// Began as a copy of `@electric-sql/pg-protocol`, itself adapted from node-postgres' `pg-protocol`
// (MIT, © Brian Carlson; ElectricSQL's changes taken under the PostgreSQL License — see NOTICE).
// Owned outright (ADR-0062); compatibility with PGlite is an anti-goal — evolve freely.

import { Writer } from "./buffer-writer";
import { byteLengthUtf8 } from "./string-utils";

const code = {
  startup: 0x70,
  query: 0x51,
  parse: 0x50,
  bind: 0x42,
  execute: 0x45,
  flush: 0x48,
  sync: 0x53,
  end: 0x58,
  close: 0x43,
  describe: 0x44,
  copyFromChunk: 0x64,
  copyDone: 0x63,
  copyFail: 0x66,
} as const;

type Code = (typeof code)[keyof typeof code];

/** A bind parameter: text, raw bytes (sent as binary), or SQL NULL. */
export type LegalValue = string | ArrayBuffer | ArrayBufferView | null;

const writer = new Writer();

function startup(opts: Record<string, string>): Uint8Array<ArrayBuffer> {
  // protocol version 3.0
  writer.addInt16(3).addInt16(0);
  for (const [key, value] of Object.entries(opts)) {
    writer.addCString(key).addCString(value);
  }
  writer.addCString("client_encoding").addCString("UTF8");
  // The startup message is sent without a type byte.
  const bodyBuffer = writer.addCString("").flush();
  const length = bodyBuffer.byteLength + 4;
  return new Writer().addInt32(length).add(bodyBuffer).flush();
}

function requestSsl(): Uint8Array<ArrayBuffer> {
  const bufferView = new DataView(new ArrayBuffer(8));
  bufferView.setInt32(0, 8, false);
  bufferView.setInt32(4, 80877103, false);
  return new Uint8Array(bufferView.buffer);
}

function password(value: string): Uint8Array<ArrayBuffer> {
  return writer.addCString(value).flush(code.startup);
}

function sendSASLInitialResponseMessage(mechanism: string, initialResponse: string): Uint8Array<ArrayBuffer> {
  writer.addCString(mechanism).addInt32(byteLengthUtf8(initialResponse)).addString(initialResponse);
  return writer.flush(code.startup);
}

function sendSCRAMClientFinalMessage(additionalData: string): Uint8Array<ArrayBuffer> {
  return writer.addString(additionalData).flush(code.startup);
}

function query(text: string): Uint8Array<ArrayBuffer> {
  return writer.addCString(text).flush(code.query);
}

export interface ParseOpts {
  name?: string;
  types?: readonly number[];
  text: string;
}

const emptyValueArray: LegalValue[] = [];

function parse(opts: ParseOpts): Uint8Array<ArrayBuffer> {
  const name = opts.name ?? "";
  if (name.length > 63) {
    throw new RangeError(`Postgres statement names are at most 63 characters: "${name}" (${name.length})`);
  }
  const buffer = writer
    .addCString(name)
    .addCString(opts.text)
    .addInt16(opts.types?.length ?? 0);
  opts.types?.forEach((type) => buffer.addInt32(type));
  return writer.flush(code.parse);
}

type ValueMapper = (param: unknown, index: number) => LegalValue;

export interface BindOpts {
  portal?: string;
  binary?: boolean;
  statement?: string;
  values?: readonly LegalValue[];
  /** Optional map from a JS value to the value sent, per parameter. */
  valueMapper?: ValueMapper;
}

const paramWriter = new Writer();

const ParamType = { STRING: 0, BINARY: 1 } as const;

function writeValues(values: readonly LegalValue[], valueMapper?: ValueMapper): void {
  for (let i = 0; i < values.length; i++) {
    const value = values[i] ?? null;
    const mappedVal = valueMapper ? valueMapper(value, i) : value;
    if (mappedVal === null) {
      writer.addInt16(ParamType.STRING);
      // -1 is SQL NULL.
      paramWriter.addInt32(-1);
    } else if (mappedVal instanceof ArrayBuffer || ArrayBuffer.isView(mappedVal)) {
      const byteLength = mappedVal.byteLength;
      writer.addInt16(ParamType.BINARY);
      paramWriter.addInt32(byteLength);
      paramWriter.add(mappedVal);
    } else {
      writer.addInt16(ParamType.STRING);
      paramWriter.addInt32(byteLengthUtf8(mappedVal));
      paramWriter.addString(mappedVal);
    }
  }
}

