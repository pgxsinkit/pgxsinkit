import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import type { PGlite } from "@electric-sql/pglite";
import { boolean, text, uuid } from "drizzle-orm/pg-core";

import { startCircuitsSync } from "@pgxsinkit/client";
import {
  DENY_ALL_PREDICATE,
  defineSyncRegistry,
  defineSyncTable,
  p,
  type StreamEnvelope,
  type SyncTableRegistry,
} from "@pgxsinkit/contracts";
import {
  barrierPath,
  createBarrierHandler,
  createRefreshHandler,
  createReleaseHandler,
  createSubscribeHandler,
  importStreamTokenKey,
  refreshPath,
  releasePath,
  subscribePath,
  type CircuitsEngineClient,
  type EntitlementSet,
} from "@pgxsinkit/server";

import { migrateSubscriptionMetadataTables } from "../../packages/client/src/sync/subscription-state";
import { createTablesFromSchema, drizzleOver } from "../support/drizzle";
import { createFreshTestPGlite } from "../support/pglite";

// Native consistency-group orchestration against the REAL control-plane handlers: derive groups from
// the registry, subscribe each, and let the shared tier fan out. The property this exists for is the
// one fan-out creates and nothing else in the stack tests — every scope of a shape shares ONE local
// table, so a must-refetch on one scope must not take the others' rows with it.

const key = await importStreamTokenKey("group-sync-test-secret");
const METADATA_SCHEMA = "pgxsinkit";

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
  shape: { scope: (c) => [c.offeringId], where: (c) => p.eq(c.published, true) },
});

const registry = defineSyncRegistry({ tables: { content: contentEntry } });
const content = contentEntry.localTable;

// ADR-0021 §2's promotion subject: a `lazy + persistent` table, which once activated joins the eager
// set permanently. Its own registry, so the fan-out tests above keep their single-group shape.
const noteEntry = defineSyncTable({
  tableName: "offering_note",
  makeColumns: () => ({
    id: uuid("id").primaryKey(),
    body: text("body").notNull(),
  }),
  primaryKey: ["id"],
  mode: "readonly",
  subscription: "lazy",
  retention: "persistent",
});

const lazyRegistry = defineSyncRegistry({ tables: { note: noteEntry } });
const note = noteEntry.localTable;
/** The lazy table has no explicit consistency group, so its group key is its own shape key. */
const NOTE_GROUP = "offering_note";

/**
 * A PRIVATE-tier table, for the revocation the shared tier cannot express: a shape whose row filter
 * stops naming this subject at all. `denied` arrives as a deployment param rather than as mutable
 * module state, so a boot's answer is a property of the control plane it was handed.
 */
