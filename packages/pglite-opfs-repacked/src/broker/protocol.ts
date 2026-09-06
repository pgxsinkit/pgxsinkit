/**
 * The synchronous broker wire protocol.
 *
 * ## Why a wire protocol at all
 *
 * A repacked store is a single-owner object: it holds four exclusive file handles and one in-memory
 * metadata generation, and it is not shareable across JavaScript agents. A multi-backend engine needs
 * several worker threads to reach ONE store, and a worker running wasm parks in futexes, so it cannot
 * await a promise to get a file answered. The store therefore lives alone in a coordinator worker and
 * every other thread asks for file operations over a `SharedArrayBuffer`, blocking in `Atomics.wait`
 * until the coordinator answers. Nothing here knows about PGlite, wasm, or OPFS.
 *
 * ## Topology
 *
 * One CHANNEL per client, plus one DOORBELL shared by every channel of one broker:
 *
 *     client A ─ channel A ─┐
 *     client B ─ channel B ─┼─→ doorbell ─→ RepackedSyncBroker (owns the RepackedVfs)
 *     client C ─ channel C ─┘
 *
 * A client publishes its request into its own channel and then bumps the doorbell, so one blocking
 * server loop can wait on a single word and still service any number of clients.
 *
 * ## Channel layout
 *
 * One `SharedArrayBuffer`, `CHANNEL_HEADER_BYTES` (64) of `Int32Array` header followed by a byte
 * payload region (`DEFAULT_PAYLOAD_BYTES`, 64 KiB, chosen at channel creation):
 *
 *     offset  size  as        name
 *     ------  ----  --------  ------------------------------------------------------------------
 *          0     4  int32     HEADER_STATE      the word both sides `Atomics.wait` / `notify` on
 *          4     4  int32     HEADER_OPCODE     `OPCODE_*`, written by the client
 *          8     4  int32     HEADER_REQUEST    request bytes valid in the payload region
 *         12     4  int32     HEADER_RESPONSE   response bytes valid in the payload region
 *         16     4  int32     HEADER_ERRNO      0, or the WASI preview1 errno of a file rejection
 *         20     4  int32     HEADER_RESULT_LO  low  32 bits of the unsigned 64-bit result
 *         24     4  int32     HEADER_RESULT_HI  high 32 bits of the unsigned 64-bit result
 *         28     4  int32     HEADER_SEQUENCE   the client's monotonic request number
 *         32     4  int32     HEADER_FAULT      `FAULT_*` — a transport/store failure, not a file one
 *         36     4  int32     HEADER_PAYLOAD    payload capacity in bytes (written once at creation)
 *         40    24  int32[6]  reserved, always zero
 *         64     …  bytes     payload region
 *
 * `HEADER_STATE` is the whole handshake:
 *
 *     STATE_IDLE (0) ──client publishes──→ STATE_REQUEST (1) ──server answers──→ STATE_RESPONSE (2)
 *          ↑                                     │                                     │
 *          └─────────────client consumes─────────┼─────────────────────────────────────┘
 *                                                └──server rejects the client──→ STATE_DETACHED (3)
 *
 * `STATE_DETACHED` is terminal: the server has closed the client's descriptors and dropped it, and
 * every later client call throws instead of blocking forever.
 *
 * ## Doorbell layout
 *
 * A small separate `SharedArrayBuffer`, `DOORBELL_BYTES` (16) of `Int32Array`:
 *
 *     index  name              meaning
 *     -----  ----------------  ----------------------------------------------------------------
 *         0  DOORBELL_TICKET   incremented by any client that publishes a request; the word the
 *                              server's blocking loop waits on
 *         1  DOORBELL_RUNNING  1 while the server should keep looping, 0 to ask it to return
 *         2  reserved
 *         3  reserved
 *
 * The server reads `DOORBELL_TICKET` BEFORE it scans the channels and waits on that observed value,
 * so a request published during the scan makes the wait return `not-equal` immediately rather than
 * being missed.
 *
 * ## Ordering
 *
 * Nothing in the payload region is atomic, and nothing needs to be. Each side writes its payload with
 * ordinary stores and then publishes with `Atomics.store` on `HEADER_STATE`; the other side observes
 * with `Atomics.load` on the same word before touching the payload. That store/load pair is the
 * release/acquire edge, so every payload byte written before the publish is visible after the observe.
 *
 * ## Encoding
 *
 * Payloads are little-endian. Paths are `u32` byte length followed by UTF-8 bytes; sizes, offsets and
 * timestamps are unsigned 64-bit (`bigint`) because a virtual file may exceed 2^53 in principle and
 * the core store speaks `bigint` throughout. Byte counts that cannot exceed the payload region stay
 * `u32`. The single numeric answer of an operation travels in the header's 64-bit result pair, not in
 * the payload, so a read reply is nothing but its bytes.
 */

