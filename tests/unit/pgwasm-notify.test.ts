// Began as a copy of `@electric-sql/pglite`'s tests (taken under its PostgreSQL License option,
// © ElectricSQL — see NOTICE). Owned outright (ADR-0062); compatibility with PGlite is an anti-goal.

import { afterEach, describe, expect, it } from "bun:test";

import { cBuild } from "../../packages/pgwasm-c/src";
import type { Pgwasm } from "../../packages/pgwasm/src";
import { closeTestPgwasms, createTestPgwasm } from "./support/pgwasm";
import { outOfBandNotifyBuild } from "./support/pgwasm-build-decorators";
import { rejectionOf } from "./support/rejection";

afterEach(closeTestPgwasms);

/** Wait until `predicate` holds, polling every few milliseconds, up to two seconds. */
async function eventually(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition not reached within 2s");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Let queued notification callbacks run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

function counter(): { calls: string[]; callback: (payload: string) => void } {
  const calls: string[] = [];
  return { calls, callback: (payload) => calls.push(payload) };
}

for (const [label, build] of [
  ["in-band", cBuild],
  ["delivered between exchanges", outOfBandNotifyBuild(cBuild)],
] as const) {
  describe(`LISTEN/NOTIFY, notifications ${label}`, () => {
    let pg: Pgwasm;

    it("delivers a payload to a listener", async () => {
      pg = await createTestPgwasm({ build });
      const listener = counter();
      await pg.listen("test", listener.callback);
      await pg.exec("NOTIFY test, '321'");
      await eventually(() => listener.calls.length === 1);
      expect(listener.calls).toEqual(["321"]);
    });

    it("stops delivering after unlisten", async () => {
      pg = await createTestPgwasm({ build });
      const listener = counter();
      const unlisten = await pg.listen("test", listener.callback);
      await unlisten();
      await pg.exec("NOTIFY test");
      await settle();
      expect(listener.calls).toEqual([]);
    });

    it("delivers every channel to onNotification, until unsubscribed", async () => {
      pg = await createTestPgwasm({ build });
      const seen: [string, string][] = [];
      const unsubscribe = pg.onNotification((channel, payload) => seen.push([channel, payload]));
      await pg.exec("LISTEN test");
      await pg.exec("NOTIFY test, '123'");
      await eventually(() => seen.length === 1);
      unsubscribe();
      await pg.exec("NOTIFY test, '456'");
      await settle();
      expect(seen).toEqual([["test", "123"]]);
    });

    it("names channels as Postgres does: unquoted folds to lower case, quoted keeps it", async () => {
      pg = await createTestPgwasm({ build });
      const allLower1 = counter();
      await pg.listen("postgresdefaultlower", allLower1.callback);
      await pg.exec(`NOTIFY postgresdefaultlower, 'payload1'`);
      const autoLower1 = counter();
      await pg.listen("PostgresDefaultLower", autoLower1.callback);
      await pg.exec(`NOTIFY PostgresDefaultLower, 'payload1'`);
      const autoLower2 = counter();
      await pg.listen("PostgresDefaultLower", autoLower2.callback);
      await pg.exec(`NOTIFY postgresdefaultlower, 'payload1'`);
      const autoLower3 = counter();
      await pg.listen("postgresdefaultlower", autoLower3.callback);
      await pg.exec(`NOTIFY PostgresDefaultLower, 'payload1'`);
      const caseSensitive1 = counter();
      await pg.listen('"tesT2"', caseSensitive1.callback);
      await pg.exec(`NOTIFY "tesT2", 'paYloAd2'`);
      const caseSensitive2 = counter();
      await pg.listen('"tesT3"', caseSensitive2.callback);
      await pg.exec(`NOTIFY tesT3, 'paYloAd2'`);
      const caseSensitive3 = counter();
      await pg.listen("testNotCalled2", caseSensitive3.callback);
      await pg.exec(`NOTIFY "testNotCalled2", 'paYloAd2'`);
      const quotedWithSpaces = counter();
      await pg.listen('"Quoted Channel With Spaces"', quotedWithSpaces.callback);
      await pg.exec(`NOTIFY "Quoted Channel With Spaces", 'payload1'`);
      const unquotedWithSpaces = counter();
      await rejectionOf(pg.listen("Unquoted Channel With Spaces", unquotedWithSpaces.callback));
      await rejectionOf(pg.exec(`NOTIFY Unquoted Channel With Spaces, 'payload1'`));
      const otherCharsWithQuotes = counter();
      await pg.listen('"test&me"', otherCharsWithQuotes.callback);
      await pg.exec(`NOTIFY "test&me", 'paYloAd2'`);
      const otherChars = counter();
      await rejectionOf(pg.listen("test&me", otherChars.callback));
      await rejectionOf(pg.exec(`NOTIFY test&me, 'payload1'`));

      await eventually(() => allLower1.calls.length === 4);
      await settle();
      expect(allLower1.calls.length).toBe(4);
      expect(autoLower1.calls.length).toBe(3);
      expect(autoLower2.calls.length).toBe(2);
      expect(autoLower3.calls.length).toBe(1);
      expect(caseSensitive1.calls.length).toBe(1);
      expect(caseSensitive2.calls.length).toBe(0);
      expect(caseSensitive3.calls.length).toBe(0);
      expect(otherCharsWithQuotes.calls.length).toBe(1);
      expect(quotedWithSpaces.calls.length).toBe(1);
      expect(unquotedWithSpaces.calls.length).toBe(0);
    });

    it("unlistens by the name Postgres stores", async () => {
      pg = await createTestPgwasm({ build });
      const counts: number[] = [];
      for (const [listenAs, notifyAs] of [
        ["postgresdefaultlower", "postgresdefaultlower"],
        ["PostgresDefaultLower", "PostgresDefaultLower"],
        ["PostgresDefaultLower", "postgresdefaultlower"],
        ["postgresdefaultlower", "PostgresDefaultLower"],
      ] as const) {
        const listener = counter();
        const unlisten = await pg.listen(listenAs, listener.callback);
        await pg.exec(`NOTIFY ${notifyAs}, 'payload1'`);
        await eventually(() => listener.calls.length === 1);
        await unlisten();
        counts.push(listener.calls.length);
      }
      for (const channel of ['"CaSESEnsiTIvE"', '"Quoted Channel With Spaces"', '"test&me"']) {
        const listener = counter();
        await pg.listen(channel, listener.callback);
        await pg.exec(`NOTIFY ${channel}, 'payload1'`);
        await eventually(() => listener.calls.length === 1);
        await pg.unlisten(channel);
        await pg.exec(`NOTIFY ${channel}, 'payload1'`);
        await settle();
        counts.push(listener.calls.length);
      }
      expect(counts).toEqual([1, 1, 1, 1, 1, 1, 1]);
    });

    it("unsubscribes a quoted mixed-case channel through the function listen returned", async () => {
      pg = await createTestPgwasm({ build });
      const counts: number[] = [];
      for (const channel of ['"CaSESEnsiTIvE"', '"Quoted Channel With Spaces"', "MixedUnquoted"]) {
        const listener = counter();
        const unsubscribe = await pg.listen(channel, listener.callback);
        await pg.exec(`NOTIFY ${channel}, 'payload1'`);
        await eventually(() => listener.calls.length === 1);
        await unsubscribe();
        await pg.exec(`NOTIFY ${channel}, 'payload2'`);
        await settle();
        counts.push(listener.calls.length);
      }
      expect(counts).toEqual([1, 1, 1]);
      // UNLISTEN reached Postgres too: nothing is left listening.
      expect((await pg.query("SELECT pg_listening_channels() AS channel")).rows).toEqual([]);
    });
  });
}

describe("LISTEN from a transaction beside a top-level LISTEN", () => {
  it("takes the locks in one order, so neither waits on the other forever", async () => {
    const pg = await createTestPgwasm();
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    let entered!: () => void;
    const inTransaction = new Promise<void>((resolve) => {
      entered = resolve;
    });
    // The shape of a live query's init: tx.listen() inside a transaction.
    const transaction = pg.transaction(async (tx) => {
      entered();
      await gate;
      await tx.listen("from_transaction", () => undefined);
    });
    await inTransaction;
    // A top-level listen arrives while the transaction holds its lock, and gets as far as it can.
    const topLevel = pg.listen("top_level", () => undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));
    openGate();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadlocked = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("listen deadlocked against the transaction's listen")), 2000);
    });
    try {
      await Promise.race([Promise.all([transaction, topLevel]), deadlocked]);
    } finally {
      clearTimeout(timer);
    }
    expect((await pg.query<{ channel: string }>("SELECT pg_listening_channels() AS channel ORDER BY 1")).rows).toEqual([
      { channel: "from_transaction" },
      { channel: "top_level" },
    ]);
  });
});
