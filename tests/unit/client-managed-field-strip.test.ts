import { describe, expect, it, mock } from "bun:test";

import { bigint, uuid, varchar } from "drizzle-orm/pg-core";

import { defineSyncRegistry, defineSyncTable } from "@pgxsinkit/contracts";

import { createMutationRuntime } from "../../packages/client/src/mutation";
import { generateLocalSchemaSql } from "../../packages/client/src/schema";
import { createSchemaTestPGlite } from "../support/pglite";

// The CLIENT twin of the server's create-only-managed-field rule (tests/unit/update-managed-field-guard.test.ts):
// a field declared `applyOn: ["create"]` is stamped at birth and INERT on update — the generated apply
// function offers no UPDATE SET candidate for it and the write route 400-rejects an update payload that
// carries one. `stripManagedFields` must therefore drop EVERY managed field from an outgoing update, not
// just the update-managed ones, so a locally-authored patch can never round-trip to that rejection.
// (`SyncTableUpdateInput` states the same rule at the type level — pinned in tests/client-api-types.ts.)

const ownedRegistry = defineSyncRegistry({
  owned: defineSyncTable({
    tableName: "owned",
    makeColumns: () => ({
      id: uuid("id").primaryKey(),
      ownerId: uuid("owner_id"),
      note: varchar("note", { length: 200 }),
      updatedAtUs: bigint("updated_at_us", { mode: "bigint" }).notNull().default(0n),
    }),
    mode: "readwrite",
    conflictPolicy: "last-write-wins",
    governance: {
      managedFields: [
        // create-only: stamped once from the verified `sub` claim, inert thereafter.
        { column: "ownerId", applyOn: ["create"], strategy: "authClaim", claimPath: ["sub"] },
        { column: "updatedAtUs", applyOn: ["create", "update"], strategy: "nowMicroseconds" },
      ],
    },
  }),
});

const schemaSql = generateLocalSchemaSql(ownedRegistry);
const batchWriteUrl = "http://localhost:3001/api/mutations";
const OWNED_ID = "01963227-d4c7-72db-b858-00000000a001";
const OWNER_ID = "01963227-d4c7-72db-b858-00000000b001";

interface SentMutation {
  mutationId: string;
  tableName: string;
  mutationSeq: number;
  kind: string;
  entityKey: Record<string, string>;
  payload: Record<string, unknown>;
}

/** Captures every POSTed batch and acks it, so a drained flush keeps draining. */
function capturingAckFetch() {
  const sent: SentMutation[] = [];
  const fetchMock = mock(async (_input: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { mutations: SentMutation[] };
    sent.push(...body.mutations);
    return new Response(
      JSON.stringify({
        acks: body.mutations.map((m) => ({
          tableName: m.tableName,
          entityKey: m.entityKey,
          mutationId: m.mutationId,
          mutationSeq: m.mutationSeq,
          status: "acked",
          serverUpdatedAtUs: "2000",
        })),
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  });
  return { fetchMock, sent };
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

// The payloads below deliberately carry keys `SyncTableCreateInput`/`SyncTableUpdateInput` forbid — the
// point of these tests is what the RUNTIME does with a payload that reached it through an untyped path
// (a JS consumer, a hand-built batch), so they are smuggled past the input types on purpose.
function untyped<T>(payload: Record<string, unknown>): T {
  return payload as T;
}

describe("client-side managed-field stripping (twin of the server's write-route guards)", () => {
  it("strips a CREATE-ONLY managed field from an update payload, keeping the ordinary edit", async () => {
    const db = await createSchemaTestPGlite(schemaSql);
    const runtime = createMutationRuntime({ db, registry: ownedRegistry, batchWriteUrl });
    const { fetchMock, sent } = capturingAckFetch();

    try {
      await withFetch(fetchMock, async () => {
        await runtime.create("owned", { id: OWNED_ID, note: "first" });
        await runtime.flush("owned");
        await runtime.update(
          "owned",
          { id: OWNED_ID },
          untyped({
            note: "edited",
            ownerId: OWNER_ID, // create-only managed — the server would 400 this
            updatedAtUs: 1n, // update-managed — always stripped
          }),
        );
        await runtime.flush("owned");
      });

      const update = sent.find((m) => m.kind === "update");
      // Only the ordinary column survives; neither managed field reaches the wire. (The client strips by
      // property key, which is the only spelling a typed payload can carry; the server's sanitizer covers
      // the DB-column-name spelling too, for payloads it did not author.)
      expect(update?.payload).toEqual({ note: "edited" });
    } finally {
      await db.close();
    }
  });

  it("keeps the create path unchanged — a create-managed field is stripped there as before", async () => {
    const db = await createSchemaTestPGlite(schemaSql);
    const runtime = createMutationRuntime({ db, registry: ownedRegistry, batchWriteUrl });
    const { fetchMock, sent } = capturingAckFetch();

    try {
      await withFetch(fetchMock, async () => {
        await runtime.create(
          "owned",
          untyped({
            id: OWNED_ID,
            note: "new",
            ownerId: OWNER_ID,
            updatedAtUs: 1n,
          }),
        );
        await runtime.flush("owned");
      });

      const create = sent.find((m) => m.kind === "create");
      expect(create?.payload).toEqual({ id: OWNED_ID, note: "new" });
    } finally {
      await db.close();
    }
  });

  it("does not over-strip: an update carrying only ordinary keys reaches the wire intact", async () => {
    const db = await createSchemaTestPGlite(schemaSql);
    const runtime = createMutationRuntime({ db, registry: ownedRegistry, batchWriteUrl });
    const { fetchMock, sent } = capturingAckFetch();

    try {
      await withFetch(fetchMock, async () => {
        await runtime.create("owned", { id: OWNED_ID, note: "first" });
        await runtime.flush("owned");
        await runtime.update("owned", { id: OWNED_ID }, { note: "plain edit" });
        await runtime.flush("owned");
      });

      expect(sent.find((m) => m.kind === "update")?.payload).toEqual({ note: "plain edit" });
    } finally {
      await db.close();
    }
  });
});
