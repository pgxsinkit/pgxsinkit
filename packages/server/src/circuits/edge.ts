import { getTableConfig } from "drizzle-orm/pg-core";

import type { PredicateValue, RowTransform, RowTransformContext, SyncTableRegistry } from "@pgxsinkit/contracts";

import { resolveEntryByShapeKey } from "./compile";
import { findGrant, verifyStreamToken, type StreamGrant } from "./stream-token";

/**
 * The live entitlement set the edge checks a shared-tier read against (ADR-0055 decision 7).
 *
 * An interface, not an implementation, because the source is a Circuits subscription over the
 * membership relations themselves — freshness is engine propagation, not a cache TTL, and there is
 * no database on the read path.
 */
export interface EntitlementSet {
  /**
   * Whether the entitlement set can be trusted right now. False while the subscription is catching
   * up, degraded, or stale.
   *
   * The edge denies when this is false. An unavailable entitlement set is never a permit — the
   * failure mode of the alternative is a disclosure, and the failure mode of this one is a subject
   * retrying a read.
   */
  readonly ready: boolean;
  /** Whether `subject` may read `shapeKey` at `scope`. */
  permits(subject: string, shapeKey: string, scope: readonly PredicateValue[]): boolean;
  /**
   * Every scope of `shapeKey` that `subject` holds, each an ordered tuple matching the shape's
   * declared scope columns.
   *
   * This is what lets a client subscribe by shape alone (ADR-0055 decision 6): it names
   * `offering_content`, and the control plane answers with one stream per offering the subject can
   * actually read. The alternative — the client naming scopes — makes it restate something only this
   * set knows, so its every answer is either redundant or wrong.
   *
   * Enumeration and `permits` must agree: a scope returned here that `permits` would refuse is a
   * grant the edge then rejects on every read.
   */
  scopesFor(subject: string, shapeKey: string): readonly (readonly PredicateValue[])[];
}

/**
 * The entitlement set cannot be consulted right now — it is catching up, degraded, or stale.
 *
 * An OUTAGE, and thrown rather than reported per subscription for exactly the reason an engine fault
 * is: a client told "not entitled" clears that scope and unsubscribes (ADR-0055 decision 6), so
 * relaying an unavailable set as a denial would turn a transient control-plane condition into
 * client-side data loss. The routes map it to 503, which is a status a client retries through.
 *
 * The EDGE does not throw this. A read arriving while the set is unavailable is denied (see
 * {@link EntitlementSet.ready}) and a denied read is not a revocation — it is a request the client
 * makes again.
 */
export class EntitlementsUnavailableError extends Error {
  constructor() {
    super(
      "[pgxsinkit] the entitlement set is unavailable — it is catching up, degraded or stale; " +
        "shared-tier subscriptions cannot be decided right now",
    );
    this.name = "EntitlementsUnavailableError";
  }
}

export interface StreamGateOptions {
  /** Verifies the stream token. Minted by the control plane in the same process. */
  key: CryptoKey;
  /**
   * The registry the granted shapes are declared in — REQUIRED, unlike every other option here.
   *
   * The gate needs it to answer one question per read: does this shape declare a
   * `serverProjection.rowTransform`, and must its bytes therefore be rewritten before they reach the
   * client (ADR-0055 decision 5)? A gate that cannot see the registry cannot know, so it would proxy
   * a transform shape's raw rows — including the `serverOnlyColumns` fetched solely for the transform
   * — with nothing anywhere reporting a discrepancy. Making it required is what makes that mount
   * impossible to write, which is why it is not optional "for deployments with no transform shape":
   * the leak arrives on the day someone adds the first one, in a file nobody was editing.
   */
  registry: SyncTableRegistry;
  /**
   * The live entitlement set backing the shared tier. Optional for the same reason it is optional on
   * the control plane: a deployment whose registry declares no shared shape has nothing to ask it.
   * Absent, a shared-tier grant is DENIED rather than waved through — the two sides then agree that
   * an unconfigured entitlement set can never permit.
   */
  entitlements?: EntitlementSet;
  /**
   * Base URL of the durable-streams server, with whatever stream prefix it is mounted under — the
   * same value the engine is given as `ELECTRIC_CIRCUITS_DS_URL`, since both address the same paths.
   */
  durableStreamsUrl: string;
  /**
   * Deployment-supplied runtime params, handed to an egress `rowTransform` as its context's `params`
   * — the same values `SubscribeOptions.params` hands to `rowFilter.customPredicate`. A deployment
   * that configures them on one side and not the other gives its registry two different runtime
   * environments for one shape, so mount both from the same source.
   */
  params?: Record<string, unknown>;
  /** Injected for tests; defaults to the ambient `fetch`. */
  fetch?: typeof fetch;
}

