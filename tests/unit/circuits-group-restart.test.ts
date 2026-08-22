import { expect, it } from "bun:test";

import { eq } from "drizzle-orm";
import { boolean, text, uuid } from "drizzle-orm/pg-core";

import { openSubscriptionSession, startCircuitsSync } from "@pgxsinkit/client";
import { defineSyncRegistry, defineSyncTable, p, type StreamEnvelope } from "@pgxsinkit/contracts";
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

// The mid-session recovery (backlog 0010, ADR-0056 decision 7's live half). A read that ends under a
// live subscription has no way back on its own — `stream()`'s own error hook wraps only the OPENING
// request, so every later long-poll dies on the response's `closed` promise with nobody listening —
// and the group is the only layer that can re-subscribe, because the subscribe answer is what says
// what the subject may still read.
//
// Every test here drives real control-plane handlers and a real PGlite; the edge is a fetch stub
// whose per-path read COUNT is the script. Nothing waits on a clock: completion is signalled by
// deferreds the stub resolves, so the only timing in play is the restart ladder's own backoff.

const key = await importStreamTokenKey("group-restart-test-secret");
const METADATA_SCHEMA = "pgxsinkit";

/** A PRIVATE-tier shape: no scope, so the subject is the whole of its authorization. */
const draftEntry = defineSyncTable({
  tableName: "restart_draft",
  makeColumns: () => ({
    id: uuid("id").primaryKey(),
    body: text("body").notNull(),
    published: boolean("published").notNull(),
  }),
  primaryKey: ["id"],
  mode: "readonly",
  shape: { where: (c) => p.eq(c.published, true) },
});
const privateRegistry = defineSyncRegistry({ tables: { draft: draftEntry } });
const draft = draftEntry.localTable;
const DRAFT_GROUP = "restart_draft";
const DRAFT_ROW = "dddddddd-1111-4111-8111-dddddddddddd";

/** A SHARED-tier shape, which fans out to one stream per entitled scope. */
const contentEntry = defineSyncTable({
  tableName: "restart_content",
  makeColumns: () => ({
    id: uuid("id").primaryKey(),
    offeringId: uuid("offering_id").notNull(),
    body: text("body").notNull(),
  }),
  primaryKey: ["id"],
  mode: "readonly",
  shape: { scope: (c) => [c.offeringId] },
});
const sharedRegistry = defineSyncRegistry({ tables: { content: contentEntry } });
const content = contentEntry.localTable;
const CONTENT_GROUP = "restart_content";

const OFF_A = "11111111-1111-4111-8111-111111111111";
const OFF_B = "22222222-2222-4222-8222-222222222222";
const ROW_A = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const ROW_B = "bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb";

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** A durable-streams catch-up response: the envelopes, plus the headers the client reads off it. */
function dsResponse(envelopes: StreamEnvelope[], offset = "0000000000000001"): Response {
  return new Response(JSON.stringify(envelopes), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "Stream-Next-Offset": offset,
      "Stream-Up-To-Date": "true",
    },
  });
}

/**
 * A long-poll that never answers, released only when the test tears down.
 *
 * It is released with a `404` rather than a rejection, and that is not cosmetic: the ds client's
 * backoff wrapper retries a rejected fetch FOREVER (only a non-429/503 4xx propagates), so a stub
 * that rejected on teardown would spin the router instead of ending the read.
 */
function hang(init: RequestInit | undefined, release: Promise<void>): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new Error("[test] read aborted")), { once: true });
    void release.then(() => resolve(new Response("teardown", { status: 404 })));
  });
}

/**
 * A stub engine handing back a STABLE path per distinct shape request, so a re-subscribe resumes.
 *
 * It records what was RELEASED too: a restart closes the old session, and the claims that session
 * took must go back before the new one takes its own — otherwise every recovery ratchets the shape's
 * refcount up by one and `refcount > 0` pins it active for good.
 */
function stableEngine(): CircuitsEngineClient & { released: string[] } {
  const assigned = new Map<string, string>();
  const released: string[] = [];
  return {
    released,
    createShape: async (request) => {
      const fingerprint = JSON.stringify(request.where ?? {});
      let path = assigned.get(fingerprint);
      if (path === undefined) {
        path = `shape/s${assigned.size + 1}`;
        assigned.set(fingerprint, path);
      }
      return { shapeId: path, table: request.table, streamPath: path, streamUrl: `http://ds/${path}` };
    },
    releaseShape: async (shapeId: string) => {
      released.push(shapeId);
    },
    replicationState: async () => ({ lsn: "0/0", pendingFlips: 0, flipFailures: 0 }),
  } as CircuitsEngineClient & { released: string[] };
}