const draftEntry = defineSyncTable({
  tableName: "offering_draft",
  makeColumns: () => ({
    id: uuid("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    body: text("body").notNull(),
  }),
  primaryKey: ["id"],
  mode: "readonly",
  shape: {
    rowFilter: (c) => ({
      customPredicate: (claims, params) =>
        (params as { denied?: boolean } | undefined)?.denied === true
          ? DENY_ALL_PREDICATE
          : p.eq(c.ownerId, String(claims.sub)),
    }),
  },
});

const privateRegistry = defineSyncRegistry({ tables: { draft: draftEntry } });
const draft = draftEntry.localTable;
/** No explicit consistency group, so the group key is the shape key. */
const DRAFT_GROUP = "offering_draft";
const DRAFT_ROW = "dddddddd-1111-4111-8111-dddddddddddd";

const OFF_A = "11111111-1111-4111-8111-111111111111";
const OFF_B = "22222222-2222-4222-8222-222222222222";
const ROW_A1 = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const ROW_A2 = "aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa";
const ROW_B1 = "bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb";

function envelope(id: string, offeringId: string): StreamEnvelope {
  return {
    type: "offering_content",
    key: id,
    value: { id, offering_id: offeringId, body: `body-${id}`, published: true },
    headers: { operation: "upsert" },
  };
}

function entitlements(held: readonly string[]): EntitlementSet {
  return {
    ready: true,
    permits: (subject, shapeKey, scope) =>
      subject === "person-a" && shapeKey === "offering_content" && held.includes(String(scope[0])),
    scopesFor: (subject, shapeKey) =>
      subject === "person-a" && shapeKey === "offering_content" ? held.map((one) => [one]) : [],
  };
}

/**
 * A stub engine whose stream paths carry a generation prefix.
 *
 * That prefix is what makes a second boot a genuine re-subscribe: the control plane hands back a
 * DIFFERENT path for the same shape, which is exactly the native must-refetch trigger (ADR-0056
 * decision 7). A counter that restarted at 1 would hand back the same paths and test nothing.
 *
 * It also records what was RELEASED. Every grant is a refcount join, and `refcount > 0` blocks
 * dormancy and eviction, so a group that closes its session without giving its claims back pins its
 * shapes active forever.
 */
function stubEngine(generation: string): CircuitsEngineClient & { released: string[] } {
  const released: string[] = [];
  let next = 0;
  const scopeOf = (request: { where?: unknown }) => JSON.stringify(request.where ?? {});
  const assigned = new Map<string, string>();
  return {
    createShape: async (request) => {
      const fingerprint = scopeOf(request);
      let path = assigned.get(fingerprint);
      if (path === undefined) {
        next += 1;
        path = `shape/${generation}${next}`;
        assigned.set(fingerprint, path);
      }
      return {
        shapeId: path,
        table: request.table,
        streamPath: path,
        streamUrl: `http://ds/${path}`,
        subscription: request.subscription ?? "~minted",
        leaseSeconds: 1800,
      };
    },
    releaseShape: async (shapeId: string) => {
      released.push(shapeId);
    },
    replicationState: async () => ({ lsn: "0/0", pendingFlips: 0, flipFailures: 0 }),
    released,
  } as CircuitsEngineClient & { released: string[] };
}

/**
 * One fetch covering both planes: the real control-plane handlers, and a durable-streams stub for
 * the edge. `byOffering` decides what each stream carries — the router reads the offering out of the
 * grant order rather than the path, so a test names data by scope instead of by generated id.
 */
function router(options: {
  engine: CircuitsEngineClient;
  held: readonly string[];
  byOffering: Record<string, StreamEnvelope[]>;
  /** The registry this control plane serves. Defaults to the shared-tier fan-out one. */
  registry?: SyncTableRegistry;
  /** Runtime params handed to a private shape's `customPredicate` — how a boot withdraws its grant. */
  params?: Record<string, unknown>;
  /** What a SCOPELESS (private-tier) stream carries; the shared tier is keyed by offering instead. */
  unscoped?: StreamEnvelope[];
}): typeof fetch {
  const shared = {
    registry: options.registry ?? registry,
    engine: options.engine,
    entitlements: entitlements(options.held),
    key,
    ...(options.params ? { params: options.params } : {}),
  };
  const subscribe = createSubscribeHandler({ ...shared, resolveAuthClaims: () => ({ sub: "person-a" }) });
  const refresh = createRefreshHandler({ ...shared, resolveAuthClaims: () => ({ sub: "person-a" }) });
  const release = createReleaseHandler({
    engine: options.engine,
    key,
    resolveAuthClaims: () => ({ sub: "person-a" }),
  });
  const barrier = createBarrierHandler({ engine: options.engine, resolveAuthClaims: () => ({ sub: "person-a" }) });

  // streamPath -> offering, learned from the grants the control plane just issued.
  const offeringByPath = new Map<string, string>();

  return (async (url: string, init?: RequestInit) => {
    const request = new Request(url, init);
    const path = new URL(url).pathname;

    if (path === subscribePath) {
      const response = await subscribe(request);
      // Read the body ONCE and re-wrap it. `clone()` tees the stream, and a tee whose halves are
      // consumed at different times is a deadlock waiting to happen in a test that then waits on the
      // consumer it starved.
      const text = await response.text();
      const body = JSON.parse(text) as { granted?: { scope?: string[]; streamPath: string }[] };
      for (const grant of body.granted ?? []) {
        if (grant.scope?.[0] != null) offeringByPath.set(grant.streamPath, grant.scope[0]);
      }
      return new Response(text, { status: response.status, headers: response.headers });
    }
    if (path === refreshPath) return refresh(request);
    if (path === releasePath) return release(request);
    if (path === barrierPath) return barrier(request);

    const streamPath = path.replace(/^\/+/, "");
    const offering = offeringByPath.get(streamPath);
    const envelopes = offering != null ? (options.byOffering[offering] ?? []) : (options.unscoped ?? []);
    return new Response(JSON.stringify(envelopes), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "Stream-Next-Offset": "0000000000000001",
        "Stream-Up-To-Date": "true",
      },
    });
  }) as unknown as typeof fetch;
}

