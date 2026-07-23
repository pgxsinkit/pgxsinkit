/**
 * F1-R1 — a mid-commit `resetShape` (must-refetch) must not let the succeeding commit's ack delete the
 * shape's post-reset rebuild. End-to-end reproduction through the real engine:
 *
 *   1. A two-shape group commits at LSN 5 (both shapes reached it), having PEEKED both shapes. The
 *      transaction is held open by a controllable gate.
 *   2. While it is held, shape `beta` gets a must-refetch + re-snapshot: `resetShape` rewinds beta's
 *      frontier and installs a rebuilt row at LSN 0 (content NOT in the in-flight commit's peek).
 *   3. The gate releases; the LSN-5 commit succeeds. Its `ackUpTo(5)` would (LSN 0 ≤ 5) delete beta's
 *      rebuilt row — but the per-shape EPOCH bumped by the reset makes the ack skip beta.
 *   4. The follow-up commit truncates beta and applies the rebuilt row.
 *
 * Without the epoch guard beta ends TRUNCATED-EMPTY (old row truncated, rebuilt row acked away before it
 * could be applied). With it, beta holds exactly the rebuilt row. Runs in its own `bun test` invocation
 * (ISOLATED set) because `mock.module` is process-global.
 */
import { beforeEach, describe, expect, it, mock } from "bun:test";

import type { PGlite, Transaction } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { integer, text } from "drizzle-orm/pg-core";

import { defineSyncRegistry, defineSyncTable } from "@pgxsinkit/contracts";

import type { MultiShapeMessages, Row, ShapeStreamOptions } from "../../packages/client/src/sync/types";
import { createTablesFromSchema, drizzleOver } from "../support/drizzle";
import { createFreshTestPGlite } from "../support/pglite";

const registry = defineSyncRegistry({
  alpha: defineSyncTable({
    tableName: "alpha",
    makeColumns: () => ({ id: integer("id").primaryKey(), note: text("note") }),
  }),
  beta: defineSyncTable({
    tableName: "beta",
    makeColumns: () => ({ id: integer("id").primaryKey(), note: text("note") }),
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
  shapes: {
    alpha: { subscribe: mock(), unsubscribeAll: mock() },
    beta: { subscribe: mock(), unsubscribeAll: mock() },
  },
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

const insertMsg = (shape: string, lsn: number, value: { id: number; note: string }): MultiShapeMessage => ({
  headers: { operation: "insert", lsn: String(lsn), last: true },
  key: `${shape}/${value.id}`,
  value,
  shape,
});
const upToDate = (shape: string, lsn: number): MultiShapeMessage => ({
  shape,
  headers: { control: "up-to-date", global_last_seen_lsn: String(lsn) },
});
const mustRefetch = (shape: string): MultiShapeMessage => ({
  shape,
  headers: { control: "must-refetch" },
});

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeout = 10_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (Date.now() - start > timeout) throw new Error("waitUntil: timed out");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

type TransactionMethod = PGlite["transaction"];
type TransactionCallback = (tx: Transaction) => Promise<unknown>;

describe("sync mid-commit reset (F1-R1)", () => {
  let pg: SyncEnginePGlite;

  beforeEach(async () => {
    capturedCb = null;
    pg = await attachSyncEngine(await createFreshTestPGlite(), { debug: false });
    await createTablesFromSchema(pg, { alpha: registry.alpha.table, beta: registry.beta.table });
  });

  it("keeps beta's post-reset rebuild when a must-refetch lands mid-commit", async () => {
    await pg.electric.syncShapesToTables({
      registry,
      key: null,
      commitRetryDelayMs: () => 0,
      shapes: {
        alpha: { shape: { url: "http://localhost:3000/v1/shape", params: { table: "alpha" } }, tableKey: "alpha" },
        beta: { shape: { url: "http://localhost:3000/v1/shape", params: { table: "beta" } }, tableKey: "beta" },
      },
    });
    if (!capturedCb) throw new Error("subscribe callback not captured");

    // Gate the FIRST commit's transaction open so a must-refetch can land while it is peeked-but-uncommitted.
    const realTransaction = pg.transaction.bind(pg);
    let commitCount = 0;
    let releaseFirstCommit: (() => void) | null = null;
    let signalFirstCommitStarted: (() => void) | null = null;
    const firstCommitStarted = new Promise<void>((resolve) => (signalFirstCommitStarted = resolve));
    pg.transaction = ((fn: TransactionCallback) => {
      commitCount += 1;
      if (commitCount === 1) {
        signalFirstCommitStarted!();
        return new Promise<void>((resolve) => (releaseFirstCommit = resolve)).then(() => realTransaction(fn));
      }
      return realTransaction(fn);
    }) as TransactionMethod;

    // Batch 1: both shapes reach LSN 5 → a group commit at 5 starts and blocks in the gate.
    void capturedCb([
      insertMsg("alpha", 5, { id: 1, note: "a" }),
      upToDate("alpha", 5),
      insertMsg("beta", 5, { id: 1, note: "b-old" }),
      upToDate("beta", 5),
    ]);
    await firstCommitStarted;

    // Batch 2 (mid-commit): beta must-refetch + re-snapshot with a DIFFERENT row (id 2), then up-to-date.
    void capturedCb([mustRefetch("beta"), insertMsg("beta", 0, { id: 2, note: "b-rebuilt" }), upToDate("beta", 6)]);

    // Release the held first commit; the follow-up commit (rerun) then truncates + rebuilds beta.
    releaseFirstCommit!();

    const betaRows = async () => drizzleOver(pg).select().from(registry.beta.table).orderBy(registry.beta.table.id);

    // Beta converges to EXACTLY the rebuilt row — the old row truncated away, the rebuild NOT lost to the
    // stale commit's ack (the F1-R1 bug would leave beta empty).
    await waitUntil(async () => {
      const rows = await betaRows();
      return rows.length === 1 && rows[0]?.note === "b-rebuilt";
    });
    const rows = await betaRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 2, note: "b-rebuilt" });

    // Alpha (untouched by the reset) applied normally.
    const alphaRows = await drizzleOver(pg).select().from(registry.alpha.table).where(eq(registry.alpha.table.id, 1));
    expect(alphaRows).toHaveLength(1);
    expect(alphaRows[0]).toMatchObject({ id: 1, note: "a" });
  });
});
