import { readFile } from "node:fs/promises";

import { eq, sql } from "drizzle-orm";
import { pgTable, uuid, varchar } from "drizzle-orm/pg-core";

import { defineSyncRegistry, defineSyncTable, defineTableGovernance } from "@pgxsinkit/contracts";
import {
  authorsTable,
  demoSyncRegistry,
  DEMO_JWT_ADMIN,
  DEMO_JWT_USER1,
  DEMO_JWT_USER2,
  DEMO_USER1_ID,
  todosTable,
} from "@pgxsinkit/demo";
import { createSyncServer } from "@pgxsinkit/server";
import { readIntegrationEnv } from "@pgxsinkit/test-utils";

import { parseDemoAuthClaimsFromRequest } from "../../apps/write-api/src/demo-auth";
import { installPlpgsqlBatchFunction } from "../../packages/server/src/mutations/bulk/plpgsql-strategy";

const env = readIntegrationEnv();

const ensureTablesSql = sql.raw(`
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

  ALTER TABLE authors ADD COLUMN IF NOT EXISTS owner_id UUID;
  ALTER TABLE authors ADD COLUMN IF NOT EXISTS modified_by UUID;

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

  ALTER TABLE todos ADD COLUMN IF NOT EXISTS owner_id UUID;
  ALTER TABLE todos ADD COLUMN IF NOT EXISTS modified_by UUID;
`);

const fkParentsTable = pgTable("fk_parents", {
  id: uuid("id").primaryKey(),
  name: varchar("name", { length: 120 }).notNull(),
});

const fkChildrenTable = pgTable("fk_children", {
  id: uuid("id").primaryKey(),
  name: varchar("name", { length: 120 }).notNull(),
  parentId: uuid("parent_id")
    .notNull()
    .references(() => fkParentsTable.id),
});

const fkSyncRegistry = defineSyncRegistry({
  fk_parents: defineSyncTable({
    table: fkParentsTable,
    mode: "readwrite",
    primaryKey: { columns: ["id"] },
    shape: { tableName: "fk_parents", shapeKey: "fk_parents" },
    routes: { basePath: "/api/fk-parents", allowBatch: false },
  }),
  fk_children: defineSyncTable({
    table: fkChildrenTable,
    mode: "readwrite",
    primaryKey: { columns: ["id"] },
    shape: { tableName: "fk_children", shapeKey: "fk_children" },
    routes: { basePath: "/api/fk-children", allowBatch: false },
  }),
});

const ensureFkTablesSql = sql.raw(`
  DO $$
  BEGIN
    IF to_regclass('public.fk_parents') IS NULL THEN
      CREATE TABLE fk_parents (
        id UUID PRIMARY KEY,
        name VARCHAR(120) NOT NULL
      );
    END IF;
  END $$;

  DO $$
  BEGIN
    IF to_regclass('public.fk_children') IS NULL THEN
      CREATE TABLE fk_children (
        id UUID PRIMARY KEY,
        name VARCHAR(120) NOT NULL,
        parent_id UUID NOT NULL,
        CONSTRAINT fk_children_parent_fk FOREIGN KEY (parent_id) REFERENCES fk_parents(id)
      );
    END IF;
  END $$;
`);

const ensureFkConstraintDeferrableSql = sql.raw(`
  ALTER TABLE "fk_children"
  ALTER CONSTRAINT "fk_children_parent_fk"
  DEFERRABLE INITIALLY IMMEDIATE;
`);

const rlsTodosTable = pgTable("rls_todos", {
  id: uuid("id").primaryKey(),
  title: varchar("title", { length: 120 }).notNull(),
  ownerId: uuid("owner_id"),
});

const rlsSyncRegistry = defineSyncRegistry({
  rls_todos: defineSyncTable({
    table: rlsTodosTable,
    mode: "readwrite",
    primaryKey: { columns: ["id"] },
    shape: { tableName: "rls_todos", shapeKey: "rls_todos" },
    routes: { basePath: "/api/rls-todos", allowBatch: false },
    governance: defineTableGovernance(rlsTodosTable, {
      rls: {
        enabled: true,
        force: false,
        policies: [],
      },
    }),
  }),
});

