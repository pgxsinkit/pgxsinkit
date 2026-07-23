import { describe, expect, it } from "bun:test";

import { buildAuthShapeHeaders, buildShapeHeaders, createShapeErrorHandler } from "../../packages/client/src/sync-auth";

/**
 * A stand-in for Electric's `FetchError` — the handler detects auth failures by the documented
 * numeric `status` field (not `instanceof`), so this faithfully exercises the real path without
 * pulling the client's nested `@electric-sql/client` dep into the root test lane.
 */
function fetchError(status: number): Error {
  return Object.assign(new Error(`HTTP ${status}`), { status });
}

describe("read-path identity — per-request token (ADR-0013 Phase 1)", () => {
  it("exposes Authorization as an async function, not a frozen string", () => {
    const headers = buildAuthShapeHeaders(async () => "tok");
    expect(typeof headers["Authorization"]).toBe("function");
  });

  it("resolves a fresh token on every invocation (per request, never captured once)", async () => {
    // A provider whose token rotates — exactly the case a boot-time freeze breaks.
    let issued = 0;
    const headers = buildAuthShapeHeaders(async () => `token-${++issued}`);
    const authorization = headers["Authorization"];
    if (typeof authorization !== "function") throw new Error("expected an async header function");

    expect(await authorization()).toBe("Bearer token-1");
    expect(await authorization()).toBe("Bearer token-2");
    expect(await authorization()).toBe("Bearer token-3");
    // Three requests → the provider was consulted three times, not frozen at the first value.
    expect(issued).toBe(3);
  });

  it("re-reads an expired-then-refreshed token without rebuilding the header (resumes on re-auth)", async () => {
    // The provider returns undefined while the session is dead, then a real token after re-auth.
    let token: string | undefined;
    const headers = buildAuthShapeHeaders(async () => token);
    const authorization = headers["Authorization"];
    if (typeof authorization !== "function") throw new Error("expected an async header function");

    expect(await authorization()).toBe(""); // no token → unauthenticated, not "Bearer undefined"
    token = "refreshed";
    expect(await authorization()).toBe("Bearer refreshed"); // same function, fresh value
  });
});

describe("read-path static request headers (deployment-gateway credentials)", () => {
  it("merges static requestHeaders alongside the async Authorization", async () => {
    const headers = buildShapeHeaders({
      getAuthToken: async () => "tok",
      requestHeaders: { apikey: "sb_publishable_demo" },
    });
    expect(headers["apikey"]).toBe("sb_publishable_demo");
    const authorization = headers["Authorization"];
    if (typeof authorization !== "function") throw new Error("expected an async header function");
    expect(await authorization()).toBe("Bearer tok");
  });

  it("emits the static headers even with no token provider (credential-only consumer)", () => {
    const headers = buildShapeHeaders({ requestHeaders: { apikey: "sb_publishable_demo" } });
    expect(headers["apikey"]).toBe("sb_publishable_demo");
    expect(headers["Authorization"]).toBeUndefined();
  });

  it("never lets a static header clobber the toolkit-owned Authorization", async () => {
    const headers = buildShapeHeaders({
      getAuthToken: async () => "tok",
      requestHeaders: { Authorization: "Bearer attacker" },
    });
    const authorization = headers["Authorization"];
    if (typeof authorization !== "function") throw new Error("Authorization must remain the toolkit async function");
    expect(await authorization()).toBe("Bearer tok");
  });
});

describe("read-path identity — auth-error recovery (ADR-0013 Phase 2)", () => {
  it("returns retry ({}) on 401 so Electric re-resolves the header for a fresh token", () => {
    const handler = createShapeErrorHandler();
    expect(handler(fetchError(401))).toEqual({});
  });

  it("returns retry ({}) on 403 too", () => {
    const handler = createShapeErrorHandler();
    expect(handler(fetchError(403))).toEqual({});
  });

  it("NEVER returns void/undefined for an auth error — that would stop the stream permanently", () => {
    const handler = createShapeErrorHandler();
    // Persistent 401 across many retries: every single one must request a retry, never give up.
    for (let i = 0; i < 25; i++) {
      expect(handler(fetchError(401))).not.toBeUndefined();
    }
  });

  it("does not invoke the AUTH branch for a non-auth error", () => {
    let authNotifications = 0;
    const handler = createShapeErrorHandler({ onAuthError: () => (authNotifications += 1) });
    void handler(fetchError(500));
    void handler(fetchError(404));
    void handler(new Error("boom"));
    expect(authNotifications).toBe(0);
  });
});

