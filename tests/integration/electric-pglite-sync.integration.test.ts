import { sql } from "drizzle-orm";

import { buildDemoSyncConfig, demoSyncRegistry } from "@pgxsinkit/schema";
import { createSyncServer } from "@pgxsinkit/server";
import { createElectricExtension, startConfiguredSync } from "@pgxsinkit/sync-engine";
import { readIntegrationEnv, waitFor } from "@pgxsinkit/test-utils";

import { installPlpgsqlBatchFunction } from "../../packages/server/src/mutations/bulk/plpgsql-strategy";
import { createFreshTestPGlite } from "../support/pglite";

const env = readIntegrationEnv();

const ensureTodosTableSql = sql.raw(`
  DO $$
  BEGIN
    IF to_regclass('public.authors') IS NULL THEN
      CREATE TABLE authors (
        id UUID PRIMARY KEY,
        name VARCHAR(120) NOT NULL,
        owner_id UUID,
        modified_by UUID,
        created_at_us BIGINT NOT NULL DEFAULT CAST(FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000000) AS BIGINT),
        updated_at_us BIGINT NOT NULL DEFAULT CAST(FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000000) AS BIGINT)
      );
    END IF;
  END $$;

  DO $$
  BEGIN
    IF to_regclass('public.todos') IS NULL THEN
      CREATE TABLE todos (
        id UUID PRIMARY KEY,
        title VARCHAR(120) NOT NULL,
        description TEXT,
        author_id UUID NOT NULL REFERENCES authors(id),
        owner_id UUID,
        modified_by UUID,
        status VARCHAR(24) NOT NULL DEFAULT 'todo',
        priority VARCHAR(24) NOT NULL DEFAULT 'medium',
        created_at_us BIGINT NOT NULL DEFAULT CAST(FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000000) AS BIGINT),
        updated_at_us BIGINT NOT NULL DEFAULT CAST(FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000000) AS BIGINT)
      );
    END IF;
  END $$;
`);

async function createLocalTodoStore() {
  const pg = await createFreshTestPGlite({
    extensions: {
      electric: createElectricExtension(),
    },
  });

  await pg.exec(`
    CREATE TABLE IF NOT EXISTS authors (
      id UUID PRIMARY KEY,
      name VARCHAR(120) NOT NULL,
      owner_id UUID,
      modified_by UUID,
      created_at_us BIGINT NOT NULL,
      updated_at_us BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS todos (
      id UUID PRIMARY KEY,
      title VARCHAR(120) NOT NULL,
      description TEXT,
      author_id UUID NOT NULL,
      owner_id UUID,
      modified_by UUID,
      status VARCHAR(24) NOT NULL,
      priority VARCHAR(24) NOT NULL,
      created_at_us BIGINT NOT NULL,
      updated_at_us BIGINT NOT NULL
    );
  `);

  return pg;
}

async function startTestSync(localPg: Awaited<ReturnType<typeof createLocalTodoStore>>) {
  let markInitialSyncDone: (() => void) | null = null;
  const initialSyncDone = new Promise<void>((resolve) => {
    markInitialSyncDone = resolve;
  });

  const sync = await startConfiguredSync(localPg as Parameters<typeof startConfiguredSync>[0], {
    syncConfig: buildDemoSyncConfig(env.electricUrl),
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

describe("electric -> pglite sync integration", () => {
  let server!: ReturnType<typeof createSyncServer<typeof demoSyncRegistry>>;

  beforeAll(async () => {
    const provisioningServer = createSyncServer({
      registry: demoSyncRegistry,
      databaseUrl: env.databaseUrl,
    });

    try {
      await installPlpgsqlBatchFunction(provisioningServer.drizzle, demoSyncRegistry);
    } finally {
      await provisioningServer.stop();
    }

    server = createSyncServer({
      registry: demoSyncRegistry,
      databaseUrl: env.databaseUrl,
      resolveAuthClaims: () => ({
        role: "authenticated",
        sub: "179e4f33-69ec-4f39-ba26-8f10c8ac8c9d",
      }),
    });
    await server.drizzle.execute(ensureTodosTableSql);
  });

  beforeEach(async () => {
    await server.drizzle.execute(sql.raw("TRUNCATE TABLE todos, authors;"));
  });

  afterAll(async () => {
    await server.stop();
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
    const { sync, initialSyncDone } = await startTestSync(localPg);

    try {
      await initialSyncDone;

      await waitFor(async () => {
        const authorResult = await localPg.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM authors;");
        const result = await localPg.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM todos;");
        expect(authorResult.rows[0]?.count).toBe(1);
        expect(result.rows[0]?.count).toBe(1);
      });
    } finally {
      sync.unsubscribe();
      await localPg.close();
    }
  }, 30_000);

  it("delivers new API writes to an active pglite subscriber", async () => {
    const localPg = await createLocalTodoStore();
    const { sync, initialSyncDone } = await startTestSync(localPg);

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

      await waitFor(async () => {
        const authorResult = await localPg.query<{ name: string }>("SELECT name FROM authors WHERE id = $1;", [
          "01963227-d4c7-72db-b858-f89f6af8f921",
        ]);
        const result = await localPg.query<{ title: string; authorId: string }>(
          'SELECT title, author_id AS "authorId" FROM todos WHERE title = $1;',
          ["Visible after API write"],
        );
        expect(authorResult.rows[0]?.name).toBe("Grace Hopper");
        expect(result.rows[0]?.title).toBe("Visible after API write");
        expect(result.rows[0]?.authorId).toBe("01963227-d4c7-72db-b858-f89f6af8f921");
      });
    } finally {
      sync.unsubscribe();
      await localPg.close();
    }
  }, 30_000);
});
