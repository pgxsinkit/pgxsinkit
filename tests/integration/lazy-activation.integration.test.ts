import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PGlite } from "@electric-sql/pglite";
import { count, eq } from "drizzle-orm";

import { createSyncClient } from "@pgxsinkit/client";
import { authorsTable, buildDemoSyncConfig, demoSyncRegistry, todosTable } from "@pgxsinkit/schema";
import { createSyncServer } from "@pgxsinkit/server";
import { createServerDb, readIntegrationEnv, waitFor } from "@pgxsinkit/test-utils";

import { generateLocalSchemaSql } from "../../packages/client/src/schema";
import { startConfiguredSync } from "../../packages/client/src/shape-sync";
import { installPlpgsqlBatchFunction } from "../../packages/server/src/mutations/plpgsql-apply";
import { drizzleOver } from "../support/drizzle";
import { createSyncEngineTestPGlite } from "../support/sync-engine-pglite";

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
// buildDemoSyncConfig returns the entry objects directly, so the engine reads these axes off them. The
// apply ladder's types are no longer carried on the config: the engine resolves them from the registry
// entry via `resolveApplyTarget` (ADR-0029 D1/D2), which also fixes `pg_temp` column resolution for the
// bulk update/delete apply — so no `columnTypes` attachment is needed here.
function lazyTodosConfig(ephemeral: boolean) {
  const config = buildDemoSyncConfig(env.electricUrl);
  return {
    ...config,
    tables: {
      authors: { ...config.tables.authors },
      todos: {
        ...config.tables.todos,
        subscription: "lazy" as const,
        ...(ephemeral ? { retention: "ephemeral" as const } : {}),
      },
    },
  };
}

async function createStore(schemaSql: string) {
  const pg = await createSyncEngineTestPGlite();
  await pg.exec(schemaSql);
  return pg;
}

