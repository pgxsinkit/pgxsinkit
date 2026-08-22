import { describe, expect, it } from "bun:test";

import { boolean, text, uuid } from "drizzle-orm/pg-core";

import { DENY_ALL_PREDICATE, defineSyncRegistry, defineSyncTable, p } from "@pgxsinkit/contracts";
import {
  authorizeStreamRead,
  CircuitsEngineError,
  createBarrierHandler,
  createRefreshHandler,
  createSubscribeHandler,
  fingerprintShapeRequest,
  importStreamTokenKey,
  mintStreamToken,
  refreshStreamToken,
  subscribeToShapes,
  type CircuitsEngineClient,
  type EntitlementSet,
} from "@pgxsinkit/server";

// The control plane's subscribe path end to end (bar the live entitlement source): compile, check
// entitlement, register with the engine, mint one token for the batch. What matters here is that a
// batch degrades per subscription rather than as a whole, and that the token it hands back is one
// the edge actually accepts — the two halves are written against the same grant shape, so a
// mismatch between them is the failure this catches.

const NOW = 1_700_000_000;
const key = await importStreamTokenKey("test-signing-secret");

const content = defineSyncTable({
  tableName: "offering_content",
  makeColumns: () => ({
    id: uuid("id").primaryKey(),
    offeringId: uuid("offering_id").notNull(),
    published: boolean("published").notNull(),
  }),
  primaryKey: ["id"],
  mode: "readonly",
  shape: { scope: (c) => [c.offeringId], where: (c) => p.eq(c.published, true) },
});

const notes = defineSyncTable({
  tableName: "notes",
  makeColumns: () => ({ id: uuid("id").primaryKey(), ownerId: uuid("owner_id").notNull(), body: text("body") }),
  primaryKey: ["id"],
  mode: "readonly",
  shape: {
    rowFilter: (c) => ({
      customPredicate: (claims) => (typeof claims.sub === "string" ? p.eq(c.ownerId, claims.sub) : DENY_ALL_PREDICATE),
    }),
  },
});

const registry = defineSyncRegistry({ tables: { content, notes } });

// person-a holds TWO offerings, so a single requested shape must fan out to two streams.
const HELD = ["off-1", "off-2"];

const entitlements: EntitlementSet = {
  ready: true,
  permits: (subject, shapeKey, scope) =>
    subject === "person-a" && shapeKey === "offering_content" && HELD.includes(String(scope[0])),
  scopesFor: (subject, shapeKey) =>
    subject === "person-a" && shapeKey === "offering_content" ? HELD.map((held) => [held]) : [],
};

function stubEngine(): CircuitsEngineClient & { created: unknown[] } {
  const created: unknown[] = [];
  let next = 0;
  return {
    created,
    createShape: async (request) => {
      created.push(request);
      next += 1;
      return {
        shapeId: `s${next}`,
        table: request.table,
        streamPath: `shape/s${next}`,
        streamUrl: `http://ds:8080/v1/stream/shape/s${next}`,
      };
    },
    releaseShape: async () => {},
    replicationState: async () => ({ lsn: "0/0", pendingFlips: 0, flipFailures: 0 }),
  } as CircuitsEngineClient & { created: unknown[] };
}

