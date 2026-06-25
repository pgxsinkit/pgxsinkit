/* oxlint-disable -- engine behaviour test: drives client/src/sync through a process-global
 * MultiShapeStream mock + a monkeypatched pg.transaction; the value is runtime behaviour. */
// @ts-nocheck -- mocking @electric-sql/experimental (process-global) + `new` on a mock + a
// transaction monkeypatch defeats strict typing; this is a runtime oracle for ADR-0009 Phase 2.
/**
 * ADR-0009 Phase 2 — serialized single-flight commit queue + commit-error surfacing.
 *
 * Forces commit outcomes against a real PGlite (by replacing `pg.transaction`) to prove the four
 * properties the upstream fire-and-forget loop could not: single-flight (no overlapping
 * transactions), coalescing, retry-then-recover, and exhaustion → degraded (`isUpToDate` stays
 * false, frontier held) + `onSyncError`. Runs in its own `bun test` invocation because
 * `mock.module` is process-global (see package.json `test:unit`).
 */
import { beforeEach, describe, expect, it, mock } from "bun:test";

import { createFreshTestPGlite } from "../support/pglite";

let capturedCb = null;

const MockMultiShapeStream = mock(() => ({
  subscribe: (cb) => {
    capturedCb = cb;
  },
  unsubscribeAll: mock(),
  isUpToDate: true,
  shapes: { shape: { subscribe: mock(), unsubscribeAll: mock() } },
}));
await mock.module("@electric-sql/experimental", () => ({ MultiShapeStream: MockMultiShapeStream }));

const { electricSync } = await import("../../packages/client/src/sync/index");

const upToDate = (lsn) => ({
  shape: "shape",
  headers: { control: "up-to-date", global_last_seen_lsn: String(lsn) },
});
const insertMsg = (lsn, value) => ({
  headers: { operation: "insert", lsn: String(lsn) },
  key: `id${value.id}`,
  value,
  shape: "shape",
});

async function waitUntil(predicate, timeout = 10_000) {
  const start = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (Date.now() - start > timeout) throw new Error("waitUntil: timed out");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("sync commit queue (ADR-0009 Phase 2)", () => {
  let pg;

  beforeEach(async () => {
    capturedCb = null;
    // Prepopulated FS skips the ~1.5s WASM initdb each test.
    pg = await createFreshTestPGlite({ extensions: { electric: electricSync({ debug: false }) } });
    await pg.exec(`CREATE TABLE IF NOT EXISTS todo (id INTEGER PRIMARY KEY, task TEXT); TRUNCATE todo;`);
  });

  async function startSync(opts = {}) {
    const shape = await pg.electric.syncShapeToTable({
      shape: { url: "http://localhost:3000/v1/shape", params: { table: "todo" } },
      table: "todo",
      primaryKey: ["id"],
      shapeKey: null,
      commitRetryDelayMs: () => 0, // immediate retry — don't sleep the real jittered backoff in tests
      ...opts,
    });
    if (!capturedCb) throw new Error("subscribe callback was not captured");
    return shape;
  }

  const count = async () => (await pg.sql`SELECT COUNT(*)::int AS c FROM todo;`).rows[0].c;

  it("retries a failed commit with backoff, then recovers (never degraded)", async () => {
    const onSyncError = mock();
    const shape = await startSync({ onSyncError, maxCommitRetries: 5 });

    const realTransaction = pg.transaction.bind(pg);
    let calls = 0;
    pg.transaction = (fn) => {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error("transient")) : realTransaction(fn);
    };

    await capturedCb([insertMsg(1, { id: 1, task: "a" }), upToDate(1)]);

    expect(await count()).toBe(1); // applied on the retry
    expect(onSyncError).not.toHaveBeenCalled();
    expect(shape.isUpToDate).toBe(true);
    await shape.unsubscribe();
  });

  it("goes degraded + fires onSyncError when a commit exhausts its retries", async () => {
    const onSyncError = mock();
    const shape = await startSync({ onSyncError, maxCommitRetries: 2 });

    pg.transaction = () => Promise.reject(new Error("permanent"));

    await capturedCb([insertMsg(1, { id: 1, task: "a" }), upToDate(1)]);

    expect(onSyncError).toHaveBeenCalledTimes(1);
    expect(shape.isUpToDate).toBe(false); // never up-to-date on an unapplied commit
    expect(await count()).toBe(0); // frontier held — nothing applied
    await shape.unsubscribe();
  });

  it("runs at most one commit transaction at a time (single-flight)", async () => {
    const shape = await startSync();

    const realTransaction = pg.transaction.bind(pg);
    let active = 0;
    let maxActive = 0;
    pg.transaction = (fn) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      return realTransaction(fn).finally(() => {
        active -= 1;
      });
    };

    for (let i = 1; i <= 4; i++) {
      void capturedCb([insertMsg(i, { id: i, task: `t${i}` }), upToDate(i)]);
    }

    await waitUntil(async () => (await count()) === 4);
    expect(maxActive).toBe(1);
    await shape.unsubscribe();
  });

  it("coalesces batches buffered during a commit into fewer transactions than batches", async () => {
    const shape = await startSync();

    const realTransaction = pg.transaction.bind(pg);
    let transactionCount = 0;
    pg.transaction = (fn) => {
      transactionCount += 1;
      return realTransaction(fn);
    };

    for (let i = 1; i <= 4; i++) {
      void capturedCb([insertMsg(i, { id: i, task: `t${i}` }), upToDate(i)]);
    }

    await waitUntil(async () => (await count()) === 4);
    expect(transactionCount).toBeGreaterThanOrEqual(1);
    expect(transactionCount).toBeLessThan(4); // coalesced, not one-per-batch
    await shape.unsubscribe();
  });
});
