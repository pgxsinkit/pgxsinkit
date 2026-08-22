import { describe, expect, it } from "bun:test";

import { boolean, text, uuid } from "drizzle-orm/pg-core";

import { openSubscriptionSession } from "@pgxsinkit/client";
import { defineSyncRegistry, defineSyncTable, p } from "@pgxsinkit/contracts";
import {
  CircuitsEngineError,
  createRefreshHandler,
  createReleaseHandler,
  createSubscribeHandler,
  importStreamTokenKey,
  mintStreamToken,
  refreshPath,
  releasePath,
  releaseStreamGrants,
  subscribePath,
  type CircuitsEngineClient,
  type EntitlementSet,
} from "@pgxsinkit/server";

// The close half of the native subscribe path. Every grant subscribe hands out is one `POST /shapes`
// join, and a live claim is the ONLY thing that tells the engine a reader exists — native reads
// terminate on durable-streams and never touch it — so one live claim blocks dormancy and eviction
// alike. Without a release, every shape waits out its full lease window before it can be reclaimed.
//
// What these tests pin is that every claim is NAMED and released BY that name (fork ADR-0008). One
// release per grant on the way out, each carrying its own claim id — which is what makes a repeat
// harmless rather than a theft, and what keeps two grants that deduplicated onto one shape
// distinguishable. Refusals are still refusals: a token is only ever its own subject's to give back.

const key = await importStreamTokenKey("release-test-secret");
const NOW = 1_700_000_000;

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

const OFF_A = "11111111-1111-4111-8111-111111111111";
const OFF_B = "22222222-2222-4222-8222-222222222222";

/**
 * An engine stub recording what it was asked to release, in order — the shapeId in `released` and the
 * `(shapeId, claim)` pair in `releases`, because the claim is the half that says WHICH join is being
 * given back.
 *
 * Its creates honour the subscription contract: the id is echoed back, and repeating it renews rather
 * than taking a second claim.
 */
function stubEngine(options?: {
  failRelease?: boolean;
}): CircuitsEngineClient & { released: string[]; releases: { shapeId: string; claim: string }[] } {
  const released: string[] = [];
  const releases: { shapeId: string; claim: string }[] = [];
  const byClaim = new Map<string, { shapeId: string; streamPath: string }>();
  let next = 0;
  return {
    released,
    releases,
    createShape: async (request) => {
      const claim = request.subscription ?? `~minted-${next + 1}`;
      let handle = byClaim.get(claim);
      if (handle === undefined) {
        next += 1;
        handle = { shapeId: `s${next}`, streamPath: `shape/s${next}` };
        byClaim.set(claim, handle);
      }
      return {
        shapeId: handle.shapeId,
        table: request.table,
        streamPath: handle.streamPath,
        streamUrl: `http://ds:8080/v1/stream/${handle.streamPath}`,
        subscription: claim,
        leaseSeconds: 1800,
      };
    },
    releaseShape: async (shapeId: string, claim: string) => {
      if (options?.failRelease === true) {
        throw new CircuitsEngineError(502, "boom", "[pgxsinkit] circuits engine DELETE /shapes → 502");
      }
      released.push(shapeId);
      releases.push({ shapeId, claim });
    },
    replicationState: async () => ({ lsn: "0/0", pendingFlips: 0, flipFailures: 0 }),
  } as CircuitsEngineClient & { released: string[]; releases: { shapeId: string; claim: string }[] };
}

function mutableEntitlements(allowed: Set<string>): EntitlementSet {
  return {
    ready: true,
    permits: (subject, shapeKey, scope) =>
      subject === "person-a" && shapeKey === "offering_content" && allowed.has(String(scope[0])),
    scopesFor: (subject, shapeKey) =>
      subject === "person-a" && shapeKey === "offering_content" ? [...allowed].map((held) => [held]) : [],
  };
}

