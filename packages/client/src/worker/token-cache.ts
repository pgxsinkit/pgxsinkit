// The worker's single auth token cache + pull mechanism (ADR-0032 decision 3). The worker holds exactly
// ONE token and NEVER refreshes it — the tab layer is the sole auth owner (exactly one refresher exists, so
// GoTrue refresh-token reuse detection can never trip). A read/write that finds the cache within the expiry
// margin triggers ONE pull broadcast; concurrent needs dedupe onto that single in-flight pull; the first
// tab answer wins. Factored out of `defineSyncWorker` so this mechanism is unit-tested in isolation.

import type { AuthTokenSnapshot } from "./protocol";

export interface WorkerTokenCache {
  /**
   * Resolve the access token for a shape/flush request. Returns the cached token when it is comfortably
   * ahead of expiry; otherwise broadcasts ONE pull (deduped across concurrent callers) and resolves when a
   * tab answers. Falls back to the (stale) cached token if a pull yields nothing.
   */
  getToken: () => Promise<string | undefined>;
  /** The tab pushed a fresh token (auth state change or the initial attach) — cache it and satisfy any pull. */
  push: (token: AuthTokenSnapshot | null) => void;
  /**
   * Seed the cache from a LATER attach's token, but only if it is strictly fresher than what is cached
   * (ADR-0032 FIX 5). Attach seeding must never CLOBBER a fresher cached token with an older/null one —
   * only the explicit `push` path (the tab as auth owner saying "this is current") may overwrite
   * unconditionally, including null on logout.
   */
  pushIfFresher: (token: AuthTokenSnapshot | null) => void;
  /** A tab answered a pull-request. First matching answer wins; later duplicates are ignored. */
  respond: (requestId: string, token: AuthTokenSnapshot | null) => void;
}

export function createWorkerTokenCache(options: {
  marginMs: number;
  broadcastRequest: (requestId: string) => void;
  now?: () => number;
}): WorkerTokenCache {
  const now = options.now ?? (() => Date.now());
  let cached: AuthTokenSnapshot | null = null;
  let inFlight: Promise<AuthTokenSnapshot | null> | null = null;
  let resolveInFlight: ((token: AuthTokenSnapshot | null) => void) | null = null;
  let currentRequestId: string | null = null;
  let requestCounter = 0;

  const settle = (token: AuthTokenSnapshot | null) => {
    if (token) cached = token;
    const resolve = resolveInFlight;
    inFlight = null;
    resolveInFlight = null;
    currentRequestId = null;
    resolve?.(token);
  };

  return {
    getToken: async () => {
      if (cached && cached.expiresAt - now() > options.marginMs) {
        return cached.accessToken;
      }
      if (!inFlight) {
        currentRequestId = `pull-${++requestCounter}`;
        inFlight = new Promise<AuthTokenSnapshot | null>((resolve) => {
          resolveInFlight = resolve;
        });
        // Exactly one broadcast per pull; concurrent getToken calls below await the same `inFlight`.
        options.broadcastRequest(currentRequestId);
      }
      const answered = await inFlight;
      return answered?.accessToken ?? cached?.accessToken;
    },
    push: (token) => {
      cached = token;
      // A push satisfies an outstanding pull too (the tab volunteered before answering the request).
      if (inFlight) settle(token);
    },
    pushIfFresher: (token) => {
      if (!token) return;
      if (cached && cached.expiresAt >= token.expiresAt) return;
      // Strictly fresher than the cache (or the cache is empty) → adopt it via `push`, which also settles
      // any in-flight pull.
      cached = token;
      if (inFlight) settle(token);
    },
    respond: (requestId, token) => {
      // First response for the CURRENT pull wins; a stale/duplicate requestId (or no pull) is ignored.
      if (inFlight && requestId === currentRequestId) settle(token);
    },
  };
}
