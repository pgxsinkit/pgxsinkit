/**
 * Frontend messages out of libpq's `send()` calls.
 *
 * On a Unix-socket connection, which pg_dump's is, libpq sends its output in whole 8 KiB blocks as a
 * message is added and keeps the rest for its next send (`pqPutMsgEnd`), so a longer message reaches
 * pg_dump's write callback in pieces; one call can also carry several messages. The session must only
 * be handed whole messages: a piece makes the backend read past the end of its input. The first message of a connection is a startup packet (a length, then its body);
 * every later one is a type byte, then a length that counts itself.
 */
export class FrontendFramer {
  #pending: Uint8Array = new Uint8Array(0);
  #startup = true;

  /** Take a copy of `bytes`; return every message that is now complete, in order. */
  push(bytes: Uint8Array): Uint8Array[] {
    const joined = new Uint8Array(this.#pending.byteLength + bytes.byteLength);
    joined.set(this.#pending, 0);
    joined.set(bytes, this.#pending.byteLength);
    const messages: Uint8Array[] = [];
    let offset = 0;
    for (;;) {
      const header = this.#startup ? 4 : 5;
      if (joined.byteLength - offset < header) break;
      const lengthAt = offset + header - 4;
      const length = new DataView(joined.buffer, joined.byteOffset + lengthAt, 4).getUint32(0, false);
      if (length < 4) throw new Error(`pg_dump sent a frontend message with an invalid length (${length})`);
      const end = lengthAt + length;
      if (joined.byteLength < end) break;
      messages.push(joined.slice(offset, end));
      offset = end;
      this.#startup = false;
    }
    this.#pending = joined.slice(offset);
    return messages;
  }

  /** Bytes of an incomplete message, still waiting for the rest. */
  get pendingBytes(): number {
    return this.#pending.byteLength;
  }
}

/** Backend bytes waiting for libpq's `recv()`, read in whatever sizes it asks for. */
export class ByteQueue {
  readonly #chunks: Uint8Array[] = [];
  #head = 0;

  /** Keep a copy of `bytes`. */
  push(bytes: Uint8Array): void {
    if (bytes.byteLength > 0) this.#chunks.push(bytes.slice());
  }

  /** Move up to `target.byteLength` bytes into `target`; returns how many were moved. */
  read(target: Uint8Array): number {
    let written = 0;
    while (written < target.byteLength && this.#chunks.length > 0) {
      const chunk = this.#chunks[0];
      if (chunk === undefined) break;
      const take = Math.min(chunk.byteLength - this.#head, target.byteLength - written);
      target.set(chunk.subarray(this.#head, this.#head + take), written);
      written += take;
      this.#head += take;
      if (this.#head === chunk.byteLength) {
        this.#chunks.shift();
        this.#head = 0;
      }
    }
    return written;
  }
}
