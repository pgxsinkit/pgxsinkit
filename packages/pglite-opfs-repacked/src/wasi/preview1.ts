/**
 * A WASI preview1 FILESYSTEM adapter over `RepackedSyncClient`.
 *
 * ## Why this file exists
 *
 * The broker gives a futex-parked thread synchronous access to ONE repacked store. A wasm engine does
 * not speak that API — it speaks `wasi_snapshot_preview1`, thirty-odd i32-returning imports over its
 * own linear memory. This module is the seam: every WASI file call a guest makes is translated into a
 * broker request, and the errno the broker already speaks (the protocol's numbers ARE WASI preview1
 * errnos) is handed straight back. Nothing here knows about PGlite, OPFS, or any particular engine —
 * it needs a client, a way to reach the guest's memory, and nothing else.
 *
 * ## What it owns and what it refuses to touch
 *
 * The adapter owns fd `preopenFd` (3 by default — the "/" preopen) and every fd at or above `fdBase`
 * (4 by default). It NEVER touches fds 0–2: a host keeps its own stdin/stdout/stderr, and
 * {@link WasiPreview1Fs.compose} builds the merged import object that routes each call to whichever
 * side owns the fd. `owns()` is public so a host can make that decision itself.
 *
 * ## The fd table
 *
 * One entry per open descriptor, keyed by the WASI fd the guest sees:
 *
 *     { fd, path, isDir, clientFd, offset, fdflags, rightsBase, rightsInheriting, readable, writable }
 *
 * - `path` is the normalized absolute path the fd was opened with. It is kept for the whole life of
 *   the descriptor because the store resizes by PATH, not by descriptor: `fd_filestat_set_size` and
 *   `fd_allocate` resolve through it.
 * - `clientFd` is the broker's descriptor for a FILE. A DIRECTORY has none: the store cannot open a
 *   directory at all (its `open` answers `EISDIR`), so a directory fd is adapter-local — a remembered
 *   path plus a listing snapshot — and is still usable for `fd_readdir`, `fd_filestat_get`, `fd_sync`
 *   and as a dirfd for every path operation.
 * - `offset` is tracked HERE, not in the store. Every read and write the adapter issues carries an
 *   explicit position (the store's `pread`/`pwrite` form), so the store's own cursor is never used and
 *   `fd_seek`/`fd_tell` are exact even though several threads share one store.
 *
 * ## The mapping, decision by decision
 *
 * - **rights → access.** `RIGHTS_FD_READ` grants read, `RIGHTS_FD_WRITE` grants write; a request that
 *   asks for neither is read-only. That access is enforced by the BROKER (per its own fd) and again
 *   here, because a POSIX `open(O_RDONLY|O_CREAT)` has to open the store descriptor wider than the
 *   guest asked for — see below.
 * - **oflags → POSIX bits.** `CREAT`→`O_CREAT`, `EXCL`→`O_EXCL`, `TRUNC`→`O_TRUNC`, and the access
 *   mode from the rights. `planOpen` (server side) rejects `O_CREAT`/`O_TRUNC` without write access,
 *   so a create/truncate request always adds write to the POSIX access mode while the adapter keeps
 *   the NARROWER access the rights asked for and rejects a later `fd_write` with `ENOTCAPABLE`.
 * - **`O_DIRECTORY` and directories.** With `DIRECTORY` set the adapter never calls `open` (that would
 *   create a file); it stats and builds a directory fd. Without it, `open` is attempted and an
 *   `EISDIR` answer is recognised as "this is a directory" and turned into a directory fd too — which
 *   costs nothing on the common file path.
 * - **`O_APPEND` is emulated here, never passed to the broker.** An append write resolves end-of-file
 *   with `fstat` and then `pwrite`s there, so the adapter's own offset stays exact and
 *   `fd_fdstat_set_flags` can turn `APPEND` on and off on a descriptor that was not opened with it.
 * - **`fd_seek`.** `SET`/`CUR` are pure arithmetic on the adapter's offset; `END` resolves the size
 *   with `fstat` on the broker fd (never `size(path)`, which would race a rename).
 * - **`fd_readdir` cookies.** A cookie is an index into a listing SNAPSHOT taken on cookie 0, exactly
 *   as a POSIX `readdir` may. The snapshot is built out of `readdirPage` calls, and it exists for a
 *   protocol reason as much as a semantic one: the broker treats a cursor past the end of the listing
 *   as a protocol violation and DETACHES the client, so a stale cookie from a directory that shrank
 *   must never reach it. A cookie past the snapshot's end reports zero bytes used — end of directory.
 * - **truncate by path.** `fd_filestat_set_size` and `fd_allocate` call `truncate(path, size)` with
 *   the descriptor's remembered path. The store has no hard links, so nothing is lost.
 * - **`fd_sync`/`fd_datasync`.** Both map to the broker's `fsync`, whose durability is STORE-WIDE: on
 *   success every byte written through the broker by ANY client before the call returned is
 *   recoverable. That is stronger than `fd_sync` promises, never weaker.
 * - **symlinks.** The store has none: `path_readlink` is `EINVAL` (POSIX's answer for a non-symlink),
 *   `path_symlink` and `path_link` are `ENOTSUP`, and `SYMLINK_FOLLOW` in a `path_filestat_get`
 *   lookup flag makes no difference (`stat` and `lstat` agree).
 * - **`fd_advise`** is a no-op success. **`fd_filestat_set_times`/`path_filestat_set_times`** answer
 *   `ENOTSUP`: the broker exposes no `utimes` opcode, and inventing an adapter-local timestamp would
 *   make two threads on ONE store disagree about a file's mtime, which is exactly what this whole
 *   arrangement exists to prevent.
 *
 * ## Failure discipline
 *
 * Every exported function is wrapped so that a JS exception can never leave it. A throw out of a WASI
 * import unwinds through the guest's nounwind frames and surfaces as a bare `RuntimeError:
 * unreachable` with no attribution at all; instead the wrapper reports `EIO` and hands the cause to
 * `onError` with the call name. A transport failure (the coordinator died, the client was detached) is
 * therefore an `EIO` the guest can act on rather than an abort it cannot.
 */