describe("subscribe", () => {
  // The client asks for two SHAPES and gets three STREAMS: the shared one fans out across the two
  // offerings person-a holds, the private one does not fan out at all. Nothing on the request named
  // a scope — that expansion is the control plane's, off the entitlement set.
  it("expands a shared shape to one stream per entitled scope, under one token", async () => {
    const engine = stubEngine();
    const result = await subscribeToShapes(
      { registry, engine, entitlements, key },
      { sub: "person-a" },
      [{ shapeKey: "offering_content" }, { shapeKey: "notes" }],
      NOW,
    );

    expect(result.denied).toEqual([]);
    expect(result.granted.map((g) => [g.shapeKey, g.scope?.[0] ?? null])).toEqual([
      ["offering_content", "off-1"],
      ["offering_content", "off-2"],
      ["notes", null],
    ]);
    expect(result.expiresAt).toBe(NOW + 300);

    // Each scope got its OWN shape — the predicates differ, so they must not collapse onto one.
    expect(engine.created).toHaveLength(3);

    // One token covers all three, and the edge accepts each.
    const gate = { key, entitlements, durableStreamsUrl: "http://ds:8080" };
    for (const grant of result.granted) {
      expect((await authorizeStreamRead(gate, result.token!, grant.streamPath, NOW)).allow).toBe(true);
    }
  });

  // One bad shape in a batch must not cost the subject the rest of it.
  it("degrades per subscription, not per batch", async () => {
    const engine = stubEngine();
    const result = await subscribeToShapes(
      { registry, engine, entitlements, key },
      { sub: "person-a" },
      [{ shapeKey: "offering_content" }, { shapeKey: "unknown_shape" }],
      NOW,
    );

    expect(result.granted).toHaveLength(2);
    expect(result.denied.map((d) => d.reason)).toEqual(['no shape declares shapeKey "unknown_shape"']);
  });

  // A subject holding nothing is refused, not granted an empty set: zero grants returned silently
  // would leave the client waiting on streams that were never created.
  it("refuses a shared shape the subject holds no scope of", async () => {
    const engine = stubEngine();
    const result = await subscribeToShapes(
      { registry, engine, entitlements, key },
      { sub: "person-b" },
      [{ shapeKey: "offering_content" }],
      NOW,
    );

    expect(result.granted).toEqual([]);
    expect(result.denied[0]?.reason).toBe("no entitled scopes");
    expect(engine.created).toEqual([]);
  });

  // Enumeration and permits are required to agree. When they do not, subscribe is the side that has
  // to catch it — the edge checks `permits` on every read, so a scope only `scopesFor` believes in
  // would mint a capability for a stream that then 403s forever.
  it("refuses a scope that scopesFor yields but permits denies", async () => {
    const engine = stubEngine();
    const disagreeing: EntitlementSet = {
      ready: true,
      permits: (_subject, _shapeKey, scope) => scope[0] === "off-1",
      scopesFor: () => [["off-1"], ["off-ghost"]],
    };
    const result = await subscribeToShapes(
      { registry, engine, entitlements: disagreeing, key },
      { sub: "person-a" },
      [{ shapeKey: "offering_content" }],
      NOW,
    );

    expect(result.granted.map((g) => g.scope?.[0])).toEqual(["off-1"]);
    expect(result.denied).toEqual([
      { shapeKey: "offering_content", scope: ["off-ghost"], reason: "not entitled to this scope" },
    ]);
    // The ghost scope never reached the engine — no shape created, no capability minted.
    expect(engine.created).toHaveLength(1);
  });

  // An entitlement set that is not ready is an OUTAGE, never a denial. A client told "not entitled"
  // clears that scope and unsubscribes (ADR-0055 decision 6), so answering a set that is merely
  // catching up that way turns a few seconds of propagation lag into data loss. It throws, and the
  // route answers 503 — the same treatment a degraded engine gets, for the same reason.
  it("refuses to decide while the entitlement set is unavailable", async () => {
    const engine = stubEngine();
    const unavailable = { ready: false, permits: () => true, scopesFor: () => [["off-1"]] };

    // oxlint-disable-next-line typescript/await-thenable -- bun-types gap: .rejects returns a real promise typed as void
    await expect(
      subscribeToShapes(
        { registry, engine, entitlements: unavailable, key },
        { sub: "person-a" },
        [{ shapeKey: "offering_content" }],
        NOW,
      ),
    ).rejects.toThrow(/entitlement set is unavailable/);

    // Still the original property: nothing was registered and no capability exists to be revoked.
    expect(engine.created).toEqual([]);

    const handle = createSubscribeHandler({
      registry,
      engine,
      entitlements: unavailable,
      key,
      resolveAuthClaims: () => ({ sub: "person-a" }),
    });
    const response = await handle(
      new Request("http://cp/sync/v1/subscribe", {
        method: "POST",
        body: JSON.stringify({ subscriptions: [{ shapeKey: "offering_content" }] }),
      }),
    );

    expect(response.status).toBe(503);
    // Critically NOT a denial: nothing in the body may read as lost entitlement.
    expect(await response.json()).toEqual({ error: "entitlements unavailable" });
    expect(engine.created).toEqual([]);
  });

  it("has no anonymous form in either tier", async () => {
    const engine = stubEngine();
    const result = await subscribeToShapes(
      { registry, engine, entitlements, key },
      null,
      [{ shapeKey: "notes" }, { shapeKey: "offering_content" }],
      NOW,
    );

    expect(result.token).toBeUndefined();
    expect(result.granted).toEqual([]);
    expect(engine.created).toEqual([]);
  });
});