const ensureSupabaseAuthHelpersSql = sql.raw(`
  CREATE SCHEMA IF NOT EXISTS auth;

  DO $$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      BEGIN
        CREATE ROLE authenticated NOLOGIN;
      EXCEPTION
        WHEN insufficient_privilege THEN
          NULL;
      END;
    END IF;
  END;
  $$;

  CREATE OR REPLACE FUNCTION auth.set_auth_context(claims jsonb)
  RETURNS void
  LANGUAGE plpgsql
  AS $$
  DECLARE
    normalized_claims jsonb := COALESCE(claims, '{}'::jsonb);
    target_role text := COALESCE(NULLIF(normalized_claims ->> 'role', ''), 'authenticated');
  BEGIN
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = target_role) THEN
        PERFORM set_config('role', target_role, true);
      ELSIF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        PERFORM set_config('role', 'authenticated', true);
      END IF;
    EXCEPTION
      WHEN insufficient_privilege THEN
        NULL;
    END;
    PERFORM set_config('request.jwt.claims', normalized_claims::text, true);

    IF normalized_claims ? 'sub' THEN
      PERFORM set_config('request.jwt.claim.sub', normalized_claims ->> 'sub', true);
    END IF;
  END;
  $$;

  CREATE OR REPLACE FUNCTION auth.uid()
  RETURNS uuid
  LANGUAGE sql
  STABLE
  AS $$
    SELECT coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid
  $$;

  CREATE OR REPLACE FUNCTION auth.jwt()
  RETURNS jsonb
  LANGUAGE sql
  STABLE
  AS $$
    SELECT coalesce(nullif(current_setting('request.jwt.claim', true), ''), nullif(current_setting('request.jwt.claims', true), ''))::jsonb
  $$;

  CREATE OR REPLACE FUNCTION auth.has_role(role_name text)
  RETURNS boolean
  LANGUAGE sql
  STABLE
  AS $$
    SELECT EXISTS (
      SELECT 1
      FROM jsonb_array_elements_text(COALESCE(auth.jwt() -> 'app_metadata' -> 'roles', '[]'::jsonb)) AS assigned_role(role_name_value)
      WHERE assigned_role.role_name_value = role_name
    )
  $$;

  DO $$
  BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE 'GRANT USAGE ON SCHEMA auth TO authenticated';
      EXECUTE 'GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO authenticated';
    END IF;
  END;
  $$;
`);

const ensureRlsTablesSql = sql.raw(`
  DO $$
  BEGIN
    IF to_regclass('public.rls_todos') IS NULL THEN
      CREATE TABLE rls_todos (
        id UUID PRIMARY KEY,
        title VARCHAR(120) NOT NULL,
        owner_id UUID DEFAULT auth.uid()
      );
    END IF;
  END $$;

  ALTER TABLE rls_todos ENABLE ROW LEVEL SECURITY;

  DO $$
  BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE 'GRANT SELECT, INSERT ON TABLE rls_todos TO authenticated';
    END IF;
  END;
  $$;

  DROP POLICY IF EXISTS "rls_todos_select_owner" ON "rls_todos";
  CREATE POLICY "rls_todos_select_owner" ON "rls_todos"
  AS PERMISSIVE
  FOR SELECT
  TO "authenticated" USING (owner_id = auth.uid());

  DROP POLICY IF EXISTS "rls_todos_insert_owner" ON "rls_todos";
  CREATE POLICY "rls_todos_insert_owner" ON "rls_todos"
  AS PERMISSIVE
  FOR INSERT
  TO "authenticated" WITH CHECK (owner_id = auth.uid());
`);

