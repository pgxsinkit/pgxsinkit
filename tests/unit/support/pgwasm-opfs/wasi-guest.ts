/**
 * A stand-in for a wasm guest's linear memory, so a WASI preview1 call can be made the way the engine
 * makes it: arguments marshalled INTO memory, results read back OUT of it. Nothing in the adapter is
 * reachable any other way — every one of its functions takes pointers and returns an errno.
 *
 * The scratch allocator is a bump pointer: a test writes its path, its iovec array and its result
 * slots wherever `alloc` puts them and never frees. `reset()` rewinds it between cases.
 */

export class GuestMemory {
  readonly memory: WebAssembly.Memory;
  readonly #base: number;
  #cursor: number;

  constructor(options: { pages?: number; shared?: boolean; scratchBase?: number } = {}) {
    const pages = options.pages ?? 4;
    this.memory =
      options.shared === true
        ? new WebAssembly.Memory({ initial: pages, maximum: pages, shared: true })
        : new WebAssembly.Memory({ initial: pages });
    this.#base = options.scratchBase ?? 1024;
    this.#cursor = this.#base;
  }

  /** The `memory()` callback the adapter takes: resolved on every call, never cached. */
  get resolver(): () => ArrayBuffer | SharedArrayBuffer {
    return () => this.memory.buffer;
  }

  bytes(): Uint8Array {
    return new Uint8Array(this.memory.buffer);
  }

  view(): DataView {
    return new DataView(this.memory.buffer);
  }

  reset(): void {
    this.#cursor = this.#base;
  }

  /** Reserve `count` bytes, 8-byte aligned so a `u64` result slot is never misaligned. */
  alloc(count: number): number {
    const at = (this.#cursor + 7) & ~7;
    this.#cursor = at + count;
    if (this.#cursor > this.memory.buffer.byteLength) throw new RangeError("guest scratch exhausted");
    return at;
  }

  /** Write a UTF-8 string into scratch; returns the pointer and its byte length. */
  string(value: string): { ptr: number; len: number } {
    const encoded = new TextEncoder().encode(value);
    const ptr = this.alloc(encoded.byteLength);
    this.bytes().set(encoded, ptr);
    return { ptr, len: encoded.byteLength };
  }

  /** Write `data` into scratch and return the pointer. */
  buffer(data: Uint8Array): number {
    const ptr = this.alloc(data.byteLength);
    this.bytes().set(data, ptr);
    return ptr;
  }

  /** Build a WASI `iovec` array over already-placed buffers. */
  iovecs(entries: readonly { ptr: number; len: number }[]): number {
    const ptr = this.alloc(entries.length * 8);
    const view = this.view();
    entries.forEach((entry, index) => {
      view.setUint32(ptr + index * 8, entry.ptr, true);
      view.setUint32(ptr + index * 8 + 4, entry.len, true);
    });
    return ptr;
  }

  /** One iovec over a freshly reserved `length`-byte landing zone, for a read. */
  readTarget(length: number): { iovs: number; ptr: number; len: number } {
    const ptr = this.alloc(length);
    this.bytes().fill(0, ptr, ptr + length);
    return { iovs: this.iovecs([{ ptr, len: length }]), ptr, len: length };
  }

  /** One iovec over `data`, for a write. */
  writeSource(data: Uint8Array): number {
    return this.iovecs([{ ptr: this.buffer(data), len: data.byteLength }]);
  }

  u32(ptr: number): number {
    return this.view().getUint32(ptr, true);
  }

  u64(ptr: number): bigint {
    return this.view().getBigUint64(ptr, true);
  }

  read(ptr: number, length: number): Uint8Array {
    return this.bytes().slice(ptr, ptr + length);
  }

  text(ptr: number, length: number): string {
    return new TextDecoder().decode(this.read(ptr, length));
  }
}

/** One decoded `fd_readdir` record. */
export interface GuestDirent {
  readonly next: bigint;
  readonly ino: bigint;
  readonly namlen: number;
  readonly filetype: number;
  readonly name: string;
  /** True when the buffer ran out mid-name: the caller must grow it and retry from `next`. */
  readonly truncated: boolean;
}

/** Decode the dirent stream `fd_readdir` wrote, exactly as wasi-libc's `readdir` would. */
export function decodeDirents(memory: GuestMemory, bufPtr: number, used: number): GuestDirent[] {
  const view = memory.view();
  const entries: GuestDirent[] = [];
  let offset = 0;
  while (offset + 24 <= used) {
    const at = bufPtr + offset;
    const next = view.getBigUint64(at, true);
    const ino = view.getBigUint64(at + 8, true);
    const namlen = view.getUint32(at + 16, true);
    const filetype = view.getUint8(at + 20);
    const available = Math.min(namlen, used - offset - 24);
    entries.push({
      next,
      ino,
      namlen,
      filetype,
      name: memory.text(at + 24, available),
      truncated: available < namlen,
    });
    offset += 24 + namlen;
  }
  return entries;
}
