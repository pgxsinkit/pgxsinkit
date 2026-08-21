import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";

import { count, eq } from "drizzle-orm";
import { jsonb, pgSchema, text } from "drizzle-orm/pg-core";

import { authorsTable, demoSyncRegistry, todosTable } from "@pgxsinkit/schema";
import { createSyncServer } from "@pgxsinkit/server";
import {
  createServerDb,
  readIntegrationEnv,
  startNativeSyncStack,
  waitFor,
  type NativeSyncStack,
} from "@pgxsinkit/test-utils";

import { startCircuitsSync } from "../../packages/client/src/circuits/group-sync";
import { generateLocalSchemaSql } from "../../packages/client/src/schema";
import { DEFAULT_METADATA_SCHEMA } from "../../packages/client/src/sync/metadata-tables";
import { installPlpgsqlBatchFunction } from "../../packages/server/src/mutations/plpgsql-apply";
import { createCircuitsTestPGlite } from "../support/circuits-pglite";
import { drizzleOver } from "../support/drizzle";

const env = readIntegrationEnv();
const localSchemaSql = generateLocalSchemaSql(demoSyncRegistry);

// Test-local Drizzle object over the client engine's subscription-state relation, mirroring the DDL
// in packages/client/src/sync/subscription-state.ts (`migrateSubscriptionMetadataTables`) — an
// introspection surface only; the engine's own SQL remains the authority for the physical shape.
const subscriptionsMetadataTable = pgSchema("pgxsinkit").table("subscriptions_metadata", {
  key: text("key").primaryKey(),
  shapeMetadata: jsonb("shape_metadata").$type<Record<string, unknown>>().notNull(),
  lastLsn: text("last_lsn").notNull(),
});

async function createLocalTodoStore() {
  const pg = await createCircuitsTestPGlite();

  await pg.exec(localSchemaSql);

  return pg;
}

async function startTestSync(
  localPg: Awaited<ReturnType<typeof createLocalTodoStore>>,
  urls: Pick<NativeSyncStack<unknown>, "controlPlaneUrl" | "streamBaseUrl">,
  registry: typeof demoSyncRegistry = demoSyncRegistry,
) {
  let markInitialSyncDone: (() => void) | null = null;
  const initialSyncDone = new Promise<void>((resolve) => {
    markInitialSyncDone = resolve;
  });

  const sync = await startCircuitsSync(localPg, {
    registry,
    controlPlaneUrl: urls.controlPlaneUrl,
    streamBaseUrl: urls.streamBaseUrl,
    metadataSchema: DEFAULT_METADATA_SCHEMA,
    onInitialSync: () => {
      markInitialSyncDone?.();
      markInitialSyncDone = null;
    },
  });

  return {
    sync,
    initialSyncDone,
  };
}

// Bind both demo tables into one consistency group (ADR-0009 decision 2) so they sync as one group and
// commit atomically — the cross-shape path the standalone-per-table wiring never exercised. The group
// is declared on the REGISTRY, which is where `startCircuitsSync` reads it from.
const groupedDemoRegistry = {
  ...demoSyncRegistry,
  authors: { ...demoSyncRegistry.authors, consistencyGroup: "demo" },
  todos: { ...demoSyncRegistry.todos, consistencyGroup: "demo" },
};