/**
 * One fetch covering both planes: the real control-plane handlers, and an edge whose answer is a
 * function of `(streamPath, how many times it has been read)`.
 */
function router(options: {
  registry: typeof privateRegistry | typeof sharedRegistry;
  engine: CircuitsEngineClient;
  entitlements?: EntitlementSet;
  ttlSeconds?: number;
  onSubscribe?: () => void;
  /** Fired when a session hands its engine claims back, so a test can order it against the subscribes. */
  onRelease?: () => void;
  /** Learned from each subscribe answer, so a test can name a stream by the scope it carries. */
  offeringByPath?: Map<string, string>;
  read: (path: string, attempt: number, init: RequestInit | undefined) => Promise<Response>;
}): typeof fetch {
  const shared = {
    registry: options.registry,
    engine: options.engine,
    key,
    ...(options.entitlements ? { entitlements: options.entitlements } : {}),
    ...(options.ttlSeconds !== undefined ? { ttlSeconds: options.ttlSeconds } : {}),
  };
  const subscribe = createSubscribeHandler({ ...shared, resolveAuthClaims: () => ({ sub: "person-a" }) });
  const refresh = createRefreshHandler({ ...shared, resolveAuthClaims: () => ({ sub: "person-a" }) });
  const release = createReleaseHandler({
    engine: options.engine,
    key,
    resolveAuthClaims: () => ({ sub: "person-a" }),
  });
  const barrier = createBarrierHandler({ engine: options.engine, resolveAuthClaims: () => ({ sub: "person-a" }) });
  const reads = new Map<string, number>();

  return (async (input: string, init?: RequestInit) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;

    if (path === subscribePath) {
      options.onSubscribe?.();
      const response = await subscribe(request);
      if (options.offeringByPath === undefined) return response;
      // Read the body ONCE and re-wrap it: `clone()` tees the stream, and a tee consumed at two
      // different times is a deadlock waiting to happen in a test that then waits on the consumer.
      const text = await response.text();
      const body = JSON.parse(text) as { granted?: { scope?: string[]; streamPath: string }[] };
      for (const grant of body.granted ?? []) {
        if (grant.scope?.[0] != null) options.offeringByPath.set(grant.streamPath, grant.scope[0]);
      }
      return new Response(text, { status: response.status, headers: response.headers });
    }
    if (path === refreshPath) return refresh(request);
    if (path === releasePath) {
      options.onRelease?.();
      return release(request);
    }
    if (path === barrierPath) return barrier(request);

    const streamPath = path.replace(/^\/+/, "");
    const attempt = (reads.get(streamPath) ?? 0) + 1;
    reads.set(streamPath, attempt);
    return options.read(streamPath, attempt, init);
  }) as unknown as typeof fetch;
}

function draftEnvelope(): StreamEnvelope {
  return {
    type: "restart_draft",
    key: DRAFT_ROW,
    value: { id: DRAFT_ROW, body: "kept across the reset", published: true },
    headers: { operation: "upsert" },
  };
}

function contentEnvelope(id: string, offeringId: string): StreamEnvelope {
  return {
    type: "restart_content",
    key: id,
    value: { id, offering_id: offeringId, body: `body-${id}` },
    headers: { operation: "upsert" },
  };
}

