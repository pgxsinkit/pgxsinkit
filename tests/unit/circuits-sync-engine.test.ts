import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import type { PGlite } from "@electric-sql/pglite";
import { boolean, text, uuid } from "drizzle-orm/pg-core";

import { syncCircuitsShapes, type ConvergenceBarrier } from "@pgxsinkit/client";
import { defineSyncRegistry, defineSyncTable, type StreamEnvelope } from "@pgxsinkit/contracts";

import { migrateSubscriptionMetadataTables } from "../../packages/client/src/sync/subscription-state";
import { createTablesFromSchema, drizzleOver } from "../support/drizzle";
import { createFreshTestPGlite } from "../support/pglite";

// The native read path end to end (ADR-0055 + ADR-0056): K durable-streams subscriptions through the
// edge, envelopes translated, folded, and applied into one PGlite table. Two properties are the
// reason this test exists rather than a unit one — that two shapes really do land in a single table
// (the shared tier's whole point), and that the engine barrier really does hold the boot commit when
// the engine has a computed-but-undelivered revocation.

const contentEntry = defineSyncTable({
  tableName: "offering_content",
  makeColumns: () => ({
    id: uuid("id").primaryKey(),
    offeringId: uuid("offering_id").notNull(),
    body: text("body").notNull(),
    published: boolean("published").notNull(),
  }),
  primaryKey: ["id"],
  mode: "readonly",
});

const registry = defineSyncRegistry({ tables: { content: contentEntry } });
const content = contentEntry.localTable;
const METADATA_SCHEMA = "pgxsinkit";

function envelope(id: string, offeringId: string): StreamEnvelope {
  return {
    type: "offering_content",
    key: id,
    value: { id, offering_id: offeringId, body: `body-${id}`, published: true },
    headers: { operation: "upsert" },
  };
}

/**
 * A durable-streams catch-up response carrying the headers the client reads off it.
 *
 * `upToDate: false` is a partial chunk — the server had more than it returned — so the client comes
 * back for the rest. That is what lets a test drive two deliveries out of one catch-up.
 */
function dsResponse(envelopes: StreamEnvelope[], offset: string, upToDate = true): Response {
  return new Response(JSON.stringify(envelopes), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "Stream-Next-Offset": offset,
      ...(upToDate ? { "Stream-Up-To-Date": "true" } : {}),
    },
  });
}

const OFF_A = "11111111-1111-4111-8111-111111111111";
const OFF_B = "22222222-2222-4222-8222-222222222222";
const ROW_1 = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const ROW_2 = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";

function stubEdge(bodies: Record<string, StreamEnvelope[]>): typeof fetch {
  return (async (input: URL | string) => {
    const path = new URL(String(input)).pathname;
    return dsResponse(bodies[path] ?? [], "0000000000000001");
  }) as unknown as typeof fetch;
}

/**
 * Serve a scripted sequence of responses, then park — as a real long-poll does when it has nothing
 * to send. Without the park a stub that answers instantly turns a live subscription into a hot loop.
 */
function parkAfter(responses: Response[]): typeof fetch {
  let index = 0;
  return (async () => {
    if (index < responses.length) return responses[index++]!;
    await Bun.sleep(30_000);
    return new Response("[]", { status: 200 });
  }) as unknown as typeof fetch;
}

async function settle(): Promise<void> {
  await Bun.sleep(150);
}