/**
 * What DECIDING one read needs: the signing key, plus the entitlement set the shared tier is checked
 * against.
 *
 * Spelled as the gate's options with everything else relaxed to optional, rather than as
 * {@link StreamGateOptions} itself, because a caller that wants only the decision — a mount that
 * proxies for itself, a test pinning the authorization rules — has no gate to configure, and
 * requiring it to invent a `registry` and a `durableStreamsUrl` would demand values the answer
 * provably does not depend on.
 */
export type StreamAuthorizationOptions = Pick<StreamGateOptions, "key" | "entitlements"> &
  Partial<Omit<StreamGateOptions, "key" | "entitlements">>;

export type GateDecision =
  | {
      allow: true;
      grant: StreamGrant;
      /**
       * The token's subject. Carried on the decision because the egress transform stage needs it and
       * re-verifying the token to recover it would pay for a second HMAC on every rewritten read —
       * the verification that established it already happened here.
       */
      subject: string;
    }
  | { allow: false; reason: string };

/**
 * Authorize one read of one stream path.
 *
 * Two checks, and they are not redundant. The token is a capability bounded by its TTL, which is the
 * only bound available when a hit-serving CDN sits in front and the request never reaches us. The
 * entitlement lookup is live, and bounds revocation by propagation latency instead whenever the
 * request does reach us. Which one binds is a property of the deployment, not of this code.
 *
 * A private-tier grant has no scope to check, so the token is the whole authorization and its TTL is
 * the whole revocation bound. That is the same bound a CDN-fronted shared read has, and it is worth
 * stating rather than leaving to be inferred.
 */
export async function authorizeStreamRead(
  options: StreamAuthorizationOptions,
  token: string | null,
  path: string,
  now: number,
): Promise<GateDecision> {
  if (token == null || token === "") return { allow: false, reason: "no stream token" };

  const verified = await verifyStreamToken(options.key, token, now);
  if (!verified.ok) return { allow: false, reason: verified.reason };

  const grant = findGrant(verified.claims, path);
  if (grant == null) return { allow: false, reason: "token grants no such stream" };

  const subject = verified.claims.sub;
  if (grant.scope === undefined) return { allow: true, grant, subject };

  const entitlements = options.entitlements;
  if (entitlements === undefined) {
    return { allow: false, reason: "shared-tier grant, but this deployment configured no entitlement set" };
  }
  if (!entitlements.ready) return { allow: false, reason: "entitlements unavailable" };
  if (!entitlements.permits(subject, grant.shapeKey, grant.scope)) {
    return { allow: false, reason: "not entitled to this scope" };
  }
  return { allow: true, grant, subject };
}

/**
 * Read the stream token off a request.
 *
 * `Authorization`, never a query parameter, and this is a correctness condition rather than a
 * convention: the cache key is the URL, so a token in the URL gives every subscriber a distinct key
 * and destroys precisely the sharing the shared tier exists for. A cache must also be configured not
 * to vary on this header — which it can only do if the header is where the token is.
 */
export function readStreamToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (header == null) return null;
  const [scheme, value] = header.split(" ");
  return scheme?.toLowerCase() === "bearer" && value ? value : null;
}

/**
 * The response headers a browser must be allowed to READ off a stream-edge response.
 *
 * CORS lets script see only a short safelist of response headers (`cache-control`, `content-language`,
 * `content-length`, `content-type`, `expires`, `last-modified`, `pragma`). Every header the
 * durable-streams protocol answers with is outside it, so a CROSS-ORIGIN reader sees NONE of them
 * unless the mount names them on `Access-Control-Expose-Headers`.
 *
 * The failure that follows is silent and expensive rather than loud. `@durable-streams/client` drives
 * its entire read loop off these headers — verified by grepping the installed 0.2.6 dist
 * (`@durable-streams/client/dist/index.js`, mirrored in its shipped `src/`): `Stream-Next-Offset`,
 * `Stream-Cursor` and `Stream-Closed` are read per response, `Stream-Up-To-Date` is a presence check
 * (`headers.has`, which is why it is easy to miss), `stream-sse-data-encoding` decides SSE payload
 * decoding, and `etag` is read on the stream-metadata path. Stripped of them, the client never learns
 * an offset: it re-requests `offset=-1` forever and never switches to a live long poll, which presents
 * as a hot loop of hundreds of requests per second per shape with no error raised anywhere.
 *
 * `Stream-Seq`, `Stream-TTL` and `Stream-Expires-At` are request headers in that client version. They
 * are named here anyway because this list is a statement about the ds protocol's response namespace
 * rather than about which subset one client version happens to read today — exposing a header a
 * response never carries is inert, while omitting one that it does carry wedges the reader. The
 * `Producer-*` headers are deliberately absent: they belong to the write path, which does not come
 * through this gate.
 *
 * EVERY mount of `createStreamGate` must put these on `Access-Control-Expose-Headers` of the ACTUAL
 * (non-preflight) response. The gate cannot do it itself — it forwards the upstream response's
 * headers (verbatim for an ordinary shape, minus the caching ones for a rewritten one), and an
 * exposure list is meaningless without the `Access-Control-Allow-Origin` decision that only the mount
 * owns.
 */
