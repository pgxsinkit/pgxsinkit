/**
 * `RepackedSyncClient` — the backend side of the synchronous broker.
 *
 * Every method blocks the calling thread in `Atomics.wait` until the coordinator answers, which is the
 * whole point: a thread running wasm parks in futexes and can never observe a promise, so the file
 * layer under it has to be synchronous. Nothing here is async, and nothing here knows about wasm.
 *
 * ## What throws and what does not
 *
 * A FILE rejection is data: every method returns `{ errno }` (0 on success) with whatever else the
 * operation produced. Callers map the errno straight into their own ABI — the values are WASI preview1
 * errno numbers already.
 *
 * A TRANSPORT failure throws, because there is no answer to return: the server detached this client,
 * the client sent something the server refused, the server never replied inside the timeout, or the
 * store itself failed. Those are `RepackedBrokerTransportError` and `RepackedBrokerStoreError`.
 *
 * ## Mapping onto WASI preview1
 *
 * The method set is shaped so a preview1 adapter is a straight translation, with no state of its own
 * beyond the preopen table:
 *
 *     path_open              → open(path, flags, mode)          (flags are the POSIX bits, see protocol)
 *     fd_close               → close(fd)
 *     fd_read                → read(fd, length)                 (no position: the store's own cursor)
 *     fd_pread               → read(fd, length, position)
 *     fd_write               → write(fd, bytes)
 *     fd_pwrite              → write(fd, bytes, position)
 *     fd_seek                → resolved by the caller; the store's cursor moves on cursor reads/writes
 *     fd_sync / fd_datasync  → fsync(fd)                        (store-wide; see the server's note)
 *     fd_filestat_get        → fstat(fd)
 *     path_filestat_get      → stat(path) / lstat(path)
 *     fd_readdir             → readdir(path) or readdirPage(path, cursor) for the cookie form
 *     path_create_directory  → mkdir(path)
 *     path_remove_directory  → rmdir(path)
 *     path_unlink_file       → unlink(path)
 *     path_rename            → rename(oldPath, newPath)
 *     path_symlink           → symlink(target, path)      (targets are ABSOLUTE; see the core)
 *     path_readlink          → readlink(path)
 *     fd_filestat_set_size   → truncate(path, size) — the core resizes by PATH only, so the adapter
 *                              keeps the path it opened each fd with and resolves it here
 *
 * Reads and writes larger than the channel's payload region are split transparently; a caller never
 * has to know the channel size.
 */

import { FsError } from "../core/errors";
import {
  FAULT_NONE,
  FAULT_PROTOCOL,
  FAULT_STORE,
  HEADER_ERRNO,
  HEADER_FAULT,
  HEADER_OPCODE,
  HEADER_REQUEST,
  HEADER_RESPONSE,
  HEADER_RESULT_HI,
  HEADER_RESULT_LO,
  HEADER_SEQUENCE,
  HEADER_STATE,
  OPCODE_CLOSE,
  OPCODE_FSTAT,
  OPCODE_FSYNC,
  OPCODE_LSTAT,
  OPCODE_MKDIR,
  OPCODE_OPEN,
  OPCODE_READ,
  OPCODE_READDIR,
  OPCODE_READLINK,
  OPCODE_RENAME,
  OPCODE_RMDIR,
  OPCODE_SIZE,
  OPCODE_STAT,
  OPCODE_SYMLINK,
  OPCODE_TRUNCATE,
  OPCODE_UNLINK,
  OPCODE_WRITE,
  PayloadReader,
  PayloadWriter,
  READDIR_DONE,
  STATE_DETACHED,
  STATE_IDLE,
  STATE_REQUEST,
  STATE_RESPONSE,
  errnoName,
  fsErrorNameOf,
  joinResult,
  readStat,
} from "./protocol";
import type { BrokerStat, RepackedChannel } from "./protocol";