const base = {
  registry,
  controlPlaneUrl: "http://api",
  streamBaseUrl: "http://edge",
  metadataSchema: METADATA_SCHEMA,
  live: false as const,
};

async function settle(): Promise<void> {
  await Bun.sleep(150);
}

/**
 * A control plane that cannot be reached at all — every request fails at the socket. That is what an
 * offline reopen looks like from inside `subscribeWithRetry`: it never throws to its caller, it just
 * keeps retrying, so any start awaiting it stays pending for as long as the network is down.
 */
const unreachable = (() => Promise.reject(new TypeError("Failed to fetch"))) as unknown as typeof fetch;

/**
 * What `promise` did within `ms` — `"pending"` when it did nothing, which is the only honest way to
 * assert that something must NOT resolve. The timer is always cleared, so a passing test leaves none.
 */
async function outcomeWithin(promise: Promise<unknown>, ms: number): Promise<"settled" | "rejected" | "pending"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<"pending">((resolve) => {
    timer = setTimeout(() => resolve("pending"), ms);
  });
  const outcome = await Promise.race([
    promise.then(
      () => "settled" as const,
      () => "rejected" as const,
    ),
    expiry,
  ]);
  clearTimeout(timer);
  return outcome;
}

describe("circuits group sync", () => {
  let pg: PGlite;

  beforeAll(async () => {
    pg = await createFreshTestPGlite();
    await createTablesFromSchema(pg, { content, note, draft });
    await migrateSubscriptionMetadataTables({ pg, metadataSchema: METADATA_SCHEMA });
  });

  afterAll(async () => {
    await pg.close();
  });

  it("fans one shared shape out to a stream per entitled scope, into one table", async () => {
    const sync = await startCircuitsSync(pg, {
      ...base,
      fetch: router({
        engine: stubEngine("a"),
        held: [OFF_A, OFF_B],
        byOffering: { [OFF_A]: [envelope(ROW_A1, OFF_A)], [OFF_B]: [envelope(ROW_B1, OFF_B)] },
      }),
    });
    await settle();

    const rows = await drizzleOver(pg).select({ id: content.id, offeringId: content.offeringId }).from(content);
    expect(rows.map((r) => r.offeringId).sort()).toEqual([OFF_A, OFF_B].sort());
    expect(sync.groupKeys()).toEqual(["offering_content"]);
    expect(sync.isTableStarted("content")).toBe(true);

    sync.unsubscribe();
    await drizzleOver(pg).delete(content);
  });

  // A group's lifecycle and its session's are the same object, and that has a second half: stopping a
  // group must give its ENGINE claims back, not merely drop its streams. Every grant is a `POST
  // /shapes` join, and `refcount > 0` blocks both dormancy and eviction — precisely because native
  // reads terminate on durable-streams and the engine cannot see them — so a stop that released
  // nothing would pin these shapes active and tailer-maintained for the life of the deployment.
  it("releases the engine claims a stopped group acquired", async () => {
    const engine = stubEngine("g");
    const sync = await startCircuitsSync(pg, {
      ...base,
      fetch: router({
        engine,
        held: [OFF_A, OFF_B],
        byOffering: { [OFF_A]: [envelope(ROW_A1, OFF_A)], [OFF_B]: [envelope(ROW_B1, OFF_B)] },
      }),
    });
    await settle();
    // Nothing yet: a running group is holding exactly the claims it should be.
    expect(engine.released).toEqual([]);

    sync.stopGroup("offering_content");
    await settle();

    // One release per GRANT. The fan-out took two joins, so it gives two back.
    expect([...engine.released].sort()).toEqual(["shape/g1", "shape/g2"]);

    // And the teardown behind it does not release a second time — a double release would decrement a
    // refcount this session no longer owns, which is another subscriber's claim.
    sync.unsubscribe();
    await settle();
    expect(engine.released).toHaveLength(2);

    await drizzleOver(pg).delete(content);
  });

  // The whole reason a fan-out needs a scoped clear. Both scopes are re-subscribed onto NEW stream
  // paths, so both must-refetch; if either clear truncated the table rather than its own scope, the
  // other's rows would be gone.
  //
  // Drop the derived `onMustRefetch` and this does not merely lose rows — the group is REFUSED at
  // construction, because a fan-out always shares a table and `assertScopedClearsForSharedTables`
  // makes the scoped clear structurally mandatory rather than conventional.
  it("clears only its own scope on a must-refetch", async () => {
    const first = await startCircuitsSync(pg, {
      ...base,
      fetch: router({
        engine: stubEngine("a"),
        held: [OFF_A, OFF_B],
        byOffering: { [OFF_A]: [envelope(ROW_A1, OFF_A)], [OFF_B]: [envelope(ROW_B1, OFF_B)] },
      }),
    });
    await settle();
    first.unsubscribe();

    // A fresh generation of stream paths: every grant's handle differs from the persisted one, so
    // every scope re-snapshots. Scope A's content CHANGES (A1 -> A2) so a stale row would show.
    const second = await startCircuitsSync(pg, {
      ...base,
      fetch: router({
        engine: stubEngine("b"),
        held: [OFF_A, OFF_B],
        byOffering: { [OFF_A]: [envelope(ROW_A2, OFF_A)], [OFF_B]: [envelope(ROW_B1, OFF_B)] },
      }),
    });
    await settle();

    const rows = await drizzleOver(pg).select({ id: content.id }).from(content);
    // A's old row is gone, A's new row landed, and B — cleared by its OWN scope only — still has its row.
    expect(rows.map((r) => r.id).sort()).toEqual([ROW_A2, ROW_B1].sort());

    second.unsubscribe();
    await drizzleOver(pg).delete(content);
  });

  // A boot must not hang on an entitlement the subject simply does not hold.
  //
  // It also reports both KINDS of loss, which is why `refused` has three entries and not one. The
  // control plane refuses the shape once ("no entitled scopes" — an answer about the request), and
  // the reconcile separately clears the two scopes the previous boots persisted and names each of
  // them (an answer about the store). Only the second kind tells an app WHICH offering's rows just
  // disappeared, so a caller that reacts per scope needs it; a cleared reader the control plane
  // already named by scope would be reported once, not twice.
  it("reports ready when the subject is granted nothing", async () => {
    const refused: string[] = [];
    const sync = await startCircuitsSync(pg, {
      ...base,
      onRefused: (entries) => refused.push(...entries.map((entry) => entry.reason)),
      fetch: router({ engine: stubEngine("c"), held: [], byOffering: {} }),
    });

    expect(refused).toEqual(["no entitled scopes", "no longer granted at subscribe", "no longer granted at subscribe"]);
    expect(sync.isGroupReady("offering_content")).toBe(true);
    await sync.groupReady("offering_content");

    sync.unsubscribe();
  });

  /**
   * Boot the lazy registry with its group already PROMOTED, against a control plane that cannot be
   * reached — an offline reopen after a previous session activated the group. Boot starts the group
   * (ADR-0021 §2) and is released by its first failed subscribe attempt, leaving the retry loop
   * running and nothing ever ready.
   */
  async function startOfflinePromoted(): Promise<Awaited<ReturnType<typeof startCircuitsSync>>> {
    const subscribeErrors: Error[] = [];
    const sync = await startCircuitsSync(pg, {
      ...base,
      registry: lazyRegistry,
      promotedGroups: new Set([NOTE_GROUP]),
      onSubscribeError: (error) => subscribeErrors.push(error),
      fetch: unreachable,
    });
    // The precondition for everything below: boot came back with NO subscription, still retrying.
    expect(subscribeErrors.length).toBeGreaterThan(0);
    expect(sync.isGroupReady(NOTE_GROUP)).toBe(false);
    return sync;
  }

  // A promoted group's rows are durable and local, so a reference to one must be answerable NOW — the
  // offline reopen is the exact state promotion exists to serve (ADR-0021 §2). Awaiting the boot start
  // would instead park the read on a subscribe that only resolves when the network returns.
  it("a promoted group is readable while its boot subscribe is still retrying", async () => {
    const sync = await startOfflinePromoted();

    expect(await outcomeWithin(sync.ensureGroupStarted(NOTE_GROUP), 100)).toBe("settled");
    // "Started" = a durable subscription for it exists, which is what a read needs to know.
    expect(sync.isTableStarted("note")).toBe(true);
    // Started is NOT caught up, and the two must stay separable: `hydrating` reads THIS one.
    expect(sync.isGroupReady(NOTE_GROUP)).toBe(false);

    sync.unsubscribe();
  });

  // A desync truncates the local copy, so the premise the promotion fast path rests on is gone with
  // it: the group is HELD again. Its next reference must go through the real activation path — which
  // offline cannot complete — instead of resolving instantly against a subscription that no longer
  // exists, and it must not claim to be started meanwhile.
  it("stopGroup returns a promoted group to held", async () => {
    const sync = await startOfflinePromoted();
    expect(sync.isTableStarted("note")).toBe(true);

    sync.stopGroup(NOTE_GROUP);
    expect(sync.isTableStarted("note")).toBe(false);

    const activation = sync.ensureGroupStarted(NOTE_GROUP);
    expect(await outcomeWithin(activation, 300)).toBe("pending");
    // Still held: a re-activation in flight over a truncated table is not a readable table.
    expect(sync.isTableStarted("note")).toBe(false);

    sync.unsubscribe();
    // Teardown abandons the activation mid-retry, so it never settles. Detached here so a future
    // change that makes it reject cannot surface as an unhandled rejection in an unrelated test.
    void activation.catch(() => {});
  });

  // ── Revocation discovered at subscribe (ADR-0055 decision 6) ────────────────────────────────────
  // Losing entitlement means losing the subscription, and a revocation that lands while the client is
  // OFFLINE has no 403 to deliver it: the next boot simply subscribes and is granted less. Nothing in
  // the start path noticed — the grants only ever describe what SURVIVED — so the previous session's
  // rows stayed readable forever. The persisted cursor is the only thing that still remembers them.

  // The scope keeps its rows only for as long as it keeps its grant, and the clear has to land before
  // anything reports ready: a group that announced readiness first would hand the app one render of a
  // store showing rows the subject may no longer read.
  it("clears a scope that is no longer granted before the group reports ready", async () => {
    await drizzleOver(pg).delete(content);
    // ONE engine across both boots, so a still-granted scope is handed back the SAME stream path and
    // resumes rather than re-snapshotting — otherwise a must-refetch would be doing this test's work.
    const engine = stubEngine("d");
    const createdPaths: string[] = [];
    const recording = {
      ...engine,
      createShape: async (request: Parameters<CircuitsEngineClient["createShape"]>[0]) => {
        const handle = await engine.createShape(request);
        createdPaths.push(handle.streamPath);
        return handle;
      },
    } as CircuitsEngineClient;

    const first = await startCircuitsSync(pg, {
      ...base,
      fetch: router({
        engine: recording,
        held: [OFF_A, OFF_B],
        byOffering: { [OFF_A]: [envelope(ROW_A1, OFF_A)], [OFF_B]: [envelope(ROW_B1, OFF_B)] },
      }),
    });
    await settle();
    expect((await drizzleOver(pg).select({ id: content.id }).from(content)).map((r) => r.id).sort()).toEqual(
      [ROW_A1, ROW_B1].sort(),
    );
    first.unsubscribe();

    // ENQUEUED from inside the ready callback, and that is what makes it an ordering assertion rather
    // than a re-read: PGlite runs one connection FIFO, so this select sees everything committed before
    // ready was announced and nothing committed after it.
    const idsAtReady: Promise<string[]>[] = [];
    const second = await startCircuitsSync(pg, {
      ...base,
      onGroupReady: () => {
        idsAtReady.push(
          drizzleOver(pg)
            .select({ id: content.id })
            .from(content)
            .then((rows) => rows.map((r) => r.id).sort()),
        );
      },
      fetch: router({
        engine: recording,
        held: [OFF_A],
        byOffering: { [OFF_A]: [envelope(ROW_A1, OFF_A)] },
      }),
    });
    await settle();

    // B is gone, A is untouched — the clear was scoped, exactly as a must-refetch's would be.
    expect((await drizzleOver(pg).select({ id: content.id }).from(content)).map((r) => r.id)).toEqual([ROW_A1]);
    expect(await Promise.all(idsAtReady)).toEqual([[ROW_A1]]);
    // A RESUMED: the second boot was handed the same stream it persisted, so nothing re-snapshotted.
    expect(createdPaths).toEqual(["shape/d1", "shape/d2", "shape/d1"]);

    second.unsubscribe();
    await drizzleOver(pg).delete(content);
  });

  // The private tier's form of the same loss. There is no scope to subtract here — a scope-less shape
  // is its table's sole occupant — so the clear is the whole table, and the group still has to report
  // ready over it rather than hanging on a shape it was refused.
  it("truncates a private shape denied at the next boot, and still reports ready", async () => {
    const draftRow: StreamEnvelope = {
      type: "offering_draft",
      key: DRAFT_ROW,
      value: { id: DRAFT_ROW, owner_id: "person-a", body: "draft body" },
      headers: { operation: "upsert" },
    };
    const privateBase = { ...base, registry: privateRegistry };

    const first = await startCircuitsSync(pg, {
      ...privateBase,
      fetch: router({
        engine: stubEngine("e"),
        held: [],
        byOffering: {},
        registry: privateRegistry,
        unscoped: [draftRow],
      }),
    });
    await first.groupReady(DRAFT_GROUP);
    expect(await drizzleOver(pg).select({ id: draft.id }).from(draft)).toHaveLength(1);
    first.unsubscribe();

    // Enqueued from inside the callback, same FIFO ordering argument as above: `onRefused` is the app's
    // cue to react, so the rows must already be gone by the time it fires (see
    // `CircuitsGroupSyncOptions.onRefused`).
    const refusedWith: Promise<{ reason: string; rows: number }[]>[] = [];
    const second = await startCircuitsSync(pg, {
      ...privateBase,
      onRefused: (entries) => {
        refusedWith.push(
          drizzleOver(pg)
            .select({ id: draft.id })
            .from(draft)
            .then((rows) => entries.map((entry) => ({ reason: entry.reason, rows: rows.length }))),
        );
      },
      fetch: router({
        engine: stubEngine("f"),
        held: [],
        byOffering: {},
        registry: privateRegistry,
        params: { denied: true },
      }),
    });
    await second.groupReady(DRAFT_GROUP);
    await settle();

    expect(await drizzleOver(pg).select({ id: draft.id }).from(draft)).toEqual([]);
    expect(second.isGroupReady(DRAFT_GROUP)).toBe(true);
    expect(await Promise.all(refusedWith)).toEqual([
      [{ reason: 'shape "offering_draft" denies this caller', rows: 0 }],
    ]);

    second.unsubscribe();
    await drizzleOver(pg).delete(draft);
  });
});
