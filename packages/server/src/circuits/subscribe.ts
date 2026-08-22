import {
  readShapeTier,
  type JwtClaims,
  type PredicateValue,
  type SyncTableEntry,
  type SyncTableRegistry,
} from "@pgxsinkit/contracts";

import { compileShapeRequest, fingerprintShapeRequest, resolveEntryByShapeKey } from "./compile";
import { EntitlementsUnavailableError, type EntitlementSet } from "./edge";
import { CircuitsEngineError, type CircuitsEngineClient } from "./engine-client";
import { DEFAULT_STREAM_TOKEN_TTL_SECONDS, mintStreamToken, verifyStreamToken, type StreamGrant } from "./stream-token";

/**
 * One shape a client wants to follow.
 *
 * A shape KEY and nothing else — deliberately (ADR-0055 decision 6). A shared-tier shape fans out to
 * one stream per scope the subject holds, and the control plane does that expansion because it is
 * the only side that knows the answer: it holds the entitlement set. A client naming its own scopes
 * could only ever restate that set redundantly or contradict it, and every contradiction is a
 * denial it then has to reconcile at boot.
 */
export interface SubscriptionRequest {
  shapeKey: string;
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
  /**
   * The live entitlement set backing the SHARED tier.
   *
   * Optional, because a registry with no shared-tier shape has nothing to ask it. Omitting it is a
   * statement that this deployment has none: a shared-tier subscription is then refused with that
   * reason rather than silently permitted, so adding the first shared shape fails loudly instead of
   * serving one subject's rows to everyone.
   */
  entitlements?: EntitlementSet;
  /** The stream-token signing key, shared with the edge — the same process holds both. */
  key: CryptoKey;
  /** Per-deployment override of ADR-0055's 5-minute default. */
  ttlSeconds?: number;
  /** Deployment-supplied runtime params, handed to `rowFilter.customPredicate` as its second argument. */
  params?: Record<string, unknown>;
}

/**
 * What one requested shape expands to: the scopes to compile it at.
 *
 * `[undefined]` — a single scope-less compile — is the private tier, whose subject arrives in the
 * claims instead. A shared-tier shape expands to one entry per entitled scope, and none is a
 * refusal rather than an empty success: a subject with no scopes has nothing to read, and returning
 * zero grants silently would leave the client waiting on streams that were never created.
 *
 * An unknown shapeKey deliberately expands to `[undefined]` and is refused downstream by
 * `compileShapeRequest`, so the message for "no such shape" has exactly one author.
 *
 * Throws {@link EntitlementsUnavailableError} when the set exists but cannot be trusted yet — an
 * outage, not a refusal, and the route turns it into a 503.
 */
function expandToScopes(
  options: Pick<SubscribeOptions, "registry" | "entitlements">,
  subject: string,
  shapeKey: string,
): { scopes: readonly (readonly PredicateValue[] | undefined)[] } | { refusal: string } {
  const entry: SyncTableEntry | undefined = resolveEntryByShapeKey(options.registry, shapeKey);
  const shape = entry?.shape;
  if (shape == null) return { scopes: [undefined] };
  if (readShapeTier(shape) === "private") return { scopes: [undefined] };

  if (options.entitlements === undefined) {
    return { refusal: "shared-tier shape, but this deployment configured no entitlement set" };
  }
  // A refusal above, a THROW here, and the difference is permanence. "No entitlement set configured"
  // is a statement about this deployment that will read the same on every future request. "Not ready"
  // is a statement about this instant, and answering it with a denial would tell the client it lost
  // the scope — which makes it clear those rows. See {@link EntitlementsUnavailableError}.
  if (!options.entitlements.ready) throw new EntitlementsUnavailableError();
  const held = options.entitlements.scopesFor(subject, shapeKey);
  if (held.length === 0) return { refusal: "no entitled scopes" };
  return { scopes: held };
}