describe("circuits sync engine", () => {
  let pg: PGlite;

  beforeAll(async () => {
    pg = await createFreshTestPGlite();
    await createTablesFromSchema(pg, { content });
    await migrateSubscriptionMetadataTables({ pg, metadataSchema: METADATA_SCHEMA });
  });

  afterAll(async () => {
    await pg.close();
  });

  // The shared tier's whole point: one local table fed by several scope-keyed streams.
  it("applies two scope shapes into one local table", async () => {
    const barrier: ConvergenceBarrier = { sync: true, pendingFlips: 0, flipFailures: 0 };
    const handle = await syncCircuitsShapes({
      pg,
      registry,
      key: null,
      live: false,
      metadataSchema: METADATA_SCHEMA,
      readBarrier: async () => barrier,
      token: () => "t",
      fetch: stubEdge({
        "/shape/s1": [envelope(ROW_1, OFF_A)],
        "/shape/s2": [envelope(ROW_2, OFF_B)],
      }),
      shapes: {
        scopeA: {
          streamUrl: "http://edge/shape/s1",
          tableKey: "content",
          onMustRefetch: async () => {},
        },
        scopeB: {
          streamUrl: "http://edge/shape/s2",
          tableKey: "content",
          onMustRefetch: async () => {},
        },
      },
    });

    await settle();

    const rows = await drizzleOver(pg).select({ id: content.id, offeringId: content.offeringId }).from(content);
    expect(rows.map((r) => r.offeringId).sort()).toEqual([OFF_A, OFF_B]);
    handle.unsubscribe();

    await drizzleOver(pg).delete(content);
  });

  // Every stream can report drained while the engine still holds a computed revocation. A boot that
  // committed there would present a store claiming consistency while missing an eviction.
  //
  // Asserted causally rather than by timing: the barrier reports pending flips on EVERY read, so no
  // schedule exists in which the commit is merely late. Deleting the pendingFlips term from the gate
  // makes this fail.
  it("never commits while the barrier reports pending flips", async () => {
    const handle = await syncCircuitsShapes({
      pg,
      registry,
      key: null,
      metadataSchema: METADATA_SCHEMA,
      readBarrier: async () => ({ sync: true, pendingFlips: 2, flipFailures: 0 }),
      token: () => "t",
      fetch: parkAfter([dsResponse([envelope(ROW_1, OFF_A)], "0000000000000001", true)]),
      shapes: { scopeA: { streamUrl: "http://edge/shape/s1", tableKey: "content" } },
    });

    await settle();

    expect(await drizzleOver(pg).select({ id: content.id }).from(content)).toEqual([]);
    handle.unsubscribe();
    await drizzleOver(pg).delete(content);
  });

  // The release half: the batch held through an unsatisfied barrier is not lost, and commits in full
  // once the engine converges.
  it("commits the held batch once the barrier clears", async () => {
    let reads = 0;
    const handle = await syncCircuitsShapes({
      pg,
      registry,
      key: null,
      metadataSchema: METADATA_SCHEMA,
      // Unsatisfied on the first read, converged on every one after it.
      readBarrier: async () => ({ sync: true, pendingFlips: ++reads === 1 ? 2 : 0, flipFailures: 0 }),
      token: () => "t",
      fetch: parkAfter([
        dsResponse([envelope(ROW_1, OFF_A)], "0000000000000001", true),
        dsResponse([envelope(ROW_2, OFF_A)], "0000000000000002", true),
      ]),
      shapes: { scopeA: { streamUrl: "http://edge/shape/s1", tableKey: "content" } },
    });

    await settle();

    // Both rows — the first was HELD across the unsatisfied barrier rather than dropped.
    const rows = await drizzleOver(pg).select({ id: content.id }).from(content);
    expect(rows.map((r) => r.id).sort()).toEqual([ROW_1, ROW_2].sort());
    expect(reads).toBeGreaterThan(1);

    handle.unsubscribe();
    await drizzleOver(pg).delete(content);
  });

  // A poisoned engine is the one barrier reading that is NOT a delay. An abandoned flip batch
  // releases its permit on the way out, so `pendingFlips` is back to zero and `sync` is true — every
  // other term reports converged, forever — while the membership effect it carried is gone. Holding
  // would be indistinguishable from a slow engine, so the group refuses instead.
  //
  // Note the barrier here satisfies BOTH other terms: delete the flipFailures check and the gate
  // opens, the row lands, and no error is raised.
  it("refuses terminally when the engine reports lost membership effects", async () => {
    const errors: Error[] = [];
    const handle = await syncCircuitsShapes({
      pg,
      registry,
      key: null,
      metadataSchema: METADATA_SCHEMA,
      readBarrier: async () => ({ sync: true, pendingFlips: 0, flipFailures: 1 }),
      token: () => "t",
      onSyncError: (error) => errors.push(error),
      fetch: parkAfter([dsResponse([envelope(ROW_1, OFF_A)], "0000000000000001", true)]),
      shapes: { scopeA: { streamUrl: "http://edge/shape/s1", tableKey: "content" } },
    });

    await settle();

    expect(await drizzleOver(pg).select({ id: content.id }).from(content)).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toMatch(/lost 1 membership flip batch/);
    // And it stays refused — a degraded group must never report a consistent store.
    expect(handle.isUpToDate).toBe(false);

    handle.unsubscribe();
    await drizzleOver(pg).delete(content);
  });

  // The same condition the Electric engine's per-table lock enforced, stated as the requirement it
  // always was: co-tenant shapes need a scoped clear, because the default truncate takes the table.
  it("refuses shapes sharing a table without a scoped clear", async () => {
    const attempt = syncCircuitsShapes({
      pg,
      registry,
      key: null,
      live: false,
      metadataSchema: METADATA_SCHEMA,
      readBarrier: async () => ({ sync: true, pendingFlips: 0, flipFailures: 0 }),
      token: () => "t",
      fetch: stubEdge({}),
      shapes: {
        scopeA: { streamUrl: "http://edge/shape/s1", tableKey: "content" },
        scopeB: { streamUrl: "http://edge/shape/s2", tableKey: "content" },
      },
    });

    // oxlint-disable-next-line typescript/await-thenable -- bun-types gap: .rejects returns a real promise typed as void
    await expect(attempt).rejects.toThrow(/share table "content" without an onMustRefetch/);
  });
});
