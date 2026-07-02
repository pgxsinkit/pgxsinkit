import { describe, expect, it, mock } from "bun:test";

import { count, eq, inArray, sql } from "drizzle-orm";

import { getJournalTable, getOverlayTable, getSyncStateView } from "@pgxsinkit/client";
import { CONVERGENCE_EVENTS } from "@pgxsinkit/contracts";
import { demoSyncRegistry } from "@pgxsinkit/schema";

import { createMutationRuntime } from "../../packages/client/src/mutation";
import { buildDropReadCacheSql, generateLocalSchemaSql } from "../../packages/client/src/schema";
import { pgViews } from "../support/catalog-tables";
import { drizzleOver } from "../support/drizzle";
import { createFreshTestPGlite } from "../support/pglite";

// ADR-0011 proofs for the Convergence model: the per-table `<table>_sync_state` view derives every
// convergence fact from synced + overlay + journal, and its acked-unobserved status uses the SAME
// barrier predicate the resolver (the reconcile trigger + reconcileTable) uses — so what the view
// shows can never drift from what the resolver does (decision 4, the anti-drift guarantee).

const schemaSql = generateLocalSchemaSql(demoSyncRegistry);
const writeUrl = "http://localhost:3001";
const AUTHOR_ID = "01963227-d4c7-72db-b858-f89f6af80001";

async function createContext() {
  const db = await createFreshTestPGlite();
  await db.exec(schemaSql);
  return { db, runtime: createMutationRuntime({ db, registry: demoSyncRegistry, writeUrl }) };
}

type PGliteDb = Awaited<ReturnType<typeof createFreshTestPGlite>>;
type DemoRuntime = Awaited<ReturnType<typeof createContext>>["runtime"];

async function seedSyncedAuthor(db: PGliteDb, id: string, version: number) {
  await drizzleOver(db)
    .insert(demoSyncRegistry.authors.localTable)
    .values({ id, name: "Seeded", createdAtUs: BigInt(version), updatedAtUs: BigInt(version) });
}

/** Apply an Electric echo by advancing the synced row's Server version — fires the reconcile trigger. */
async function applyEcho(db: PGliteDb, id: string, version: number) {
  await drizzleOver(db)
    .update(demoSyncRegistry.authors.localTable)
    .set({ updatedAtUs: BigInt(version) })
    .where(eq(demoSyncRegistry.authors.localTable.id, id));
}

async function journalCount(db: PGliteDb, id: string) {
  const journal = getJournalTable(demoSyncRegistry, "authors");
  const rows = await drizzleOver(db).select({ count: count() }).from(journal).where(eq(journal["id"]!, id));
  return rows[0]?.count ?? 0;
}

interface SyncStateRow {
  observed: string | null;
  acked: string | null;
  pending: number;
  unobserved: boolean;
  deletePending: boolean;
  conflict: string | null;
  quarantined: number;
  quarantineState: string | null;
}

async function readSyncState(db: PGliteDb, id: string): Promise<SyncStateRow | null> {
  const view = getSyncStateView(demoSyncRegistry, "authors");
  const rows = await drizzleOver(db)
    .select({
      observed: sql<string | null>`${view.observedServerVersion}::text`.as("observed"),
      acked: sql<string | null>`${view.ackedServerVersion}::text`.as("acked"),
      pending: view.pendingCount,
      unobserved: view.hasAckedUnobservedWrite,
      deletePending: view.localDeletePending,
      conflict: view.conflictState,
      quarantined: view.quarantinedCount,
      quarantineState: view.quarantineState,
    })
    .from(view)
    .where(eq(view["id"]!, id));
  return rows[0] ?? null;
}

