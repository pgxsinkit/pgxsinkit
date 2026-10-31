// Began as a copy of `@electric-sql/pg-protocol`'s tests, themselves adapted from node-postgres'
// `pg-protocol` (MIT, © Brian Carlson; ElectricSQL's changes taken under the PostgreSQL License — see
// NOTICE). Owned outright (ADR-0062); compatibility with PGlite is an anti-goal — evolve freely.

import { describe, expect, it } from "bun:test";

import { Parser, serialize } from "../../packages/pgwasm/src/protocol/wire";
import { BufferReader } from "../../packages/pgwasm/src/protocol/wire/buffer-reader";
import type {
  BackendMessage,
  DataRowMessage,
  ParameterDescriptionMessage,
} from "../../packages/pgwasm/src/protocol/wire/messages";
import { byteLengthUtf8 } from "../../packages/pgwasm/src/protocol/wire/string-utils";
import { Modes } from "../../packages/pgwasm/src/protocol/wire/types";
import { BufferList, buffers } from "./support/pg-wire-buffers";

function parseAll(chunks: Uint8Array[]): BackendMessage[] {
  const parser = new Parser();
  const messages: BackendMessage[] = [];
  for (const chunk of chunks) parser.parse(chunk, (message) => messages.push(message));
  return messages;
}

function concat(views: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(views.reduce((sum, view) => sum + view.byteLength, 0));
  let offset = 0;
  for (const view of views) {
    out.set(view, offset);
    offset += view.byteLength;
  }
  return out;
}

/** Parse one message and compare the listed properties (the rest of the message may carry more). */
function expectMessage(buffer: Uint8Array, expected: Record<string, unknown>): void {
  const [message] = parseAll([buffer]);
  for (const [key, value] of Object.entries(expected)) {
    expect((message as unknown as Record<string, unknown>)[key]).toEqual(value);
  }
}

function field(name: string, base: number) {
  return {
    name,
    tableID: base,
    columnID: base + 1,
    dataTypeID: base + 2,
    dataTypeSize: base + 3,
    dataTypeModifier: base + 4,
    format: Modes.text,
  };
}

