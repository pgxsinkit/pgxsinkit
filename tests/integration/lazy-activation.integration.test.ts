import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";

import { deriveSyncColumnTypes } from "@pgxsinkit/contracts";
import { authorsTable, buildDemoSyncConfig, demoSyncRegistry, todosTable } from "@pgxsinkit/schema";
import { createSyncServer } from "@pgxsinkit/server";
import { createServerDb, readIntegrationEnv, waitFor } from "@pgxsinkit/test-utils";

import { generateLocalSchemaSql } from "../../packages/client/src/schema";
import { createElectricExtension, startConfiguredSync } from "../../packages/client/src/shape-sync";
import { installPlpgsqlBatchFunction } from "../../packages/server/src/mutations/plpgsql-apply";
import { createFreshTestPGlite } from "../support/pglite";

// Lazy on-demand activation, end-to-end against the REAL engine (postgres → Electric → PGlite).
//
// Why this exists: `client-lazy-facade.test.ts` fully MOCKS the sync engine (it only records that
// `ensureGroupStarted` was called), and no integration test drives a lazy group actually streaming
// rows. The board demo's `lazy + ephemeral` chat surfaced the gap: activation resolves cleanly
// (isSynced → true, no error) but ZERO rows land in the local store. These two tests isolate the two
// lifecycle axes the demo turned on together — `lazy` alone (Test 1) and `lazy + ephemeral` (Test 2) —
// reusing the already-migrated demo tables (`authors` eager, `todos` flipped lazy) so the only variable
// is the lifecycle. `authors` stays eager so boot completes; `todos` must be empty until activated.
//
// Run via the implementation integration lane (`bun run test:integration:implementation`).

const env = readIntegrationEnv();

// Persistent local schema (today's path) and an ephemeral one where `todos`' whole cluster is TEMP.
// generateLocalSchemaSql reads `entry.retention`/`subscription`, so a shallow override is enough.
const persistentSchemaSql = generateLocalSchemaSql(demoSyncRegistry);
const ephemeralRegistry = {
  ...demoSyncRegistry,
  todos: { ...demoSyncRegistry.todos, subscription: "lazy" as const, retention: "ephemeral" as const },
};
const ephemeralSchemaSql = generateLocalSchemaSql(ephemeralRegistry);

// The demo sync config with `todos` flipped to `lazy` (Test 1) and additionally `ephemeral` (Test 2).
// buildDemoSyncConfig returns the entry objects directly, so the engine reads these axes off them. We
// also attach `columnTypes` (as the real client's `buildSyncConfigFromRegistry` does) so the apply
// ladder uses the statically-resolved types instead of an `information_schema` probe — the production
// path, and the one that resolves a `pg_temp` table's columns correctly for the bulk update/delete apply.
function lazyTodosConfig(ephemeral: boolean) {
  const config = buildDemoSyncConfig(env.electricUrl);
  return {
    ...config,
    tables: {
      authors: { ...config.tables.authors, columnTypes: deriveSyncColumnTypes(demoSyncRegistry.authors) },
      todos: {
        ...config.tables.todos,
        columnTypes: deriveSyncColumnTypes(demoSyncRegistry.todos),
        subscription: "lazy" as const,
        ...(ephemeral ? { retention: "ephemeral" as const } : {}),
      },
    },
  };
}

async function createStore(schemaSql: string) {
  const pg = await createFreshTestPGlite({ extensions: { electric: createElectricExtension() } });
  await pg.exec(schemaSql);
  return pg;
}

async function startSync(
  localPg: Awaited<ReturnType<typeof createStore>>,
  syncConfig: ReturnType<typeof lazyTodosConfig>,
) {
  let markBootDone: (() => void) | null = null;
  const bootDone = new Promise<void>((resolve) => {
    markBootDone = resolve;
  });
  const sync = await startConfiguredSync(localPg as Parameters<typeof startConfiguredSync>[0], {
    syncConfig,
    onInitialSync: () => {
      markBootDone?.();
      markBootDone = null;
    },
  });
  return { sync, bootDone };
}

