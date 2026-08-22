import { describe, expect, it } from "bun:test";

import { boolean, jsonb, uuid, varchar } from "drizzle-orm/pg-core";

import {
  defineReadProjection,
  defineSyncRegistry,
  defineSyncTable,
  type RowTransformContext,
} from "@pgxsinkit/contracts";
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
  scopesFor: (subject, shapeKey) => (subject === "person-a" && shapeKey === "offering_content" ? [["off-1"]] : []),
};

async function tokenFor(grants: Parameters<typeof mintStreamToken>[1]["grants"], sub = "person-a") {
  return mintStreamToken(key, { sub, grants, now: NOW });
}

const sharedGrant = {
  path: "shape/s1",
  shapeId: "s1",
  claim: "claim-s1",
  shapeKey: "offering_content",
  scope: ["off-1", "grp-1"],
};
const privateGrant = { path: "shape/s7", shapeId: "s7", claim: "claim-s7", shapeKey: "notes" };
const transformGrant = { path: "shape/s3", shapeId: "s3", claim: "claim-s3", shapeKey: "secured_item_window" };

// A secure "window" over a keyed table — the worked example the registry docs give. The owner holds the
// item body (a jsonb `payload` with the answer key inside), a kept `metadata` column, and a
// `keysWithheld` control flag; the projection streams body + metadata and redacts per row. The flag is
// SERVER-ONLY: fetched onto the engine's stream so the transform can read it, and never on the client
// wire — which, on the native path, is the edge's job (ADR-0055 decision 5).
const securedItem = defineSyncTable({
  tableName: "secured_item",
  makeColumns: () => ({
    id: uuid("id").primaryKey(),
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    metadata: varchar("metadata", { length: 200 }),
    keysWithheld: boolean("keys_withheld").notNull().default(false),
  }),
  primaryKey: ["id"],
  mode: "readonly",
});

const transformContexts: RowTransformContext[] = [];

const securedItemWindow = defineReadProjection(securedItem, {
  as: "secured_item_window",
  columns: ["payload", "metadata"],
  serverProjection: {
    rowTransform: (row, context) => {
      transformContexts.push(context);
      const payload = { ...(row["payload"] as Record<string, unknown>) };
      if (row["keys_withheld"] === true) delete payload["correctResponse"];
      // `noteFromTransform` is deliberate: a transform may return keys the client's local table never
      // declared, and the edge must drop them rather than widen the shape the client's schema was
      // generated for.
      return { ...row, payload, noteFromTransform: "should never reach the client" };
    },
  },
  serverOnlyColumns: ["keysWithheld"],
});

const note = defineSyncTable({
  tableName: "notes",
  makeColumns: () => ({ id: uuid("id").primaryKey() }),
  primaryKey: ["id"],
  mode: "readonly",
});

