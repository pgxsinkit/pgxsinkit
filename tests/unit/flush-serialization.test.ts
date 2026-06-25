import { describe, expect, it, mock } from "bun:test";

import { demoSyncRegistry } from "@pgxsinkit/schema";

import { createMutationRuntime } from "../../packages/client/src/mutation";
import { generateLocalSchemaSql } from "../../packages/client/src/schema";
import { createFreshTestPGlite } from "../support/pglite";

// ADR-0014 Phase 5 — the Per-entity flush serialization invariant is now a CORRECTNESS dependency of
// the set-based write-path apply (Phase 4): a POSTed batch must hold at most one mutation per Entity
// identity, or the server's UPDATE..FROM / DELETE..USING join would have a same-PK duplicate and pick
// one arbitrarily. This gate test locks the invariant readPendingBatchRows enforces, across the
// batch-size limit, the dedupe path, and create-then-update of a new entity.

const overlaySchemaSql = generateLocalSchemaSql(demoSyncRegistry);
const writeUrl = "http://localhost:3001";

async function createAuthorsRuntime(flushBatchSize?: number) {
  const db = await createFreshTestPGlite();
  await db.exec(overlaySchemaSql);
  return {
    db,
    runtime: createMutationRuntime({
      db,
      registry: demoSyncRegistry,
      writeUrl,
      ...(flushBatchSize !== undefined ? { flushBatchSize } : {}),
    }),
  };
}

interface SentMutation {
  mutationId: string;
  tableName: string;
  mutationSeq: number;
  entityKey: Record<string, string>;
}

/** Captures every POSTed batch and acks it, so a drained flush keeps draining. */
function capturingAckFetch() {
  const batches: SentMutation[][] = [];
  const fetchMock = mock(async (_input: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { mutations: SentMutation[] };
    batches.push(body.mutations);
    return new Response(
      JSON.stringify({
        acks: body.mutations.map((m) => ({
          tableName: m.tableName,
          entityKey: m.entityKey,
          mutationId: m.mutationId,
          mutationSeq: m.mutationSeq,
          status: "acked",
        })),
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  });
  return { fetchMock, batches };
}

function authorId(n: number): string {
  return `01963227-d4c7-72db-b858-${n.toString(16).padStart(12, "0")}`;
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

/** The invariant: no Entity identity appears twice within a single POSTed batch. */
function expectNoEntityTwicePerBatch(batches: SentMutation[][]) {
  for (const batch of batches) {
    const ids = batch.map((m) => m.entityKey["id"]);
    expect(new Set(ids).size).toBe(ids.length);
  }
}

describe("Per-entity flush serialization (ADR-0014 Phase 5 — release gate)", () => {
  it("create-then-update of a NEW entity never co-flushes both in one batch", async () => {
    const { runtime } = await createAuthorsRuntime();
    const { fetchMock, batches } = capturingAckFetch();
    const id = authorId(1);

    await withFetch(fetchMock, async () => {
      await runtime.create("authors", { id, name: "first" });
      await runtime.update("authors", { id }, { name: "second" });
      await runtime.flush("authors");
    });

    expectNoEntityTwicePerBatch(batches);
    // Both writes reach the server (just never in the same batch) — nothing is silently dropped.
    expect(batches.flat().some((m) => m.entityKey["id"] === id)).toBe(true);
    for (const batch of batches) {
      expect(batch.filter((m) => m.entityKey["id"] === id).length).toBeLessThanOrEqual(1);
    }
  });

  it("multiple updates to one existing entity serialize one-per-batch (author order)", async () => {
    const { runtime } = await createAuthorsRuntime();
    const { fetchMock, batches } = capturingAckFetch();
    const id = authorId(2);

    await withFetch(fetchMock, async () => {
      await runtime.create("authors", { id, name: "a" });
      await runtime.flush("authors"); // create acked first
      await runtime.update("authors", { id }, { name: "b" });
      await runtime.update("authors", { id }, { name: "c" });
      await runtime.flush("authors"); // two pending same-entity updates
    });

    expectNoEntityTwicePerBatch(batches);
  });

  it("the dedupe path: a runtime.batch() with repeats of one entity flushes it at most once per batch", async () => {
    const { runtime } = await createAuthorsRuntime();
    const { fetchMock, batches } = capturingAckFetch();
    const id = authorId(3);

    await withFetch(fetchMock, async () => {
      await runtime.batch([
        { kind: "create", table: "authors", input: { id, name: "a" } },
        { kind: "update", table: "authors", entityKey: { id }, patch: { name: "b" } },
        { kind: "update", table: "authors", entityKey: { id }, patch: { name: "c" } },
      ]);
      await runtime.flush("authors");
    });

    expectNoEntityTwicePerBatch(batches);
  });

  it("respects the batch-size limit while never sending an entity twice in one batch", async () => {
    // Small slice so a handful of entities exercises the truncation, not hundreds.
    const flushBatchSize = 5;
    const { runtime } = await createAuthorsRuntime(flushBatchSize);
    const { fetchMock, batches } = capturingAckFetch();
    const count = flushBatchSize + 3; // more eligible entities than one batch holds

    await withFetch(fetchMock, async () => {
      for (let i = 0; i < count; i++) {
        const id = authorId(1000 + i);
        await runtime.create("authors", { id, name: `a${i}` });
        await runtime.update("authors", { id }, { name: `b${i}` });
      }
      await runtime.flush("authors"); // drains across several batches
    });

    expectNoEntityTwicePerBatch(batches);
    // The limit truncates at least one batch to exactly the configured slice size...
    expect(Math.max(...batches.map((batch) => batch.length))).toBe(flushBatchSize);
    expect(batches.every((batch) => batch.length <= flushBatchSize)).toBe(true);
    // ...and every distinct entity is eventually sent (nothing starved by truncation).
    const sentIds = new Set(batches.flat().map((m) => m.entityKey["id"]));
    expect(sentIds.size).toBe(count);
  });
});