async function startSync(
  localPg: Awaited<ReturnType<typeof createStore>>,
  syncConfig: ReturnType<typeof lazyTodosConfig>,
  registry: typeof demoSyncRegistry,
) {
  let markBootDone: (() => void) | null = null;
  const bootDone = new Promise<void>((resolve) => {
    markBootDone = resolve;
  });
  const sync = await startConfiguredSync(localPg as Parameters<typeof startConfiguredSync>[0], {
    syncConfig,
    registry,
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

// `todosTable` carries no schema qualifier, so Drizzle renders the BARE name `"todos"` — in the
// ephemeral test that resolves via search_path to the pg_temp cluster, exactly as the raw SQL did.
const countTodo = async (pg: Awaited<ReturnType<typeof createStore>>, todoId: string) =>
  (await drizzleOver(pg).select({ count: count() }).from(todosTable).where(eq(todosTable.id, todoId)))[0]?.count;

describe("lazy on-demand activation streams rows (real engine)", () => {
  let server!: ReturnType<typeof createSyncServer<typeof demoSyncRegistry>>;
  // A Bun HTTP front for the demo server so the full `createSyncClient` (which requires a `batchWriteUrl`)
  // can boot. The engine-restart repro drives reads only, so the write path is never exercised — but a
  // real, reachable `batchWriteUrl` keeps the client construction faithful to production.
  let writeServer!: ReturnType<typeof Bun.serve>;
  let batchWriteUrl!: string;
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
    writeServer = Bun.serve({ port: 0, fetch: (request) => server.fetch(request) });
    batchWriteUrl = `http://127.0.0.1:${writeServer.port}/api/mutations`;
  });

  beforeEach(async () => {
    await server.drizzle.delete(todosTable);
    await server.drizzle.delete(authorsTable);
  });

  afterAll(async () => {
    await writeServer.stop(true);
    await server.stop();
    await serverDb.close();
  });

  it("lazy (persistent): a held-out group is empty at boot, then streams its rows on ensureGroupStarted", async () => {
    const authorId = "01970000-0000-7000-8000-0000000a0001";
    const todoId = "01970000-0000-7000-8000-0000000b0001";
    await seedAuthorAndTodo(server, authorId, todoId);
    const localPg = await createStore(persistentSchemaSql);
    const { sync, bootDone } = await startSync(localPg, lazyTodosConfig(false), demoSyncRegistry);

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
    const { sync, bootDone } = await startSync(localPg, lazyTodosConfig(true), ephemeralRegistry);

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

  // Engine-restart of a `lazy + ephemeral` group over a WARM store — the board's `lazy + ephemeral` chat
  // read after the SharedWorker (engine) dies and the same user returns (cold worker, warm store). Unlike
  // the two tests above (which drive the sync engine directly and never die/reboot), this one goes through
  // the full `createSyncClient` boot on a FILESYSTEM store that survives `stop()`.
  //
  // Mechanism under test (ADR-0042): an ephemeral group's TEMP cluster and rows die with the engine (the
  // boot always re-creates the TEMP relations EMPTY), AND — now — so does its subscription cursor, which the
  // engine stores in `pg_temp.subscriptions_metadata` for a session-scoped group. So boot B finds NO cursor
  // for the group (the session table is empty on a new engine), treats it as a brand-new subscription, and
  // re-streams the whole shape from scratch over the recreated-empty TEMP table. Pre-ADR-0042 the durable
  // cursor survived and boot B resumed from it over emptiness — Electric re-sent nothing and the history
  // never re-arrived. No boot sweep exists in this design: storage placement makes the cursor session-scoped.
  it("lazy + ephemeral: rows re-arrive after an engine restart over a warm store (ADR-0042 session cursor)", async () => {
    const authorId = "01970000-0000-7000-8000-0000000a0003";
    const todoId = "01970000-0000-7000-8000-0000000b0003";
    await seedAuthorAndTodo(server, authorId, todoId);

    // A real on-disk store (not memory): it must survive `stop()` so boot B is a genuine warm store.
    const storePath = await mkdtemp(join(tmpdir(), "pgxsinkit-ephemeral-restart-"));
    const countClientTodo = async (client: { pglite: unknown }) =>
      (
        await drizzleOver(client.pglite as PGlite)
          .select({ count: count() })
          .from(todosTable)
          .where(eq(todosTable.id, todoId))
      )[0]?.count;

    try {
      // Boot A — fresh warm store. `todos` is lazy → dormant + empty until activated.
      const clientA = await createSyncClient({
        registry: ephemeralRegistry,
        electricUrl: env.electricUrl,
        batchWriteUrl,
        storePath,
      });
      try {
        await clientA.ready;
        expect(await countClientTodo(clientA)).toBe(0);

        await clientA.ensureSynced(["todos"]);
        await clientA.groupReady("todos");
        await waitFor(async () => {
          expect(await countClientTodo(clientA)).toBe(1);
        });
      } finally {
        // `stop()` halts sync + closes the engine but preserves the on-disk store (ADR-0005) — the
        // engine-death half of the board repro.
        await clientA.stop();
      }

      // Boot B — cold worker (new engine), SAME warm store. The ephemeral TEMP cluster is re-created empty.
      const clientB = await createSyncClient({
        registry: ephemeralRegistry,
        electricUrl: env.electricUrl,
        batchWriteUrl,
        storePath,
      });
      try {
        await clientB.ready;
        // The TEMP cluster died with boot A's engine, so `todos` starts empty again this boot.
        expect(await countClientTodo(clientB)).toBe(0);

        await clientB.ensureSynced(["todos"]);
        // H3 distinguisher: the activation is NOT dropped — the group genuinely starts and reaches
        // up-to-date on boot B (this resolves). The bug was that it caught up with ZERO rows because the
        // resumed durable cursor believed the (now-empty) TEMP table was already synced.
        await clientB.groupReady("todos");

        // The row MUST re-stream over the recreated-empty TEMP cluster. Pre-fix this times out at 0.
        await waitFor(async () => {
          expect(await countClientTodo(clientB)).toBe(1);
        });
      } finally {
        await clientB.destroy({ force: true });
      }
    } finally {
      await rm(storePath, { recursive: true, force: true });
    }
  }, 60_000);
});
