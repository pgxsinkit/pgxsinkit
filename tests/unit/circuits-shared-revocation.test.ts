import { expect, test } from "bun:test";

import { eq } from "drizzle-orm";
import { text, uuid } from "drizzle-orm/pg-core";

import { startCircuitsSync } from "@pgxsinkit/client";
import { defineSyncRegistry, defineSyncTable, type StreamEnvelope } from "@pgxsinkit/contracts";
import {
  barrierPath,
  createBarrierHandler,
  createRefreshHandler,
  createSubscribeHandler,
  importStreamTokenKey,
  refreshPath,
  subscribePath,
  type CircuitsEngineClient,
  type EntitlementSet,
} from "@pgxsinkit/server";

import { migrateSubscriptionMetadataTables } from "../../packages/client/src/sync/subscription-state";
import { createTablesFromSchema, drizzleOver } from "../../tests/support/drizzle";
import { createFreshTestPGlite } from "../../tests/support/pglite";

const METADATA_SCHEMA = "pgxsinkit";
const OFFERING = "11111111-1111-4111-8111-111111111111";
const ROW = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const contentEntry = defineSyncTable({
  tableName: "review_content",
  makeColumns: () => ({
    id: uuid("id").primaryKey(),
    offeringId: uuid("offering_id").notNull(),
    body: text("body").notNull(),
  }),
  primaryKey: ["id"],
  mode: "readonly",
  shape: { scope: (c) => [c.offeringId] },
});
const registry = defineSyncRegistry({ tables: { content: contentEntry } });
const content = contentEntry.localTable;

function oneShotRouter(options: {
  engine: CircuitsEngineClient;
  entitlements: EntitlementSet;
  key: CryptoKey;
  envelopes: StreamEnvelope[];
}): typeof fetch {
  const subscribe = createSubscribeHandler({
    registry,
    engine: options.engine,
    entitlements: options.entitlements,
    key: options.key,
    resolveAuthClaims: () => ({ sub: "person-a" }),
  });
  const refresh = createRefreshHandler({
    registry,
    entitlements: options.entitlements,
    key: options.key,
    resolveAuthClaims: () => ({ sub: "person-a" }),
  });
  const barrier = createBarrierHandler({
    engine: options.engine,
    resolveAuthClaims: () => ({ sub: "person-a" }),
  });
  return (async (input: string, init?: RequestInit) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    if (path === subscribePath) return subscribe(request);
    if (path === refreshPath) return refresh(request);
    if (path === barrierPath) return barrier(request);
    return new Response(JSON.stringify(options.envelopes), {
      headers: {
        "content-type": "application/json",
        "stream-next-offset": "1",
        "stream-up-to-date": "true",
      },
    });
  }) as unknown as typeof fetch;
}

test("a shared scope revoked while offline is cleared on the next public sync start", async () => {
  const pg = await createFreshTestPGlite();
  await createTablesFromSchema(pg, { content });
  await migrateSubscriptionMetadataTables({ pg, metadataSchema: METADATA_SCHEMA });
  const key = await importStreamTokenKey("offline-shared-revocation-repro");
  const engine = {
    createShape: async (request) => ({
      shapeId: "s1",
      table: request.table,
      streamPath: "shape/s1",
      streamUrl: "http://ds/shape/s1",
    }),
    releaseShape: async () => {},
    replicationState: async () => ({ lsn: "0/0", pendingFlips: 0, flipFailures: 0 }),
  } as CircuitsEngineClient;
  const granted: EntitlementSet = {
    ready: true,
    permits: (_subject, _shapeKey, scope) => scope[0] === OFFERING,
    scopesFor: () => [[OFFERING]],
  };
  const denied: EntitlementSet = { ready: true, permits: () => false, scopesFor: () => [] };
  const envelope: StreamEnvelope = {
    type: "review_content",
    key: ROW,
    value: { id: ROW, offering_id: OFFERING, body: "must disappear" },
    headers: { operation: "upsert" },
  };

  const first = await startCircuitsSync(pg, {
    registry,
    controlPlaneUrl: "http://api",
    streamBaseUrl: "http://edge",
    metadataSchema: METADATA_SCHEMA,
    live: false,
    fetch: oneShotRouter({ engine, entitlements: granted, key, envelopes: [envelope] }),
  });
  await first.groupReady("review_content");
  first.unsubscribe();
  expect(await drizzleOver(pg).select().from(content)).toHaveLength(1);

  const second = await startCircuitsSync(pg, {
    registry,
    controlPlaneUrl: "http://api",
    streamBaseUrl: "http://edge",
    metadataSchema: METADATA_SCHEMA,
    live: false,
    fetch: oneShotRouter({ engine, entitlements: denied, key, envelopes: [] }),
  });
  try {
    await second.groupReady("review_content");
    expect(await drizzleOver(pg).select().from(content)).toEqual([]);
  } finally {
    second.unsubscribe();
    await pg.close();
  }
});

