import { expect, test } from "bun:test";

import { text, uuid } from "drizzle-orm/pg-core";

import { DENY_ALL_PREDICATE, defineSyncRegistry, defineSyncTable } from "@pgxsinkit/contracts";
import {
  authorizeStreamRead,
  importStreamTokenKey,
  refreshStreamToken,
  subscribeToShapes,
  type CircuitsEngineClient,
} from "@pgxsinkit/server";

const NOW = 1_700_000_000;
const key = await importStreamTokenKey("spec-review-private-refresh");

const secret = defineSyncTable({
  tableName: "secrets",
  makeColumns: () => ({ id: uuid("id").primaryKey(), value: text("value").notNull() }),
  primaryKey: ["id"],
  mode: "readonly",
  shape: {
    rowFilter: () => ({
      customPredicate: (claims) => (claims.app_metadata?.roles?.includes("admin") ? null : DENY_ALL_PREDICATE),
    }),
  },
});
const registry = defineSyncRegistry({ tables: { secret } });

const engine = {
  createShape: async (request) => ({
    shapeId: "s1",
    table: request.table,
    streamPath: "shape/s1",
    streamUrl: "http://ds/shape/s1",
    subscription: request.subscription ?? "~minted",
    leaseSeconds: 1800,
  }),
  releaseShape: async () => {},
  replicationState: async () => ({ lsn: "0/0", pendingFlips: 0, flipFailures: 0 }),
} as CircuitsEngineClient;

test("a private grant is revoked when refreshed claims no longer satisfy its row filter", async () => {
  const initial = await subscribeToShapes(
    { registry, engine, key },
    { sub: "user-1", app_metadata: { roles: ["admin"] } },
    [{ shapeKey: "secrets" }],
    NOW,
  );
  expect(initial.granted).toHaveLength(1);

  const refreshed = await refreshStreamToken(
    { registry, engine, key },
    { sub: "user-1", app_metadata: { roles: [] } },
    initial.token!,
    NOW + 1,
  );

  expect(refreshed.granted).toEqual([]);
  expect(refreshed.revoked).toHaveLength(1);
  expect(
    await authorizeStreamRead({ key, durableStreamsUrl: "http://ds" }, refreshed.token ?? null, "shape/s1", NOW + 1),
  ).toMatchObject({ allow: false });
});
