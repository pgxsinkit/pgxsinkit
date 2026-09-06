import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { RepackedSyncClient } from "../../packages/pglite-opfs-repacked/src/broker/client";
import {
  OFLAGS_CREAT,
  OFLAGS_DIRECTORY,
  OFLAGS_TRUNC,
  RIGHTS_FD_READ,
  RIGHTS_FD_WRITE,
  WASI_ERRNO,
  WASI_FILETYPE,
  createWasiPreview1Fs,
  normalizeWasiPath,
} from "../../packages/pglite-opfs-repacked/src/wasi/preview1";
import type { WasiPreview1Fs } from "../../packages/pglite-opfs-repacked/src/wasi/preview1";
import { startBrokerWorker } from "../../packages/pglite-opfs-repacked/test/support/broker-harness";
import type { BrokerWorkerHandle } from "../../packages/pglite-opfs-repacked/test/support/broker-harness";
import { GuestMemory, decodeDirents } from "../../packages/pglite-opfs-repacked/test/support/wasi-guest";

// Directory fds are the part of the adapter with no counterpart in the store: the store cannot open a
// directory at all, so a directory fd is a remembered path plus a listing snapshot. Everything here is
// about the two things a guest actually depends on — that a truncated `fd_readdir` says so, and that
// resuming from the cookie it reported yields the rest exactly once.

const RW = RIGHTS_FD_READ | RIGHTS_FD_WRITE;