describe("read-path identity — non-auth read-stream error handling (#4)", () => {
  it("retries transient faults (5xx / 429 / network) so a blip does not permanently stop the stream", () => {
    const handler = createShapeErrorHandler();
    expect(handler(fetchError(500))).toEqual({}); // server error
    expect(handler(fetchError(503))).toEqual({});
    expect(handler(fetchError(429))).toEqual({}); // rate limited
    expect(handler(new Error("network down"))).toEqual({}); // no HTTP status → transport fault
  });

  it("stops on a structural non-auth 4xx — retrying re-fails", () => {
    const handler = createShapeErrorHandler();
    expect(handler(fetchError(400))).toBeUndefined();
    expect(handler(fetchError(404))).toBeUndefined();
    expect(handler(fetchError(409))).toBeUndefined();
  });

  it("surfaces EVERY non-auth error via onReadStreamError (so the runtime can go degraded), never auth errors", () => {
    const surfaced: number[] = [];
    let authNotifications = 0;
    const handler = createShapeErrorHandler({
      onAuthError: () => (authNotifications += 1),
      onReadStreamError: (error) => surfaced.push((error as { status?: number }).status ?? -1),
    });

    void handler(fetchError(500)); // transient → surfaced + retried
    void handler(fetchError(404)); // terminal → surfaced + stopped
    void handler(new Error("network")); // network → surfaced (-1) + retried
    void handler(fetchError(401)); // auth → NOT surfaced as a stream error

    expect(surfaced).toEqual([500, 404, -1]);
    expect(authNotifications).toBe(1);
  });
});

describe("read-path identity — surfacing a persistent auth failure (ADR-0013 Phase 3)", () => {
  it("notifies onAuthError on every 401/403 while still requesting a retry (retry forever, never stop)", () => {
    let notifications = 0;
    const handler = createShapeErrorHandler({ onAuthError: () => (notifications += 1) });

    // A truly dead token 401s every retry: each one notifies AND requests a retry — there is no
    // attempt cap, so it can keep surfacing "re-login" and resume the instant re-auth succeeds.
    for (let i = 0; i < 10; i++) {
      expect(handler(fetchError(i % 2 === 0 ? 401 : 403))).toEqual({});
    }
    expect(notifications).toBe(10);
  });

  it("does NOT notify onAuthError for a non-auth error", () => {
    let notifications = 0;
    const handler = createShapeErrorHandler({ onAuthError: () => (notifications += 1) });

    void handler(fetchError(500));
    void handler(fetchError(404));
    void handler(new Error("network down"));
    expect(notifications).toBe(0);
  });
});

describe("read-path identity — the refresh-deduping provider contract (ADR-0013 Phase 4)", () => {
  // A reference single-flight provider, exactly what the docs require the consumer to supply: return
  // the cached valid token, and refresh at most once even under concurrent callers.
  function createRefreshDedupingProvider(refresh: () => Promise<string>): () => Promise<string> {
    let cached: string | null = null;
    let inflight: Promise<string> | null = null;
    return async () => {
      if (cached !== null) return cached;
      inflight ??= refresh().then((token) => {
        cached = token;
        inflight = null;
        return token;
      });
      return inflight;
    };
  }

  it("collapses an N-shape group's concurrent per-request header resolutions into ONE refresh", async () => {
    let refreshes = 0;
    const provider = createRefreshDedupingProvider(async () => {
      refreshes += 1;
      return "fresh-token";
    });
    const headers = buildAuthShapeHeaders(provider);
    const authorization = headers["Authorization"];
    if (typeof authorization !== "function") throw new Error("expected an async header function");

    // Five shapes in one consistency group each resolve the Authorization header concurrently against
    // a momentarily-expired token — the toolkit calls the provider per request, but a deduping
    // provider must refresh single-flight.
    // Electric's header type allows sync OR async values, so wrap each resolution to normalise the
    // `string | Promise<string>` return to a Promise before aggregating.
    const resolved = await Promise.all(Array.from({ length: 5 }, () => Promise.resolve(authorization())));

    expect(resolved).toHaveLength(5);
    expect(resolved.every((value) => value === "Bearer fresh-token")).toBe(true);
    expect(refreshes).toBe(1); // single-flight: one refresh for the whole group, not five
  });
});
