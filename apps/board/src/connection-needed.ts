import { isAuthRetryableFetchError } from "@supabase/supabase-js";

import type { SyncRuntimeStatus } from "@pgxsinkit/contracts";

// The board's ONE connection-needed pattern (board ADR-0010). Wherever data cannot exist offline —
// Member chat (`lazy + ephemeral`: a TEMP cluster leaves no durable trace by design), an Admin chat never
// yet activated, and sign-in for a signed-out visitor — the surface says so explicitly instead of
// presenting an indefinite skeleton or a dead button. Two surfaces, two signals, one vocabulary.

export const CONNECTION_NEEDED_CHAT =
  "Chat needs a connection to load. It will appear automatically when you're back online.";

export const CONNECTION_NEEDED_SIGN_IN = "Signing in needs a connection. Reconnect and try again.";

/**
 * Whether the read path currently cannot reach the backend, read off the same {@link SyncRuntimeStatus}
 * the SyncBadge renders. `degraded` is the runtime's only "the stream is not being served" phase: a
 * network-level shape-stream failure has no HTTP status, so Electric retries it forever INSIDE its own
 * backoff wrapper and it never surfaces as a stream error at all — the runtime learns of it through
 * `backoffOptions.onFailedAttempt` (pgxsinkit `read-stream-stall.ts`) and enters `degraded`, clearing back
 * to `syncing`/`ready` on the next delivered batch. That recovery is why callers derive this at render
 * time and never latch it.
 *
 * `degraded` is shared with a commit failure (a sync apply that exhausted its retries), which is not
 * literally "unreachable" — but it is equally "the local cache is not being kept current", and every
 * caller composes this with an unsettled read that would otherwise spin forever, so the state is honest
 * either way. There is no finer distinction in `SyncRuntimeStatus` to key off.
 *
 * Deliberately NOT `navigator.onLine`, which lies in both directions (ADR-0010), and deliberately not
 * `auth-needed` — a rejected token means the backend answered. The board's Offline toggle pauses only the
 * OUTBOUND convergence driver (reads keep flowing, nothing errors), so flipping it never trips this.
 *
 * `null` means there is no sync provider above the caller (the login screen), which is no evidence of
 * anything — hence `false`.
 */
export function isBackendUnreachable(status: SyncRuntimeStatus | null): boolean {
  return status?.phase === "degraded";
}

/**
 * Whether a sign-in failure was the backend being unreachable rather than a rejected credential. The
 * login screen renders OUTSIDE the sync provider, so there is no runtime status to consult there — the
 * shape of the auth error is the signal.
 *
 * supabase-js wraps a rejected `fetch` (network down, DNS, CORS) as `AuthRetryableFetchError` with
 * `status` 0, and reuses the same class for 5xx/gateway responses with the real status. Only the
 * status-less form is "no connection": a 502 means the backend answered, and a 400
 * `invalid_credentials` is an `AuthApiError`, which this must never claim.
 */
export function isSignInConnectionFailure(error: unknown): boolean {
  if (!isAuthRetryableFetchError(error)) return false;
  return error.status === undefined || error.status === 0;
}

/**
 * The sign-in path's connection-needed failure, thrown by `signInAs` in place of the raw auth error so
 * supabase's error vocabulary is translated in exactly one place. Its message IS the ruled copy, so a
 * caller that only renders `error.message` (the login screen's existing mechanism) already says the right
 * thing; the type lets that screen drop its "is the stack up?" hint, which is advice for a different
 * failure. The original error rides on `cause`.
 */
export class SignInConnectionError extends Error {
  constructor(options?: { cause?: unknown }) {
    super(CONNECTION_NEEDED_SIGN_IN, options);
    this.name = "SignInConnectionError";
  }
}
