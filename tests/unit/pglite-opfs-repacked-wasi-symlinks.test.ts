import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { RepackedSyncClient } from "../../packages/pglite-opfs-repacked/src/broker/client";
import {
  LOOKUPFLAGS_SYMLINK_FOLLOW,
  OFLAGS_CREAT,
  OFLAGS_DIRECTORY,
  OFLAGS_TRUNC,
  RIGHTS_FD_READ,
  RIGHTS_FD_WRITE,
  WASI_ERRNO,
  WASI_FILETYPE,
  createWasiPreview1Fs,
} from "../../packages/pglite-opfs-repacked/src/wasi/preview1";
import type { WasiPreview1Fs } from "../../packages/pglite-opfs-repacked/src/wasi/preview1";
import { startBrokerWorker } from "../../packages/pglite-opfs-repacked/test/support/broker-harness";
import type { BrokerWorkerHandle } from "../../packages/pglite-opfs-repacked/test/support/broker-harness";
import { GuestMemory, decodeDirents } from "../../packages/pglite-opfs-repacked/test/support/wasi-guest";

// The seam a guest actually meets: `path_symlink` / `path_readlink` marshalled through guest memory,
// over the SharedArrayBuffer broker, against a store in another thread. `SYMLINK_FOLLOW` is the whole
// story here — it is the one lookup flag that now changes an answer, and a guest that omits it
// (`lstat`, `open(O_NOFOLLOW)`) must get the LINK rather than what it points at.

const RW = RIGHTS_FD_READ | RIGHTS_FD_WRITE;
const FOLLOW = LOOKUPFLAGS_SYMLINK_FOLLOW;

