import { StoreOwnedError } from "../../src/core/errors";
import { OWNED_FILE_NAMES } from "../../src/core/port";
import type { OwnedFileName, RepackedFileHandle, RepackedPort, RepackedPortEntry } from "../../src/core/port";

export type MemoryOperation = "enumerate" | "acquire" | "getSize" | "read" | "write" | "truncate" | "flush";
type FaultOutcome = "short" | "throw-before" | "throw-after" | "quota";

export interface MemoryFault {
  operation: MemoryOperation;
  outcome: FaultOutcome;
  file?: string;
  label?: string;
  bytes?: number;
  occurrence?: number;
}

interface WriteEffect {
  id: number;
  file: OwnedFileName;
  kind: "write";
  at: number;
  data: Uint8Array;
}

interface TruncateEffect {
  id: number;
  file: OwnedFileName;
  kind: "truncate";
  size: number;
}

type MemoryEffect = WriteEffect | TruncateEffect;
export type TerminationDecision = "absent" | "full" | number;

export interface MemoryEffectSummary {
  id: number;
  file: OwnedFileName;
  operation: "write" | "truncate";
  bytes: number;
}

export interface MemoryOperationSummary {
  readonly operation: MemoryOperation;
  readonly file: OwnedFileName | undefined;
  readonly label: string;
}

function clone(bytes: Uint8Array): Uint8Array {
  return bytes.slice();
}

function applyWrite(current: Uint8Array, at: number, source: Uint8Array): Uint8Array {
  const required = at + source.byteLength;
  const next = required <= current.byteLength ? clone(current) : new Uint8Array(required);
  if (next.byteLength > current.byteLength) next.set(current);
  next.set(source, at);
  return next;
}

function applyTruncate(current: Uint8Array, size: number): Uint8Array {
  if (size === current.byteLength) return clone(current);
  const next = new Uint8Array(size);
  next.set(current.subarray(0, Math.min(size, current.byteLength)));
  return next;
}

function isOwnedFileName(name: string): name is OwnedFileName {
  return (OWNED_FILE_NAMES as readonly string[]).includes(name);
}

class MemoryHandle implements RepackedFileHandle {
  readonly name: OwnedFileName;
  readonly #port: MemoryRepackedPort;
  readonly #epoch: number;
  #closed = false;

  constructor(port: MemoryRepackedPort, name: OwnedFileName, epoch: number) {
    this.#port = port;
    this.name = name;
    this.#epoch = epoch;
  }

  getSize(label: string): number {
    this.#assertOpen();
    return this.#port.handleGetSize(this.name, label);
  }

  read(target: Uint8Array, at: number, label: string): number {
    this.#assertOpen();
    return this.#port.handleRead(this.name, target, at, label);
  }

  write(source: Uint8Array, at: number, label: string): number {
    this.#assertOpen();
    return this.#port.handleWrite(this.name, source, at, label);
  }

  truncate(size: number, label: string): void {
    this.#assertOpen();
    this.#port.handleTruncate(this.name, size, label);
  }

  flush(label: string): void {
    this.#assertOpen();
    this.#port.handleFlush(this.name, label);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#epoch === this.#port.epoch) this.#port.handleClose(this.name);
  }

  #assertOpen(): void {
    if (this.#closed || this.#epoch !== this.#port.epoch) {
      throw new Error(`memory handle ${this.name} is closed`);
    }
  }
}

export class MemoryRepackedPort implements RepackedPort {
  readonly #durable = new Map<OwnedFileName, Uint8Array>();
  readonly #volatile = new Map<OwnedFileName, Uint8Array>();
  readonly #entryKinds = new Map<string, "file" | "directory">();
  readonly #open = new Set<OwnedFileName>();
  readonly #faults: MemoryFault[] = [];
  readonly #operations: MemoryOperationSummary[] = [];
  #effects: MemoryEffect[] = [];
  #nextEffectId = 1;
  #epoch = 1;

  get epoch(): number {
    return this.#epoch;
  }

