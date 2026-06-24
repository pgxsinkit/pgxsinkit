import { describe, expect, it, mock } from "bun:test";

import { projectsSyncRegistry } from "@pgxsinkit/schema";

import { createMutationRuntime, type MutationDetail } from "../../packages/client/src/mutation";
import { generateLocalSchemaSql } from "../../packages/client/src/schema";
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
  await db.query(
    `INSERT INTO projects (id, name, created_at_us, updated_at_us) VALUES ($1, 'seed', $2::bigint, $2::bigint)`,
    [PROJECT_ID, SYNCED_VERSION],
  );
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
  const result = await db.query<{ name: string; overlayKind: string }>(
    `SELECT name, overlay_kind AS "overlayKind" FROM projects_read_model WHERE id = $1`,
    [PROJECT_ID],
  );
  return result.rows[0];
}

async function readJournalStatus(db: Awaited<ReturnType<typeof createFreshTestPGlite>>, seq: number) {
  const result = await db.query<{ status: string; reason: string | null; serverVersion: string | null }>(
    `SELECT status, conflict_reason AS reason, server_updated_at_us::text AS "serverVersion"
     FROM projects_mutations WHERE mutation_seq = $1`,
    [seq],
  );
  return result.rows[0];
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
      const syncState = await db.query<{ conflictState: string | null }>(
        `SELECT conflict_state AS "conflictState" FROM projects_sync_state WHERE id = $1`,
        [PROJECT_ID],
      );
      expect(syncState.rows[0]?.conflictState).toContain("reject-if-stale");
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
      const journalCount = await db.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM projects_mutations WHERE id = $1`,
        [PROJECT_ID],
      );
      expect(journalCount.rows[0]?.count).toBe(0);

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
      await db.query(`UPDATE projects SET name = 'external', updated_at_us = $2::bigint WHERE id = $1`, [
        PROJECT_ID,
        SERVER_VERSION,
      ]);

      // The user re-applies their edit — an ordinary new mutation. Its base resolves to the caught-up
      // synced version, so it is no longer stale and acks normally (no special transition).
      await runtime.update("projects", { id: PROJECT_ID }, { name: "my edit, retried" });
      await withFetch(conflictAwareFetch(), () => runtime.flush());

      const resolution = await readJournalStatus(db, 2);
      expect(resolution?.status).toBe("acked");
    } finally {
      await db.close();
    }
  });
});
