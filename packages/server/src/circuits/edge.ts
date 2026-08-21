import type { PredicateValue } from "@pgxsinkit/contracts";

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

export interface StreamGateOptions {
  /** Verifies the stream token. Minted by the control plane in the same process. */
  key: CryptoKey;
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
  /** Injected for tests; defaults to the ambient `fetch`. */
  fetch?: typeof fetch;
}

export type GateDecision = { allow: true; grant: StreamGrant } | { allow: false; reason: string };

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
  options: StreamGateOptions,
  token: string | null,
  path: string,
  now: number,
): Promise<GateDecision> {
  if (token == null || token === "") return { allow: false, reason: "no stream token" };

  const verified = await verifyStreamToken(options.key, token, now);
  if (!verified.ok) return { allow: false, reason: verified.reason };

  const grant = findGrant(verified.claims, path);
  if (grant == null) return { allow: false, reason: "token grants no such stream" };

  if (grant.scope === undefined) return { allow: true, grant };

  const entitlements = options.entitlements;
  if (entitlements === undefined) {
    return { allow: false, reason: "shared-tier grant, but this deployment configured no entitlement set" };
  }
  if (!entitlements.ready) return { allow: false, reason: "entitlements unavailable" };
  if (!entitlements.permits(verified.claims.sub, grant.shapeKey, grant.scope)) {
    return { allow: false, reason: "not entitled to this scope" };
  }
  return { allow: true, grant };
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
 * (non-preflight) response. The gate cannot do it itself — it hands back the upstream response
 * unchanged, and an exposure list is meaningless without the `Access-Control-Allow-Origin` decision
 * that only the mount owns.
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
 * The edge: gate, then proxy bytes.
 *
 * There is no per-read filtering and no per-read rewriting here, and that absence is the design.
 * Predicates were resolved at shape creation and redaction was pre-computed in Postgres, so what
 * remains is a decision and a copy — which is why this can sit in the TypeScript control-plane
 * process without CPU being the axis that decides where it belongs.
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

    // Forward the ds protocol's own query string untouched — offsets and the live flag are the
    // protocol's, not ours, and rewriting them is how a proxy ends up owning a contract it does not
    // define. The token does NOT travel on: durable-streams has no read authorization in any
    // implementation, so it would only be an unread secret sitting in another service's logs.
    const upstream = new URL(`${base}/${path}`);
    upstream.search = new URL(request.url).search;

    const forwarded = new Headers(request.headers);
    forwarded.delete("authorization");
    forwarded.delete("host");

    return doFetch(upstream, {
      method: request.method,
      headers: forwarded,
      signal: request.signal,
    });
  };
}
