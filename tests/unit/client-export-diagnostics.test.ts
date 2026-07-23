import { afterEach, describe, expect, it } from "bun:test";
// Diagnostic dump (ADR-0035, via the throwaway clone of the addendum) on the in-process client: a LIVE
// datadir dump → memory-backed throwaway PGlite booted with `loadDataDir` → `pg_dump` against the clone →
// the clone discarded, the live engine never touched. Uses a REAL in-memory PGlite (`syncEnabled: false`,
// no network) so the emitted SQL can be asserted directly. WASM-heavy (`pg_dump.wasm`): this file is in the
// FULL unit lane only (`test:unit`), NOT `test:unit:fast`.

import { bigint, boolean, uuid, varchar } from "drizzle-orm/pg-core";

import { defineSyncRegistry, defineSyncTable } from "@pgxsinkit/contracts";

import { createSyncClient, LifecycleBusyError, type SyncClient } from "../../packages/client/src/index";
import { migrateSubscriptionMetadataTables } from "../../packages/client/src/sync/subscription-state";
import { DEFAULT_METADATA_SCHEMA } from "../../packages/client/src/sync/tags";
import { memoryStoreForTests } from "../../packages/client/src/testing";

// A persistent readwrite table (todos) alongside an EPHEMERAL readwrite table (exam_answer). The ephemeral
// table's whole local cluster is emitted as pg_temp (ADR-0021 §3), which is what lets us prove decision 5:
// an active ephemeral cluster never appears in the diagnostic dump (pg_dump ignores temp objects, and the
// throwaway clone is a fresh session that never saw the live session's temp state).
const registry = defineSyncRegistry({
  todos: defineSyncTable({
    tableName: "todos",
    makeColumns: () => ({
      id: uuid("id").primaryKey(),
      title: varchar("title", { length: 200 }).notNull(),
      done: boolean("done").notNull(),
      updatedAtUs: bigint("updated_at_us", { mode: "bigint" }).notNull(),
    }),
    mode: "readwrite",
    conflictPolicy: "last-write-wins",
    governance: {
      managedFields: [{ column: "updatedAtUs", applyOn: ["create", "update"], strategy: "nowMicroseconds" }],
    },
  }),
  exam_answer: defineSyncTable({
    tableName: "exam_answer",
    makeColumns: () => ({
      id: uuid("id").primaryKey(),
      answer: varchar("answer", { length: 200 }),
      updatedAtUs: bigint("updated_at_us", { mode: "bigint" }).notNull().default(0n),
    }),
    mode: "readwrite",
    retention: "ephemeral",
    conflictPolicy: "last-write-wins",
    governance: {
      managedFields: [{ column: "updatedAtUs", applyOn: ["create", "update"], strategy: "nowMicroseconds" }],
    },
  }),
});
type Registry = typeof registry;

let client: SyncClient<Registry> | undefined;

afterEach(async () => {
  await client?.stop();
  client = undefined;
});

async function makeClient(storePath: string): Promise<SyncClient<Registry>> {
  return createSyncClient({
    registry,
    electricUrl: "http://127.0.0.1:1/v1/electric-proxy",
    batchWriteUrl: "http://127.0.0.1:1/api/mutations",
    syncEnabled: false,
    ...memoryStoreForTests(storePath),
  });
}

