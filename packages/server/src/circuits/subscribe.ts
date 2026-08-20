import type { JwtClaims, PredicateValue, SyncTableRegistry } from "@pgxsinkit/contracts";

import { compileShapeRequest } from "./compile";
import type { EntitlementSet } from "./edge";
import { CircuitsEngineError, type CircuitsEngineClient } from "./engine-client";
import { DEFAULT_STREAM_TOKEN_TTL_SECONDS, mintStreamToken, verifyStreamToken, type StreamGrant } from "./stream-token";

/** One shape a client wants to follow. */
export interface SubscriptionRequest {
  shapeKey: string;
  /** Shared tier only, positionally matching the shape's declared scope columns. */
  scope?: readonly PredicateValue[];
}

/** A subscription the control plane granted: what to read, and where. */
export interface GrantedSubscription {
  shapeKey: string;
  scope?: readonly PredicateValue[];
  shapeId: string;
  /** The durable-streams path, which is what the client follows through the edge. */
  streamPath: string;
}

/** A subscription the control plane declined, with why. */
export interface DeniedSubscription {
  shapeKey: string;
  scope?: readonly PredicateValue[];
  reason: string;
}

export interface SubscribeResult {
  /** The stream token covering every granted subscription. Absent when nothing was granted. */
  token?: string;
  /** Seconds since the epoch. The client re-mints before this, in one request for the whole batch. */
  expiresAt?: number;
  granted: GrantedSubscription[];
  denied: DeniedSubscription[];
}

export interface SubscribeOptions {
  registry: SyncTableRegistry;
  engine: CircuitsEngineClient;
  entitlements: EntitlementSet;
  /** The stream-token signing key, shared with the edge — the same process holds both. */
  key: CryptoKey;
  /** Per-deployment override of ADR-0055's 5-minute default. */
  ttlSeconds?: number;
  /** Deployment-supplied runtime params, as the Electric proxy's `extraParams`. */
  params?: Record<string, unknown>;
}

/**
 * Subscribe to a batch of shapes: compile each against the registry, check entitlement, register it
 * with the engine, and mint ONE token covering all of them.
 *
 * A partial result rather than an all-or-nothing one. A subject asking for K scopes at boot may
 * legitimately have lost one of them, and failing the whole batch on that would deny them the K-1
 * they still hold — so a denial is reported per subscription and the rest proceed.
 *
 * That partiality covers AUTHORIZATION only. An engine that cannot answer — degraded, unreachable —
 * is not a denial and must never be reported as one: a client told "not entitled" truncates that
 * scope and unsubscribes, so reporting an outage that way would turn a transient engine fault into
 * client-side data loss. Engine failures propagate, and the route answers 503.
 *
 * Entitlement is checked HERE as well as at the edge, and the duplication is deliberate: this is
 * what stops a shape being created and a capability minted for a scope the subject never held. The
 * edge's check bounds how long an already-minted one keeps working.
 */
export async function subscribeToShapes(
  options: SubscribeOptions,
  claims: JwtClaims | null,
  requests: readonly SubscriptionRequest[],
  now: number,
): Promise<SubscribeResult> {
  const subject = typeof claims?.sub === "string" ? claims.sub : null;
  const granted: GrantedSubscription[] = [];
  const denied: DeniedSubscription[] = [];
  const grants: StreamGrant[] = [];

  for (const request of requests) {
    const scoped = request.scope !== undefined ? { scope: request.scope } : {};
    const deny = (reason: string) => denied.push({ shapeKey: request.shapeKey, ...scoped, reason });

    const compiled = compileShapeRequest(options.registry, {
      shapeKey: request.shapeKey,
      claims,
      ...scoped,
      ...(options.params ? { params: options.params } : {}),
    });
    if (compiled.outcome === "deny") {
      deny(compiled.reason);
      continue;
    }

    // Every read is bound to a subject, both tiers. The private tier fuses the subject into the
    // predicate and the shared tier checks it against the entitlement set, but neither has an
    // anonymous form — a token with no subject would name a bearer no revocation could reach.
    if (subject === null) {
      deny("no subject");
      continue;
    }

    if (compiled.tier === "shared") {
      if (!options.entitlements.ready) {
        deny("entitlements unavailable");
        continue;
      }
      if (!options.entitlements.permits(subject, request.shapeKey, request.scope ?? [])) {
        deny("not entitled to this scope");
        continue;
      }
    }

    // Deliberately unguarded: see the note above on why an engine fault is not a denial.
    const handle = await options.engine.createShape(compiled.request);
    granted.push({ shapeKey: request.shapeKey, ...scoped, shapeId: handle.shapeId, streamPath: handle.streamPath });
    grants.push({ path: handle.streamPath, shapeKey: request.shapeKey, ...scoped });
  }

  if (subject === null || grants.length === 0) return { granted, denied };

  const ttlSeconds = options.ttlSeconds ?? DEFAULT_STREAM_TOKEN_TTL_SECONDS;
  const token = await mintStreamToken(options.key, { sub: subject, grants, ttlSeconds, now });
  return { token, expiresAt: now + ttlSeconds, granted, denied };
}

