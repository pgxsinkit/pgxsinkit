import {
  readShapeTier,
  type JwtClaims,
  type PredicateValue,
  type SyncTableEntry,
  type SyncTableRegistry,
} from "@pgxsinkit/contracts";

import {
  compileShapeRequest,
  fingerprintShapeRequest,
  resolveEntryByShapeKey,
  type CompiledShapeRequest,
} from "./compile";
import { EntitlementsUnavailableError, type EntitlementSet } from "./edge";
import { CircuitsEngineError, type CircuitsEngineClient } from "./engine-client";
import { DEFAULT_STREAM_TOKEN_TTL_SECONDS, mintStreamToken, verifyStreamToken, type StreamGrant } from "./stream-token";
import type { CircuitsShapeHandle, CreateShapeRequest } from "./wire";

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
 * The engine's subscription lease is shorter than this deployment's token TTL — a **configuration**
 * fault, not a request one.
 *
 * The control plane renews every live claim on exactly one cadence: the token re-mint, which the
 * client drives at `expiresAt - skew` and which therefore lands at most `ttlSeconds` apart. The
 * engine releases a claim not renewed within `leaseSeconds` (`ELECTRIC_CIRCUITS_SHAPE_IDLE_SECS`).
 * So a deployment whose lease window is under two TTLs has no margin at all: one refresh delayed by a
 * retry, a redeploy, or a sleeping tab, and a live session's shape goes dormant underneath it. The
 * factor of two is the margin for exactly one missed refresh.
 *
 * Refused loudly rather than papered over, because both numbers are the operator's and neither the
 * subject nor the client can do anything about either. The routes answer 503 — "this deployment, not
 * you" — and never a denial: a client told it lost entitlement truncates its rows.
 */
export class CircuitsLeaseConfigError extends Error {
  /** The engine's `ELECTRIC_CIRCUITS_SHAPE_IDLE_SECS`, as the create response reported it. */
  readonly leaseSeconds: number;
  /** The stream-token TTL this control plane is configured with. */
  readonly ttlSeconds: number;

  constructor(leaseSeconds: number, ttlSeconds: number) {
    super(
      `[pgxsinkit] the sync engine's shape lease window (${leaseSeconds}s, ` +
        `ELECTRIC_CIRCUITS_SHAPE_IDLE_SECS) is shorter than twice this control plane's stream-token TTL ` +
        `(${ttlSeconds}s, the \`ttlSeconds\` option). Claims are renewed on the token re-mint, so a single ` +
        `missed refresh would let a live session's subscription lapse and its shape go dormant underneath ` +
        `it. Raise ELECTRIC_CIRCUITS_SHAPE_IDLE_SECS to at least ${2 * ttlSeconds}, lower \`ttlSeconds\` to ` +
        `at most ${Math.floor(leaseSeconds / 2)}, or set ELECTRIC_CIRCUITS_SHAPE_IDLE_SECS=0 to disable ` +
        `leases entirely.`,
    );
    this.name = "CircuitsLeaseConfigError";
    this.leaseSeconds = leaseSeconds;
    this.ttlSeconds = ttlSeconds;
  }
}

/**
 * `leaseSeconds === 0` means the engine has dormancy — and with it leases — switched off, so there is
 * no window to fall out of and nothing to check. Anything else must cover two re-mints.
 */
function assertLeaseCoversTtl(leaseSeconds: number, ttlSeconds: number): void {
  if (leaseSeconds !== 0 && leaseSeconds < 2 * ttlSeconds) throw new CircuitsLeaseConfigError(leaseSeconds, ttlSeconds);
}

/**
 * The engine must record a claim under the name it was given — on the create that TAKES it and on
 * every create that RENEWS it alike.
 *
 * An engine that renames a claim is one this control plane can neither renew nor release by id, which
 * is the whole protocol (fork ADR-0008): the renewal would take a second claim every time, and the
 * release would name something the engine never held. That is the wrong engine, not a degraded one,
 * so it throws rather than degrading — there is no answer this client could go on to give.
 */
function assertClaimRecorded(handle: CircuitsShapeHandle, claim: string): void {
  if (handle.subscription === claim) return;
  throw new Error(
    `[pgxsinkit] the engine recorded this shape claim under \`${handle.subscription}\` rather than the ` +
      `subscription id it was sent (\`${claim}\`). Renewal and release are BY that id (fork ADR-0008), ` +
      `so an engine that renames a claim is not the one this client targets.`,
  );
}