import { FS_ERRNO, FsError } from "../core/errors";
import type { FsErrorName } from "../core/errors";

/** Int32 slot indices of the channel header. */
export const HEADER_STATE = 0;
export const HEADER_OPCODE = 1;
export const HEADER_REQUEST = 2;
export const HEADER_RESPONSE = 3;
export const HEADER_ERRNO = 4;
export const HEADER_RESULT_LO = 5;
export const HEADER_RESULT_HI = 6;
export const HEADER_SEQUENCE = 7;
export const HEADER_FAULT = 8;
export const HEADER_PAYLOAD = 9;
export const CHANNEL_HEADER_SLOTS = 16;
export const CHANNEL_HEADER_BYTES = CHANNEL_HEADER_SLOTS * 4;

/** `HEADER_STATE` values. */
export const STATE_IDLE = 0;
export const STATE_REQUEST = 1;
export const STATE_RESPONSE = 2;
export const STATE_DETACHED = 3;

/** Int32 slot indices of the doorbell. */
export const DOORBELL_TICKET = 0;
export const DOORBELL_RUNNING = 1;
export const DOORBELL_SLOTS = 4;
export const DOORBELL_BYTES = DOORBELL_SLOTS * 4;

/** The default payload region: large enough that a Postgres 8 KiB page round-trips in one request. */
export const DEFAULT_PAYLOAD_BYTES = 64 * 1024;
/** A payload region below this cannot hold the fixed part of every request. */
export const MIN_PAYLOAD_BYTES = 1024;

/**
 * `HEADER_FAULT` values. A fault is NOT a file rejection: `HEADER_ERRNO` carries those and leaves the
 * client working. A fault means the transport or the store itself failed.
 */
export const FAULT_NONE = 0;
/** The client violated the protocol (unknown opcode, impossible length, truncated payload). */
export const FAULT_PROTOCOL = 1;
/** The store threw something that is not an `FsError` — it is very likely poisoned. */
export const FAULT_STORE = 2;
/** The server rejected or dropped the client for a reason of its own (explicit `detach`). */
export const FAULT_DETACHED = 3;

/** Every operation the broker speaks. */
export const OPCODE_OPEN = 1;
export const OPCODE_CLOSE = 2;
export const OPCODE_READ = 3;
export const OPCODE_WRITE = 4;
export const OPCODE_FSYNC = 5;
export const OPCODE_FSTAT = 6;
export const OPCODE_STAT = 7;
export const OPCODE_LSTAT = 8;
export const OPCODE_READDIR = 9;
export const OPCODE_MKDIR = 10;
export const OPCODE_RMDIR = 11;
export const OPCODE_UNLINK = 12;
export const OPCODE_RENAME = 13;
export const OPCODE_TRUNCATE = 14;
export const OPCODE_SIZE = 15;
const MIN_OPCODE = OPCODE_OPEN;
const MAX_OPCODE = OPCODE_SIZE;

export function isKnownOpcode(opcode: number): boolean {
  return Number.isInteger(opcode) && opcode >= MIN_OPCODE && opcode <= MAX_OPCODE;
}

/**
 * POSIX/WASI-shaped open bits. The wire carries these, never the core's node-style flag string: a WASI
 * `path_open` maps its `oflags`/`fdflags`/`fs_rights_base` onto them directly, and the server is the
 * only place that has to know the core's string vocabulary.
 */
export const O_RDONLY = 0;
export const O_WRONLY = 1;
export const O_RDWR = 2;
export const O_ACCMODE = 3;
export const O_CREAT = 0o100;
export const O_EXCL = 0o200;
export const O_TRUNC = 0o1000;
export const O_APPEND = 0o2000;
const O_KNOWN = O_ACCMODE | O_CREAT | O_EXCL | O_TRUNC | O_APPEND;