describe("exportDiagnostics throwaway-clone SQL dump (ADR-0035)", () => {
  it("dumps everything — synced tables, journal, metadata, views, functions — with a well-formed report", async () => {
    client = await makeClient("export-diag-everything");
    await client.ready;

    // Stage a write WITHOUT flushing (syncEnabled:false → nothing drains it): the journal evidence is the
    // whole point of a diagnostic dump, so it must ride inside the SQL.
    await client.mutate.create("todos", {
      id: "11111111-1111-1111-1111-111111111111",
      title: "unflushed-diagnostic",
      done: false,
    });
    // Provision the pgxsinkit metadata schema exactly as the sync engine does at first sync — a real synced
    // store carries `subscriptions_metadata`, and `syncEnabled:false` never starts sync to create it itself.
    await migrateSubscriptionMetadataTables({ pg: client.pglite, metadataSchema: DEFAULT_METADATA_SCHEMA });

    const { file, report } = await client.exportDiagnostics();

    // The artefact is named SQL of the whole store.
    expect(file.name).toMatch(/^export-diag-everything-.+-diagnostics\.sql$/);
    expect(file.type).toBe("application/sql");
    expect(file.size).toBeGreaterThan(0);

    // A well-formed diagnostic-dump report: the discriminant, every phase (checkpoint → dump → clone boot →
    // pg_dump), byte length matches the file, and the diagnostics snapshot carries the unflushed write.
    expect(report.reportVersion).toBe(1);
    expect(report.kind).toBe("diagnostic-dump");
    expect(report.scope).toBe("everything");
    expect(report.byteLength).toBe(file.size);
    expect(report.diagnostics.pendingCount).toBe(1);
    expect(report.phases.checkpointMs).toBeGreaterThanOrEqual(0);
    expect(report.phases.dumpMs).toBeGreaterThanOrEqual(0);
    expect(report.phases.cloneBootMs).toBeGreaterThanOrEqual(0);
    expect(report.phases.pgDumpMs).toBeGreaterThanOrEqual(0);
    // Offsets are monotonic in mechanism order: checkpoint → dump → clone boot → pg_dump.
    expect(report.phases.dumpStartedAtMs).toBeGreaterThanOrEqual(report.phases.checkpointStartedAtMs);
    expect(report.phases.cloneBootStartedAtMs).toBeGreaterThanOrEqual(report.phases.dumpStartedAtMs);
    expect(report.phases.pgDumpStartedAtMs).toBeGreaterThanOrEqual(report.phases.cloneBootStartedAtMs);

    const sql = await file.text();

    // The synced read-cache table and its rows are NOT the point here (there are none, syncEnabled:false) —
    // its CREATE TABLE is. The overlay + journal tables carry the STAGED-UNFLUSHED write's evidence.
    expect(sql).toMatch(/CREATE TABLE[^;]*\btodos\b/);
    expect(sql).toContain("todos_overlay");
    expect(sql).toContain("todos_mutations");
    expect(sql).toContain("unflushed-diagnostic"); // the staged write's row lives in the journal/overlay SQL

    // The pgxsinkit metadata schema (ADR-0009 decision 6) and its subscription bookkeeping table.
    expect(sql).toContain("pgxsinkit");
    expect(sql).toContain("subscriptions_metadata");

    // The read-model view and the convergence `_sync_state` view definitions, and the reconcile
    // function + trigger (the machinery a diagnostic must show to explain a misbehaving store).
    expect(sql).toMatch(/CREATE VIEW[\s\S]*todos_read_model/);
    expect(sql).toMatch(/CREATE VIEW[\s\S]*todos_sync_state/);
    expect(sql).toMatch(/CREATE FUNCTION[\s\S]*todos_reconcile_on_sync/);
    expect(sql).toMatch(/CREATE TRIGGER[\s\S]*todos_reconcile_on_sync/);
  });

  it("omits an ACTIVE ephemeral (pg_temp) cluster — by construction, not by filter (decision 5)", async () => {
    client = await makeClient("export-diag-ephemeral");
    await client.ready;

    // The eager ephemeral cluster's temp objects exist from boot; put a real row in it so it is genuinely
    // ACTIVE (not merely declared). It lives in pg_temp, so a `secret` here must never reach the dump.
    await client.rawExec(
      "INSERT INTO exam_answer (id, answer, updated_at_us) VALUES ('22222222-2222-2222-2222-222222222222', 'secret-temp-answer', 0)",
    );

    const { file } = await client.exportDiagnostics();
    const sql = await file.text();

    // pg_dump ignores temp objects, and the throwaway clone is a fresh session that never saw this one's
    // temp state — so neither the temp relation nor its row appears.
    expect(sql).not.toContain("exam_answer");
    expect(sql).not.toContain("secret-temp-answer");
    // Sanity: the persistent table IS present, so the assertion above is not vacuously true.
    expect(sql).toMatch(/CREATE TABLE[^;]*\btodos\b/);
  });

  it("leaves the live engine UNAFFECTED — queries and a live subscription still work afterwards", async () => {
    client = await makeClient("export-diag-live-intact");
    await client.ready;

    await client.exportDiagnostics();

    // The whole point of the clone design: `pg_dump`'s `DEALLOCATE ALL` ran against the discarded clone, so
    // the live engine's prepared statements (and the `live` extension) are untouched. A live subscription
    // registered AFTER the export must still fire on a subsequent write.
    const seen: number[] = [];
    const subscription = await client.subscribeLiveRows<{ n: number }>(
      { sql: "SELECT count(*)::int AS n FROM todos_read_model", params: [] },
      (rows) => seen.push(rows[0]?.n ?? -1),
    );
    expect(subscription.initialRows[0]?.n).toBe(0);

    await client.mutate.create("todos", {
      id: "33333333-3333-3333-3333-333333333333",
      title: "after-export",
      done: false,
    });
    // The optimistic write flips the read model; the live query must observe it (engine fully alive).
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(seen.at(-1)).toBe(1);
    subscription.unsubscribe();

    // And a plain read still works on the same live instance.
    const rows = await client.rawQuery("SELECT count(*)::int AS n FROM todos_read_model");
    expect((rows.rows[0] as { n: number }).n).toBe(1);
  });

  it("serialises against exportStore through the single lifecycle slot (typed busy error)", async () => {
    client = await makeClient("export-diag-busy");
    await client.ready;

    // A diagnostic dump raced against a store backup: one claims the slot, the other is refused immediately
    // (no queueing) with the typed busy error — the two lifecycle ops share ONE slot (ADR-0035 decision 4).
    const [a, b] = await Promise.allSettled([client.exportDiagnostics(), client.exportStore()]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual(["fulfilled", "rejected"]);
    const rejected = (a.status === "rejected" ? a : b) as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(LifecycleBusyError);
  });

  it("waits out the boot rather than rejecting when called before ready", async () => {
    // Call exportDiagnostics WITHOUT first awaiting `client.ready` — it must await engine-ready internally
    // and resolve once booted, not reject during boot (ADR-0035 decision 4).
    client = await makeClient("export-diag-preready");
    const { file, report } = await client.exportDiagnostics();
    expect(file.size).toBeGreaterThan(0);
    expect(report.kind).toBe("diagnostic-dump");
  });
});