// A degraded engine refuses shape creation (503). The route must NOT relay that as a denial: a
// client told "not entitled" truncates that scope and unsubscribes, so reporting an outage that way
// would turn a transient engine fault into client-side data loss.
describe("subscribe under engine failure", () => {
  function failingEngine(status: number): CircuitsEngineClient {
    return {
      createShape: async () => {
        throw new CircuitsEngineError(status, "degraded", "engine degraded");
      },
      releaseShape: async () => {},
      replicationState: async () => ({ lsn: null, pendingFlips: 0, flipFailures: 1 }),
    } as unknown as CircuitsEngineClient;
  }

  it("answers 503 rather than denying the subscriptions", async () => {
    const handle = createSubscribeHandler({
      registry,
      engine: failingEngine(503),
      entitlements,
      key,
      resolveAuthClaims: () => ({ sub: "person-a" }),
    });

    const response = await handle(
      new Request("http://cp/sync/v1/subscribe", {
        method: "POST",
        body: JSON.stringify({ subscriptions: [{ shapeKey: "offering_content", scope: ["off-1"] }] }),
      }),
    );

    expect(response.status).toBe(503);
    // Critically NOT a denial: nothing in the body may read as lost entitlement.
    expect(await response.json()).toEqual({ error: "sync engine unavailable" });
  });
});

// The re-mint route runs every few minutes for the life of every subscription, and its `revoked` list
// is the wire's clear-this-scope instruction. So the unavailable-is-not-a-denial rule binds harder
// here than on subscribe: an entitlement subscription a few seconds behind would otherwise empty a
// subject's store on every reconnect.
describe("refresh while the entitlement set is unavailable", () => {
  it("answers 503 and revokes nothing", async () => {
    const token = await mintStreamToken(key, {
      sub: "person-a",
      grants: [{ path: "shape/s1", shapeId: "s1", shapeKey: "offering_content", scope: ["off-1"] }],
      ttlSeconds: 300,
      now: NOW,
    });
    const handle = createRefreshHandler({
      registry,
      entitlements: { ready: false, permits: () => true, scopesFor: () => [["off-1"]] },
      key,
      resolveAuthClaims: () => ({ sub: "person-a" }),
    });

    const response = await handle(
      new Request("http://cp/sync/v1/refresh", { method: "POST", body: JSON.stringify({ token }) }),
    );

    expect(response.status).toBe(503);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({ error: "entitlements unavailable" });
    // The word that must NOT appear: a `revoked` entry is what makes a client clear its rows.
    expect(body["revoked"]).toBeUndefined();
  });
});