/**
 * The subscribe route: verified claims in, a token and stream paths out.
 *
 * Deliberately a POST that returns paths rather than a redirect to them. The client needs the whole
 * batch to open K long-polls and to know when to re-mint, and a redirect would give it one stream
 * and no expiry.
 */
export function createSubscribeHandler(
  options: SubscribeOptions & {
    resolveAuthClaims?: (request: Request) => Promise<JwtClaims | null> | JwtClaims | null;
  },
) {
  return async function handleSubscribe(request: Request): Promise<Response> {
    let body: { subscriptions?: SubscriptionRequest[] };
    try {
      body = (await request.json()) as { subscriptions?: SubscriptionRequest[] };
    } catch {
      return Response.json({ error: "malformed body" }, { status: 400 });
    }
    if (!Array.isArray(body.subscriptions)) {
      return Response.json({ error: "subscriptions must be an array" }, { status: 400 });
    }

    const claims = options.resolveAuthClaims ? await options.resolveAuthClaims(request) : null;

    let result: SubscribeResult;
    try {
      result = await subscribeToShapes(options, claims, body.subscriptions, Math.floor(Date.now() / 1000));
    } catch (error) {
      // A degraded engine refuses shape creation outright (503). Answering with the engine's own
      // status keeps the client retrying rather than treating an outage as lost entitlement.
      if (error instanceof CircuitsEngineError) {
        return Response.json({ error: "sync engine unavailable" }, { status: 503 });
      }
      throw error;
    }

    // 200 even when everything was denied: the per-subscription reasons ARE the response, and
    // collapsing them to a status code would tell a client that lost one scope out of K nothing
    // about which one.
    return Response.json(result);
  };
}

export interface RefreshResult {
  token?: string;
  expiresAt?: number;
  /** Grants that survived the live entitlement re-check. */
  granted: StreamGrant[];
  /** Grants the subject no longer holds. The client truncates each scope and unsubscribes. */
  revoked: DeniedSubscription[];
}

/**
 * Re-mint a stream token from an existing one (ADR-0055 decision 6).
 *
 * The expiring token IS the request: its signature proves this control plane issued those grants, so
 * nothing has to be stored server-side to know what the subject held, and the edge stays stateless on
 * both halves. Expiry is deliberately not enforced here — a token is presented for re-mint precisely
 * because it is at or past its TTL — but the signature is, and **entitlement is re-checked live for
 * every grant**. That re-check is what makes the TTL a revocation bound rather than a formality: a
 * subject who lost a scope gets a token without it, and the edge stops serving that stream as soon as
 * the old one lapses.
 *
 * No engine call. The shapes already exist and the client already holds their paths; re-creating them
 * would bump a refcount nothing ever releases.
 */
export async function refreshStreamToken(
  options: Pick<SubscribeOptions, "entitlements" | "key" | "ttlSeconds">,
  claims: JwtClaims | null,
  expiringToken: string,
  now: number,
): Promise<RefreshResult> {
  const subject = typeof claims?.sub === "string" ? claims.sub : null;
  const verified = await verifyStreamToken(options.key, expiringToken, now, { allowExpired: true });
  if (!verified.ok || subject === null) return { granted: [], revoked: [] };

  // The token names its subject; a token presented by anyone else is not a re-mint, it is a theft.
  if (verified.claims.sub !== subject) return { granted: [], revoked: [] };

  const granted: StreamGrant[] = [];
  const revoked: DeniedSubscription[] = [];

  for (const grant of verified.claims.grants) {
    const scoped = grant.scope !== undefined ? { scope: grant.scope } : {};
    if (grant.scope === undefined) {
      // Private tier: the shape's predicate already fused this subject in, so holding a signed grant
      // for it IS the entitlement. Nothing further to check.
      granted.push(grant);
      continue;
    }
    if (!options.entitlements.ready) {
      revoked.push({ shapeKey: grant.shapeKey, ...scoped, reason: "entitlements unavailable" });
      continue;
    }
    if (!options.entitlements.permits(subject, grant.shapeKey, grant.scope)) {
      revoked.push({ shapeKey: grant.shapeKey, ...scoped, reason: "not entitled to this scope" });
      continue;
    }
    granted.push(grant);
  }

  if (granted.length === 0) return { granted, revoked };

  const ttlSeconds = options.ttlSeconds ?? DEFAULT_STREAM_TOKEN_TTL_SECONDS;
  const token = await mintStreamToken(options.key, { sub: subject, grants: granted, ttlSeconds, now });
  return { token, expiresAt: now + ttlSeconds, granted, revoked };
}