export const STREAM_READ_EXPOSED_HEADERS: readonly string[] = [
  "stream-next-offset",
  "stream-up-to-date",
  "stream-cursor",
  "stream-closed",
  "stream-seq",
  "stream-ttl",
  "stream-expires-at",
  "stream-sse-data-encoding",
  "etag",
];

/**
 * A durable-streams long-poll body as the transform stage handles it.
 *
 * Deliberately NOT `StreamEnvelope`: the gate is a proxy, and typing the body as the contract would
 * assert that the edge validates a wire form it only ever forwards. All it needs to know is that an
 * envelope may carry a `value` object — a delete envelope is key-only, so it has nothing to rewrite
 * and nothing to disclose.
 */
interface ProxiedEnvelope {
  value?: unknown;
  [key: string]: unknown;
}

/**
 * The response headers a rewritten body may be answered with.
 *
 * `cache-control: private, no-store` is the governing invariant, not a precaution: a transform makes
 * the bytes a function of the SUBJECT, so nothing between this edge and the browser that requested
 * them may share or store them. `etag` goes for the same reason — an upstream validator describes the
 * bytes durable-streams holds, not the ones we just produced, and honouring it would let a
 * revalidation return another subject's rewrite. `content-length` and `content-encoding` describe a
 * body that no longer exists: the length changed under the rewrite, and `fetch` already decoded what
 * it handed us.
 *
 * Everything else is kept VERBATIM — every `stream-*` header and the content type. The client's whole
 * read loop drives off them (see {@link STREAM_READ_EXPOSED_HEADERS}); an edge that dropped
 * `stream-next-offset` while rewriting would present as a hot loop, not as a redaction bug.
 */
function rewrittenEgressHeaders(upstream: Headers): Headers {
  const headers = new Headers(upstream);
  headers.delete("content-length");
  headers.delete("content-encoding");
  headers.delete("etag");
  headers.set("cache-control", "private, no-store");
  return headers;
}

/** Whether this read asks for SSE framing, by either of the two ways the ds protocol expresses it. */
function asksForSse(request: Request): boolean {
  return (
    new URL(request.url).searchParams.get("live") === "sse" ||
    (request.headers.get("accept") ?? "").includes("text/event-stream")
  );
}

/**
 * The edge: gate, then proxy bytes — rewriting them only for the shapes that declare a rewrite.
 *
 * There is no per-read FILTERING here at all, and no per-read rewriting for shapes that declare none.
 * Predicates were resolved at shape creation, so what remains for almost every read is a decision and
 * a copy — which is why this can sit in the TypeScript control-plane process without CPU being the
 * axis that decides where it belongs.
 *
 * A shape that declares `serverProjection.rowTransform` is the one exception: it is rewritten HERE,
 * per request, with the subject taken from the stream token, and answered `private, no-store`. This
 * is the rewriting origin ADR-0055 decision 5 names, confined to the shapes that incur it — a
 * transform shape gives up CDN shareability and SSE framing, and every other shape gives up nothing.
 * The transform's `serverOnlyColumns` are fetched by the engine so the transform can read them and
 * are stripped here, after it runs, to the columns the client's local table declares.
 *
 * The claims a transform sees at the edge are `{ sub }` and nothing else: a stream token carries the
 * subject, not the JWT it was minted from, and re-deriving richer claims per read would put an auth
 * provider call on the read path this whole topology exists to keep off it. A transform that needs
 * more than the subject is therefore NOT expressible at egress — put the subject-dependent part in
 * the shape's private `rowFilter.customPredicate`, which is compiled at subscribe time from the full
 * verified claims.
 */
