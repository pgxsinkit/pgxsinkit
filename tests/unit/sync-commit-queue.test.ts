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

import type { PGlite, Transaction } from "@electric-sql/pglite";
import { count as countAgg } from "drizzle-orm";
import { integer, text } from "drizzle-orm/pg-core";

import { defineSyncRegistry, defineSyncTable } from "@pgxsinkit/contracts";

// These Electric types resolve through the engine's own type surface (re-exported there), so this
// root-level test needs no direct dependency on the Electric client packages.
import type { MultiShapeMessages, Row, ShapeStreamOptions } from "../../packages/client/src/sync/types";
import { createTablesFromSchema, drizzleOver } from "../support/drizzle";
import { createFreshTestPGlite } from "../support/pglite";

// Small REAL registry (ADR-0029 D1) — the engine resolves the `todo` apply target from `(registry, "todo")`.
const registry = defineSyncRegistry({
  todo: defineSyncTable({
    tableName: "todo",
    makeColumns: () => ({ id: integer("id").primaryKey(), task: text("task") }),
  }),
});

type MultiShapeMessage = MultiShapeMessages<Record<string, Row<unknown>>>;
type SubscribeCallback = (messages: MultiShapeMessage[]) => Promise<void>;

let capturedCb: SubscribeCallback | null = null;

const MockMultiShapeStream = mock((_initOpts?: ShapeStreamOptions) => ({
  subscribe: (cb: SubscribeCallback) => {
    capturedCb = cb;
  },
  unsubscribeAll: mock(),
  isUpToDate: true,
  shapes: { shape: { subscribe: mock(), unsubscribeAll: mock() } },
}));
await mock.module("@electric-sql/experimental", () => ({ MultiShapeStream: MockMultiShapeStream }));

const { createSyncEngine } = await import("../../packages/client/src/sync/index");

// Attach the sync engine as `.electric` on a freshly-created PGlite (ADR-0032 S1) — a plain module over
// the instance, no longer a create-time extension. Setup-only shim; assertions are unchanged.
type SyncEnginePGlite = PGlite & { electric: Awaited<ReturnType<typeof createSyncEngine>>["namespace"] };
async function attachSyncEngine(
  pg: PGlite,
  options?: Parameters<typeof createSyncEngine>[1],
): Promise<SyncEnginePGlite> {
  const engine = await createSyncEngine(pg, options);
  (pg as unknown as { electric: SyncEnginePGlite["electric"] }).electric = engine.namespace;
  return pg as SyncEnginePGlite;
}

const upToDate = (lsn: number): MultiShapeMessage => ({
  shape: "shape",
  headers: { control: "up-to-date", global_last_seen_lsn: String(lsn) },
});
const insertMsg = (lsn: number, value: { id: number; task: string }): MultiShapeMessage => ({
  headers: { operation: "insert", lsn: String(lsn) },
  key: `id${value.id}`,
  value,
  shape: "shape",
});

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeout = 10_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (Date.now() - start > timeout) throw new Error("waitUntil: timed out");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * The commit-queue transaction is a generic method (`transaction<T>(cb): Promise<T>`); the tests
 * replace it with fault-injecting stubs to force commit outcomes. A stub can't reproduce the generic
 * signature, so each assignment is scoped to a single-expression `as typeof pg.transaction` cast —
 * the narrowest escape for a deliberate monkeypatch of a generic method.
 */
type TransactionMethod = PGlite["transaction"];
type TransactionCallback = (tx: Transaction) => Promise<unknown>;

