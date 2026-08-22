import { describe, expect, it } from "bun:test";

import { boolean, text, uuid } from "drizzle-orm/pg-core";

import { DENY_ALL_PREDICATE, defineSyncRegistry, defineSyncTable, p } from "@pgxsinkit/contracts";
import {
  authorizeStreamRead,
  CircuitsEngineError,
  CircuitsLeaseConfigError,
  createBarrierHandler,
  createCircuitsEngineClient,
  createRefreshHandler,
  createSubscribeHandler,
  fingerprintShapeRequest,
  importStreamTokenKey,
  mintStreamToken,
  refreshStreamToken,
  subscribeToShapes,
  verifyStreamToken,
  type CircuitsEngineClient,
  type CreateShapeRequest,
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

/**
 * An engine stub that honours the subscription contract (fork ADR-0008): a create is recorded under
 * the id it was given and echoes it back, and REPEATING it with that id renews — the same handle, no
 * second shape. `created` records every call, renewals included, so a test can see exactly what was
 * sent and under which claim.
 */
function stubEngine(leaseSeconds = 1800): CircuitsEngineClient & { created: CreateShapeRequest[] } {
  const created: CreateShapeRequest[] = [];
  const byClaim = new Map<string, { shapeId: string; streamPath: string }>();
  let next = 0;
  return {
    created,
    createShape: async (request) => {
      created.push(request);
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
        leaseSeconds,
      };
    },
    releaseShape: async () => {},
    replicationState: async () => ({ lsn: "0/0", pendingFlips: 0, flipFailures: 0 }),
  } as CircuitsEngineClient & { created: CreateShapeRequest[] };
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

// Every claim this control plane takes on an engine shape is NAMED, and the name travels in the
// signed grant (fork ADR-0008). That is what makes the release idempotent and the renewal possible at
// all: both are stateless, so the token is the only record of what a session holds.
describe("subscribe names every claim it takes", () => {
  it("sends a distinct subscription per grant, and carries it in the grant", async () => {
    const engine = stubEngine();
    const result = await subscribeToShapes(
      { registry, engine, entitlements, key },
      { sub: "person-a" },
      [{ shapeKey: "offering_content" }, { shapeKey: "notes" }],
      NOW,
    );

    // One id per CREATE, and every one of them non-empty and distinct — a shared id would make two
    // joins indistinguishable, and one release would give back a claim the other still needs.
    const sent = engine.created.map((request) => request.subscription);
    expect(sent.every((id) => typeof id === "string" && id !== "")).toBe(true);
    expect(new Set(sent).size).toBe(3);

    const verified = await verifyStreamToken(key, result.token!, NOW);
    expect(verified.ok).toBe(true);
    const claims = verified.ok ? verified.claims.grants.map((grant) => grant.claim) : [];
    // The grant carries exactly the id that was sent, in order: the release route has nothing else to
    // go on.
    expect(claims).toEqual(sent as string[]);
  });

  // An engine that files a claim under a name other than the one it was given cannot be renewed or
  // released by id, which is the whole protocol. That is the wrong engine, not a degraded one.
  it("throws when the engine records a claim under a different id", async () => {
    const renaming = {
      createShape: async (request: CreateShapeRequest) => ({
        shapeId: "s1",
        table: request.table,
        streamPath: "shape/s1",
        streamUrl: "http://ds/shape/s1",
        subscription: "an-id-of-my-own",
        leaseSeconds: 1800,
      }),
      releaseShape: async () => {},
      replicationState: async () => ({ lsn: "0/0", pendingFlips: 0, flipFailures: 0 }),
    } as unknown as CircuitsEngineClient;

    // oxlint-disable-next-line typescript/await-thenable -- bun-types gap: .rejects returns a real promise typed as void
    await expect(
      subscribeToShapes(
        { registry, engine: renaming, entitlements, key },
        { sub: "person-a" },
        [{ shapeKey: "notes" }],
        NOW,
      ),
    ).rejects.toThrow(/recorded this shape claim under/);
  });

  // The barrier's rule applied to the create: a create answer missing the subscription it was
  // recorded under, or the window that subscription lives in, leaves a claim nothing can renew and
  // nothing can release by id. Defaulting either would invent a lease the engine never granted.
  it("refuses an engine whose create answer omits the subscription or the lease", async () => {
    const answering = (body: Record<string, unknown>) =>
      createCircuitsEngineClient({
        baseUrl: "http://engine",
        fetch: (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch,
      });
    const whole = {
      shapeId: "s1",
      table: "notes",
      streamPath: "shape/s1",
      streamUrl: "http://ds/shape/s1",
      subscription: "given-back",
      leaseSeconds: 1800,
    };

    for (const missing of ["subscription", "leaseSeconds"] as const) {
      const body = { ...whole };
      delete (body as Record<string, unknown>)[missing];
      // oxlint-disable-next-line typescript/await-thenable -- bun-types gap: .rejects returns a real promise typed as void
      await expect(
        subscribeToShapes(
          { registry, engine: answering(body), key },
          { sub: "person-a" },
          [{ shapeKey: "notes" }],
          NOW,
        ),
      ).rejects.toThrow(new RegExp(`unusable \\\`${missing}\\\``));
    }
  });
});

// Claims are renewed on ONE cadence — the token re-mint — so an engine whose lease window is shorter
// than two TTLs would drop a live session's shape after a single missed refresh. That is an
// operator's misconfiguration, and it is refused loudly rather than served: 503, never a denial,
// because nothing about it is a statement about this subject's entitlements.
describe("the lease window must cover the token TTL", () => {
  const subscribeWith = (leaseSeconds: number, ttlSeconds: number) =>
    subscribeToShapes(
      { registry, engine: stubEngine(leaseSeconds), entitlements, key, ttlSeconds },
      { sub: "person-a" },
      [{ shapeKey: "notes" }],
      NOW,
    );

  it("refuses a lease window shorter than twice the TTL", async () => {
    // oxlint-disable-next-line typescript/await-thenable -- bun-types gap: .rejects returns a real promise typed as void
    await expect(subscribeWith(500, 300)).rejects.toThrow(CircuitsLeaseConfigError);
    // Both numbers and the knob that fixes them are named: the operator reading this log owns both.
    // oxlint-disable-next-line typescript/await-thenable -- bun-types gap: .rejects returns a real promise typed as void
    await expect(subscribeWith(500, 300)).rejects.toThrow(/500s.*ELECTRIC_CIRCUITS_SHAPE_IDLE_SECS/s);
    // oxlint-disable-next-line typescript/await-thenable -- bun-types gap: .rejects returns a real promise typed as void
    await expect(subscribeWith(500, 300)).rejects.toThrow(/300s.*ttlSeconds/s);
  });

  // Exactly two TTLs is the margin for one missed refresh, and is accepted.
  it("accepts a window of two TTLs or more", async () => {
    expect((await subscribeWith(600, 300)).granted).toHaveLength(1);
    expect((await subscribeWith(1800, 300)).granted).toHaveLength(1);
  });

  // `0` is the engine saying dormancy — and with it leases — is switched off. There is no window to
  // fall out of, so there is nothing to check.
  it("accepts leaseSeconds 0, which is leases disabled", async () => {
    expect((await subscribeWith(0, 300)).granted).toHaveLength(1);
  });

  // At the route it is a 503 in the outage family, and the body must not read as lost entitlement:
  // a client told that truncates the scope and unsubscribes.
  it("answers 503 at the route, never a denial", async () => {
    const handle = createSubscribeHandler({
      registry,
      engine: stubEngine(60),
      entitlements,
      key,
      ttlSeconds: 300,
      resolveAuthClaims: () => ({ sub: "person-a" }),
    });

    const response = await handle(
      new Request("http://cp/sync/v1/subscribe", {
        method: "POST",
        body: JSON.stringify({ subscriptions: [{ shapeKey: "notes" }] }),
      }),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "sync engine lease window shorter than the token TTL" });
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

// A claim is a LEASE (fork ADR-0008): the engine releases one that is not renewed within its idle
// window, because native reads terminate on durable-streams and the renewal is the only liveness
// signal it has. The re-mint is where pgxsinkit renews — it already runs once per subject per TTL
// window and already decides which grants are still authorized, so the renewal covers exactly those
// and costs no extra round trip.
describe("the re-mint renews every grant it re-authorizes", () => {
  /** What the engine should do when a claim it already holds is presented again. */
  type Renewal = "renew" | "new-handle" | "conflict" | "outage" | "short-lease" | "rename";

  /**
   * An engine recording every `(request, subscription)` it was asked to create under, whose answer to
   * a REPEAT create a test can steer — the four outcomes a renewal actually has.
   */
  function recordingEngine(onRepeat: (claim: string) => Renewal = () => "renew") {
    const calls: { table: string; where: unknown; subscription: string | undefined }[] = [];
    const releases: { shapeId: string; claim: string }[] = [];
    const byClaim = new Map<string, { shapeId: string; streamPath: string }>();
    let next = 0;
    const answer = (handle: { shapeId: string; streamPath: string }, table: string, claim: string) => ({
      shapeId: handle.shapeId,
      table,
      streamPath: handle.streamPath,
      streamUrl: `http://ds:8080/v1/stream/${handle.streamPath}`,
      subscription: claim,
      leaseSeconds: 1800,
    });
    const engine = {
      calls,
      releases,
      createShape: async (request: CreateShapeRequest) => {
        calls.push({ table: request.table, where: request.where, subscription: request.subscription });
        const claim = request.subscription ?? `~minted-${next + 1}`;
        const held = byClaim.get(claim);
        const verdict: Renewal = held === undefined ? "renew" : onRepeat(claim);
        if (verdict === "conflict") {
          throw new CircuitsEngineError(409, "already belongs to shape s99", "engine conflict");
        }
        if (verdict === "outage") throw new CircuitsEngineError(503, "degraded", "engine degraded");
        if (held !== undefined && verdict === "renew") return answer(held, request.table, claim);
        // An operator lowered ELECTRIC_CIRCUITS_SHAPE_IDLE_SECS under a live session: the claim is
        // renewed, but the window it now lives in no longer covers two of this deployment's TTLs.
        if (held !== undefined && verdict === "short-lease") {
          return { ...answer(held, request.table, claim), leaseSeconds: 60 };
        }
        // The renewal is filed under a name of the engine's choosing — the next renewal would take a
        // second claim, and the release would name something it never held.
        if (held !== undefined && verdict === "rename") {
          return { ...answer(held, request.table, claim), subscription: `${claim}-renamed` };
        }
        // Either the first create, or a renewal that arrived after the claim lapsed and therefore
        // RE-SUBSCRIBED: a fresh shape on a fresh path (ADR-0007).
        next += 1;
        const handle = { shapeId: `s${next}`, streamPath: `shape/s${next}` };
        byClaim.set(claim, handle);
        return answer(handle, request.table, claim);
      },
      releaseShape: async (shapeId: string, claim: string) => {
        releases.push({ shapeId, claim });
      },
      replicationState: async () => ({ lsn: "0/0", pendingFlips: 0, flipFailures: 0 }),
    };
    return engine as unknown as CircuitsEngineClient & { calls: typeof calls; releases: typeof releases };
  }

  /** An entitlement set a test can narrow between the subscribe and the re-mint. */
  function heldScopes(allowed: Set<string>): EntitlementSet {
    return {
      ready: true,
      permits: (subject, shapeKey, scope) =>
        subject === "person-a" && shapeKey === "offering_content" && allowed.has(String(scope[0])),
      scopesFor: (subject, shapeKey) =>
        subject === "person-a" && shapeKey === "offering_content" ? [...allowed].map((held) => [held]) : [],
    };
  }

  async function claimsOf(token: string): Promise<string[]> {
    const verified = await verifyStreamToken(key, token, NOW);
    return verified.ok ? verified.claims.grants.map((grant) => grant.claim) : [];
  }

  // Both tiers, and the SAME id each time: a renewal under a new id would be a second join, which is
  // exactly the leak the lease exists to close.
  it("repeats each grant's create under its own claim id, both tiers", async () => {
    const engine = recordingEngine();
    const allowed = new Set(["off-1", "off-2"]);
    const options = { registry, engine, entitlements: heldScopes(allowed), key };
    const initial = await subscribeToShapes(
      options,
      { sub: "person-a" },
      [{ shapeKey: "offering_content" }, { shapeKey: "notes" }],
      NOW,
    );
    const acquired = await claimsOf(initial.token!);
    expect(acquired).toHaveLength(3);
    const subscribeCalls = [...engine.calls];

    const refreshed = await refreshStreamToken(options, { sub: "person-a" }, initial.token!, NOW + 1);

    expect(refreshed.revoked).toEqual([]);
    expect(refreshed.granted.map((grant) => grant.path)).toEqual(["shape/s1", "shape/s2", "shape/s3"]);
    // One renewal per grant, naming the same claim AND the same definition — a renewal of a different
    // definition would be a different shape, which the engine would answer with a different handle.
    const renewals = engine.calls.slice(subscribeCalls.length);
    expect(renewals.map((call) => call.subscription)).toEqual(acquired);
    expect(renewals.map((call) => [call.table, call.where])).toEqual(
      subscribeCalls.map((call) => [call.table, call.where]),
    );
    // The re-minted token carries the same claims forward: they are the same claims.
    expect(await claimsOf(refreshed.token!)).toEqual(acquired);
  });

  // A grant that lost its authorization is deliberately NOT renewed: its lease lapses and the engine
  // reclaims the shape. Renewing it would pin a shape for a subject who may no longer read it.
  it("does not renew a grant it revoked", async () => {
    const engine = recordingEngine();
    const allowed = new Set(["off-1", "off-2"]);
    const options = { registry, engine, entitlements: heldScopes(allowed), key };
    const initial = await subscribeToShapes(options, { sub: "person-a" }, [{ shapeKey: "offering_content" }], NOW);
    const [keptClaim, lostClaim] = await claimsOf(initial.token!);
    const subscribeCalls = engine.calls.length;

    allowed.delete("off-2");
    const refreshed = await refreshStreamToken(options, { sub: "person-a" }, initial.token!, NOW + 1);

    expect(refreshed.revoked.map((entry) => entry.reason)).toEqual(["not entitled to this scope"]);
    expect(engine.calls.slice(subscribeCalls).map((call) => call.subscription)).toEqual([keptClaim]);
    expect(engine.calls.slice(subscribeCalls).map((call) => call.subscription)).not.toContain(lostClaim);
  });

  // The claim lapsed (or its shape was evicted), so the renewal RE-SUBSCRIBED and the engine handed
  // back a different shape on a different path. The grant names the old one, and the client is
  // following the old one — so the grant is revoked and the client re-subscribes. The claim the
  // renewal just took is released immediately: nobody is reading that stream.
  it("revokes a grant whose renewal came back a different handle, and gives back the new claim", async () => {
    const engine = recordingEngine(() => "new-handle");
    const allowed = new Set(["off-1"]);
    const options = { registry, engine, entitlements: heldScopes(allowed), key };
    const initial = await subscribeToShapes(options, { sub: "person-a" }, [{ shapeKey: "offering_content" }], NOW);
    const [claim] = await claimsOf(initial.token!);

    const refreshed = await refreshStreamToken(options, { sub: "person-a" }, initial.token!, NOW + 1);

    expect(refreshed.granted).toEqual([]);
    expect(refreshed.revoked).toEqual([
      { shapeKey: "offering_content", scope: ["off-1"], reason: "shape stream changed; re-subscribe" },
    ]);
    expect(engine.releases).toEqual([{ shapeId: "s2", claim: claim! }]);
  });

  // One name, one shape. A 409 means the id names something else entirely — nothing was taken, so
  // there is nothing to give back, and no retry changes it. The client re-subscribes under a new id.
  it("revokes on a 409 and releases nothing, because nothing was taken", async () => {
    const engine = recordingEngine(() => "conflict");
    const allowed = new Set(["off-1"]);
    const options = { registry, engine, entitlements: heldScopes(allowed), key };
    const initial = await subscribeToShapes(options, { sub: "person-a" }, [{ shapeKey: "offering_content" }], NOW);

    const refreshed = await refreshStreamToken(options, { sub: "person-a" }, initial.token!, NOW + 1);

    expect(refreshed.granted).toEqual([]);
    expect(refreshed.revoked).toEqual([
      {
        shapeKey: "offering_content",
        scope: ["off-1"],
        reason: "subscription id is held by another shape; re-subscribe",
      },
    ]);
    expect(engine.releases).toEqual([]);
  });

  // The claim-recording assertion is not a subscribe-only check: a renewal filed under another name
  // is the same wrong engine, and reached one re-mint later. Both call sites go through
  // `assertClaimRecorded`, so there is exactly one place this can be got wrong.
  it("throws when a RENEWAL is recorded under a different id", async () => {
    const engine = recordingEngine(() => "rename");
    const allowed = new Set(["off-1"]);
    const options = { registry, engine, entitlements: heldScopes(allowed), key };
    const initial = await subscribeToShapes(options, { sub: "person-a" }, [{ shapeKey: "offering_content" }], NOW);

    // oxlint-disable-next-line typescript/await-thenable -- bun-types gap: .rejects returns a real promise typed as void
    await expect(refreshStreamToken(options, { sub: "person-a" }, initial.token!, NOW + 1)).rejects.toThrow(
      /recorded this shape claim under/,
    );
  });

  // The lease guard is checked on every create, so it catches a window lowered UNDER a live session,
  // not only a deployment that was misconfigured from the start. At the re-mint it is a 503 like any
  // other deployment fault — never a `revoked`, which would make the client clear rows over a
  // configuration change it has no part in.
  it("answers 503 at the route when a renewal reports a lease shorter than twice the TTL", async () => {
    const engine = recordingEngine(() => "short-lease");
    const allowed = new Set(["off-1"]);
    const options = { registry, engine, entitlements: heldScopes(allowed), key };
    const initial = await subscribeToShapes(options, { sub: "person-a" }, [{ shapeKey: "offering_content" }], NOW);

    const handle = createRefreshHandler({ ...options, resolveAuthClaims: () => ({ sub: "person-a" }) });
    const response = await handle(
      new Request("http://cp/sync/v1/refresh", { method: "POST", body: JSON.stringify({ token: initial.token }) }),
    );

    expect(response.status).toBe(503);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({ error: "sync engine lease window shorter than the token TTL" });
    // Nothing revoked, and nothing given back: the claim is still held and the client's token still
    // works until its own TTL lapses.
    expect(body["revoked"]).toBeUndefined();
    expect(engine.releases).toEqual([]);
  });

  // An engine that could not answer a renewal is an OUTAGE, and the outage-is-not-a-denial rule binds
  // hardest here: `revoked` is the wire's clear-this-scope instruction, and this route runs every few
  // minutes for the life of every subscription. The claim is still held — a lease outlives a failed
  // renewal by the rest of its window — and the token the client holds still works.
  it("answers 503 at the route when a renewal fails, and revokes nothing", async () => {
    const engine = recordingEngine(() => "outage");
    const allowed = new Set(["off-1"]);
    const options = { registry, engine, entitlements: heldScopes(allowed), key };
    const initial = await subscribeToShapes(options, { sub: "person-a" }, [{ shapeKey: "offering_content" }], NOW);

    const handle = createRefreshHandler({ ...options, resolveAuthClaims: () => ({ sub: "person-a" }) });
    const response = await handle(
      new Request("http://cp/sync/v1/refresh", { method: "POST", body: JSON.stringify({ token: initial.token }) }),
    );

    expect(response.status).toBe(503);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({ error: "sync engine unavailable" });
    // The word that must NOT appear: a `revoked` entry is what makes a client clear its rows.
    expect(body["revoked"]).toBeUndefined();
    expect(engine.releases).toEqual([]);
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
      grants: [{ path: "shape/s1", shapeId: "s1", claim: "claim-1", shapeKey: "offering_content", scope: ["off-1"] }],
      ttlSeconds: 300,
      now: NOW,
    });
    const handle = createRefreshHandler({
      registry,
      engine: stubEngine(),
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

  // The engine comes back with the result: a re-mint RENEWS every grant it re-authorizes, so it has
  // to be given the same engine the claims were taken on.
  async function subscribeAs(tenant: string) {
    const engine = stubEngine();
    const result = await subscribeToShapes(
      { registry: tenantRegistry, engine, key },
      { sub: "person-a", app_metadata: { tenant } },
      [{ shapeKey: "tenant_documents" }],
      NOW,
    );
    expect(result.granted.map((g) => g.streamPath)).toEqual(["shape/s1"]);
    return { ...result, engine };
  }

  it("keeps a grant whose shape still compiles the same", async () => {
    const initial = await subscribeAs(TENANT_A);
    const refreshed = await refreshStreamToken(
      { registry: tenantRegistry, engine: initial.engine, key },
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
      { registry: tenantRegistry, engine: initial.engine, key },
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
      grants: [{ path: "shape/s1", shapeId: "s1", claim: "claim-1", shapeKey: "tenant_documents" }],
      now: NOW,
    });
    const refreshed = await refreshStreamToken(
      { registry: tenantRegistry, engine: stubEngine(), key },
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
