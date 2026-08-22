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

/**
 * A control-plane call that did not return 2xx, carrying the status so a caller can tell an AUTH
 * failure from an outage.
 *
 * That distinction is the whole reason this is a class rather than a bare `Error`. A 401 means the
 * subject's own credential is stale and an app can fix it by prompting for re-login (ADR-0013); a
 * 503 means the engine is unreachable and only time fixes it. Both retry, but only one of them is
 * worth telling the user about.
 */
export class ControlPlaneError extends Error {
  readonly status: number;
  readonly path: string;
  readonly body: string;

  constructor(status: number, path: string, body: string) {
    super(`[pgxsinkit] control plane ${path} → ${status}: ${body}`);
    this.name = "ControlPlaneError";
    this.status = status;
    this.path = path;
    this.body = body;
  }

  /** Whether this is the subject's credential failing, rather than the deployment. */
  get isAuthFailure(): boolean {
    return this.status === 401 || this.status === 403;
  }
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
  /**
   * Aborts in-flight control-plane requests on teardown.
   *
   * Load-bearing rather than tidy: a client stopped while its control plane is unreachable has a
   * subscribe sitting on a TCP connect that can take minutes to fail, and `stop()` waits for the boot
   * tail. Without this, teardown is held hostage by a network that is already gone.
   */
  signal?: AbortSignal;
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
   *
   * It rejects for exactly one reason — every grant was revoked, so there is no bearer left to send.
   * A control plane that could not be reached is NOT that reason: see {@link SubscriptionSession.refresh}.
   */
  token: () => Promise<string>;
  /**
   * Force a re-mint now — what a 403 from the edge should trigger. Null when nothing survived.
   *
   * A re-mint that FAILS (the control plane is down, unreachable, or answering 5xx) resolves with the
   * token already held rather than rejecting. This is the ADR-0013 "the deployment being down is not
   * the subject's problem" rule applied at the one place it is easy to get wrong: this promise is
   * awaited inside `@durable-streams/client`'s header thunk, and a rejection there kills the read
   * with no path back — the very silence backlog 0010 is about. The held token is still good for up
   * to `refreshSkewSeconds`, and when it truly lapses the edge answers 403, the stream ends, and the
   * group re-subscribes (`startCircuitsSync`'s `scheduleRestart`) — which is where a 401 surfaces as
   * `onAuthError` and a 503 as a retried subscribe, both of them recoverable and both of them
   * visible.
   */
  refresh: () => Promise<string | null>;
  /**
   * Close the session and hand its engine shape claims back — **best-effort, at most once**.
   *
   * Synchronous and fire-and-forget by design. Every grant this session was given is a refcount the
   * engine holds (a `POST /shapes` join), and `refcount > 0` blocks both dormancy and eviction, so a
   * session that never released leaves its shapes active and tailer-maintained forever. But the
   * engine's `DELETE /shapes/{id}` carries no claim identity — it decrements a shared counter — so a
   * release sent TWICE takes a claim that belongs to somebody else, and can park a shape underneath a
   * live reader. That asymmetry is why this fires exactly one request, never retries it, and never
   * reports whether it landed: a lost release costs one leaked claim, a duplicated one costs another
   * subscriber's stream.
   */
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
  /**
   * The token the SUBSCRIBE answered with, kept for the whole life of the session.
   *
   * Deliberately not `currentToken`. A re-mint only ever DROPS grants — it re-authorizes each one and
   * omits the ones that no longer pass — so the first token is a superset of every later one, and it
   * is the only record of the full set of engine claims this session acquired. Releasing with the
   * live token after a revocation narrowed it would leak exactly the claims that were revoked, which
   * are the ones nothing else will ever come back for. The release route verifies with `allowExpired`
   * precisely so this stays usable at close, long past its TTL.
   */
  let initialToken: string | null = null;
  let releaseSent = false;

