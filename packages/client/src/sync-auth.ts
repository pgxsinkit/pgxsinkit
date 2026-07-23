import type { ExternalHeadersRecord, ShapeStreamOptions } from "@electric-sql/client";

/** The per-shape error handler shape Electric expects (`ShapeStreamOptions.onError`). */
type ShapeStreamErrorHandler = NonNullable<ShapeStreamOptions["onError"]>;

/**
 * Read-path identity (ADR-0013). The two ingress points must share **one** token lifecycle: the
 * write path already calls `getAuthToken` fresh on every flush, so the read path must too — never
 * freezing a JWT at boot, which wedges a long-lived offline-first session the instant the token
 * expires.
 *
 * `buildAuthShapeHeaders` returns the read-path `Authorization` header as an **async function**.
 * Electric resolves header-value functions on every request *and every retry*
 * (`ExternalHeadersRecord` allows `string | (() => string | Promise<string>)`), so each shape fetch
 * presents a fresh token. This is the client mirror of ADR-0003's server-side one-identity decision.
 *
 * The provider contract (documented in `docs/architecture.md`): `getAuthToken` is now called per
 * request by both paths and **must be refresh-deduping** — return the cached valid token and refresh
 * single-flight, so an N-shape consistency group does not trigger N refreshes.
 */
/**
 * Build the read-path shape headers: the optional async `Authorization` (per ADR-0013) **plus** any
 * caller-supplied static `requestHeaders`. The static headers are spread first so the toolkit-owned
 * `Authorization` always wins; they exist for deployment-gateway credentials the toolkit is otherwise
 * agnostic about — e.g. a Supabase `apikey` header the platform function gateway expects. Emitted
 * whenever *either* a token provider or static headers are present, so a credential-only consumer
 * (no per-request token) still sends its headers.
 */
export function buildShapeHeaders(input: {
  getAuthToken?: () => Promise<string | undefined>;
  requestHeaders?: Record<string, string>;
}): ExternalHeadersRecord {
  const headers: ExternalHeadersRecord = { ...(input.requestHeaders ?? {}) };
  const getAuthToken = input.getAuthToken;
  if (getAuthToken) {
    // Resolved per request: a fresh token each time, never one captured at boot. An absent token
    // yields an empty value (unauthenticated) rather than the literal string `Bearer undefined`.
    headers["Authorization"] = async () => {
      const token = await getAuthToken();
      return token ? `Bearer ${token}` : "";
    };
  }
  return headers;
}

/** Token-only convenience over {@link buildShapeHeaders}; retained for callers that pass a provider. */
export function buildAuthShapeHeaders(
  getAuthToken: () => Promise<string | undefined>,
  requestHeaders?: Record<string, string>,
): ExternalHeadersRecord {
  return buildShapeHeaders({ getAuthToken, ...(requestHeaders ? { requestHeaders } : {}) });
}

/** HTTP statuses that mean "the credential is the problem" — re-auth, never give up (ADR-0013). */
const AUTH_ERROR_STATUSES = new Set([401, 403]);

/** Read the duck-typed numeric `status` off an Electric `FetchError`, or `undefined` for a plain error. */
function readErrorStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("status" in error)) {
    return undefined;
  }
  const status = (error as { status: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

/**
 * True when the error is an auth failure (Electric's `FetchError` with a 401/403 `status`). We read
 * the documented `status` field rather than `instanceof FetchError`: the experimental and client
 * packages can resolve to *different* `@electric-sql/client` copies, so an `instanceof` against one
 * copy can miss a `FetchError` thrown from the other. A duck-typed numeric `status` is robust and
 * carries no false positives — a plain network/`Error` has no numeric `status`.
 */
function isAuthError(error: unknown): boolean {
  const status = readErrorStatus(error);
  return status !== undefined && AUTH_ERROR_STATUSES.has(status);
}

/**
 * Whether a non-auth read-stream error is worth retrying (#4): a transient transport fault — a 5xx,
 * a 429 rate-limit, or a network error with no HTTP status. A genuine non-auth 4xx (400/404/409/…)
 * is structural: retrying re-fails, so we stop. (401/403 are handled separately as auth.)
 */
function isRetryableStreamError(error: unknown): boolean {
  const status = readErrorStatus(error);
  if (status === undefined) {
    return true; // network/transport error — retry with Electric's backoff
  }
  return status >= 500 || status === 429;
}

/**
 * The per-shape `ShapeStreamOptions.onError` handler for the read path. It is the only place that can
 * request a retry (the `MultiShapeStream.subscribe` `onError` is notification-only), so it owns BOTH
 * read-path identity (ADR-0013) and read-stream error surfacing (#4):
 *
 * - **auth (401/403)** → `onAuthError` + return `{}` (retry): Electric re-issues the request,
 *   re-resolving the async Authorization header ({@link buildAuthShapeHeaders}) for a *fresh* token.
 *   Never return `void` here — that stops the stream permanently, wrong for offline-first: a dead
 *   session must keep retrying (jittered backoff bounds the cost) so sync resumes the instant re-auth
 *   makes the token valid again. The optional `onAuthError` surfaces a distinct "re-login" status.
 * - **any other error** → `onReadStreamError` (so the runtime can move to a `degraded` status instead
 *   of silently believing the read path is live), then retry transient faults ({@link
 *   isRetryableStreamError}: 5xx/429/network → `{}`) or stop a structural 4xx (return `undefined`). A
 *   later successful fetch (`onSyncActivity`) clears the degraded status back to live.
 */
export function createShapeErrorHandler(
  options: { onAuthError?: () => void; onReadStreamError?: (error: Error) => void } = {},
): ShapeStreamErrorHandler {
  return (error: Error) => {
    if (isAuthError(error)) {
      options.onAuthError?.();
      return {}; // retry → re-resolves the async Authorization header for a fresh token
    }
    options.onReadStreamError?.(error);
    return isRetryableStreamError(error) ? {} : undefined;
  };
}