describe("the backend message parser", () => {
  it("decodes UTF-8 at every packet split and retains strings after input reuse", () => {
    const values = [null, "", "ASCII", "你好 © 😀", '{"key":"é"}'];
    const full = buffers.dataRow(values);
    for (let split = 1; split < full.byteLength; split++) {
      const first = full.slice(0, split);
      const second = full.slice(split);
      const [message] = parseAll([first, second]) as DataRowMessage[];
      first.fill(0);
      second.fill(0);
      expect(message?.fields).toEqual(values);
    }
  });

  it("parses authentication messages", () => {
    expectMessage(buffers.authenticationOk(), { name: "authenticationOk", length: 8 });
    expectMessage(buffers.authenticationCleartextPassword(), { name: "authenticationCleartextPassword", length: 8 });
    expectMessage(buffers.authenticationMD5Password(), {
      name: "authenticationMD5Password",
      length: 12,
      salt: new Uint8Array([1, 2, 3, 4]),
    });
    const sasl = buffers.authenticationSASL();
    expectMessage(sasl, { name: "authenticationSASL", length: sasl.byteLength - 1, mechanisms: ["SCRAM-SHA-256"] });
    const saslContinue = buffers.authenticationSASLContinue();
    expectMessage(saslContinue, {
      name: "authenticationSASLContinue",
      length: saslContinue.byteLength - 1,
      data: "data",
    });
    const saslFinal = buffers.authenticationSASLFinal();
    expectMessage(saslFinal, { name: "authenticationSASLFinal", length: saslFinal.byteLength - 1, data: "data" });
  });

  // node-postgres#2210: trailing bytes after a SASL message must not leak into its data.
  it("reads SASL data only up to the message's own length", () => {
    const saslContinue = buffers.authenticationSASLContinue();
    expectMessage(concat([saslContinue, new Uint8Array([1, 2, 3, 4])]), {
      name: "authenticationSASLContinue",
      data: "data",
    });
    const saslFinal = buffers.authenticationSASLFinal();
    expectMessage(concat([saslFinal, new Uint8Array([1, 2, 4, 5])]), { name: "authenticationSASLFinal", data: "data" });
  });

  it("parses status, key data, ready and command-complete messages", () => {
    expectMessage(buffers.parameterStatus("client_encoding", "UTF8"), {
      name: "parameterStatus",
      parameterName: "client_encoding",
      parameterValue: "UTF8",
      length: 25,
    });
    expectMessage(buffers.backendKeyData(1, 2), { name: "backendKeyData", processID: 1, secretKey: 2, length: 12 });
    expectMessage(buffers.readyForQuery(), { name: "readyForQuery", length: 5, status: "I" });
    expectMessage(buffers.commandComplete("SELECT 3"), { name: "commandComplete", length: 13, text: "SELECT 3" });
    const notification = buffers.notification(4, "hi", "boom");
    expectMessage(notification, {
      name: "notification",
      processId: 4,
      channel: "hi",
      payload: "boom",
      length: notification.byteLength - 1,
    });
    expectMessage(buffers.emptyQuery(), { name: "emptyQuery", length: 4 });
    expectMessage(new Uint8Array([0x6e, 0, 0, 0, 4]), { name: "noData", length: 5 });
    expectMessage(buffers.parseComplete(), { name: "parseComplete", length: 5 });
    expectMessage(buffers.bindComplete(), { name: "bindComplete", length: 5 });
    expectMessage(buffers.closeComplete(), { name: "closeComplete", length: 5 });
    expectMessage(buffers.portalSuspended(), { name: "portalSuspended", length: 5 });
    expectMessage(new Uint8Array([0x57, 0x00, 0x00, 0x00, 0x04]), { name: "replicationStart", length: 4 });
  });

  it("parses row descriptions", () => {
    expectMessage(new BufferList().addInt16(0).join(true, "T"), {
      name: "rowDescription",
      length: 6,
      fieldCount: 0,
      fields: [],
    });
    expectMessage(buffers.rowDescription([field("id", 1)]), {
      name: "rowDescription",
      length: 27,
      fieldCount: 1,
      fields: [field("id", 1)],
    });
    expectMessage(buffers.rowDescription([field("bang", 1), field("whoah", 10)]), {
      name: "rowDescription",
      length: 53,
      fieldCount: 2,
      fields: [field("bang", 1), field("whoah", 10)],
    });
  });

  it("parses parameter descriptions", () => {
    expectMessage(new BufferList().addInt16(0).join(true, "t"), {
      name: "parameterDescription",
      length: 6,
      parameterCount: 0,
      dataTypeIDs: [],
    });
    expectMessage(buffers.parameterDescription([1111]), {
      name: "parameterDescription",
      length: 10,
      parameterCount: 1,
      dataTypeIDs: [1111],
    });
    expectMessage(buffers.parameterDescription([2222, 3333]), {
      name: "parameterDescription",
      length: 14,
      parameterCount: 2,
      dataTypeIDs: [2222, 3333],
    });
  });

  for (const count of [32_767, 32_768, 65_535]) {
    it(`preserves all ${count} parameter type OIDs`, () => {
      const packet = new Uint8Array(7 + 4 * count);
      const view = new DataView(packet.buffer);
      packet[0] = 0x74;
      view.setUint32(1, packet.byteLength - 1, false);
      view.setUint16(5, count, false);
      for (let index = 0; index < count; index++) view.setInt32(7 + 4 * index, 23 + index, false);

      const [description, ready] = parseAll([concat([packet, buffers.readyForQuery()])]);
      const parameters = description as ParameterDescriptionMessage;
      expect(parameters.name).toBe("parameterDescription");
      expect(parameters.parameterCount).toBe(count);
      expect(parameters.dataTypeIDs.length).toBe(count);
      expect(parameters.dataTypeIDs[0]).toBe(23);
      expect(parameters.dataTypeIDs.at(-1)).toBe(23 + count - 1);
      expect(ready?.name).toBe("readyForQuery");
    });
  }

  it("retains signed variable-length type sizes and modifiers", () => {
    const textField = { ...field("value", 0), dataTypeID: 25, dataTypeSize: -1, dataTypeModifier: -1 };
    expectMessage(buffers.rowDescription([textField]), { fields: [textField] });
  });

  it("parses data rows", () => {
    const empty = buffers.dataRow([]);
    expectMessage(empty, { name: "dataRow", fieldCount: 0, length: empty.byteLength - 1 });
    const one = buffers.dataRow(["test"]);
    expectMessage(one, { name: "dataRow", fieldCount: 1, fields: ["test"], length: one.byteLength - 1 });
  });

  it("recovers after a malformed data row throws", () => {
    const malformedDataRow = new Uint8Array(11);
    const view = new DataView(malformedDataRow.buffer);
    malformedDataRow[0] = 0x44;
    view.setUint32(1, 10, false);
    view.setInt16(5, 2, false);
    view.setInt32(7, 0x40000000, false);

    const parser = new Parser();
    expect(() => parser.parse(malformedDataRow, () => undefined)).toThrow(RangeError);

    const messages: BackendMessage[] = [];
    parser.parse(buffers.readyForQuery(), (message) => messages.push(message));
    expect(messages).toEqual([{ name: "readyForQuery", length: 5, status: "I" } as BackendMessage]);
  });

  it("parses notices and errors with all their fields", () => {
    const notice = buffers.notice([{ type: "C", value: "code" }]);
    expectMessage(notice, { name: "notice", code: "code", length: notice.byteLength - 1 });
    const emptyError = buffers.error([]);
    expectMessage(emptyError, { name: "error", length: emptyError.byteLength - 1 });
    const full = buffers.error([
      { type: "S", value: "ERROR" },
      { type: "C", value: "code" },
      { type: "M", value: "message" },
      { type: "D", value: "details" },
      { type: "H", value: "hint" },
      { type: "P", value: "100" },
      { type: "p", value: "101" },
      { type: "q", value: "query" },
      { type: "W", value: "where" },
      { type: "F", value: "file" },
      { type: "L", value: "line" },
      { type: "R", value: "routine" },
      { type: "Z", value: "alsdkf" }, // ignored
    ]);
    expectMessage(full, {
      name: "error",
      severity: "ERROR",
      code: "code",
      message: "message",
      detail: "details",
      hint: "hint",
      position: "100",
      internalPosition: "101",
      internalQuery: "query",
      where: "where",
      file: "file",
      line: "line",
      routine: "routine",
      length: full.byteLength - 1,
    });
  });

  it("parses copy messages", () => {
    expectMessage(buffers.copyIn(0), { name: "copyInResponse", length: 7, binary: false, columnTypes: [] });
    expectMessage(buffers.copyIn(2), { name: "copyInResponse", length: 11, binary: false, columnTypes: [0, 1] });
    expectMessage(buffers.copyOut(0), { name: "copyOutResponse", length: 7, binary: false, columnTypes: [] });
    expectMessage(buffers.copyOut(3), { name: "copyOutResponse", length: 13, binary: false, columnTypes: [0, 1, 2] });
    expectMessage(buffers.copyDone(), { name: "copyDone", length: 4 });
    expectMessage(buffers.copyData(new Uint8Array([5, 6, 7])), {
      name: "copyData",
      length: 7,
      chunk: new Uint8Array([5, 6, 7]),
    });
  });

  // A stream may split a message anywhere, so every split of one message must parse the same.
  it("parses one message split at every byte", () => {
    const full = buffers.dataRow([null, "bang", "zug zug", null, "!"]);
    for (let split = 1; split < full.byteLength; split++) {
      const [message] = parseAll([full.slice(0, split), full.slice(split)]) as DataRowMessage[];
      expect(message?.fields).toEqual([null, "bang", "zug zug", null, "!"]);
    }
  });

  it("parses two messages split at every byte", () => {
    const full = concat([buffers.dataRow(["!"]), buffers.readyForQuery()]);
    for (let split = 1; split < full.byteLength; split++) {
      const messages = parseAll([full.slice(0, split), full.slice(split)]);
      expect(messages).toEqual([
        { name: "dataRow", fieldCount: 1, length: 11, fields: ["!"] } as BackendMessage,
        { name: "readyForQuery", length: 5, status: "I" } as BackendMessage,
      ]);
    }
  });

  it("reads only the section of a buffer a view covers", () => {
    const message = buffers.dataRow(["bang"]);
    const larger = concat([new Uint8Array([1, 2, 3, 4]), message, new Uint8Array([5, 6, 7, 8])]);
    const messages = parseAll([new Uint8Array(larger.buffer, 4, message.byteLength)]);
    expect(messages).toEqual([
      { name: "dataRow", fieldCount: 1, length: message.byteLength - 1, fields: ["bang"] } as BackendMessage,
    ]);
  });
});