function ackingFetch(serverUpdatedAtUs: string) {
  return mock(async (_input: unknown, init?: { body?: unknown }) => {
    const bodyText = typeof init?.body === "string" ? init.body : null;
    const requestBody = bodyText
      ? (JSON.parse(bodyText) as { mutations: Array<{ mutationId: string }> })
      : { mutations: [] };

    return new Response(
      JSON.stringify({
        acks: requestBody.mutations.map((mutation) => ({
          mutationId: mutation.mutationId,
          status: "acked",
          httpStatus: 200,
          serverUpdatedAtUs,
        })),
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  });
}

async function flushWithAck(runtime: DemoRuntime, serverUpdatedAtUs: string) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ackingFetch(serverUpdatedAtUs) as unknown as typeof fetch;
  try {
    await runtime.flush("authors");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

describe("Convergence model — the <table>_sync_state view (ADR-0011)", () => {
  it("has_acked_unobserved_write is true exactly between ack and echo (ack-before-echo)", async () => {
    const { db, runtime } = await createContext();
    try {
      await seedSyncedAuthor(db, AUTHOR_ID, 100);
      await runtime.update("authors", { id: AUTHOR_ID }, { name: "Edited" });

      // Pending (enqueued, not yet acked): outstanding work, but not acked-unobserved.
      let state = await readSyncState(db, AUTHOR_ID);
      expect(state).toEqual({
        observed: "100",
        acked: null,
        pending: 1,
        unobserved: false,
        deletePending: false,
        conflict: null,
        quarantined: 0,
        quarantineState: null,
      });

      // Acked, echo not yet at the acked version → acked-unobserved. The resolver must AGREE: the
      // reconcile trigger has not fired (no synced change), so the journal row is still present.
      await flushWithAck(runtime, "200");
      state = await readSyncState(db, AUTHOR_ID);
      expect(state).toEqual({
        observed: "100",
        acked: "200",
        pending: 0,
        unobserved: true,
        deletePending: false,
        conflict: null,
        quarantined: 0,
        quarantineState: null,
      });
      expect(await journalCount(db, AUTHOR_ID)).toBe(1);

      // Echo reaches the acked version → the trigger resolves the entity. The view agrees: the
      // entity has no overlay/journal activity left, so it drops out of the convergence view.
      await applyEcho(db, AUTHOR_ID, 200);
      expect(await journalCount(db, AUTHOR_ID)).toBe(0);
      expect(await readSyncState(db, AUTHOR_ID)).toBeNull();
    } finally {
      await db.close();
    }
  });

  it("a stale echo (below the acked version) keeps the write unobserved — view agrees with the trigger", async () => {
    const { db, runtime } = await createContext();
    try {
      await seedSyncedAuthor(db, AUTHOR_ID, 100);
      await runtime.update("authors", { id: AUTHOR_ID }, { name: "Edited" });
      await flushWithAck(runtime, "300");

      // A stale/reordered echo lands below the acked version: the trigger's barrier (300 <= 250) is
      // false, so it must NOT clear — and the view must still report the write unobserved.
      await applyEcho(db, AUTHOR_ID, 250);
      expect(await journalCount(db, AUTHOR_ID)).toBe(1);
      expect(await readSyncState(db, AUTHOR_ID)).toEqual({
        observed: "250",
        acked: "300",
        pending: 0,
        unobserved: true,
        deletePending: false,
        conflict: null,
        quarantined: 0,
        quarantineState: null,
      });

      // The real echo reaches the acked version → resolved on both sides.
      await applyEcho(db, AUTHOR_ID, 300);
      expect(await journalCount(db, AUTHOR_ID)).toBe(0);
      expect(await readSyncState(db, AUTHOR_ID)).toBeNull();
    } finally {
      await db.close();
    }
  });

  it("echo-before-ack: the view reports observed and reconcileTable (the bulk resolver) agrees", async () => {
    const { db, runtime } = await createContext();
    try {
      await seedSyncedAuthor(db, AUTHOR_ID, 100);
      await runtime.update("authors", { id: AUTHOR_ID }, { name: "Edited" });

      // The echo arrives while the mutation is still un-acked. The trigger fires but only clears
      // acked rows, so nothing is resolved and the write is not yet acked-unobserved.
      await applyEcho(db, AUTHOR_ID, 400);
      expect(await journalCount(db, AUTHOR_ID)).toBe(1);
      let state = await readSyncState(db, AUTHOR_ID);
      expect(state?.pending).toBe(1);
      expect(state?.unobserved).toBe(false);
      expect(state?.observed).toBe("400");

      // Ack lands at the already-observed version (the server caught the echo first). The view now
      // reports the write as observed — barrier satisfied → not unobserved — WITHOUT the trigger
      // re-firing. (Acked directly so the post-ack/pre-reconcile window is observable; `flush` would
      // bundle the reconcile, which the first two cases already exercise.)
      const journal = getJournalTable(demoSyncRegistry, "authors");
      await drizzleOver(db)
        .update(journal)
        .set({ status: "acked", serverUpdatedAtUs: "400", ackedAtUs: "400" })
        .where(eq(journal["id"]!, AUTHOR_ID));
      state = await readSyncState(db, AUTHOR_ID);
      expect(state).toEqual({
        observed: "400",
        acked: "400",
        pending: 0,
        unobserved: false,
        deletePending: false,
        conflict: null,
        quarantined: 0,
        quarantineState: null,
      });
      expect(await journalCount(db, AUTHOR_ID)).toBe(1);

      // ...and the second resolver site (reconcileTable, the bulk fallback) MUST agree by clearing
      // it. Same barrier, both consumers — no drift.
      await runtime.reconcile("authors");
      expect(await journalCount(db, AUTHOR_ID)).toBe(0);
      expect(await readSyncState(db, AUTHOR_ID)).toBeNull();
    } finally {
      await db.close();
    }
  });

  it("surfaces local_delete_pending and the reserved conflict_state, while the read model hides the delete", async () => {
    const { db, runtime } = await createContext();
    try {
      await seedSyncedAuthor(db, AUTHOR_ID, 100);
      await runtime.delete("authors", { id: AUTHOR_ID });

      const state = await readSyncState(db, AUTHOR_ID);
      expect(state?.deletePending).toBe(true);
      expect(state?.pending).toBe(1);
      expect(state?.conflict).toBeNull();

      // The lean read model hides the optimistically-deleted row...
      const view = demoSyncRegistry.authors.view!;
      const readModel = await drizzleOver(db).select({ count: count() }).from(view).where(eq(view.id, AUTHOR_ID));
      expect(readModel[0]?.count).toBe(0);

      // ...and the conflict_state slot surfaces the reason of a `conflicted` write (ADR-0015 fills it,
      // scoped to status = 'conflicted' so a non-conflict reason never leaks in).
      const journal = getJournalTable(demoSyncRegistry, "authors");
      await drizzleOver(db)
        .update(journal)
        .set({ status: "conflicted", conflictReason: "409 stale" })
        .where(eq(journal["id"]!, AUTHOR_ID));
      expect((await readSyncState(db, AUTHOR_ID))?.conflict).toBe("409 stale");
    } finally {
      await db.close();
    }
  });

  it("surfaces a quarantined terminal write the resolver/view would otherwise hide (audit finding 3)", async () => {
    const { db, runtime } = await createContext();
    try {
      await seedSyncedAuthor(db, AUTHOR_ID, 100);
      await runtime.update("authors", { id: AUTHOR_ID }, { name: "Edited" });

      // Drive the journal row to the terminal `quarantined` state (ADR-0006: a poison write the
      // server permanently rejected). Quarantine keeps the optimistic overlay and is NOT a pending
      // retry, so before this fix the entity showed pending=0/conflict=null and no terminal signal.
      const journal = getJournalTable(demoSyncRegistry, "authors");
      await drizzleOver(db)
        .update(journal)
        .set({ status: "quarantined", lastError: "413 payload too large" })
        .where(eq(journal["id"]!, AUTHOR_ID));

      const state = await readSyncState(db, AUTHOR_ID);
      expect(state?.pending).toBe(0); // not a retryable owed write...
      expect(state?.conflict).toBeNull(); // ...and not a conflict...
      expect(state?.quarantined).toBe(1); // ...but the blocked terminal intent IS surfaced.
      expect(state?.quarantineState).toBe("413 payload too large");
    } finally {
      await db.close();
    }
  });

  it("keeps the read model lean — no convergence columns leak into it (ADR-0011 decision 2)", async () => {
    const { db } = await createContext();
    try {
      const readModel = await db.query(`SELECT * FROM authors_read_model LIMIT 0`);
      const readModelColumns = new Set(readModel.fields.map((field) => field.name));
      // The everyday optimistic signal stays on the read model...
      expect(readModelColumns.has("overlay_kind")).toBe(true);
      expect(readModelColumns.has("local_updated_at_us")).toBe(true);
      // ...but the heavier convergence facts live only on the sync-state view.
      for (const convergenceColumn of [
        "observed_server_version",
        "acked_server_version",
        "pending_count",
        "has_acked_unobserved_write",
        "local_delete_pending",
        "conflict_state",
        "quarantined_count",
        "quarantine_state",
      ]) {
        expect(readModelColumns.has(convergenceColumn)).toBe(false);
      }

      const syncState = await db.query(`SELECT * FROM authors_sync_state LIMIT 0`);
      const syncStateColumns = new Set(syncState.fields.map((field) => field.name));
      expect(syncStateColumns.has("has_acked_unobserved_write")).toBe(true);
      expect(syncStateColumns.has("conflict_state")).toBe(true);
      expect(syncStateColumns.has("quarantined_count")).toBe(true);
      expect(syncStateColumns.has("quarantine_state")).toBe(true);
    } finally {
      await db.close();
    }
  });

  it("preserves ADR-0006 droppability — dropping the read cache leaves overlay + journal intact", async () => {
    const { db, runtime } = await createContext();
    try {
      await seedSyncedAuthor(db, AUTHOR_ID, 100);
      await runtime.update("authors", { id: AUTHOR_ID }, { name: "Edited" });
      await flushWithAck(runtime, "200");

      // Drop the reconstructible read cache (synced tables + read-model + sync-state views + trigger).
      await db.exec(buildDropReadCacheSql(demoSyncRegistry));

      // The authority tables — the convergence facts' source — survive untouched.
      const overlayTable = getOverlayTable(demoSyncRegistry, "authors");
      const overlay = await drizzleOver(db).select({ count: count() }).from(overlayTable);
      expect(overlay[0]?.count).toBe(1);
      expect(await journalCount(db, AUTHOR_ID)).toBe(1);

      // The derived views are gone (reconstructed by re-running generateLocalSchemaSql).
      const views = await drizzleOver(db)
        .select({ name: pgViews.viewname })
        .from(pgViews)
        .where(inArray(pgViews.viewname, ["authors_read_model", "authors_sync_state"]));
      expect(views.length).toBe(0);
    } finally {
      await db.close();
    }
  });

  it("documents every convergence event the model derives state for", () => {
    const events = CONVERGENCE_EVENTS.map((entry) => entry.event);
    expect(events).toContain("local create/update/delete enqueued");
    expect(events).toContain("mutation acked");
    expect(events).toContain("Electric insert/update observed");
    expect(events).toContain("Electric delete observed");
    expect(events).toContain("resolution");
    expect(events).toContain("conflict detected");
    expect(events).toContain("mutation quarantined");
    expect(events).toContain("shape must-refetch");
  });

  it("reconcile skips the transaction when no journal rows are acked/conflicted — idle fast-path (perf)", async () => {
    const { db, runtime } = await createContext();
    try {
      await seedSyncedAuthor(db, AUTHOR_ID, 100);

      // Count transaction openings: reconcileTable opens a BEGIN only when it has rows to clear/retire.
      let beginCount = 0;
      const originalExec = db.exec.bind(db);
      db.exec = ((...args: Parameters<typeof db.exec>) => {
        if (typeof args[0] === "string" && /^\s*BEGIN/i.test(args[0])) beginCount += 1;
        return originalExec(...args);
      }) as typeof db.exec;

      // Idle: an empty journal has nothing acked/conflicted, so a reconcile pass must be a pure no-op —
      // not open a transaction and run the three clear/retire CTEs. This is the dominant idle-CPU cost
      // the convergence driver would otherwise pay every interval, for every writable table (and each
      // such pass also fired the live-query NOTIFY triggers, re-running every UI query for nothing).
      await runtime.reconcile("authors");
      expect(beginCount).toBe(0);

      // But an acked write leaves an 'acked' journal row, so the guard lets reconcile run and converge.
      await runtime.update("authors", { id: AUTHOR_ID }, { name: "Edited" });
      await flushWithAck(runtime, "200");
      beginCount = 0;
      await runtime.reconcile("authors");
      expect(beginCount).toBeGreaterThan(0);
    } finally {
      await db.close();
    }
  });
});
