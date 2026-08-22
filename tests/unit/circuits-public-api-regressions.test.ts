import { expect, test } from "bun:test";

import { text, uuid } from "drizzle-orm/pg-core";

import { openSubscriptionSession } from "@pgxsinkit/client";
import { DENY_ALL_PREDICATE, defineSyncRegistry, defineSyncTable, p, type StreamEnvelope } from "@pgxsinkit/contracts";
import {
  createReleaseHandler,
  createStreamGate,
  createSubscribeHandler,
  importStreamTokenKey,
  releasePath,
  subscribePath,
  type CircuitsEngineClient,
} from "@pgxsinkit/server";

/**
 * A stub engine that counts its lifecycle calls, and can tell a test when a release has LANDED.
 *
 * `onRelease` exists because the release is fire-and-forget by design — `close()` returns before the
 * request has left — so a test asserting on it has to be woken by the engine rather than by guessing
 * how many microtasks the round trip costs.
 */
function engineWithCounters(onRelease?: (shapeId: string) => void) {
  let created = 0;
  let released = 0;
  const engine = {
    createShape: async (request) => {
      created += 1;
      return {
        shapeId: `s${created}`,
        table: request.table,
        streamPath: `shape/s${created}`,
        streamUrl: `http://ds/shape/s${created}`,
      };
    },
    releaseShape: async (shapeId: string) => {
      released += 1;
      onRelease?.(shapeId);
    },
    replicationState: async () => ({ lsn: "0/0", pendingFlips: 0, flipFailures: 0 }),
  } as CircuitsEngineClient;
  return { engine, created: () => created, released: () => released };
}

test("serverProjection.rowTransform rewrites native stream egress", async () => {
  const key = await importStreamTokenKey("row-transform-repro");
  const document = defineSyncTable({
    tableName: "documents",
    makeColumns: () => ({
      id: uuid("id").primaryKey(),
      ownerId: uuid("owner_id").notNull(),
      secret: text("secret").notNull(),
    }),
    primaryKey: ["id"],
    mode: "readonly",
    shape: {
      rowFilter: (c) => ({
        customPredicate: (claims) =>
          typeof claims.sub === "string" ? p.eq(c.ownerId, claims.sub) : DENY_ALL_PREDICATE,
      }),
    },
    serverProjection: { rowTransform: (row) => ({ ...row, secret: "[redacted]" }) },
  });
  const registry = defineSyncRegistry({ tables: { document } });
  const { engine } = engineWithCounters();
  const subscribe = createSubscribeHandler({
    registry,
    engine,
    key,
    resolveAuthClaims: () => ({ sub: "11111111-1111-4111-8111-111111111111" }),
  });
  const subscribed = await subscribe(
    new Request(`http://api${subscribePath}`, {
      method: "POST",
      body: JSON.stringify({ subscriptions: [{ shapeKey: "documents" }] }),
    }),
  );
  const result = (await subscribed.json()) as { token: string; granted: { streamPath: string }[] };

  const raw: StreamEnvelope = {
    type: "documents",
    key: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    value: {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      owner_id: "11111111-1111-4111-8111-111111111111",
      secret: "raw-secret",
    },
    headers: { operation: "upsert" },
  };
  const gate = createStreamGate({
    key,
    registry,
    durableStreamsUrl: "http://ds",
    fetch: (async () =>
      new Response(JSON.stringify([raw]), {
        headers: { "content-type": "application/json", "stream-next-offset": "1" },
      })) as unknown as typeof fetch,
  });
  const path = result.granted[0]!.streamPath;
  const response = await gate(
    new Request(`http://edge/${path}`, { headers: { authorization: `Bearer ${result.token}` } }),
    path,
    Math.floor(Date.now() / 1000),
  );
  const envelopes = (await response.json()) as StreamEnvelope[];

  expect(envelopes[0]?.value?.["secret"]).toBe("[redacted]");
});

test("defineSyncRegistry refuses duplicate public shapeKey values", () => {
  const first = defineSyncTable({
    tableName: "first_table",
    makeColumns: () => ({ id: uuid("id").primaryKey() }),
    primaryKey: ["id"],
    mode: "readonly",
    shape: { shapeKey: "duplicate-shape" },
  });
  const second = defineSyncTable({
    tableName: "second_table",
    makeColumns: () => ({ id: uuid("id").primaryKey() }),
    primaryKey: ["id"],
    mode: "readonly",
    shape: { shapeKey: "duplicate-shape" },
  });

  let thrown: unknown;
  try {
    defineSyncRegistry({ tables: { first, second } });
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(Error);
  expect(String(thrown)).toMatch(/shapeKey.*duplicate|duplicate.*shapeKey/i);
});

test("closing a public subscription session releases its engine shape claim", async () => {
  const key = await importStreamTokenKey("shape-release-repro");
  const note = defineSyncTable({
    tableName: "notes",
    makeColumns: () => ({ id: uuid("id").primaryKey() }),
    primaryKey: ["id"],
    mode: "readonly",
  });
  const registry = defineSyncRegistry({ tables: { note } });
  // The release is fired without being awaited, so the engine stub is what signals completion.
  let releaseLanded!: () => void;
  const released = new Promise<void>((resolve) => {
    releaseLanded = resolve;
  });
  const counters = engineWithCounters(() => releaseLanded());
  const subscribe = createSubscribeHandler({
    registry,
    engine: counters.engine,
    key,
    resolveAuthClaims: () => ({ sub: "user-1" }),
  });
  const release = createReleaseHandler({
    engine: counters.engine,
    key,
    resolveAuthClaims: () => ({ sub: "user-1" }),
  });
  const routedFetch = (async (input: string, init?: RequestInit) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    if (path === subscribePath) return subscribe(request);
    if (path === releasePath) return release(request);
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  const session = await openSubscriptionSession(
    { controlPlaneUrl: "http://api", streamBaseUrl: "http://edge", fetch: routedFetch },
    [{ shapeKey: "notes" }],
  );
  expect(counters.created()).toBe(1);

  session.close();
  await released;

  expect(counters.released()).toBe(1);
});

test("token() never resolves null when an automatic refresh revokes every grant", async () => {
  let calls = 0;
  const routedFetch = (async () => {
    calls += 1;
    if (calls === 1) {
      return Response.json({
        token: "initial-token",
        expiresAt: 0,
        granted: [{ shapeKey: "notes", shapeId: "s1", streamPath: "shape/s1" }],
        denied: [],
      });
    }
    return Response.json({ granted: [], revoked: [{ shapeKey: "notes", reason: "revoked" }] });
  }) as unknown as typeof fetch;
  const session = await openSubscriptionSession(
    { controlPlaneUrl: "http://api", streamBaseUrl: "http://edge", fetch: routedFetch },
    [{ shapeKey: "notes" }],
  );

  // Restructured rather than `.rejects`: `expect(...).rejects` is typed as returning void, so awaiting
  // it is an await-thenable lint error. The behaviour asserted is identical.
  let thrown: unknown;
  try {
    await session.token();
  } catch (error) {
    thrown = error;
  }
  expect(String(thrown)).toMatch(/no stream token/);
});
