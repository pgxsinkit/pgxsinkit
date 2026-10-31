// Began as a copy of `@electric-sql/pg-protocol`, itself adapted from node-postgres' `pg-protocol`
// (MIT, © Brian Carlson; ElectricSQL's changes taken under the PostgreSQL License — see NOTICE).
// Owned outright (ADR-0062); compatibility with PGlite is an anti-goal — evolve freely.

const emptyBuffer = new ArrayBuffer(0);

/** Big-endian reads over one backend message, advancing an offset. */
export class BufferReader {
  #bufferView: DataView = new DataView(emptyBuffer);
  #offset: number;
  readonly #decoder = new TextDecoder("utf-8");

  constructor(offset = 0) {
    this.#offset = offset;
  }

  setBuffer(offset: number, buffer: ArrayBufferLike): void {
    this.#offset = offset;
    this.#bufferView = new DataView(buffer);
  }

  int16(): number {
    const result = this.#bufferView.getInt16(this.#offset, false);
    this.#offset += 2;
    return result;
  }

  uint16(): number {
    const result = this.#bufferView.getUint16(this.#offset, false);
    this.#offset += 2;
    return result;
  }

  byte(): number {
    const result = this.#bufferView.getUint8(this.#offset);
    this.#offset++;
    return result;
  }

  int32(): number {
    const result = this.#bufferView.getInt32(this.#offset, false);
    this.#offset += 4;
    return result;
  }

  string(length: number): string {
    const offset = this.#offset;
    if (
      Number.isInteger(offset) &&
      offset >= 0 &&
      Number.isInteger(length) &&
      length >= 0 &&
      length <= this.#bufferView.byteLength - offset
    ) {
      // Decode while the view is borrowed; only the resulting string escapes. Binary bytes() still owns its data.
      const bytes = new Uint8Array(this.#bufferView.buffer, offset, length);
      this.#offset += length;
      return this.#decoder.decode(bytes);
    }
    // Keep slice's clipping/coercion and offset advancement for malformed input.
    return this.#decoder.decode(this.bytes(length));
  }

  cstring(): string {
    const start = this.#offset;
    let end = start;
    while (this.#bufferView.getUint8(end++) !== 0) {
      // advance to the terminator
    }
    const result = this.string(end - start - 1);
    this.#offset = end;
    return result;
  }

  bytes(length: number): Uint8Array {
    const result = this.#bufferView.buffer.slice(this.#offset, this.#offset + length);
    this.#offset += length;
    return new Uint8Array(result);
  }
}