// The condition backlog 0010 was opened for: the engine evicted the stream, so the long-poll comes
// back `404` and delivery simply STOPS. Nothing throws at anyone — the failure is on the response's
// `closed` promise — so before this the rows sat there forever with no reader.
it("re-subscribes and resumes when a stream 404s under a live read", async () => {
  const pg = await createFreshTestPGlite();
  await createTablesFromSchema(pg, { draft });
  await migrateSubscriptionMetadataTables({ pg, metadataSchema: METADATA_SCHEMA });

  const teardown = deferred();
  const committed = deferred();
  const liveAgain = deferred();
  const streamErrors: Error[] = [];
  let subscribeCalls = 0;
  // The control-plane calls in order, so the release can be placed relative to the re-subscribe
  // rather than merely counted. A restart that re-subscribed FIRST would hold two claims on one
  // shape at once, and give back only one of them.
  const controlPlane: string[] = [];
  const engine = stableEngine();

  const sync = await startCircuitsSync(pg, {
    registry: privateRegistry,
    controlPlaneUrl: "http://api",
    streamBaseUrl: "http://edge",
    metadataSchema: METADATA_SCHEMA,
    onStreamError: (error) => streamErrors.push(error),
    fetch: router({
      registry: privateRegistry,
      engine,
      onSubscribe: () => {
        subscribeCalls += 1;
        controlPlane.push("subscribe");
      },
      onRelease: () => controlPlane.push("release"),
      read: async (_path, attempt, init) => {
        // 1: the catch-up, carrying the row. 2: the long-poll the engine kills. 3: the re-subscribed
        // read, resuming from the persisted offset with nothing new. 4: proof it is live again.
        if (attempt === 1) return dsResponse([draftEnvelope()]);
        // Held until the row is COMMITTED and its offset persisted. Not pacing for its own sake: a
        // restart tears the engine down, and a commit in flight when that happens is rolled back by
        // design (its offset does not advance either, so it re-streams) — which would make this a
        // test of the re-snapshot rather than of the resume.
        if (attempt === 2) {
          await committed.promise;
          return new Response("gone", { status: 404 });
        }
        if (attempt === 3) return dsResponse([]);
        if (attempt === 4) liveAgain.resolve();
        return hang(init, teardown.promise);
      },
    }),
  });

  try {
    await sync.groupReady(DRAFT_GROUP);
    committed.resolve();
    await liveAgain.promise;

    // The group re-subscribed exactly once, and said so exactly once.
    expect(subscribeCalls).toBe(2);
    expect(streamErrors).toHaveLength(1);
    // And it gave the old session's engine claim back BEFORE taking a new one. Every subscribe is a
    // `POST /shapes` join and `refcount > 0` blocks dormancy and eviction, so a restart that never
    // released would leave one extra claim on this shape for every recovery it ever made.
    expect(controlPlane).toEqual(["subscribe", "release", "subscribe"]);
    expect(engine.released).toEqual(["shape/s1"]);
    // RESUMED, not re-snapshotted: the control plane handed back the same stream, so the persisted
    // offset still addresses it and the row nobody re-sent is still here.
    expect(await drizzleOver(pg).select({ id: draft.id }).from(draft)).toEqual([{ id: DRAFT_ROW }]);
  } finally {
    sync.unsubscribe();
    teardown.resolve();
    await pg.close();
  }
});

// The other way a live read ends: the scope under it was revoked on a re-mint. The recovery is the
// same re-subscribe, and it is the re-subscribe that does the CLEARING — the subscribe answer is the
// authoritative statement of what the subject may read, so the scope it no longer names is the scope
// whose rows go (ADR-0055 decision 6). The caller hears about it only after they are gone.
it("clears a scope revoked on re-mint and tells the caller after the clear", async () => {
  const pg = await createFreshTestPGlite();
  await createTablesFromSchema(pg, { content });
  await migrateSubscriptionMetadataTables({ pg, metadataSchema: METADATA_SCHEMA });

  const allowed = new Set([OFF_A, OFF_B]);
  const entitlements: EntitlementSet = {
    ready: true,
    permits: (subject, shapeKey, scope) =>
      subject === "person-a" && shapeKey === "restart_content" && allowed.has(String(scope[0])),
    scopesFor: (subject, shapeKey) =>
      subject === "person-a" && shapeKey === "restart_content" ? [...allowed].map((held) => [held]) : [],
  };

  const teardown = deferred();
  const pollGate = deferred();
  const refusedFired = deferred();
  const offeringByPath = new Map<string, string>();
  const rowsForRevokedAtCallTime: Promise<number>[] = [];

  const sync = await startCircuitsSync(pg, {
    registry: sharedRegistry,
    controlPlaneUrl: "http://api",
    streamBaseUrl: "http://edge",
    metadataSchema: METADATA_SCHEMA,
    onRefused: (entries) => {
      if (!entries.some((entry) => entry.scope?.[0] === OFF_B)) return;
      // ENQUEUED from inside the callback: PGlite runs one connection FIFO, so this select sees
      // everything committed before `onRefused` fired and nothing committed after it.
      rowsForRevokedAtCallTime.push(
        drizzleOver(pg)
          .select({ id: content.id })
          .from(content)
          .where(eq(content.offeringId, OFF_B))
          .then((rows) => rows.length),
      );
      refusedFired.resolve();
    },
    fetch: router({
      registry: sharedRegistry,
      engine: stableEngine(),
      entitlements,
      // A one-second token, so EVERY request re-mints (the 60s refresh skew swallows the whole TTL)
      // and the revocation below is discovered on the next poll rather than five minutes later.
      ttlSeconds: 1,
      offeringByPath,
      read: async (path, attempt, init) => {
        if (attempt === 1) {
          const offering = offeringByPath.get(path)!;
          return dsResponse([contentEnvelope(offering === OFF_A ? ROW_A : ROW_B, offering)]);
        }
        // Parked until the test has both rows and has withdrawn the entitlement; it then answers as
        // an idle long-poll does, and the poll AFTER it re-mints into the revocation.
        if (attempt === 2) {
          await pollGate.promise;
          return dsResponse([]);
        }
        return hang(init, teardown.promise);
      },
    }),
  });

  try {
    await sync.groupReady(CONTENT_GROUP);
    expect((await drizzleOver(pg).select({ id: content.id }).from(content)).map((row) => row.id).sort()).toEqual(
      [ROW_A, ROW_B].sort(),
    );

    allowed.delete(OFF_B);
    pollGate.resolve();
    await refusedFired.promise;

    // B is gone, A — which kept its grant — is untouched.
    expect((await drizzleOver(pg).select({ id: content.id }).from(content)).map((row) => row.id)).toEqual([ROW_A]);
    // And the rows were already gone when the app was told, which is what makes `onRefused` safe to
    // re-render from.
    expect(await Promise.all(rowsForRevokedAtCallTime)).toEqual([0]);
  } finally {
    sync.unsubscribe();
    teardown.resolve();
    await pg.close();
  }
});

