import { describe, expect, it, mock } from "bun:test";

import { eq, sql } from "drizzle-orm";

import { getJournalTable } from "@pgxsinkit/client";
import { projectsSyncRegistry } from "@pgxsinkit/schema";

import { createMutationRuntime } from "../../packages/client/src/mutation";
import { generateLocalSchemaSql } from "../../packages/client/src/schema";
import { drizzleOver } from "../support/drizzle";
import { createFreshTestPGlite } from "../support/pglite";

// ADR-0015 Phase 1 — the Base server version capture rule (decision 2), proven in isolation BEFORE
// any server-side detection lands. A chain head (the first staged write on an entity) stamps the
// synced Server version it was authored against, so a genuine external write between view and apply
// is caught. A chained write stamps NULL at enqueue and resolves its base at flush from its acked
// predecessor — so an entity's OWN successive edits never self-conflict.

const schemaSql = generateLocalSchemaSql(projectsSyncRegistry);
const writeUrl = "http://localhost:3001";

const PROJECT_ID = "01963227-d4c7-72db-b858-000000000001";
const SYNCED_VERSION = "1000"; // the Server version the synced row was last observed at
const ACKED_VERSION = "2000"; // the Server version the server assigns when it acks m1

async function createProjectsRuntime() {
  const db = await createFreshTestPGlite();
  await db.exec(schemaSql);
  // Seed the synced read cache with one project at SYNCED_VERSION — the value the user "sees".
  await drizzleOver(db)
    .insert(projectsSyncRegistry.projects.localTable)
    .values({ id: PROJECT_ID, name: "seed", createdAtUs: BigInt(SYNCED_VERSION), updatedAtUs: BigInt(SYNCED_VERSION) });
  return { db, runtime: createMutationRuntime({ db, registry: projectsSyncRegistry, writeUrl }) };
}

interface SentMutation {
  mutationId: string;
  tableName: string;
  mutationSeq: number;
  kind: string;
  baseServerVersion?: string;
}

/** Captures every POSTed batch and acks each mutation, stamping ACKED_VERSION as the server version. */
function capturingAckFetch() {
  const batches: SentMutation[][] = [];
  const fetchMock = mock(async (_input: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { mutations: SentMutation[] };
    batches.push(body.mutations);
    return new Response(
      JSON.stringify({
        acks: body.mutations.map((m) => ({
          tableName: m.tableName,
          entityKey: { id: PROJECT_ID },
          mutationId: m.mutationId,
          mutationSeq: m.mutationSeq,
          status: "acked",
          serverUpdatedAtUs: ACKED_VERSION,
        })),
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  });
  return { fetchMock, batches };
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

async function readJournalBase(db: Awaited<ReturnType<typeof createFreshTestPGlite>>, mutationSeq: number) {
  const journal = getJournalTable(projectsSyncRegistry, "projects");
  const rows = await drizzleOver(db)
    .select({
      base: sql<string | null>`${journal.baseServerVersion}::text`.as("base"),
      kind: journal.mutationKind,
    })
    .from(journal)
    .where(eq(journal.mutationSeq, mutationSeq));
  return rows[0];
}

describe("Base server version capture (ADR-0015 Phase 1)", () => {
  it("stamps the chain head's base = the synced Server version at enqueue", async () => {
    const { db, runtime } = await createProjectsRuntime();

    try {
      await runtime.update("projects", { id: PROJECT_ID }, { name: "m1" });

      const m1 = await readJournalBase(db, 1);
      expect(m1?.kind).toBe("update");
      expect(m1?.base).toBe(SYNCED_VERSION);
    } finally {
      await db.close();
    }
  });

  it("leaves a chained write's base NULL at enqueue (resolved at flush)", async () => {
    const { db, runtime } = await createProjectsRuntime();

    try {
      await runtime.update("projects", { id: PROJECT_ID }, { name: "m1" });
      // m1 is still pending, so m2 chains onto it.
      await runtime.update("projects", { id: PROJECT_ID }, { name: "m2" });

      const m1 = await readJournalBase(db, 1);
      const m2 = await readJournalBase(db, 2);
      expect(m1?.base).toBe(SYNCED_VERSION);
      expect(m2?.base).toBeNull();
    } finally {
      await db.close();
    }
  });

  it("resolves a chained write's base to its acked predecessor's version — so the chain never self-conflicts", async () => {
    const { db, runtime } = await createProjectsRuntime();
    const { fetchMock, batches } = capturingAckFetch();

    try {
      await runtime.update("projects", { id: PROJECT_ID }, { name: "m1" });
      await runtime.update("projects", { id: PROJECT_ID }, { name: "m2" });

      // One flush() drains both: m1 sends first (per-entity serialization), is acked at ACKED_VERSION,
      // then m2 becomes eligible and resolves its base from m1's acked Server version.
      await withFetch(fetchMock, () => runtime.flush());

      const sent = batches.flat();
      const m1Envelope = sent.find((m) => m.mutationSeq === 1);
      const m2Envelope = sent.find((m) => m.mutationSeq === 2);

      // The chain head carries the version the user saw...
      expect(m1Envelope?.baseServerVersion).toBe(SYNCED_VERSION);
      // ...and the chained write carries its predecessor's *output* version, NOT the stale synced one,
      // so when the server compares current (== ACKED_VERSION) to base (== ACKED_VERSION) it is not stale.
      expect(m2Envelope?.baseServerVersion).toBe(ACKED_VERSION);
    } finally {
      await db.close();
    }
  });

  it("never sends a base on a create (its conflict is a PK collision, a separate concern)", async () => {
    const { db, runtime } = await createProjectsRuntime();
    const { fetchMock, batches } = capturingAckFetch();
    const NEW_ID = "01963227-d4c7-72db-b858-000000000002";

    try {
      await runtime.create("projects", { id: NEW_ID, name: "fresh" });
      await withFetch(fetchMock, () => runtime.flush());

      const createEnvelope = batches.flat().find((m) => m.kind === "create");
      expect(createEnvelope).toBeDefined();
      expect(createEnvelope?.baseServerVersion).toBeUndefined();
    } finally {
      await db.close();
    }
  });
});
