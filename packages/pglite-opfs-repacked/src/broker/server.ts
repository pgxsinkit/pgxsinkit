/**
 * `RepackedSyncBroker` — the single owner of one `RepackedVfs`, answering synchronous file requests
 * that arrive over `SharedArrayBuffer` channels.
 *
 * The broker is meant to be the only thing on its thread. A backend running wasm parks in futexes and
 * cannot await anything, so it publishes a request and blocks; the broker must therefore never block on
 * a promise between reading a request and writing its answer. Every handler here is synchronous, and
 * the store's own API is synchronous end to end.
 *
 * Three loop shapes are offered:
 *
 * - `serveForever()` parks the thread in `Atomics.wait` between requests. It is the shape for a
 *   dedicated coordinator worker, and while it runs the thread never reaches its event loop — so
 *   `postMessage` cannot reach it and every channel must be attached BEFORE entering it. Ask it to
 *   return with `doorbell.requestStop()` from any thread holding the doorbell.
 * - `serve()` is the same loop built on `Atomics.waitAsync`, for a host that must keep its event loop
 *   alive. Channels may be attached and detached at any time.
 * - `serveOnce()` scans every attached channel once and returns without waiting, for a host that
 *   drives its own loop.
 *
 * Failure separation is the point of the class. A file rejection (`FsError`) becomes an errno in the
 * reply header and nothing else happens. A store failure becomes `FAULT_STORE` in the reply, and the
 * loop keeps running because every later request will fail the same way and the client decides what to
 * do. A protocol violation detaches only the offending client, with a logged reason.
 */

import { FS_ERRNO, FsError } from "../core/errors";
import type { RepackedStat, RepackedVfs } from "../core/repacked-vfs";
import {
  FAULT_DETACHED,
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
  HEADER_STATE,
  OPCODE_CLOSE,
  OPCODE_FSTAT,
  OPCODE_FSYNC,
  OPCODE_LSTAT,
  OPCODE_MKDIR,
  OPCODE_OPEN,
  OPCODE_READ,
  OPCODE_READDIR,
  OPCODE_RENAME,
  OPCODE_RMDIR,
  OPCODE_SIZE,
  OPCODE_STAT,
  OPCODE_TRUNCATE,
  OPCODE_UNLINK,
  OPCODE_WRITE,
  PayloadDecodeError,
  PayloadOverflowError,
  PayloadReader,
  PayloadWriter,
  READDIR_DONE,
  STATE_DETACHED,
  STATE_REQUEST,
  STATE_RESPONSE,
  isKnownOpcode,
  planOpen,
  splitResult,
  writeStat,
} from "./protocol";
import type { RepackedChannel, RepackedDoorbell } from "./protocol";

/** A descriptor the broker opened on behalf of one client. */
interface BrokerFd {
  /** The core's descriptor number. */
  readonly fd: number;
  /** The access the CLIENT asked for, which may be narrower than what the core descriptor grants. */
  readonly readable: boolean;
  readonly writable: boolean;
}

interface AttachedClient {
  readonly channel: RepackedChannel;
  readonly fds: Map<number, BrokerFd>;
}

/** What a handler produced: an errno-only rejection, or a result plus optional response bytes. */
interface Answer {
  readonly errno: number;
  readonly result: bigint;
  readonly responseBytes: number;
}

const OK: Answer = { errno: 0, result: 0n, responseBytes: 0 };

function ok(result: bigint | number = 0n, responseBytes = 0): Answer {
  return { errno: 0, result: typeof result === "bigint" ? result : BigInt(result), responseBytes };
}

/** A client's request could not be understood; the client is detached, the loop survives. */
class ProtocolViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolViolation";
  }
}