const registry = defineSyncRegistry({ notes: note, secured_item_window: securedItemWindow });

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
    const token = await tokenFor([
      { path: "shape/s9", shapeId: "s9", claim: "claim-s9", shapeKey: "offering_content", scope: ["off-2", null] },
    ]);
    expect(await authorizeStreamRead(options, token, "shape/s9", NOW)).toEqual({
      allow: false,
      reason: "not entitled to this scope",
    });
  });

  // The whole point of decision 7's fail-closed clause: a set that cannot be trusted is never a permit.
  it("denies while the entitlement set is unavailable", async () => {
    const token = await tokenFor([sharedGrant]);
    const degraded = { ...options, entitlements: { ready: false, permits: () => true, scopesFor: () => [] } };
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
    registry,
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

// The one exception to "the edge is a gate, not a pipeline" (ADR-0055 decision 5, amended): a shape
// declaring `serverProjection.rowTransform` is rewritten HERE, per request, with the subject the stream
// token names. What is pinned is the whole bargain — the rewrite happens, the server-only inputs and any
// invented keys come off, the answer is unshareable, the ds steering headers survive — and, just as
// importantly, that a shape declaring NO transform pays none of it.
describe("egress transform", () => {
  const upstreamJson = (value: Record<string, unknown>) =>
    new Response(
      JSON.stringify([{ type: "secured_item_window", key: "item-1", value, headers: { operation: "upsert" } }]),
      {
        headers: {
          "content-type": "application/json",
          "stream-next-offset": "0000000000000000_0000000000000009",
          "stream-up-to-date": "",
          etag: '"3785364913788960:0:16"',
          "cache-control": "public, max-age=60, stale-while-revalidate=300",
        },
      },
    );

  const readTransformShape = async (
    request: Request,
    respond: () => Response,
  ): Promise<{ response: Response; fetches: number }> => {
    let fetches = 0;
    const gate = createStreamGate({
      key,
      registry,
      durableStreamsUrl: "http://ds:8080/v1/stream",
      fetch: (async () => {
        fetches += 1;
        return respond();
      }) as unknown as typeof fetch,
    });
    return { response: await gate(request, transformGrant.path, NOW), fetches };
  };

  const transformRequest = async (init?: RequestInit) => {
    const token = await tokenFor([transformGrant]);
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${token}`);
    return new Request(`http://edge/stream/${transformGrant.path}?offset=-1&live=true`, { ...init, headers });
  };

  it("rewrites each row, drops the server-only input and any key the transform invented", async () => {
    transformContexts.length = 0;
    const { response } = await readTransformShape(await transformRequest(), () =>
      upstreamJson({
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        payload: { body: "the question", correctResponse: "42" },
        metadata: "unit-1",
        keys_withheld: true,
      }),
    );

    expect(response.status).toBe(200);
    const [envelope] = (await response.json()) as { value: Record<string, unknown> }[];
    const value = envelope!.value;

    // The rewrite ran: the answer key is gone from the jsonb sub-document…
    expect(value["payload"]).toEqual({ body: "the question" });
    // …the control flag the transform READ never reaches the client…
    expect("keys_withheld" in value).toBe(false);
    // …nor does a key the transform added, which the client's local table does not declare…
    expect("noteFromTransform" in value).toBe(false);
    // …and the client keep-set survives intact.
    expect(value["metadata"]).toBe("unit-1");
    expect(value["id"]).toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");

    // The bytes are a function of the subject, so nothing may share or store them, and an upstream
    // validator describing the un-rewritten body must not survive to be revalidated against.
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("etag")).toBeNull();

    // The client's read loop steers entirely off these; a rewrite that lost them would present as a hot
    // loop rather than as a redaction bug.
    expect(response.headers.get("stream-next-offset")).toBe("0000000000000000_0000000000000009");
    expect(response.headers.has("stream-up-to-date")).toBe(true);
    expect(response.headers.get("content-type")).toContain("application/json");

    // The claims a transform sees at the edge are the token's subject and nothing else — the token
    // carries `sub`, not the JWT it was minted from.
    expect(transformContexts).toEqual([{ claims: { sub: "person-a" } }]);
  });

  it("hands back the upstream response object itself for a shape declaring no transform", async () => {
    const upstream = new Response("[]", {
      status: 200,
      headers: { "content-type": "application/json", "cache-control": "public, max-age=60", etag: '"note-1"' },
    });
    const gate = createStreamGate({
      key,
      registry,
      durableStreamsUrl: "http://ds:8080/v1/stream",
      fetch: (async () => upstream) as unknown as typeof fetch,
    });
    const token = await tokenFor([privateGrant]);

    const response = await gate(
      new Request(`http://edge/stream/${privateGrant.path}?offset=-1&live=true`, {
        headers: { authorization: `Bearer ${token}` },
      }),
      privateGrant.path,
      NOW,
    );

    // Object identity, not equivalence: an ordinary shape must not pay for the transform stage existing,
    // and it keeps whatever caching durable-streams answered with.
    expect(response).toBe(upstream);
    expect(response.headers.get("cache-control")).toBe("public, max-age=60");
    expect(response.headers.get("etag")).toBe('"note-1"');
  });

  // The rewrite needs a whole JSON body per response. SSE delivers a frame stream instead, so the mode is
  // declined for these shapes rather than half-supported — and declined BEFORE the upstream read, so a
  // refused request never reaches durable-streams.
  it("refuses SSE for a transform shape, by query parameter or by Accept", async () => {
    const token = await tokenFor([transformGrant]);
    const gate = createStreamGate({
      key,
      registry,
      durableStreamsUrl: "http://ds:8080/v1/stream",
      fetch: (async () => {
        throw new Error("upstream must not be reached for a refused SSE read");
      }) as unknown as typeof fetch,
    });

    for (const request of [
      new Request(`http://edge/stream/${transformGrant.path}?offset=-1&live=sse`, {
        headers: { authorization: `Bearer ${token}` },
      }),
      new Request(`http://edge/stream/${transformGrant.path}?offset=-1&live=true`, {
        headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" },
      }),
    ]) {
      const response = await gate(request, transformGrant.path, NOW);
      expect(response.status).toBe(406);
      expect(await response.json()).toEqual({
        error: "this shape is rewritten at egress and is served as JSON long-poll only",
      });
    }
  });

  // A HEAD answers `200 application/json` with NO body, so it takes the same pass-through branch as a
  // 204: parsing it would throw on a request that only ever asked for the headers.
  it("answers a HEAD with the rebuilt headers and no body", async () => {
    const { response, fetches } = await readTransformShape(
      await transformRequest({ method: "HEAD" }),
      () =>
        new Response(null, {
          status: 200,
          headers: {
            "content-type": "application/json",
            "stream-next-offset": "0000000000000000_0000000000000009",
            etag: '"stale"',
            "cache-control": "public, max-age=60",
          },
        }),
    );

    expect(fetches).toBe(1);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    expect(response.headers.get("stream-next-offset")).toBe("0000000000000000_0000000000000009");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("etag")).toBeNull();
  });

  it("passes a 204 long-poll timeout through with the no-store posture", async () => {
    const { response, fetches } = await readTransformShape(
      await transformRequest(),
      () => new Response(null, { status: 204, headers: { etag: '"stale"', "cache-control": "public, max-age=60" } }),
    );

    expect(fetches).toBe(1);
    expect(response.status).toBe(204);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("etag")).toBeNull();
  });
});