/** The transport failed: there is no answer, and this client can no longer make progress. */
export class RepackedBrokerTransportError extends Error {
  readonly brokerCode: "detached" | "protocol" | "timeout";

  constructor(brokerCode: "detached" | "protocol" | "timeout", message: string) {
    super(message);
    this.name = "RepackedBrokerTransportError";
    this.brokerCode = brokerCode;
  }
}

/** The store behind the broker failed. Not a file rejection, and not this client's mistake. */
export class RepackedBrokerStoreError extends Error {
  readonly brokerCode = "store";

  constructor(message: string) {
    super(`the repacked store behind the broker failed: ${message}`);
    this.name = "RepackedBrokerStoreError";
  }
}

/** Every result carries an errno; 0 means the operation succeeded. */
export interface BrokerResult {
  readonly errno: number;
}

export interface BrokerOpenResult extends BrokerResult {
  readonly fd: number;
}

export interface BrokerCountResult extends BrokerResult {
  /** Bytes actually transferred. Short of the request means end-of-file (read) or a store limit (write). */
  readonly count: number;
}

export interface BrokerReadResult extends BrokerCountResult {
  readonly bytes: Uint8Array;
}

export interface BrokerStatResult extends BrokerResult {
  readonly stat: BrokerStat | undefined;
}

export interface BrokerSizeResult extends BrokerResult {
  readonly size: bigint;
}

export interface BrokerReaddirResult extends BrokerResult {
  readonly entries: readonly string[];
}

export interface BrokerReadlinkResult extends BrokerResult {
  /** The link's target, or `undefined` when the call was rejected. */
  readonly target: string | undefined;
}

export interface BrokerReaddirPageResult extends BrokerReaddirResult {
  /** The cursor to resume from, or `undefined` when the listing is complete. */
  readonly nextCursor: number | undefined;
}

export interface RepackedSyncClientOptions {
  /**
   * How long one request may go unanswered before the client gives up and throws. A dead coordinator
   * would otherwise park this thread forever, which is worse than a loud failure. Pass `Infinity` for
   * a host that genuinely prefers to wait.
   */
  readonly requestTimeoutMs?: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** The fixed bytes a read/write request spends before its data: fd + hasPosition + position + length. */
const TRANSFER_OVERHEAD_BYTES = 4 + 1 + 8 + 4;

export class RepackedSyncClient {
  readonly channel: RepackedChannel;
  readonly #timeoutMs: number;
  readonly #reply: Uint8Array;
  #sequence = 0;

  constructor(channel: RepackedChannel, options: RepackedSyncClientOptions = {}) {
    this.channel = channel;
    this.#timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    // A scratch copy of the reply region: the payload is shared memory the server reuses on the very
    // next request, so nothing handed to a caller may point into it.
    this.#reply = new Uint8Array(channel.payloadBytes);
  }

  /** The largest single read or write that fits one request. Reads/writes above it are chunked. */
  get maxTransferBytes(): number {
    return this.channel.payloadBytes - TRANSFER_OVERHEAD_BYTES;
  }