// Each test uses a DISTINCT author/todo id pair. The two tests share one Electric `todos` shape
// (same table, no where), so reusing one id across tests would mean delete-then-reinsert of the same
// PK on that shape between tests — churn that races a fresh subscriber's snapshot. Distinct ids keep
// each test hermetic.
async function seedAuthorAndTodo(
  server: ReturnType<typeof createSyncServer<typeof demoSyncRegistry>>,
  authorId: string,
  todoId: string,
) {
  await server.request("/api/mutations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      mutations: [
        {
          tableName: "authors",
          entityKey: { id: authorId },
          mutationId: crypto.randomUUID(),
          mutationSeq: 1,
          kind: "create",
          payload: { id: authorId, name: "Lazy Author" },
          clientTimestampUs: String(Date.now() * 1000),
        },
        {
          tableName: "todos",
          entityKey: { id: todoId },
          mutationId: crypto.randomUUID(),
          mutationSeq: 2,
          kind: "create",
          payload: {
            id: todoId,
            title: "Held until activated",
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
}

const countTodo = async (pg: Awaited<ReturnType<typeof createStore>>, todoId: string) =>
  (await pg.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM todos WHERE id = $1;", [todoId])).rows[0]
    ?.count;

describe("lazy on-demand activation streams rows (real engine)", () => {
  let server!: ReturnType<typeof createSyncServer<typeof demoSyncRegistry>>;
  const serverDb = createServerDb(demoSyncRegistry, env.databaseUrl);

  beforeAll(async () => {
    const provisioningServer = createSyncServer({ registry: demoSyncRegistry, db: serverDb.db });
    try {
      await installPlpgsqlBatchFunction(provisioningServer.drizzle, demoSyncRegistry);
    } finally {
      await provisioningServer.stop();
    }
    server = createSyncServer({
      registry: demoSyncRegistry,
      db: serverDb.db,
      resolveAuthClaims: () => ({ role: "authenticated", sub: "179e4f33-69ec-4f39-ba26-8f10c8ac8c9d" }),
    });
  });

  beforeEach(async () => {
    await server.drizzle.delete(todosTable);
    await server.drizzle.delete(authorsTable);
  });

  afterAll(async () => {
    await server.stop();
    await serverDb.close();
  });

  it("lazy (persistent): a held-out group is empty at boot, then streams its rows on ensureGroupStarted", async () => {
    const authorId = "01970000-0000-7000-8000-0000000a0001";
    const todoId = "01970000-0000-7000-8000-0000000b0001";
    await seedAuthorAndTodo(server, authorId, todoId);
    const localPg = await createStore(persistentSchemaSql);
    const { sync, bootDone } = await startSync(localPg, lazyTodosConfig(false));

    try {
      await bootDone;
      // Held out of the eager boot: authors (eager) synced, todos (lazy) dormant + empty.
      expect(sync.isTableStarted("todos")).toBe(false);
      expect(await countTodo(localPg, todoId)).toBe(0);

      const groupKey = sync.groupKeyForTable("todos");
      expect(groupKey).toBeDefined();
      await sync.ensureGroupStarted(groupKey!);

      // The on-demand subscription must stream the seeded row down — this is the path the board's chat hits.
      await waitFor(async () => {
        expect(await countTodo(localPg, todoId)).toBe(1);
      });
      expect(sync.isTableStarted("todos")).toBe(true);
    } finally {
      sync.unsubscribe();
      await localPg.close();
    }
  }, 30_000);

  it("lazy + ephemeral: a TEMP-cluster group also streams its rows on ensureGroupStarted", async () => {
    const authorId = "01970000-0000-7000-8000-0000000a0002";
    const todoId = "01970000-0000-7000-8000-0000000b0002";
    await seedAuthorAndTodo(server, authorId, todoId);
    const localPg = await createStore(ephemeralSchemaSql);
    const { sync, bootDone } = await startSync(localPg, lazyTodosConfig(true));

    try {
      await bootDone;
      expect(sync.isTableStarted("todos")).toBe(false);
      expect(await countTodo(localPg, todoId)).toBe(0); // bare `todos` resolves to the pg_temp cluster

      const groupKey = sync.groupKeyForTable("todos");
      expect(groupKey).toBeDefined();
      await sync.ensureGroupStarted(groupKey!);

      await waitFor(async () => {
        expect(await countTodo(localPg, todoId)).toBe(1);
      });
      expect(sync.isTableStarted("todos")).toBe(true);
    } finally {
      sync.unsubscribe();
      await localPg.close();
    }
  }, 30_000);
});
