import { describe, expect, it } from "bun:test";

import { buildAuthShapeHeaders } from "../../packages/client/src/sync-auth";

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
