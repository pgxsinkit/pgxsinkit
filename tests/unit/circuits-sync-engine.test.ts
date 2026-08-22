import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import type { PGlite } from "@electric-sql/pglite";
import { asc, eq } from "drizzle-orm";
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
const ROW_3 = "cccccccc-3333-4333-8333-cccccccccccc";

/**
 * The identity a shape is persisted under. Required on every spec: the map key is a name the caller
 * mints, so the cursor carries the registry shape (and, for the shared tier, the scope) that a later
 * subscribe resolves a stored entry back to.
 */
const SOLE = { shapeKey: "offering_content" } as const;
const SCOPE_A = { shapeKey: "offering_content", scope: [OFF_A] } as const;
const SCOPE_B = { shapeKey: "offering_content", scope: [OFF_B] } as const;

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
    const barrier: ConvergenceBarrier = { pendingFlips: 0, flipFailures: 0 };
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
          identity: { shapeKey: "offering_content", scope: [OFF_A] },
          onMustRefetch: async () => {},
        },
        scopeB: {
          streamUrl: "http://edge/shape/s2",
          tableKey: "content",
          identity: { shapeKey: "offering_content", scope: [OFF_B] },
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
      readBarrier: async () => ({ pendingFlips: 2, flipFailures: 0 }),
      token: () => "t",
      fetch: parkAfter([dsResponse([envelope(ROW_1, OFF_A)], "0000000000000001", true)]),
      shapes: { scopeA: { streamUrl: "http://edge/shape/s1", tableKey: "content", identity: SOLE } },
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
      readBarrier: async () => ({ pendingFlips: ++reads === 1 ? 2 : 0, flipFailures: 0 }),
      token: () => "t",
      fetch: parkAfter([
        dsResponse([envelope(ROW_1, OFF_A)], "0000000000000001", true),
        dsResponse([envelope(ROW_2, OFF_A)], "0000000000000002", true),
      ]),
      shapes: { scopeA: { streamUrl: "http://edge/shape/s1", tableKey: "content", identity: SOLE } },
    });

    await settle();

    // Both rows — the first was HELD across the unsatisfied barrier rather than dropped.
    const rows = await drizzleOver(pg).select({ id: content.id }).from(content);
    expect(rows.map((r) => r.id).sort()).toEqual([ROW_1, ROW_2].sort());
    expect(reads).toBeGreaterThan(1);

    handle.unsubscribe();
    await drizzleOver(pg).delete(content);
  });

  // A degraded engine is the one barrier reading that is NOT a delay. An abandoned flip batch keeps
  // its `pendingFlips` count held forever, so waiting on it is indistinguishable from waiting on a
  // slow engine — the effects it carried are gone and no restart-free future makes them land. The
  // group must therefore refuse terminally: no commit now, no commit on any later delivery, and one
  // error telling the operator the engine has to be restarted.
  //
  // The barrier below is exactly what this engine reports after a loss — the abandoned batch pins
  // `pendingFlips` above zero permanently. Deleting the flipFailures term makes this fail: the group
  // would hold on that pending count silently and forever, raising nothing, which is precisely the
  // indistinguishable-from-a-slow-engine state the term exists to break.
  it("refuses terminally when the barrier reports lost flips", async () => {
    const errors: Error[] = [];
    const handle = await syncCircuitsShapes({
      pg,
      registry,
      key: null,
      metadataSchema: METADATA_SCHEMA,
      readBarrier: async () => ({ pendingFlips: 3, flipFailures: 1 }),
      token: () => "t",
      onSyncError: (error) => errors.push(error),
      fetch: parkAfter([
        dsResponse([envelope(ROW_1, OFF_A)], "0000000000000001", true),
        dsResponse([envelope(ROW_2, OFF_A)], "0000000000000002", true),
      ]),
      shapes: { scopeA: { streamUrl: "http://edge/shape/s1", tableKey: "content", identity: SOLE } },
    });

    await settle();

    // Neither the batch that was held when the loss surfaced nor the delivery after it.
    expect(await drizzleOver(pg).select({ id: content.id }).from(content)).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toMatch(/abandoned 1 membership flip batch/);
    expect(errors[0]!.message).toMatch(/degraded/);
    expect(errors[0]!.message).toMatch(/must be restarted/);
    // And it stays refused — a degraded group must never report a consistent store.
    expect(handle.isUpToDate).toBe(false);

    handle.unsubscribe();
    await drizzleOver(pg).delete(content);
  });

  // The native must-refetch (ADR-0056 d6). The client is handed a different stream for the same
  // shape — an eviction, a deletion, a close, all end here — and the offset it persisted addresses
  // the OLD stream, where it means nothing. So it re-snapshots, and the previous stream's rows are
  // cleared in the same transaction the new ones land in.
  //
  // Delete the handle comparison and this fails twice over: the stale row survives, and the offset
  // from a foreign stream is replayed against the new one.
  it("re-snapshots when the granted handle differs from the persisted one", async () => {
    const barrier: ConvergenceBarrier = { pendingFlips: 0, flipFailures: 0 };
    const common = {
      pg,
      registry,
      key: "sub-handle",
      live: false as const,
      metadataSchema: METADATA_SCHEMA,
      readBarrier: async () => barrier,
      token: () => "t",
    };

    const first = await syncCircuitsShapes({
      ...common,
      fetch: stubEdge({ "/shape/s1": [envelope(ROW_1, OFF_A)] }),
      shapes: { scopeA: { streamUrl: "http://edge/shape/s1", tableKey: "content", identity: SOLE } },
    });
    await settle();
    expect((await drizzleOver(pg).select({ id: content.id }).from(content)).map((r) => r.id)).toEqual([ROW_1]);
    first.unsubscribe();

    // Same subscription, same shape name — a NEW stream path.
    const offsets: (string | null)[] = [];
    const second = await syncCircuitsShapes({
      ...common,
      fetch: (async (input: URL | string) => {
        offsets.push(new URL(String(input)).searchParams.get("offset"));
        return dsResponse([envelope(ROW_2, OFF_B)], "0000000000000009");
      }) as unknown as typeof fetch,
      shapes: { scopeA: { streamUrl: "http://edge/shape/s2", tableKey: "content", identity: SOLE } },
    });
    await settle();

    // The old stream's row is gone, not merged with the new one's.
    expect((await drizzleOver(pg).select({ id: content.id }).from(content)).map((r) => r.id)).toEqual([ROW_2]);
    // And it read the new stream from the start rather than replaying a foreign offset.
    expect(offsets[0]).toBe("-1");

    second.unsubscribe();
    await drizzleOver(pg).delete(content);
  });

  // The bulk backfill tier loads a leading run of upserts onto an empty table with a statement that
  // cannot express ON CONFLICT, so what it needs is DISTINCT primary keys. A fresh client reads from
  // `-1` and the stream is append-only, so on the two-verb wire (ADR-0058) every revision of a row is
  // its own `upsert` envelope: the leading run of a first delivery repeats the key of anything that
  // was ever updated. Folding the run to its net rows is what supplies distinctness; without it the
  // first updated row is a duplicate-key failure that retries, exhausts, and degrades EVERY fresh
  // client of a stack where any synced row has ever been updated.
  //
  // The trailing distinct key matters for the `copy` lane: COPY hands the run's last row back to the
  // remainder, which would mask a repeat sitting at the very tail.
  it.each(["json", "copy"] as const)(
    "a fresh subscription replaying a stream that repeats a key commits the last value (%s)",
    async (initialInsertMethod) => {
      await drizzleOver(pg).delete(content);
      const errors: Error[] = [];
      const handle = await syncCircuitsShapes({
        pg,
        registry,
        key: null,
        metadataSchema: METADATA_SCHEMA,
        maxCommitRetries: 1,
        readBarrier: async () => ({ pendingFlips: 0, flipFailures: 0 }),
        token: () => "t",
        onSyncError: (error) => errors.push(error),
        fetch: parkAfter([
          dsResponse(
            [
              envelope(ROW_1, OFF_A),
              envelope(ROW_2, OFF_A),
              // The same key again, at a later revision — an UPDATE on the server.
              envelope(ROW_1, OFF_B),
              envelope(ROW_3, OFF_A),
            ],
            "0000000000000001",
            true,
          ),
        ]),
        shapes: {
          scopeA: { streamUrl: "http://edge/shape/s1", tableKey: "content", identity: SOLE, initialInsertMethod },
        },
      });

      await settle();

      expect(errors).toEqual([]);
      // One row per key, and the repeated key holds the LAST value the stream stated.
      expect(
        await drizzleOver(pg)
          .select({ id: content.id, offeringId: content.offeringId })
          .from(content)
          .orderBy(asc(content.id)),
      ).toEqual([
        { id: ROW_1, offeringId: OFF_B },
        { id: ROW_2, offeringId: OFF_A },
        { id: ROW_3, offeringId: OFF_A },
      ]);
      expect(handle.isUpToDate).toBe(true);

      handle.unsubscribe();
      await drizzleOver(pg).delete(content);
    },
  );

  // The same condition the Electric engine's per-table lock enforced, stated as the requirement it
  // always was: co-tenant shapes need a scoped clear, because the default truncate takes the table.
  it("refuses shapes sharing a table without a scoped clear", async () => {
    const attempt = syncCircuitsShapes({
      pg,
      registry,
      key: null,
      live: false,
      metadataSchema: METADATA_SCHEMA,
      readBarrier: async () => ({ pendingFlips: 0, flipFailures: 0 }),
      token: () => "t",
      fetch: stubEdge({}),
      shapes: {
        scopeA: { streamUrl: "http://edge/shape/s1", tableKey: "content", identity: SOLE },
        scopeB: { streamUrl: "http://edge/shape/s2", tableKey: "content", identity: SOLE },
      },
    });

    // oxlint-disable-next-line typescript/await-thenable -- bun-types gap: .rejects returns a real promise typed as void
    await expect(attempt).rejects.toThrow(/share table "content" without an onMustRefetch/);
  });
  // ── The post-clear residue assertion (the ADR-0014 replacement check) ────────────────────────
  // ADR-0014's primary-key collision was a tripwire on the replication machinery, and the state it
  // could actually catch was stale rows the client should no longer hold — which it noticed only
  // indirectly, when the server later re-sent one of those keys as a plain `insert`. The wire has no
  // `insert` any more, so the invariant is asserted at the clear that is responsible for it.
  describe("post-clear residue", () => {
    // A function, not a const: `pg` is assigned in beforeAll, which runs AFTER this describe body, so
    // capturing it here would bind `undefined`.
    const common = () => ({
      pg,
      registry,
      live: false as const,
      metadataSchema: METADATA_SCHEMA,
      readBarrier: async () => ({ pendingFlips: 0, flipFailures: 0 }),
      token: () => "t",
      maxCommitRetries: 1,
    });

    /** Subscribe once so a handle is persisted, then re-subscribe on a NEW stream — a must-refetch. */
    async function reSnapshotWith(
      key: string,
      onMustRefetch: NonNullable<Parameters<typeof syncCircuitsShapes>[0]["shapes"][string]["onMustRefetch"]>,
    ): Promise<Error | undefined> {
      const first = await syncCircuitsShapes({
        ...common(),
        key,
        fetch: stubEdge({ "/shape/s1": [envelope(ROW_1, OFF_A)] }),
        shapes: { solo: { streamUrl: "http://edge/shape/s1", tableKey: "content", identity: SOLE, onMustRefetch } },
      });
      await settle();
      first.unsubscribe();

      let failure: Error | undefined;
      const second = await syncCircuitsShapes({
        ...common(),
        key,
        onSyncError: (error) => {
          failure = error;
        },
        fetch: stubEdge({ "/shape/s2": [envelope(ROW_2, OFF_B)] }),
        shapes: { solo: { streamUrl: "http://edge/shape/s2", tableKey: "content", identity: SOLE, onMustRefetch } },
      });
      await settle();
      second.unsubscribe();
      return failure;
    }

    it("surfaces an onMustRefetch that leaves rows behind on a sole-occupant table", async () => {
      await drizzleOver(pg).delete(content);
      const failure = await reSnapshotWith("sub-residue-bad", async () => {
        // Clears nothing — the under-clearing bug this check exists to catch.
      });

      expect(failure?.message).toMatch(/the clear was incomplete/);
      expect(failure?.message).toContain('shape "solo"');
      await drizzleOver(pg).delete(content);
    });

    it("passes an onMustRefetch that actually clears, and lands the new snapshot", async () => {
      await drizzleOver(pg).delete(content);
      const failure = await reSnapshotWith("sub-residue-good", async (db) => {
        await db.delete(content);
      });

      expect(failure).toBeUndefined();
      expect((await drizzleOver(pg).select({ id: content.id }).from(content)).map((r) => r.id)).toEqual([ROW_2]);
      await drizzleOver(pg).delete(content);
    });

    // The check is deliberately NOT applied when a table is shared: a scoped clear leaves its
    // co-tenants' rows in place by design, and the client holds no scope predicate to subtract them
    // with. What carries the shared case is the scoped-clear requirement, not a check here.
    it("does not fire for a shared table, where a scoped clear leaves co-tenant rows standing", async () => {
      await drizzleOver(pg).delete(content);
      const key = "sub-residue-shared";
      // Only scopeA re-snapshots (scopeB keeps its handle), and its clear removes only its own row.
      const clearA = async (db: ReturnType<typeof drizzleOver>) => {
        await db.delete(content).where(eq(content.offeringId, OFF_A));
      };
      const clearB = async () => {};

      const first = await syncCircuitsShapes({
        ...common(),
        key,
        fetch: stubEdge({ "/shape/a1": [envelope(ROW_1, OFF_A)], "/shape/b1": [envelope(ROW_2, OFF_B)] }),
        shapes: {
          scopeA: { streamUrl: "http://edge/shape/a1", tableKey: "content", identity: SCOPE_A, onMustRefetch: clearA },
          scopeB: { streamUrl: "http://edge/shape/b1", tableKey: "content", identity: SCOPE_B, onMustRefetch: clearB },
        },
      });
      await settle();
      first.unsubscribe();

      let failure: Error | undefined;
      const second = await syncCircuitsShapes({
        ...common(),
        key,
        onSyncError: (error) => {
          failure = error;
        },
        fetch: stubEdge({ "/shape/a2": [envelope(ROW_1, OFF_A)], "/shape/b1": [] }),
        shapes: {
          scopeA: { streamUrl: "http://edge/shape/a2", tableKey: "content", identity: SCOPE_A, onMustRefetch: clearA },
          scopeB: { streamUrl: "http://edge/shape/b1", tableKey: "content", identity: SCOPE_B, onMustRefetch: clearB },
        },
      });
      await settle();
      second.unsubscribe();

      expect(failure).toBeUndefined();
      // Both rows stand: scopeA re-delivered its own, scopeB's was never touched.
      expect(
        (await drizzleOver(pg).select({ id: content.id }).from(content).orderBy(asc(content.id))).map((r) => r.id),
      ).toEqual([ROW_1, ROW_2]);
      await drizzleOver(pg).delete(content);
    });
  });
});