describe("opfs-repacked WASI preview1 directories", () => {
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

  function openDir(path: string): number {
    const encoded = memory.string(path);
    const out = memory.alloc(4);
    const errno = wasi.path_open(3, 0, encoded.ptr, encoded.len, OFLAGS_DIRECTORY, RW, RW, 0, out);
    expect(errno).toBe(WASI_ERRNO.SUCCESS);
    return memory.u32(out);
  }

  function touch(path: string, dirfd = 3): void {
    const encoded = memory.string(path);
    const out = memory.alloc(4);
    const errno = wasi.path_open(dirfd, 0, encoded.ptr, encoded.len, OFLAGS_CREAT | OFLAGS_TRUNC, RW, RW, 0, out);
    expect(errno).toBe(WASI_ERRNO.SUCCESS);
    expect(wasi.fd_close(memory.u32(out))).toBe(WASI_ERRNO.SUCCESS);
  }

  /** One `fd_readdir` call, decoded the way wasi-libc decodes it. */
  function readdir(fd: number, bufLen: number, cookie: bigint) {
    const buf = memory.alloc(bufLen);
    memory.bytes().fill(0, buf, buf + bufLen);
    const usedPtr = memory.alloc(4);
    const errno = wasi.fd_readdir(fd, buf, bufLen, cookie, usedPtr);
    const used = memory.u32(usedPtr);
    return { errno, used, bufLen, entries: decodeDirents(memory, buf, used) };
  }

  test("the preopen answers prestat and serves as the dirfd every relative path resolves against", () => {
    memory.reset();
    const prestat = memory.alloc(8);
    expect(wasi.fd_prestat_get(3, prestat)).toBe(WASI_ERRNO.SUCCESS);
    expect(memory.view().getUint8(prestat)).toBe(0); // preopentype::dir
    expect(memory.u32(prestat + 4)).toBe(1); // strlen("/")
    expect(wasi.fd_prestat_get(4, prestat)).toBe(WASI_ERRNO.BADF);

    const name = memory.alloc(4);
    expect(wasi.fd_prestat_dir_name(3, name, 4)).toBe(WASI_ERRNO.SUCCESS);
    expect(memory.text(name, 1)).toBe("/");
    expect(wasi.fd_prestat_dir_name(3, name, 0)).toBe(WASI_ERRNO.INVAL);

    // A dirfd of the adapter's own making resolves relative paths against ITS path, and an absolute
    // path is still accepted from either — the leniency wasi-libc's callers rely on.
    expect(mkdir("/relative")).toBe(WASI_ERRNO.SUCCESS);
    const dirfd = openDir("/relative");
    touch("child.txt", dirfd);
    touch("/relative/sibling.txt", dirfd);
    const listed = readdir(dirfd, 4096, 0n);
    expect(listed.errno).toBe(WASI_ERRNO.SUCCESS);
    expect(listed.entries.map((entry) => entry.name)).toEqual(["child.txt", "sibling.txt"]);
    // No "." or ".." — the store does not carry them and neither does the host this replaces.
    expect(listed.entries.every((entry) => entry.filetype === WASI_FILETYPE.REGULAR_FILE)).toBe(true);
    expect(wasi.fd_close(dirfd)).toBe(WASI_ERRNO.SUCCESS);
  });

  test("a listing that does not fit one buffer reports it and resumes exactly from the cookie", () => {
    memory.reset();
    expect(mkdir("/paged")).toBe(WASI_ERRNO.SUCCESS);
    const names = Array.from({ length: 12 }, (_unused, index) => `entry-${String(index).padStart(2, "0")}`);
    for (const name of names) touch(`/paged/${name}`);
    expect(mkdir("/paged/nested")).toBe(WASI_ERRNO.SUCCESS);
    const expected = [...names, "nested"].sort();

    const dirfd = openDir("/paged");
    // 92 bytes holds two complete 24+8-byte records and the head of a third: the caller must see a
    // full buffer AND a name it could not finish reading.
    const first = readdir(dirfd, 92, 0n);
    expect(first.errno).toBe(WASI_ERRNO.SUCCESS);
    expect(first.used).toBe(first.bufLen); // a full buffer is the WASI signal to grow and retry
    expect(first.entries.length).toBeGreaterThan(0);
    expect(first.entries.at(-1)?.truncated).toBe(true);

    // Resume from the cookie of the last COMPLETE record, exactly as wasi-libc's readdir does.
    const complete = first.entries.filter((entry) => !entry.truncated);
    const collected = complete.map((entry) => entry.name);
    let cookie = complete.at(-1)!.next;
    for (let guard = 0; guard < 20 && collected.length < expected.length; guard += 1) {
      const page = readdir(dirfd, 92, cookie);
      expect(page.errno).toBe(WASI_ERRNO.SUCCESS);
      const whole = page.entries.filter((entry) => !entry.truncated);
      expect(whole.length).toBeGreaterThan(0);
      collected.push(...whole.map((entry) => entry.name));
      cookie = whole.at(-1)!.next;
    }
    expect(collected).toEqual(expected);

    // The nested directory is reported as a directory, and the last page is short of the buffer —
    // which is how a caller knows the listing ended.
    const everything = readdir(dirfd, 8192, 0n);
    expect(everything.used).toBeLessThan(8192);
    expect(everything.entries.map((entry) => entry.name)).toEqual(expected);
    expect(everything.entries.find((entry) => entry.name === "nested")?.filetype).toBe(WASI_FILETYPE.DIRECTORY);
    // A cookie past the end is the end of the directory, never an error and never a broker rejection.
    const past = readdir(dirfd, 8192, 9999n);
    expect(past).toMatchObject({ errno: WASI_ERRNO.SUCCESS, used: 0 });
    expect(wasi.fd_close(dirfd)).toBe(WASI_ERRNO.SUCCESS);
    expect(errors).toEqual([]);
  });

  test("a directory with more entries than one broker page holds still lists completely", () => {
    memory.reset();
    expect(mkdir("/wide")).toBe(WASI_ERRNO.SUCCESS);
    const count = 320;
    const expected: string[] = [];
    for (let index = 0; index < count; index += 1) {
      // Long names on purpose: 320 of them exceed one 64 KiB broker readdir page, so the adapter's
      // snapshot has to stitch several `readdirPage` answers together.
      const name = `wide-entry-${String(index).padStart(4, "0")}-${"x".repeat(200)}`;
      touch(`/wide/${name}`);
      expected.push(name);
    }
    expected.sort();

    const dirfd = openDir("/wide");
    const collected: string[] = [];
    let cookie = 0n;
    for (let guard = 0; guard < 400 && collected.length < count; guard += 1) {
      const page = readdir(dirfd, 4096, cookie);
      expect(page.errno).toBe(WASI_ERRNO.SUCCESS);
      const whole = page.entries.filter((entry) => !entry.truncated);
      expect(whole.length).toBeGreaterThan(0);
      collected.push(...whole.map((entry) => entry.name));
      cookie = whole.at(-1)!.next;
    }
    expect(collected.length).toBe(count);
    expect(collected).toEqual(expected);
    expect(wasi.fd_close(dirfd)).toBe(WASI_ERRNO.SUCCESS);
    expect(errors).toEqual([]);
  });

  test("a file fd is not a directory and a directory fd is not a file", () => {
    memory.reset();
    touch("/plain.txt");
    const encoded = memory.string("/plain.txt");
    const out = memory.alloc(4);
    expect(wasi.path_open(3, 0, encoded.ptr, encoded.len, 0, RW, RW, 0, out)).toBe(WASI_ERRNO.SUCCESS);
    const fileFd = memory.u32(out);
    const usedPtr = memory.alloc(4);
    const buf = memory.alloc(256);
    expect(wasi.fd_readdir(fileFd, buf, 256, 0n, usedPtr)).toBe(WASI_ERRNO.NOTDIR);
    // A file fd used as a dirfd is EBADF, exactly as the host this replaces answers.
    const child = memory.string("child");
    expect(wasi.path_create_directory(fileFd, child.ptr, child.len)).toBe(WASI_ERRNO.BADF);
    expect(wasi.fd_close(fileFd)).toBe(WASI_ERRNO.SUCCESS);

    const dirfd = openDir("/");
    const stat = memory.alloc(64);
    expect(wasi.fd_filestat_get(dirfd, stat)).toBe(WASI_ERRNO.SUCCESS);
    expect(memory.view().getUint8(stat + 16)).toBe(WASI_FILETYPE.DIRECTORY);
    // fsync on a directory is legal and lands on the store-wide flush.
    expect(wasi.fd_sync(dirfd)).toBe(WASI_ERRNO.SUCCESS);
    expect(wasi.fd_filestat_set_size(dirfd, 0n)).toBe(WASI_ERRNO.ISDIR);
    expect(wasi.fd_close(dirfd)).toBe(WASI_ERRNO.SUCCESS);
  });

  test("guest paths are canonicalized the way the store demands before they ever reach it", () => {
    expect(normalizeWasiPath("pgdata/base")).toBe("/pgdata/base");
    expect(normalizeWasiPath("/pgdata//base/./")).toBe("/pgdata/base");
    expect(normalizeWasiPath("/pgdata/base/../global")).toBe("/pgdata/global");
    expect(normalizeWasiPath("/pgdata/base\0\0")).toBe("/pgdata/base");
    expect(normalizeWasiPath("")).toBe("/");
    expect(normalizeWasiPath(".")).toBe("/");
    expect(normalizeWasiPath("/../..")).toBe("/");
  });
});
