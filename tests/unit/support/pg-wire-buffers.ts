// Began as a copy of `@electric-sql/pg-protocol`'s test helpers, themselves adapted from node-postgres'
// `pg-protocol` (MIT, © Brian Carlson; ElectricSQL's changes taken under the PostgreSQL License — see
// NOTICE). Owned outright (ADR-0062); compatibility with PGlite is an anti-goal — evolve freely.

import { byteLengthUtf8 } from "../../../packages/pgwasm/src/protocol/wire/string-utils";

/** Builds a backend (or frontend) message byte by byte, for comparing against the codec's output. */
export class BufferList {
  buffers: Uint8Array[];

  constructor(buffers: Uint8Array[] = []) {
    this.buffers = buffers;
  }

  add(buffer: ArrayBuffer | Uint8Array, front?: boolean): BufferList {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    if (front) this.buffers.unshift(bytes);
    else this.buffers.push(bytes);
    return this;
  }

  addInt16(val: number, front?: boolean): BufferList {
    return this.add(new Uint8Array([(val >>> 8) & 0xff, val & 0xff]), front);
  }

  getByteLength(initial = 0): number {
    return this.buffers.reduce((previous, current) => previous + current.byteLength, initial);
  }

  addInt32(val: number, first?: boolean): BufferList {
    return this.add(new Uint8Array([(val >>> 24) & 0xff, (val >>> 16) & 0xff, (val >>> 8) & 0xff, val & 0xff]), first);
  }

  addCString(val: string, front?: boolean): BufferList {
    const len = byteLengthUtf8(val);
    const bufferView = new Uint8Array(len + 1);
    new TextEncoder().encodeInto(val, bufferView);
    bufferView[len] = 0;
    return this.add(bufferView, front);
  }

  addString(val: string, front?: boolean): BufferList {
    const len = byteLengthUtf8(val);
    const bufferView = new Uint8Array(len);
    new TextEncoder().encodeInto(val, bufferView);
    return this.add(bufferView, front);
  }

  addChar(char: string, first?: boolean): BufferList {
    return this.add(new TextEncoder().encode(char), first);
  }

  addByte(byte: number): BufferList {
    return this.add(new Uint8Array([byte]));
  }

  join(appendLength?: boolean, char?: string): Uint8Array<ArrayBuffer> {
    let length = this.getByteLength();
    if (appendLength) {
      this.addInt32(length + 4, true);
      return this.join(false, char);
    }
    if (char) {
      this.addChar(char, true);
      length++;
    }
    const result = new Uint8Array(length);
    let index = 0;
    for (const buffer of this.buffers) {
      result.set(buffer, index);
      index += buffer.byteLength;
    }
    return result;
  }
}

interface FieldSpec {
  name: string;
  tableID: number;
  columnID: number;
  dataTypeID: number;
  dataTypeSize: number;
  dataTypeModifier: number;
  format: number;
}

interface NoticeField {
  type: string;
  value: string;
}

function errorOrNotice(fields: NoticeField[]): BufferList {
  const buf = new BufferList();
  for (const field of fields) {
    buf.addChar(field.type);
    buf.addCString(field.value);
  }
  return buf.add(new Uint8Array([0])); // terminator
}

/** Backend messages as bytes (https://www.postgresql.org/docs/current/protocol-message-formats.html). */
export const buffers = {
  readyForQuery: () => new BufferList().add(new TextEncoder().encode("I")).join(true, "Z"),
  authenticationOk: () => new BufferList().addInt32(0).join(true, "R"),
  authenticationCleartextPassword: () => new BufferList().addInt32(3).join(true, "R"),
  authenticationMD5Password: () =>
    new BufferList()
      .addInt32(5)
      .add(new Uint8Array([1, 2, 3, 4]))
      .join(true, "R"),
  authenticationSASL: () => new BufferList().addInt32(10).addCString("SCRAM-SHA-256").addCString("").join(true, "R"),
  authenticationSASLContinue: () => new BufferList().addInt32(11).addString("data").join(true, "R"),
  authenticationSASLFinal: () => new BufferList().addInt32(12).addString("data").join(true, "R"),
  parameterStatus: (name: string, value: string) => new BufferList().addCString(name).addCString(value).join(true, "S"),
  backendKeyData: (processID: number, secretKey: number) =>
    new BufferList().addInt32(processID).addInt32(secretKey).join(true, "K"),
  commandComplete: (text: string) => new BufferList().addCString(text).join(true, "C"),
  rowDescription: (fields: FieldSpec[]) => {
    const buf = new BufferList();
    buf.addInt16(fields.length);
    for (const field of fields) {
      buf
        .addCString(field.name)
        .addInt32(field.tableID)
        .addInt16(field.columnID)
        .addInt32(field.dataTypeID)
        .addInt16(field.dataTypeSize)
        .addInt32(field.dataTypeModifier)
        .addInt16(field.format);
    }
    return buf.join(true, "T");
  },
  parameterDescription: (dataTypeIDs: number[]) => {
    const buf = new BufferList();
    buf.addInt16(dataTypeIDs.length);
    for (const dataTypeID of dataTypeIDs) buf.addInt32(dataTypeID);
    return buf.join(true, "t");
  },
  dataRow: (columns: (string | null)[]) => {
    const buf = new BufferList();
    buf.addInt16(columns.length);
    for (const col of columns) {
      if (col === null) {
        buf.addInt32(-1);
      } else {
        const strBuf = new TextEncoder().encode(col);
        buf.addInt32(strBuf.byteLength);
        buf.add(strBuf);
      }
    }
    return buf.join(true, "D");
  },
  error: (fields: NoticeField[]) => errorOrNotice(fields).join(true, "E"),
  notice: (fields: NoticeField[]) => errorOrNotice(fields).join(true, "N"),
  parseComplete: () => new BufferList().join(true, "1"),
  bindComplete: () => new BufferList().join(true, "2"),
  notification: (id: number, channel: string, payload: string) =>
    new BufferList().addInt32(id).addCString(channel).addCString(payload).join(true, "A"),
  emptyQuery: () => new BufferList().join(true, "I"),
  portalSuspended: () => new BufferList().join(true, "s"),
  closeComplete: () => new BufferList().join(true, "3"),
  copyIn: (cols: number) => {
    const list = new BufferList().addByte(0).addInt16(cols);
    for (let i = 0; i < cols; i++) list.addInt16(i);
    return list.join(true, "G");
  },
  copyOut: (cols: number) => {
    const list = new BufferList().addByte(0).addInt16(cols);
    for (let i = 0; i < cols; i++) list.addInt16(i);
    return list.join(true, "H");
  },
  copyData: (bytes: Uint8Array) => new BufferList().add(bytes).join(true, "d"),
  copyDone: () => new BufferList().join(true, "c"),
};
