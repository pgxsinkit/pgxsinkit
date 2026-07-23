interface MemoryFile {
  bytes: Uint8Array;
  locked: boolean;
  flushCount: number;
  flushFailure: Error | undefined;
  closeCount: number;
  closeFailure: Error | undefined;
}

export class MemoryOpfsDirectory {
  readonly #entries = new Map<string, { kind: "directory" } | ({ kind: "file" } & MemoryFile)>();
  readonly #acquireFailures = new Map<string, Error>();

  async *values(): AsyncIterable<{ readonly kind: "file" | "directory"; readonly name: string }> {
    for (const [name, entry] of [...this.#entries].sort(([left], [right]) => left.localeCompare(right))) {
      yield { kind: entry.kind, name };
    }
  }

  async getFileHandle(name: string, options?: { create?: boolean }): Promise<MemoryOpfsFileHandle> {
    const existing = this.#entries.get(name);
    if (existing?.kind === "directory") throw new DOMException("entry is a directory", "TypeMismatchError");
    if (existing?.kind === "file") return new MemoryOpfsFileHandle(existing, () => this.#takeAcquireFailure(name));
    if (!options?.create) throw new DOMException("entry does not exist", "NotFoundError");
    const created = {
      kind: "file" as const,
      bytes: new Uint8Array(),
      locked: false,
      flushCount: 0,
      flushFailure: undefined,
      closeCount: 0,
      closeFailure: undefined,
    };
    this.#entries.set(name, created);
    return new MemoryOpfsFileHandle(created, () => this.#takeAcquireFailure(name));
  }

  injectDirectory(name: string): void {
    this.#entries.set(name, { kind: "directory" });
  }

  openHandleCount(): number {
    let count = 0;
    for (const entry of this.#entries.values()) if (entry.kind === "file" && entry.locked) count += 1;
    return count;
  }

  flushCount(name: string): number {
    const entry = this.#entries.get(name);
    return entry?.kind === "file" ? entry.flushCount : 0;
  }

  failNextFlush(name: string, failure: Error): void {
    const entry = this.#entries.get(name);
    if (entry?.kind !== "file") throw new Error(`memory OPFS file ${name} does not exist`);
    entry.flushFailure = failure;
  }

  failNextAcquire(name: string, failure: Error): void {
    this.#acquireFailures.set(name, failure);
  }

  failNextClose(name: string, failure: Error): void {
    const entry = this.#entries.get(name);
    if (entry?.kind !== "file") throw new Error(`memory OPFS file ${name} does not exist`);
    entry.closeFailure = failure;
  }

  closeAttemptCount(name: string): number {
    const entry = this.#entries.get(name);
    return entry?.kind === "file" ? entry.closeCount : 0;
  }

  #takeAcquireFailure(name: string): Error | undefined {
    const failure = this.#acquireFailures.get(name);
    this.#acquireFailures.delete(name);
    return failure;
  }
}

class MemoryOpfsFileHandle {
  readonly kind = "file" as const;
  readonly #file: MemoryFile;
  readonly #takeAcquireFailure: () => Error | undefined;

  constructor(file: MemoryFile, takeAcquireFailure: () => Error | undefined) {
    this.#file = file;
    this.#takeAcquireFailure = takeAcquireFailure;
  }

  async createSyncAccessHandle(): Promise<MemoryOpfsSyncAccessHandle> {
    const failure = this.#takeAcquireFailure();
    if (failure !== undefined) throw failure;
    if (this.#file.locked) throw new DOMException("file is already locked", "NoModificationAllowedError");
    this.#file.locked = true;
    return new MemoryOpfsSyncAccessHandle(this.#file);
  }
}

class MemoryOpfsSyncAccessHandle {
  readonly #file: MemoryFile;
  #closed = false;

  constructor(file: MemoryFile) {
    this.#file = file;
  }

  getSize(): number {
    this.#assertOpen();
    return this.#file.bytes.byteLength;
  }

  read(target: Uint8Array, options: { at: number }): number {
    this.#assertOpen();
    const count = Math.max(0, Math.min(target.byteLength, this.#file.bytes.byteLength - options.at));
    target.set(this.#file.bytes.subarray(options.at, options.at + count));
    return count;
  }

  write(source: Uint8Array, options: { at: number }): number {
    this.#assertOpen();
    const required = options.at + source.byteLength;
    if (required > this.#file.bytes.byteLength) {
      const grown = new Uint8Array(required);
      grown.set(this.#file.bytes);
      this.#file.bytes = grown;
    }
    this.#file.bytes.set(source, options.at);
    return source.byteLength;
  }

  truncate(size: number): void {
    this.#assertOpen();
    const next = new Uint8Array(size);
    next.set(this.#file.bytes.subarray(0, Math.min(size, this.#file.bytes.byteLength)));
    this.#file.bytes = next;
  }

  flush(): void {
    this.#assertOpen();
    const failure = this.#file.flushFailure;
    this.#file.flushFailure = undefined;
    if (failure !== undefined) throw failure;
    this.#file.flushCount += 1;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#file.closeCount += 1;
    this.#file.locked = false;
    const failure = this.#file.closeFailure;
    this.#file.closeFailure = undefined;
    if (failure !== undefined) throw failure;
  }

  #assertOpen(): void {
    if (this.#closed) throw new DOMException("access handle is closed", "InvalidStateError");
  }
}