import type { RepackedSyncClient } from "../broker/client";
import { O_CREAT, O_EXCL, O_RDONLY, O_RDWR, O_TRUNC, O_WRONLY } from "../broker/protocol";
import type { BrokerStat } from "../broker/protocol";

/**
 * WASI preview1 errno numbers. A superset of the store's own `FS_ERRNO` (whose values already ARE
 * these numbers); the extra codes are ones a filesystem ADAPTER has to answer and the store core
 * never produces, so they live here rather than widening the core's error vocabulary.
 */
export const WASI_ERRNO = {
  SUCCESS: 0,
  ACCES: 2,
  BADF: 8,
  EXIST: 20,
  INVAL: 28,
  IO: 29,
  ISDIR: 31,
  NOENT: 44,
  NOSYS: 52,
  NOTDIR: 54,
  NOTEMPTY: 55,
  NOTSUP: 58,
  OVERFLOW: 61,
  PERM: 63,
  SPIPE: 70,
  NOTCAPABLE: 76,
} as const;

/** WASI preview1 filetypes. */
export const WASI_FILETYPE = {
  UNKNOWN: 0,
  BLOCK_DEVICE: 1,
  CHARACTER_DEVICE: 2,
  DIRECTORY: 3,
  REGULAR_FILE: 4,
  SOCKET_DGRAM: 5,
  SOCKET_STREAM: 6,
  SYMBOLIC_LINK: 7,
} as const;

/** `path_open` oflags. */
export const OFLAGS_CREAT = 1;
export const OFLAGS_DIRECTORY = 2;
export const OFLAGS_EXCL = 4;
export const OFLAGS_TRUNC = 8;

/** `fdflags`, on `path_open` and `fd_fdstat_set_flags`. */
export const FDFLAGS_APPEND = 1;
export const FDFLAGS_DSYNC = 2;
export const FDFLAGS_NONBLOCK = 4;
export const FDFLAGS_RSYNC = 8;
export const FDFLAGS_SYNC = 16;

/** `lookupflags`, on every path operation that could follow a symlink. */
export const LOOKUPFLAGS_SYMLINK_FOLLOW = 1;

/** The two rights the adapter reads; the rest are carried through untouched. */
export const RIGHTS_FD_READ = 1n << 1n;
export const RIGHTS_FD_WRITE = 1n << 6n;
/** What a preopen advertises when the host asked for nothing narrower. */
export const RIGHTS_ALL = 0xffff_ffff_ffff_ffffn;

/** `fd_seek` whence values. */
export const WHENCE_SET = 0;
export const WHENCE_CUR = 1;
export const WHENCE_END = 2;

/** `filestat` is 64 bytes; `dirent` is 24 bytes plus the name. */
const FILESTAT_BYTES = 64;
const DIRENT_HEADER_BYTES = 24;
/** What `stat` reports for a directory — the store has no directory size, and `0` confuses callers. */
const DIRECTORY_SIZE = 4096n;
const NS_PER_MS = 1_000_000n;

/** One open descriptor the adapter owns. */
interface AdapterFd {
  readonly fd: number;
  /** The normalized absolute path this fd was opened with; the store resizes by path only. */
  path: string;
  readonly isDir: boolean;
  /** The broker's descriptor — `undefined` for a directory, which the store cannot open. */
  readonly clientFd: number | undefined;
  /** The adapter's own cursor. Every transfer carries an explicit position, so this is authoritative. */
  offset: bigint;
  fdflags: number;
  rightsBase: bigint;
  rightsInheriting: bigint;
  readonly readable: boolean;
  readonly writable: boolean;
  /** The listing snapshot a `fd_readdir` cookie indexes into, taken on cookie 0. */
  listing: DirentSnapshot | undefined;
}

interface DirentSnapshot {
  readonly names: readonly string[];
  /** Lazily filled per emitted entry: a `d_type` costs one `lstat`, so only emitted names pay it. */
  readonly filetypes: Map<string, number>;
}

export interface WasiPreview1FsOptions {
  /** The synchronous broker client this adapter turns WASI calls into. */
  readonly client: RepackedSyncClient;
  /**
   * The guest's linear memory, resolved on EVERY call. A shared wasm memory grows underneath the host
   * and any cached `Uint8Array`/`DataView` goes stale (or detaches outright, for a non-shared one), so
   * nothing here holds a view across a call.
   */
  readonly memory: () => ArrayBuffer | SharedArrayBuffer;
  /** The fd the guest sees the preopened directory as. Defaults to 3, the WASI convention. */
  readonly preopenFd?: number;
  /** The directory that preopen names. Defaults to the store root. */
  readonly preopenPath?: string;
  /** The first fd the adapter hands out, and the bottom of the range it claims. Defaults to 4. */
  readonly fdBase?: number;
  /** The adapter's clock, in milliseconds. Defaults to the wall clock; used for diagnostics. */
  readonly now?: () => bigint;
  /** Where a JS exception that escaped a WASI call is reported. Defaults to `console.error`. */
  readonly onError?: (call: string, cause: unknown) => void;
}

