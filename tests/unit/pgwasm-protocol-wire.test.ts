// Began as a copy of `@electric-sql/pg-protocol`'s tests, themselves adapted from node-postgres'
// `pg-protocol` (MIT, © Brian Carlson; ElectricSQL's changes taken under the PostgreSQL License — see
// NOTICE). Owned outright (ADR-0062); compatibility with PGlite is an anti-goal — evolve freely.

import { describe, expect, it } from "bun:test";

import { Parser, serialize } from "../../packages/pgwasm/src/protocol/wire";
import type { BackendMessage, DataRowMessage } from "../../packages/pgwasm/src/protocol/wire/messages";
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
