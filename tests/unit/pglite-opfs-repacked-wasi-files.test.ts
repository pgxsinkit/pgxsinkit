import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { RepackedSyncClient } from "../../packages/pglite-opfs-repacked/src/broker/client";
import {
  FDFLAGS_APPEND,
  OFLAGS_CREAT,
  OFLAGS_DIRECTORY,
  OFLAGS_EXCL,
  OFLAGS_TRUNC,
  RIGHTS_FD_READ,
  RIGHTS_FD_WRITE,
  WASI_ERRNO,
  WASI_FILETYPE,
  WHENCE_CUR,
  WHENCE_END,
  WHENCE_SET,
  createWasiPreview1Fs,
} from "../../packages/pglite-opfs-repacked/src/wasi/preview1";
import type { WasiPreview1Fs } from "../../packages/pglite-opfs-repacked/src/wasi/preview1";
import { startBrokerWorker } from "../../packages/pglite-opfs-repacked/test/support/broker-harness";
import type { BrokerWorkerHandle } from "../../packages/pglite-opfs-repacked/test/support/broker-harness";
import { GuestMemory } from "../../packages/pglite-opfs-repacked/test/support/wasi-guest";

// The production thread arrangement: the store and its blocking `serveForever()` loop live in a
// Worker, and the ADAPTER runs here, on the thread that blocks in `Atomics.wait` — exactly where a
// wasm backend's WASI imports run. Every call below goes through guest memory the way an engine makes
// it, because that is the only interface the adapter has.

const RW = RIGHTS_FD_READ | RIGHTS_FD_WRITE;
const encoder = new TextEncoder();