describe("the frontend message serializer", () => {
  it("writes replacement-encoded surrogate bytes without corrupting following bind values", () => {
    const values = ["\u0800\udc00", "tail", "©\udc00", "\udc00\udc00", "\ud800\udc00", "\ud800", "last"];
    const expected = new BufferList().addCString("").addCString("").addInt16(values.length);
    for (let i = 0; i < values.length; i++) expected.addInt16(0);
    expected.addInt16(values.length);
    const encoder = new TextEncoder();
    for (const value of values) {
      const bytes = encoder.encode(value);
      expected.addInt32(bytes.length).add(bytes);
    }
    expected.addInt16(0);

    expect(serialize.bind({ values })).toEqual(expected.join(true, "B"));
  });

  it("builds startup, password and ssl-request messages", () => {
    expect(serialize.startup({ user: "brian", database: "bang" })).toEqual(
      new BufferList()
        .addInt16(3)
        .addInt16(0)
        .addCString("user")
        .addCString("brian")
        .addCString("database")
        .addCString("bang")
        .addCString("client_encoding")
        .addCString("UTF8")
        .addCString("")
        .join(true),
    );
    expect(serialize.password("!")).toEqual(new BufferList().addCString("!").join(true, "p"));
    expect(serialize.requestSsl()).toEqual(new BufferList().addInt32(80877103).join(true));
  });

  it("builds SASL messages", () => {
    expect(serialize.sendSASLInitialResponseMessage("mech", "data")).toEqual(
      new BufferList().addCString("mech").addInt32(4).addString("data").join(true, "p"),
    );
    expect(serialize.sendSCRAMClientFinalMessage("data")).toEqual(new BufferList().addString("data").join(true, "p"));
  });

  it("builds a query message", () => {
    const txt = "select * from boom";
    expect(serialize.query(txt)).toEqual(new BufferList().addCString(txt).join(true, "Q"));
  });

  it("builds parse messages", () => {
    expect(serialize.parse({ text: "!" })).toEqual(
      new BufferList().addCString("").addCString("!").addInt16(0).join(true, "P"),
    );
    expect(serialize.parse({ name: "boom", text: "select * from boom", types: [] })).toEqual(
      new BufferList().addCString("boom").addCString("select * from boom").addInt16(0).join(true, "P"),
    );
    expect(serialize.parse({ name: "force", text: "select * from bang where name = $1", types: [1, 2, 3, 4] })).toEqual(
      new BufferList()
        .addCString("force")
        .addCString("select * from bang where name = $1")
        .addInt16(4)
        .addInt32(1)
        .addInt32(2)
        .addInt32(3)
        .addInt32(4)
        .join(true, "P"),
    );
  });

  it("refuses a statement name Postgres would truncate", () => {
    expect(() => serialize.parse({ name: "x".repeat(64), text: "select 1" })).toThrow(RangeError);
  });

  it("rejects too many parameter type OIDs before writing a parse message", () => {
    expect(() => serialize.parse({ text: "SELECT 1", types: Array<number>(65_536).fill(23) })).toThrow(
      /at most 65535 parameters/,
    );
    expect(serialize.parse({ text: "SELECT 1", types: [23] })).toEqual(
      new BufferList().addCString("").addCString("SELECT 1").addInt16(1).addInt32(23).join(true, "P"),
    );
  });

  it("builds bind messages", () => {
    expect(serialize.bind()).toEqual(
      new BufferList().addCString("").addCString("").addInt16(0).addInt16(0).addInt16(0).join(true, "B"),
    );
    expect(serialize.bind({ portal: "bang", statement: "woo", values: ["1", "hi", null, "zing"] })).toEqual(
      new BufferList()
        .addCString("bang")
        .addCString("woo")
        .addInt16(4)
        .addInt16(0)
        .addInt16(0)
        .addInt16(0)
        .addInt16(0)
        .addInt16(4)
        .addInt32(1)
        .add(new TextEncoder().encode("1"))
        .addInt32(2)
        .add(new TextEncoder().encode("hi"))
        .addInt32(-1)
        .addInt32(4)
        .add(new TextEncoder().encode("zing"))
        .addInt16(0)
        .join(true, "B"),
    );
  });

  for (const count of [32_767, 32_768, 65_535]) {
    it(`encodes ${count} parse parameter type OIDs`, () => {
      const packet = serialize.parse({ text: "", types: Array<number>(count).fill(23) });
      const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
      expect(view.getUint32(1, false)).toBe(packet.byteLength - 1);
      expect(view.getUint16(7, false)).toBe(count);
      expect(view.getInt32(9 + 4 * (count - 1), false)).toBe(23);
    });

    it(`encodes ${count} bind parameter formats and values`, () => {
      const packet = serialize.bind({ values: Array<null>(count).fill(null) });
      const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
      expect(packet[0]).toBe(0x42);
      expect(view.getUint32(1, false)).toBe(packet.byteLength - 1);
      expect(view.getUint16(7, false)).toBe(count);
      expect(view.getUint16(9 + 2 * count, false)).toBe(count);
      expect(view.getInt32(11 + 2 * count, false)).toBe(-1);
      expect(view.getInt32(11 + 2 * count + 4 * (count - 1), false)).toBe(-1);
      expect(view.getUint16(packet.byteLength - 2, false)).toBe(0);
    });
  }

  it("rejects too many bind parameters before writing either message buffer", () => {
    expect(() => serialize.bind({ values: Array<null>(65_536).fill(null) })).toThrow(/at most 65535 parameters/);
    expect(serialize.bind()).toEqual(
      new BufferList().addCString("").addCString("").addInt16(0).addInt16(0).addInt16(0).join(true, "B"),
    );
  });

  it("applies a value mapper to every bind value", () => {
    expect(
      serialize.bind({ portal: "bang", statement: "woo", values: ["1", "hi", null, "zing"], valueMapper: () => null }),
    ).toEqual(
      new BufferList()
        .addCString("bang")
        .addCString("woo")
        .addInt16(4)
        .addInt16(0)
        .addInt16(0)
        .addInt16(0)
        .addInt16(0)
        .addInt16(4)
        .addInt32(-1)
        .addInt32(-1)
        .addInt32(-1)
        .addInt32(-1)
        .addInt16(0)
        .join(true, "B"),
    );
  });

  it("sends a byte value as binary", () => {
    expect(
      serialize.bind({ portal: "bang", statement: "woo", values: ["1", "hi", null, new TextEncoder().encode("zing")] }),
    ).toEqual(
      new BufferList()
        .addCString("bang")
        .addCString("woo")
        .addInt16(4)
        .addInt16(0)
        .addInt16(0)
        .addInt16(0)
        .addInt16(1)
        .addInt16(4)
        .addInt32(1)
        .add(new TextEncoder().encode("1"))
        .addInt32(2)
        .add(new TextEncoder().encode("hi"))
        .addInt32(-1)
        .addInt32(4)
        .add(new TextEncoder().encode("zing"))
        .addInt16(0)
        .join(true, "B"),
    );
  });

  it("builds execute messages", () => {
    expect(serialize.execute()).toEqual(new BufferList().addCString("").addInt32(0).join(true, "E"));
    expect(serialize.execute({ portal: "my favorite portal", rows: 100 })).toEqual(
      new BufferList().addCString("my favorite portal").addInt32(100).join(true, "E"),
    );
  });

  it("builds flush, sync and end", () => {
    expect(serialize.flush()).toEqual(new BufferList().join(true, "H"));
    expect(serialize.sync()).toEqual(new BufferList().join(true, "S"));
    expect(serialize.end()).toEqual(new Uint8Array([0x58, 0, 0, 0, 4]));
  });

  it("builds describe and close messages", () => {
    expect(serialize.describe({ type: "S", name: "bang" })).toEqual(
      new BufferList().addChar("S").addCString("bang").join(true, "D"),
    );
    expect(serialize.describe({ type: "P" })).toEqual(new BufferList().addChar("P").addCString("").join(true, "D"));
    expect(serialize.close({ type: "S", name: "bang" })).toEqual(
      new BufferList().addChar("S").addCString("bang").join(true, "C"),
    );
    expect(serialize.close({ type: "P" })).toEqual(new BufferList().addChar("P").addCString("").join(true, "C"));
  });

  it("builds copy messages", () => {
    expect(serialize.copyData(new Uint8Array([1, 2, 3]))).toEqual(
      new BufferList().add(new Uint8Array([1, 2, 3])).join(true, "d"),
    );
    expect(serialize.copyFail("err!")).toEqual(new BufferList().addCString("err!").join(true, "f"));
    expect(serialize.copyDone()).toEqual(new BufferList().join(true, "c"));
  });

  it("builds a cancel message", () => {
    expect(serialize.cancel(3, 4)).toEqual(
      new BufferList().addInt16(1234).addInt16(5678).addInt32(3).addInt32(4).join(true),
    );
  });
});