  open(path: string, flags: number, mode = 0o100666): BrokerOpenResult {
    const reply = this.#call(OPCODE_OPEN, (writer) => {
      writer.string(path);
      writer.u32(flags);
      writer.u32(mode);
    });
    return { errno: reply.errno, fd: reply.errno === 0 ? Number(reply.result) : -1 };
  }

  close(fd: number): BrokerResult {
    return { errno: this.#call(OPCODE_CLOSE, (writer) => writer.u32(fd)).errno };
  }

  /**
   * Read up to `length` bytes. With no `position` the store's own descriptor cursor is used and
   * advances; with a `position` the cursor is untouched (`fd_pread`). A result shorter than `length`
   * means end-of-file, never a partial transport.
   */
  read(fd: number, length: number, position?: bigint): BrokerReadResult {
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new RangeError("a broker read length must be a non-negative safe integer");
    }
    const output = new Uint8Array(length);
    let filled = 0;
    let errno = 0;
    while (filled < length) {
      const want = Math.min(length - filled, this.maxTransferBytes);
      const at = position === undefined ? undefined : position + BigInt(filled);
      const reply = this.#call(OPCODE_READ, (writer) => {
        writer.u32(fd);
        writer.u8(at === undefined ? 0 : 1);
        writer.u64(at ?? 0n);
        writer.u32(want);
      });
      if (reply.errno !== 0) {
        errno = reply.errno;
        break;
      }
      output.set(reply.bytes, filled);
      filled += reply.bytes.byteLength;
      if (reply.bytes.byteLength < want) break; // end-of-file
    }
    // A rejection part-way through still reports what already transferred, as a short read does.
    return { errno, count: filled, bytes: output.subarray(0, filled) };
  }

  /**
   * Write `bytes`. With no `position` the store's own descriptor cursor is used and advances; with a
   * `position` the cursor is untouched (`fd_pwrite`). A descriptor opened with `O_APPEND` always
   * writes at end-of-file and ignores `position`, exactly as POSIX requires.
   */
  write(fd: number, bytes: Uint8Array, position?: bigint): BrokerCountResult {
    let written = 0;
    let errno = 0;
    while (written < bytes.byteLength) {
      const chunk = bytes.subarray(written, written + Math.min(bytes.byteLength - written, this.maxTransferBytes));
      const at = position === undefined ? undefined : position + BigInt(written);
      const reply = this.#call(OPCODE_WRITE, (writer) => {
        writer.u32(fd);
        writer.u8(at === undefined ? 0 : 1);
        writer.u64(at ?? 0n);
        writer.u32(chunk.byteLength);
        writer.bytes(chunk);
      });
      if (reply.errno !== 0) {
        errno = reply.errno;
        break;
      }
      const count = Number(reply.result);
      written += count;
      if (count < chunk.byteLength) break; // the store admitted less than asked; stop rather than spin
    }
    return { errno, count: written };
  }

  /**
   * Flush the store. Durability is STORE-WIDE, not per-descriptor: on success every byte written
   * through this broker by any client before the call returned is recoverable. `fd` is validated so
   * the call still rejects a descriptor this client does not own.
   */
  fsync(fd?: number): BrokerResult {
    return {
      errno: this.#call(OPCODE_FSYNC, (writer) => {
        writer.u8(fd === undefined ? 0 : 1);
        writer.u32(fd ?? 0);
      }).errno,
    };
  }

  fstat(fd: number): BrokerStatResult {
    return this.#statCall(OPCODE_FSTAT, (writer) => writer.u32(fd));
  }

  stat(path: string): BrokerStatResult {
    return this.#statCall(OPCODE_STAT, (writer) => writer.string(path));
  }

  /** Reports the LINK itself when the final component is one; `stat` follows it instead. */
  lstat(path: string): BrokerStatResult {
    return this.#statCall(OPCODE_LSTAT, (writer) => writer.string(path));
  }

  /**
   * Create a symbolic link at `path` pointing at `target`. Targets are ABSOLUTE — the store refuses
   * a relative one with `EINVAL` rather than reinterpreting it against the link's directory.
   */
  symlink(target: string, path: string): BrokerResult {
    return {
      errno: this.#call(OPCODE_SYMLINK, (writer) => {
        writer.string(target);
        writer.string(path);
      }).errno,
    };
  }

  /** The target of the symbolic link at `path`. `EINVAL` when the path is not a link. */
  readlink(path: string): BrokerReadlinkResult {
    const reply = this.#call(OPCODE_READLINK, (writer) => writer.string(path));
    if (reply.errno !== 0) return { errno: reply.errno, target: undefined };
    return { errno: 0, target: new PayloadReader(reply.bytes, reply.bytes.byteLength).string() };
  }

  /** The complete listing, paged transparently over as many requests as the channel needs. */
  readdir(path: string): BrokerReaddirResult {
    const entries: string[] = [];
    let cursor: number | undefined = 0;
    while (cursor !== undefined) {
      const page: BrokerReaddirPageResult = this.readdirPage(path, cursor);
      if (page.errno !== 0) return { errno: page.errno, entries: [] };
      entries.push(...page.entries);
      cursor = page.nextCursor;
    }
    return { errno: 0, entries };
  }

  /**
   * One page of a listing, for a caller that owns its own cookie (WASI `fd_readdir`). The cursor is an
   * index into the store's sorted listing, recomputed per call — a paged listing is therefore not an
   * atomic snapshot, which is exactly what POSIX `readdir` allows.
   */
  readdirPage(path: string, cursor = 0): BrokerReaddirPageResult {
    const reply = this.#call(OPCODE_READDIR, (writer) => {
      writer.string(path);
      writer.u32(cursor);
    });
    if (reply.errno !== 0) return { errno: reply.errno, entries: [], nextCursor: undefined };
    const reader = new PayloadReader(reply.bytes, reply.bytes.byteLength);
    const count = reader.u32();
    const next = reader.i32();
    const entries: string[] = [];
    for (let index = 0; index < count; index += 1) entries.push(reader.string());
    return { errno: 0, entries, nextCursor: next === READDIR_DONE ? undefined : next };
  }

  mkdir(path: string, options: { recursive?: boolean; mode?: number } = {}): BrokerResult {
    return {
      errno: this.#call(OPCODE_MKDIR, (writer) => {
        writer.string(path);
        writer.u8(options.recursive === true ? 1 : 0);
        writer.u32(options.mode ?? 0o40777);
      }).errno,
    };
  }

  rmdir(path: string): BrokerResult {
    return { errno: this.#call(OPCODE_RMDIR, (writer) => writer.string(path)).errno };
  }

  unlink(path: string): BrokerResult {
    return { errno: this.#call(OPCODE_UNLINK, (writer) => writer.string(path)).errno };
  }

  rename(oldPath: string, newPath: string): BrokerResult {
    return {
      errno: this.#call(OPCODE_RENAME, (writer) => {
        writer.string(oldPath);
        writer.string(newPath);
      }).errno,
    };
  }

  /**
   * Resize by PATH. The core store has no resize-by-descriptor, so a WASI `fd_filestat_set_size`
   * adapter keeps the path each fd was opened with and calls this. Nothing is lost by that: the store
   * has no hard links, and a descriptor whose path was unlinked meanwhile is an orphan the core keeps
   * readable but no longer resizes.
   */
  truncate(path: string, size: bigint): BrokerResult {
    return {
      errno: this.#call(OPCODE_TRUNCATE, (writer) => {
        writer.string(path);
        writer.u64(size);
      }).errno,
    };
  }

  /** The size of one file, without the rest of a stat. `EISDIR` for a directory. */
  size(path: string): BrokerSizeResult {
    const reply = this.#call(OPCODE_SIZE, (writer) => writer.string(path));
    return { errno: reply.errno, size: reply.errno === 0 ? reply.result : 0n };
  }

  #statCall(opcode: number, encode: (writer: PayloadWriter) => void): BrokerStatResult {
    const reply = this.#call(opcode, encode);
    if (reply.errno !== 0) return { errno: reply.errno, stat: undefined };
    return { errno: 0, stat: readStat(new PayloadReader(reply.bytes, reply.bytes.byteLength)) };
  }

  /**
   * Publish one request, ring the doorbell, and park until the server answers. The returned `bytes`
   * are a private copy: the shared payload is reused by the next request.
   */
  #call(
    opcode: number,
    encode: (writer: PayloadWriter) => void,
  ): { readonly errno: number; readonly result: bigint; readonly bytes: Uint8Array } {
    const header = this.channel.header;
    const state = Atomics.load(header, HEADER_STATE);
    if (state === STATE_DETACHED) {
      throw new RepackedBrokerTransportError("detached", "the repacked broker detached this client");
    }
    if (state === STATE_REQUEST) {
      throw new RepackedBrokerTransportError("protocol", "a repacked broker request is already in flight");
    }
    const writer = new PayloadWriter(this.channel.payload);
    encode(writer);
    this.#sequence = (this.#sequence + 1) | 0;
    Atomics.store(header, HEADER_SEQUENCE, this.#sequence);
    Atomics.store(header, HEADER_OPCODE, opcode);
    Atomics.store(header, HEADER_REQUEST, writer.length);
    Atomics.store(header, HEADER_RESPONSE, 0);
    Atomics.store(header, HEADER_ERRNO, 0);
    Atomics.store(header, HEADER_FAULT, FAULT_NONE);
    // Publishing the state is the release edge for every payload byte written above; the doorbell is
    // the only wakeup path, so nothing waits on this word from the server side.
    Atomics.store(header, HEADER_STATE, STATE_REQUEST);
    this.channel.doorbell.ring();

    while (Atomics.load(header, HEADER_STATE) === STATE_REQUEST) {
      const outcome = Atomics.wait(header, HEADER_STATE, STATE_REQUEST, this.#timeoutMs);
      if (outcome === "timed-out" && Atomics.load(header, HEADER_STATE) === STATE_REQUEST) {
        throw new RepackedBrokerTransportError(
          "timeout",
          `the repacked broker did not answer opcode ${opcode} within ${this.#timeoutMs} ms`,
        );
      }
    }

    const responseBytes = Atomics.load(header, HEADER_RESPONSE);
    const fault = Atomics.load(header, HEADER_FAULT);
    const errno = Atomics.load(header, HEADER_ERRNO);
    const result = joinResult(Atomics.load(header, HEADER_RESULT_LO), Atomics.load(header, HEADER_RESULT_HI));
    let bytes: Uint8Array = new Uint8Array();
    if (responseBytes > 0 && responseBytes <= this.channel.payloadBytes) {
      this.#reply.set(this.channel.payload.subarray(0, responseBytes));
      bytes = this.#reply.subarray(0, responseBytes);
    }
    if (Atomics.load(header, HEADER_STATE) === STATE_DETACHED) {
      throw new RepackedBrokerTransportError(
        fault === FAULT_PROTOCOL ? "protocol" : "detached",
        fault === FAULT_PROTOCOL
          ? `the repacked broker rejected opcode ${opcode} as a protocol violation and detached this client`
          : "the repacked broker detached this client",
      );
    }
    if (Atomics.load(header, HEADER_STATE) !== STATE_RESPONSE) {
      throw new RepackedBrokerTransportError("protocol", "the repacked broker left the channel in an unknown state");
    }
    Atomics.store(header, HEADER_STATE, STATE_IDLE);
    if (fault === FAULT_STORE) throw new RepackedBrokerStoreError(this.#faultMessage(bytes));
    if (fault !== FAULT_NONE) {
      throw new RepackedBrokerTransportError("protocol", `the repacked broker reported fault ${fault}`);
    }
    return { errno, result, bytes };
  }

  #faultMessage(bytes: Uint8Array): string {
    if (bytes.byteLength === 0) return "no detail was reported";
    try {
      return new PayloadReader(bytes, bytes.byteLength).string();
    } catch {
      return "the fault detail was malformed";
    }
  }
}

/**
 * Turn a broker result into the throw the core store would have produced, for a caller that prefers
 * exceptions to errnos. The rebuilt `FsError` carries the same numeric `code` the broker reported.
 */
export function throwOnErrno(result: BrokerResult, operation: string, path?: string): void {
  if (result.errno === 0) return;
  const name = fsErrorNameOf(result.errno);
  const detail = `${operation} failed with ${errnoName(result.errno)}`;
  if (name === undefined) throw new RepackedBrokerTransportError("protocol", `${detail} (unknown to the core)`);
  throw new FsError(name, detail, path === undefined ? { operation } : { operation, path });
}
