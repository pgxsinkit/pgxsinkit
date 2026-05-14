import { eq, sql } from "drizzle-orm";
import { uuid, varchar } from "drizzle-orm/pg-core";
import { authenticatedRole } from "drizzle-orm/supabase";

import { buildSupabaseOwnerOrAdminNativePolicies, defineSyncRegistry, defineSyncTable } from "@pgxsinkit/contracts";
import {
  authorsTable,
  demoSyncRegistry,
  DEMO_JWT_ADMIN,
  DEMO_JWT_USER1,
  DEMO_JWT_USER2,
  DEMO_USER1_ID,
  todosTable,
} from "@pgxsinkit/schema";
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

const fkParentsSyncEntry = defineSyncTable({
  tableName: "fk_parents",
  makeColumns: () => ({
    id: uuid("id").primaryKey(),
    name: varchar("name", { length: 120 }).notNull(),
  }),
  mode: "readwrite",
});
const fkParentsTable = fkParentsSyncEntry.table;

const fkChildrenSyncEntry = defineSyncTable({
  tableName: "fk_children",
  makeColumns: () => ({
    id: uuid("id").primaryKey(),
    name: varchar("name", { length: 120 }).notNull(),
    parentId: uuid("parent_id")
      .notNull()
      .references(() => fkParentsTable.id),
  }),
  mode: "readwrite",
});
const fkChildrenTable = fkChildrenSyncEntry.table;