describe("circuits -> pglite sync integration", () => {
  let stack!: NativeSyncStack<ReturnType<typeof createSyncServer<typeof demoSyncRegistry>>>;
  let server!: ReturnType<typeof createSyncServer<typeof demoSyncRegistry>>;
  const serverDb = createServerDb(demoSyncRegistry, env.databaseUrl);

  beforeAll(async () => {
    const provisioningServer = createSyncServer({
      registry: demoSyncRegistry,
      db: serverDb.db,
    });

    try {
      await installPlpgsqlBatchFunction(provisioningServer.drizzle, demoSyncRegistry);
    } finally {
      await provisioningServer.stop();
    }

    stack = await startNativeSyncStack({
      env,
      createServer: (readPath) =>
        createSyncServer({
          registry: demoSyncRegistry,
          db: serverDb.db,
          resolveAuthClaims: () => ({
            role: "authenticated",
            sub: "179e4f33-69ec-4f39-ba26-8f10c8ac8c9d",
          }),
          readPath,
        }),
    });
    server = stack.server;
  });

  beforeEach(async () => {
    await server.drizzle.delete(todosTable);
    await server.drizzle.delete(authorsTable);
  });

  afterAll(async () => {
    await stack.stop();
    await serverDb.close();
  });

  it("syncs seeded postgres rows into pglite", async () => {
    await server.request("/api/mutations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        mutations: [
          {
            tableName: "authors",
            entityKey: { id: "01963227-d4c7-72db-b858-f89f6af8f920" },
            mutationId: "ea44f5ea-6908-4328-94bf-e95fca8f3ca0",
            mutationSeq: 1,
            kind: "create",
            payload: {
              id: "01963227-d4c7-72db-b858-f89f6af8f920",
              name: "Ada Lovelace",
            },
            clientTimestampUs: String(Date.now() * 1000),
          },
          {
            tableName: "todos",
            entityKey: { id: "01963227-d4c7-72db-b858-f89f6af8f991" },
            mutationId: "14be349f-bf96-430c-9d87-513d671b9f47",
            mutationSeq: 2,
            kind: "create",
            payload: {
              id: "01963227-d4c7-72db-b858-f89f6af8f991",
              title: "Seed row one",
              description: null,
              author_id: "01963227-d4c7-72db-b858-f89f6af8f920",
              status: "todo",
              priority: "medium",
            },
            clientTimestampUs: String(Date.now() * 1000),
          },
        ],
      }),
    });

    const localPg = await createLocalTodoStore();
    const { sync, initialSyncDone } = await startTestSync(localPg, stack);

    try {
      await initialSyncDone;

      const localDb = drizzleOver(localPg);
      await waitFor(async () => {
        const authorResult = await localDb.select({ count: count() }).from(authorsTable);
        const result = await localDb.select({ count: count() }).from(todosTable);
        expect(authorResult[0]?.count).toBe(1);
        expect(result[0]?.count).toBe(1);
      });
    } finally {
      sync.unsubscribe();
      await localPg.close();
    }
  }, 30_000);

  it("delivers new API writes to an active pglite subscriber", async () => {
    const localPg = await createLocalTodoStore();
    const { sync, initialSyncDone } = await startTestSync(localPg, stack);

    try {
      await initialSyncDone;

      await server.request("/api/mutations", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          mutations: [
            {
              tableName: "authors",
              entityKey: { id: "01963227-d4c7-72db-b858-f89f6af8f921" },
              mutationId: "95be871f-ee6d-45cd-89a6-f1f15fa1d8dd",
              mutationSeq: 1,
              kind: "create",
              payload: {
                id: "01963227-d4c7-72db-b858-f89f6af8f921",
                name: "Grace Hopper",
              },
              clientTimestampUs: String(Date.now() * 1000),
            },
          ],
        }),
      });

      const response = await server.request("/api/mutations", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          mutations: [
            {
              tableName: "todos",
              entityKey: { id: "01963227-d4c7-72db-b858-f89f6af8f992" },
              mutationId: "4cb07d29-d072-44b3-b84e-8ee7f024ca1a",
              mutationSeq: 1,
              kind: "create",
              payload: {
                id: "01963227-d4c7-72db-b858-f89f6af8f992",
                title: "Visible after API write",
                description: "Electric should stream this down",
                author_id: "01963227-d4c7-72db-b858-f89f6af8f921",
                status: "in_progress",
                priority: "high",
              },
              clientTimestampUs: String(Date.now() * 1000),
            },
          ],
        }),
      });

      expect(response.status).toBe(200);

      const localDb = drizzleOver(localPg);
      await waitFor(async () => {
        const authorResult = await localDb
          .select({ name: authorsTable.name })
          .from(authorsTable)
          .where(eq(authorsTable.id, "01963227-d4c7-72db-b858-f89f6af8f921"));
        const result = await localDb
          .select({ title: todosTable.title, authorId: todosTable.authorId })
          .from(todosTable)
          .where(eq(todosTable.title, "Visible after API write"));
        expect(authorResult[0]?.name).toBe("Grace Hopper");
        expect(result[0]?.title).toBe("Visible after API write");
        expect(result[0]?.authorId).toBe("01963227-d4c7-72db-b858-f89f6af8f921");
      });
    } finally {
      sync.unsubscribe();
      await localPg.close();
    }
  }, 30_000);

  it("syncs a consistency group on one stream with a single shared subscription row (ADR-0009 decision 2)", async () => {
    // Parent author + child todo seeded together; a group commits both atomically at a shared LSN.
    await server.request("/api/mutations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mutations: [
          {
            tableName: "authors",
            entityKey: { id: "0196322a-0000-7000-8000-00000000a001" },
            mutationId: "8d0a1d2e-0000-4000-8000-00000000a001",
            mutationSeq: 1,
            kind: "create",
            payload: { id: "0196322a-0000-7000-8000-00000000a001", name: "Group Parent" },
            clientTimestampUs: String(Date.now() * 1000),
          },
          {
            tableName: "todos",
            entityKey: { id: "0196322a-0000-7000-8000-00000000b001" },
            mutationId: "8d0a1d2e-0000-4000-8000-00000000b001",
            mutationSeq: 2,
            kind: "create",
            payload: {
              id: "0196322a-0000-7000-8000-00000000b001",
              title: "Grouped child",
              description: null,
              author_id: "0196322a-0000-7000-8000-00000000a001",
              status: "todo",
              priority: "medium",
            },
            clientTimestampUs: String(Date.now() * 1000),
          },
        ],
      }),
    });

    const localPg = await createLocalTodoStore();
    let markInitialSyncDone: (() => void) | null = null;
    const initialSyncDone = new Promise<void>((resolve) => {
      markInitialSyncDone = resolve;
    });
    const sync = await startCircuitsSync(localPg, {
      registry: groupedDemoRegistry,
      controlPlaneUrl: stack.controlPlaneUrl,
      streamBaseUrl: stack.streamBaseUrl,
      metadataSchema: DEFAULT_METADATA_SCHEMA,
      onInitialSync: () => {
        markInitialSyncDone?.();
        markInitialSyncDone = null;
      },
    });

    try {
      await initialSyncDone;

      const localDb = drizzleOver(localPg);
      await waitFor(async () => {
        const authorResult = await localDb.select({ count: count() }).from(authorsTable);
        const todoResult = await localDb.select({ count: count() }).from(todosTable);
        expect(authorResult[0]?.count).toBe(1);
        expect(todoResult[0]?.count).toBe(1);
      });

      // The whole group persists ONE subscription-state row, keyed by the group, whose per-shape
      // metadata covers both member streams — i.e. one atomically-committing group, not two.
      //
      // The per-shape keys are the engine's own STREAM PATHS, not the table names: a shared-tier shape
      // fans out to one stream per entitled scope (ADR-0055 decision 6), so table names are not unique
      // within a group and keying by them would silently collapse every scope but the last. Their exact
      // values are the engine's to choose, so only the count is asserted.
      const subs = await localDb
        .select({ key: subscriptionsMetadataTable.key, shapeMetadata: subscriptionsMetadataTable.shapeMetadata })
        .from(subscriptionsMetadataTable)
        .orderBy(subscriptionsMetadataTable.key);
      expect(subs).toHaveLength(1);
      expect(subs[0]?.key).toBe("demo");
      expect(Object.keys(subs[0]?.shapeMetadata ?? {})).toHaveLength(2);
    } finally {
      sync.unsubscribe();
      await localPg.close();
    }
  }, 30_000);

  it("converges a steady-state stream of same-PK updates through the fold + bulk apply (ADR-0014)", async () => {
    const authorId = "0196322b-0000-7000-8000-0000000000a1";
    const todoId = "0196322b-0000-7000-8000-0000000000b1";

    // Seed the parent author and the todo whose primary key we will churn.
    await server.request("/api/mutations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mutations: [
          {
            tableName: "authors",
            entityKey: { id: authorId },
            mutationId: "0196322b-0000-4000-8000-0000000000a1",
            mutationSeq: 1,
            kind: "create",
            payload: { id: authorId, name: "Churn Author" },
            clientTimestampUs: String(Date.now() * 1000),
          },
          {
            tableName: "todos",
            entityKey: { id: todoId },
            mutationId: "0196322b-0000-4000-8000-0000000000b1",
            mutationSeq: 2,
            kind: "create",
            payload: {
              id: todoId,
              title: "v0",
              description: null,
              author_id: authorId,
              status: "todo",
              priority: "low",
            },
            clientTimestampUs: String(Date.now() * 1000),
          },
        ],
      }),
    });

    const localPg = await createLocalTodoStore();
    const { sync, initialSyncDone } = await startTestSync(localPg, stack);

    try {
      await initialSyncDone;

      // Steady-state churn: many updates to the SAME primary key, each its own batch (faithful to the
      // client's per-entity serialization). They stream down and the read apply must converge to the
      // last value — the fold collapses any that land in one drained window to a single UPDATE.
      const updates = 8;
      for (let i = 1; i <= updates; i++) {
        await server.request("/api/mutations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            mutations: [
              {
                tableName: "todos",
                entityKey: { id: todoId },
                mutationId: `0196322b-0000-4000-8000-0000000000${(0xc0 + i).toString(16)}`,
                mutationSeq: i + 2,
                kind: "update",
                payload: { title: `v${i}`, priority: i % 2 === 0 ? "high" : "low" },
                clientTimestampUs: String(Date.now() * 1000),
              },
            ],
          }),
        });
      }

      const localDb = drizzleOver(localPg);
      await waitFor(async () => {
        const result = await localDb
          .select({ title: todosTable.title, priority: todosTable.priority })
          .from(todosTable)
          .where(eq(todosTable.id, todoId));
        expect(result[0]?.title).toBe(`v${updates}`); // converged to the last write
        expect(result[0]?.priority).toBe("high"); // v8 is even → high

        // Exactly one row for the PK — the bulk INSERT/UPDATE path never duplicated it.
        const countResult = await localDb.select({ count: count() }).from(todosTable).where(eq(todosTable.id, todoId));
        expect(countResult[0]?.count).toBe(1);
      });
    } finally {
      sync.unsubscribe();
      await localPg.close();
    }
  }, 30_000);
});
