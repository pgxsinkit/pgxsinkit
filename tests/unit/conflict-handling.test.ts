import { describe, expect, it, mock } from "bun:test";

import { count, eq, sql } from "drizzle-orm";

import { getJournalTable, getOverlayTable, getSyncStateView } from "@pgxsinkit/client";
import { projectsSyncRegistry } from "@pgxsinkit/schema";

import { createMutationRuntime, type MutationDetail } from "../../packages/client/src/mutation";
import { generateLocalSchemaSql } from "../../packages/client/src/schema";
import { drizzleOver } from "../support/drizzle";
import { createFreshTestPGlite } from "../support/pglite";

// ADR-0015 Phase 4: the client side of a reject-if-stale conflict. A conflicted ack moves the
// mutation to the terminal `conflicted` status, KEEPS the optimistic Overlay (the user's edit is
// never silently lost), surfaces via onConflict + the sync-state view, and resolves as a NEW
// mutation; discard clears the overlay + the conflicted entry.

const schemaSql = generateLocalSchemaSql(projectsSyncRegistry);
const writeUrl = "http://localhost:3001";

const PROJECT_ID = "01963227-d4c7-72db-b858-0000000000aa";
const SYNCED_VERSION = "100";
const SERVER_VERSION = "200"; // the external writer advanced the row to here

async function createProjectsRuntime(onConflict?: (conflicted: MutationDetail[]) => void) {
  const db = await createFreshTestPGlite();
  await db.exec(schemaSql);
  await drizzleOver(db)
    .insert(projectsSyncRegistry.projects.localTable)
    .values({ id: PROJECT_ID, name: "seed", createdAtUs: BigInt(SYNCED_VERSION), updatedAtUs: BigInt(SYNCED_VERSION) });
  return {
    db,
    runtime: createMutationRuntime({
      db,
      registry: projectsSyncRegistry,
      writeUrl,
      ...(onConflict ? { onConflict } : {}),
    }),
  };
}

interface SentMutation {
  mutationId: string;
  tableName: string;
  mutationSeq: number;
  entityKey: Record<string, string>;
  baseServerVersion?: string;
}

/**
 * A mock server holding one row at SERVER_VERSION. A write whose base is behind that is rejected as
 * `conflicted`; a write with no base or a base that has caught up is acked (and bumps the version).
 */
