import { describe, expect, test } from "bun:test";

import { FS_ERRNO, FsError } from "../../packages/pglite-opfs-repacked/src/core/errors";
import { MAX_PATH_BYTES, MAX_SYMLINK_HOPS } from "../../packages/pglite-opfs-repacked/src/core/limits";
import { RepackedVfs } from "../../packages/pglite-opfs-repacked/src/core/repacked-vfs";
import { MemoryRepackedPort } from "../../packages/pglite-opfs-repacked/test/support/memory-port";

// Symbolic links are a STORE feature, not a WASI or a Postgres one: the entry kind lives in the
// metadata format, resolution is the state machine's, and both ports inherit it because a port
// carries opaque bytes and never sees a path at all. Reopening a port is therefore the whole
// persistence proof — the same four owned files carry the links on OPFS.

const EXTENT_SIZES = [8192, 65_536] as const;

function errno(run: () => unknown): number {
  try {
    run();
  } catch (cause) {
    if (cause instanceof FsError) return cause.code;
    throw cause;
  }
  throw new Error("the call was expected to be rejected");
}

for (const extentSize of EXTENT_SIZES) {
  describe(`opfs-repacked symbolic links (${extentSize}-byte extents)`, () => {
    test("a link is created, read back, and resolved through on every path operation", async () => {
      const port = new MemoryRepackedPort();
      const vfs = await RepackedVfs.open(port, { extentSize });
      vfs.mkdir("/real/inner", { recursive: true, nowMs: 1n });
      vfs.writeFile("/real/inner/data", "payload", { nowMs: 2n });
      vfs.symlink("/real", "/link", 3n);

      expect(vfs.readlink("/link")).toBe("/real");
      // stat follows the final component, lstat reports the link; both always follow the middle.
      expect(vfs.stat("/link")).toMatchObject({ kind: "directory" });
      expect(vfs.lstat("/link")).toMatchObject({ kind: "symlink", mode: 0o120777, size: 5n });
      expect(vfs.readdir("/link")).toEqual(["inner"]);
      expect(new TextDecoder().decode(vfs.readFile("/link/inner/data"))).toBe("payload");
      expect(vfs.stat("/link/inner/data")).toMatchObject({ kind: "file", size: 7n });

      // A write through the link lands in the target, and the target's own path sees it.
      vfs.writeFile("/link/inner/data", "rewritten", { nowMs: 4n });
      expect(new TextDecoder().decode(vfs.readFile("/real/inner/data"))).toBe("rewritten");

      // Creating through the link creates in the target.
      const fd = vfs.open("/link/inner/created", "w+", 0o100666, 5n);
      vfs.write(fd, new TextEncoder().encode("x"), 0, 1, undefined, 5n);
      vfs.close(fd);
      expect(vfs.readdir("/real/inner").sort()).toEqual(["created", "data"]);
      vfs.close();
    });

    test("unlink, rename and rmdir act on the LINK, never on what it points at", async () => {
      const port = new MemoryRepackedPort();
      const vfs = await RepackedVfs.open(port, { extentSize });
      vfs.mkdir("/target", { nowMs: 1n });
      vfs.writeFile("/target/keep", "kept", { nowMs: 2n });
      vfs.symlink("/target", "/dir-link", 3n);
      vfs.symlink("/target/keep", "/file-link", 4n);

      // rmdir refuses a link outright — the final component is never followed.
      expect(errno(() => vfs.rmdir("/dir-link", 5n))).toBe(FS_ERRNO.ENOTDIR);
      // rename moves the link itself; the target keeps its own name and contents.
      vfs.rename("/dir-link", "/moved-link", 6n);
      expect(vfs.readlink("/moved-link")).toBe("/target");
      expect(vfs.readdir("/moved-link")).toEqual(["keep"]);
      // unlink removes the link and leaves the file alone.
      vfs.unlink("/file-link", 7n);
      expect(errno(() => vfs.lstat("/file-link"))).toBe(FS_ERRNO.ENOENT);
      expect(vfs.stat("/target/keep")).toMatchObject({ kind: "file", size: 4n });
      vfs.unlink("/moved-link", 8n);
      expect(vfs.readdir("/").sort()).toEqual(["target"]);
      vfs.close();
    });

    test("a link is rejected where a name is taken, and a broken one resolves but does not exist", async () => {
      const port = new MemoryRepackedPort();
      const vfs = await RepackedVfs.open(port, { extentSize });
      vfs.writeFile("/occupied", "", { nowMs: 1n });
      expect(errno(() => vfs.symlink("/anywhere", "/occupied", 2n))).toBe(FS_ERRNO.EEXIST);
      // A relative target is refused rather than reinterpreted against the link's directory.
      expect(errno(() => vfs.symlink("relative/target", "/relative-link", 3n))).toBe(FS_ERRNO.EINVAL);
      expect(errno(() => vfs.symlink("/".padEnd(MAX_PATH_BYTES + 1, "x"), "/too-long", 3n))).toBe(FS_ERRNO.EINVAL);

      // A dangling link is a perfectly good link: lstat sees it, stat reports what is missing.
      vfs.symlink("/nowhere", "/dangling", 4n);
      expect(vfs.lstat("/dangling")).toMatchObject({ kind: "symlink" });
      expect(errno(() => vfs.stat("/dangling"))).toBe(FS_ERRNO.ENOENT);
      expect(vfs.readlink("/dangling")).toBe("/nowhere");
      // ...and a create through it lands at the target's name, exactly as POSIX does.
      vfs.writeFile("/dangling", "materialised", { nowMs: 5n });
      expect(new TextDecoder().decode(vfs.readFile("/nowhere"))).toBe("materialised");
      expect(vfs.lstat("/dangling")).toMatchObject({ kind: "symlink" });

      expect(errno(() => vfs.readlink("/nowhere"))).toBe(FS_ERRNO.EINVAL);
      vfs.close();
    });

    test("a cycle is bounded by the hop count rather than parked forever", async () => {
      const port = new MemoryRepackedPort();
      const vfs = await RepackedVfs.open(port, { extentSize });
      vfs.symlink("/b", "/a", 1n);
      vfs.symlink("/a", "/b", 2n);
      expect(errno(() => vfs.stat("/a"))).toBe(FS_ERRNO.ELOOP);
      expect(errno(() => vfs.readdir("/a/child"))).toBe(FS_ERRNO.ELOOP);
      // lstat never follows the final component, so a cycle is still perfectly inspectable.
      expect(vfs.lstat("/a")).toMatchObject({ kind: "symlink" });

      // A chain shorter than the limit resolves; one longer than it does not.
      vfs.writeFile("/end", "e", { nowMs: 3n });
      let previous = "/end";
      for (let index = 0; index < MAX_SYMLINK_HOPS; index += 1) {
        vfs.symlink(previous, `/hop${index}`, 4n);
        previous = `/hop${index}`;
      }
      expect(vfs.stat(`/hop${MAX_SYMLINK_HOPS - 1}`)).toMatchObject({ kind: "file" });
      vfs.symlink(previous, "/hop-too-far", 5n);
      expect(errno(() => vfs.stat("/hop-too-far"))).toBe(FS_ERRNO.ELOOP);
      vfs.close();
    });

    test("links survive a reopen, a repack, and the metadata-log replay in between", async () => {
      const port = new MemoryRepackedPort();
      const vfs = await RepackedVfs.open(port, { extentSize });
      vfs.mkdir("/data/base", { recursive: true, nowMs: 1n });
      vfs.writeFile("/data/base/relation", "rows", { nowMs: 2n });
      vfs.symlink("/data/base", "/tblspc", 3n);
      vfs.strictSync();
      vfs.close();

      // Reopen replays the createSymlink frame out of the active log.
      const replayed = await RepackedVfs.open(port);
      expect(replayed.readlink("/tblspc")).toBe("/data/base");
      expect(new TextDecoder().decode(replayed.readFile("/tblspc/relation"))).toBe("rows");
      // Repack rewrites the metadata BASE, which is the other half of the format.
      replayed.repack();
      replayed.symlink("/data", "/second", 4n);
      replayed.strictSync();
      replayed.close();

      const repacked = await RepackedVfs.open(port);
      expect(repacked.readlink("/tblspc")).toBe("/data/base");
      expect(repacked.readlink("/second")).toBe("/data");
      expect(repacked.readdir("/second/base")).toEqual(["relation"]);
      expect(repacked.lstat("/tblspc")).toMatchObject({ kind: "symlink", atimeMs: 3n, mtimeMs: 3n });
      repacked.close();
    });

    test("removing a link releases its metadata without touching the arena", async () => {
      const port = new MemoryRepackedPort();
      const vfs = await RepackedVfs.open(port, { extentSize });
      const before = vfs.metrics();
      vfs.symlink("/somewhere", "/temp-link", 1n);
      vfs.unlink("/temp-link", 2n);
      vfs.repack();
      const after = vfs.metrics();
      // A link owns no extents, so the allocator is exactly where it started.
      expect(after.totalExtents).toBe(before.totalExtents);
      expect(after.quarantineExtents).toBe(0);
      vfs.strictSync();
      vfs.close();

      const reopened = await RepackedVfs.open(port);
      expect(reopened.readdir("/")).toEqual([]);
      reopened.close();
    });
  });
}
