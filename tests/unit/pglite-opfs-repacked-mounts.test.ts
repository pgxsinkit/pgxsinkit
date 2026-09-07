import { describe, expect, test } from "bun:test";

import { FS_ERRNO, FsError } from "../../packages/pglite-opfs-repacked/src/core/errors";
import { MountedRepackedVfs } from "../../packages/pglite-opfs-repacked/src/core/mounted-vfs";
import { RepackedVfs } from "../../packages/pglite-opfs-repacked/src/core/repacked-vfs";
import { MemoryRepackedPort } from "../../packages/pglite-opfs-repacked/test/support/memory-port";

// A mount is TWO stores serving ONE tree. Everything below is written against the arrangement the
// feature exists for: a durable root (an OPFS store in production) plus a volatile mount, joined by
// a symbolic link the root holds — the shape `CREATE TABLESPACE` produces. The ports are memory
// ports here because a port carries opaque bytes and never sees a path, so the OPFS one behaves
// identically; a reopen of the same port is the persistence proof.

const EXTENT_SIZE = 8192;

interface Fixture {
  readonly rootPort: MemoryRepackedPort;
  readonly mountPort: MemoryRepackedPort;
  readonly root: RepackedVfs;
  readonly mount: RepackedVfs;
  readonly fs: MountedRepackedVfs;
}

async function fixture(options: { durable?: boolean } = {}): Promise<Fixture> {
  const rootPort = new MemoryRepackedPort();
  const mountPort = new MemoryRepackedPort();
  const root = await RepackedVfs.open(rootPort, { extentSize: EXTENT_SIZE });
  const mount = await RepackedVfs.open(mountPort, { extentSize: EXTENT_SIZE });
  const fs = new MountedRepackedVfs({
    root,
    mounts: [{ prefix: "/eph", vfs: mount, durable: options.durable ?? false }],
    nowMs: () => 1n,
  });
  return { rootPort, mountPort, root, mount, fs };
}

function errno(run: () => unknown): number {
  try {
    run();
  } catch (cause) {
    if (cause instanceof FsError) return cause.code;
    throw cause;
  }
  throw new Error("the call was expected to be rejected");
}

function flushCount(port: MemoryRepackedPort): number {
  return port.observedOperations().filter((operation) => operation.operation === "flush").length;
}

