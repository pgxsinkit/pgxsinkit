import { sql } from "drizzle-orm";

import { buildDemoSyncConfig, demoSyncRegistry } from "@pgxsinkit/demo";
import { createSyncServer } from "@pgxsinkit/server";
import { createElectricExtension, startConfiguredSync } from "@pgxsinkit/sync-engine";
import { readIntegrationEnv, waitFor } from "@pgxsinkit/test-utils";

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

  const sync = await startConfiguredSync(localPg, {
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
    server = createSyncServer({
      registry: demoSyncRegistry,
      databaseUrl: env.databaseUrl,
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
    await server.request("/api/authors", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        id: "01963227-d4c7-72db-b858-f89f6af8f920",
        name: "Ada Lovelace",
      }),
    });

    await server.request("/api/todos", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        id: "01963227-d4c7-72db-b858-f89f6af8f991",
        title: "Seed row one",
        description: null,
        authorId: "01963227-d4c7-72db-b858-f89f6af8f920",
        status: "todo",
        priority: "medium",
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

      await server.request("/api/authors", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          id: "01963227-d4c7-72db-b858-f89f6af8f921",
          name: "Grace Hopper",
        }),
      });

      const response = await server.request("/api/todos", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          id: "01963227-d4c7-72db-b858-f89f6af8f992",
          title: "Visible after API write",
          description: "Electric should stream this down",
          authorId: "01963227-d4c7-72db-b858-f89f6af8f921",
          status: "in_progress",
          priority: "high",
        }),
      });

      expect(response.status).toBe(201);

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