/**
 * Compile one shape for one scope — the single form both the subscribe and the re-mint paths use.
 *
 * Shared between them on purpose: the re-mint RENEWS each grant's engine claim by repeating the create
 * that took it, so the request it sends has to be the request subscribe would build today. Two
 * spellings of "compile this grant" would be two chances for a renew to name a different definition
 * than the grant it is renewing — which the engine would answer with a different handle, and this
 * route would read as a revocation.
 */
function compileGrant(
  options: Pick<SubscribeOptions, "registry" | "params">,
  claims: JwtClaims | null,
  shapeKey: string,
  scope?: readonly PredicateValue[],
): CompiledShapeRequest {
  return compileShapeRequest(options.registry, {
    shapeKey,
    claims,
    ...(scope !== undefined ? { scope } : {}),
    ...(options.params ? { params: options.params } : {}),
  });
}

/** What a renewal attempt came to. `renewed` is the only outcome that keeps the grant. */
type RenewalOutcome = { renewed: true } | { revoked: string };

/**
 * Renew one grant's engine claim: the SAME create, repeated with the SAME subscription id.
 *
 * This is the whole of the lease protocol on our side (fork ADR-0008). The engine has no separate
 * renew route because it needs none — a create naming a claim the shape already holds returns the same
 * handle, counts nothing, and moves the lease. So the re-mint, which already re-authorizes every grant
 * on the client's own refresh cadence, renews for free and renews exactly the grants that survived.
 *
 * The two failure outcomes are both "this is no longer the stream the client follows", and both end in
 * `revoked` rather than an error, because the client's answer to a revocation — truncate and
 * re-subscribe — is precisely the right one:
 *
 * - **A different handle.** The claim lapsed, or the shape was evicted, so this call re-subscribed
 *   instead of renewing (ADR-0007) and the engine handed back a fresh shape on a fresh path. The
 *   grant names the old one. The claim just taken is released immediately: nothing is following that
 *   new stream, and the client's re-subscribe will take its own.
 * - **409.** The id names a different shape. Nothing was taken, so there is nothing to give back.
 *
 * Anything else the engine says is an OUTAGE and propagates — the route answers 503. A revocation
 * would tell the client it lost the scope, and a client told that clears the rows. An engine that
 * renames the claim propagates too, through {@link assertClaimRecorded}: that one is not an outage
 * either, it is the wrong engine.
 */