/**
 * Enough of a turn for a fire-and-forget release to have travelled through the router and the
 * handler. `close()` is synchronous by design, so a test can only observe the request after the fact,
 * and a NEGATIVE assertion ("nothing was sent") has no signal to wait on at all.
 */
async function settle(): Promise<void> {
  await Bun.sleep(25);
}

/** The real control-plane handlers behind one fetch, with the release requests counted. */
function routeToHandlers(
  engine: CircuitsEngineClient,
  entitlements: EntitlementSet,
  caller = "person-a",
): typeof fetch & { releaseCalls: () => number } {
  const shared = { registry, engine, entitlements, key };
  const resolveAuthClaims = () => ({ sub: caller });
  const subscribe = createSubscribeHandler({ ...shared, resolveAuthClaims });
  const refresh = createRefreshHandler({ ...shared, resolveAuthClaims });
  const release = createReleaseHandler({ engine, key, resolveAuthClaims });

  let releaseCalls = 0;
  const routed = (async (url: string, init?: RequestInit) => {
    const request = new Request(url, init);
    const path = new URL(url).pathname;
    if (path === subscribePath) return subscribe(request);
    if (path === refreshPath) return refresh(request);
    if (path === releasePath) {
      releaseCalls += 1;
      return release(request);
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch & { releaseCalls: () => number };
  routed.releaseCalls = () => releaseCalls;
  return routed;
}

describe("releaseStreamGrants", () => {
  // The engine shares by definition: two identical shape requests collapse onto ONE stream and are
  // counted twice (ADR-0055 decision 6). So two grants naming one shapeId are two joins, and
  // deduplicating them here would hand back one claim and leak the other forever.
  it("releases one claim per grant, even when two grants share a shapeId", async () => {
    const engine = stubEngine();
    const token = await mintStreamToken(key, {
      sub: "person-a",
      grants: [
        { path: "shape/s1", shapeId: "s1", claim: "claim-a", shapeKey: "offering_content", scope: [OFF_A] },
        { path: "shape/s1", shapeId: "s1", claim: "claim-b", shapeKey: "offering_content", scope: [OFF_B] },
      ],
      now: NOW,
    });

    const result = await releaseStreamGrants({ engine, key }, { sub: "person-a" }, token, NOW + 1);

    expect(result).toEqual({ released: 2 });
    expect(engine.released).toEqual(["s1", "s1"]);
    // And each release names its OWN claim, which is what makes the two distinguishable at all: one
    // shapeId, two joins, two ids. Releasing `claim-a` twice would leave `claim-b` held.
    expect(engine.releases).toEqual([
      { shapeId: "s1", claim: "claim-a" },
      { shapeId: "s1", claim: "claim-b" },
    ]);
  });

  // A session releases at CLOSE, which is routinely well past a 5-minute TTL. Expiry bounds how long
  // a grant keeps WORKING; the signature is what proves this control plane issued these claims, and
  // that is the only thing the release relies on.
  it("releases on an expired token", async () => {
    const engine = stubEngine();
    const token = await mintStreamToken(key, {
      sub: "person-a",
      grants: [{ path: "shape/s1", shapeId: "s1", claim: "claim-a", shapeKey: "offering_content", scope: [OFF_A] }],
      ttlSeconds: 300,
      now: NOW - 86_400,
    });

    const result = await releaseStreamGrants({ engine, key }, { sub: "person-a" }, token, NOW);

    expect(result).toEqual({ released: 1 });
    expect(engine.releases).toEqual([{ shapeId: "s1", claim: "claim-a" }]);
  });

  // A token presented by anyone but its own subject is not a release, it is an attempt to drop the
  // victim's claims — and it names them exactly, so it would succeed.
  it("refuses a token whose subject is not the caller, and releases nothing", async () => {
    const engine = stubEngine();
    const token = await mintStreamToken(key, {
      sub: "person-a",
      grants: [{ path: "shape/s1", shapeId: "s1", claim: "claim-a", shapeKey: "offering_content", scope: [OFF_A] }],
      now: NOW,
    });

    const result = await releaseStreamGrants({ engine, key }, { sub: "person-b" }, token, NOW + 1);

    expect(result).toEqual({ refused: "token subject does not match the caller" });
    expect(engine.released).toEqual([]);
  });
});

describe("the release route", () => {
  const post = (token: string) =>
    new Request(`http://api${releasePath}`, { method: "POST", body: JSON.stringify({ token }) });

  it("401s a caller with no subject", async () => {
    const engine = stubEngine();
    const handle = createReleaseHandler({ engine, key, resolveAuthClaims: () => null });
    const token = await mintStreamToken(key, {
      sub: "person-a",
      grants: [{ path: "shape/s1", shapeId: "s1", claim: "claim-a", shapeKey: "offering_content", scope: [OFF_A] }],
      now: NOW,
    });

    const response = await handle(post(token));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthenticated" });
    expect(engine.released).toEqual([]);
  });

  // 403 rather than a 200 `{ released: 0 }`: a refused release must be VISIBLE. Answering success to
  // a stolen token would make the theft indistinguishable from an ordinary close.
  it("403s when the JWT subject differs from the token subject", async () => {
    const engine = stubEngine();
    const handle = createReleaseHandler({ engine, key, resolveAuthClaims: () => ({ sub: "person-b" }) });
    const token = await mintStreamToken(key, {
      sub: "person-a",
      grants: [{ path: "shape/s1", shapeId: "s1", claim: "claim-a", shapeKey: "offering_content", scope: [OFF_A] }],
      now: NOW,
    });

    const response = await handle(post(token));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "token subject does not match the caller" });
    expect(engine.released).toEqual([]);
  });

  it("403s a token this control plane did not sign", async () => {
    const engine = stubEngine();
    const handle = createReleaseHandler({ engine, key, resolveAuthClaims: () => ({ sub: "person-a" }) });
    const forged = await mintStreamToken(await importStreamTokenKey("some-other-secret"), {
      sub: "person-a",
      grants: [{ path: "shape/s1", shapeId: "s1", claim: "claim-a", shapeKey: "offering_content", scope: [OFF_A] }],
      now: NOW,
    });

    const response = await handle(post(forged));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "bad signature" });
    expect(engine.released).toEqual([]);
  });

  // An engine that could not answer has not dropped the claims. 503 says "this deployment, not you",
  // and the client is free to come back: the release names its claims, so a retry that races one that
  // actually landed is a no-op. Either way the residue is bounded — an unrenewed claim lapses.
  it("503s when the engine cannot answer", async () => {
    const engine = stubEngine({ failRelease: true });
    const handle = createReleaseHandler({ engine, key, resolveAuthClaims: () => ({ sub: "person-a" }) });
    const token = await mintStreamToken(key, {
      sub: "person-a",
      grants: [{ path: "shape/s1", shapeId: "s1", claim: "claim-a", shapeKey: "offering_content", scope: [OFF_A] }],
      now: NOW,
    });

    const response = await handle(post(token));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "sync engine unavailable" });
  });

  // The property the whole of fork ADR-0008 exists to give this route: a release is IDEMPOTENT. The
  // route no longer has to protect anyone from a repeat — it forwards both, the engine makes the
  // second a no-op, and both answer 200. Before claims were named, the second `DELETE` decremented a
  // shared counter and took a claim belonging to somebody else.
  it("answers a repeated release the same way, forwarding both to the engine", async () => {
    const engine = stubEngine();
    const handle = createReleaseHandler({ engine, key, resolveAuthClaims: () => ({ sub: "person-a" }) });
    const token = await mintStreamToken(key, {
      sub: "person-a",
      grants: [{ path: "shape/s1", shapeId: "s1", claim: "claim-a", shapeKey: "offering_content", scope: [OFF_A] }],
      now: NOW,
    });

    const first = await handle(post(token));
    const second = await handle(post(token));

    expect([first.status, second.status]).toEqual([200, 200]);
    expect(await first.json()).toEqual({ released: 1 });
    expect(await second.json()).toEqual({ released: 1 });
    // Both reached the engine, naming the SAME claim both times — the id is what makes the repeat a
    // no-op there rather than a second decrement here.
    expect(engine.releases).toEqual([
      { shapeId: "s1", claim: "claim-a" },
      { shapeId: "s1", claim: "claim-a" },
    ]);
  });
});