/** The `wasi_snapshot_preview1` filesystem surface, with the ABI's exact signatures. */
export interface WasiPreview1FsFunctions {
  fd_prestat_get(fd: number, resultPtr: number): number;
  fd_prestat_dir_name(fd: number, pathPtr: number, pathLen: number): number;
  fd_close(fd: number): number;
  fd_read(fd: number, iovsPtr: number, iovsLen: number, nreadPtr: number): number;
  fd_pread(fd: number, iovsPtr: number, iovsLen: number, offset: bigint, nreadPtr: number): number;
  fd_write(fd: number, iovsPtr: number, iovsLen: number, nwrittenPtr: number): number;
  fd_pwrite(fd: number, iovsPtr: number, iovsLen: number, offset: bigint, nwrittenPtr: number): number;
  fd_seek(fd: number, offset: bigint, whence: number, resultPtr: number): number;
  fd_tell(fd: number, resultPtr: number): number;
  fd_fdstat_get(fd: number, resultPtr: number): number;
  fd_fdstat_set_flags(fd: number, fdflags: number): number;
  fd_fdstat_set_rights(fd: number, rightsBase: bigint, rightsInheriting: bigint): number;
  fd_filestat_get(fd: number, resultPtr: number): number;
  fd_filestat_set_size(fd: number, size: bigint): number;
  fd_filestat_set_times(fd: number, atim: bigint, mtim: bigint, fstflags: number): number;
  fd_readdir(fd: number, bufPtr: number, bufLen: number, cookie: bigint, bufusedPtr: number): number;
  fd_sync(fd: number): number;
  fd_datasync(fd: number): number;
  fd_allocate(fd: number, offset: bigint, length: bigint): number;
  fd_advise(fd: number, offset: bigint, length: bigint, advice: number): number;
  path_open(
    dirfd: number,
    dirflags: number,
    pathPtr: number,
    pathLen: number,
    oflags: number,
    rightsBase: bigint,
    rightsInheriting: bigint,
    fdflags: number,
    resultPtr: number,
  ): number;
  path_filestat_get(dirfd: number, flags: number, pathPtr: number, pathLen: number, resultPtr: number): number;
  path_filestat_set_times(
    dirfd: number,
    flags: number,
    pathPtr: number,
    pathLen: number,
    atim: bigint,
    mtim: bigint,
    fstflags: number,
  ): number;
  path_create_directory(dirfd: number, pathPtr: number, pathLen: number): number;
  path_remove_directory(dirfd: number, pathPtr: number, pathLen: number): number;
  path_unlink_file(dirfd: number, pathPtr: number, pathLen: number): number;
  path_rename(dirfd: number, oldPtr: number, oldLen: number, newDirfd: number, newPtr: number, newLen: number): number;
  path_readlink(
    dirfd: number,
    pathPtr: number,
    pathLen: number,
    bufPtr: number,
    bufLen: number,
    bufusedPtr: number,
  ): number;
  path_symlink(oldPtr: number, oldLen: number, dirfd: number, newPtr: number, newLen: number): number;
  path_link(
    oldDirfd: number,
    oldFlags: number,
    oldPtr: number,
    oldLen: number,
    newDirfd: number,
    newPtr: number,
    newLen: number,
  ): number;
}

/** The adapter: the WASI surface plus the three composition/lifecycle helpers a host needs. */
export interface WasiPreview1Fs extends WasiPreview1FsFunctions {
  /** Whether this adapter answers for `fd`: the preopen, or anything at or above `fdBase`. */
  owns(fd: number): boolean;
  /** How many descriptors the adapter currently holds, preopen excluded. */
  openFdCount(): number;
  /**
   * A merged `wasi_snapshot_preview1` object: every filesystem call goes to the adapter when the fd
   * (or the dirfd, for a path operation) is adapter-owned and to `base` otherwise. Everything in
   * `base` that is not a filesystem call — `args_get`, `clock_time_get`, `poll_oneoff`, `proc_exit`,
   * `random_get`, `sched_yield`, the socket stubs — is carried through untouched, as are `base`'s own
   * fd 0/1/2 handlers.
   */
  compose(base: Readonly<Record<string, unknown>>): Record<string, unknown>;
  /**
   * Close every descriptor, returning how many were released. The call a thread makes on its way out:
   * without it the coordinator holds the thread's store descriptors until the whole channel detaches.
   */
  closeAll(): number;
}

/** Every filesystem import name, mapped to the argument index carrying the fd or dirfd. */
const FD_ARGUMENT_INDEX: Readonly<Record<keyof WasiPreview1FsFunctions, number>> = {
  fd_prestat_get: 0,
  fd_prestat_dir_name: 0,
  fd_close: 0,
  fd_read: 0,
  fd_pread: 0,
  fd_write: 0,
  fd_pwrite: 0,
  fd_seek: 0,
  fd_tell: 0,
  fd_fdstat_get: 0,
  fd_fdstat_set_flags: 0,
  fd_fdstat_set_rights: 0,
  fd_filestat_get: 0,
  fd_filestat_set_size: 0,
  fd_filestat_set_times: 0,
  fd_readdir: 0,
  fd_sync: 0,
  fd_datasync: 0,
  fd_allocate: 0,
  fd_advise: 0,
  path_open: 0,
  path_filestat_get: 0,
  path_filestat_set_times: 0,
  path_create_directory: 0,
  path_remove_directory: 0,
  path_unlink_file: 0,
  path_rename: 0,
  path_readlink: 0,
  // The only call whose directory argument is not first: `path_symlink(old_path, old_len, fd, …)`.
  path_symlink: 2,
  path_link: 0,
};

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: false });

/**
 * Canonicalize a guest path the way the store demands: absolute, no `.`/`..`, no empty or repeated
 * separator, no trailing slash. Deliberately lenient in the same places a WASI host has to be —
 * wasi-libc hands preopen-RELATIVE paths, but an absolute one is accepted too, and a trailing NUL from
 * a fixed-size buffer is stripped rather than rejected.
 */
export function normalizeWasiPath(path: string): string {
  let value = path.replace(/\0+$/u, "");
  if (value === "" || value === ".") return "/";
  if (!value.startsWith("/")) value = `/${value}`;
  const parts: string[] = [];
  for (const segment of value.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return `/${parts.join("/")}`;
}

/**
 * A stable synthetic inode number for a path. The store has no inode numbers on the wire, and a WASI
 * `filestat`/`dirent` must carry one; a 64-bit FNV-1a of the path is stable for as long as the path
 * is, never zero, and never collides in practice within one datadir.
 */
function inodeOf(path: string): bigint {
  let hash = 0xcbf2_9ce4_8422_2325n;
  const bytes = textEncoder.encode(path);
  for (const byte of bytes) {
    hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x1000_0000_01b3n);
  }
  return hash === 0n ? 1n : hash;
}