/**
 * Subscribe to a batch of shapes: compile each against the registry, check entitlement, register it
 * with the engine, and mint ONE token covering all of them.
 *
 * A shared-tier shape FANS OUT: one stream per scope the subject holds, so K requested shapes yield
 * however many grants their entitlements come to. Expansion happens here rather than on the client
 * because this is the side holding the entitlement set — see {@link SubscriptionRequest}.
 *
 * A partial result rather than an all-or-nothing one. A subject holding K scopes at boot may
 * legitimately have lost one of them, and failing the whole batch on that would deny them the K-1
 * they still hold — so a denial is reported per subscription and the rest proceed.
 *
 * That partiality covers AUTHORIZATION only. An engine that cannot answer — degraded, unreachable —
 * is not a denial and must never be reported as one: a client told "not entitled" truncates that
 * scope and unsubscribes, so reporting an outage that way would turn a transient engine fault into
 * client-side data loss. Engine failures propagate, and the route answers 503.
 *
 * An entitlement set that is not `ready` joins it. It is the same shape of failure — a dependency
 * that cannot answer right now — and the client's response to a denial is the same clear, so it
 * propagates as {@link EntitlementsUnavailableError} and the route answers 503 too. What stays a
 * denial is the set being absent altogether: that is a deployment's permanent configuration.
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
    const deny = (reason: string, scope?: readonly PredicateValue[]) =>
      denied.push({ shapeKey: request.shapeKey, ...(scope !== undefined ? { scope } : {}), reason });

    // Every read is bound to a subject, both tiers. The private tier fuses the subject into the
    // predicate and the shared tier checks it against the entitlement set, but neither has an
    // anonymous form — a token with no subject would name a bearer no revocation could reach.
    if (subject === null) {
      deny("no subject");
      continue;
    }

    const expanded = expandToScopes(options, subject, request.shapeKey);
    if ("refusal" in expanded) {
      deny(expanded.refusal);
      continue;
    }

    for (const scope of expanded.scopes) {
      const scoped = scope !== undefined ? { scope } : {};
      const compiled = compileShapeRequest(options.registry, {
        shapeKey: request.shapeKey,
        claims,
        ...scoped,
        ...(options.params ? { params: options.params } : {}),
      });
      if (compiled.outcome === "deny") {
        deny(compiled.reason, scope);
        continue;
      }

      // Enumeration said yes; ask the predicate too. The two are required to agree, and when they do
      // not it is this side that must catch it: the edge checks `permits` on EVERY read, so a scope
      // only `scopesFor` believes in would mint a capability for a stream the client can never
      // actually read. Better a denial it can see now than a stream that 403s forever.
      if (compiled.tier === "shared" && !options.entitlements?.permits(subject, request.shapeKey, scope ?? [])) {
        deny("not entitled to this scope", scope);
        continue;
      }

      // The private tier's grant records WHAT was authorized, not merely that something was. Its
      // predicate is a function of this subject's claims, and those change under the client's feet —
      // a role removed mid-session — so the re-mint has to be able to ask whether the shape this
      // grant points at is still the shape these claims compile to. The fingerprint is how it asks
      // without storing anything (ADR-0055 decision 6). The shared tier needs none: its predicate is
      // generated from the scope values, which the entitlement re-check already covers.
      const fp = compiled.tier === "private" ? { fp: await fingerprintShapeRequest(compiled.request) } : {};

      // Deliberately unguarded: see the note above on why an engine fault is not a denial.
      const handle = await options.engine.createShape(compiled.request);
      granted.push({ shapeKey: request.shapeKey, ...scoped, shapeId: handle.shapeId, streamPath: handle.streamPath });
      // The grant carries the shapeId this `createShape` returned, and that is what makes the release
      // route possible at all: this join is a refcount the engine will hold forever unless the session
      // that took it gives it back (see {@link releaseStreamGrants}).
      grants.push({
        path: handle.streamPath,
        shapeKey: request.shapeKey,
        shapeId: handle.shapeId,
        ...scoped,
        ...fp,
      });
    }
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

    // Unauthenticated is NOT a denial, for the same reason an engine outage is not: a client told
    // "not entitled" truncates the scope and unsubscribes, so answering an expired JWT that way
    // turns a re-login into data loss. 401 is what makes it a distinct, recoverable status the
    // client can retry through (ADR-0013).
    //
    // The check is on the SUBJECT, not on the claims object: a verified token with no `sub` names a
    // bearer no revocation could ever reach, so it is exactly as unusable as no token at all. A
    // deployment with no auth adapter never reaches here — `createSyncServer` refuses that pairing
    // at construction.
    if (typeof claims?.sub !== "string" || claims.sub === "") {
      return Response.json({ error: "unauthenticated" }, { status: 401 });
    }

    let result: SubscribeResult;
    try {
      result = await subscribeToShapes(options, claims, body.subscriptions, Math.floor(Date.now() / 1000));
    } catch (error) {
      // An engine that could not answer is an OUTAGE, and 503 is what keeps the client retrying.
      // Relaying it as a per-subscription denial would tell the client it lost entitlement, and a
      // client told that truncates the scope and unsubscribes — turning a transient fault into data
      // loss.
      if (error instanceof CircuitsEngineError) {
        return Response.json({ error: "sync engine unavailable" }, { status: 503 });
      }
      if (error instanceof EntitlementsUnavailableError) {
        return Response.json({ error: "entitlements unavailable" }, { status: 503 });
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
  /** Grants that survived re-authorization — see {@link refreshStreamToken} for what that is per tier. */
  granted: StreamGrant[];
  /**
   * Grants the subject may no longer read as granted: a shared scope they have lost, or a private
   * shape their current claims no longer compile to. The client truncates each and unsubscribes,
   * then re-subscribes for whatever it is entitled to now.
   */
  revoked: DeniedSubscription[];
}

