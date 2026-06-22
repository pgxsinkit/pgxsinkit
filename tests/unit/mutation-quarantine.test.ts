import { describe, expect, it, mock } from "bun:test";

import { demoSyncRegistry } from "@pgxsinkit/schema";

import { createMutationRuntime, type MutationDetail } from "../../packages/client/src/mutation";
import { generateLocalSchemaSql } from "../../packages/client/src/schema";
import { createFreshTestPGlite } from "../support/pglite";

// ADR-0006 decision 4 + ADR-0005 congestion cap: a flush failure is either transient
// (retryable `failed`) or permanent (terminal `quarantined`, surfaced, never retried).

const overlaySchemaSql = generateLocalSchemaSql(demoSyncRegistry);
const writeUrl = "http://localhost:3001";

async function createAuthorsRuntime(overrides: Partial<Parameters<typeof createMutationRuntime>[0]> = {}) {
  const db = await createFreshTestPGlite();
  await db.exec(overlaySchemaSql);

  const runtime = createMutationRuntime({
    db,
    registry: demoSyncRegistry,
    writeUrl,
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
          status: "conflicted",
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