/** The stat shape on the wire: `kind` + mode + size + the three timestamps. */
export const STAT_KIND_FILE = 0;
export const STAT_KIND_DIRECTORY = 1;
export const STAT_BYTES = 1 + 4 + 8 * 4;

/** A `readdir` reply that ran out of payload room reports the cursor to resume from; -1 means done. */
export const READDIR_DONE = -1;

/**
 * How the server should satisfy one open request with the core's fixed flag-string vocabulary
 * (`r`, `r+`, `w`, `w+`, `wx`, `wx+`, `a`, `a+`, `ax`, `ax+`).
 *
 * `readable`/`writable` are the access the CLIENT asked for, which is not always what `coreFlags`
 * grants: the core has no "create without truncating and without appending" and no write-only
 * non-truncating mode, so those requests open a wider core descriptor and the broker enforces the
 * requested access itself on every later read/write.
 */
export interface OpenPlan {
  /** The core flag string to try first. */
  readonly coreFlags: string;
  /** Used only when `coreFlags` fails with ENOENT — the create-without-truncate two-step. */
  readonly fallbackFlags: string | undefined;
  /** `O_TRUNC` without `O_CREAT`: truncate the existing path to zero before opening. */
  readonly truncateFirst: boolean;
  /** No `O_CREAT`, but `coreFlags` would create: the server must prove the path exists first. */
  readonly requireExisting: boolean;
  /** The access the client asked for, enforced by the broker on top of the core descriptor. */
  readonly readable: boolean;
  readonly writable: boolean;
}

/**
 * Translate POSIX open bits into the core's vocabulary, or reject the combination with `EINVAL`.
 *
 * Rejected because they are meaningless rather than merely unsupported: an unknown bit, `O_EXCL`
 * without `O_CREAT`, `O_TRUNC` with `O_APPEND`, and a read-only request that also creates,
 * truncates, or appends.
 */