export interface RepackedSyncBrokerOptions {
  /** The store this broker owns. Nothing else may hold it. */
  readonly vfs: RepackedVfs;
  /** The shared doorbell every attached channel rings. */
  readonly doorbell: RepackedDoorbell;
  /** The timestamp the broker supplies to every core call. Defaults to the wall clock. */
  readonly now?: () => bigint;
  /** Where a detach reason goes. Defaults to `console.warn`. */
  readonly log?: (message: string) => void;
  /**
   * How long one blocking iteration parks before re-scanning anyway. Defaults to 250 ms. The protocol
   * has no missed-wakeup window — the server observes the doorbell ticket BEFORE it scans, so a
   * request published during the scan makes the wait return `not-equal` at once — so this is purely a
   * heartbeat: it costs four idle wakeups a second and turns any future slip into a latency blip
   * instead of a permanently parked backend. `Infinity` makes the loop a pure park.
   */
  readonly pollIntervalMs?: number;
}

export class RepackedSyncBroker {
  readonly doorbell: RepackedDoorbell;
  readonly #vfs: RepackedVfs;
  readonly #now: () => bigint;
  readonly #log: (message: string) => void;
  readonly #pollIntervalMs: number;
  readonly #clients = new Map<number, AttachedClient>();
  #serving = false;

  constructor(options: RepackedSyncBrokerOptions) {
    this.#vfs = options.vfs;
    this.doorbell = options.doorbell;
    this.#now = options.now ?? (() => BigInt(Date.now()));
    this.#log = options.log ?? ((message) => console.warn(message));
    this.#pollIntervalMs = options.pollIntervalMs ?? 250;
  }

