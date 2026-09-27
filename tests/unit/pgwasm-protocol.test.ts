// Began as a copy of `@electric-sql/pglite`'s tests (taken under its PostgreSQL License option,
// © ElectricSQL — see NOTICE). Owned outright (ADR-0062); compatibility with PGlite is an anti-goal.

import { afterEach, describe, expect, it } from "bun:test";

import { DatabaseError, PgwasmClosedError } from "../../packages/pgwasm/src";
import { messages, protocol, serialize } from "../../packages/pgwasm/src/protocol";
import { closeTestPgwasms, createTestPgwasm } from "./support/pgwasm";
import { rejectionOf } from "./support/rejection";

afterEach(closeTestPgwasms);

describe("the wire, through protocol(pg)", () => {
  it("runs a simple query", async () => {
    const wire = protocol(await createTestPgwasm());
    const result = await wire.execProtocol(serialize.query("SELECT 1"));
    expect(result.messages.map((message) => message.name)).toEqual([
      "rowDescription",
      "dataRow",
      "commandComplete",
      "readyForQuery",
    ]);
    expect(result.data.length).toEqual(66);
  });

  it("runs an extended query message by message", async () => {
    const wire = protocol(await createTestPgwasm());
    const names = async (message: Uint8Array) => (await wire.execProtocol(message)).messages.map((reply) => reply.name);
    expect(await names(serialize.parse({ text: "SELECT $1" }))).toEqual(["parseComplete"]);
    expect(await names(serialize.bind({ values: ["1"] }))).toEqual(["bindComplete"]);
    expect(await names(serialize.describe({ type: "P" }))).toEqual(["rowDescription"]);
    expect(await names(serialize.execute({}))).toEqual(["dataRow", "commandComplete"]);
    expect(await names(serialize.sync())).toEqual(["readyForQuery"]);
  });

  it("returns an error in-band, or throws it", async () => {
    const wire = protocol(await createTestPgwasm());
    const result = await wire.execProtocol(serialize.query("invalid sql"), { throwOnError: false });
    expect(result.messages.map((message) => message.name)).toEqual(["error", "readyForQuery"]);
    expect(await rejectionOf(wire.execProtocol(serialize.query("invalid sql")))).toBeInstanceOf(DatabaseError);
    expect((await wire.execProtocolStream(serialize.query("SELECT 2"))).map((message) => message.name)).toContain(
      "dataRow",
    );
  });

  it("returns the raw reply", async () => {
    const wire = protocol(await createTestPgwasm());
    const raw = await wire.execProtocolRaw(serialize.query("SELECT 1"));
    expect(raw[0]).toBe(0x54); // RowDescription
    expect(raw[raw.length - 6]).toBe(0x5a); // ReadyForQuery
  });

  // Tools that drive the wire from inside a blocking wasm call (pg_dump's socket bridge) read the reply
  // back before they return: on a build that exchanges synchronously it must arrive inside the call.
  it("delivers a raw stream's bytes before the caller can await", async () => {
    const db = await createTestPgwasm();
    await db.exec("SELECT 1"); // settle any scheduled persist
    const wire = protocol(db);
    expect(wire.capabilities.synchronousExchange).toBe(true);
    let received = 0;
    const pending = wire.execProtocolRawStream(serialize.query("SELECT 1"), {
      onRawData: (bytes) => {
        received += bytes.length;
      },
    });
    expect(received).toBeGreaterThan(0);
    await pending;
  });

  it("refuses anything that is not a pgwasm instance", () => {
    expect(() => protocol({} as never)).toThrow(/Not a pgwasm instance/);
  });
});

const nextMacrotask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** A promise and the function that resolves it. */
function latch(): { readonly promise: Promise<void>; readonly open: () => void } {
  let open: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

// A tool that drives the wire through several exchanges (pg_dump) must not have a query, a transaction's
// next statement or a backup run between them.
describe("an exclusive session, through protocol(pg)", () => {
  it("holds off queries, transactions and backups until it settles", async () => {
    const pg = await createTestPgwasm();
    const wire = protocol(pg);
    await pg.exec("CREATE TABLE seen (step text)");
    const entered = latch();
    const gate = latch();
    const order: string[] = [];
    const exclusive = wire.runExclusiveSession(async () => {
      entered.open();
      await gate.promise;
      await wire.execProtocol(serialize.query("INSERT INTO seen VALUES ('exclusive')"));
      order.push("exclusive");
      return "done";
    });
    await entered.promise;
    const others = [
      pg.query("INSERT INTO seen VALUES ('query')").then(() => order.push("query")),
      pg
        .transaction(async (tx) => {
          await tx.exec("INSERT INTO seen VALUES ('transaction')");
        })
        .then(() => order.push("transaction")),
      pg.dumpDataDir().then(() => order.push("backup")),
    ];
    await nextMacrotask();
    await nextMacrotask();
    expect(order).toEqual([]);
    gate.open();
    expect(await exclusive).toBe("done");
    await Promise.all(others);
    expect(order[0]).toBe("exclusive");
    expect(order.slice(1).sort()).toEqual(["backup", "query", "transaction"]);
    expect(
      (await pg.query<{ step: string }>("SELECT step FROM seen ORDER BY step")).rows.map((row) => row.step),
    ).toEqual(["exclusive", "query", "transaction"]);
  });

  it("waits for a transaction in progress, between its statements", async () => {
    const pg = await createTestPgwasm();
    const wire = protocol(pg);
    const entered = latch();
    const gate = latch();
    const transaction = pg.transaction(async (tx) => {
      await tx.exec("CREATE TABLE inside (id int)");
      entered.open();
      await gate.promise;
      await tx.exec("INSERT INTO inside VALUES (1)");
    });
    await entered.promise;
    let status: string | undefined;
    const exclusive = wire.runExclusiveSession(async () => {
      const replies = (await wire.execProtocol(serialize.sync())).messages;
      const ready = replies.find((reply) => reply instanceof messages.ReadyForQueryMessage);
      status = ready instanceof messages.ReadyForQueryMessage ? ready.status : undefined;
    });
    await nextMacrotask();
    await nextMacrotask();
    expect(status).toBeUndefined();
    gate.open();
    await transaction;
    await exclusive;
    // It ran after the COMMIT: the session was outside any transaction block.
    expect(status).toBe("I");
  });

  it("refuses a closed database", async () => {
    const pg = await createTestPgwasm();
    const wire = protocol(pg);
    await pg.close();
    expect(await rejectionOf(wire.runExclusiveSession(async () => undefined))).toBeInstanceOf(PgwasmClosedError);
  });
});