// A re-mint runs inside the read's own header thunk, so a rejection there kills the stream silently.
// A control plane that cannot answer must therefore leave the held token in place: it is still good
// for the refresh skew, and if it does lapse the edge says so out loud with a 403.
it("keeps the current token when a re-mint fails", async () => {
  let refreshShouldFail = false;
  const inner = router({
    registry: privateRegistry,
    engine: stableEngine(),
    read: async () => new Response("unused", { status: 404 }),
  });

  const session = await openSubscriptionSession(
    {
      controlPlaneUrl: "http://api",
      streamBaseUrl: "http://edge",
      fetch: (async (input: string, init?: RequestInit) => {
        if (refreshShouldFail && new URL(input).pathname === refreshPath) {
          throw new TypeError("Failed to fetch");
        }
        return inner(input, init);
      }) as unknown as typeof fetch,
    },
    [{ shapeKey: "restart_draft" }],
  );

  const original = await session.token();
  expect(original).not.toBe("");

  refreshShouldFail = true;
  expect(await session.refresh()).toBe(original);
  expect(await session.token()).toBe(original);
});

// An edge that is down when the group starts is the same condition as one that dies mid-session, and
// the answer is the same ladder. What it must NOT be is fatal: a start that threw would leave the app
// holding a group that never syncs again, seconds before the network came back.
it("retries a start whose streams cannot be opened, rather than failing it", async () => {
  const pg = await createFreshTestPGlite();
  await createTablesFromSchema(pg, { draft });
  await migrateSubscriptionMetadataTables({ pg, metadataSchema: METADATA_SCHEMA });

  const teardown = deferred();
  const streamErrors: Error[] = [];
  const syncErrors: Error[] = [];

  const sync = await startCircuitsSync(pg, {
    registry: privateRegistry,
    controlPlaneUrl: "http://api",
    streamBaseUrl: "http://edge",
    metadataSchema: METADATA_SCHEMA,
    onStreamError: (error) => streamErrors.push(error),
    onSyncError: (error) => syncErrors.push(error),
    fetch: router({
      registry: privateRegistry,
      engine: stableEngine(),
      // The first two opens are refused outright; the third is the edge coming back. A `404` and not
      // a socket error on purpose: the ds client retries a rejected fetch internally and forever, so
      // only a non-429/503 4xx reaches this client's own recovery at all.
      read: async (_path, attempt, init) => {
        if (attempt <= 2) return new Response("edge down", { status: 404 });
        if (attempt === 3) return dsResponse([draftEnvelope()]);
        return hang(init, teardown.promise);
      },
    }),
  });

  try {
    await sync.groupReady(DRAFT_GROUP);

    expect(sync.isGroupReady(DRAFT_GROUP)).toBe(true);
    expect(await drizzleOver(pg).select({ id: draft.id }).from(draft)).toEqual([{ id: DRAFT_ROW }]);
    // Two refusals, two recoverable reports — and not one `onSyncError`, which is the sticky status
    // reserved for a store that is actually diverging.
    expect(streamErrors).toHaveLength(2);
    expect(syncErrors).toEqual([]);
  } finally {
    sync.unsubscribe();
    teardown.resolve();
    await pg.close();
  }
});
