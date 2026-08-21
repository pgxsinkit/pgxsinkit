import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PGlite } from "@electric-sql/pglite";
import { count, eq } from "drizzle-orm";

import { createSyncClient } from "@pgxsinkit/client";
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

// Lazy on-demand activation, end-to-end against the REAL engine (postgres → Circuits → durable-streams
// → PGlite).
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

// The lifecycle axes live on the REGISTRY, and only there (ADR-0021): `startCircuitsSync` derives its
// groups from `entry.subscription`/`entry.retention`, so flipping `todos` is a registry override rather
// than a per-run sync config. A shallow override is enough — `generateLocalSchemaSql` reads the same two
// fields, so the DDL and the engine agree by construction.
const lazyRegistry = {
  ...demoSyncRegistry,
  todos: { ...demoSyncRegistry.todos, subscription: "lazy" as const },
};
const persistentSchemaSql = generateLocalSchemaSql(lazyRegistry);
const ephemeralRegistry = {
  ...demoSyncRegistry,
  todos: { ...demoSyncRegistry.todos, subscription: "lazy" as const, retention: "ephemeral" as const },
};
const ephemeralSchemaSql = generateLocalSchemaSql(ephemeralRegistry);

async function createStore(schemaSql: string) {
  const pg = await createCircuitsTestPGlite();
  await pg.exec(schemaSql);
  return pg;
}

async function startSync(
  localPg: Awaited<ReturnType<typeof createStore>>,
  urls: Pick<NativeSyncStack<unknown>, "controlPlaneUrl" | "streamBaseUrl">,
  registry: typeof demoSyncRegistry,
) {
  let markBootDone: (() => void) | null = null;
  const bootDone = new Promise<void>((resolve) => {
    markBootDone = resolve;
  });
  const sync = await startCircuitsSync(localPg, {
    registry,
    controlPlaneUrl: urls.controlPlaneUrl,
    streamBaseUrl: urls.streamBaseUrl,
    metadataSchema: DEFAULT_METADATA_SCHEMA,
    onInitialSync: () => {
      markBootDone?.();
      markBootDone = null;
    },
  });
  return { sync, bootDone };
}

// Each test uses a DISTINCT author/todo id pair. The two tests share one `todos` shape
// (same table, same predicate), so reusing one id across tests would mean delete-then-reinsert of the same
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
  // One HTTP front for the demo server, serving both the write route and the native control plane, so
  // the full `createSyncClient` (which requires a `batchWriteUrl`) can boot against it.
  let stack!: NativeSyncStack<ReturnType<typeof createSyncServer<typeof demoSyncRegistry>>>;
  let server!: ReturnType<typeof createSyncServer<typeof demoSyncRegistry>>;
  let batchWriteUrl!: string;
  const serverDb = createServerDb(demoSyncRegistry, env.databaseUrl);

  beforeAll(async () => {
    const provisioningServer = createSyncServer({ registry: demoSyncRegistry, db: serverDb.db });
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
          resolveAuthClaims: () => ({ role: "authenticated", sub: "179e4f33-69ec-4f39-ba26-8f10c8ac8c9d" }),
          readPath,
        }),
    });
    server = stack.server;
    batchWriteUrl = `${stack.controlPlaneUrl}/api/mutations`;
  });

  beforeEach(async () => {
    await server.drizzle.delete(todosTable);
    await server.drizzle.delete(authorsTable);
  });

  afterAll(async () => {
    await stack.stop();
    await serverDb.close();
  });

  it("lazy (persistent): a held-out group is empty at boot, then streams its rows on ensureGroupStarted", async () => {
    const authorId = "01970000-0000-7000-8000-0000000a0001";
    const todoId = "01970000-0000-7000-8000-0000000b0001";
    await seedAuthorAndTodo(server, authorId, todoId);
    const localPg = await createStore(persistentSchemaSql);
    const { sync, bootDone } = await startSync(localPg, stack, lazyRegistry);

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
    const { sync, bootDone } = await startSync(localPg, stack, ephemeralRegistry);

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
        controlPlaneUrl: stack.controlPlaneUrl,
        streamBaseUrl: stack.streamBaseUrl,
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
        controlPlaneUrl: stack.controlPlaneUrl,
        streamBaseUrl: stack.streamBaseUrl,
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