  async function post(path: string, body: unknown): Promise<Record<string, unknown>> {
    const headers = new Headers(await (options.authHeaders?.() ?? {}));
    headers.set("content-type", "application/json");
    const response = await doFetch(`${controlPlane}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (!response.ok) {
      throw new ControlPlaneError(response.status, path, await response.text());
    }
    return (await response.json()) as Record<string, unknown>;
  }

  const result = await post("/sync/v1/subscribe", { subscriptions: requests });
  const grantedRaw = (result["granted"] ?? []) as Array<Record<string, unknown>>;
  const refused = (result["denied"] ?? []) as RefusedStream[];

  currentToken = (result["token"] as string | undefined) ?? null;
  initialToken = currentToken;
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
   *
   * A FAILED re-mint keeps the current token and its expiry, and resolves with it. Not leniency:
   * this runs inside the read's header thunk, so rejecting would take the stream down silently and
   * permanently, and it would do so for a condition that is routinely transient — a control plane
   * restarting, a 503 while the entitlement set catches up (which that route answers precisely so a
   * client does NOT clear anything), a laptop between networks. The held token stays valid for up to
   * the refresh skew; past that the edge refuses it, the read ends, and the group's restart path
   * re-subscribes — the loud, recoverable version of the same failure.
   *
   * The expiry is not moved either, so the next {@link token} call asks again: a failing control
   * plane is re-tried once per poll cycle, and the first answer that lands restores the lifecycle
   * without anything having noticed.
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
      } catch {
        // `currentToken`/`expiresAt` deliberately untouched: the answer that would have replaced them
        // never arrived, and the one thing worse than a stale token here is no token at all.
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
    // A refresh that revoked every grant leaves `currentToken` null: the stream-source header thunk
    // needs a usable bearer, and `Bearer null` is not a state — fail here rather than on the wire.
    if (currentToken === null) throw new Error("[pgxsinkit] no stream token — every grant was revoked on refresh");
    return currentToken;
  }

  /**
   * The one release request, built by hand rather than through {@link post}, for two reasons that are
   * both about it actually leaving the process.
   *
   * NO `options.signal`. Group teardown aborts that controller BEFORE it closes its sessions, so a
   * release riding it would be cancelled in the same tick it was created — the teardown path is
   * exactly the one that most needs the claims back.
   *
   * `keepalive`, so a page unload does not cancel it either: closing a tab is the single most common
   * way a session ends, and a release that dies with the document is the leak this route exists to
   * stop.
   *
   * Errors are SWALLOWED and nothing is retried. That is the at-most-once rule, not laziness — the
   * engine's `DELETE /shapes/{id}` is not idempotent (no claim identity, a bare refcount decrement),
   * so a retry that races a first attempt which actually landed would steal another subscriber's
   * claim. One lost claim is the tolerable failure; two claims dropped for one join is not.
   */
  function sendRelease(releaseToken: string): void {
    void (async () => {
      try {
        const headers = new Headers(await (options.authHeaders?.() ?? {}));
        headers.set("content-type", "application/json");
        await doFetch(`${controlPlane}/sync/v1/release`, {
          method: "POST",
          headers,
          body: JSON.stringify({ token: releaseToken }),
          keepalive: true,
        });
      } catch {
        // Deliberately silent: see above.
      }
    })();
  }

  return {
    granted,
    refused,
    token,
    refresh,
    close: () => {
      closed = true;
      // A session that was granted nothing holds no claim and has nothing to give back. The
      // `releaseSent` latch is what makes a second `close()` — a stop racing a teardown, say — a no-op
      // rather than a double release.
      if (initialToken === null || releaseSent) return;
      releaseSent = true;
      sendRelease(initialToken);
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
 * A body missing a term throws for the same reason and to the same effect. Defaulting the absent
 * field to zero would let a control plane that CANNOT report lost membership effects be read as one
 * reporting none — a guard that cannot trip, which is protection nobody has. Throwing leaves the
 * group on the pre-alignment gate instead: it never aligns against a barrier it cannot read whole.
 */
export function createBarrierReader(
  options: Pick<SubscriptionClientOptions, "controlPlaneUrl" | "authHeaders" | "signal" | "fetch">,
): () => Promise<ConvergenceBarrier> {
  const doFetch = options.fetch ?? fetch;
  const controlPlane = options.controlPlaneUrl.replace(/\/+$/, "");

  return async () => {
    const headers = new Headers(await (options.authHeaders?.() ?? {}));
    const response = await doFetch(`${controlPlane}/sync/v1/barrier`, {
      headers,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (!response.ok) {
      throw new ControlPlaneError(response.status, "/sync/v1/barrier", await response.text());
    }
    const body = (await response.json()) as Partial<ConvergenceBarrier>;
    if (typeof body.pendingFlips !== "number" || typeof body.flipFailures !== "number") {
      throw new Error(
        `[pgxsinkit] the barrier at /sync/v1/barrier answered without \`pendingFlips\`/\`flipFailures\` ` +
          `(${JSON.stringify(body)}). This client aligns only on the whole barrier (ADR-0056 decision 3); a control ` +
          `plane that cannot report lost membership effects is not one this client can align against.`,
      );
    }
    return { pendingFlips: body.pendingFlips, flipFailures: body.flipFailures };
  };
}