async function renewGrantClaim(
  engine: CircuitsEngineClient,
  request: CreateShapeRequest,
  grant: StreamGrant,
  ttlSeconds: number,
): Promise<RenewalOutcome> {
  let handle;
  try {
    handle = await engine.createShape({ ...request, subscription: grant.claim });
  } catch (error) {
    if (error instanceof CircuitsEngineError && error.status === 409) {
      return { revoked: "subscription id is held by another shape; re-subscribe" };
    }
    throw error;
  }
  assertClaimRecorded(handle, grant.claim);
  // The handle comparison and the release of a fresh claim come BEFORE the lease guard, deliberately:
  // a misconfigured window is fatal to this request, and throwing it first would strand the claim
  // this very call just took.
  if (handle.shapeId !== grant.shapeId || handle.streamPath !== grant.path) {
    await engine.releaseShape(handle.shapeId, grant.claim);
    return { revoked: "shape stream changed; re-subscribe" };
  }
  assertLeaseCoversTtl(handle.leaseSeconds, ttlSeconds);
  return { renewed: true };
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
  const ttlSeconds = options.ttlSeconds ?? DEFAULT_STREAM_TOKEN_TTL_SECONDS;

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
      const compiled = compileGrant(options, claims, request.shapeKey, scope);
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

      // The claim is NAMED before it is taken, and the name is ours (fork ADR-0008). That is what
      // makes this create idempotent — a repeat with the same id renews rather than joining twice —
      // and what makes the release retry-safe: `DELETE ?subscription=…` drops this claim and only
      // this one. A uuid per grant, never per shape: two grants that deduplicate onto one shapeId are
      // two joins, and one id could only ever release one of them.
      const claim = crypto.randomUUID();

      // Deliberately unguarded: see the note above on why an engine fault is not a denial.
      const handle = await options.engine.createShape({ ...compiled.request, subscription: claim });
      assertClaimRecorded(handle, claim);
      // Checked per create rather than once at boot: the lease window is the engine's to report, and
      // this is the only place it is reported. A misconfigured pairing must surface as a 503 on the
      // very first subscribe, not as sessions quietly lapsing an idle window later.
      //
      // The claim is already taken by the time this can trip, so it is handed back before the error
      // leaves — nobody will ever follow this stream. Best effort, and the failure is SWALLOWED: the
      // configuration fault is what the operator has to see, and a release that also fails must not
      // mask it. An unreleased claim lapses on its own.
      try {
        assertLeaseCoversTtl(handle.leaseSeconds, ttlSeconds);
      } catch (error) {
        await options.engine.releaseShape(handle.shapeId, claim).catch(() => {});
        throw error;
      }

      granted.push({ shapeKey: request.shapeKey, ...scoped, shapeId: handle.shapeId, streamPath: handle.streamPath });
      // The grant carries the shapeId this `createShape` returned AND the claim it was taken under,
      // and together they are what make the renew and release routes possible at all: both are
      // stateless, so the signed token is the only record of what this session holds.
      grants.push({
        path: handle.streamPath,
        shapeKey: request.shapeKey,
        shapeId: handle.shapeId,
        claim,
        ...scoped,
        ...fp,
      });
    }
  }

  if (subject === null || grants.length === 0) return { granted, denied };

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
      // A lease window shorter than the token TTL is an operator's misconfiguration, and it joins the
      // 503s for the same reason: it is a statement about this deployment, never about this subject's
      // entitlements. Denying instead would make an unserviceable pairing look like lost access.
      if (error instanceof CircuitsLeaseConfigError) {
        return Response.json({ error: "sync engine lease window shorter than the token TTL" }, { status: 503 });
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
 * predicate, and this route may not hand out a new one — the client's re-subscribe is where a new
 * shape is created, and this route is not that. So the grant is revoked, the client re-subscribes, the
 * control plane creates the shape its current claims compile to, and because the handle differs the
 * client re-snapshots through ADR-0056 decision 7's must-refetch.
 *
 * **This is also where every surviving grant's engine claim is RENEWED** (fork ADR-0008). A claim is a
 * lease: the engine releases one not renewed within `leaseSeconds`, because native reads terminate on
 * durable-streams and the renewal is the only liveness signal it has. Renewing here rather than on a
 * timer is what makes the cadence honest — this route already runs once per subject per TTL window and
 * already decides which grants are still authorized, so the renewal covers exactly the grants that
 * survived and costs no extra round trip. A revoked grant is deliberately NOT renewed: its lease
 * lapses and the engine reclaims the shape.
 *
 * The renewal is the same create, repeated with the grant's own `claim` id. Its outcomes are in
 * {@link renewGrantClaim}; a renewal that comes back a different handle, or 409s, revokes the grant
 * with a re-subscribe reason rather than failing the whole re-mint.
 *
 * `registry` is therefore REQUIRED rather than optional: a refresh route that cannot recompile cannot
 * re-authorize the private tier — and now cannot renew either, since the renewal IS the compiled
 * create. `engine` is required for the same reason.
 *
 * Throws {@link EntitlementsUnavailableError} rather than revoking when the set cannot be consulted —
 * the same outage-is-not-a-denial rule {@link subscribeToShapes} follows, and it matters more here:
 * `revoked` is the wire's clear-this-scope instruction, and this route runs every few minutes for
 * the life of every subscription. An engine that cannot answer a renewal joins it, as does a lease
 * window this deployment's TTL does not fit inside ({@link CircuitsLeaseConfigError}).
 */
export async function refreshStreamToken(
  options: Pick<SubscribeOptions, "registry" | "engine" | "entitlements" | "key" | "ttlSeconds" | "params">,
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
  const ttlSeconds = options.ttlSeconds ?? DEFAULT_STREAM_TOKEN_TTL_SECONDS;

  for (const grant of verified.claims.grants) {
    const scoped = grant.scope !== undefined ? { scope: grant.scope } : {};
    if (grant.scope === undefined) {
      // Private tier: re-authorize by recompiling. See the note above on why the signed grant alone
      // is not the entitlement — the predicate is a function of claims that may have changed since
      // it was issued.
      const compiled = compileGrant(options, claims, grant.shapeKey);
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
      // Re-authorized, so renew the claim it holds — the recompiled request is exactly the one that
      // took it, which the fingerprint just proved.
      const renewal = await renewGrantClaim(options.engine, compiled.request, grant, ttlSeconds);
      if ("revoked" in renewal) {
        revoked.push({ shapeKey: grant.shapeKey, reason: renewal.revoked });
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
    // Still entitled, so renew. The shared tier carries no fingerprint — its predicate is generated
    // from the scope values, which is why the entitlement check above is the whole question — so the
    // request is recompiled here, through the same {@link compileGrant} subscribe used.
    const compiled = compileGrant(options, claims, grant.shapeKey, grant.scope);
    if (compiled.outcome === "deny") {
      revoked.push({ shapeKey: grant.shapeKey, ...scoped, reason: compiled.reason });
      continue;
    }
    const renewal = await renewGrantClaim(options.engine, compiled.request, grant, ttlSeconds);
    if ("revoked" in renewal) {
      revoked.push({ shapeKey: grant.shapeKey, ...scoped, reason: renewal.revoked });
      continue;
    }
    granted.push(grant);
  }

  if (granted.length === 0) return { granted, revoked };

  const token = await mintStreamToken(options.key, { sub: subject, grants: granted, ttlSeconds, now });
  return { token, expiresAt: now + ttlSeconds, granted, revoked };
}

/**
 * The re-mint route. Takes the expiring token, answers with a fresh one and the list of grants that
 * did not survive re-authorization — the shared tier's against the live entitlement set, the private
 * tier's against a recompile with the subject's current claims — and **renews the engine claim of
 * every grant that did survive** (fork ADR-0008).
 *
 * `registry` for that recompile and `engine` for that renewal, both required for the reasons
 * {@link refreshStreamToken} gives.
 *
 * 200 even when everything was revoked, for the same reason subscribe answers 200 on a full denial:
 * the per-grant reasons ARE the response, and a client that lost one scope of K needs to know which.
 */
export function createRefreshHandler(
  options: Pick<SubscribeOptions, "registry" | "engine" | "entitlements" | "key" | "ttlSeconds" | "params"> & {
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
      // An engine that could not answer a RENEWAL is the same case: the claim is still held (a lease
      // outlives a failed renewal by the rest of its window), the token the client holds still works,
      // and a `revoked` answer would clear rows over a transient fault.
      if (error instanceof CircuitsEngineError) {
        return Response.json({ error: "sync engine unavailable" }, { status: 503 });
      }
      if (error instanceof CircuitsLeaseConfigError) {
        return Response.json({ error: "sync engine lease window shorter than the token TTL" }, { status: 503 });
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
 * not create a second shape: it JOINS the existing one, under a claim of its own. Live claims are
 * load-bearing rather than bookkeeping — one live claim blocks both dormancy and eviction, precisely
 * because native durable-streams reads bypass the engine entirely, so a claim is the only thing that
 * tells it a reader it cannot see still exists. Without a release, a shape waits out its whole lease
 * window before it can go dormant, every time.
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
 * 6) — so collapsing them here would return one of two claims and leak the other permanently. Each
 * grant releases its OWN claim (`DELETE /shapes/{id}?subscription=<claim>`), which is what makes one
 * release distinguishable from the other at all.
 *
 * **Idempotent and retry-safe** (fork ADR-0008). A claim is named, so releasing it twice is releasing
 * it once: the second `DELETE` is a no-op `200` and cannot touch another subscriber's claim. That is
 * a change in kind from the anonymous refcount decrement this route was first written against, and it
 * collapses the old asymmetry — a client, a proxy or an operator may repeat a release freely. A
 * release that never arrives at all is not a permanent leak either: the claim is a LEASE, renewed on
 * the token re-mint, so a session that crashed or was unloaded has its claims reclaimed by the engine
 * within `leaseSeconds`. What this route buys is promptness, not correctness.
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
    await options.engine.releaseShape(grant.shapeId, grant.claim);
  }
  return { released: verified.claims.grants.length };
}

/**
 * The release route: the token a session was given, back at its close.
 *
 * **Safe to call more than once.** Every grant releases a NAMED claim, so a repeat is the same act
 * once (fork ADR-0008) — a duplicate close, a proxy retry or an operator replaying a request all
 * answer 200 and change nothing. The client still sends it at most once, but that is now a matter of
 * not making a pointless request rather than of correctness.
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
      // An engine that could not answer has not dropped the claims. 503 says "this deployment, not
      // you", and a client is free to come back: releases are named and therefore idempotent (fork
      // ADR-0008), so a retry that races a release which actually landed is a no-op rather than a
      // theft. Whether it retries or not, the residue is bounded by the lease — an unreleased claim
      // lapses within `leaseSeconds` of its last renewal.
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