// A private-tier grant is NOT self-authorizing at re-mint (ADR-0055 decision 6, amended). Its
// predicate is compiled out of the subject's claims, and a claim it reads can change while the
// subscription lives — so the re-mint recompiles the shape against the CURRENT claims and admits the
// grant only if the result is the same shape the grant was issued for. Re-verifying the JWT proves
// the bearer is still who they were; only the recompile proves the shape is still theirs.
describe("re-mint re-authorizes the private tier", () => {
  const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const TENANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

  // Keyed on a claim that is NOT `sub`, which is the whole point: the subject is unchanged across
  // every case below, so a re-mint that only re-verified the subject would wave all of them through.
  const documents = defineSyncTable({
    tableName: "tenant_documents",
    makeColumns: () => ({ id: uuid("id").primaryKey(), tenantId: uuid("tenant_id").notNull(), body: text("body") }),
    primaryKey: ["id"],
    mode: "readonly",
    shape: {
      rowFilter: (c) => ({
        customPredicate: (claims) => {
          const tenant = claims.app_metadata?.["tenant"];
          return typeof tenant === "string" ? p.eq(c.tenantId, tenant) : DENY_ALL_PREDICATE;
        },
      }),
    },
  });
  const tenantRegistry = defineSyncRegistry({ tables: { documents } });
  const gate = { key, durableStreamsUrl: "http://ds" };

  async function subscribeAs(tenant: string) {
    const engine = stubEngine();
    const result = await subscribeToShapes(
      { registry: tenantRegistry, engine, key },
      { sub: "person-a", app_metadata: { tenant } },
      [{ shapeKey: "tenant_documents" }],
      NOW,
    );
    expect(result.granted.map((g) => g.streamPath)).toEqual(["shape/s1"]);
    return result;
  }

  it("keeps a grant whose shape still compiles the same", async () => {
    const initial = await subscribeAs(TENANT_A);
    const refreshed = await refreshStreamToken(
      { registry: tenantRegistry, key },
      { sub: "person-a", app_metadata: { tenant: TENANT_A } },
      initial.token!,
      NOW + 1,
    );

    expect(refreshed.revoked).toEqual([]);
    expect(refreshed.granted.map((g) => g.path)).toEqual(["shape/s1"]);
    // Re-authorized means re-minted: the fresh token opens the same stream the old one did.
    expect((await authorizeStreamRead(gate, refreshed.token!, "shape/s1", NOW + 1)).allow).toBe(true);
  });

  // The subject is still permitted something — just not THIS shape. Revoking anyway is the design:
  // the grant names one stream and that stream serves the old predicate, and minting a new shape here
  // would bump an engine refcount nothing ever releases. The client re-subscribes, is granted the
  // shape its claims now compile to, and re-snapshots because the handle differs (ADR-0056 d7).
  it("revokes a grant whose predicate now compiles differently, even though it still permits", async () => {
    const initial = await subscribeAs(TENANT_A);
    const refreshed = await refreshStreamToken(
      { registry: tenantRegistry, key },
      { sub: "person-a", app_metadata: { tenant: TENANT_B } },
      initial.token!,
      NOW + 1,
    );

    expect(refreshed.granted).toEqual([]);
    expect(refreshed.revoked).toEqual([
      { shapeKey: "tenant_documents", reason: "shape predicate changed for this subject" },
    ]);
    // And the bound is real: the re-minted token does not open the stream the old predicate served.
    expect(await authorizeStreamRead(gate, refreshed.token ?? null, "shape/s1", NOW + 1)).toMatchObject({
      allow: false,
    });
  });

  // Nothing to compare against is nothing that could establish the grant is still the right one, so
  // it fails closed. The recovery costs a re-subscribe, never a row the subject may still read.
  it("revokes a private grant carrying no fingerprint", async () => {
    const token = await mintStreamToken(key, {
      sub: "person-a",
      grants: [{ path: "shape/s1", shapeId: "s1", shapeKey: "tenant_documents" }],
      now: NOW,
    });
    const refreshed = await refreshStreamToken(
      { registry: tenantRegistry, key },
      { sub: "person-a", app_metadata: { tenant: TENANT_A } },
      token,
      NOW + 1,
    );

    expect(refreshed.granted).toEqual([]);
    expect(refreshed.revoked).toEqual([
      {
        shapeKey: "tenant_documents",
        reason: "private grant carries no fingerprint and cannot be re-authorized",
      },
    ]);
  });

  // The comparison above is only sound if the fingerprint is a function of MEANING. A predicate
  // arrives from an author's closure, whose branches may build `{ col, op, value }` in any order, so
  // key order must not register — while the values, which are the authorization, must.
  it("fingerprints by meaning: key order is invisible, values are not", async () => {
    const canonical = await fingerprintShapeRequest({
      table: "tenant_documents",
      where: {
        and: [
          { col: "tenant_id", op: "eq", value: TENANT_A },
          { col: "archived", isNull: true },
        ],
      },
      columns: ["id", "body"],
    });
    const reordered = await fingerprintShapeRequest({
      columns: ["id", "body"],
      where: {
        and: [
          { value: TENANT_A, op: "eq", col: "tenant_id" },
          { isNull: true, col: "archived" },
        ],
      },
      table: "tenant_documents",
    });
    const otherTenant = await fingerprintShapeRequest({
      table: "tenant_documents",
      where: {
        and: [
          { col: "tenant_id", op: "eq", value: TENANT_B },
          { col: "archived", isNull: true },
        ],
      },
      columns: ["id", "body"],
    });

    expect(reordered).toBe(canonical);
    expect(otherTenant).not.toBe(canonical);
  });
});