/**
 * Re-mint a stream token from an existing one (ADR-0055 decision 6).
 *
 * The expiring token IS the request: its signature proves this control plane issued those grants, so
 * nothing has to be stored server-side to know what the subject held, and the edge stays stateless on
 * both halves. Expiry is deliberately not enforced here — a token is presented for re-mint precisely
 * because it is at or past its TTL — but the signature is, and **every grant is re-authorized**.
 * That re-check is what makes the TTL a revocation bound rather than a formality.
 *
 * BOTH TIERS are re-authorized, by the question each tier's authorization actually turns on.
 *
 * - Shared: the live entitlement set. Its predicate is generated from the scope values, so it cannot
 *   drift with the subject; what can change is whether the subject still holds the scope.
 * - Private: **recompile the shape with the subject's CURRENT claims** and compare the fingerprint
 *   the grant carries. A private predicate may read ANY verified claim, not only `sub`, so a subject
 *   demoted mid-session — a role dropped, a tenant changed — is still the same authenticated subject
 *   and would sail through a check that only re-verified the JWT. Re-verifying the JWT proves the
 *   bearer is still who they were; it says nothing about whether the shape they hold is still the
 *   shape their claims compile to, and only recompiling answers that.
 *
 * A fingerprint mismatch is a REVOCATION by design, including when the recompiled predicate would
 * still permit the subject something. The grant names one stream, that stream serves the old
 * predicate, and this route may not hand out a new one — creating the new shape here would bump an
 * engine refcount that is only released when the session closes, and this route is not the session's
 * close. So the grant is revoked, the client re-subscribes, the
 * control plane creates the shape its current claims compile to, and because the handle differs the
 * client re-snapshots through ADR-0056 decision 7's must-refetch. No engine call happens here at all.
 *
 * `registry` is therefore REQUIRED rather than optional: a refresh route that cannot recompile cannot
 * re-authorize the private tier, and the only honest alternatives are revoking every private grant or
 * waving them all through. Both are wrong, so the pairing is a type error instead.
 *
 * Throws {@link EntitlementsUnavailableError} rather than revoking when the set cannot be consulted —
 * the same outage-is-not-a-denial rule {@link subscribeToShapes} follows, and it matters more here:
 * `revoked` is the wire's clear-this-scope instruction, and this route runs every few minutes for
 * the life of every subscription.
 */
