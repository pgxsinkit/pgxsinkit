import { describe, expect, it, mock } from "bun:test";

import { count, eq } from "drizzle-orm";

import { getJournalTable, getOverlayTable } from "@pgxsinkit/client";
import { demoSyncRegistry } from "@pgxsinkit/schema";

import { createMutationRuntime, type MutationDetail } from "../../packages/client/src/mutation";
import { generateLocalSchemaSql } from "../../packages/client/src/schema";
import { drizzleOver } from "../support/drizzle";
import { createSchemaTestPGlite } from "../support/pglite";

// ADR-0006 decision 4 + ADR-0005 congestion cap: a flush failure is either transient
// (retryable `failed`) or permanent (terminal `quarantined`, surfaced, never retried).

const overlaySchemaSql = generateLocalSchemaSql(demoSyncRegistry);
const batchWriteUrl = "http://localhost:3001/api/mutations";

async function createAuthorsRuntime(overrides: Partial<Parameters<typeof createMutationRuntime>[0]> = {}) {
  const db = await createSchemaTestPGlite(overlaySchemaSql);

  const runtime = createMutationRuntime({
    db,
    registry: demoSyncRegistry,
    batchWriteUrl,
    ...overrides,
  });

  return { db, runtime };
}

/** A batch response where every mutation is rejected with the given HTTP status. */
function rejectingFetch(httpStatus: number, conflictReason = "structural rejection") {
  return mock(async (_input: unknown, init?: { body?: unknown }) => {
    const bodyText = typeof init?.body === "string" ? init.body : null;
    const requestBody = bodyText
      ? (JSON.parse(bodyText) as { mutations: Array<{ mutationId: string }> })
      : { mutations: [] };

    return new Response(
      JSON.stringify({
        acks: requestBody.mutations.map((mutation) => ({
          mutationId: mutation.mutationId,
          // A non-acked ack carrying a 4xx httpStatus is the structural-rejection signal the failure
          // branch quarantines (ADR-0006). NOT `conflicted` — that is now the distinct stale-write
          // outcome (ADR-0015), routed to the kept-overlay terminal state, never quarantine.
          status: "failed",
          httpStatus,
          conflictReason,
        })),
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  });
}

/** A batch response that fails at the transport level with a non-ok HTTP status. */
function transportErrorFetch(httpStatus: number) {
  return mock(async () => new Response("upstream unavailable", { status: httpStatus }));
}

/**
 * A 400 whole-batch validation rejection that *attributes* the fault to the named mutations
 * (the real server's behaviour: an atomic batch, one structurally-invalid member, the
 * culprits named in `rejections`).
 */
function attributedRejectFetch(rejectedEntityIds: string[], reason = "includes a server-managed field") {
  const rejected = new Set(rejectedEntityIds);
  return mock(async (_input: unknown, init?: { body?: unknown }) => {
    const bodyText = typeof init?.body === "string" ? init.body : "{}";
    const requestBody = JSON.parse(bodyText) as {
      mutations: Array<{
        mutationId: string;
        tableName: string;
        mutationSeq: number;
        entityKey: Record<string, string>;
      }>;
    };

    // Model the real server's atomic batch: any structurally-invalid member 400s the whole
    // batch, naming the culprits; an all-valid batch is applied and 200-acked.
    const rejections = requestBody.mutations
      .filter((mutation) => rejected.has(mutation.entityKey["id"]!))
      .map((mutation) => ({
        tableName: mutation.tableName,
        mutationId: mutation.mutationId,
        mutationSeq: mutation.mutationSeq,
        reason,
      }));

    if (rejections.length > 0) {
      return new Response(JSON.stringify({ message: "Payload validation failed", rejections }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(
      JSON.stringify({
        acks: requestBody.mutations.map((mutation) => ({
          tableName: mutation.tableName,
          entityKey: mutation.entityKey,
          mutationId: mutation.mutationId,
          mutationSeq: mutation.mutationSeq,
          status: "acked",
        })),
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  });
}

describe("mutation quarantine (ADR-0006)", () => {
  it("quarantines a structural 4xx rejection, surfaces it, and never retries it", async () => {
    const quarantined: MutationDetail[][] = [];
    const { db, runtime } = await createAuthorsRuntime({
      onQuarantine: (details) => {
        quarantined.push(details);
      },
    });

    const fetchMock = rejectingFetch(422, "column does not exist");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      await runtime.create("authors", { id: "01963227-d4c7-72db-b858-f89f6af80001", name: "Quarantine me" });
      await runtime.flush("authors");

      const stats = await runtime.readMutationStats("authors");
      expect(stats.quarantinedCount).toBe(1);
      expect(stats.failedCount).toBe(0);

      const [detail] = await runtime.readMutationDetails("authors");
      expect(detail?.status).toBe("quarantined");
      expect(detail?.lastHttpStatus).toBe(422);
      expect(detail?.nextRetryAtUs).toBeNull(); // terminal — no scheduled retry

      // Surfaced exactly once, with the quarantined detail.
      expect(quarantined).toHaveLength(1);
      expect(quarantined[0]?.[0]?.status).toBe("quarantined");

      // A second flush must not re-send a terminal mutation.
      const callsAfterFirst = fetchMock.mock.calls.length;
      await runtime.flush("authors");
      expect(fetchMock.mock.calls.length).toBe(callsAfterFirst);
      void db;
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("keeps a transient 5xx failure retryable (not quarantined)", async () => {
    const { runtime } = await createAuthorsRuntime();

    const fetchMock = transportErrorFetch(503);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      await runtime.create("authors", { id: "01963227-d4c7-72db-b858-f89f6af80002", name: "Retry me" });
      await runtime.flush("authors");

      const stats = await runtime.readMutationStats("authors");
      expect(stats.failedCount).toBe(1);
      expect(stats.quarantinedCount).toBe(0);

      const [detail] = await runtime.readMutationDetails("authors");
      expect(detail?.status).toBe("failed");
      expect(detail?.lastHttpStatus).toBe(503);
      expect(detail?.nextRetryAtUs).not.toBeNull(); // a backoff is scheduled
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("keeps a batch-level 4xx retryable — does not quarantine unattributed writes", async () => {
    const { runtime } = await createAuthorsRuntime();

    // The whole POST fails with a structural-looking 4xx (e.g. a stray 404 / 413 / malformed
    // envelope) that the server did NOT attribute to a specific mutation. Quarantining the
    // batch here would permanently kill valid offline writes, so it must stay retryable.
    const fetchMock = transportErrorFetch(404);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      await runtime.create("authors", { id: "01963227-d4c7-72db-b858-f89f6af80004", name: "Valid write" });
      await runtime.flush("authors");

      const stats = await runtime.readMutationStats("authors");
      expect(stats.quarantinedCount).toBe(0);
      expect(stats.failedCount).toBe(1);

      const [detail] = await runtime.readMutationDetails("authors");
      expect(detail?.status).toBe("failed");
      expect(detail?.lastHttpStatus).toBe(404);
      expect(detail?.nextRetryAtUs).not.toBeNull(); // retried with backoff, not terminal
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("attributes a structural 400 to the named mutation only — innocent siblings flush", async () => {
    const quarantined: MutationDetail[][] = [];
    const { runtime } = await createAuthorsRuntime({
      onQuarantine: (details) => {
        quarantined.push(details);
      },
    });

    const poisonId = "01963227-d4c7-72db-b858-f89f6af80010";
    const innocentId = "01963227-d4c7-72db-b858-f89f6af80011";

    // The atomic batch 400s because of one poison mutation; the server names it. The flush
    // drain then re-sends the innocent sibling alone, which the (now-valid) batch 200-acks.
    const fetchMock = attributedRejectFetch([poisonId]);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      await runtime.create("authors", { id: poisonId, name: "Poison" });
      await runtime.create("authors", { id: innocentId, name: "Innocent" });

      await runtime.flush("authors");

      const details = await runtime.readMutationDetails("authors");
      const poison = details.find((detail) => detail.entityKey["id"] === poisonId);
      const innocent = details.find((detail) => detail.entityKey["id"] === innocentId);

      // The named mutation is terminally quarantined; the unrelated sibling is NOT dragged
      // down with it — it flushed successfully on its own. One bad write never poisons the queue.
      expect(poison?.status).toBe("quarantined");
      expect(poison?.nextRetryAtUs).toBeNull();
      expect(innocent?.status).toBe("acked");

      const stats = await runtime.readMutationStats("authors");
      expect(stats.quarantinedCount).toBe(1);
      expect(stats.failedCount).toBe(0);

      // Surfaced exactly once, only for the quarantined poison.
      expect(quarantined).toHaveLength(1);
      expect(quarantined[0]).toHaveLength(1);
      expect(quarantined[0]?.[0]?.entityKey["id"]).toBe(poisonId);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("quarantines a still-failing mutation once it hits the hard attempt cap", async () => {
    const { runtime } = await createAuthorsRuntime({ maxMutationAttempts: 2 });

    const fetchMock = transportErrorFetch(503);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      await runtime.create("authors", { id: "01963227-d4c7-72db-b858-f89f6af80003", name: "Give up on me" });

      // Attempt 1: a transient 5xx -> failed (under the cap).
      await runtime.flush("authors");
      expect((await runtime.readMutationStats("authors")).failedCount).toBe(1);

      // retryFailed re-queues without resetting attempt_count; attempt 2 hits the cap.
      await runtime.retryFailed("authors");
      await runtime.flush("authors");

      const stats = await runtime.readMutationStats("authors");
      expect(stats.quarantinedCount).toBe(1);
      expect(stats.failedCount).toBe(0);
      expect((await runtime.readMutationDetails("authors"))[0]?.attemptCount).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("stamps each enqueued mutation with the registry fingerprint it was authored under", async () => {
    const { runtime } = await createAuthorsRuntime({ registryVersion: "fp-abc123" });

    await runtime.create("authors", { id: "01963227-d4c7-72db-b858-f89f6af80004", name: "Stamped" });

    const [detail] = await runtime.readMutationDetails("authors");
    expect(detail?.registryVersion).toBe("fp-abc123");
  });

  it("blocks a later same-entity mutation behind a quarantined prerequisite", async () => {
    const { runtime } = await createAuthorsRuntime();

    const fetchMock = rejectingFetch(400, "bad create");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      const authorId = "01963227-d4c7-72db-b858-f89f6af80005";
      await runtime.create("authors", { id: authorId, name: "First" });
      await runtime.update("authors", { id: authorId }, { name: "Second" });

      // First flush sends only the create (the update is ordered behind it); create -> quarantined.
      await runtime.flush("authors");
      const callsAfterFirst = fetchMock.mock.calls.length;

      // Second flush must not send the update: its prerequisite create is quarantined.
      await runtime.flush("authors");
      expect(fetchMock.mock.calls.length).toBe(callsAfterFirst);

      const details = await runtime.readMutationDetails("authors");
      const createDetail = details.find((d) => d.mutationKind === "create");
      const updateDetail = details.find((d) => d.mutationKind === "update");
      expect(createDetail?.status).toBe("quarantined");
      expect(updateDetail?.status).toBe("pending"); // still queued, never sent
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ADR-0006 addendum (2026-07-06): `discardQuarantined` closes the disposition asymmetry — quarantine
// now has a real rollback, exactly symmetric to `discardConflict`. Clearing the quarantined journal
// rows + kept overlay removes the phantom optimistic row from the read model and unblocks a later
// same-entity write. Consumers no longer need to mis-route a permanent policy denial (e.g. RLS 42501)
// to `conflicted` purely to borrow `discardConflict`'s rollback.
describe("discardQuarantined (ADR-0006 — symmetric rollback)", () => {
  const authorsView = demoSyncRegistry.authors.view!;

  async function readReadModel(db: Awaited<ReturnType<typeof createSchemaTestPGlite>>, id: string) {
    const rows = await drizzleOver(db)
      .select({ name: authorsView.name, overlayKind: authorsView.overlay_kind })
      .from(authorsView)
      .where(eq(authorsView.id, id));
    return rows[0];
  }

  async function journalCount(db: Awaited<ReturnType<typeof createSchemaTestPGlite>>, id: string) {
    const journal = getJournalTable(demoSyncRegistry, "authors");
    const rows = await drizzleOver(db).select({ c: count() }).from(journal).where(eq(journal["id"]!, id));
    return rows[0]?.c ?? 0;
  }

  it("rolls back a quarantined create — phantom row gone, journal cleared, a re-create is accepted", async () => {
    const { db, runtime } = await createAuthorsRuntime();
    const id = "01963227-d4c7-72db-b858-f89f6af8d001";

    const originalFetch = globalThis.fetch;
    globalThis.fetch = rejectingFetch(422, "structural rejection") as unknown as typeof fetch;
    try {
      await runtime.create("authors", { id, name: "Quarantine me" });
      await runtime.flush("authors");

      // The optimistic overlay is KEPT — the phantom row is visible in the read model.
      expect(await readReadModel(db, id)).toEqual({ name: "Quarantine me", overlayKind: "pending_create" });
      expect((await runtime.readMutationStats("authors")).quarantinedCount).toBe(1);

      await runtime.discardQuarantined("authors", { id });

      // (a) the phantom row is gone from the read model...
      expect(await readReadModel(db, id)).toBeUndefined();
      // (b) ...and the quarantined journal rows are deleted.
      expect(await journalCount(db, id)).toBe(0);
      expect((await runtime.readMutationStats("authors")).quarantinedCount).toBe(0);

      // (c) a subsequent create for the SAME entity is accepted, not blocked behind the quarantined head.
      await runtime.create("authors", { id, name: "Re-created" });
      expect(await readReadModel(db, id)).toEqual({ name: "Re-created", overlayKind: "pending_create" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("rolls back a quarantined update — read model falls back to synced, a re-update is accepted", async () => {
    const { db, runtime } = await createAuthorsRuntime();
    const id = "01963227-d4c7-72db-b858-f89f6af8d002";

    // A synced (server) row present, so the update has a base to fall back to on discard.
    await drizzleOver(db)
      .insert(demoSyncRegistry.authors.localTable)
      .values({ id, name: "synced", createdAtUs: 100n, updatedAtUs: 100n });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = rejectingFetch(422, "structural rejection") as unknown as typeof fetch;
    try {
      await runtime.update("authors", { id }, { name: "my edit" });
      await runtime.flush("authors");

      expect(await readReadModel(db, id)).toEqual({ name: "my edit", overlayKind: "pending_update" });
      expect((await runtime.readMutationStats("authors")).quarantinedCount).toBe(1);

      await runtime.discardQuarantined("authors", { id });

      // The overlay is cleared, so the read model falls back to the synced (server) value.
      expect(await readReadModel(db, id)).toEqual({ name: "synced", overlayKind: "synced" });
      expect(await journalCount(db, id)).toBe(0);

      // A subsequent update is accepted (no longer chained onto the quarantined head).
      await runtime.update("authors", { id }, { name: "re-edited" });
      expect(await readReadModel(db, id)).toEqual({ name: "re-edited", overlayKind: "pending_update" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("owed-guard: keeps the overlay when a still-pending later write depends on it", async () => {
    const { db, runtime } = await createAuthorsRuntime();
    const id = "01963227-d4c7-72db-b858-f89f6af8d003";

    const originalFetch = globalThis.fetch;
    globalThis.fetch = rejectingFetch(400, "bad create") as unknown as typeof fetch;
    try {
      await runtime.create("authors", { id, name: "First" });
      // A later same-entity update stays `pending` — blocked behind the quarantined create prerequisite.
      await runtime.update("authors", { id }, { name: "Second" });
      await runtime.flush("authors");

      const details = await runtime.readMutationDetails("authors");
      expect(details.find((d) => d.mutationKind === "create")?.status).toBe("quarantined");
      expect(details.find((d) => d.mutationKind === "update")?.status).toBe("pending");

      await runtime.discardQuarantined("authors", { id });

      // The quarantined create journal row is gone, but the still-pending update remains...
      const after = await runtime.readMutationDetails("authors");
      expect(after).toHaveLength(1);
      expect(after[0]?.mutationKind).toBe("update");
      expect(after[0]?.status).toBe("pending");
      // ...and the overlay is KEPT because that pending write still owes the entity (the merged
      // create-then-update overlay carries the latest value "Second" under the create disposition).
      expect(await readReadModel(db, id)).toEqual({ name: "Second", overlayKind: "pending_create" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("no-op safety: leaves a non-quarantined (pending) entity untouched", async () => {
    const { db, runtime } = await createAuthorsRuntime();
    const id = "01963227-d4c7-72db-b858-f89f6af8d004";

    // A plain pending create — never flushed, so never quarantined.
    await runtime.create("authors", { id, name: "Pending only" });

    // Plus a manually-staged `conflicted` journal row on a DIFFERENT entity, to prove the status
    // filter — discardQuarantined must not retire conflicted rows either.
    const conflictedId = "01963227-d4c7-72db-b858-f89f6af8d005";
    const journal = getJournalTable(demoSyncRegistry, "authors");
    await drizzleOver(db)
      .insert(journal)
      .values({
        id: conflictedId,
        mutationId: crypto.randomUUID(),
        entityKeyJson: JSON.stringify({ id: conflictedId }),
        mutationSeq: 99,
        mutationKind: "update",
        status: "conflicted",
        registryVersion: "test-registry",
        payloadJson: "{}",
        enqueuedAtUs: "1",
        updatedAtUs: "1",
      } as never);
    const overlay = getOverlayTable(demoSyncRegistry, "authors");

    await runtime.discardQuarantined("authors", { id });

    // The pending entity is untouched: its journal row and overlay survive.
    expect(await journalCount(db, id)).toBe(1);
    expect(await readReadModel(db, id)).toEqual({ name: "Pending only", overlayKind: "pending_create" });
    // The conflicted row is untouched too.
    expect(await journalCount(db, conflictedId)).toBe(1);
    void overlay;
  });
});