  /** Channel ids the broker currently serves. */
  attachedIds(): number[] {
    return [...this.#clients.keys()].sort((left, right) => left - right);
  }

  /** Descriptors the broker currently holds for one client — the leak check after a detach. */
  openFdCount(channelId?: number): number {
    if (channelId === undefined) {
      let total = 0;
      for (const client of this.#clients.values()) total += client.fds.size;
      return total;
    }
    return this.#clients.get(channelId)?.fds.size ?? 0;
  }

  attach(channel: RepackedChannel): void {
    if (this.#clients.has(channel.id)) throw new Error(`broker channel ${channel.id} is already attached`);
    if (channel.doorbell.buffer !== this.doorbell.buffer) {
      throw new Error(`broker channel ${channel.id} rings a different doorbell`);
    }
    this.#clients.set(channel.id, { channel, fds: new Map() });
  }

  /**
   * Drop a client and close every descriptor it still holds. A backend that dies mid-query never leaks
   * a descriptor into the store, and the store's exclusive handles are released the moment the LAST
   * owner goes away rather than whenever a stale fd happens to be noticed.
   */
  detach(channel: RepackedChannel | number, reason = "detached by the host"): void {
    this.#detach(typeof channel === "number" ? channel : channel.id, reason, FAULT_DETACHED);
  }

  #detach(id: number, reason: string, fault: number): void {
    const client = this.#clients.get(id);
    if (client === undefined) return;
    this.#clients.delete(id);
    this.#releaseFds(client);
    const header = client.channel.header;
    Atomics.store(header, HEADER_FAULT, fault);
    Atomics.store(header, HEADER_ERRNO, 0);
    Atomics.store(header, HEADER_RESPONSE, 0);
    Atomics.store(header, HEADER_STATE, STATE_DETACHED);
    Atomics.notify(header, HEADER_STATE);
    this.#log(`repacked broker detached channel ${id}: ${reason}`);
  }

  /** Detach every client, closing all descriptors. The store itself is NOT closed. */
  detachAll(reason = "broker shutting down"): void {
    for (const id of this.attachedIds()) this.detach(id, reason);
  }

  /**
   * Scan every attached channel once and answer whatever is pending. Never blocks, never throws for a
   * file or store error. Returns how many requests were answered.
   */
  serveOnce(): number {
    let served = 0;
    for (const client of [...this.#clients.values()]) {
      if (Atomics.load(client.channel.header, HEADER_STATE) !== STATE_REQUEST) continue;
      this.#answer(client);
      served += 1;
    }
    return served;
  }

  /**
   * The blocking coordinator loop. Parks the thread in `Atomics.wait` on the doorbell between
   * requests, so this thread's event loop never runs: attach every channel before calling it, and stop
   * it with `doorbell.requestStop()` from another thread.
   */
  serveForever(): void {
    this.#enterLoop();
    try {
      while (this.doorbell.running()) {
        const observed = this.doorbell.ticket();
        if (this.serveOnce() > 0) continue;
        this.doorbell.wait(observed, this.#pollIntervalMs);
      }
    } finally {
      this.#serving = false;
    }
  }

  /**
   * The same loop on `Atomics.waitAsync`, for a host that must not park its thread — the tab's main
   * thread, or a worker that also has to receive `postMessage`. Channels may be attached and detached
   * while it runs. Resolves when `doorbell.requestStop()` is called.
   */
  async serve(): Promise<void> {
    this.#enterLoop();
    try {
      while (this.doorbell.running()) {
        const observed = this.doorbell.ticket();
        if (this.serveOnce() > 0) continue;
        await this.doorbell.waitAsync(observed, this.#pollIntervalMs);
      }
    } finally {
      this.#serving = false;
    }
  }

  #enterLoop(): void {
    if (this.#serving) throw new Error("the repacked broker is already serving");
    this.#serving = true;
  }

  #releaseFds(client: AttachedClient): void {
    for (const entry of client.fds.values()) {
      try {
        this.#vfs.close(entry.fd);
      } catch {
        // A descriptor the store already dropped (or a poisoned store) must not stop the release of
        // the rest — the client is going away either way.
      }
    }
    client.fds.clear();
  }

  /** Read one pending request, run it, and publish the reply. Never throws. */
  #answer(client: AttachedClient): void {
    const header = client.channel.header;
    const opcode = Atomics.load(header, HEADER_OPCODE);
    const requestBytes = Atomics.load(header, HEADER_REQUEST);
    let fault = FAULT_NONE;
    let answer = OK;
    try {
      if (!isKnownOpcode(opcode)) throw new ProtocolViolation(`unknown opcode ${opcode}`);
      if (requestBytes < 0 || requestBytes > client.channel.payloadBytes) {
        throw new ProtocolViolation(`request length ${requestBytes} is outside the payload region`);
      }
      const reader = new PayloadReader(client.channel.payload, requestBytes);
      const writer = new PayloadWriter(client.channel.payload);
      answer = this.#dispatch(client, opcode, reader, writer);
    } catch (cause) {
      if (cause instanceof ProtocolViolation || cause instanceof PayloadDecodeError) {
        // Only the offending client goes; every other backend keeps its descriptors and its store.
        this.#detach(client.channel.id, cause.message, FAULT_PROTOCOL);
        return;
      }
      if (cause instanceof FsError) {
        answer = { errno: cause.code, result: 0n, responseBytes: 0 };
      } else {
        // Everything else — a poisoned store, a limit, a corrupt store, or a reply that did not fit
        // the client's own channel — is not a file rejection and not this client's fault. Report it
        // as a fault and keep the loop alive; a poisoned store answers every later request the same
        // way, and the client decides whether to give up.
        fault = FAULT_STORE;
        answer = this.#faultAnswer(client, cause);
      }
    }
    const { lo, hi } = splitResult(answer.result);
    Atomics.store(header, HEADER_ERRNO, answer.errno);
    Atomics.store(header, HEADER_RESULT_LO, lo);
    Atomics.store(header, HEADER_RESULT_HI, hi);
    Atomics.store(header, HEADER_RESPONSE, answer.responseBytes);
    Atomics.store(header, HEADER_FAULT, fault);
    Atomics.store(header, HEADER_STATE, STATE_RESPONSE);
    Atomics.notify(header, HEADER_STATE);
  }

  /** Put a fault message in the payload, truncating rather than overflowing a small channel. */
  #faultAnswer(client: AttachedClient, cause: unknown): Answer {
    const message = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
    const writer = new PayloadWriter(client.channel.payload);
    const room = client.channel.payloadBytes - 4;
    try {
      writer.string(message.length > room ? message.slice(0, Math.max(0, room)) : message);
    } catch {
      return { errno: 0, result: 0n, responseBytes: 0 };
    }
    return { errno: 0, result: 0n, responseBytes: writer.length };
  }

  #dispatch(client: AttachedClient, opcode: number, reader: PayloadReader, writer: PayloadWriter): Answer {
    switch (opcode) {
      case OPCODE_OPEN:
        return this.#open(client, reader);
      case OPCODE_CLOSE:
        return this.#close(client, reader);
      case OPCODE_READ:
        return this.#read(client, reader);
      case OPCODE_WRITE:
        return this.#write(client, reader);
      case OPCODE_FSYNC:
        return this.#fsync(client, reader);
      case OPCODE_FSTAT:
        return this.#stat(writer, this.#vfs.fstat(this.#fd(client, reader.u32()).fd));
      case OPCODE_STAT:
        return this.#stat(writer, this.#vfs.stat(reader.string()));
      case OPCODE_LSTAT:
        return this.#stat(writer, this.#vfs.lstat(reader.string()));
      case OPCODE_READDIR:
        return this.#readdir(reader, writer);
      case OPCODE_MKDIR:
        return this.#mkdir(reader);
      case OPCODE_RMDIR:
        this.#vfs.rmdir(reader.string(), this.#now());
        return OK;
      case OPCODE_UNLINK:
        this.#vfs.unlink(reader.string(), this.#now());
        return OK;
      case OPCODE_RENAME: {
        const oldPath = reader.string();
        this.#vfs.rename(oldPath, reader.string(), this.#now());
        return OK;
      }
      case OPCODE_TRUNCATE: {
        const path = reader.string();
        this.#vfs.truncate(path, reader.u64(), this.#now());
        return OK;
      }
      case OPCODE_SIZE:
        return this.#size(reader);
      default:
        throw new ProtocolViolation(`unhandled opcode ${opcode}`);
    }
  }

  #open(client: AttachedClient, reader: PayloadReader): Answer {
    const path = reader.string();
    const flags = reader.u32();
    const mode = reader.u32();
    const plan = planOpen(flags);
    const nowMs = this.#now();
    if (plan.requireExisting) this.#vfs.lstat(path);
    if (plan.truncateFirst) this.#vfs.truncate(path, 0n, nowMs);
    let fd: number;
    try {
      fd = this.#vfs.open(path, plan.coreFlags, mode, nowMs);
    } catch (cause) {
      if (plan.fallbackFlags === undefined || !(cause instanceof FsError) || cause.code !== FS_ERRNO.ENOENT) {
        throw cause;
      }
      fd = this.#vfs.open(path, plan.fallbackFlags, mode, nowMs);
    }
    client.fds.set(fd, { fd, readable: plan.readable, writable: plan.writable });
    return ok(fd);
  }