describe("opfs-repacked mounted stores", () => {
  test("everything at or below the prefix lands in the MOUNT store, and nothing else does", async () => {
    const { root, mount, fs } = await fixture();
    fs.mkdir("/pgdata/base", { recursive: true, nowMs: 2n });
    fs.writeFile("/pgdata/base/rooted", "durable", { nowMs: 3n });
    fs.mkdir("/eph/PG_18", { recursive: true, nowMs: 4n });
    fs.writeFile("/eph/PG_18/relation", "volatile", { nowMs: 5n });

    // The composite sees one tree...
    expect(fs.readdir("/").sort()).toEqual(["eph", "pgdata"]);
    expect(fs.readdir("/eph")).toEqual(["PG_18"]);
    expect(new TextDecoder().decode(fs.readFile("/eph/PG_18/relation"))).toBe("volatile");

    // ...and the two stores each hold exactly their own half. The prefix exists in the root only as
    // a NAME, so a listing of the root's parent shows it and nothing is ever stored behind it.
    expect(root.readdir("/").sort()).toEqual(["eph", "pgdata"]);
    expect(root.readdir("/eph")).toEqual([]);
    expect(mount.readdir("/")).toEqual(["PG_18"]);
    expect(mount.readdir("/PG_18")).toEqual(["relation"]);
    expect(errno(() => root.stat("/eph/PG_18"))).toBe(FS_ERRNO.ENOENT);
    expect(errno(() => mount.stat("/pgdata"))).toBe(FS_ERRNO.ENOENT);
    // The mount store owns the bytes; the root store never allocated for them.
    expect(mount.metrics().totalExtents).toBeGreaterThan(0n);
    expect(root.metrics().totalExtents).toBe(1n);
    fs.close();
  });

  test("a link in the root store resolves across the boundary, and one in the mount resolves back", async () => {
    const { root, mount, fs } = await fixture();
    fs.mkdir("/pgdata/pg_tblspc", { recursive: true, nowMs: 2n });
    fs.mkdir("/eph/PG_18", { recursive: true, nowMs: 3n });
    // The CREATE TABLESPACE shape: the link lives in the durable root, the target is the mount.
    fs.symlink("/eph", "/pgdata/pg_tblspc/16385", 4n);
    fs.writeFile("/pgdata/pg_tblspc/16385/PG_18/16386", "pages", { nowMs: 5n });

    expect(fs.readlink("/pgdata/pg_tblspc/16385")).toBe("/eph");
    expect(fs.resolvePath("/pgdata/pg_tblspc/16385/PG_18/16386")).toBe("/eph/PG_18/16386");
    expect(fs.readdir("/pgdata/pg_tblspc/16385")).toEqual(["PG_18"]);
    expect(fs.stat("/pgdata/pg_tblspc/16385")).toMatchObject({ kind: "directory" });
    expect(fs.lstat("/pgdata/pg_tblspc/16385")).toMatchObject({ kind: "symlink" });
    // Neither store alone could have answered that: the link is the root's, the file is the mount's.
    expect(root.lstat("/pgdata/pg_tblspc/16385")).toMatchObject({ kind: "symlink" });
    expect(mount.readdir("/PG_18")).toEqual(["16386"]);
    expect(errno(() => root.stat("/pgdata/pg_tblspc/16385/PG_18/16386"))).toBe(FS_ERRNO.ENOENT);

    // ...and the reverse direction: a link INSIDE the mount pointing back at the durable root.
    fs.writeFile("/pgdata/anchor", "anchored", { nowMs: 6n });
    fs.symlink("/pgdata/anchor", "/eph/back", 7n);
    expect(new TextDecoder().decode(fs.readFile("/eph/back"))).toBe("anchored");
    expect(fs.resolvePath("/eph/back")).toBe("/pgdata/anchor");
    fs.close();
  });

  test("descriptors carry their own store, and a rename across the boundary is EXDEV", async () => {
    const { fs } = await fixture();
    fs.writeFile("/pgdata", "rooted", { nowMs: 2n });
    fs.writeFile("/eph/mounted", "volatile", { nowMs: 3n });

    const rooted = fs.open("/pgdata", "r+", 0o100666, 4n);
    const mounted = fs.open("/eph/mounted", "r+", 0o100666, 5n);
    // Each store numbers its own fds from 3, so the composite must not hand out either store's.
    expect(rooted).not.toBe(mounted);
    expect(fs.fstat(rooted).size).toBe(6n);
    expect(fs.fstat(mounted).size).toBe(8n);
    const target = new Uint8Array(8);
    expect(fs.read(mounted, target, 0, 8, 0n)).toBe(8);
    expect(new TextDecoder().decode(target)).toBe("volatile");
    fs.write(rooted, new TextEncoder().encode("!"), 0, 1, 6n, 6n);
    expect(fs.fstat(rooted).size).toBe(7n);
    fs.close(rooted);
    fs.close(mounted);
    expect(errno(() => fs.fstat(rooted))).toBe(FS_ERRNO.EBADF);

    expect(errno(() => fs.rename("/pgdata", "/eph/moved", 7n))).toBe(FS_ERRNO.EXDEV);
    expect(errno(() => fs.rename("/eph/mounted", "/moved", 8n))).toBe(FS_ERRNO.EXDEV);
    // A rename WITHIN one store is untouched by any of that.
    fs.rename("/eph/mounted", "/eph/renamed", 9n);
    expect(fs.readdir("/eph")).toEqual(["renamed"]);
    fs.close();
  });

  test("a store-wide sync skips a mount the owner declared volatile, and reaches a durable one", async () => {
    const volatileFixture = await fixture({ durable: false });
    volatileFixture.fs.writeFile("/eph/scratch", "x", { nowMs: 2n });
    volatileFixture.rootPort.clearObservedOperations();
    volatileFixture.mountPort.clearObservedOperations();
    volatileFixture.fs.strictSync();
    expect(flushCount(volatileFixture.rootPort)).toBeGreaterThan(0);
    expect(flushCount(volatileFixture.mountPort)).toBe(0);
    volatileFixture.fs.close();

    const durableFixture = await fixture({ durable: true });
    durableFixture.fs.writeFile("/eph/scratch", "x", { nowMs: 2n });
    durableFixture.rootPort.clearObservedOperations();
    durableFixture.mountPort.clearObservedOperations();
    durableFixture.fs.strictSync();
    expect(flushCount(durableFixture.rootPort)).toBeGreaterThan(0);
    expect(flushCount(durableFixture.mountPort)).toBeGreaterThan(0);
    durableFixture.fs.close();
  });

  test("the root store keeps its links across a reopen while the volatile mount starts empty", async () => {
    const first = await fixture();
    first.fs.mkdir("/pgdata/pg_tblspc", { recursive: true, nowMs: 2n });
    first.fs.symlink("/eph", "/pgdata/pg_tblspc/16385", 3n);
    first.fs.writeFile("/pgdata/pg_tblspc/16385/relation", "volatile", { nowMs: 4n });
    first.fs.strictSync();
    first.fs.close();

    // The durable side comes back with the link intact; the volatile side is a brand-new store,
    // which is exactly the contract a memory-backed mount offers.
    const root = await RepackedVfs.open(first.rootPort);
    const mount = await RepackedVfs.open(new MemoryRepackedPort(), { extentSize: EXTENT_SIZE });
    const fs = new MountedRepackedVfs({ root, mounts: [{ prefix: "/eph", vfs: mount, durable: false }] });
    expect(fs.readlink("/pgdata/pg_tblspc/16385")).toBe("/eph");
    expect(fs.readdir("/pgdata/pg_tblspc/16385")).toEqual([]);
    expect(errno(() => fs.stat("/pgdata/pg_tblspc/16385/relation"))).toBe(FS_ERRNO.ENOENT);
    // ...and it is writable again through the same link.
    fs.writeFile("/pgdata/pg_tblspc/16385/relation", "again", { nowMs: 5n });
    expect(mount.readdir("/")).toEqual(["relation"]);
    fs.close();
  });

  test("a prefix must be an absolute path below the root, and prefixes may not overlap", async () => {
    const root = await RepackedVfs.open(new MemoryRepackedPort(), { extentSize: EXTENT_SIZE });
    const mount = await RepackedVfs.open(new MemoryRepackedPort(), { extentSize: EXTENT_SIZE });
    const other = await RepackedVfs.open(new MemoryRepackedPort(), { extentSize: EXTENT_SIZE });
    expect(errno(() => new MountedRepackedVfs({ root, mounts: [{ prefix: "/", vfs: mount }] }))).toBe(FS_ERRNO.EINVAL);
    expect(errno(() => new MountedRepackedVfs({ root, mounts: [{ prefix: "relative", vfs: mount }] }))).toBe(
      FS_ERRNO.EINVAL,
    );
    expect(
      errno(
        () =>
          new MountedRepackedVfs({
            root,
            mounts: [
              { prefix: "/a", vfs: mount },
              { prefix: "/a/nested", vfs: other },
            ],
          }),
      ),
    ).toBe(FS_ERRNO.EINVAL);
    // Two disjoint prefixes are fine, and both appear in one listing.
    const fs = new MountedRepackedVfs({
      root,
      mounts: [
        { prefix: "/a", vfs: mount },
        { prefix: "/b", vfs: other },
      ],
    });
    expect(fs.readdir("/").sort()).toEqual(["a", "b"]);
    expect(fs.mounts.map((entry) => entry.prefix)).toEqual(["/a", "/b"]);
    fs.close();
  });
});