describe("a subscription session's close", () => {
  // The one that justifies keeping the SUBSCRIBE token rather than the live one. A re-mint only ever
  // drops grants, so after a revocation the current token names fewer claims than the session
  // acquired — and the dropped one is precisely the claim nothing else will ever come back for.
  it("releases every claim it acquired, including one a re-mint revoked", async () => {
    const engine = stubEngine();
    const allowed = new Set([OFF_A, OFF_B]);
    const routed = routeToHandlers(engine, mutableEntitlements(allowed));
    const session = await openSubscriptionSession(
      { controlPlaneUrl: "http://api", streamBaseUrl: "http://edge/stream", fetch: routed },
      [{ shapeKey: "offering_content" }],
    );
    expect(session.granted.map((g) => g.shapeId)).toEqual(["s1", "s2"]);

    allowed.delete(OFF_B);
    expect(await session.refresh()).not.toBeNull();

    session.close();
    await settle();

    expect(engine.released.sort()).toEqual(["s1", "s2"]);
  });

  // A second close sends nothing — not because a repeat would be unsafe (it is a no-op now: see the
  // route's idempotence test above) but because it could only ever be redundant. The latch is there
  // so a stop racing a teardown does not make a pointless request.
  it("sends exactly one release however many times it is closed", async () => {
    const engine = stubEngine();
    const routed = routeToHandlers(engine, mutableEntitlements(new Set([OFF_A])));
    const session = await openSubscriptionSession(
      { controlPlaneUrl: "http://api", streamBaseUrl: "http://edge/stream", fetch: routed },
      [{ shapeKey: "offering_content" }],
    );

    session.close();
    session.close();
    session.close();
    await settle();

    expect(routed.releaseCalls()).toBe(1);
    expect(engine.released).toEqual(["s1"]);
  });

  // Nothing granted is nothing acquired: there is no token, so there is no claim to give back and no
  // request worth making.
  it("sends nothing when the session was granted nothing", async () => {
    const engine = stubEngine();
    const routed = routeToHandlers(engine, mutableEntitlements(new Set()));
    const session = await openSubscriptionSession(
      { controlPlaneUrl: "http://api", streamBaseUrl: "http://edge/stream", fetch: routed },
      [{ shapeKey: "offering_content" }],
    );
    expect(session.granted).toEqual([]);

    session.close();
    await settle();

    expect(routed.releaseCalls()).toBe(0);
    expect(engine.released).toEqual([]);
  });

  // A control plane that refuses or cannot be reached must not take the caller down with it: the
  // release is fire-and-forget, and its failure is invisible because `close()` is synchronous and its
  // commonest caller is a page unload — there is no one left to report to. The claims lapse.
  it("swallows a failed release rather than throwing out of close()", async () => {
    const engine = stubEngine();
    const routed = routeToHandlers(engine, mutableEntitlements(new Set([OFF_A])));
    const unreachableRelease = (async (url: string, init?: RequestInit) => {
      if (new URL(url).pathname === releasePath) throw new TypeError("Failed to fetch");
      return routed(url, init);
    }) as unknown as typeof fetch;
    const session = await openSubscriptionSession(
      { controlPlaneUrl: "http://api", streamBaseUrl: "http://edge/stream", fetch: unreachableRelease },
      [{ shapeKey: "offering_content" }],
    );

    expect(() => session.close()).not.toThrow();
    await settle();

    expect(engine.released).toEqual([]);
  });
});