describe("write api implementation integration", () => {
  let server!: ReturnType<typeof createSyncServer<typeof demoSyncRegistry>>;

  beforeAll(async () => {
    server = createSyncServer({
      registry: demoSyncRegistry,
      databaseUrl: env.databaseUrl,
    });
    await server.drizzle.execute(ensureTablesSql);
  });

  beforeEach(async () => {
    await server.drizzle.delete(todosTable);
    await server.drizzle.delete(authorsTable);
  });

  afterAll(async () => {
    await server.stop();
  });

  it("rejects invalid payloads", async () => {
    const response = await server.request("/api/todos", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        title: "",
      }),
    });

    expect(response.status).toBe(400);
  });

  it("returns cors headers for browser app origins", async () => {
    for (const origin of ["http://localhost:5173", "http://localhost:5174"]) {
      const response = await server.request("/api/todos", {
        method: "OPTIONS",
        headers: {
          Origin: origin,
          "Access-Control-Request-Method": "POST",
        },
      });

      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(origin);
    }
  });

  it("returns an empty todo list", async () => {
    const response = await server.request("/api/todos");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
  });

  it("creates and lists authors", async () => {
    const authorId = "01963227-d4c7-72db-b858-f89f6af8f920";
    const createResponse = await server.request("/api/authors", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        id: authorId,
        name: "Ada Lovelace",
      }),
    });

    expect(createResponse.status).toBe(201);

    const listResponse = await server.request("/api/authors");
    expect(listResponse.status).toBe(200);
    expect(await listResponse.json()).toEqual([
      expect.objectContaining({
        id: authorId,
        name: "Ada Lovelace",
      }),
    ]);
  });

  it("persists a validated todo", async () => {
    const todoId = "01963227-d4c7-72db-b858-f89f6af8f999";
    const authorId = "01963227-d4c7-72db-b858-f89f6af8f920";

    await server.request("/api/authors", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        id: authorId,
        name: "Ada Lovelace",
      }),
    });

    const response = await server.request("/api/todos", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        id: todoId,
        title: "Persist from integration test",
        description: "written through Hono + Drizzle",
        authorId,
        status: "todo",
        priority: "high",
      }),
    });

    expect(response.status).toBe(201);
    const created = (await response.json()) as {
      id: string;
      createdAtUs: string;
      updatedAtUs: string;
    };

    const rows = await server.drizzle.select().from(todosTable).where(eq(todosTable.id, created.id));

    expect(rows).toHaveLength(1);
    expect(created.id).toBe(todoId);
    expect(created.createdAtUs).toMatch(/^[0-9]+$/);
    expect(created.updatedAtUs).toMatch(/^[0-9]+$/);
    expect(rows[0]?.authorId).toBe(authorId);
    expect(rows[0]?.title).toBe("Persist from integration test");
  });

  it("updates an existing todo", async () => {
    const todoId = "01963227-d4c7-72db-b858-f89f6af8f981";
    const authorId = "01963227-d4c7-72db-b858-f89f6af8f921";

    await server.request("/api/authors", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        id: authorId,
        name: "Grace Hopper",
      }),
    });

    await server.request("/api/todos", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        id: todoId,
        title: "Before patch",
        description: null,
        authorId,
        status: "todo",
        priority: "medium",
      }),
    });

    const response = await server.request(`/api/todos/${todoId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        status: "done",
        title: "After patch",
      }),
    });

    expect(response.status).toBe(200);
    const updated = (await response.json()) as {
      title: string;
      status: string;
      updatedAtUs: string;
    };
    expect(updated.title).toBe("After patch");
    expect(updated.status).toBe("done");
    expect(updated.updatedAtUs).toMatch(/^[0-9]+$/);
  });

  it("deletes an existing todo", async () => {
    const todoId = "01963227-d4c7-72db-b858-f89f6af8f982";
    const authorId = "01963227-d4c7-72db-b858-f89f6af8f922";

    await server.request("/api/authors", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        id: authorId,
        name: "Margaret Hamilton",
      }),
    });

    await server.request("/api/todos", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        id: todoId,
        title: "Delete me",
        description: null,
        authorId,
        status: "todo",
        priority: "medium",
      }),
    });

    const response = await server.request(`/api/todos/${todoId}`, {
      method: "DELETE",
    });

    expect(response.status).toBe(204);

    const rows = await server.drizzle.select().from(todosTable).where(eq(todosTable.id, todoId));
    expect(rows).toHaveLength(0);
  });

  it("supports disabling operations log at startup", async () => {
    const beforeCount = await readOperationsLogRowCount(server);

    const disabledServer = createSyncServer({
      registry: demoSyncRegistry,
      databaseUrl: env.databaseUrl,
      operationsLog: {
        enabled: false,
      },
    });

    await disabledServer.drizzle.execute(ensureTablesSql);

    try {
      const authorId = "01963227-d4c7-72db-b858-f89f6af8f933";
      const todoId = "01963227-d4c7-72db-b858-f89f6af8f983";

      const createAuthorResponse = await disabledServer.request("/api/authors", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          id: authorId,
          name: "Disabled logger author",
        }),
      });
      expect(createAuthorResponse.status).toBe(201);

      const createTodoResponse = await disabledServer.request("/api/todos", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          id: todoId,
          title: "Write with ops log disabled",
          description: null,
          authorId,
          status: "todo",
          priority: "medium",
        }),
      });
      expect(createTodoResponse.status).toBe(201);
    } finally {
      await disabledServer.stop();
    }

    const afterCount = await readOperationsLogRowCount(server);
    expect(afterCount).toBe(beforeCount);
  });
});

describe.each([
  {
    backend: "bulk-plpgsql" as const,
    expectedStatus: 500,
  },
  {
    backend: "bulk-plpgsql-artifact" as const,
    expectedStatus: 200,
  },
])("write api deferred FK behavior — $backend", ({ backend, expectedStatus }) => {
  let server!: ReturnType<typeof createSyncServer<typeof fkSyncRegistry>>;

  beforeAll(async () => {
    if (backend === "bulk-plpgsql-artifact") {
      const provisioningServer = createSyncServer({
        registry: fkSyncRegistry,
        databaseUrl: env.databaseUrl,
      });

      try {
        await installPlpgsqlBatchFunction(provisioningServer.drizzle, fkSyncRegistry);
      } finally {
        await provisioningServer.stop();
      }
    }

    server = createSyncServer({
      registry: fkSyncRegistry,
      databaseUrl: env.databaseUrl,
      backend,
    });

    await server.drizzle.execute(ensureFkTablesSql);
    await server.drizzle.execute(ensureFkConstraintDeferrableSql);
  });

  beforeEach(async () => {
    await server.drizzle.delete(fkChildrenTable);
    await server.drizzle.delete(fkParentsTable);
  });

  afterAll(async () => {
    await server.stop();
  });

  it("handles out-of-order parent/child creates in one batch", async () => {
    const parentId = "03ab3b8d-3bd8-4720-a17f-496ebd8bbfd2";
    const childId = "0f52156a-e97c-433e-93d1-346a32726195";

    const response = await server.request("/api/mutations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        mutations: [
          {
            tableName: "fk_children",
            entityKey: { id: childId },
            mutationId: "617f2f44-7293-4d74-ae6f-b56fe746e66f",
            mutationSeq: 1,
            kind: "create",
            payload: {
              id: childId,
              name: "Child created before parent",
              parent_id: parentId,
            },
            clientTimestampUs: String(Date.now() * 1000),
          },
          {
            tableName: "fk_parents",
            entityKey: { id: parentId },
            mutationId: "dc58f69d-ae89-48bf-87ea-6f7d4eca2104",
            mutationSeq: 2,
            kind: "create",
            payload: {
              id: parentId,
              name: "Deferred parent",
            },
            clientTimestampUs: String(Date.now() * 1000),
          },
        ],
      }),
    });

    expect(response.status).toBe(expectedStatus);

    const children = await server.drizzle.select().from(fkChildrenTable);
    const parents = await server.drizzle.select().from(fkParentsTable);

    if (backend === "bulk-plpgsql-artifact") {
      expect(children).toHaveLength(1);
      expect(parents).toHaveLength(1);
      expect(children[0]?.parentId).toBe(parentId);
      return;
    }

    expect(children).toHaveLength(0);
    expect(parents).toHaveLength(0);
  });
});

describe("write api artifact backend RLS auth context", () => {
  let server!: ReturnType<typeof createSyncServer<typeof rlsSyncRegistry>>;

  beforeAll(async () => {
    const provisioningServer = createSyncServer({
      registry: rlsSyncRegistry,
      databaseUrl: env.databaseUrl,
    });

    try {
      await installPlpgsqlBatchFunction(provisioningServer.drizzle, rlsSyncRegistry);
      await provisioningServer.drizzle.execute(ensureSupabaseAuthHelpersSql);
      await provisioningServer.drizzle.execute(ensureRlsTablesSql);
    } finally {
      await provisioningServer.stop();
    }

    server = createSyncServer({
      registry: rlsSyncRegistry,
      databaseUrl: env.databaseUrl,
      backend: "bulk-plpgsql-artifact",
      resolveAuthClaims: () => ({
        role: "authenticated",
        sub: "179e4f33-69ec-4f39-ba26-8f10c8ac8c9d",
      }),
    });
  });

  beforeEach(async () => {
    await server.drizzle.delete(rlsTodosTable);
  });

  afterAll(async () => {
    await server.stop();
  });

  it("returns 401 when claims are missing in RLS mode", async () => {
    const unauthorizedServer = createSyncServer({
      registry: rlsSyncRegistry,
      databaseUrl: env.databaseUrl,
      backend: "bulk-plpgsql-artifact",
      resolveAuthClaims: () => null,
    });

    try {
      const response = await unauthorizedServer.request("/api/mutations", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          mutations: [
            {
              tableName: "rls_todos",
              entityKey: { id: "f19304cb-0f85-4f7f-8f90-f30766f30796" },
              mutationId: "5ae8b852-c44e-454c-ae87-1a2f7ef5180e",
              mutationSeq: 1,
              kind: "create",
              payload: {
                id: "f19304cb-0f85-4f7f-8f90-f30766f30796",
                title: "unauthorized write",
              },
              clientTimestampUs: String(Date.now() * 1000),
            },
          ],
        }),
      });

      expect(response.status).toBe(401);
    } finally {
      await unauthorizedServer.stop();
    }
  });

  it("applies claims context so auth.uid defaults can be used", async () => {
    const id = "91e2a1e4-940f-4d4a-b61b-f0b89e0f24ce";
    const expectedOwnerId = "179e4f33-69ec-4f39-ba26-8f10c8ac8c9d";

    const response = await server.request("/api/mutations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        mutations: [
          {
            tableName: "rls_todos",
            entityKey: { id },
            mutationId: "89b1098c-d211-49ea-a2f4-7f179bfd6a01",
            mutationSeq: 1,
            kind: "create",
            payload: {
              id,
              title: "claim-propagated write",
            },
            clientTimestampUs: String(Date.now() * 1000),
          },
        ],
      }),
    });

    expect(response.status).toBe(200);

    const rows = await server.drizzle.select().from(rlsTodosTable).where(eq(rlsTodosTable.id, id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.ownerId).toBe(expectedOwnerId);
  });
});

describe("write api artifact backend missing governance prerequisites", () => {
  let server!: ReturnType<typeof createSyncServer<typeof demoSyncRegistry>>;

  beforeAll(async () => {
    const provisioningServer = createSyncServer({
      registry: demoSyncRegistry,
      databaseUrl: env.databaseUrl,
    });

    try {
      await provisioningServer.drizzle.execute(ensureTablesSql);
      await installPlpgsqlBatchFunction(provisioningServer.drizzle, demoSyncRegistry);
      await provisioningServer.drizzle.execute(sql`DROP SCHEMA IF EXISTS auth CASCADE`);
    } finally {
      await provisioningServer.stop();
    }

    server = createSyncServer({
      registry: demoSyncRegistry,
      databaseUrl: env.databaseUrl,
      backend: "bulk-plpgsql-artifact",
      resolveAuthClaims: (request) => {
        const claims = parseDemoAuthClaimsFromRequest(request);
        return claims ? { ...claims } : null;
      },
    });
  });

  afterAll(async () => {
    await server.stop();
  });

  it("returns a clear error when governance auth helpers are missing", async () => {
    const response = await postBatchMutations(
      server,
      [
        buildBatchMutation({
          tableName: "authors",
          entityKey: { id: "1d28e420-2fe6-4507-9730-13cd0a483428" },
          mutationId: "6e8f9d98-cc8e-497f-bef9-e113640a8af4",
          mutationSeq: 1,
          kind: "create",
          payload: {
            id: "1d28e420-2fe6-4507-9730-13cd0a483428",
            name: "missing-governance",
          },
        }),
      ],
      DEMO_JWT_USER1,
    );

    await expectResponseStatus(response, 500);
    expect(await response.json()).toEqual({
      message:
        "bulk-plpgsql-artifact backend with RLS-enabled tables requires governance SQL to be applied. Missing: auth.set_auth_context(jsonb), auth.uid(), auth.jwt(), auth.has_role(text). Run bun run db:apply:governance.",
    });
  });
});

describe("write api artifact backend demo auth RLS", () => {
  let server!: ReturnType<typeof createSyncServer<typeof demoSyncRegistry>>;

  const demoAdminId = "22222222-2222-4222-8222-222222222222";

  beforeAll(async () => {
    const provisioningServer = createSyncServer({
      registry: demoSyncRegistry,
      databaseUrl: env.databaseUrl,
    });

    try {
      await provisioningServer.drizzle.execute(ensureTablesSql);
      await executeSqlFile(
        provisioningServer.drizzle,
        "../../drizzle/20260416114759_registry_governance/migration.sql",
      );
      await executeSqlFile(provisioningServer.drizzle, "../../infra/sql/functions/pgxsinkit_apply_batch_mutations.sql");
    } finally {
      await provisioningServer.stop();
    }

    server = createSyncServer({
      registry: demoSyncRegistry,
      databaseUrl: env.databaseUrl,
      backend: "bulk-plpgsql-artifact",
      resolveAuthClaims: (request) => {
        const claims = parseDemoAuthClaimsFromRequest(request);
        return claims ? { ...claims } : null;
      },
    });
  });

  beforeEach(async () => {
    await server.drizzle.delete(todosTable);
    await server.drizzle.delete(authorsTable);
  });

  afterAll(async () => {
    await server.stop();
  });

  it("returns 401 when demo jwt claims are missing", async () => {
    const authorId = "61d8c828-5396-4f55-89c6-618b4265418d";

    const response = await postBatchMutations(server, [
      buildBatchMutation({
        tableName: "authors",
        entityKey: { id: authorId },
        mutationId: "fd08ac24-d188-45ca-a952-976620f65e5a",
        mutationSeq: 1,
        kind: "create",
        payload: {
          id: authorId,
          name: "unauthorized author",
        },
      }),
    ]);

    await expectResponseStatus(response, 401);
  });

  it("rejects non-batch CRUD writes in bulk-plpgsql-artifact mode", async () => {
    const createResponse = await server.request("/api/authors", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${DEMO_JWT_USER1}`,
      },
      body: JSON.stringify({
        id: "9531dc53-78c6-4e1e-a0a1-1db2b48e0127",
        name: "Should be rejected",
      }),
    });

    await expectResponseStatus(createResponse, 405);
    expect(await createResponse.json()).toEqual({
      message:
        "CRUD POST routes are disabled for authors when WRITE_API_BACKEND=bulk-plpgsql-artifact. Use POST /api/mutations instead.",
    });
  });

  it("applies owner and audit fields from demo jwt claims for authors and todos", async () => {
    const authorId = "d47ca275-c3b6-4906-a0db-b474dc3912d8";
    const todoId = "1c5304ca-c0db-4316-8665-ce3a1273540c";

    const response = await postBatchMutations(
      server,
      [
        buildBatchMutation({
          tableName: "authors",
          entityKey: { id: authorId },
          mutationId: "0d4ec6ec-47ad-43e5-915e-df3b44028671",
          mutationSeq: 1,
          kind: "create",
          payload: {
            id: authorId,
            name: "Owned author",
          },
        }),
        buildBatchMutation({
          tableName: "todos",
          entityKey: { id: todoId },
          mutationId: "d87c5918-55f3-45fd-b4b1-e8d624ed323e",
          mutationSeq: 2,
          kind: "create",
          payload: {
            id: todoId,
            title: "Owned todo",
            description: null,
            author_id: authorId,
            status: "todo",
            priority: "medium",
          },
        }),
      ],
      DEMO_JWT_USER1,
    );

    await expectResponseStatus(response, 200);
    const body = (await response.json()) as {
      acks: Array<{ mutationId: string; status: string; serverUpdatedAtUs?: string }>;
    };

    expect(body.acks).toHaveLength(2);
    expect(body.acks[0]?.status).toBe("acked");
    expect(body.acks[0]?.serverUpdatedAtUs).toMatch(/^[0-9]+$/);
    expect(body.acks[1]?.status).toBe("acked");
    expect(body.acks[1]?.serverUpdatedAtUs).toMatch(/^[0-9]+$/);

    const authors = await server.drizzle.select().from(authorsTable).where(eq(authorsTable.id, authorId));
    const todos = await server.drizzle.select().from(todosTable).where(eq(todosTable.id, todoId));

    expect(authors).toHaveLength(1);
    expect(authors[0]?.ownerId).toBe(DEMO_USER1_ID);
    expect(authors[0]?.modifiedBy).toBe(DEMO_USER1_ID);
    expect(authors[0]?.createdAtUs).toBeTypeOf("bigint");
    expect(authors[0]?.updatedAtUs).toBeTypeOf("bigint");
    expect(authors[0]?.updatedAtUs).toBeGreaterThanOrEqual(authors[0]?.createdAtUs ?? 0n);

    expect(todos).toHaveLength(1);
    expect(todos[0]?.ownerId).toBe(DEMO_USER1_ID);
    expect(todos[0]?.modifiedBy).toBe(DEMO_USER1_ID);
    expect(todos[0]?.createdAtUs).toBeTypeOf("bigint");
    expect(todos[0]?.updatedAtUs).toBeTypeOf("bigint");
    expect(todos[0]?.updatedAtUs).toBeGreaterThanOrEqual(todos[0]?.createdAtUs ?? 0n);
  });

  it("rejects client-supplied managed fields in artifact mode", async () => {
    const authorId = "f3e55040-1b89-4ea2-9983-b13074184e78";

    const response = await postBatchMutations(
      server,
      [
        buildBatchMutation({
          tableName: "authors",
          entityKey: { id: authorId },
          mutationId: "de76c555-659c-40be-af41-848a845d6f2c",
          mutationSeq: 1,
          kind: "create",
          payload: {
            id: authorId,
            name: "Managed field smuggling",
            owner_id: DEMO_USER1_ID,
            modified_by: DEMO_USER1_ID,
            created_at_us: "1",
            updated_at_us: "2",
          },
        }),
      ],
      DEMO_JWT_USER1,
    );

    await expectResponseStatus(response, 400);
    expect(await response.json()).toEqual({
      message:
        "Payload validation failed: authors/de76c555-659c-40be-af41-848a845d6f2c includes server-managed fields: ownerId, modifiedBy, createdAtUs, updatedAtUs",
    });
  });

  it("does not let a different non-admin user update another user's author", async () => {
    const authorId = "7c425722-7c85-406e-a67c-ee81f5d5d9d5";

    const createResponse = await postBatchMutations(
      server,
      [
        buildBatchMutation({
          tableName: "authors",
          entityKey: { id: authorId },
          mutationId: "52fdf7fe-6e6c-4576-a97f-67677a078783",
          mutationSeq: 1,
          kind: "create",
          payload: {
            id: authorId,
            name: "User-owned author",
          },
        }),
      ],
      DEMO_JWT_USER1,
    );

    await expectResponseStatus(createResponse, 200);

    const updateResponse = await postBatchMutations(
      server,
      [
        buildBatchMutation({
          tableName: "authors",
          entityKey: { id: authorId },
          mutationId: "92ed127f-6af3-4d0f-b861-a25407cc24c9",
          mutationSeq: 2,
          kind: "update",
          payload: {
            name: "Hijacked author",
          },
        }),
      ],
      DEMO_JWT_USER2,
    );

    await expectResponseStatus(updateResponse, 200);

    const authors = await server.drizzle.select().from(authorsTable).where(eq(authorsTable.id, authorId));

    expect(authors).toHaveLength(1);
    expect(authors[0]?.name).toBe("User-owned author");
    expect(authors[0]?.ownerId).toBe(DEMO_USER1_ID);
    expect(authors[0]?.modifiedBy).toBe(DEMO_USER1_ID);
  });

  it("allows admin to update another user's author and stamps modified_by", async () => {
    const authorId = "f9ef65bc-b4c7-4a24-8aaf-dab754e66534";

    const createResponse = await postBatchMutations(
      server,
      [
        buildBatchMutation({
          tableName: "authors",
          entityKey: { id: authorId },
          mutationId: "820c07e8-acff-469a-9fb1-685bfc8fe208",
          mutationSeq: 1,
          kind: "create",
          payload: {
            id: authorId,
            name: "Admin-edit target",
          },
        }),
      ],
      DEMO_JWT_USER1,
    );

    await expectResponseStatus(createResponse, 200);

    const beforeUpdate = await server.drizzle.select().from(authorsTable).where(eq(authorsTable.id, authorId));
    expect(beforeUpdate).toHaveLength(1);
    const beforeUpdatedAtUs = beforeUpdate[0]?.updatedAtUs;

    const updateResponse = await postBatchMutations(
      server,
      [
        buildBatchMutation({
          tableName: "authors",
          entityKey: { id: authorId },
          mutationId: "677aa942-703e-4db8-9f67-69c6eb009aad",
          mutationSeq: 2,
          kind: "update",
          payload: {
            name: "Admin updated author",
          },
        }),
      ],
      DEMO_JWT_ADMIN,
    );

    await expectResponseStatus(updateResponse, 200);

    const authors = await server.drizzle.select().from(authorsTable).where(eq(authorsTable.id, authorId));

    expect(authors).toHaveLength(1);
    expect(authors[0]?.name).toBe("Admin updated author");
    expect(authors[0]?.ownerId).toBe(DEMO_USER1_ID);
    expect(authors[0]?.modifiedBy).toBe(demoAdminId);
    expect(authors[0]?.updatedAtUs).toBeTypeOf("bigint");
    expect(authors[0]?.updatedAtUs).toBeGreaterThan(beforeUpdatedAtUs ?? 0n);
  });
});

