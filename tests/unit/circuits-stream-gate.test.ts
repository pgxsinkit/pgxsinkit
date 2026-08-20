import { describe, expect, it } from "bun:test";

import {
  authorizeStreamRead,
  createStreamGate,
  importStreamTokenKey,
  mintStreamToken,
  readStreamToken,
  verifyStreamToken,
  type EntitlementSet,
} from "@pgxsinkit/server";

// The edge gate (ADR-0055 decisions 6-8): verify the capability, check live entitlement for the
// shared tier, proxy. Pinned here are the properties that make the shared tier safe to cache — the
// token never reaches the cache key or the upstream, and an unavailable entitlement set denies.

const NOW = 1_700_000_000;
const key = await importStreamTokenKey("test-signing-secret");

const entitled: EntitlementSet = {
  ready: true,
  permits: (subject, shapeKey, scope) =>
    subject === "person-a" && shapeKey === "offering_content" && scope[0] === "off-1",
};

async function tokenFor(grants: Parameters<typeof mintStreamToken>[1]["grants"], sub = "person-a") {
  return mintStreamToken(key, { sub, grants, now: NOW });
}

const sharedGrant = { path: "shape/s1", shapeKey: "offering_content", scope: ["off-1", "grp-1"] };
const privateGrant = { path: "shape/s7", shapeKey: "notes" };

describe("stream token", () => {
  it("round-trips grants and rejects a tampered payload", async () => {
    const token = await tokenFor([sharedGrant]);
    const verified = await verifyStreamToken(key, token, NOW + 1);
    expect(verified.ok && verified.claims.grants).toEqual([sharedGrant]);

    const [header, , signature] = token.split(".");
    const forged = btoa(JSON.stringify({ sub: "person-b", grants: [sharedGrant], iat: NOW, exp: NOW + 300 }))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", "");
    const tampered = await verifyStreamToken(key, `${header}.${forged}.${signature}`, NOW + 1);
    expect(tampered).toEqual({ ok: false, reason: "bad signature" });
  });

  // Validity is judged at request start, so a long-poll held across the boundary is not killed
  // mid-flight — that presents as a stall rather than as the re-auth it actually is.
  it("expires on its ttl", async () => {
    const token = await tokenFor([sharedGrant]);
    expect((await verifyStreamToken(key, token, NOW + 299)).ok).toBe(true);
    expect(await verifyStreamToken(key, token, NOW + 300)).toEqual({ ok: false, reason: "expired" });
  });
});

describe("gate", () => {
  const options = { key, entitlements: entitled, durableStreamsUrl: "http://ds:8080/v1/stream" };

  it("allows an entitled shared read and a private read on its own token", async () => {
    const token = await tokenFor([sharedGrant, privateGrant]);
    expect((await authorizeStreamRead(options, token, "shape/s1", NOW)).allow).toBe(true);
    expect((await authorizeStreamRead(options, token, "shape/s7", NOW)).allow).toBe(true);
  });

  // Paths are a monotonic counter, so they are enumerable; only an exact grant admits one.
  it("refuses a path the token does not name", async () => {
    const token = await tokenFor([sharedGrant]);
    expect(await authorizeStreamRead(options, token, "shape/s2", NOW)).toEqual({
      allow: false,
      reason: "token grants no such stream",
    });
  });

  it("refuses a scope the subject is not entitled to, even with a valid token", async () => {
    const token = await tokenFor([{ path: "shape/s9", shapeKey: "offering_content", scope: ["off-2", null] }]);
    expect(await authorizeStreamRead(options, token, "shape/s9", NOW)).toEqual({
      allow: false,
      reason: "not entitled to this scope",
    });
  });

  // The whole point of decision 7's fail-closed clause: a set that cannot be trusted is never a permit.
  it("denies while the entitlement set is unavailable", async () => {
    const token = await tokenFor([sharedGrant]);
    const degraded = { ...options, entitlements: { ready: false, permits: () => true } };
    expect(await authorizeStreamRead(degraded, token, "shape/s1", NOW)).toEqual({
      allow: false,
      reason: "entitlements unavailable",
    });
  });
});

it("proxies with the ds query string intact and the token stripped", async () => {
  let seen: { url: string; auth: string | null } | undefined;
  const gate = createStreamGate({
    key,
    entitlements: entitled,
    durableStreamsUrl: "http://ds:8080/v1/stream/",
    fetch: (async (url: URL, init: RequestInit) => {
      seen = { url: String(url), auth: new Headers(init.headers).get("authorization") };
      return new Response("[]", { status: 200 });
    }) as unknown as typeof fetch,
  });

  const token = await tokenFor([sharedGrant]);
  const response = await gate(
    new Request("http://edge/stream/shape/s1?offset=-1&live=true", {
      headers: { authorization: `Bearer ${token}` },
    }),
    "shape/s1",
    NOW,
  );

  expect(response.status).toBe(200);
  expect(seen?.url).toBe("http://ds:8080/v1/stream/shape/s1?offset=-1&live=true");
  expect(seen?.auth).toBeNull();
});

it("reads the token from Authorization only — a query parameter would be a distinct cache key", () => {
  expect(readStreamToken(new Request("http://edge/s?token=abc"))).toBeNull();
  expect(readStreamToken(new Request("http://edge/s", { headers: { authorization: "Bearer abc" } }))).toBe("abc");
});