describe("byteLengthUtf8", () => {
  it("matches TextEncoder for short combinations across UTF-16 boundaries", () => {
    const units = [0x61, 0x7f, 0x80, 0x7ff, 0x800, 0xd7ff, 0xd800, 0xdbff, 0xdc00, 0xdfff, 0xe000, 0xffff].map((code) =>
      String.fromCharCode(code),
    );
    const encoder = new TextEncoder();
    for (const first of units) {
      expect(byteLengthUtf8(first)).toBe(encoder.encode(first).length);
      for (const second of units) {
        expect(byteLengthUtf8(first + second)).toBe(encoder.encode(first + second).length);
        for (const third of units) {
          expect(byteLengthUtf8(first + second + third)).toBe(encoder.encode(first + second + third).length);
        }
      }
    }
  });

  it("counts UTF-8 bytes across ASCII, the BMP, surrogate pairs and emoji", () => {
    expect(byteLengthUtf8("")).toBe(0);
    expect(byteLengthUtf8("hello")).toBe(5);
    expect(byteLengthUtf8("©")).toBe(2);
    expect(byteLengthUtf8("你好")).toBe(6);
    expect(byteLengthUtf8("𝄞")).toBe(4);
    expect(byteLengthUtf8("hello 你好 𝄞")).toBe(17);
    expect(byteLengthUtf8("😀")).toBe(4);
    expect(byteLengthUtf8("The quick brown 🦊 jumps over 13 lazy 🐶! 你好世界")).toBe(58);
  });
});

