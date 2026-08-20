import type { JwtClaims, PredicateValue, SyncTableRegistry } from "@pgxsinkit/contracts";

import { compileShapeRequest } from "./compile";
import type { EntitlementSet } from "./edge";
import type { CircuitsEngineClient } from "./engine-client";
import { DEFAULT_STREAM_TOKEN_TTL_SECONDS, mintStreamToken, type StreamGrant } from "./stream-token";

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
    const result = await subscribeToShapes(options, claims, body.subscriptions, Math.floor(Date.now() / 1000));

    // 200 even when everything was denied: the per-subscription reasons ARE the response, and
    // collapsing them to a status code would tell a client that lost one scope out of K nothing
    // about which one.
    return Response.json(result);
  };
}