export function createStreamGate(options: StreamGateOptions) {
  const doFetch = options.fetch ?? fetch;
  const base = options.durableStreamsUrl.replace(/\/+$/, "");

  return async function handleStreamRead(request: Request, path: string, now: number): Promise<Response> {
    const decision = await authorizeStreamRead(options, readStreamToken(request), path, now);
    if (!decision.allow) {
      return new Response(JSON.stringify({ error: decision.reason }), {
        status: 403,
        headers: { "content-type": "application/json" },
      });
    }

    // Resolved by shapeKey, exactly as the control plane resolved it to create the shape, so the edge
    // and the control plane cannot disagree about which declaration governs this stream.
    const entry = resolveEntryByShapeKey(options.registry, decision.grant.shapeKey);
    const transform: RowTransform | undefined = entry?.serverProjection?.rowTransform;

    // Refused BEFORE the upstream fetch: the rewrite needs a whole JSON body per response, and SSE
    // delivers a frame stream instead. Parsing that would mean a second body parser for a mode no
    // pgxsinkit client uses, so the mode is declined rather than half-supported.
    if (transform != null && asksForSse(request)) {
      return new Response(
        JSON.stringify({ error: "this shape is rewritten at egress and is served as JSON long-poll only" }),
        { status: 406, headers: { "content-type": "application/json" } },
      );
    }

    // Forward the ds protocol's own query string untouched — offsets and the live flag are the
    // protocol's, not ours, and rewriting them is how a proxy ends up owning a contract it does not
    // define. The token does NOT travel on: durable-streams has no read authorization in any
    // implementation, so it would only be an unread secret sitting in another service's logs.
    const upstreamUrl = new URL(`${base}/${path}`);
    upstreamUrl.search = new URL(request.url).search;

    const forwarded = new Headers(request.headers);
    forwarded.delete("authorization");
    forwarded.delete("host");

    const init: RequestInit = { method: request.method, headers: forwarded, signal: request.signal };

    // The pass-through path hands back the upstream Response OBJECT, untouched. Not "an equivalent
    // response" — the same one, so a shape that declares no transform pays nothing for the existence
    // of this stage and keeps whatever caching headers durable-streams answered with.
    if (transform == null || entry == null) return doFetch(upstreamUrl, init);

    const upstream = await doFetch(upstreamUrl, init);
    const headers = rewrittenEgressHeaders(upstream.headers);

    // 204 long-poll timeouts, 304s, upstream errors, and HEAD probes: nothing to rewrite, but they
    // are still answers about a subject-dependent stream, so they leave with the same no-store,
    // no-etag posture. HEAD belongs here because it answers `application/json` with NO body — parsing
    // it would throw on a request that is only asking for the headers.
    if (
      request.method === "HEAD" ||
      upstream.status !== 200 ||
      !(upstream.headers.get("content-type") ?? "").includes("application/json")
    ) {
      return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers });
    }

    const parsed = (await upstream.json()) as unknown;
    const isBatch = Array.isArray(parsed);
    const envelopes = (isBatch ? parsed : [parsed]) as ProxiedEnvelope[];

    // The client keep-set: the columns the LOCAL table declares, computed once per request. Stripping
    // to it after the transform runs is what keeps `serverOnlyColumns` — fetched by the engine solely
    // so the transform could read them — off the client wire, and it also drops any key a transform
    // invented, so an egress rewrite can never widen the shape the client's schema was built for.
    const keep = new Set(getTableConfig(entry.localTable).columns.map((column) => column.name));
    const context: RowTransformContext = {
      claims: { sub: decision.subject },
      ...(options.params ? { params: options.params } : {}),
    };

    const rewritten = envelopes.map((envelope) => {
      const value = envelope?.value;
      if (value == null || typeof value !== "object") return envelope;
      const transformed = transform(value as Record<string, unknown>, context);
      const stripped: Record<string, unknown> = {};
      for (const [column, cell] of Object.entries(transformed)) {
        if (keep.has(column)) stripped[column] = cell;
      }
      return { ...envelope, value: stripped };
    });

    // Answered in the shape it arrived in. A ds long-poll body is an array, and the single-object case
    // is only defensive — re-emitting it as an array would corrupt a body the client can parse today.
    return new Response(JSON.stringify(isBatch ? rewritten : rewritten[0]), {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    });
  };
}