describe("BufferReader string ownership and ranges", () => {
  it("decodes bounded strings and cstrings without exposing borrowed bytes", () => {
    const source = new Uint8Array([99, 0xe4, 0xbd, 0xa0, 0, 0xff, 0, 8, 9]);
    const reader = new BufferReader();
    reader.setBuffer(1, source.buffer);
    const text = reader.cstring();
    const replacement = reader.cstring();
    const owned = reader.bytes(2);
    source.fill(0);
    expect(text).toBe("你");
    expect(replacement).toBe("�");
    expect(owned).toEqual(new Uint8Array([8, 9]));
  });

  it("keeps slice range behavior and offset advancement for malformed string reads", () => {
    const source = new TextEncoder().encode("abcdef");
    const decoder = new TextDecoder();
    const ranges: Array<[number, number]> = [
      [2, 100],
      [2, -1],
      [-2, 1],
      [1.5, 2.5],
      [0, NaN],
      [0, Infinity],
    ];
    for (const [offset, length] of ranges) {
      const reader = new BufferReader();
      reader.setBuffer(offset, source.buffer);
      expect(reader.string(length)).toBe(decoder.decode(source.buffer.slice(offset, offset + length)));
      const nextOffset = offset + length;
      expect(reader.string(1)).toBe(decoder.decode(source.buffer.slice(nextOffset, nextOffset + 1)));
    }
  });
});