function toBigInt(value: bigint | number): bigint {
  return typeof value === "bigint" ? value : BigInt(Math.trunc(value));
}

export function createWasiPreview1Fs(options: WasiPreview1FsOptions): WasiPreview1Fs {
  const client = options.client;
  const preopenFd = options.preopenFd ?? 3;
  const preopenPath = normalizeWasiPath(options.preopenPath ?? "/");
  const fdBase = options.fdBase ?? preopenFd + 1;
  const now = options.now ?? (() => BigInt(Date.now()));
  const onError =
    options.onError ??
    ((call: string, cause: unknown) => {
      const detail = cause instanceof Error ? (cause.stack ?? `${cause.name}: ${cause.message}`) : String(cause);
      console.error(`[wasi-preview1 ${call} @${now()}] ${detail}`);
    });

  if (!Number.isSafeInteger(preopenFd) || preopenFd < 3) {
    throw new RangeError("a WASI preopen fd must be a safe integer of at least 3 (0-2 are stdio)");
  }
  if (!Number.isSafeInteger(fdBase) || fdBase <= preopenFd) {
    throw new RangeError("the WASI adapter fd base must be a safe integer above the preopen fd");
  }

  const table = new Map<number, AdapterFd>();
  let nextFd = fdBase;

  const preopenEntry = (): AdapterFd => ({
    fd: preopenFd,
    path: preopenPath,
    isDir: true,
    clientFd: undefined,
    offset: 0n,
    fdflags: 0,
    rightsBase: RIGHTS_ALL,
    rightsInheriting: RIGHTS_ALL,
    readable: true,
    writable: false,
    listing: undefined,
  });
  table.set(preopenFd, preopenEntry());

  // ---- memory access -------------------------------------------------------
  // Re-derived per call, never cached: the guest memory is shared and grows underneath us.
  const bytes = (): Uint8Array => new Uint8Array(options.memory());
  const view = (): DataView => new DataView(options.memory());

  function readGuestString(ptr: number, length: number): string {
    // `.slice()`, not `.subarray()`: TextDecoder refuses a SharedArrayBuffer-backed view in Chrome
    // (the [AllowShared] rule). Paths are short, so the copy costs nothing.
    return textDecoder.decode(bytes().slice(ptr, ptr + length));
  }

  function* iovecs(ptr: number, count: number): Generator<{ ptr: number; len: number }> {
    const data = view();
    for (let index = 0; index < count; index += 1) {
      const base = ptr + index * 8;
      yield { ptr: data.getUint32(base, true), len: data.getUint32(base + 4, true) };
    }
  }

  // ---- fd table ------------------------------------------------------------
  function owns(fd: number): boolean {
    return fd === preopenFd || (Number.isSafeInteger(fd) && fd >= fdBase);
  }

  function entryOf(fd: number): AdapterFd | undefined {
    return table.get(fd);
  }

  function allocate(entry: Omit<AdapterFd, "fd">): number {
    const fd = nextFd;
    nextFd += 1;
    table.set(fd, { ...entry, fd });
    return fd;
  }

  function resolve(dirfd: number, ptr: number, length: number): string | undefined {
    const dir = entryOf(dirfd);
    if (dir === undefined || !dir.isDir) return undefined;
    const relative = readGuestString(ptr, length);
    if (relative.startsWith("/")) return normalizeWasiPath(relative);
    return normalizeWasiPath(dir.path === "/" ? `/${relative}` : `${dir.path}/${relative}`);
  }

  // ---- stat ----------------------------------------------------------------
  function writeFilestat(ptr: number, path: string, stat: BrokerStat): void {
    // Zero first: the struct has padding the guest is entitled to see as zero, and a reused stack
    // slot would otherwise hand it whatever the last call left there.
    bytes().fill(0, ptr, ptr + FILESTAT_BYTES);
    const data = view();
    const isDirectory = stat.kind === "directory";
    const times = [stat.atimeMs, stat.mtimeMs, stat.ctimeMs].map((ms) => ms * NS_PER_MS);
    data.setBigUint64(ptr + 0, 1n, true); // dev
    data.setBigUint64(ptr + 8, inodeOf(path), true); // ino
    data.setUint8(ptr + 16, isDirectory ? WASI_FILETYPE.DIRECTORY : WASI_FILETYPE.REGULAR_FILE);
    data.setBigUint64(ptr + 24, 1n, true); // nlink
    data.setBigUint64(ptr + 32, isDirectory ? DIRECTORY_SIZE : stat.size, true);
    data.setBigUint64(ptr + 40, times[0]!, true); // atim
    data.setBigUint64(ptr + 48, times[1]!, true); // mtim
    data.setBigUint64(ptr + 56, times[2]!, true); // ctim
  }

  /** The size of a descriptor's file, from the broker fd (never the path — a rename must not race it). */
  function sizeOf(entry: AdapterFd): { errno: number; size: bigint } {
    if (entry.clientFd === undefined) return { errno: 0, size: DIRECTORY_SIZE };
    const stat = client.fstat(entry.clientFd);
    if (stat.errno !== 0 || stat.stat === undefined) return { errno: stat.errno || WASI_ERRNO.IO, size: 0n };
    return { errno: 0, size: stat.stat.size };
  }

  // ---- the WASI surface ----------------------------------------------------
  const fs: WasiPreview1FsFunctions = {
    fd_prestat_get(fd, resultPtr) {
      if (fd !== preopenFd) return WASI_ERRNO.BADF;
      const data = view();
      data.setUint8(resultPtr, 0); // preopentype::dir
      data.setUint32(resultPtr + 4, textEncoder.encode(preopenPath).byteLength, true);
      return WASI_ERRNO.SUCCESS;
    },

    fd_prestat_dir_name(fd, pathPtr, pathLen) {
      if (fd !== preopenFd) return WASI_ERRNO.BADF;
      const encoded = textEncoder.encode(preopenPath);
      if (pathLen < encoded.byteLength) return WASI_ERRNO.INVAL;
      bytes().set(encoded, pathPtr);
      return WASI_ERRNO.SUCCESS;
    },

    fd_close(fd) {
      if (fd === preopenFd) return WASI_ERRNO.SUCCESS; // the preopen outlives every guest close
      const entry = entryOf(fd);
      if (entry === undefined) return WASI_ERRNO.BADF;
      table.delete(fd);
      if (entry.clientFd === undefined) return WASI_ERRNO.SUCCESS;
      return client.close(entry.clientFd).errno;
    },

    fd_read(fd, iovsPtr, iovsLen, nreadPtr) {
      const entry = entryOf(fd);
      if (entry === undefined) return WASI_ERRNO.BADF;
      if (entry.clientFd === undefined) return WASI_ERRNO.ISDIR;
      if (!entry.readable) return WASI_ERRNO.NOTCAPABLE;
      let total = 0;
      let errno: number = WASI_ERRNO.SUCCESS;
      for (const { ptr, len } of iovecs(iovsPtr, iovsLen)) {
        if (len === 0) continue;
        const chunk = client.read(entry.clientFd, len, entry.offset + BigInt(total));
        if (chunk.count > 0) bytes().set(chunk.bytes, ptr);
        total += chunk.count;
        if (chunk.errno !== 0) {
          errno = chunk.errno;
          break;
        }
        if (chunk.count < len) break; // end of file
      }
      entry.offset += BigInt(total);
      view().setUint32(nreadPtr, total, true);
      // A rejection part-way through still reports what transferred, exactly as a short read does.
      return total > 0 ? WASI_ERRNO.SUCCESS : errno;
    },

    fd_pread(fd, iovsPtr, iovsLen, offset, nreadPtr) {
      const entry = entryOf(fd);
      if (entry === undefined) return WASI_ERRNO.BADF;
      if (entry.clientFd === undefined) return WASI_ERRNO.ISDIR;
      if (!entry.readable) return WASI_ERRNO.NOTCAPABLE;
      let at = toBigInt(offset);
      let total = 0;
      let errno: number = WASI_ERRNO.SUCCESS;
      for (const { ptr, len } of iovecs(iovsPtr, iovsLen)) {
        if (len === 0) continue;
        const chunk = client.read(entry.clientFd, len, at);
        if (chunk.count > 0) bytes().set(chunk.bytes, ptr);
        at += BigInt(chunk.count);
        total += chunk.count;
        if (chunk.errno !== 0) {
          errno = chunk.errno;
          break;
        }
        if (chunk.count < len) break;
      }
      view().setUint32(nreadPtr, total, true);
      return total > 0 ? WASI_ERRNO.SUCCESS : errno;
    },

    fd_write(fd, iovsPtr, iovsLen, nwrittenPtr) {
      const entry = entryOf(fd);
      if (entry === undefined) return WASI_ERRNO.BADF;
      if (entry.clientFd === undefined) return WASI_ERRNO.ISDIR;
      if (!entry.writable) return WASI_ERRNO.NOTCAPABLE;
      // O_APPEND is emulated here: resolve end-of-file once, then write at explicit positions.
      if ((entry.fdflags & FDFLAGS_APPEND) !== 0) {
        const end = sizeOf(entry);
        if (end.errno !== 0) return end.errno;
        entry.offset = end.size;
      }
      let total = 0;
      let errno: number = WASI_ERRNO.SUCCESS;
      for (const { ptr, len } of iovecs(iovsPtr, iovsLen)) {
        if (len === 0) continue;
        const source = bytes().subarray(ptr, ptr + len);
        const written = client.write(entry.clientFd, source, entry.offset + BigInt(total));
        total += written.count;
        if (written.errno !== 0) {
          errno = written.errno;
          break;
        }
        if (written.count < len) break; // the store admitted less than asked
      }
      entry.offset += BigInt(total);
      view().setUint32(nwrittenPtr, total, true);
      return total > 0 ? WASI_ERRNO.SUCCESS : errno;
    },

    fd_pwrite(fd, iovsPtr, iovsLen, offset, nwrittenPtr) {
      const entry = entryOf(fd);
      if (entry === undefined) return WASI_ERRNO.BADF;
      if (entry.clientFd === undefined) return WASI_ERRNO.ISDIR;
      if (!entry.writable) return WASI_ERRNO.NOTCAPABLE;
      let at = toBigInt(offset);
      let total = 0;
      let errno: number = WASI_ERRNO.SUCCESS;
      for (const { ptr, len } of iovecs(iovsPtr, iovsLen)) {
        if (len === 0) continue;
        const written = client.write(entry.clientFd, bytes().subarray(ptr, ptr + len), at);
        at += BigInt(written.count);
        total += written.count;
        if (written.errno !== 0) {
          errno = written.errno;
          break;
        }
        if (written.count < len) break;
      }
      view().setUint32(nwrittenPtr, total, true);
      return total > 0 ? WASI_ERRNO.SUCCESS : errno;
    },

    fd_seek(fd, offset, whence, resultPtr) {
      const entry = entryOf(fd);
      if (entry === undefined) return WASI_ERRNO.BADF;
      if (entry.clientFd === undefined) return WASI_ERRNO.BADF; // a directory has no seekable offset
      const delta = toBigInt(offset);
      let target: bigint;
      if (whence === WHENCE_SET) target = delta;
      else if (whence === WHENCE_CUR) target = entry.offset + delta;
      else if (whence === WHENCE_END) {
        const end = sizeOf(entry);
        if (end.errno !== 0) return end.errno;
        target = end.size + delta;
      } else return WASI_ERRNO.INVAL;
      if (target < 0n) return WASI_ERRNO.INVAL;
      entry.offset = target;
      view().setBigUint64(resultPtr, target, true);
      return WASI_ERRNO.SUCCESS;
    },

    fd_tell(fd, resultPtr) {
      const entry = entryOf(fd);
      if (entry === undefined) return WASI_ERRNO.BADF;
      if (entry.clientFd === undefined) return WASI_ERRNO.BADF;
      view().setBigUint64(resultPtr, entry.offset, true);
      return WASI_ERRNO.SUCCESS;
    },

    fd_fdstat_get(fd, resultPtr) {
      const entry = entryOf(fd);
      if (entry === undefined) return WASI_ERRNO.BADF;
      const data = view();
      data.setUint8(resultPtr, entry.isDir ? WASI_FILETYPE.DIRECTORY : WASI_FILETYPE.REGULAR_FILE);
      data.setUint8(resultPtr + 1, 0);
      data.setUint16(resultPtr + 2, entry.fdflags, true);
      data.setUint32(resultPtr + 4, 0, true);
      data.setBigUint64(resultPtr + 8, entry.rightsBase, true);
      data.setBigUint64(resultPtr + 16, entry.rightsInheriting, true);
      return WASI_ERRNO.SUCCESS;
    },

    fd_fdstat_set_flags(fd, fdflags) {
      const entry = entryOf(fd);
      if (entry === undefined) return WASI_ERRNO.BADF;
      // APPEND is the adapter's own emulation, so it can be turned on and off freely; the rest of the
      // sync bits are accepted and ignored (the store's only durability primitive is `fsync`, which is
      // already store-wide and stronger than DSYNC/RSYNC/SYNC promise). NONBLOCK is meaningless here:
      // every broker call blocks by construction.
      entry.fdflags = fdflags & (FDFLAGS_APPEND | FDFLAGS_DSYNC | FDFLAGS_NONBLOCK | FDFLAGS_RSYNC | FDFLAGS_SYNC);
      return WASI_ERRNO.SUCCESS;
    },

    fd_fdstat_set_rights(fd, rightsBase, rightsInheriting) {
      const entry = entryOf(fd);
      if (entry === undefined) return WASI_ERRNO.BADF;
      // Rights may only ever be narrowed.
      const base = toBigInt(rightsBase);
      const inheriting = toBigInt(rightsInheriting);
      if ((base & ~entry.rightsBase) !== 0n || (inheriting & ~entry.rightsInheriting) !== 0n) {
        return WASI_ERRNO.NOTCAPABLE;
      }
      entry.rightsBase = base;
      entry.rightsInheriting = inheriting;
      return WASI_ERRNO.SUCCESS;
    },

    fd_filestat_get(fd, resultPtr) {
      const entry = entryOf(fd);
      if (entry === undefined) return WASI_ERRNO.BADF;
      const stat = entry.clientFd === undefined ? client.stat(entry.path) : client.fstat(entry.clientFd);
      if (stat.errno !== 0 || stat.stat === undefined) return stat.errno || WASI_ERRNO.IO;
      writeFilestat(resultPtr, entry.path, stat.stat);
      return WASI_ERRNO.SUCCESS;
    },

    fd_filestat_set_size(fd, size) {
      const entry = entryOf(fd);
      if (entry === undefined) return WASI_ERRNO.BADF;
      if (entry.clientFd === undefined) return WASI_ERRNO.ISDIR;
      if (!entry.writable) return WASI_ERRNO.NOTCAPABLE;
      // The store resizes by PATH only, which is why every fd remembers the path it was opened with.
      return client.truncate(entry.path, toBigInt(size)).errno;
    },

    fd_filestat_set_times(fd, _atim, _mtim, fstflags) {
      const entry = entryOf(fd);
      if (entry === undefined) return WASI_ERRNO.BADF;
      if ((fstflags & ~0b1111) !== 0) return WASI_ERRNO.INVAL;
      if (fstflags === 0) return WASI_ERRNO.SUCCESS;
      // The broker exposes no `utimes`. Answering ENOTSUP is the honest answer: a timestamp kept in
      // this adapter alone would make two threads on ONE store disagree about a file's mtime.
      return WASI_ERRNO.NOTSUP;
    },

    fd_readdir(fd, bufPtr, bufLen, cookie, bufusedPtr) {
      const entry = entryOf(fd);
      if (entry === undefined) return WASI_ERRNO.BADF;
      if (!entry.isDir) return WASI_ERRNO.NOTDIR;
      const start = Number(toBigInt(cookie));
      if (!Number.isSafeInteger(start) || start < 0) return WASI_ERRNO.INVAL;
      // Snapshot on cookie 0 so pagination is stable across guest mutations — and so a stale cookie
      // can never be forwarded to the broker, which treats a cursor past the listing as a protocol
      // violation and detaches the client.
      if (start === 0 || entry.listing === undefined) {
        const listed = client.readdir(entry.path);
        if (listed.errno !== 0) return listed.errno;
        entry.listing = { names: listed.entries, filetypes: new Map() };
      }
      const listing = entry.listing;
      const data = view();
      const memory = bytes();
      let used = 0;
      for (let index = start; index < listing.names.length; index += 1) {
        const name = listing.names[index]!;
        const nameBytes = textEncoder.encode(name);
        if (used + DIRENT_HEADER_BYTES >= bufLen) {
          // No room for another header: report the buffer full so the caller grows it and retries.
          used = bufLen;
          break;
        }
        let filetype = listing.filetypes.get(name);
        if (filetype === undefined) {
          const child = client.lstat(entry.path === "/" ? `/${name}` : `${entry.path}/${name}`);
          filetype =
            child.errno !== 0 || child.stat === undefined
              ? WASI_FILETYPE.UNKNOWN
              : child.stat.kind === "directory"
                ? WASI_FILETYPE.DIRECTORY
                : WASI_FILETYPE.REGULAR_FILE;
          listing.filetypes.set(name, filetype);
        }
        const at = bufPtr + used;
        data.setBigUint64(at, BigInt(index + 1), true); // d_next
        data.setBigUint64(at + 8, inodeOf(entry.path === "/" ? `/${name}` : `${entry.path}/${name}`), true); // d_ino
        data.setUint32(at + 16, nameBytes.byteLength, true); // d_namlen
        data.setUint8(at + 20, filetype);
        data.setUint8(at + 21, 0);
        data.setUint16(at + 22, 0, true);
        const room = bufLen - used - DIRENT_HEADER_BYTES;
        const copied = Math.min(nameBytes.byteLength, room);
        memory.set(nameBytes.subarray(0, copied), at + DIRENT_HEADER_BYTES);
        used += DIRENT_HEADER_BYTES + copied;
        if (copied < nameBytes.byteLength) break; // truncated name: the caller grows the buffer
      }
      data.setUint32(bufusedPtr, used, true);
      return WASI_ERRNO.SUCCESS;
    },

    fd_sync(fd) {
      const entry = entryOf(fd);
      if (entry === undefined) return WASI_ERRNO.BADF;
      // Store-wide by construction: on success every byte any client wrote before the call is durable.
      return entry.clientFd === undefined ? client.fsync().errno : client.fsync(entry.clientFd).errno;
    },

    fd_datasync(fd) {
      return fs.fd_sync(fd);
    },

    fd_allocate(fd, offset, length) {
      const entry = entryOf(fd);
      if (entry === undefined) return WASI_ERRNO.BADF;
      if (entry.clientFd === undefined) return WASI_ERRNO.ISDIR;
      if (!entry.writable) return WASI_ERRNO.NOTCAPABLE;
      const end = toBigInt(offset) + toBigInt(length);
      if (end < 0n) return WASI_ERRNO.INVAL;
      const current = sizeOf(entry);
      if (current.errno !== 0) return current.errno;
      // The store has no space RESERVATION primitive, so this extends by truncation instead. That
      // satisfies everything `posix_fallocate` observably promises — the file is at least that big,
      // existing bytes are untouched, the gap reads as zeros — but it does not pre-commit capacity, so
      // a later write into the range can still fail on a full store.
      if (end <= current.size) return WASI_ERRNO.SUCCESS;
      return client.truncate(entry.path, end).errno;
    },

    fd_advise(fd, _offset, _length, _advice) {
      return entryOf(fd) === undefined ? WASI_ERRNO.BADF : WASI_ERRNO.SUCCESS;
    },

    path_open(dirfd, _dirflags, pathPtr, pathLen, oflags, rightsBase, rightsInheriting, fdflags, resultPtr) {
      const path = resolve(dirfd, pathPtr, pathLen);
      if (path === undefined) return WASI_ERRNO.BADF;
      const base = toBigInt(rightsBase);
      const inheriting = toBigInt(rightsInheriting);
      const wantsRead = (base & RIGHTS_FD_READ) !== 0n;
      const wantsWrite = (base & RIGHTS_FD_WRITE) !== 0n;
      const create = (oflags & OFLAGS_CREAT) !== 0;
      const exclusive = (oflags & OFLAGS_EXCL) !== 0;
      const truncate = (oflags & OFLAGS_TRUNC) !== 0;
      const directory = (oflags & OFLAGS_DIRECTORY) !== 0;
      // A request that asks for neither right is a plain read-only open.
      const readable = wantsRead || !wantsWrite;
      const writable = wantsWrite;

      const openDirectory = (): number => {
        const stat = client.stat(path);
        if (stat.errno !== 0 || stat.stat === undefined) return stat.errno || WASI_ERRNO.IO;
        if (stat.stat.kind !== "directory") return WASI_ERRNO.NOTDIR;
        if (create && exclusive) return WASI_ERRNO.EXIST;
        const fd = allocate({
          path,
          isDir: true,
          clientFd: undefined,
          offset: 0n,
          fdflags: 0,
          rightsBase: base === 0n ? RIGHTS_ALL : base,
          rightsInheriting: inheriting === 0n ? RIGHTS_ALL : inheriting,
          readable: true,
          writable: false,
          listing: undefined,
        });
        view().setUint32(resultPtr, fd, true);
        return WASI_ERRNO.SUCCESS;
      };

      // With O_DIRECTORY the path must never be created as a file, so `open` is not attempted at all.
      if (directory) return openDirectory();

      // `planOpen` refuses O_CREAT/O_TRUNC without write access, but POSIX `open(O_RDONLY|O_CREAT)` is
      // perfectly legal — so the STORE descriptor is opened wide enough to satisfy the plan while the
      // adapter keeps the narrower access the rights asked for and rejects a later write itself.
      const posixWrite = writable || create || truncate;
      const posixRead = readable || !posixWrite;
      let flags = posixRead && posixWrite ? O_RDWR : posixWrite ? O_WRONLY : O_RDONLY;
      if (create) flags |= O_CREAT;
      if (exclusive) flags |= O_EXCL;
      if (truncate) flags |= O_TRUNC;
      // O_APPEND is never sent: it is emulated on this side so the adapter's offset stays exact and
      // `fd_fdstat_set_flags` can add or remove APPEND on an already-open descriptor.

      const opened = client.open(path, flags);
      if (opened.errno !== 0) {
        // The store cannot open a directory at all — it answers EISDIR — so that answer is how a
        // directory is recognised on the common path, at no cost to a file open.
        if (opened.errno === WASI_ERRNO.ISDIR) return create && exclusive ? WASI_ERRNO.EXIST : openDirectory();
        return opened.errno;
      }
      const fd = allocate({
        path,
        isDir: false,
        clientFd: opened.fd,
        offset: 0n,
        fdflags: fdflags & (FDFLAGS_APPEND | FDFLAGS_DSYNC | FDFLAGS_NONBLOCK | FDFLAGS_RSYNC | FDFLAGS_SYNC),
        rightsBase: base === 0n ? RIGHTS_ALL : base,
        rightsInheriting: inheriting === 0n ? RIGHTS_ALL : inheriting,
        readable,
        writable,
        listing: undefined,
      });
      view().setUint32(resultPtr, fd, true);
      return WASI_ERRNO.SUCCESS;
    },

    path_filestat_get(dirfd, flags, pathPtr, pathLen, resultPtr) {
      const path = resolve(dirfd, pathPtr, pathLen);
      if (path === undefined) return WASI_ERRNO.BADF;
      // The store has no symbolic links, so following or not following one is the same query; both
      // spellings exist so a guest that passes either gets the answer it expects.
      const follow = (flags & LOOKUPFLAGS_SYMLINK_FOLLOW) !== 0;
      const stat = follow ? client.stat(path) : client.lstat(path);
      if (stat.errno !== 0 || stat.stat === undefined) return stat.errno || WASI_ERRNO.IO;
      writeFilestat(resultPtr, path, stat.stat);
      return WASI_ERRNO.SUCCESS;
    },

    path_filestat_set_times(dirfd, _flags, pathPtr, pathLen, _atim, _mtim, fstflags) {
      const path = resolve(dirfd, pathPtr, pathLen);
      if (path === undefined) return WASI_ERRNO.BADF;
      if ((fstflags & ~0b1111) !== 0) return WASI_ERRNO.INVAL;
      const stat = client.lstat(path);
      if (stat.errno !== 0) return stat.errno;
      if (fstflags === 0) return WASI_ERRNO.SUCCESS;
      return WASI_ERRNO.NOTSUP; // see fd_filestat_set_times
    },

    path_create_directory(dirfd, pathPtr, pathLen) {
      const path = resolve(dirfd, pathPtr, pathLen);
      if (path === undefined) return WASI_ERRNO.BADF;
      return client.mkdir(path).errno;
    },

    path_remove_directory(dirfd, pathPtr, pathLen) {
      const path = resolve(dirfd, pathPtr, pathLen);
      if (path === undefined) return WASI_ERRNO.BADF;
      return client.rmdir(path).errno;
    },

    path_unlink_file(dirfd, pathPtr, pathLen) {
      const path = resolve(dirfd, pathPtr, pathLen);
      if (path === undefined) return WASI_ERRNO.BADF;
      return client.unlink(path).errno;
    },

    path_rename(dirfd, oldPtr, oldLen, newDirfd, newPtr, newLen) {
      const oldPath = resolve(dirfd, oldPtr, oldLen);
      const newPath = resolve(newDirfd, newPtr, newLen);
      if (oldPath === undefined || newPath === undefined) return WASI_ERRNO.BADF;
      const result = client.rename(oldPath, newPath);
      if (result.errno !== 0) return result.errno;
      // Every descriptor still open on the old path must follow it, or a later `fd_filestat_set_size`
      // would resize whatever now occupies the source name.
      const prefix = oldPath === "/" ? "/" : `${oldPath}/`;
      for (const entry of table.values()) {
        if (entry.path === oldPath) entry.path = newPath;
        else if (entry.path.startsWith(prefix)) entry.path = newPath + entry.path.slice(oldPath.length);
      }
      return WASI_ERRNO.SUCCESS;
    },

    path_readlink(dirfd, pathPtr, pathLen, _bufPtr, _bufLen, _bufusedPtr) {
      const path = resolve(dirfd, pathPtr, pathLen);
      if (path === undefined) return WASI_ERRNO.BADF;
      // The store holds no symbolic links, so every existing path is not one: EINVAL is what POSIX
      // `readlink` answers for a non-symlink, and ENOENT still has to win when nothing is there.
      const stat = client.lstat(path);
      return stat.errno !== 0 ? stat.errno : WASI_ERRNO.INVAL;
    },

    path_symlink(_oldPtr, _oldLen, dirfd, _newPtr, _newLen) {
      return entryOf(dirfd)?.isDir === true ? WASI_ERRNO.NOTSUP : WASI_ERRNO.BADF;
    },

    path_link(oldDirfd, _oldFlags, _oldPtr, _oldLen, newDirfd, _newPtr, _newLen) {
      if (entryOf(oldDirfd)?.isDir !== true || entryOf(newDirfd)?.isDir !== true) return WASI_ERRNO.BADF;
      return WASI_ERRNO.NOTSUP; // the store has no hard links
    },
  };

  // ---- failure containment -------------------------------------------------
  // A JS exception thrown out of a WASI import unwinds through the guest's nounwind frames and
  // surfaces as a bare `RuntimeError: unreachable` with nothing attached. Every call is therefore
  // wrapped: the guest sees EIO and the host sees the stack.
  const guarded: Record<string, unknown> = {};
  for (const name of Object.keys(fs) as (keyof WasiPreview1FsFunctions)[]) {
    const inner = fs[name] as (...args: unknown[]) => number;
    guarded[name] = (...args: unknown[]): number => {
      try {
        return inner(...args);
      } catch (cause) {
        onError(name, cause);
        return WASI_ERRNO.IO;
      }
    };
  }

  const adapter = guarded as unknown as WasiPreview1Fs;

  adapter.owns = owns;

  adapter.openFdCount = (): number => table.size - (table.has(preopenFd) ? 1 : 0);

  adapter.closeAll = (): number => {
    let released = 0;
    for (const entry of table.values()) {
      if (entry.clientFd === undefined) continue;
      client.close(entry.clientFd);
      released += 1;
    }
    table.clear();
    table.set(preopenFd, preopenEntry());
    nextFd = fdBase;
    return released;
  };

  adapter.compose = (base: Readonly<Record<string, unknown>>): Record<string, unknown> => {
    const merged: Record<string, unknown> = { ...base };
    for (const [name, index] of Object.entries(FD_ARGUMENT_INDEX)) {
      const mine = guarded[name] as (...args: unknown[]) => number;
      const theirs = base[name];
      if (typeof theirs !== "function") {
        // The base host does not implement this call at all (`fd_tell`, `fd_allocate` and friends are
        // commonly absent): the adapter answers for its own fds and reports EBADF for anything else,
        // which is exactly what an absent implementation would have to say.
        merged[name] = (...args: unknown[]): number => (owns(Number(args[index])) ? mine(...args) : WASI_ERRNO.BADF);
        continue;
      }
      const fallback = theirs as (...args: unknown[]) => number;
      merged[name] = (...args: unknown[]): number => (owns(Number(args[index])) ? mine(...args) : fallback(...args));
    }
    return merged;
  };

  return adapter;
}
