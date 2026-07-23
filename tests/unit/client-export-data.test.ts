import { afterEach, describe, expect, it } from "bun:test";
// Data export (ADR-0035 decision 1, via the throwaway clone of the addendum) on the in-process client: the
// journal is drained (or the escape hatch is taken), then `pg_dump -t <synced table> --no-owner` runs against
// a memory-backed throwaway clone, and a generated enum DDL header is concatenated ahead of it. The artefact
// is the PORTABLE synced data — loadable into a vanilla Postgres, free of pgxsinkit's overlay/journal/views/
// reconcile machinery. Uses a REAL in-memory PGlite (`syncEnabled: false`, no network) so the SQL can be
// asserted directly and re-loaded into a FRESH bare store. WASM-heavy (`pg_dump.wasm`): FULL unit lane only
// (`test:unit`), NOT `test:unit:fast`.

import { PGlite } from "@electric-sql/pglite";
import { bigint, boolean, pgEnum, uuid, varchar } from "drizzle-orm/pg-core";

import { defineSyncRegistry, defineSyncTable } from "@pgxsinkit/contracts";

import { DataExportDrainError } from "../../packages/client/src/export-data";
import { createSyncClient, LifecycleBusyError, type SyncClient } from "../../packages/client/src/index";
import { resolveStoreDataDir } from "../../packages/client/src/store-path";
import { memoryStoreForTests } from "../../packages/client/src/testing";

// A persistent readwrite table (todos) with an ENUM-typed column — the enum is what proves the generated DDL
// header (pg_dump -t omits the enum type). Alongside it, an EPHEMERAL readwrite table (exam_answer): its
// cluster is pg_temp (ADR-0021 §3), so the `-t` allowlist must EXCLUDE it (a pattern matching nothing makes
// pg_dump fail) and it must never appear in the artefact.
const todoPriority = pgEnum("todo_priority", ["low", "high"]);

