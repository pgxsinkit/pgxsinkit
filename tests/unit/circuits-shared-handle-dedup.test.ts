import { expect, test } from "bun:test";

import { text, uuid } from "drizzle-orm/pg-core";

import { startCircuitsSync } from "@pgxsinkit/client";
import { defineReadProjection, defineSyncRegistry, defineSyncTable, type StreamEnvelope } from "@pgxsinkit/contracts";
import {
  barrierPath,
  createBarrierHandler,
  createRefreshHandler,
  createSubscribeHandler,
  importStreamTokenKey,
  refreshPath,
  subscribePath,
  type CircuitsEngineClient,
} from "@pgxsinkit/server";

import { migrateSubscriptionMetadataTables } from "../../packages/client/src/sync/subscription-state";
import { createTablesFromSchema, drizzleOver } from "../../tests/support/drizzle";
import { createFreshTestPGlite } from "../../tests/support/pglite";

const METADATA_SCHEMA = "pgxsinkit";
const GROUP = "two-local-projections";
const ROW = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const owner = defineSyncTable({
  tableName: "projection_source",
  makeColumns: () => ({ id: uuid("id").primaryKey(), title: text("title").notNull() }),
  primaryKey: ["id"],
  mode: "readonly",
});
const firstEntry = defineReadProjection(owner, {
  as: "projection_first",
  columns: ["title"],
  consistencyGroup: GROUP,
});
const secondEntry = defineReadProjection(owner, {
  as: "projection_second",
  columns: ["title"],
  consistencyGroup: GROUP,
});
const registry = defineSyncRegistry({ tables: { first: firstEntry, second: secondEntry } });
const first = firstEntry.localTable;
const second = secondEntry.localTable;

test("two public projections survive engine deduplication onto one shared stream handle", async () => {
  const pg = await createFreshTestPGlite();
  await createTablesFromSchema(pg, { first, second });
  await migrateSubscriptionMetadataTables({ pg, metadataSchema: METADATA_SCHEMA });

  const key = await importStreamTokenKey("shared-handle-repro");
  // Circuits' intended native behavior: byte-identical shape definitions share one ref-counted handle.
  const engine = {
    createShape: async (request) => ({
      shapeId: "shared",
      table: request.table,
      streamPath: "shape/shared",
      streamUrl: "http://ds/shape/shared",
      // Two claims, one shape: the id is echoed so each projection can renew and release its own.
      subscription: request.subscription ?? "~minted",
      leaseSeconds: 1800,
    }),
    releaseShape: async () => {},
    replicationState: async () => ({ lsn: "0/0", pendingFlips: 0, flipFailures: 0 }),
  } as CircuitsEngineClient;
  const claims = () => ({ sub: "person-a" });
  const subscribe = createSubscribeHandler({ registry, engine, key, resolveAuthClaims: claims });
  const refresh = createRefreshHandler({ registry, engine, key, resolveAuthClaims: claims });
  const barrier = createBarrierHandler({ engine, resolveAuthClaims: claims });
  const envelope: StreamEnvelope = {
    type: "projection_source",
    key: ROW,
    value: { id: ROW, title: "one source row" },
    headers: { operation: "upsert" },
  };
  const routedFetch = (async (input: string, init?: RequestInit) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    if (path === subscribePath) return subscribe(request);
    if (path === refreshPath) return refresh(request);
    if (path === barrierPath) return barrier(request);
    return new Response(JSON.stringify([envelope]), {
      headers: {
        "content-type": "application/json",
        "stream-next-offset": "1",
        "stream-up-to-date": "true",
      },
    });
  }) as unknown as typeof fetch;

  const sync = await startCircuitsSync(pg, {
    registry,
    controlPlaneUrl: "http://api",
    streamBaseUrl: "http://edge",
    metadataSchema: METADATA_SCHEMA,
    live: false,
    fetch: routedFetch,
  });
  try {
    await sync.groupReady(GROUP);
    expect(await drizzleOver(pg).select().from(first)).toHaveLength(1);
    expect(await drizzleOver(pg).select().from(second)).toHaveLength(1);
  } finally {
    sync.unsubscribe();
    await pg.close();
  }
});