describe("opfs-repacked WASI preview1 files", () => {
  let broker: BrokerWorkerHandle;
  let client: RepackedSyncClient;
  let memory: GuestMemory;
  let wasi: WasiPreview1Fs;
  const errors: string[] = [];

  beforeAll(async () => {
    broker = await startBrokerWorker({ channelCount: 1 });
    client = new RepackedSyncClient(broker.channels[0]!, { requestTimeoutMs: 15_000 });
    memory = new GuestMemory({ pages: 8 });
    wasi = createWasiPreview1Fs({
      client,
      memory: memory.resolver,
      onError: (call, cause) => errors.push(`${call}: ${String(cause)}`),
    });
  });

  afterAll(async () => {
    await broker.stop();
  });

  function open(
    path: string,
    oflags: number,
    options: { rights?: bigint; fdflags?: number; dirfd?: number } = {},
  ): { errno: number; fd: number } {
    const encoded = memory.string(path);
    const out = memory.alloc(4);
    const rights = options.rights ?? RW;
    const errno = wasi.path_open(
      options.dirfd ?? 3,
      0,
      encoded.ptr,
      encoded.len,
      oflags,
      rights,
      rights,
      options.fdflags ?? 0,
      out,
    );
    return { errno, fd: errno === WASI_ERRNO.SUCCESS ? memory.u32(out) : -1 };
  }

  function write(fd: number, text: string): { errno: number; written: number } {
    const iovs = memory.writeSource(encoder.encode(text));
    const out = memory.alloc(4);
    const errno = wasi.fd_write(fd, iovs, 1, out);
    return { errno, written: memory.u32(out) };
  }

  function read(fd: number, length: number): { errno: number; text: string; count: number } {
    const target = memory.readTarget(length);
    const out = memory.alloc(4);
    const errno = wasi.fd_read(fd, target.iovs, 1, out);
    const count = memory.u32(out);
    return { errno, count, text: memory.text(target.ptr, count) };
  }

  function tell(fd: number): bigint {
    const out = memory.alloc(8);
    expect(wasi.fd_tell(fd, out)).toBe(WASI_ERRNO.SUCCESS);
    return memory.u64(out);
  }

  test("a created file round-trips through write, seek, tell and read", () => {
    memory.reset();
    const created = open("/round-trip.txt", OFLAGS_CREAT | OFLAGS_TRUNC);
    expect(created.errno).toBe(WASI_ERRNO.SUCCESS);
    expect(created.fd).toBeGreaterThanOrEqual(4);
    expect(wasi.owns(created.fd)).toBe(true);

    expect(write(created.fd, "hello ")).toEqual({ errno: 0, written: 6 });
    expect(write(created.fd, "broker")).toEqual({ errno: 0, written: 6 });
    expect(tell(created.fd)).toBe(12n);

    const seekOut = memory.alloc(8);
    expect(wasi.fd_seek(created.fd, 0n, WHENCE_SET, seekOut)).toBe(WASI_ERRNO.SUCCESS);
    expect(memory.u64(seekOut)).toBe(0n);
    expect(read(created.fd, 32)).toEqual({ errno: 0, count: 12, text: "hello broker" });
    expect(tell(created.fd)).toBe(12n);

    // Reading at end-of-file is a zero-length success, never an error.
    expect(read(created.fd, 8)).toEqual({ errno: 0, count: 0, text: "" });

    expect(wasi.fd_seek(created.fd, -6n, WHENCE_END, seekOut)).toBe(WASI_ERRNO.SUCCESS);
    expect(memory.u64(seekOut)).toBe(6n);
    expect(read(created.fd, 6).text).toBe("broker");

    expect(wasi.fd_seek(created.fd, -12n, WHENCE_CUR, seekOut)).toBe(WASI_ERRNO.SUCCESS);
    expect(memory.u64(seekOut)).toBe(0n);
    // A seek before the start of the file is EINVAL and leaves the offset alone.
    expect(wasi.fd_seek(created.fd, -1n, WHENCE_CUR, seekOut)).toBe(WASI_ERRNO.INVAL);
    expect(tell(created.fd)).toBe(0n);

    expect(wasi.fd_sync(created.fd)).toBe(WASI_ERRNO.SUCCESS);
    expect(wasi.fd_datasync(created.fd)).toBe(WASI_ERRNO.SUCCESS);
    expect(wasi.fd_close(created.fd)).toBe(WASI_ERRNO.SUCCESS);
    expect(wasi.fd_close(created.fd)).toBe(WASI_ERRNO.BADF);
    expect(errors).toEqual([]);
  });

  test("pread and pwrite transfer at an explicit position and never move the offset", () => {
    memory.reset();
    const file = open("/positional.bin", OFLAGS_CREAT | OFLAGS_TRUNC);
    expect(file.errno).toBe(WASI_ERRNO.SUCCESS);
    expect(write(file.fd, "0123456789")).toEqual({ errno: 0, written: 10 });

    const seekOut = memory.alloc(8);
    expect(wasi.fd_seek(file.fd, 3n, WHENCE_SET, seekOut)).toBe(WASI_ERRNO.SUCCESS);

    const pwriteOut = memory.alloc(4);
    const pwriteIovs = memory.writeSource(encoder.encode("XY"));
    expect(wasi.fd_pwrite(file.fd, pwriteIovs, 1, 7n, pwriteOut)).toBe(WASI_ERRNO.SUCCESS);
    expect(memory.u32(pwriteOut)).toBe(2);
    expect(tell(file.fd)).toBe(3n);

    const target = memory.readTarget(10);
    const preadOut = memory.alloc(4);
    expect(wasi.fd_pread(file.fd, target.iovs, 1, 0n, preadOut)).toBe(WASI_ERRNO.SUCCESS);
    expect(memory.u32(preadOut)).toBe(10);
    expect(memory.text(target.ptr, 10)).toBe("0123456XY9");
    expect(tell(file.fd)).toBe(3n);

    // The ordinary cursor read still starts where the offset actually is.
    expect(read(file.fd, 4).text).toBe("3456");
    expect(tell(file.fd)).toBe(7n);
    expect(wasi.fd_close(file.fd)).toBe(WASI_ERRNO.SUCCESS);
  });

  test("O_APPEND writes at end-of-file however the offset was left, and can be toggled", () => {
    memory.reset();
    const seeded = open("/append.log", OFLAGS_CREAT | OFLAGS_TRUNC);
    expect(write(seeded.fd, "first")).toEqual({ errno: 0, written: 5 });
    expect(wasi.fd_close(seeded.fd)).toBe(WASI_ERRNO.SUCCESS);

    const appended = open("/append.log", 0, { fdflags: FDFLAGS_APPEND });
    expect(appended.errno).toBe(WASI_ERRNO.SUCCESS);
    const seekOut = memory.alloc(8);
    // Rewind to the start: an append descriptor must ignore it entirely.
    expect(wasi.fd_seek(appended.fd, 0n, WHENCE_SET, seekOut)).toBe(WASI_ERRNO.SUCCESS);
    expect(write(appended.fd, "-second")).toEqual({ errno: 0, written: 7 });
    expect(tell(appended.fd)).toBe(12n);

    // Clearing APPEND makes the very next write positional again — the adapter emulates the flag, so
    // it is not frozen into the descriptor the coordinator holds.
    expect(wasi.fd_fdstat_set_flags(appended.fd, 0)).toBe(WASI_ERRNO.SUCCESS);
    expect(wasi.fd_seek(appended.fd, 0n, WHENCE_SET, seekOut)).toBe(WASI_ERRNO.SUCCESS);
    expect(write(appended.fd, "F")).toEqual({ errno: 0, written: 1 });

    expect(wasi.fd_seek(appended.fd, 0n, WHENCE_SET, seekOut)).toBe(WASI_ERRNO.SUCCESS);
    expect(read(appended.fd, 32).text).toBe("First-second");
    expect(wasi.fd_close(appended.fd)).toBe(WASI_ERRNO.SUCCESS);
  });

  test("the open rejections a guest depends on come back as the exact WASI errnos", () => {
    memory.reset();
    expect(open("/missing/deep.txt", 0).errno).toBe(WASI_ERRNO.NOENT);
    expect(open("/nothing-here", 0).errno).toBe(WASI_ERRNO.NOENT);

    const exclusive = open("/exclusive.txt", OFLAGS_CREAT | OFLAGS_EXCL);
    expect(exclusive.errno).toBe(WASI_ERRNO.SUCCESS);
    expect(wasi.fd_close(exclusive.fd)).toBe(WASI_ERRNO.SUCCESS);
    expect(open("/exclusive.txt", OFLAGS_CREAT | OFLAGS_EXCL).errno).toBe(WASI_ERRNO.EXIST);

    // A plain file opened with O_DIRECTORY is ENOTDIR; a directory opened with O_EXCL|O_CREAT is
    // EEXIST, not EISDIR, because that is what the guest's `mkdir`-then-`open` dance expects.
    expect(open("/exclusive.txt", OFLAGS_DIRECTORY).errno).toBe(WASI_ERRNO.NOTDIR);
    const dir = memory.string("/a-directory");
    expect(wasi.path_create_directory(3, dir.ptr, dir.len)).toBe(WASI_ERRNO.SUCCESS);
    expect(open("/a-directory", OFLAGS_CREAT | OFLAGS_EXCL).errno).toBe(WASI_ERRNO.EXIST);
    expect(open("/a-directory", OFLAGS_DIRECTORY).errno).toBe(WASI_ERRNO.SUCCESS);

    // A directory opened WITHOUT O_DIRECTORY still yields a usable directory fd, never a file one.
    const asFile = open("/a-directory", 0);
    expect(asFile.errno).toBe(WASI_ERRNO.SUCCESS);
    const seekOut = memory.alloc(8);
    expect(wasi.fd_seek(asFile.fd, 0n, WHENCE_SET, seekOut)).toBe(WASI_ERRNO.BADF);
    expect(read(asFile.fd, 4).errno).toBe(WASI_ERRNO.ISDIR);
    expect(wasi.fd_close(asFile.fd)).toBe(WASI_ERRNO.SUCCESS);
    expect(errors).toEqual([]);
  });

  test("a read-only open is refused a write even though the store descriptor had to be wider", () => {
    memory.reset();
    // POSIX `open(O_RDONLY|O_CREAT)` is legal, and the store has no create-without-write mode — so the
    // coordinator's descriptor is opened writable and the ADAPTER is what holds the line.
    const readOnly = open("/read-only.txt", OFLAGS_CREAT, { rights: RIGHTS_FD_READ });
    expect(readOnly.errno).toBe(WASI_ERRNO.SUCCESS);
    expect(write(readOnly.fd, "nope").errno).toBe(WASI_ERRNO.NOTCAPABLE);

    const pwriteOut = memory.alloc(4);
    const iovs = memory.writeSource(encoder.encode("nope"));
    expect(wasi.fd_pwrite(readOnly.fd, iovs, 1, 0n, pwriteOut)).toBe(WASI_ERRNO.NOTCAPABLE);
    expect(wasi.fd_filestat_set_size(readOnly.fd, 8n)).toBe(WASI_ERRNO.NOTCAPABLE);
    expect(read(readOnly.fd, 4)).toEqual({ errno: 0, count: 0, text: "" });

    const fdstat = memory.alloc(24);
    expect(wasi.fd_fdstat_get(readOnly.fd, fdstat)).toBe(WASI_ERRNO.SUCCESS);
    expect(memory.view().getUint8(fdstat)).toBe(WASI_FILETYPE.REGULAR_FILE);
    expect(memory.u64(fdstat + 8)).toBe(RIGHTS_FD_READ);
    expect(wasi.fd_close(readOnly.fd)).toBe(WASI_ERRNO.SUCCESS);
  });

  test("filestat reports the size, filetype and mtime the store holds, by fd and by path", () => {
    memory.reset();
    const before = BigInt(Date.now());
    const file = open("/stat-me.bin", OFLAGS_CREAT | OFLAGS_TRUNC);
    expect(write(file.fd, "0123456789ABCDEF")).toEqual({ errno: 0, written: 16 });

    const byFd = memory.alloc(64);
    expect(wasi.fd_filestat_get(file.fd, byFd)).toBe(WASI_ERRNO.SUCCESS);
    const view = memory.view();
    expect(view.getUint8(byFd + 16)).toBe(WASI_FILETYPE.REGULAR_FILE);
    expect(memory.u64(byFd + 32)).toBe(16n);
    expect(memory.u64(byFd + 8) > 0n).toBe(true); // a synthetic but non-zero inode
    const mtimeMs = memory.u64(byFd + 48) / 1_000_000n;
    expect(mtimeMs >= before).toBe(true);

    const path = memory.string("/stat-me.bin");
    const byPath = memory.alloc(64);
    expect(wasi.path_filestat_get(3, 1, path.ptr, path.len, byPath)).toBe(WASI_ERRNO.SUCCESS);
    expect(memory.u64(byPath + 32)).toBe(16n);
    // The store has no symlinks, so following one or not is the same answer.
    const byPathNoFollow = memory.alloc(64);
    expect(wasi.path_filestat_get(3, 0, path.ptr, path.len, byPathNoFollow)).toBe(WASI_ERRNO.SUCCESS);
    expect(memory.read(byPath, 64)).toEqual(memory.read(byPathNoFollow, 64));

    const missing = memory.string("/stat-me-not.bin");
    expect(wasi.path_filestat_get(3, 1, missing.ptr, missing.len, byPath)).toBe(WASI_ERRNO.NOENT);
    expect(wasi.fd_close(file.fd)).toBe(WASI_ERRNO.SUCCESS);
  });

  test("fd_filestat_set_size truncates and extends the file the descriptor was opened on", () => {
    memory.reset();
    const file = open("/resize.bin", OFLAGS_CREAT | OFLAGS_TRUNC);
    expect(write(file.fd, "abcdefghij")).toEqual({ errno: 0, written: 10 });

    expect(wasi.fd_filestat_set_size(file.fd, 4n)).toBe(WASI_ERRNO.SUCCESS);
    const stat = memory.alloc(64);
    expect(wasi.fd_filestat_get(file.fd, stat)).toBe(WASI_ERRNO.SUCCESS);
    expect(memory.u64(stat + 32)).toBe(4n);

    const seekOut = memory.alloc(8);
    expect(wasi.fd_seek(file.fd, 0n, WHENCE_SET, seekOut)).toBe(WASI_ERRNO.SUCCESS);
    expect(read(file.fd, 16)).toEqual({ errno: 0, count: 4, text: "abcd" });

    // Extending zero-fills, which is what `ftruncate` promises.
    expect(wasi.fd_filestat_set_size(file.fd, 8n)).toBe(WASI_ERRNO.SUCCESS);
    expect(wasi.fd_seek(file.fd, 0n, WHENCE_SET, seekOut)).toBe(WASI_ERRNO.SUCCESS);
    const target = memory.readTarget(8);
    const readOut = memory.alloc(4);
    expect(wasi.fd_read(file.fd, target.iovs, 1, readOut)).toBe(WASI_ERRNO.SUCCESS);
    expect([...memory.read(target.ptr, 8)]).toEqual([97, 98, 99, 100, 0, 0, 0, 0]);
    expect(wasi.fd_close(file.fd)).toBe(WASI_ERRNO.SUCCESS);
  });

  test("rename follows every open descriptor, and unlink and rmdir answer as POSIX does", () => {
    memory.reset();
    const nest = memory.string("/nest");
    expect(wasi.path_create_directory(3, nest.ptr, nest.len)).toBe(WASI_ERRNO.SUCCESS);
    const file = open("/nest/before.txt", OFLAGS_CREAT | OFLAGS_TRUNC);
    expect(write(file.fd, "carried")).toEqual({ errno: 0, written: 7 });

    const from = memory.string("/nest/before.txt");
    const to = memory.string("/nest/after.txt");
    expect(wasi.path_rename(3, from.ptr, from.len, 3, to.ptr, to.len)).toBe(WASI_ERRNO.SUCCESS);
    // The descriptor followed the file: a resize now lands on the NEW name, not on a fresh old one.
    expect(wasi.fd_filestat_set_size(file.fd, 3n)).toBe(WASI_ERRNO.SUCCESS);
    const stat = memory.alloc(64);
    expect(wasi.path_filestat_get(3, 0, to.ptr, to.len, stat)).toBe(WASI_ERRNO.SUCCESS);
    expect(memory.u64(stat + 32)).toBe(3n);
    expect(wasi.path_filestat_get(3, 0, from.ptr, from.len, stat)).toBe(WASI_ERRNO.NOENT);
    expect(wasi.fd_close(file.fd)).toBe(WASI_ERRNO.SUCCESS);

    expect(wasi.path_remove_directory(3, nest.ptr, nest.len)).toBe(WASI_ERRNO.NOTEMPTY);
    expect(wasi.path_unlink_file(3, to.ptr, to.len)).toBe(WASI_ERRNO.SUCCESS);
    expect(wasi.path_unlink_file(3, to.ptr, to.len)).toBe(WASI_ERRNO.NOENT);
    expect(wasi.path_remove_directory(3, nest.ptr, nest.len)).toBe(WASI_ERRNO.SUCCESS);
    expect(wasi.path_remove_directory(3, nest.ptr, nest.len)).toBe(WASI_ERRNO.NOENT);
    expect(errors).toEqual([]);
  });

  test("the symlink surface is answered without pretending the store has any", () => {
    memory.reset();
    const file = open("/not-a-link", OFLAGS_CREAT | OFLAGS_TRUNC);
    expect(wasi.fd_close(file.fd)).toBe(WASI_ERRNO.SUCCESS);
    const path = memory.string("/not-a-link");
    const missing = memory.string("/never-existed");
    const buf = memory.alloc(64);
    const used = memory.alloc(4);
    // EINVAL for an existing non-symlink is POSIX's own answer; ENOENT still has to win.
    expect(wasi.path_readlink(3, path.ptr, path.len, buf, 64, used)).toBe(WASI_ERRNO.INVAL);
    expect(wasi.path_readlink(3, missing.ptr, missing.len, buf, 64, used)).toBe(WASI_ERRNO.NOENT);
    expect(wasi.path_symlink(path.ptr, path.len, 3, missing.ptr, missing.len)).toBe(WASI_ERRNO.NOTSUP);
    expect(wasi.path_link(3, 0, path.ptr, path.len, 3, missing.ptr, missing.len)).toBe(WASI_ERRNO.NOTSUP);
    // The store keeps no utimes, and the adapter refuses to invent one that only it would believe.
    expect(wasi.fd_filestat_set_times(3, 0n, 0n, 0)).toBe(WASI_ERRNO.SUCCESS);
    expect(wasi.path_filestat_set_times(3, 0, path.ptr, path.len, 0n, 0n, 4)).toBe(WASI_ERRNO.NOTSUP);
    expect(wasi.fd_advise(3, 0n, 0n, 0)).toBe(WASI_ERRNO.SUCCESS);
    expect(wasi.fd_advise(999, 0n, 0n, 0)).toBe(WASI_ERRNO.BADF);
  });

  test("fd_allocate extends by truncation and never shrinks", () => {
    memory.reset();
    const file = open("/allocate.bin", OFLAGS_CREAT | OFLAGS_TRUNC);
    expect(write(file.fd, "abcd")).toEqual({ errno: 0, written: 4 });
    expect(wasi.fd_allocate(file.fd, 0n, 2n)).toBe(WASI_ERRNO.SUCCESS);
    const stat = memory.alloc(64);
    expect(wasi.fd_filestat_get(file.fd, stat)).toBe(WASI_ERRNO.SUCCESS);
    expect(memory.u64(stat + 32)).toBe(4n);
    expect(wasi.fd_allocate(file.fd, 4n, 12n)).toBe(WASI_ERRNO.SUCCESS);
    expect(wasi.fd_filestat_get(file.fd, stat)).toBe(WASI_ERRNO.SUCCESS);
    expect(memory.u64(stat + 32)).toBe(16n);
    expect(wasi.fd_close(file.fd)).toBe(WASI_ERRNO.SUCCESS);
  });

  test("a transport failure becomes EIO with a logged cause, never a throw into the guest", () => {
    memory.reset();
    const gone = (): never => {
      throw new Error("the coordinator went away");
    };
    const brokenClient = { stat: gone, lstat: gone } as unknown as RepackedSyncClient;
    const failing = createWasiPreview1Fs({
      client: brokenClient,
      memory: memory.resolver,
      onError: (call, cause) => errors.push(`${call}: ${String(cause)}`),
    });
    const path = memory.string("/anything");
    const stat = memory.alloc(64);
    // A throw out of a WASI import reaches the guest as a bare `RuntimeError: unreachable`; the
    // adapter turns it into an errno the guest can act on and keeps the stack on this side.
    expect(failing.path_filestat_get(3, 0, path.ptr, path.len, stat)).toBe(WASI_ERRNO.IO);
    expect(errors.at(-1)).toContain("path_filestat_get: Error: the coordinator went away");
    errors.length = 0;
  });
});