test("refresh-time shared-scope revocation clears that scope and stops its stream", async () => {
  const pg = await createFreshTestPGlite();
  await createTablesFromSchema(pg, { content });
  await migrateSubscriptionMetadataTables({ pg, metadataSchema: METADATA_SCHEMA });

  const allowed = new Set([OFFERING]);
  const entitlements: EntitlementSet = {
    ready: true,
    permits: (subject, shapeKey, scope) =>
      subject === "person-a" && shapeKey === "review_content" && allowed.has(String(scope[0])),
    scopesFor: (subject, shapeKey) =>
      subject === "person-a" && shapeKey === "review_content" ? [...allowed].map((value) => [value]) : [],
  };
  const key = await importStreamTokenKey("shared-revocation-repro");
  const engine = {
    createShape: async (request) => ({
      shapeId: "s1",
      table: request.table,
      streamPath: "shape/s1",
      streamUrl: "http://ds/shape/s1",
    }),
    releaseShape: async () => {},
    replicationState: async () => ({ lsn: "0/0", pendingFlips: 0, flipFailures: 0 }),
  } as CircuitsEngineClient;
  const shared = { registry, engine, entitlements, key, ttlSeconds: 1 };
  const subscribe = createSubscribeHandler({ ...shared, resolveAuthClaims: () => ({ sub: "person-a" }) });
  const refresh = createRefreshHandler({ ...shared, resolveAuthClaims: () => ({ sub: "person-a" }) });
  const barrier = createBarrierHandler({ engine, resolveAuthClaims: () => ({ sub: "person-a" }) });

  const envelope: StreamEnvelope = {
    type: "review_content",
    key: ROW,
    value: { id: ROW, offering_id: OFFERING, body: "must disappear" },
    headers: { operation: "upsert" },
  };
  let streamReads = 0;
  let resolveRevoked!: () => void;
  const revoked = new Promise<void>((resolve) => {
    resolveRevoked = resolve;
  });
  const routedFetch = (async (input: string, init?: RequestInit) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    if (path === subscribePath) return subscribe(request);
    if (path === refreshPath) return refresh(request);
    if (path === barrierPath) return barrier(request);

    streamReads += 1;
    if (streamReads === 1) {
      allowed.clear();
      return new Response(JSON.stringify([envelope]), {
        headers: {
          "content-type": "application/json",
          "stream-next-offset": "1",
          "stream-up-to-date": "true",
        },
      });
    }
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    });
  }) as unknown as typeof fetch;

  const sync = await startCircuitsSync(pg, {
    registry,
    controlPlaneUrl: "http://api",
    streamBaseUrl: "http://edge",
    metadataSchema: METADATA_SCHEMA,
    fetch: routedFetch,
    onRefused: (entries) => {
      if (entries.some((entry) => entry.scope?.[0] === OFFERING)) resolveRevoked();
    },
  });

  try {
    await revoked;
    const rows = await drizzleOver(pg).select().from(content).where(eq(content.offeringId, OFFERING));
    expect(rows).toEqual([]);
  } finally {
    sync.unsubscribe();
    await pg.close();
  }
});
