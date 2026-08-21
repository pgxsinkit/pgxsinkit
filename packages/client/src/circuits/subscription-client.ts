import type { PredicateValue } from "@pgxsinkit/contracts";

import type { ConvergenceBarrier } from "./sync-engine";

/**
 * One shape the client wants to follow — by declared identity, and nothing else.
 *
 * No scope, deliberately (ADR-0055 decision 6). A shared-tier shape comes back as one grant per
 * scope the subject holds, expanded by the control plane, which is the only side that knows the
 * answer. So K requests can return more than K streams, and a client that tracks them by shapeKey
 * alone will lose all but one.
 */
export interface ShapeSubscriptionRequest {
  shapeKey: string;
}

/** A subscription the control plane granted. */
export interface GrantedStream {
  shapeKey: string;
  scope?: readonly PredicateValue[];
  shapeId: string;
  /** The durable-streams path, relative to the edge's stream route. */
  streamPath: string;
  /** The absolute URL to read it from, through the edge. */
  streamUrl: string;
}

/** A subscription refused, or later revoked, with why. */
export interface RefusedStream {
  shapeKey: string;
  scope?: readonly PredicateValue[];
  reason: string;
}

export interface SubscriptionClientOptions {
  /** Base URL of the control plane — the pgxsinkit server. */
  controlPlaneUrl: string;
  /** Base URL the edge serves streams from. `streamPath` is appended to it. */
  streamBaseUrl: string;
  /**
   * The caller's own auth headers, resolved per request.
   *
   * The SAME adapter the write path uses (ADR-0003): read and write authorization must not diverge,
   * and a JWT that refreshed for one has refreshed for both.
   */
  authHeaders?: () => Record<string, string> | Promise<Record<string, string>>;
  /**
   * Re-mint this many seconds before the token expires. Default 60 — comfortably inside ADR-0055's
   * 5-minute default lifetime, and large enough that a slow round trip does not race the expiry.
   */
  refreshSkewSeconds?: number;
  /** Called when a scope is revoked. The subscriber truncates that scope and unsubscribes. */
  onRevoked?: (revoked: RefusedStream[]) => void;
  fetch?: typeof fetch;
}

export interface SubscriptionSession {
  granted: GrantedStream[];
  refused: RefusedStream[];
  /**
   * The current stream token, re-minted on demand.
   *
   * Hand this straight to the sync engine: it is called per request, so a token that expires mid-poll
   * is replaced without the subscription noticing.
   */
  token: () => Promise<string>;
  /** Force a re-mint now — what a 403 from the edge should trigger. Null when nothing survived. */
  refresh: () => Promise<string | null>;
  close: () => void;
}

const DEFAULT_REFRESH_SKEW_SECONDS = 60;

/**
 * The client's half of the native subscribe path (ADR-0055 decisions 6 and 10).
 *
 * The native path inverts how a client finds a stream. On the Electric path it *constructed* a URL
 * (`electricUrl?table=<shapeKey>`) and the proxy resolved it; here it **asks**, and the control plane
 * answers with the streams the subject may actually read. That inversion is what removes shape
 * selection from the wire entirely — there is no client-supplied `where` or `table` left to discard.
 */