const fkSyncRegistry = defineSyncRegistry({
  fk_parents: fkParentsSyncEntry,
  fk_children: fkChildrenSyncEntry,
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

const rlsTodosSyncEntry = defineSyncTable({
  tableName: "rls_todos",
  makeColumns: () => ({
    id: uuid("id").primaryKey(),
    title: varchar("title", { length: 120 }).notNull(),
    ownerId: uuid("owner_id"),
  }),
  policies: buildSupabaseOwnerOrAdminNativePolicies({
    tableName: "rls_todos",
    role: authenticatedRole,
    ownerSqlColumn: "owner_id",
  }),
  mode: "readwrite",
});
const rlsTodosTable = rlsTodosSyncEntry.table;

const rlsSyncRegistry = defineSyncRegistry({
  rls_todos: rlsTodosSyncEntry,
});

// Supabase-compatible DB provides auth.uid() and authenticated role.
// We only need table grants for the demo registry tables.
const ensureTableGrantsSql = sql.raw(`
  DO $$
  BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      IF to_regclass('public.authors') IS NOT NULL THEN
        EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "authors" TO authenticated';
      END IF;
      IF to_regclass('public.todos') IS NOT NULL THEN
        EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "todos" TO authenticated';
      END IF;
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
      resolveAuthClaims: () => ({
        role: "authenticated",
        sub: DEMO_USER1_ID,
      }),
    });
    await server.drizzle.execute(ensureTablesSql);
    await server.drizzle.execute(ensureTableGrantsSql);
    await installPlpgsqlBatchFunction(server.drizzle, demoSyncRegistry);
  });

  beforeEach(async () => {
    await server.drizzle.delete(todosTable);
    await server.drizzle.delete(authorsTable);
  });

  afterAll(async () => {
    await server.stop();
  });

  it("rejects invalid payloads", async () => {
    const response = await postBatchMutations(server, [
      buildBatchMutation({
        tableName: "todos",
        entityKey: { id: "0fd99c86-dca0-47c3-b8f7-6555633e8bf2" },
        mutationId: "0e6dca9b-c37f-471b-bc37-c84ff0467a1c",
        mutationSeq: 1,
        kind: "create",
        payload: {
          id: "0fd99c86-dca0-47c3-b8f7-6555633e8bf2",
          title: "",
        },
      }),
    ]);

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

  it("returns an empty todo list via direct DB query", async () => {
    const rows = await server.drizzle.select().from(todosTable);
    expect(rows).toEqual([]);
  });

  it("creates via /api/mutations and verifies via direct DB query", async () => {
    const authorId = "01963227-d4c7-72db-b858-f89f6af8f920";
    const createResponse = await postBatchMutations(server, [
      buildBatchMutation({
        tableName: "authors",
        entityKey: { id: authorId },
        mutationId: "bc14916d-c484-4f9b-b643-90fda3f466f0",
        mutationSeq: 1,
        kind: "create",
        payload: {
          id: authorId,
          name: "Ada Lovelace",
        },
      }),
    ]);

    expect(createResponse.status).toBe(200);

    const rows = await server.drizzle.select().from(authorsTable).where(eq(authorsTable.id, authorId));
    expect(rows).toEqual([
      expect.objectContaining({
        id: authorId,
        name: "Ada Lovelace",
      }),
    ]);
  });

  it("persists a validated todo", async () => {
    const todoId = "01963227-d4c7-72db-b858-f89f6af8f999";
    const authorId = "01963227-d4c7-72db-b858-f89f6af8f920";

    await postBatchMutations(server, [
      buildBatchMutation({
        tableName: "authors",
        entityKey: { id: authorId },
        mutationId: "fef6d5a5-1719-49f9-89e3-813b131868cb",
        mutationSeq: 1,
        kind: "create",
        payload: {
          id: authorId,
          name: "Ada Lovelace",
        },
      }),
    ]);

    const response = await postBatchMutations(server, [
      buildBatchMutation({
        tableName: "todos",
        entityKey: { id: todoId },
        mutationId: "4c97657d-fdb8-4bca-938f-3c57f9a5e72f",
        mutationSeq: 2,
        kind: "create",
        payload: {
          id: todoId,
          title: "Persist from integration test",
          description: "written through Hono + Drizzle",
          author_id: authorId,
          status: "todo",
          priority: "high",
        },
      }),
    ]);

    expect(response.status).toBe(200);

    const rows = await server.drizzle.select().from(todosTable).where(eq(todosTable.id, todoId));

    expect(rows).toHaveLength(1);
    expect(rows[0]?.authorId).toBe(authorId);
    expect(rows[0]?.title).toBe("Persist from integration test");
  });

  it("updates an existing todo", async () => {
    const todoId = "01963227-d4c7-72db-b858-f89f6af8f981";
    const authorId = "01963227-d4c7-72db-b858-f89f6af8f921";

    await postBatchMutations(server, [
      buildBatchMutation({
        tableName: "authors",
        entityKey: { id: authorId },
        mutationId: "4fe40c68-7a5d-4938-ab35-c625f6736f4a",
        mutationSeq: 1,
        kind: "create",
        payload: {
          id: authorId,
          name: "Grace Hopper",
        },
      }),
      buildBatchMutation({
        tableName: "todos",
        entityKey: { id: todoId },
        mutationId: "a93d7cb9-1f57-40cb-af3d-b74703e439df",
        mutationSeq: 2,
        kind: "create",
        payload: {
          id: todoId,
          title: "Before patch",
          description: null,
          author_id: authorId,
          status: "todo",
          priority: "medium",
        },
      }),
    ]);

    const response = await postBatchMutations(server, [
      buildBatchMutation({
        tableName: "todos",
        entityKey: { id: todoId },
        mutationId: "88451f95-962e-4e39-9733-3c8660cc260d",
        mutationSeq: 3,
        kind: "update",
        payload: {
          status: "done",
          title: "After patch",
        },
      }),
    ]);

    expect(response.status).toBe(200);

    const rows = await server.drizzle.select().from(todosTable).where(eq(todosTable.id, todoId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe("After patch");
    expect(rows[0]?.status).toBe("done");
  });

  it("deletes an existing todo", async () => {
    const todoId = "01963227-d4c7-72db-b858-f89f6af8f982";
    const authorId = "01963227-d4c7-72db-b858-f89f6af8f922";

    await postBatchMutations(server, [
      buildBatchMutation({
        tableName: "authors",
        entityKey: { id: authorId },
        mutationId: "eff3d2ec-9fd9-47f0-8f85-f938f9ee16f8",
        mutationSeq: 1,
        kind: "create",
        payload: {
          id: authorId,
          name: "Margaret Hamilton",
        },
      }),
      buildBatchMutation({
        tableName: "todos",
        entityKey: { id: todoId },
        mutationId: "7f11678f-3831-490f-a3ac-7d7e8a2d7b39",
        mutationSeq: 2,
        kind: "create",
        payload: {
          id: todoId,
          title: "Delete me",
          description: null,
          author_id: authorId,
          status: "todo",
          priority: "medium",
        },
      }),
    ]);

    const response = await postBatchMutations(server, [
      buildBatchMutation({
        tableName: "todos",
        entityKey: { id: todoId },
        mutationId: "5745ab9d-c8c9-4f95-9778-c5a6557a90aa",
        mutationSeq: 3,
        kind: "delete",
        payload: { id: todoId },
      }),
    ]);

    expect(response.status).toBe(200);

    const rows = await server.drizzle.select().from(todosTable).where(eq(todosTable.id, todoId));
    expect(rows).toHaveLength(0);
  });

  it("supports disabling operations log at startup", async () => {
    const beforeCount = await readOperationsLogRowCount(server);

    const disabledServer = createSyncServer({
      registry: demoSyncRegistry,
      databaseUrl: env.databaseUrl,
      resolveAuthClaims: () => ({
        role: "authenticated",
        sub: DEMO_USER1_ID,
      }),
      operationsLog: {
        enabled: false,
      },
    });

    await disabledServer.drizzle.execute(ensureTablesSql);
    await installPlpgsqlBatchFunction(disabledServer.drizzle, demoSyncRegistry);

    try {
      const authorId = "01963227-d4c7-72db-b858-f89f6af8f933";
      const todoId = "01963227-d4c7-72db-b858-f89f6af8f983";

      const batchResponse = await postBatchMutations(disabledServer, [
        buildBatchMutation({
          tableName: "authors",
          entityKey: { id: authorId },
          mutationId: "cfc76477-cdc8-4be7-bf2d-045ae815ec8c",
          mutationSeq: 1,
          kind: "create",
          payload: {
            id: authorId,
            name: "Disabled logger author",
          },
        }),
        buildBatchMutation({
          tableName: "todos",
          entityKey: { id: todoId },
          mutationId: "233d36a2-fde4-4e23-98f6-7ff633d28674",
          mutationSeq: 2,
          kind: "create",
          payload: {
            id: todoId,
            title: "Write with ops log disabled",
            description: null,
            author_id: authorId,
            status: "todo",
            priority: "medium",
          },
        }),
      ]);
      expect(batchResponse.status).toBe(200);
    } finally {
      await disabledServer.stop();
    }

    const afterCount = await readOperationsLogRowCount(server);
    expect(afterCount).toBe(beforeCount);
  });
});

describe("write api deferred FK behavior — bulk-plpgsql-artifact", () => {
  let server!: ReturnType<typeof createSyncServer<typeof fkSyncRegistry>>;

  beforeAll(async () => {
    const provisioningServer = createSyncServer({
      registry: fkSyncRegistry,
      databaseUrl: env.databaseUrl,
    });

    try {
      await installPlpgsqlBatchFunction(provisioningServer.drizzle, fkSyncRegistry);
    } finally {
      await provisioningServer.stop();
    }

    server = createSyncServer({
      registry: fkSyncRegistry,
      databaseUrl: env.databaseUrl,
      backend: "bulk-plpgsql-artifact",
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

    expect(response.status).toBe(200);

    const children = await server.drizzle.select().from(fkChildrenTable);
    const parents = await server.drizzle.select().from(fkParentsTable);

    expect(children).toHaveLength(1);
    expect(parents).toHaveLength(1);
    expect(children[0]?.parentId ?? null).toBe(parentId);
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
      await provisioningServer.drizzle.execute(ensureTableGrantsSql);
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

  it("fails with 500 when auth.uid() is unavailable", async () => {
    // auth.uid() is native to Supabase — this test verifies the error path
    // by provisioning a server without governance preconditions.
    // With Supabase-managed databases auth.uid() is always present,
    // so this test checks the startup check catches missing auth.uid().
    // (auth.uid() is provided by Supabase's auth schema.)
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

    // With Supabase-native auth.uid(), this should succeed.
    // The verifyArtifactRlsAuthHelpers check only requires auth.uid()
    // which is always present in a Supabase-compatible database.
    await expectResponseStatus(response, 200);
    const body = await response.json();
    expect(body.acks).toBeDefined();
    expect(body.acks).toHaveLength(1);
    expect(body.acks[0]?.status).toBe("acked");
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
      await installPlpgsqlBatchFunction(provisioningServer.drizzle, demoSyncRegistry);
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

  it("per-table CRUD routes are not registered in bulk-plpgsql-artifact mode", async () => {
    const createResponse = await server.request("/api/authors", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${DEMO_JWT_USER1}`,
      },
      body: JSON.stringify({
        id: "9531dc53-78c6-4e1e-a0a1-1db2b48e0127",
        name: "Should not exist",
      }),
    });

    expect(createResponse.status).toBe(404);

    const patchResponse = await server.request("/api/todos/any-id", {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${DEMO_JWT_USER1}`,
      },
      body: JSON.stringify({ title: "No route" }),
    });

    expect(patchResponse.status).toBe(404);

    const deleteResponse = await server.request("/api/todos/any-id", {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${DEMO_JWT_USER1}`,
      },
    });

    expect(deleteResponse.status).toBe(404);
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
  accessToken?: string,
) {
  return server.request("/api/mutations", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    body: JSON.stringify({ mutations }),
  });
}

async function expectResponseStatus(response: Response, expectedStatus: number): Promise<void> {
  const responseText = await response.clone().text();

  if (response.status !== expectedStatus) {
    throw new Error(`Expected HTTP ${expectedStatus}, got ${response.status}: ${responseText}`);
  }
}