describe("opfs-repacked WASI preview1 symbolic links", () => {
  let broker: BrokerWorkerHandle;
  let client: RepackedSyncClient;
  let memory: GuestMemory;
  let wasi: WasiPreview1Fs;
  const errors: string[] = [];

  beforeAll(async () => {
    broker = await startBrokerWorker({ channelCount: 1 });
    client = new RepackedSyncClient(broker.channels[0]!, { requestTimeoutMs: 20_000 });
    memory = new GuestMemory({ pages: 16 });
    wasi = createWasiPreview1Fs({
      client,
      memory: memory.resolver,
      onError: (call, cause) => errors.push(`${call}: ${String(cause)}`),
    });
  });

  afterAll(async () => {
    await broker.stop();
  });

  function mkdir(path: string): number {
    const encoded = memory.string(path);
    return wasi.path_create_directory(3, encoded.ptr, encoded.len);
  }

  function touch(path: string, contents = ""): void {
    const encoded = memory.string(path);
    const out = memory.alloc(4);
    expect(wasi.path_open(3, FOLLOW, encoded.ptr, encoded.len, OFLAGS_CREAT | OFLAGS_TRUNC, RW, RW, 0, out)).toBe(
      WASI_ERRNO.SUCCESS,
    );
    const fd = memory.u32(out);
    if (contents.length > 0) {
      const iovs = memory.writeSource(new TextEncoder().encode(contents));
      const written = memory.alloc(4);
      expect(wasi.fd_write(fd, iovs, 1, written)).toBe(WASI_ERRNO.SUCCESS);
    }
    expect(wasi.fd_close(fd)).toBe(WASI_ERRNO.SUCCESS);
  }

  function symlink(target: string, path: string): number {
    const oldPath = memory.string(target);
    const newPath = memory.string(path);
    return wasi.path_symlink(oldPath.ptr, oldPath.len, 3, newPath.ptr, newPath.len);
  }

  function readlink(path: string, bufLen = 256): { errno: number; used: number; target: string } {
    const encoded = memory.string(path);
    const buf = memory.alloc(bufLen);
    memory.bytes().fill(0, buf, buf + bufLen);
    const usedPtr = memory.alloc(4);
    const errno = wasi.path_readlink(3, encoded.ptr, encoded.len, buf, bufLen, usedPtr);
    const used = memory.u32(usedPtr);
    return { errno, used, target: memory.text(buf, used) };
  }

  function filestat(path: string, flags: number): { errno: number; filetype: number; size: bigint } {
    const encoded = memory.string(path);
    const out = memory.alloc(64);
    const errno = wasi.path_filestat_get(3, flags, encoded.ptr, encoded.len, out);
    return { errno, filetype: memory.bytes()[out + 16]!, size: memory.u64(out + 32) };
  }

  function open(path: string, dirflags: number, oflags = 0): { errno: number; fd: number } {
    const encoded = memory.string(path);
    const out = memory.alloc(4);
    const errno = wasi.path_open(3, dirflags, encoded.ptr, encoded.len, oflags, RW, RW, 0, out);
    return { errno, fd: errno === WASI_ERRNO.SUCCESS ? memory.u32(out) : -1 };
  }

  test("a link is written and read back verbatim, and a short buffer truncates rather than fails", () => {
    memory.reset();
    expect(mkdir("/target")).toBe(WASI_ERRNO.SUCCESS);
    expect(symlink("/target", "/link")).toBe(WASI_ERRNO.SUCCESS);
    expect(readlink("/link")).toEqual({ errno: WASI_ERRNO.SUCCESS, used: 7, target: "/target" });
    // preview1 writes no terminator: a full buffer IS how a caller learns to grow it and retry.
    expect(readlink("/link", 4)).toEqual({ errno: WASI_ERRNO.SUCCESS, used: 4, target: "/tar" });
    // Creating the same name twice is EEXIST, and a bad dirfd never reaches the store.
    expect(symlink("/target", "/link")).toBe(WASI_ERRNO.EXIST);
    const target = memory.string("/target");
    const path = memory.string("/orphan");
    expect(wasi.path_symlink(target.ptr, target.len, 999, path.ptr, path.len)).toBe(WASI_ERRNO.BADF);
    // The store takes absolute targets only; a relative one is refused, never reinterpreted.
    expect(symlink("relative", "/relative-link")).toBe(WASI_ERRNO.INVAL);
    expect(errors).toEqual([]);
  });

  test("SYMLINK_FOLLOW decides what path_filestat_get reports", () => {
    memory.reset();
    touch("/followed-file", "content");
    expect(symlink("/followed-file", "/followed-link")).toBe(WASI_ERRNO.SUCCESS);

    // Without the flag: the LINK, whose size is its target's byte length (POSIX `lstat`).
    expect(filestat("/followed-link", 0)).toEqual({
      errno: WASI_ERRNO.SUCCESS,
      filetype: WASI_FILETYPE.SYMBOLIC_LINK,
      size: 14n,
    });
    // With it: the file, at its own size. This is `symlink_metadata` versus `metadata`.
    expect(filestat("/followed-link", FOLLOW)).toEqual({
      errno: WASI_ERRNO.SUCCESS,
      filetype: WASI_FILETYPE.REGULAR_FILE,
      size: 7n,
    });
    expect(errors).toEqual([]);
  });

  test("path_open follows a link only when asked, and always follows an intermediate one", () => {
    memory.reset();
    expect(mkdir("/opened")).toBe(WASI_ERRNO.SUCCESS);
    touch("/opened/inner", "inner-bytes");
    expect(symlink("/opened", "/opened-link")).toBe(WASI_ERRNO.SUCCESS);
    expect(symlink("/opened/inner", "/inner-link")).toBe(WASI_ERRNO.SUCCESS);

    // An INTERMEDIATE link is always followed — a path can only continue through its target.
    const through = open("/opened-link/inner", 0);
    expect(through.errno).toBe(WASI_ERRNO.SUCCESS);
    const iovs = memory.readTarget(11);
    const read = memory.alloc(4);
    expect(wasi.fd_read(through.fd, iovs.iovs, 1, read)).toBe(WASI_ERRNO.SUCCESS);
    expect(memory.text(iovs.ptr, memory.u32(read))).toBe("inner-bytes");
    expect(wasi.fd_close(through.fd)).toBe(WASI_ERRNO.SUCCESS);

    // A FINAL link opens its target with the flag and reports ELOOP without it.
    const followed = open("/inner-link", FOLLOW);
    expect(followed.errno).toBe(WASI_ERRNO.SUCCESS);
    expect(wasi.fd_close(followed.fd)).toBe(WASI_ERRNO.SUCCESS);
    expect(open("/inner-link", 0).errno).toBe(WASI_ERRNO.LOOP);
    expect(open("/opened-link", 0, OFLAGS_DIRECTORY).errno).toBe(WASI_ERRNO.LOOP);
    const directory = open("/opened-link", FOLLOW, OFLAGS_DIRECTORY);
    expect(directory.errno).toBe(WASI_ERRNO.SUCCESS);
    expect(wasi.fd_close(directory.fd)).toBe(WASI_ERRNO.SUCCESS);
    expect(errors).toEqual([]);
  });

  test("path_unlink_file removes the link and leaves the target, and fd_readdir names the kind", () => {
    memory.reset();
    expect(mkdir("/listing")).toBe(WASI_ERRNO.SUCCESS);
    touch("/listing/file", "kept");
    expect(mkdir("/listing/dir")).toBe(WASI_ERRNO.SUCCESS);
    expect(symlink("/listing/file", "/listing/link")).toBe(WASI_ERRNO.SUCCESS);

    const dir = open("/listing", FOLLOW, OFLAGS_DIRECTORY);
    expect(dir.errno).toBe(WASI_ERRNO.SUCCESS);
    const buf = memory.alloc(512);
    memory.bytes().fill(0, buf, buf + 512);
    const usedPtr = memory.alloc(4);
    expect(wasi.fd_readdir(dir.fd, buf, 512, 0n, usedPtr)).toBe(WASI_ERRNO.SUCCESS);
    const entries = decodeDirents(memory, buf, memory.u32(usedPtr));
    // A guest deciding what to recurse into must see the link as a link, never as its target.
    expect(entries.map((entry) => [entry.name, entry.filetype])).toEqual([
      ["dir", WASI_FILETYPE.DIRECTORY],
      ["file", WASI_FILETYPE.REGULAR_FILE],
      ["link", WASI_FILETYPE.SYMBOLIC_LINK],
    ]);
    expect(wasi.fd_close(dir.fd)).toBe(WASI_ERRNO.SUCCESS);

    const link = memory.string("/listing/link");
    expect(wasi.path_unlink_file(3, link.ptr, link.len)).toBe(WASI_ERRNO.SUCCESS);
    expect(readlink("/listing/link").errno).toBe(WASI_ERRNO.NOENT);
    expect(filestat("/listing/file", FOLLOW)).toEqual({
      errno: WASI_ERRNO.SUCCESS,
      filetype: WASI_FILETYPE.REGULAR_FILE,
      size: 4n,
    });
    expect(errors).toEqual([]);
  });
});
