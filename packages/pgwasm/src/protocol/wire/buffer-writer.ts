// Began as a copy of `@electric-sql/pg-protocol`, itself adapted from node-postgres' `pg-protocol`
// (MIT, © Brian Carlson; ElectricSQL's changes taken under the PostgreSQL License — see NOTICE).
// Owned outright (ADR-0062); compatibility with PGlite is an anti-goal — evolve freely.

import { byteLengthUtf8 } from "./string-utils";

/** Builds frontend messages: a 5-byte header slot (code + length) followed by the body. */
export class Writer {
  readonly #size: number;
  #bufferView: DataView<ArrayBuffer>;
  #offset = 5;
  readonly #encoder = new TextEncoder();
  readonly #headerPosition = 0;

  constructor(size = 256) {
    this.#size = size;
    this.#bufferView = this.#allocateBuffer(size);
  }

  #allocateBuffer(size: number): DataView<ArrayBuffer> {
    return new DataView(new ArrayBuffer(size));
  }

  #ensure(size: number): void {
    const remaining = this.#bufferView.byteLength - this.#offset;
    if (remaining < size) {
      const oldBuffer = this.#bufferView.buffer;
      // Grow by ~1.5x (https://stackoverflow.com/questions/2269063/buffer-growth-strategy).
      const newSize = oldBuffer.byteLength + (oldBuffer.byteLength >> 1) + size;
      this.#bufferView = this.#allocateBuffer(newSize);
      new Uint8Array(this.#bufferView.buffer).set(new Uint8Array(oldBuffer));
    }
  }

  addInt32(num: number): Writer {
    this.#ensure(4);
    this.#bufferView.setInt32(this.#offset, num, false);
    this.#offset += 4;
    return this;
  }

  addInt16(num: number): Writer {
    this.#ensure(2);
    this.#bufferView.setInt16(this.#offset, num, false);
    this.#offset += 2;
    return this;
  }

  addCString(string: string): Writer {
    if (string) {
      this.addString(string);
    }
    this.#ensure(1);
    this.#bufferView.setUint8(this.#offset, 0);
    this.#offset++;
    return this;
  }

  addString(string = ""): Writer {
    const length = byteLengthUtf8(string);
    this.#ensure(length);
    this.#encoder.encodeInto(string, new Uint8Array(this.#bufferView.buffer, this.#offset));
    this.#offset += length;
    return this;
  }

  add(otherBuffer: ArrayBuffer | ArrayBufferView): Writer {
    const bytes = ArrayBuffer.isView(otherBuffer)
      ? new Uint8Array(otherBuffer.buffer, otherBuffer.byteOffset, otherBuffer.byteLength)
      : new Uint8Array(otherBuffer);
    this.#ensure(bytes.byteLength);
    new Uint8Array(this.#bufferView.buffer).set(bytes, this.#offset);
    this.#offset += bytes.byteLength;
    return this;
  }

  #join(code?: number): ArrayBuffer {
    if (code) {
      this.#bufferView.setUint8(this.#headerPosition, code);
      // The length counts everything in the message but the code byte.
      const length = this.#offset - (this.#headerPosition + 1);
      this.#bufferView.setInt32(this.#headerPosition + 1, length, false);
    }
    return this.#bufferView.buffer.slice(code ? 0 : 5, this.#offset);
  }

  flush(code?: number): Uint8Array<ArrayBuffer> {
    const result = this.#join(code);
    this.#offset = 5;
    this.#bufferView = this.#allocateBuffer(this.#size);
    return new Uint8Array(result);
  }
}