/**
 * The re-mint route. Takes the expiring token, answers with a fresh one and the list of scopes that
 * did not survive the entitlement re-check.
 *
 * 200 even when everything was revoked, for the same reason subscribe answers 200 on a full denial:
 * the per-grant reasons ARE the response, and a client that lost one scope of K needs to know which.
 */
export function createRefreshHandler(
  options: Pick<SubscribeOptions, "entitlements" | "key" | "ttlSeconds"> & {
    resolveAuthClaims?: (request: Request) => Promise<JwtClaims | null> | JwtClaims | null;
  },
) {
  return async function handleRefresh(request: Request): Promise<Response> {
    let body: { token?: string };
    try {
      body = (await request.json()) as { token?: string };
    } catch {
      return Response.json({ error: "malformed body" }, { status: 400 });
    }
    if (typeof body.token !== "string") {
      return Response.json({ error: "token must be a string" }, { status: 400 });
    }

    const claims = options.resolveAuthClaims ? await options.resolveAuthClaims(request) : null;
    const result = await refreshStreamToken(options, claims, body.token, Math.floor(Date.now() / 1000));
    return Response.json(result);
  };
}

/** The control-plane paths the native read path mounts. */
export const subscribePath = "/sync/v1/subscribe";
export const refreshPath = "/sync/v1/refresh";

/**
 * The convergence-barrier route (ADR-0056 decision 4).
 *
 * Proxied rather than exposed: the engine's control plane is unauthenticated by design and is not
 * client-reachable, so surfacing the barrier on our own authenticated endpoint costs nothing and
 * keeps the trust boundary intact.
 *
 * `maxAgeSeconds` may cache the answer briefly, but only a HEALTHY one. For the `sync` and
 * `pendingFlips` terms staleness is safe in one direction — it moves the barrier backwards, so a
 * stale reading can only delay an alignment, never satisfy one falsely. `flipFailures` inverts that:
 * a cached pre-poisoning zero would let a group align against an engine that has already lost
 * membership effects, which is precisely the alignment the term exists to refuse. So a poisoned
 * reading is never cached and never served from cache, and the cache window is exactly the bound on
 * how long a client may align against a freshly-poisoned engine — which is why the default is 0.
 */
export function createBarrierHandler(options: {
  engine: CircuitsEngineClient;
  resolveAuthClaims?: (request: Request) => Promise<JwtClaims | null> | JwtClaims | null;
  maxAgeSeconds?: number;
}) {
  let cached: { at: number; body: BarrierBody } | null = null;
  const maxAge = options.maxAgeSeconds ?? 0;

  return async function handleBarrier(request: Request): Promise<Response> {
    const claims = options.resolveAuthClaims ? await options.resolveAuthClaims(request) : null;
    // The barrier says nothing about any subject's data — only whether the engine has finished
    // propagating — but it is still engine internals, so it needs a caller we recognise.
    if (options.resolveAuthClaims && claims === null) {
      return Response.json({ error: "unauthenticated" }, { status: 401 });
    }

    const now = Date.now() / 1000;
    if (cached && now - cached.at < maxAge) return Response.json(cached.body);

    const state = await options.engine.replicationState();
    const body = { sync: state.sync, pendingFlips: state.pendingFlips, flipFailures: state.flipFailures };
    cached = body.flipFailures > 0 ? null : { at: now, body };
    return Response.json(body);
  };
}

export const barrierPath = "/sync/v1/barrier";

/** The barrier as the client reads it — the engine's LSNs are operator detail and stay server-side. */
interface BarrierBody {
  sync: boolean;
  pendingFlips: number;
  flipFailures: number;
}