export function planOpen(flags: number): OpenPlan {
  if (!Number.isInteger(flags) || flags < 0 || (flags & ~O_KNOWN) !== 0) {
    throw new FsError("EINVAL", `unsupported open flags: ${flags}`);
  }
  const access = flags & O_ACCMODE;
  if (access === O_ACCMODE) throw new FsError("EINVAL", "open access mode is invalid");
  const readable = access === O_RDONLY || access === O_RDWR;
  const writable = access === O_WRONLY || access === O_RDWR;
  const create = (flags & O_CREAT) !== 0;
  const exclusive = (flags & O_EXCL) !== 0;
  const truncate = (flags & O_TRUNC) !== 0;
  const append = (flags & O_APPEND) !== 0;

  if (exclusive && !create) throw new FsError("EINVAL", "O_EXCL requires O_CREAT");
  if (truncate && append) throw new FsError("EINVAL", "O_TRUNC and O_APPEND are contradictory");
  if (!writable && (create || truncate || append)) {
    throw new FsError("EINVAL", "O_CREAT, O_TRUNC and O_APPEND require write access");
  }

  const plan = (coreFlags: string, extra: Partial<OpenPlan> = {}): OpenPlan => ({
    coreFlags,
    fallbackFlags: undefined,
    truncateFirst: false,
    requireExisting: false,
    readable,
    writable,
    ...extra,
  });

  // Exclusive creation can never truncate anything (the file must not exist), so `wx`/`ax` serve
  // both the with- and without-O_TRUNC spellings.
  if (exclusive) return plan(append ? (readable ? "ax+" : "ax") : readable ? "wx+" : "wx");
  if (append && create) return plan(readable ? "a+" : "a");
  if (truncate && create) return plan(readable ? "w+" : "w");
  // No O_CREAT past this point: every core append flag creates, so the server proves existence first.
  if (append) return plan(readable ? "a+" : "a", { requireExisting: true });
  if (truncate) return plan("r+", { truncateFirst: true });
  // Create-without-truncate: reuse the file if it is there, otherwise create it empty. `r+` is wider
  // than a write-only request asked for, which is why `writable`/`readable` are carried separately.
  if (create) return plan("r+", { fallbackFlags: "w+" });
  return plan(readable && !writable ? "r" : "r+");
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

/** Thrown when a payload cannot hold what a caller is trying to put in it. */
export class PayloadOverflowError extends Error {
  constructor(needed: number, capacity: number) {
    super(`broker payload needs ${needed} bytes but the channel region holds ${capacity}`);
    this.name = "PayloadOverflowError";
  }
}

/** Thrown when a payload does not decode — always a protocol violation by the peer that wrote it. */
export class PayloadDecodeError extends Error {
  constructor(message: string) {
    super(`broker payload is malformed: ${message}`);
    this.name = "PayloadDecodeError";
  }
}

/** Sequential little-endian writer over a channel's payload region. */
export class PayloadWriter {
  readonly #view: DataView;
  readonly #bytes: Uint8Array;
  #cursor = 0;

  constructor(payload: Uint8Array) {
    this.#bytes = payload;
    this.#view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  }

  get length(): number {
    return this.#cursor;
  }

  get remaining(): number {
    return this.#bytes.byteLength - this.#cursor;
  }

  u8(value: number): void {
    this.#view.setUint8(this.#reserve(1), value);
  }

  u32(value: number): void {
    this.#view.setUint32(this.#reserve(4), value, true);
  }

  i32(value: number): void {
    this.#view.setInt32(this.#reserve(4), value, true);
  }

  u64(value: bigint): void {
    this.#view.setBigUint64(this.#reserve(8), value, true);
  }

  bytes(source: Uint8Array): void {
    this.#bytes.set(source, this.#reserve(source.byteLength));
  }

  string(value: string): void {
    const encoded = textEncoder.encode(value);
    this.u32(encoded.byteLength);
    this.bytes(encoded);
  }

  /**
   * Discard everything written after `to`, backing out a field that did not fit. A `string` reserves
   * its length prefix before its bytes, so a name that overflows can leave four bytes behind.
   */
  rewind(to: number): void {
    if (!Number.isSafeInteger(to) || to < 0 || to > this.#cursor) {
      throw new RangeError("the payload rewind target is outside what has been written");
    }
    this.#cursor = to;
  }

  /**
   * A mutable view over `count` bytes already written at `at` — for a counter that has to be reserved
   * before its value is known (a `readdir` page fills until the payload runs out).
   */
  patch(at: number, count: number): DataView {
    if (!Number.isSafeInteger(at) || !Number.isSafeInteger(count) || at < 0 || count < 0 || at + count > this.#cursor) {
      throw new RangeError("the payload patch range is outside what has been written");
    }
    return new DataView(this.#bytes.buffer, this.#bytes.byteOffset + at, count);
  }

  #reserve(count: number): number {
    if (count > this.remaining) throw new PayloadOverflowError(this.#cursor + count, this.#bytes.byteLength);
    const at = this.#cursor;
    this.#cursor += count;
    return at;
  }
}

/** Sequential little-endian reader over a channel's payload region. */
export class PayloadReader {
  readonly #view: DataView;
  readonly #bytes: Uint8Array;
  #cursor = 0;

  constructor(payload: Uint8Array, length: number) {
    if (!Number.isSafeInteger(length) || length < 0 || length > payload.byteLength) {
      throw new PayloadDecodeError(`declared length ${length} is outside the payload region`);
    }
    this.#bytes = payload.subarray(0, length);
    this.#view = new DataView(payload.buffer, payload.byteOffset, length);
  }

  get remaining(): number {
    return this.#bytes.byteLength - this.#cursor;
  }

  u8(): number {
    return this.#view.getUint8(this.#take(1));
  }

  u32(): number {
    return this.#view.getUint32(this.#take(4), true);
  }

  i32(): number {
    return this.#view.getInt32(this.#take(4), true);
  }

  u64(): bigint {
    return this.#view.getBigUint64(this.#take(8), true);
  }

  bytes(count: number): Uint8Array {
    return this.#bytes.subarray(this.#take(count), this.#cursor);
  }

  string(): string {
    const length = this.u32();
    // `.slice()`, not the `.subarray()` `bytes()` hands out: a payload region lives in a
    // `SharedArrayBuffer`, and Chrome REFUSES a shared-backed view to `TextDecoder.decode()`
    // ("The provided ArrayBufferView value must not be shared" — the same `[AllowShared]` rule
    // that bites `crypto.getRandomValues`). Node accepts it, so a browser is the only place this
    // shows up, and it shows up as the SERVER rejecting every path-carrying request as malformed
    // and detaching the client. Paths are short; the copy costs nothing.
    const raw = this.bytes(length);
    try {
      return textDecoder.decode(raw.slice());
    } catch (cause) {
      throw new PayloadDecodeError(`a string is not valid UTF-8: ${String(cause)}`);
    }
  }

  #take(count: number): number {
    if (!Number.isSafeInteger(count) || count < 0) throw new PayloadDecodeError(`length ${count} is invalid`);
    if (count > this.remaining) throw new PayloadDecodeError("the payload ended mid-field");
    const at = this.#cursor;
    this.#cursor += count;
    return at;
  }
}

/** Split an unsigned 64-bit result into the header's low/high `int32` pair. */
export function splitResult(value: bigint): { readonly lo: number; readonly hi: number } {
  if (value < 0n || value > 0xffff_ffff_ffff_ffffn) {
    throw new RangeError(`broker result ${value} is outside the unsigned 64-bit range`);
  }
  return { lo: Number(value & 0xffff_ffffn) | 0, hi: Number(value >> 32n) | 0 };
}

/** Rejoin the header's low/high `int32` pair into an unsigned 64-bit result. */
export function joinResult(lo: number, hi: number): bigint {
  return (BigInt(hi >>> 0) << 32n) | BigInt(lo >>> 0);
}

/** The stat shape both sides exchange; `bigint` everywhere the core is `bigint`. */
export interface BrokerStat {
  readonly kind: "directory" | "file";
  readonly mode: number;
  readonly size: bigint;
  readonly atimeMs: bigint;
  readonly mtimeMs: bigint;
  readonly ctimeMs: bigint;
}

export function writeStat(writer: PayloadWriter, stat: BrokerStat): void {
  writer.u8(stat.kind === "directory" ? STAT_KIND_DIRECTORY : STAT_KIND_FILE);
  writer.u32(stat.mode);
  writer.u64(stat.size);
  writer.u64(stat.atimeMs);
  writer.u64(stat.mtimeMs);
  writer.u64(stat.ctimeMs);
}

export function readStat(reader: PayloadReader): BrokerStat {
  const kind = reader.u8() === STAT_KIND_DIRECTORY ? "directory" : "file";
  return {
    kind,
    mode: reader.u32(),
    size: reader.u64(),
    atimeMs: reader.u64(),
    mtimeMs: reader.u64(),
    ctimeMs: reader.u64(),
  };
}

/** A channel's two shared buffers, in the form that survives `postMessage`. */
export interface RepackedChannelTransfer {
  readonly id: number;
  readonly channel: SharedArrayBuffer;
  readonly doorbell: SharedArrayBuffer;
}

/**
 * The shared word one blocking server loop waits on. Both sides hold the same buffer; a client only
 * ever rings it, and only the host that created it may ask the loop to stop.
 */
export class RepackedDoorbell {
  readonly buffer: SharedArrayBuffer;
  readonly #slots: Int32Array;

  private constructor(buffer: SharedArrayBuffer) {
    if (buffer.byteLength < DOORBELL_BYTES) {
      throw new RangeError(`a broker doorbell needs at least ${DOORBELL_BYTES} bytes`);
    }
    this.buffer = buffer;
    this.#slots = new Int32Array(buffer, 0, DOORBELL_SLOTS);
  }

  static create(): RepackedDoorbell {
    const doorbell = new RepackedDoorbell(new SharedArrayBuffer(DOORBELL_BYTES));
    Atomics.store(doorbell.#slots, DOORBELL_RUNNING, 1);
    return doorbell;
  }

  /** Rebuild the doorbell around a buffer that arrived over `postMessage`. */
  static attach(buffer: SharedArrayBuffer): RepackedDoorbell {
    return new RepackedDoorbell(buffer);
  }

  /** The value a server must observe BEFORE it scans, so a concurrent request cannot be missed. */
  ticket(): number {
    return Atomics.load(this.#slots, DOORBELL_TICKET);
  }

  /** Announce that some channel now holds a request. */
  ring(): void {
    Atomics.add(this.#slots, DOORBELL_TICKET, 1);
    Atomics.notify(this.#slots, DOORBELL_TICKET);
  }

  running(): boolean {
    return Atomics.load(this.#slots, DOORBELL_RUNNING) === 1;
  }

  /**
   * Ask a blocking `serveForever()` to return. This is the only way to stop it from another thread:
   * once inside the loop the server never reaches its own event loop, so `postMessage` cannot reach it.
   */
  requestStop(): void {
    Atomics.store(this.#slots, DOORBELL_RUNNING, 0);
    this.ring();
  }

  /** Undo a `requestStop()` so the same doorbell can drive another loop. */
  resume(): void {
    Atomics.store(this.#slots, DOORBELL_RUNNING, 1);
  }

  /** Block until the ticket leaves `observed`, or the timeout elapses. */
  wait(observed: number, timeoutMs: number): "ok" | "not-equal" | "timed-out" {
    return Atomics.wait(this.#slots, DOORBELL_TICKET, observed, timeoutMs);
  }

  /** The non-blocking form, for a host that must not park its thread. */
  waitAsync(observed: number, timeoutMs: number): Promise<"ok" | "not-equal" | "timed-out"> {
    const result = Atomics.waitAsync(this.#slots, DOORBELL_TICKET, observed, timeoutMs);
    return result.async ? result.value : Promise.resolve(result.value);
  }
}

/**
 * One client's request/response channel. Both the client and the server hold an instance over the
 * same `SharedArrayBuffer`; neither owns the memory, and nothing but the header words is atomic.
 */
export class RepackedChannel {
  readonly id: number;
  readonly buffer: SharedArrayBuffer;
  readonly doorbell: RepackedDoorbell;
  readonly header: Int32Array;
  readonly payload: Uint8Array;

  private constructor(id: number, buffer: SharedArrayBuffer, doorbell: RepackedDoorbell) {
    this.id = id;
    this.buffer = buffer;
    this.doorbell = doorbell;
    this.header = new Int32Array(buffer, 0, CHANNEL_HEADER_SLOTS);
    this.payload = new Uint8Array(buffer, CHANNEL_HEADER_BYTES);
  }

  static create(options: { id: number; doorbell: RepackedDoorbell; payloadBytes?: number }): RepackedChannel {
    const payloadBytes = options.payloadBytes ?? DEFAULT_PAYLOAD_BYTES;
    if (!Number.isSafeInteger(payloadBytes) || payloadBytes < MIN_PAYLOAD_BYTES) {
      throw new RangeError(`a broker channel payload must be at least ${MIN_PAYLOAD_BYTES} bytes`);
    }
    if (!Number.isSafeInteger(options.id) || options.id < 0) {
      throw new RangeError("a broker channel id must be a non-negative safe integer");
    }
    const channel = new RepackedChannel(
      options.id,
      new SharedArrayBuffer(CHANNEL_HEADER_BYTES + payloadBytes),
      options.doorbell,
    );
    Atomics.store(channel.header, HEADER_PAYLOAD, payloadBytes);
    Atomics.store(channel.header, HEADER_STATE, STATE_IDLE);
    return channel;
  }

  /** Rebuild a channel around buffers that arrived over `postMessage`. */
  static attach(transfer: RepackedChannelTransfer): RepackedChannel {
    const doorbell = RepackedDoorbell.attach(transfer.doorbell);
    if (transfer.channel.byteLength < CHANNEL_HEADER_BYTES + MIN_PAYLOAD_BYTES) {
      throw new RangeError("the broker channel buffer is too small to be a channel");
    }
    const channel = new RepackedChannel(transfer.id, transfer.channel, doorbell);
    const declared = Atomics.load(channel.header, HEADER_PAYLOAD);
    if (declared !== channel.payload.byteLength) {
      throw new RangeError(`the broker channel declares ${declared} payload bytes but carries a different region`);
    }
    return channel;
  }

  /** The shape to hand to `postMessage`. */
  transfer(): RepackedChannelTransfer {
    return { id: this.id, channel: this.buffer, doorbell: this.doorbell.buffer };
  }

  get payloadBytes(): number {
    return this.payload.byteLength;
  }

  state(): number {
    return Atomics.load(this.header, HEADER_STATE);
  }
}

/** The errno of a rejection, or `undefined` when it is not a plain file rejection. */
export function errnoOf(cause: unknown): number | undefined {
  return cause instanceof FsError ? cause.code : undefined;
}

/** The core error name behind a wire errno, or `undefined` for a code the core never produces. */
export function fsErrorNameOf(code: number): FsErrorName | undefined {
  for (const name of Object.keys(FS_ERRNO) as FsErrorName[]) {
    if (FS_ERRNO[name] === code) return name;
  }
  return undefined;
}

/** Readable form of a wire errno, for a message. */
export function errnoName(code: number): string {
  return fsErrorNameOf(code) ?? `errno ${code}`;
}