const registry = defineSyncRegistry({
  todos: defineSyncTable({
    tableName: "todos",
    makeColumns: () => ({
      id: uuid("id").primaryKey(),
      title: varchar("title", { length: 200 }).notNull(),
      priority: todoPriority("priority").notNull(),
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
const freshStores: PGlite[] = [];

afterEach(async () => {
  await client?.stop();
  client = undefined;
  for (const store of freshStores.splice(0)) await store.close().catch(() => undefined);
});

async function makeClient(
  storePath: string,
  overrides?: { maxMutationAttempts?: number },
): Promise<SyncClient<Registry>> {
  return createSyncClient({
    registry,
    electricUrl: "http://127.0.0.1:1/v1/electric-proxy",
    // A deliberately DEAD write endpoint: every scenario here is offline, so a flush that does run fails fast.
    batchWriteUrl: "http://127.0.0.1:1/api/mutations",
    syncEnabled: false,
    ...(overrides?.maxMutationAttempts != null ? { maxMutationAttempts: overrides.maxMutationAttempts } : {}),
    ...memoryStoreForTests(storePath),
  });
}

describe("exportData portable SQL export (ADR-0035)", () => {
  it("produces a self-contained artefact — enum + tables + rows, none of pgxsinkit's machinery — that loads into a FRESH bare Postgres", async () => {
    client = await makeClient("export-data-selfcontained");
    await client.ready;

    // Put SYNCED rows straight into the physical synced table (there is no real read path under
    // syncEnabled:false). The enum-typed column is the crux: the artefact must recreate the type itself.
    await client.rawExec(
      "INSERT INTO todos (id, title, priority, done, updated_at_us) VALUES " +
        "('11111111-1111-1111-1111-111111111111', 'alpha', 'high', false, 10), " +
        "('22222222-2222-2222-2222-222222222222', 'beta', 'low', true, 20)",
    );

    const { file, report } = await client.exportData();

    // A well-formed data-export artefact + report.
    expect(file.name).toMatch(/^export-data-selfcontained-.+-data\.sql$/);
    expect(file.type).toBe("application/sql");
    expect(report.reportVersion).toBe(1);
    expect(report.kind).toBe("data-export");
    expect(report.scope).toBe("synced-tables");
    expect(report.escapeHatch).toBe(false);
    expect(report.byteLength).toBe(file.size);
    // The `-t` allowlist is exactly the owning persistent table — the ephemeral one is excluded.
    expect(report.tables).toEqual(["todos"]);
    // A drained (here: empty) journal snapshot.
    expect(report.diagnostics.pendingCount).toBe(0);
    // Drain came first (offset 0), then the clone pipeline; every phase is present and monotonic.
    expect(report.phases.drainStartedAtMs).toBeGreaterThanOrEqual(0);
    expect(report.phases.drainMs).toBeGreaterThanOrEqual(0);
    expect(report.phases.checkpointStartedAtMs).toBeGreaterThanOrEqual(report.phases.drainStartedAtMs);
    expect(report.phases.pgDumpStartedAtMs).toBeGreaterThanOrEqual(report.phases.cloneBootStartedAtMs);

    const sql = await file.text();

    // Nothing of pgxsinkit's machinery is in the SQL text (the exclusion is the whole point of the export).
    // NB: the word "pgxsinkit" DOES legitimately appear in the artefact's provenance comment header — the
    // authoritative "no machinery" proof is the fresh-store catalog check below (no pgxsinkit schema/objects).
    expect(sql).not.toContain("todos_overlay");
    expect(sql).not.toContain("todos_mutations");
    expect(sql).not.toContain("todos_read_model");
    expect(sql).not.toContain("todos_sync_state");
    expect(sql).not.toContain("reconcile_on_sync");
    expect(sql).not.toContain("exam_answer");

    // THE PROOF: exec the artefact verbatim into a fresh, bare, engine-less PGlite (booted through the same
    // resolution module the toolkit uses) and assert it stands up on its own.
    const fresh = await PGlite.create({ dataDir: resolveStoreDataDir("export-data-fresh-verify", "memory") });
    freshStores.push(fresh);
    await fresh.exec(sql);

    // The enum type the header recreated exists…
    const enumRows = await fresh.query<{ typname: string }>(
      "SELECT typname FROM pg_type WHERE typname = 'todo_priority'",
    );
    expect(enumRows.rows).toHaveLength(1);

    // …the synced table exists with its rows and the enum values intact (schema-qualified: pg_dump resets
    // the session search_path to '' at the end of the artefact, exactly as a `psql -f` load would)…
    const rows = await fresh.query<{ title: string; priority: string; done: boolean }>(
      "SELECT title, priority::text AS priority, done FROM public.todos ORDER BY title",
    );
    expect(rows.rows).toEqual([
      { title: "alpha", priority: "high", done: false },
      { title: "beta", priority: "low", done: true },
    ]);

    // …and NONE of pgxsinkit's machinery came across: no overlay/journal/views, no reconcile function, no schema.
    const regclass = async (name: string) =>
      (await fresh.query<{ r: string | null }>(`SELECT to_regclass('${name}') AS r`)).rows[0]?.r ?? null;
    expect(await regclass("public.todos_overlay")).toBeNull();
    expect(await regclass("public.todos_mutations")).toBeNull();
    expect(await regclass("public.todos_read_model")).toBeNull();
    const reconcileFns = await fresh.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'todos_reconcile_on_sync'",
    );
    expect(reconcileFns.rows[0]?.n).toBe(0);
    const pgxsinkitSchema = await fresh.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM pg_namespace WHERE nspname = 'pgxsinkit'",
    );
    expect(pgxsinkitSchema.rows[0]?.n).toBe(0);
  });

  it("exports strictly and instantly on a clean journal even when the network is unreachable (offline-clean)", async () => {
    // An OFFLINE device (syncEnabled:false + dead batchWriteUrl) with a clean journal must succeed with ZERO
    // network involvement — the drain finds nothing owed and proceeds immediately.
    client = await makeClient("export-data-offline-clean");
    await client.ready;

    const started = performance.now();
    const { file, report } = await client.exportData();
    const elapsed = performance.now() - started;

    expect(file.size).toBeGreaterThan(0);
    expect(report.escapeHatch).toBe(false);
    expect(report.diagnostics.pendingCount).toBe(0);
    expect(report.diagnostics.ackedCount).toBe(0);
    // No flush/await happened — a clean journal is instant (well under any drain budget).
    expect(elapsed).toBeLessThan(5_000);
  });

  it("with drainJournal:false exports the SYNCED state as-is, omitting a staged unflushed write (escape hatch)", async () => {
    client = await makeClient("export-data-escape-hatch");
    await client.ready;

    // A synced row that MUST appear, and a staged optimistic write that MUST NOT (it lives in the overlay/
    // journal, never the synced table, and `-t` dumps only the synced table).
    await client.rawExec(
      "INSERT INTO todos (id, title, priority, done, updated_at_us) VALUES " +
        "('33333333-3333-3333-3333-333333333333', 'synced-visible', 'low', false, 5)",
    );
    await client.mutate.create("todos", {
      id: "44444444-4444-4444-4444-444444444444",
      title: "staged-hidden",
      priority: "high",
      done: false,
    });
    expect((await client.diagnostics()).mutation.pendingCount).toBe(1);

    const { file, report } = await client.exportData({ drainJournal: false });
    const sql = await file.text();

    expect(report.escapeHatch).toBe(true);
    expect(sql).toContain("synced-visible");
    expect(sql).not.toContain("staged-hidden");
  });

  it("fails FAST (well under the timeout) when the drain's own flush fails and rows go to `failed`", async () => {
    client = await makeClient("export-data-drain-flush-fails");
    await client.ready;

    // A pending optimistic write with a dead write endpoint: the drain flushes it, the flush fails, the row
    // moves to `failed`, and the next poll detects the non-drainable state — no waiting out the 15s budget.
    await client.mutate.create("todos", {
      id: "55555555-5555-5555-5555-555555555555",
      title: "will-fail",
      priority: "low",
      done: false,
    });

    const started = performance.now();
    let caught: unknown;
    try {
      await client.exportData();
    } catch (error) {
      caught = error;
    }
    const elapsed = performance.now() - started;

    expect(caught).toBeInstanceOf(DataExportDrainError);
    expect((caught as DataExportDrainError).reason).toBe("non-drainable-state");
    expect((caught as DataExportDrainError).diagnostics.failedCount).toBeGreaterThan(0);
    // The whole point of fail-fast: nowhere near the 15s default budget.
    expect(elapsed).toBeLessThan(5_000);
  });

  it("fails immediately, with no waiting, on a PRE-EXISTING non-drainable (quarantined) row", async () => {
    // maxMutationAttempts:1 → the first (failing) flush escalates straight to `quarantined`.
    client = await makeClient("export-data-preexisting-terminal", { maxMutationAttempts: 1 });
    await client.ready;

    await client.mutate.create("todos", {
      id: "66666666-6666-6666-6666-666666666666",
      title: "poison",
      priority: "high",
      done: false,
    });
    // Drive it terminal OUTSIDE the export, so the state pre-exists when exportData runs.
    await client.flush().catch(() => undefined);
    expect((await client.diagnostics()).mutation.quarantinedCount).toBeGreaterThan(0);

    const started = performance.now();
    let caught: unknown;
    try {
      await client.exportData();
    } catch (error) {
      caught = error;
    }
    const elapsed = performance.now() - started;

    expect(caught).toBeInstanceOf(DataExportDrainError);
    expect((caught as DataExportDrainError).reason).toBe("non-drainable-state");
    expect((caught as DataExportDrainError).diagnostics.quarantinedCount).toBeGreaterThan(0);
    // Fail-fast BEFORE any flush/wait — pre-existing terminal rows never drain.
    expect(elapsed).toBeLessThan(2_000);
  });

  it("excludes an ACTIVE ephemeral (pg_temp) cluster from the `-t` args and the artefact (still succeeds)", async () => {
    client = await makeClient("export-data-ephemeral");
    await client.ready;

    // Make the ephemeral cluster genuinely ACTIVE — a real pg_temp row that must never reach the artefact.
    await client.rawExec(
      "INSERT INTO exam_answer (id, answer, updated_at_us) VALUES ('77777777-7777-7777-7777-777777777777', 'secret-temp', 0)",
    );
    await client.rawExec(
      "INSERT INTO todos (id, title, priority, done, updated_at_us) VALUES " +
        "('88888888-8888-8888-8888-888888888888', 'persistent-row', 'low', false, 1)",
    );

    const { file, report } = await client.exportData();
    const sql = await file.text();

    // The ephemeral table is neither in the applied `-t` list nor in the artefact; the persistent one is.
    expect(report.tables).toEqual(["todos"]);
    expect(sql).not.toContain("exam_answer");
    expect(sql).not.toContain("secret-temp");
    expect(sql).toContain("persistent-row");
  });

  it("serialises against a concurrent export through the single lifecycle slot (typed busy error)", async () => {
    client = await makeClient("export-data-busy");
    await client.ready;

    const [a, b] = await Promise.allSettled([client.exportData(), client.exportStore()]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual(["fulfilled", "rejected"]);
    const rejected = (a.status === "rejected" ? a : b) as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(LifecycleBusyError);
  });

  it("waits out the boot rather than rejecting when called before ready", async () => {
    client = await makeClient("export-data-preready");
    const { file, report } = await client.exportData();
    expect(file.size).toBeGreaterThan(0);
    expect(report.kind).toBe("data-export");
  });

  it("has structured-clone-safe options (they cross the worker bridge as plain JSON)", () => {
    const options = { fileName: "x-data.sql", drainJournal: { timeoutMs: 1_000 } };
    expect(structuredClone(options)).toEqual(options);
    expect(structuredClone({ drainJournal: false as const })).toEqual({ drainJournal: false });
  });

  // The one drain path the unit harness cannot honestly exercise: `acked` writes clear ONLY via the synced
  // echo through the Convergence barrier, which needs a real read path. Exercised in the integration lane
  // (a real Postgres → Electric → PGlite round trip), NOT faked here (a fake echo would prove nothing).
  it.todo("drains `acked` writes via the synced echo before exporting — integration lane (sync-engine-e2e)", () => {});
});
