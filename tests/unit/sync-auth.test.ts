import { describe, expect, it } from "bun:test";

import { buildAuthShapeHeaders, createShapeAuthErrorHandler } from "../../packages/client/src/sync-auth";

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

describe("read-path identity — auth-error recovery (ADR-0013 Phase 2)", () => {
  it("returns retry ({}) on 401 so Electric re-resolves the header for a fresh token", () => {
    const handler = createShapeAuthErrorHandler();
    expect(handler(fetchError(401))).toEqual({});
  });

  it("returns retry ({}) on 403 too", () => {
    const handler = createShapeAuthErrorHandler();
    expect(handler(fetchError(403))).toEqual({});
  });

  it("NEVER returns void/undefined for an auth error — that would stop the stream permanently", () => {
    const handler = createShapeAuthErrorHandler();
    // Persistent 401 across many retries: every single one must request a retry, never give up.
    for (let i = 0; i < 25; i++) {
      expect(handler(fetchError(401))).not.toBeUndefined();
    }
  });

  it("does not auth-retry a non-auth error — falls through to the engine's default stop", () => {
    const handler = createShapeAuthErrorHandler();
    // 500 reaches onError only after Electric exhausted its own backoff retries; a 404/400 is a
    // genuine non-retryable client error. Neither is an identity problem, so we do not retry-loop.
    expect(handler(fetchError(500))).toBeUndefined();
    expect(handler(fetchError(404))).toBeUndefined();
    expect(handler(new Error("boom"))).toBeUndefined();
  });
});

describe("read-path identity — surfacing a persistent auth failure (ADR-0013 Phase 3)", () => {
  it("notifies onAuthError on every 401/403 while still requesting a retry (retry forever, never stop)", () => {
    let notifications = 0;
    const handler = createShapeAuthErrorHandler({ onAuthError: () => (notifications += 1) });

    // A truly dead token 401s every retry: each one notifies AND requests a retry — there is no
    // attempt cap, so it can keep surfacing "re-login" and resume the instant re-auth succeeds.
    for (let i = 0; i < 10; i++) {
      expect(handler(fetchError(i % 2 === 0 ? 401 : 403))).toEqual({});
    }
    expect(notifications).toBe(10);
  });

  it("does NOT notify onAuthError for a non-auth error", () => {
    let notifications = 0;
    const handler = createShapeAuthErrorHandler({ onAuthError: () => (notifications += 1) });

    void handler(fetchError(500));
    void handler(fetchError(404));
    void handler(new Error("network down"));
    expect(notifications).toBe(0);
  });
});