// The barrier's cache is sound for `pendingFlips` because staleness only ever moves that term
// BACKWARDS: a stale reading can delay an alignment, never satisfy one falsely. `flipFailures`
// inverts that — a cached pre-degradation zero would license exactly the alignment the term exists
// to refuse — so a degraded reading is never cached.
describe("barrier cache", () => {
  function engineReporting(states: { pendingFlips: number; flipFailures: number }[]) {
    let index = 0;
    const reads = { count: 0 };
    const engine = {
      replicationState: async () => {
        reads.count += 1;
        const state = states[Math.min(index++, states.length - 1)]!;
        return { lsn: "0/0", ...state };
      },
    } as unknown as CircuitsEngineClient;
    return { engine, reads };
  }

  const get = () => new Request("http://cp/sync/v1/barrier");

  it("caches a healthy reading", async () => {
    const { engine, reads } = engineReporting([{ pendingFlips: 0, flipFailures: 0 }]);
    const handle = createBarrierHandler({ engine, maxAgeSeconds: 60 });

    expect(await (await handle(get())).json()).toEqual({ pendingFlips: 0, flipFailures: 0 });
    await handle(get());
    expect(reads.count).toBe(1);
  });

  // Uncached by default, so an unconverged engine is re-read every time rather than being believed
  // for a window — the cache is an opt-in for deployments that have measured the trade.
  it("re-reads every time with no cache window", async () => {
    const { engine, reads } = engineReporting([{ pendingFlips: 2, flipFailures: 0 }]);
    const handle = createBarrierHandler({ engine });

    expect(await (await handle(get())).json()).toEqual({ pendingFlips: 2, flipFailures: 0 });
    await handle(get());
    await handle(get());
    expect(reads.count).toBe(3);
  });

  // A degraded reading is never CACHED — with the same generous window that just cached a healthy
  // answer, every degraded read still goes to the engine. That keeps a restart visible immediately
  // instead of being masked for a window, and is what stops a stale zero from ever being served in
  // its place. Deleting the guard makes this fail: the reading is served once and never re-read.
  it("never caches a degraded reading", async () => {
    const { engine, reads } = engineReporting([{ pendingFlips: 4, flipFailures: 1 }]);
    const handle = createBarrierHandler({ engine, maxAgeSeconds: 60 });

    expect(await (await handle(get())).json()).toEqual({ pendingFlips: 4, flipFailures: 1 });
    await handle(get());
    await handle(get());
    expect(reads.count).toBe(3);
  });
});