export async function refreshStreamToken(
  options: Pick<SubscribeOptions, "registry" | "entitlements" | "key" | "ttlSeconds" | "params">,
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
      // Private tier: re-authorize by recompiling. See the note above on why the signed grant alone
      // is not the entitlement — the predicate is a function of claims that may have changed since
      // it was issued.
      const compiled = compileShapeRequest(options.registry, {
        shapeKey: grant.shapeKey,
        claims,
        ...(options.params ? { params: options.params } : {}),
      });
      if (compiled.outcome === "deny") {
        revoked.push({ shapeKey: grant.shapeKey, reason: compiled.reason });
        continue;
      }
      if (grant.fp === undefined) {
        // Nothing to compare against, so nothing that could establish this grant is still the right
        // one. Fail closed rather than trust it: the recovery is a re-subscribe, which costs the
        // client a re-snapshot and costs the subject nothing they are still entitled to.
        revoked.push({
          shapeKey: grant.shapeKey,
          reason: "private grant carries no fingerprint and cannot be re-authorized",
        });
        continue;
      }
      if ((await fingerprintShapeRequest(compiled.request)) !== grant.fp) {
        revoked.push({ shapeKey: grant.shapeKey, reason: "shape predicate changed for this subject" });
        continue;
      }
      granted.push(grant);
      continue;
    }
    if (options.entitlements === undefined) {
      // Permanent, and therefore a real revocation: this deployment has no entitlement set, so a
      // shared grant can never be re-minted and the scope is not coming back.
      //
      // Worded as the EDGE words the same condition, and deliberately not as "entitlements
      // unavailable" — that string is now the 503 outage body, which means the exact opposite here:
      // an outage says nothing about this subject's scopes and must never clear a row.
      revoked.push({
        shapeKey: grant.shapeKey,
        ...scoped,
        reason: "shared-tier grant, but this deployment configured no entitlement set",
      });
      continue;
    }
    // Transient, and therefore NOT a revocation. `revoked` is an instruction to clear the scope, and
    // a re-mint is the most routine request on this route — an entitlement subscription that is a few
    // seconds behind would otherwise empty a subject's store every time it reconnected.
    if (!options.entitlements.ready) throw new EntitlementsUnavailableError();
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
 * The re-mint route. Takes the expiring token, answers with a fresh one and the list of grants that
 * did not survive re-authorization — the shared tier's against the live entitlement set, the private
 * tier's against a recompile with the subject's current claims.
 *
 * `registry` for that recompile, and required for the reason {@link refreshStreamToken} gives.
 *
 * 200 even when everything was revoked, for the same reason subscribe answers 200 on a full denial:
 * the per-grant reasons ARE the response, and a client that lost one scope of K needs to know which.
 */
export function createRefreshHandler(
  options: Pick<SubscribeOptions, "registry" | "entitlements" | "key" | "ttlSeconds" | "params"> & {
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
    // Same as subscribe: an unauthenticated re-mint is a credential problem, not a revocation. The
    // difference matters more here — a `revoked` answer makes the client truncate, and a token
    // expiring is the single most ordinary thing that happens on this route.
    if (typeof claims?.sub !== "string" || claims.sub === "") {
      return Response.json({ error: "unauthenticated" }, { status: 401 });
    }

    let result: RefreshResult;
    try {
      result = await refreshStreamToken(options, claims, body.token, Math.floor(Date.now() / 1000));
    } catch (error) {
      // 503, never a `revoked` list: an entitlement set that cannot answer has said nothing about
      // this subject's scopes, and a client that read it as a revocation would clear rows it still
      // holds. The client retries with the token it already has, which the edge keeps honouring
      // until its TTL lapses.
      if (error instanceof EntitlementsUnavailableError) {
        return Response.json({ error: "entitlements unavailable" }, { status: 503 });
      }
      throw error;
    }
    return Response.json(result);
  };
}

/**
 * Give back the engine claims a token's grants acquired — the close half of subscribe.
 *
 * **Why this route exists.** A native `POST /shapes` with a definition the engine already holds does
 * not create a second shape: it JOINS the existing one and increments its refcount. That refcount is
 * load-bearing rather than bookkeeping — `refcount > 0` blocks both dormancy and eviction, precisely
 * because native durable-streams reads bypass the engine entirely, so the refcount is the only thing
 * that tells it a reader it cannot see still exists. Without a release, every shape any subject ever
 * subscribed to stays active and tailer-maintained forever, across restarts, and `max_shapes` has
 * nothing dormant left to evict.
 *
 * **The token IS the request**, exactly as on the re-mint path: its signature proves this control
 * plane minted these grants, so nothing has to be stored server-side to know what was acquired.
 * Verified with `allowExpired`, and that is not a weakening — a session releases at CLOSE, which is
 * routinely past a 5-minute TTL, and expiry bounds how long a grant keeps *working*, not what it
 * proves was issued. A release grants its bearer nothing; the only thing it can do is give away
 * claims that this token's own subject holds.
 *
 * **ONE release per GRANT, deliberately not deduplicated by `shapeId`.** Two grants naming one shape
 * are two joins — the engine deduplicated identical definitions and counted both (ADR-0055 decision
 * 6) — so collapsing them here would return one of two claims and leak the other permanently.
 *
 * **The client's obligation is AT MOST ONCE, and it must never retry.** The engine's
 * `DELETE /shapes/{id}` carries no claim identity: it decrements the shared refcount and cannot tell
 * whose claim it just dropped. So the two failure modes are wildly asymmetric. A LOST release leaves
 * one claim too many — the status quo before this route existed, bounded to sessions that crashed or
 * were unloaded, and self-correcting only when the process is restarted. A DOUBLE release *steals
 * another subscriber's claim*, which can park a shape dormant underneath a live reader that is still
 * following its stream. Best-effort and silent beats retried and correct-looking; the robust form —
 * engine-side claim leases, where release is by claim id and therefore idempotent — is backlog 0012.
 *
 * Refusals are refusals, not no-ops: a bad signature or a mismatched subject answers an error rather
 * than `{ released: 0 }`, because a token presented by anyone but its own subject is not a release,
 * it is an attempt to drop the victim's claims.
 */