function bind(config: BindOpts = {}): Uint8Array<ArrayBuffer> {
  const portal = config.portal ?? "";
  const statement = config.statement ?? "";
  const binary = config.binary ?? false;
  const values = config.values ?? emptyValueArray;
  const len = values.length;

  writer.addCString(portal).addCString(statement);
  writer.addInt16(len);
  writeValues(values, config.valueMapper);
  writer.addInt16(len);
  writer.add(paramWriter.flush());
  // result format code
  writer.addInt16(binary ? ParamType.BINARY : ParamType.STRING);
  return writer.flush(code.bind);
}

export interface ExecOpts {
  portal?: string;
  rows?: number;
}

const emptyExecute = new Uint8Array([code.execute, 0x00, 0x00, 0x00, 0x09, 0x00, 0x00, 0x00, 0x00, 0x00]);

function execute(config?: ExecOpts): Uint8Array<ArrayBuffer> {
  if (!config || (!config.portal && !config.rows)) {
    return emptyExecute;
  }
  const portal = config.portal ?? "";
  const rows = config.rows ?? 0;
  const portalLength = byteLengthUtf8(portal);
  const len = 4 + portalLength + 1 + 4;
  const bufferView = new DataView(new ArrayBuffer(1 + len));
  bufferView.setUint8(0, code.execute);
  bufferView.setInt32(1, len, false);
  new TextEncoder().encodeInto(portal, new Uint8Array(bufferView.buffer, 5));
  bufferView.setUint8(portalLength + 5, 0); // the portal name's terminator
  bufferView.setUint32(bufferView.byteLength - 4, rows, false);
  return new Uint8Array(bufferView.buffer);
}

function cancel(processID: number, secretKey: number): Uint8Array<ArrayBuffer> {
  const bufferView = new DataView(new ArrayBuffer(16));
  bufferView.setInt32(0, 16, false);
  bufferView.setInt16(4, 1234, false);
  bufferView.setInt16(6, 5678, false);
  bufferView.setInt32(8, processID, false);
  bufferView.setInt32(12, secretKey, false);
  return new Uint8Array(bufferView.buffer);
}

export interface PortalOpts {
  type: "S" | "P";
  name?: string;
}

function cstringMessage(messageCode: Code, string: string): Uint8Array<ArrayBuffer> {
  return new Writer().addCString(string).flush(messageCode);
}

const emptyDescribePortal = writer.addCString("P").flush(code.describe);
const emptyDescribeStatement = writer.addCString("S").flush(code.describe);

function describe(msg: PortalOpts): Uint8Array<ArrayBuffer> {
  if (msg.name) return cstringMessage(code.describe, `${msg.type}${msg.name}`);
  return msg.type === "P" ? emptyDescribePortal : emptyDescribeStatement;
}

function close(msg: PortalOpts): Uint8Array<ArrayBuffer> {
  return cstringMessage(code.close, `${msg.type}${msg.name ?? ""}`);
}

function copyData(chunk: ArrayBuffer | ArrayBufferView): Uint8Array<ArrayBuffer> {
  return writer.add(chunk).flush(code.copyFromChunk);
}

function copyFail(message: string): Uint8Array<ArrayBuffer> {
  return cstringMessage(code.copyFail, message);
}

const codeOnlyBuffer = (messageCode: Code): Uint8Array<ArrayBuffer> =>
  new Uint8Array([messageCode, 0x00, 0x00, 0x00, 0x04]);

const flushBuffer = codeOnlyBuffer(code.flush);
const syncBuffer = codeOnlyBuffer(code.sync);
const endBuffer = codeOnlyBuffer(code.end);
const copyDoneBuffer = codeOnlyBuffer(code.copyDone);

/** Frontend message builders. */
export const serialize = {
  startup,
  password,
  requestSsl,
  sendSASLInitialResponseMessage,
  sendSCRAMClientFinalMessage,
  query,
  parse,
  bind,
  execute,
  describe,
  close,
  flush: (): Uint8Array<ArrayBuffer> => flushBuffer,
  sync: (): Uint8Array<ArrayBuffer> => syncBuffer,
  end: (): Uint8Array<ArrayBuffer> => endBuffer,
  copyData,
  copyDone: (): Uint8Array<ArrayBuffer> => copyDoneBuffer,
  copyFail,
  cancel,
};