  async enumerate(label: string): Promise<readonly RepackedPortEntry[]> {
    this.#recordOperation("enumerate", undefined, label);
    const fault = this.#takeFault("enumerate", undefined, label);
    if (fault !== undefined) throw new Error(`injected enumerate failure ${fault.outcome}`);
    return [...this.#entryKinds]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, kind]) => ({
        name,
        kind,
      }));
  }

  async acquire(name: OwnedFileName, label: string): Promise<RepackedFileHandle> {
    this.#recordOperation("acquire", name, label);
    const fault = this.#takeFault("acquire", name, label);
    if (fault?.outcome === "throw-before") throw new Error("injected acquire failure before effect");
    if (this.#open.has(name)) throw new StoreOwnedError();
    if (this.#entryKinds.get(name) === "directory") throw new Error(`memory entry ${name} is not a file`);
    if (!this.#volatile.has(name)) {
      this.#volatile.set(name, new Uint8Array());
      this.#durable.set(name, new Uint8Array());
      this.#entryKinds.set(name, "file");
    }
    if (fault !== undefined) throw new Error(`injected acquire failure ${fault.outcome}`);
    this.#open.add(name);
    return new MemoryHandle(this, name, this.#epoch);
  }

  injectEntry(name: string, kind: "file" | "directory"): void {
    if (isOwnedFileName(name) && this.#open.has(name)) {
      throw new Error(`cannot replace acquired memory entry ${name}`);
    }
    this.#entryKinds.set(name, kind);
    if (isOwnedFileName(name)) {
      if (kind === "file") {
        this.#volatile.set(name, new Uint8Array());
        this.#durable.set(name, new Uint8Array());
      } else {
        this.#volatile.delete(name);
        this.#durable.delete(name);
      }
    }
  }

  injectFault(fault: MemoryFault): void {
    if (fault.outcome === "quota" && fault.operation !== "truncate") {
      throw new TypeError("quota faults are supported only for arena growth truncates");
    }
    if (fault.bytes !== undefined && (!Number.isSafeInteger(fault.bytes) || fault.bytes < 0)) {
      throw new TypeError("fault byte count must be a non-negative safe integer");
    }
    if (fault.occurrence !== undefined && (!Number.isSafeInteger(fault.occurrence) || fault.occurrence < 0)) {
      throw new TypeError("fault occurrence must be a non-negative safe integer");
    }
    this.#faults.push({ ...fault });
  }

  pendingEffects(): readonly MemoryEffectSummary[] {
    return this.#effects.map((effect) => ({
      id: effect.id,
      file: effect.file,
      operation: effect.kind,
      bytes: effect.kind === "write" ? effect.data.byteLength : effect.size,
    }));
  }

  openHandleCount(): number {
    return this.#open.size;
  }

  observedOperations(): readonly MemoryOperationSummary[] {
    return Object.freeze(this.#operations.map((operation) => Object.freeze({ ...operation })));
  }

  clearObservedOperations(): void {
    this.#operations.length = 0;
  }

  durableBytes(name: OwnedFileName): Uint8Array {
    return clone(this.#durable.get(name) ?? new Uint8Array());
  }

  terminate(decisions: Readonly<Record<number, TerminationDecision>> = {}): void {
    const materialized = new Map<OwnedFileName, Uint8Array>();
    for (const [name, bytes] of this.#durable) materialized.set(name, clone(bytes));
    for (const effect of this.#effects) {
      const decision = decisions[effect.id] ?? "absent";
      if (decision === "absent") continue;
      const current = materialized.get(effect.file) ?? new Uint8Array();
      if (effect.kind === "truncate") {
        if (decision !== "full") {
          throw new TypeError("truncate termination decisions must be absent or full");
        }
        materialized.set(effect.file, applyTruncate(current, effect.size));
      } else {
        const bytes = decision === "full" ? effect.data.byteLength : decision;
        if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > effect.data.byteLength) {
          throw new TypeError("write termination prefix is outside the effect");
        }
        if (bytes > 0) materialized.set(effect.file, applyWrite(current, effect.at, effect.data.subarray(0, bytes)));
      }
    }
    this.#durable.clear();
    this.#volatile.clear();
    for (const [name, bytes] of materialized) {
      this.#durable.set(name, clone(bytes));
      this.#volatile.set(name, clone(bytes));
    }
    this.#effects = [];
    this.#faults.length = 0;
    this.#open.clear();
    this.#epoch += 1;
  }

  handleGetSize(name: OwnedFileName, label: string): number {
    this.#recordOperation("getSize", name, label);
    const fault = this.#takeFault("getSize", name, label);
    if (fault !== undefined) throw new Error(`injected getSize failure ${fault.outcome}`);
    return this.#file(name).byteLength;
  }

  handleRead(name: OwnedFileName, target: Uint8Array, at: number, label: string): number {
    this.#validateRange(at, target.byteLength);
    this.#recordOperation("read", name, label);
    const fault = this.#takeFault("read", name, label);
    if (fault?.outcome === "throw-before" || fault?.outcome === "throw-after") {
      throw new Error(`injected read failure ${fault.outcome === "throw-before" ? "before" : "after"} effect`);
    }
    const source = this.#file(name);
    const available = Math.max(0, Math.min(target.byteLength, source.byteLength - at));
    const count = fault?.outcome === "short" ? Math.min(available, fault.bytes ?? 0) : available;
    target.set(source.subarray(at, at + count));
    return count;
  }

  handleWrite(name: OwnedFileName, source: Uint8Array, at: number, label: string): number {
    this.#validateRange(at, source.byteLength);
    this.#recordOperation("write", name, label);
    const fault = this.#takeFault("write", name, label);
    if (fault?.outcome === "throw-before") throw new Error("injected write failure before effect");
    const count =
      fault?.outcome === "short" || fault?.outcome === "throw-after"
        ? Math.min(source.byteLength, fault.bytes ?? source.byteLength)
        : source.byteLength;
    if (count > 0) this.#recordWrite(name, at, source.subarray(0, count));
    if (fault?.outcome === "throw-after") throw new Error("injected write failure after effect");
    return count;
  }

  handleTruncate(name: OwnedFileName, size: number, label: string): void {
    this.#validateRange(size, 0);
    this.#recordOperation("truncate", name, label);
    const fault = this.#takeFault("truncate", name, label);
    if (fault?.outcome === "quota") throw new DOMException("injected arena quota exhaustion", "QuotaExceededError");
    if (fault?.outcome === "throw-before") throw new Error("injected truncate failure before effect");
    this.#volatile.set(name, applyTruncate(this.#file(name), size));
    this.#effects.push({ id: this.#nextEffectId++, file: name, kind: "truncate", size });
    if (fault?.outcome === "throw-after") throw new Error("injected truncate failure after effect");
  }

  handleFlush(name: OwnedFileName, label: string): void {
    this.#recordOperation("flush", name, label);
    const fault = this.#takeFault("flush", name, label);
    if (fault?.outcome === "throw-before") throw new Error("injected flush failure before effect");
    this.#durable.set(name, clone(this.#file(name)));
    this.#effects = this.#effects.filter((effect) => effect.file !== name);
    if (fault?.outcome === "throw-after") throw new Error("injected flush failure after effect");
  }

  handleClose(name: OwnedFileName): void {
    this.#open.delete(name);
  }

  #file(name: OwnedFileName): Uint8Array {
    const bytes = this.#volatile.get(name);
    if (bytes === undefined) throw new Error(`memory file ${name} was not acquired`);
    return bytes;
  }

  #recordWrite(name: OwnedFileName, at: number, source: Uint8Array): void {
    const data = clone(source);
    this.#volatile.set(name, applyWrite(this.#file(name), at, data));
    this.#effects.push({ id: this.#nextEffectId++, file: name, kind: "write", at, data });
  }

  #takeFault(operation: MemoryOperation, file: string | undefined, label: string): MemoryFault | undefined {
    const index = this.#faults.findIndex(
      (fault) =>
        fault.operation === operation &&
        (fault.file === undefined || fault.file === file) &&
        (fault.label === undefined || fault.label === label),
    );
    if (index < 0) return undefined;
    const fault = this.#faults[index]!;
    if ((fault.occurrence ?? 0) > 0) {
      this.#faults[index] = { ...fault, occurrence: fault.occurrence! - 1 };
      return undefined;
    }
    return this.#faults.splice(index, 1)[0];
  }

  #recordOperation(operation: MemoryOperation, file: OwnedFileName | undefined, label: string): void {
    this.#operations.push({ operation, file, label });
  }

  #validateRange(at: number, length: number): void {
    if (!Number.isSafeInteger(at) || !Number.isSafeInteger(length) || at < 0 || length < 0) {
      throw new RangeError("memory port range is invalid");
    }
    if (!Number.isSafeInteger(at + length)) throw new RangeError("memory port range exceeds safe integers");
  }
}
