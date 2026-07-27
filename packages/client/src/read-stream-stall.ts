import { BackoffDefaults, type BackoffOptions } from "@electric-sql/client";

/**
 * The read path's OUTAGE seam (board ADR-0010 "offline return").
 *
 * Every shape fetch runs inside Electric's `createFetchWithBackoff`, which retries a failed attempt
 * **forever** (`maxRetries: Infinity` — "clients may go offline and come back") and only re-throws a
 * non-retryable 4xx. A network-level failure therefore never escapes that wrapper: `ShapeStream.onError`
 * is never called, so neither is `onReadStreamError`, and a runtime keying off those alone reports
 * `syncing` for as long as the machine stays offline. `backoffOptions.onFailedAttempt` is the ONLY signal
 * Electric surfaces from inside the loop, and it is what this probe turns into a runtime status change.
 *
 * The two seams PARTITION the failures, they do not overlap:
 *
 * - **Retried inside the wrapper** (a rejected request — the offline case, with no HTTP status at all — a
 *   5xx, or a 429) → nobody else will ever hear about it. This probe's `onStalled`.
 * - **Escapes the wrapper** (any other 4xx: 401/403 auth, 404/409/… structural) → `ShapeStream.onError`,
 *   i.e. `createShapeErrorHandler` → `onAuthError` / `onReadStreamError`, which own it and carry a real
 *   error message. Deliberately NOT reported here, so a rejected token still surfaces as the more
 *   actionable `auth-needed` and an expired handle's 409 stays the recovery it is.
 * - **A deliberate abort** — a stream teardown, a hidden tab (`PAUSE_STREAM`), a live-request timeout, a
 *   system wake, and the live-tail nudge's `forceDisconnectAndRefresh` all abort the in-flight request,
 *   and Electric calls `onFailedAttempt` for the resulting `AbortError` like any other. None is an
 *   outage; counting them would report "connection needed" for backgrounding a tab.
 *
 * `onFailedAttempt` carries no arguments, so the classification is made one layer down, in the
 * `fetchClient` this probe supplies: it records how the attempt that just settled would be treated by the
 * very next lines of Electric's own catch block. Recovery needs nothing here — the runtime clears a
 * stream-degraded status on the next delivered batch (`onSyncActivity`), which a resumed stream produces
 * on its first successful poll.
 */
export interface ReadStreamStallProbe {
  /** Pass as `ShapeStreamOptions.backoffOptions` — Electric's defaults plus the failed-attempt hook. */
  backoffOptions: BackoffOptions;
  /** Pass as `ShapeStreamOptions.fetchClient` — the innermost transport, wrapped to classify each attempt. */
  fetchClient: typeof fetch;
}

/**
 * The CALL signature of `fetch`, without the runtime-specific statics (Bun's global carries `preconnect`).
 * A ShapeStream only ever invokes its `fetchClient` as a plain call, so this is the honest contract for a
 * transport being wrapped — and it is what lets a test inject a failing one.
 */
type FetchLike = (request: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => Promise<Response>;

/**
 * Would Electric SWALLOW this response status and retry it inside the backoff loop? Mirrors the branch in
 * `createFetchWithBackoff`: a 4xx is re-thrown (and reaches `onError`) unless it is the one retryable
 * status, 429; everything else — 5xx above all — is retried where no other seam can see it.
 */
function isRetriedInsideBackoff(status: number): boolean {
  return status === 429 || status < 400 || status >= 500;
}

export function createReadStreamStallProbe(input: {
  /**
   * Notified per failed attempt that Electric will retry internally, never for an escaping 4xx and never
   * for a deliberate abort. Fires repeatedly while an outage lasts — Electric retries forever — so the
   * consumer owns the transition/dedup, not this probe.
   */
  onStalled: () => void;
  /** The transport to wrap. Defaults to the global `fetch`; a test injects the failure here. */
  fetchClient?: FetchLike;
}): ReadStreamStallProbe {
  const transport = input.fetchClient;
  // How the attempt that just settled will be treated by Electric's catch block. Written by the fetch
  // wrapper and read by `onFailedAttempt`, which Electric invokes in the catch of the very call that just
  // settled — no await sits between the two, so the pairing holds. Per-probe (one probe per shape), so a
  // sibling shape's traffic can never answer for this one.
  let lastAttemptRetried = false;
  const fetchClient = (async (request: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    try {
      const response = await (transport ? transport(request, init) : fetch(request, init));
      // The server answered. `ok` means no failed attempt at all; otherwise the backoff wrapper turns it
      // into a `FetchError` and either swallows it (5xx/429 — ours) or re-throws it (4xx — `onError`'s).
      lastAttemptRetried = !response.ok && isRetriedInsideBackoff(response.status);
      return response;
    } catch (error) {
      // A rejection: a transport fault (retried forever — the outage) unless the request was deliberately
      // aborted, which Electric turns into a `FetchBackoffAbortError` rather than a retry.
      lastAttemptRetried = init?.signal?.aborted !== true;
      throw error;
    }
    // `typeof fetch` (Bun's global) carries a `preconnect` member the wrapper neither has nor needs — the
    // ShapeStream only ever invokes fetchClient as a plain fetch — so the shape-compatible cast is safe.
  }) as typeof fetch;

  return {
    fetchClient,
    // `ShapeStream` uses `options.backoffOptions ?? BackoffDefaults` — it SPREADS, it does not merge — so
    // a partial object would blank Electric's timings. Spreading `BackoffDefaults` keeps them (1000 /
    // 32000 / 2, `maxRetries: Infinity`) and tracks upstream if they ever move: adding this callback is
    // behaviour-neutral for retrying.
    backoffOptions: {
      ...BackoffDefaults,
      onFailedAttempt: () => {
        if (!lastAttemptRetried) return;
        input.onStalled();
      },
    },
  };
}