function conflictAwareFetch() {
  let nextVersion = Number(SERVER_VERSION);
  const fetchMock = mock(async (_input: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { mutations: SentMutation[] };
    return new Response(
      JSON.stringify({
        acks: body.mutations.map((m) => {
          const stale = m.baseServerVersion != null && Number(m.baseServerVersion) < Number(SERVER_VERSION);
          if (stale) {
            return {
              tableName: m.tableName,
              entityKey: m.entityKey,
              mutationId: m.mutationId,
              mutationSeq: m.mutationSeq,
              status: "conflicted",
              serverUpdatedAtUs: SERVER_VERSION,
              conflictReason: "Stale write rejected by the reject-if-stale conflict policy (ADR-0015).",
              httpStatus: 409,
            };
          }
          nextVersion += 1;
          return {
            tableName: m.tableName,
            entityKey: m.entityKey,
            mutationId: m.mutationId,
            mutationSeq: m.mutationSeq,
            status: "acked",
            serverUpdatedAtUs: String(nextVersion),
          };
        }),
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  });
  return fetchMock;
}

async function withFetch<T>(fetchMock: unknown, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = fetchMock as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

async function readReadModel(db: Awaited<ReturnType<typeof createFreshTestPGlite>>) {
  const view = projectsSyncRegistry.projects.view!;
  const rows = await drizzleOver(db)
    .select({ name: view.name, overlayKind: view.overlay_kind })
    .from(view)
    .where(eq(view.id, PROJECT_ID));
  return rows[0];
}

async function readJournalStatus(db: Awaited<ReturnType<typeof createFreshTestPGlite>>, seq: number) {
  const journal = getJournalTable(projectsSyncRegistry, "projects");
  const rows = await drizzleOver(db)
    .select({
      status: journal.status,
      reason: journal.conflictReason,
      serverVersion: sql<string | null>`${journal.serverUpdatedAtUs}::text`.as("serverVersion"),
    })
    .from(journal)
    .where(eq(journal.mutationSeq, seq));
  return rows[0];
}

describe("reject-if-stale conflict handling (ADR-0015 Phase 4)", () => {
  it("moves a stale write to `conflicted`, KEEPS the overlay, and fires onConflict", async () => {
    const conflicted: MutationDetail[] = [];
    const { db, runtime } = await createProjectsRuntime((details) => {
      conflicted.push(...details);
    });

    try {
      await runtime.update("projects", { id: PROJECT_ID }, { name: "my edit" });
      await withFetch(conflictAwareFetch(), () => runtime.flush());

      // onConflict surfaced exactly the stale write.
      expect(conflicted).toHaveLength(1);
      expect(conflicted[0]?.mutationKind).toBe("update");
      expect(conflicted[0]?.conflictReason).toContain("reject-if-stale");

      // The journal row is terminal `conflicted`, carrying the server's current version + reason.
      const journal = await readJournalStatus(db, 1);
      expect(journal?.status).toBe("conflicted");
      expect(journal?.serverVersion).toBe(SERVER_VERSION);
      expect(journal?.reason).toContain("reject-if-stale");

      // The optimistic overlay is KEPT — the read model still shows the user's edit, not the synced
      // value, so the edit is never silently lost.
      const readModel = await readReadModel(db);
      expect(readModel?.name).toBe("my edit");
      expect(readModel?.overlayKind).toBe("pending_update");

      // The sync-state view surfaces the conflict.
      const syncStateView = getSyncStateView(projectsSyncRegistry, "projects");
      const syncState = await drizzleOver(db)
        .select({ conflictState: syncStateView.conflictState })
        .from(syncStateView)
        .where(eq(syncStateView["id"]!, PROJECT_ID));
      expect(syncState[0]?.conflictState).toContain("reject-if-stale");
    } finally {
      await db.close();
    }
  });

  it("discardConflict clears the overlay + conflicted entry, so the read model falls back to synced", async () => {
    const { db, runtime } = await createProjectsRuntime();

    try {
      await runtime.update("projects", { id: PROJECT_ID }, { name: "my edit" });
      await withFetch(conflictAwareFetch(), () => runtime.flush());

      // Sanity: the conflict is staged with a kept overlay.
      expect((await readReadModel(db))?.name).toBe("my edit");

      await runtime.discardConflict("projects", { id: PROJECT_ID });

      // The conflicted journal entry is gone...
      const journal = getJournalTable(projectsSyncRegistry, "projects");
      const journalCount = await drizzleOver(db)
        .select({ count: count() })
        .from(journal)
        .where(eq(journal["id"]!, PROJECT_ID));
      expect(journalCount[0]?.count).toBe(0);

      // ...and the overlay is cleared, so the read model falls back to the synced (server) value.
      const readModel = await readReadModel(db);
      expect(readModel?.name).toBe("seed");
      expect(readModel?.overlayKind).toBe("synced");
    } finally {
      await db.close();
    }
  });

  it("resolves a conflict as an ordinary new mutation that acks normally", async () => {
    const { db, runtime } = await createProjectsRuntime();

    try {
      await runtime.update("projects", { id: PROJECT_ID }, { name: "my edit" });
      await withFetch(conflictAwareFetch(), () => runtime.flush());
      expect((await readJournalStatus(db, 1))?.status).toBe("conflicted");

      // The external write syncs down (echo): the synced row catches up to SERVER_VERSION. The
      // resolution is now authored against the current server state.
      await drizzleOver(db)
        .update(projectsSyncRegistry.projects.localTable)
        .set({ name: "external", updatedAtUs: BigInt(SERVER_VERSION) })
        .where(eq(projectsSyncRegistry.projects.localTable.id, PROJECT_ID));

      // The user re-applies their edit — an ordinary new mutation. Its base resolves to the caught-up
      // synced version, so it is no longer stale and acks normally (no special transition).
      await runtime.update("projects", { id: PROJECT_ID }, { name: "my edit, retried" });
      await withFetch(conflictAwareFetch(), () => runtime.flush());

      const resolution = await readJournalStatus(db, 2);
      expect(resolution?.status).toBe("acked");

      // ...and the SUPERSEDED conflicted row (seq 1) is retired by the resolution, so the conflict
      // does not linger forever. Without this, conflict_state + conflictedCount would surface the
      // already-resolved conflict indefinitely.
      expect(await readJournalStatus(db, 1)).toBeUndefined();

      const syncStateView = getSyncStateView(projectsSyncRegistry, "projects");
      const syncState = await drizzleOver(db)
        .select({ conflictState: syncStateView.conflictState })
        .from(syncStateView)
        .where(eq(syncStateView["id"]!, PROJECT_ID));
      expect(syncState[0]?.conflictState ?? null).toBeNull();

      const stats = await runtime.readMutationStats("projects");
      expect(stats.conflictedCount).toBe(0);
    } finally {
      await db.close();
    }
  });

  it("retires a conflicted row via the reconcile-on-sync trigger when the resolver's echo lands first (regression)", async () => {
    // The race the `reconcileTable` retire alone cannot win: the resolution (a later acked write) is
    // cleared by the reconcile-on-sync TRIGGER the instant its echo lands. If that beats the
    // post-flush `reconcileTable` pass, the acked resolver is gone before reconcileTable's
    // supersede-retire can see it, and the conflicted row ORPHANS — its `conflict_state` surfaces a
    // resolved conflict forever. The trigger must do the retire itself (it has the echo context).
    const db = await createFreshTestPGlite();
    await db.exec(schemaSql);
    await drizzleOver(db)
      .insert(projectsSyncRegistry.projects.localTable)
      .values({
        id: PROJECT_ID,
        name: "seed",
        createdAtUs: BigInt(SYNCED_VERSION),
        updatedAtUs: BigInt(SYNCED_VERSION),
      });

    try {
      const entityKeyJson = JSON.stringify({ id: PROJECT_ID });
      const RESOLVER_VERSION = "201"; // the version the server assigned to the acked resolution

      const overlay = getOverlayTable(projectsSyncRegistry, "projects");
      const journal = getJournalTable(projectsSyncRegistry, "projects");
      // The kept optimistic overlay (the user's edit, preserved through the conflict).
      await drizzleOver(db)
        .insert(overlay)
        .values({
          id: PROJECT_ID,
          name: "my edit, retried",
          createdAtUs: BigInt(SYNCED_VERSION),
          updatedAtUs: BigInt(RESOLVER_VERSION),
          overlayKind: "pending_update",
          localUpdatedAtUs: RESOLVER_VERSION,
        } as typeof overlay.$inferInsert);
      // seq 1 — the stale write the server rejected: terminal `conflicted`, kept for resolution.
      await drizzleOver(db)
        .insert(journal)
        .values({
          mutationId: crypto.randomUUID(),
          id: PROJECT_ID,
          entityKeyJson,
          mutationSeq: 1,
          mutationKind: "update",
          status: "conflicted",
          baseServerVersion: SYNCED_VERSION,
          payloadJson: JSON.stringify({ name: "my edit" }),
          conflictReason: "reject-if-stale",
          serverUpdatedAtUs: SERVER_VERSION,
          enqueuedAtUs: SYNCED_VERSION,
          updatedAtUs: SYNCED_VERSION,
        } as typeof journal.$inferInsert);
      // seq 2 — the resolution (re-applied edit) the server ACKED; its echo is about to land.
      await drizzleOver(db)
        .insert(journal)
        .values({
          mutationId: crypto.randomUUID(),
          id: PROJECT_ID,
          entityKeyJson,
          mutationSeq: 2,
          mutationKind: "update",
          status: "acked",
          payloadJson: JSON.stringify({ name: "my edit, retried" }),
          serverUpdatedAtUs: RESOLVER_VERSION,
          enqueuedAtUs: RESOLVER_VERSION,
          ackedAtUs: RESOLVER_VERSION,
          updatedAtUs: RESOLVER_VERSION,
        } as typeof journal.$inferInsert);

      // The resolver's echo arrives: the synced row catches up to RESOLVER_VERSION, firing the
      // reconcile-on-sync trigger (the ONLY cleanup that runs here — reconcileTable never does).
      await drizzleOver(db)
        .update(projectsSyncRegistry.projects.localTable)
        .set({ name: "my edit, retried", updatedAtUs: BigInt(RESOLVER_VERSION) })
        .where(eq(projectsSyncRegistry.projects.localTable.id, PROJECT_ID));

      // Both journal rows are gone: seq 1 retired (the regression — it used to orphan), seq 2 cleared.
      const remaining = await drizzleOver(db)
        .select({ count: count() })
        .from(journal)
        .where(eq(journal["id"]!, PROJECT_ID));
      expect(remaining[0]?.count).toBe(0);

      // No conflict lingers in the convergence view, and the overlay (nothing owes it) is cleared, so
      // the read model is the converged server value.
      const syncStateView = getSyncStateView(projectsSyncRegistry, "projects");
      const syncState = await drizzleOver(db)
        .select({ count: count() })
        .from(syncStateView)
        .where(eq(syncStateView["id"]!, PROJECT_ID));
      expect(syncState[0]?.count).toBe(0);

      const readModel = await readReadModel(db);
      expect(readModel?.name).toBe("my edit, retried");
      expect(readModel?.overlayKind).toBe("synced");
    } finally {
      await db.close();
    }
  });
});