export async function releaseStreamGrants(
  options: { engine: CircuitsEngineClient; key: CryptoKey },
  claims: JwtClaims | null,
  token: string,
  now: number,
): Promise<{ released: number } | { refused: string }> {
  const subject = typeof claims?.sub === "string" && claims.sub !== "" ? claims.sub : null;
  if (subject === null) return { refused: "unauthenticated" };

  const verified = await verifyStreamToken(options.key, token, now, { allowExpired: true });
  if (!verified.ok) return { refused: verified.reason };
  if (verified.claims.sub !== subject) return { refused: "token subject does not match the caller" };

  for (const grant of verified.claims.grants) {
    await options.engine.releaseShape(grant.shapeId);
  }
  return { released: verified.claims.grants.length };
}

/**
 * The release route: the token a session was given, back at its close.
 *
 * 403 rather than 200 on a refusal — see {@link releaseStreamGrants} for why a refused release must
 * be visible. 401 when the caller has no subject, the same rule subscribe and re-mint follow: an
 * unauthenticated call is a credential problem, and it is the one thing here a client could fix.
 */
export function createReleaseHandler(
  options: {
    engine: CircuitsEngineClient;
    key: CryptoKey;
  } & {
    resolveAuthClaims?: (request: Request) => Promise<JwtClaims | null> | JwtClaims | null;
  },
) {
  return async function handleRelease(request: Request): Promise<Response> {
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
    if (typeof claims?.sub !== "string" || claims.sub === "") {
      return Response.json({ error: "unauthenticated" }, { status: 401 });
    }

    let result: { released: number } | { refused: string };
    try {
      result = await releaseStreamGrants(options, claims, body.token, Math.floor(Date.now() / 1000));
    } catch (error) {
      // An engine that could not answer has not dropped the claims, and the client must NOT come back
      // to try again — a release it believes was lost may in fact have landed, and the retry is the
      // double release. 503 says "this deployment, not you"; the claims leak until the engine grows
      // leases (backlog 0012).
      if (error instanceof CircuitsEngineError) {
        return Response.json({ error: "sync engine unavailable" }, { status: 503 });
      }
      throw error;
    }

    if ("refused" in result) return Response.json({ error: result.refused }, { status: 403 });
    return Response.json(result);
  };
}

/** The control-plane paths the native read path mounts. */
export const subscribePath = "/sync/v1/subscribe";
export const refreshPath = "/sync/v1/refresh";
export const releasePath = "/sync/v1/release";

/**
 * The convergence-barrier route (ADR-0056 decision 4).
 *
 * Proxied rather than exposed: the engine's control plane is unauthenticated by design and is not
 * client-reachable, so surfacing the barrier on our own authenticated endpoint costs nothing and
 * keeps the trust boundary intact.
 *
 * `maxAgeSeconds` may cache the answer briefly, but only a HEALTHY one. For the `pendingFlips` term
 * staleness is safe in exactly one direction — it moves the barrier backwards, so a stale reading can
 * only DELAY an alignment, never satisfy one falsely. `flipFailures` inverts that: a cached
 * pre-degradation zero would let a group align against an engine that has already
 * lost membership effects, which is precisely the alignment the term exists to refuse. So a degraded
 * reading is never cached and never served from cache, and the cache window is exactly the bound on
 * how long a client may align against a freshly-degraded engine — which is why the default is 0.
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
    const body = { pendingFlips: state.pendingFlips, flipFailures: state.flipFailures };
    cached = body.flipFailures > 0 ? null : { at: now, body };
    return Response.json(body);
  };
}

export const barrierPath = "/sync/v1/barrier";

/** The barrier as the client reads it — the engine's LSN is operator detail and stays server-side. */
interface BarrierBody {
  pendingFlips: number;
  /** Abandoned flip batches. Non-zero is terminal for a group reading it, and is never cached. */
  flipFailures: number;
}