describe("sync commit queue (ADR-0009 Phase 2)", () => {
  let pg: SyncEnginePGlite;

  beforeEach(async () => {
    capturedCb = null;
    // Prepopulated FS skips the ~1.5s WASM initdb each test.
    pg = await attachSyncEngine(await createFreshTestPGlite(), { debug: false });
    // Fixture DDL rendered from the same `todo` pgTable the registry drives (single source; the DB is
    // fresh per test, so no TRUNCATE is needed).
    await createTablesFromSchema(pg, { todo: registry.todo.table });
  });

  async function startSync(opts: Partial<Parameters<typeof pg.electric.syncShapeToTable>[0]> = {}) {
    const shape = await pg.electric.syncShapeToTable({
      shape: { url: "http://localhost:3000/v1/shape", params: { table: "todo" } },
      registry,
      tableKey: "todo",
      shapeKey: null,
      commitRetryDelayMs: () => 0, // immediate retry — don't sleep the real jittered backoff in tests
      ...opts,
    });
    if (!capturedCb) throw new Error("subscribe callback was not captured");
    return shape;
  }

  const count = async () => (await drizzleOver(pg).select({ c: countAgg() }).from(registry.todo.table))[0]!.c;

  it("retries a failed commit with backoff, then recovers (never degraded)", async () => {
    const onSyncError = mock();
    const shape = await startSync({ onSyncError, maxCommitRetries: 5 });

    const realTransaction = pg.transaction.bind(pg);
    let calls = 0;
    pg.transaction = ((fn: TransactionCallback) => {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error("transient")) : realTransaction(fn);
    }) as TransactionMethod;

    await capturedCb!([insertMsg(1, { id: 1, task: "a" }), upToDate(1)]);

    expect(await count()).toBe(1); // applied on the retry
    expect(onSyncError).not.toHaveBeenCalled();
    expect(shape.isUpToDate).toBe(true);
    shape.unsubscribe();
  });

  it("goes degraded + fires onSyncError when a commit exhausts its retries", async () => {
    const onSyncError = mock();
    const shape = await startSync({ onSyncError, maxCommitRetries: 2 });

    pg.transaction = (() => Promise.reject(new Error("permanent"))) as TransactionMethod;

    await capturedCb!([insertMsg(1, { id: 1, task: "a" }), upToDate(1)]);

    expect(onSyncError).toHaveBeenCalledTimes(1);
    expect(shape.isUpToDate).toBe(false); // never up-to-date on an unapplied commit
    expect(await count()).toBe(0); // frontier held — nothing applied
    shape.unsubscribe();
  });

  it("holds the degraded buffer and refuses later commits — a newer LSN never applies over the lost batch", async () => {
    const onSyncError = mock();
    const shape = await startSync({ onSyncError, maxCommitRetries: 2 });
    // Capture the genuine transaction impl BEFORE any fault-injecting replacement.
    const realTransaction = pg.transaction.bind(pg);

    // LSN 1 permanently fails → degraded + onSyncError, nothing applied. Because `commitUpToLsn` now
    // PEEKS (never drains) the buffer, LSN 1's batch is still HELD in the inbox, not lost.
    pg.transaction = (() => Promise.reject(new Error("permanent"))) as TransactionMethod;
    await capturedCb!([insertMsg(1, { id: 1, task: "a" }), upToDate(1)]);
    expect(onSyncError).toHaveBeenCalledTimes(1);
    expect(await count()).toBe(0);

    // Restore a WORKING transaction, wrapped to count how often the engine actually commits.
    let postDegradeCommits = 0;
    pg.transaction = ((fn: TransactionCallback) => {
      postDegradeCommits += 1;
      return realTransaction(fn);
    }) as TransactionMethod;

    // A later LSN 2 batch arrives on the same live stream.
    await capturedCb!([insertMsg(2, { id: 2, task: "b" }), upToDate(2)]);

    // The engine refused to run any commit while degraded, so neither LSN 2 nor the held LSN 1 landed:
    // the store can never contain LSN 2's row without LSN 1's (it contains neither), and the read cache
    // never claims up-to-date. This is the divergence the old destructive drain allowed.
    expect(postDegradeCommits).toBe(0);
    expect(await count()).toBe(0);
    expect(shape.isUpToDate).toBe(false);
    shape.unsubscribe();
  });

  it("runs at most one commit transaction at a time (single-flight)", async () => {
    const shape = await startSync();

    const realTransaction = pg.transaction.bind(pg);
    let active = 0;
    let maxActive = 0;
    pg.transaction = ((fn: TransactionCallback) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      return realTransaction(fn).finally(() => {
        active -= 1;
      });
    }) as TransactionMethod;

    for (let i = 1; i <= 4; i++) {
      void capturedCb!([insertMsg(i, { id: i, task: `t${i}` }), upToDate(i)]);
    }

    await waitUntil(async () => (await count()) === 4);
    expect(maxActive).toBe(1);
    shape.unsubscribe();
  });

  it("coalesces batches buffered during a commit into fewer transactions than batches", async () => {
    const shape = await startSync();

    const realTransaction = pg.transaction.bind(pg);
    let transactionCount = 0;
    pg.transaction = ((fn: TransactionCallback) => {
      transactionCount += 1;
      return realTransaction(fn);
    }) as TransactionMethod;

    for (let i = 1; i <= 4; i++) {
      void capturedCb!([insertMsg(i, { id: i, task: `t${i}` }), upToDate(i)]);
    }

    await waitUntil(async () => (await count()) === 4);
    expect(transactionCount).toBeGreaterThanOrEqual(1);
    expect(transactionCount).toBeLessThan(4); // coalesced, not one-per-batch
    shape.unsubscribe();
  });
});