export async function openSubscriptionSession(
  options: SubscriptionClientOptions,
  requests: readonly ShapeSubscriptionRequest[],
): Promise<SubscriptionSession> {
  const doFetch = options.fetch ?? fetch;
  const controlPlane = options.controlPlaneUrl.replace(/\/+$/, "");
  const streamBase = options.streamBaseUrl.replace(/\/+$/, "");
  const skew = options.refreshSkewSeconds ?? DEFAULT_REFRESH_SKEW_SECONDS;

  let currentToken: string | null = null;
  let expiresAt = 0;
  let inFlight: Promise<string | null> | null = null;
  let closed = false;

  async function post(path: string, body: unknown): Promise<Record<string, unknown>> {
    const headers = new Headers(await (options.authHeaders?.() ?? {}));
    headers.set("content-type", "application/json");
    const response = await doFetch(`${controlPlane}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`[pgxsinkit] control plane ${path} → ${response.status}: ${await response.text()}`);
    }
    return (await response.json()) as Record<string, unknown>;
  }

  const result = await post("/sync/v1/subscribe", { subscriptions: requests });
  const grantedRaw = (result["granted"] ?? []) as Array<Record<string, unknown>>;
  const refused = (result["denied"] ?? []) as RefusedStream[];

  currentToken = (result["token"] as string | undefined) ?? null;
  expiresAt = (result["expiresAt"] as number | undefined) ?? 0;

  const granted: GrantedStream[] = grantedRaw.map((entry) => ({
    shapeKey: entry["shapeKey"] as string,
    ...(entry["scope"] !== undefined ? { scope: entry["scope"] as readonly PredicateValue[] } : {}),
    shapeId: entry["shapeId"] as string,
    streamPath: entry["streamPath"] as string,
    streamUrl: `${streamBase}/${String(entry["streamPath"]).replace(/^\/+/, "")}`,
  }));

  /**
   * Re-mint, single-flight.
   *
   * K subscriptions share one token, so K concurrent polls hitting expiry at once would otherwise
   * fire K refreshes for the same window — the exact fan-out ADR-0055 batches the token to avoid.
   */
  async function refresh(): Promise<string | null> {
    if (closed || currentToken === null) return null;
    if (inFlight) return inFlight;

    inFlight = (async () => {
      try {
        const refreshed = await post("/sync/v1/refresh", { token: currentToken });
        const revoked = (refreshed["revoked"] ?? []) as RefusedStream[];
        if (revoked.length > 0) options.onRevoked?.(revoked);

        currentToken = (refreshed["token"] as string | undefined) ?? null;
        expiresAt = (refreshed["expiresAt"] as number | undefined) ?? 0;
        return currentToken;
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  }

  async function token(): Promise<string> {
    if (currentToken === null) throw new Error("[pgxsinkit] no stream token — nothing was granted");
    // Refresh on the SKEW, not on expiry: a token that expires while a long-poll is in flight would
    // otherwise 403 the poll and cost a round trip to discover what the clock already knew.
    if (Date.now() / 1000 >= expiresAt - skew) {
      const refreshed = await refresh();
      if (refreshed !== null) return refreshed;
    }
    return currentToken;
  }

  return {
    granted,
    refused,
    token,
    refresh,
    close: () => {
      closed = true;
    },
  };
}

/**
 * Read the engine's convergence barrier through the control plane — the `readBarrier` the sync
 * engine takes.
 *
 * An unreachable barrier throws, and the engine treats that as a DELAY rather than a failure
 * (ADR-0056): the group stays on the pre-alignment gate and tries again on the next delivery. So a
 * control plane that is briefly down costs boot latency, not correctness.
 *
 * `flipFailures` is read defensively rather than trusted to be present: a control plane older than
 * the poison gate omits it, and defaulting it to zero there is right — that deployment cannot report
 * a poisoning, so inventing one would degrade every group on it.
 */
export function createBarrierReader(
  options: Pick<SubscriptionClientOptions, "controlPlaneUrl" | "authHeaders" | "fetch">,
): () => Promise<ConvergenceBarrier> {
  const doFetch = options.fetch ?? fetch;
  const controlPlane = options.controlPlaneUrl.replace(/\/+$/, "");

  return async () => {
    const headers = new Headers(await (options.authHeaders?.() ?? {}));
    const response = await doFetch(`${controlPlane}/sync/v1/barrier`, { headers });
    if (!response.ok) {
      throw new Error(`[pgxsinkit] barrier → ${response.status}`);
    }
    const body = (await response.json()) as Partial<ConvergenceBarrier>;
    return { sync: body.sync === true, pendingFlips: body.pendingFlips ?? 0, flipFailures: body.flipFailures ?? 0 };
  };
}