  #close(client: AttachedClient, reader: PayloadReader): Answer {
    const entry = this.#fd(client, reader.u32());
    this.#vfs.close(entry.fd);
    client.fds.delete(entry.fd);
    return OK;
  }

  #read(client: AttachedClient, reader: PayloadReader): Answer {
    const entry = this.#fd(client, reader.u32());
    if (!entry.readable) throw new FsError("EBADF", "descriptor was not opened for reading");
    const hasPosition = reader.u8() === 1;
    const position = reader.u64();
    const length = reader.u32();
    if (length > client.channel.payloadBytes) {
      throw new ProtocolViolation(`read length ${length} exceeds the payload region`);
    }
    const target = client.channel.payload.subarray(0, length);
    const count = hasPosition
      ? this.#vfs.read(entry.fd, target, 0, length, position)
      : this.#vfs.read(entry.fd, target, 0, length);
    return ok(count, count);
  }

  #write(client: AttachedClient, reader: PayloadReader): Answer {
    const entry = this.#fd(client, reader.u32());
    if (!entry.writable) throw new FsError("EBADF", "descriptor was not opened for writing");
    const hasPosition = reader.u8() === 1;
    const position = reader.u64();
    const length = reader.u32();
    const source = reader.bytes(length);
    const count = this.#vfs.write(entry.fd, source, 0, length, hasPosition ? position : undefined, this.#now());
    return ok(count);
  }

  /**
   * `fsync` is store-wide. The core's only durability primitive is `strictSync()`, which flushes the
   * arena and then the active metadata log, so a successful `fsync` promises that EVERY byte written
   * through this broker by ANY client before the call returned is recoverable — not just this
   * descriptor's. WASI `fd_sync` and `fd_datasync` both map to it; the fd is carried only so the call
   * still fails with `EBADF` on a descriptor the client does not own, exactly as `fd_sync` must.
   */
  #fsync(client: AttachedClient, reader: PayloadReader): Answer {
    if (reader.u8() === 1) this.#fd(client, reader.u32());
    this.#vfs.strictSync();
    return OK;
  }

  #stat(writer: PayloadWriter, stat: RepackedStat): Answer {
    writeStat(writer, stat);
    return ok(stat.size, writer.length);
  }

  /**
   * One page of a directory listing. The cursor is an index into the store's own sorted listing, which
   * the store recomputes on every call — so, exactly as POSIX `readdir` allows, a listing spread over
   * several pages is not an atomic snapshot of the directory.
   */
  #readdir(reader: PayloadReader, writer: PayloadWriter): Answer {
    const path = reader.string();
    const cursor = reader.u32();
    const names = this.#vfs.readdir(path);
    if (cursor > names.length) throw new ProtocolViolation(`readdir cursor ${cursor} is past the listing`);
    // Reserve the two counters written after the entries are known to fit.
    const countAt = writer.length;
    writer.u32(0);
    writer.i32(READDIR_DONE);
    let emitted = 0;
    let next = READDIR_DONE;
    for (let index = cursor; index < names.length; index += 1) {
      const before = writer.length;
      try {
        writer.string(names[index]!);
      } catch (cause) {
        if (!(cause instanceof PayloadOverflowError)) throw cause;
        writer.rewind(before);
        if (emitted === 0) throw cause; // one name alone cannot fit: the channel is too small
        next = index;
        break;
      }
      emitted += 1;
    }
    const counters = writer.patch(countAt, 8);
    counters.setUint32(0, emitted, true);
    counters.setInt32(4, next, true);
    return ok(emitted, writer.length);
  }

  #mkdir(reader: PayloadReader): Answer {
    const path = reader.string();
    const recursive = reader.u8() === 1;
    const mode = reader.u32();
    this.#vfs.mkdir(path, { recursive, mode, nowMs: this.#now() });
    return OK;
  }

  #size(reader: PayloadReader): Answer {
    const stat = this.#vfs.stat(reader.string());
    if (stat.kind !== "file") throw new FsError("EISDIR", "size is a file query");
    return ok(stat.size);
  }

  /**
   * Resolve a descriptor the CLIENT owns. A descriptor that belongs to another client is `EBADF`, not
   * a protocol violation: fd numbers are per-store, so a client guessing one is an ordinary bad-fd
   * mistake and never a reason to reach into another backend's files.
   */
  #fd(client: AttachedClient, fd: number): BrokerFd {
    const entry = client.fds.get(fd);
    if (entry === undefined) throw new FsError("EBADF", `descriptor ${fd} is not owned by this client`);
    return entry;
  }
}
