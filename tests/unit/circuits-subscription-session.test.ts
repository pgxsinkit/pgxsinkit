import { describe, expect, it } from "bun:test";

import { boolean, text, uuid } from "drizzle-orm/pg-core";

import { openSubscriptionSession, type RefusedStream } from "@pgxsinkit/client";
import { defineSyncRegistry, defineSyncTable, p } from "@pgxsinkit/contracts";
import {
  authorizeStreamRead,
  createRefreshHandler,
  createSubscribeHandler,
  importStreamTokenKey,
  refreshPath,
  subscribePath,
  type CircuitsEngineClient,
  type EntitlementSet,
} from "@pgxsinkit/server";

// The subscribe/re-mint round trip, client against the REAL server handlers rather than a mocked
// response shape — the two halves are the whole point of this seam, and a drift between them is the
// failure this catches. What matters here is the inversion: the client no longer CONSTRUCTS a stream
// URL, it asks and is told, so a subject can only ever read what the control plane grants.

const key = await importStreamTokenKey("session-test-secret");

const content = defineSyncTable({
  tableName: "offering_content",
  makeColumns: () => ({
    id: uuid("id").primaryKey(),
    offeringId: uuid("offering_id").notNull(),
    published: boolean("published").notNull(),
    body: text("body"),
  }),
  primaryKey: ["id"],
  mode: "readonly",
  shape: { scope: (c) => [c.offeringId], where: (c) => p.eq(c.published, true) },
});

const registry = defineSyncRegistry({ tables: { content } });

/** Entitlement that can be revoked mid-test, to drive the re-mint's live re-check. */
function mutableEntitlements(allowed: Set<string>): EntitlementSet {
  return {
    ready: true,
    permits: (subject, shapeKey, scope) =>
      subject === "person-a" && shapeKey === "offering_content" && allowed.has(String(scope[0])),
  };
}

function stubEngine(): CircuitsEngineClient {
  let next = 0;
  return {
    createShape: async (request) => {
      next += 1;
      return {
        shapeId: `s${next}`,
        table: request.table,
        streamPath: `shape/s${next}`,
        streamUrl: `http://ds:8080/v1/stream/shape/s${next}`,
      };
    },
    releaseShape: async () => {},
    replicationState: async () => ({ lsn: "0/0", sync: true, pendingFlips: 0 }),
  } as CircuitsEngineClient;
}

/** Route a client fetch straight into the server handlers — no transport in between. */
function routeToHandlers(entitlements: EntitlementSet): typeof fetch {
  const shared = { registry, engine: stubEngine(), entitlements, key };
  const subscribe = createSubscribeHandler({ ...shared, resolveAuthClaims: () => ({ sub: "person-a" }) });
  const refresh = createRefreshHandler({ ...shared, resolveAuthClaims: () => ({ sub: "person-a" }) });

  return (async (url: string, init: RequestInit) => {
    const request = new Request(url, init);
    const path = new URL(url).pathname;
    if (path === subscribePath) return subscribe(request);
    if (path === refreshPath) return refresh(request);
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

const OFF_A = "11111111-1111-4111-8111-111111111111";
const OFF_B = "22222222-2222-4222-8222-222222222222";

describe("subscription session", () => {
  it("is told its stream URLs rather than constructing them", async () => {
    const session = await openSubscriptionSession(
      {
        controlPlaneUrl: "http://api",
        streamBaseUrl: "http://edge/stream",
        fetch: routeToHandlers(mutableEntitlements(new Set([OFF_A, OFF_B]))),
      },
      [
        { shapeKey: "offering_content", scope: [OFF_A] },
        { shapeKey: "offering_content", scope: [OFF_B] },
      ],
    );

    expect(session.granted.map((g) => g.streamUrl)).toEqual([
      "http://edge/stream/shape/s1",
      "http://edge/stream/shape/s2",
    ]);
    // And the token it was handed actually opens them at the gate.
    const gate = { key, entitlements: mutableEntitlements(new Set([OFF_A, OFF_B])), durableStreamsUrl: "http://ds" };
    const token = await session.token();
    expect((await authorizeStreamRead(gate, token, "shape/s1", Math.floor(Date.now() / 1000))).allow).toBe(true);
  });

  it("reports a refused scope per subscription and grants the rest", async () => {
    const session = await openSubscriptionSession(
      {
        controlPlaneUrl: "http://api",
        streamBaseUrl: "http://edge/stream",
        fetch: routeToHandlers(mutableEntitlements(new Set([OFF_A]))),
      },
      [
        { shapeKey: "offering_content", scope: [OFF_A] },
        { shapeKey: "offering_content", scope: [OFF_B] },
      ],
    );

    expect(session.granted).toHaveLength(1);
    expect(session.refused.map((r) => r.reason)).toEqual(["not entitled to this scope"]);
  });

  // The re-check on re-mint is what makes the TTL a revocation bound rather than a formality.
  it("drops a revoked scope on re-mint and tells the caller which", async () => {
    const allowed = new Set([OFF_A, OFF_B]);
    const revoked: RefusedStream[] = [];

    const session = await openSubscriptionSession(
      {
        controlPlaneUrl: "http://api",
        streamBaseUrl: "http://edge/stream",
        fetch: routeToHandlers(mutableEntitlements(allowed)),
        onRevoked: (entries) => revoked.push(...entries),
      },
      [
        { shapeKey: "offering_content", scope: [OFF_A] },
        { shapeKey: "offering_content", scope: [OFF_B] },
      ],
    );

    allowed.delete(OFF_B);
    const fresh = await session.refresh();

    expect(fresh).not.toBeNull();
    expect(revoked.map((r) => r.reason)).toEqual(["not entitled to this scope"]);

    // The re-minted token no longer opens the revoked stream, and still opens the surviving one.
    const gate = { key, entitlements: mutableEntitlements(allowed), durableStreamsUrl: "http://ds" };
    const now = Math.floor(Date.now() / 1000);
    expect((await authorizeStreamRead(gate, fresh!, "shape/s1", now)).allow).toBe(true);
    expect(await authorizeStreamRead(gate, fresh!, "shape/s2", now)).toEqual({
      allow: false,
      reason: "token grants no such stream",
    });
  });

  // K subscriptions share one token; K polls hitting expiry at once must not fire K refreshes.
  it("collapses concurrent refreshes into one round trip", async () => {
    let refreshCalls = 0;
    const inner = routeToHandlers(mutableEntitlements(new Set([OFF_A])));
    const session = await openSubscriptionSession(
      {
        controlPlaneUrl: "http://api",
        streamBaseUrl: "http://edge/stream",
        fetch: (async (url: string, init: RequestInit) => {
          if (new URL(url).pathname === refreshPath) refreshCalls += 1;
          return inner(url, init);
        }) as unknown as typeof fetch,
      },
      [{ shapeKey: "offering_content", scope: [OFF_A] }],
    );

    await Promise.all([session.refresh(), session.refresh(), session.refresh(), session.refresh()]);
    expect(refreshCalls).toBe(1);
  });
});