async function readOperationsLogRowCount(
  server: ReturnType<typeof createSyncServer<typeof demoSyncRegistry>>,
): Promise<number> {
  const result = await server.drizzle.execute<{ count: number }>(sql`
    SELECT COUNT(*)::int AS count
    FROM operations_log
  `);

  const firstRow = Array.from(result, (row) => row as { count: number })[0];
  return firstRow?.count ?? 0;
}

async function executeSqlFile(
  db: {
    execute: (query: ReturnType<typeof sql.raw>) => Promise<unknown>;
  },
  relativePath: string,
): Promise<void> {
  const statement = await readFile(new URL(relativePath, import.meta.url), "utf8");
  await db.execute(sql.raw(statement));
}

function buildBatchMutation(input: {
  tableName: string;
  entityKey: Record<string, string>;
  mutationId: string;
  mutationSeq: number;
  kind: "create" | "update" | "delete";
  payload: Record<string, unknown>;
}) {
  return {
    ...input,
    clientTimestampUs: String(Date.now() * 1000),
  };
}

async function postBatchMutations(
  server: ReturnType<typeof createSyncServer<typeof demoSyncRegistry>>,
  mutations: Array<ReturnType<typeof buildBatchMutation>>,
  authToken?: string,
) {
  return server.request("/api/mutations", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
    },
    body: JSON.stringify({ mutations }),
  });
}

async function expectResponseStatus(response: Response, expectedStatus: number): Promise<void> {
  const responseText = await response.clone().text();
  expect(response.status, responseText).toBe(expectedStatus);
}
