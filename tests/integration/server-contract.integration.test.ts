import { eq, sql } from "drizzle-orm";

import { createSyncServer } from "@pgxsinkit/server";
import { readIntegrationEnv } from "@pgxsinkit/test-utils";

import { installPlpgsqlBatchFunction } from "../../packages/server/src/mutations/bulk/plpgsql-strategy";
import {
  ensureProjectsTableSql,
  projectRecordSchema,
  projectsSyncRegistry,
  projectsTable,
} from "../fixtures/projects-fixture";

const env = readIntegrationEnv();

describe("server facade contract", () => {
  let server!: ReturnType<typeof createSyncServer<typeof projectsSyncRegistry>>;

  beforeAll(async () => {
    server = createSyncServer({
      registry: projectsSyncRegistry,
      databaseUrl: env.databaseUrl,
    });

    await server.drizzle.execute(ensureProjectsTableSql);
  });

  beforeEach(async () => {
    await server.drizzle.delete(projectsTable);
    await clearOperationsLog(server);
  });

  afterAll(async () => {
    await server.stop();
  });

  it("exposes diagnostics and serves health without starting a listener", async () => {
    expect(server.status.phase).toBe("ready");
    expect(server.status.isRunning).toBe(false);
    expect(server.address).toBeNull();
    expect(server.diagnostics()).toEqual({
      tables: ["projects"],
      modes: {
        projects: "readwrite",
      },
      routes: {
        projects: {
          basePath: "/api/projects",
          allowBatch: false,
        },
      },
    });

    const response = await server.fetch(new Request("http://localhost/health"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it("creates, lists, updates, and deletes through the public request facade", async () => {
    const createResponse = await server.request("/api/projects", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        id: "01965156-5884-7a0b-a24e-31b5c9be0010",
        name: "Server contract project",
      }),
    });

    expect(createResponse.status).toBe(201);
    const created = projectRecordSchema.parse(await createResponse.json());
    expect(created.name).toBe("Server contract project");

    const listResponse = await server.request("/api/projects");

    expect(listResponse.status).toBe(200);
    expect(await listResponse.json()).toEqual([
      expect.objectContaining({
        id: created.id,
        name: "Server contract project",
      }),
    ]);

    const updateResponse = await server.request(`/api/projects/${created.id}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "Renamed through facade",
      }),
    });

    expect(updateResponse.status).toBe(200);
    const updated = projectRecordSchema.parse(await updateResponse.json());
    expect(updated.name).toBe("Renamed through facade");

    const rows = await server.drizzle.select().from(projectsTable).where(eq(projectsTable.id, created.id));

    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe("Renamed through facade");

    const deleteResponse = await server.request(`/api/projects/${created.id}`, {
      method: "DELETE",
    });

    expect(deleteResponse.status).toBe(204);

    const remainingRows = await server.drizzle.select().from(projectsTable).where(eq(projectsTable.id, created.id));

    expect(remainingRows).toHaveLength(0);

    const logRows = await readOperationsLogRows(server);
    const successRows = logRows.filter(
      (row) =>
        row.backend === "drizzle" &&
        row.source === "crud" &&
        row.tableName === "projects" &&
        row.status === "succeeded",
    );
    expect(successRows).toHaveLength(3);
  });

  it("surfaces validation and missing-record errors through the public request facade", async () => {
    const invalidCreateResponse = await server.request("/api/projects", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        id: "01965156-5884-7a0b-a24e-31b5c9be0011",
        name: "",
      }),
    });

    expect(invalidCreateResponse.status).toBe(400);
    expect(await invalidCreateResponse.json()).toEqual(
      expect.objectContaining({
        message: "Validation failed",
      }),
    );

    const missingPatchResponse = await server.request("/api/projects/01965156-5884-7a0b-a24e-31b5c9be0012", {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "Never persisted",
      }),
    });

    expect(missingPatchResponse.status).toBe(404);
    expect(await missingPatchResponse.json()).toEqual({
      message: "projects record not found",
    });

    const missingDeleteResponse = await server.request("/api/projects/01965156-5884-7a0b-a24e-31b5c9be0012", {
      method: "DELETE",
    });

    expect(missingDeleteResponse.status).toBe(404);
    expect(await missingDeleteResponse.json()).toEqual({
      message: "projects record not found",
    });

    const logRows = await readOperationsLogRows(server);
    const validationFailures = logRows.filter(
      (row) =>
        row.backend === "drizzle" &&
        row.source === "crud" &&
        row.tableName === "projects" &&
        row.status === "validation_failed",
    );
    const notFoundRows = logRows.filter(
      (row) =>
        row.backend === "drizzle" &&
        row.source === "crud" &&
        row.tableName === "projects" &&
        row.status === "not_found",
    );

    expect(validationFailures).toHaveLength(1);
    expect(notFoundRows).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Bulk mutation backends
// ---------------------------------------------------------------------------

describe.each([
  { backend: "bulk-dynamic" as const },
  { backend: "bulk-pregenerated" as const },
  { backend: "bulk-plpgsql" as const },
  { backend: "bulk-plpgsql-artifact" as const },
])("server facade contract — $backend backend", ({ backend }) => {
  let server!: ReturnType<typeof createSyncServer<typeof projectsSyncRegistry>>;

  beforeAll(async () => {
    if (backend === "bulk-plpgsql-artifact") {
      const provisioningServer = createSyncServer({
        registry: projectsSyncRegistry,
        databaseUrl: env.databaseUrl,
      });

      try {
        await installPlpgsqlBatchFunction(provisioningServer.drizzle, projectsSyncRegistry);
      } finally {
        await provisioningServer.stop();
      }
    }

    server = createSyncServer({
      registry: projectsSyncRegistry,
      databaseUrl: env.databaseUrl,
      backend,
    });

    await server.drizzle.execute(ensureProjectsTableSql);
  });

  beforeEach(async () => {
    await server.drizzle.delete(projectsTable);
    await clearOperationsLog(server);
  });

  afterAll(async () => {
    await server.stop();
  });

  it("exposes health and diagnostics", async () => {
    const response = await server.fetch(new Request("http://localhost/health"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });

    const diagnostics = server.diagnostics();
    expect(diagnostics.tables).toContain("projects");
  });

  it("creates a row via POST /api/mutations", async () => {
    const id = "02000001-0000-4001-8001-000000000001";
    const response = await server.request("/api/mutations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mutations: [
          {
            tableName: "projects",
            entityKey: { id },
            mutationId: "12345678-1234-1234-8234-123456780001",
            mutationSeq: 1,
            kind: "create",
            payload: { id, name: "Bulk created project" },
            clientTimestampUs: String(Date.now() * 1000),
          },
        ],
      }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      acks: Array<{ status: string; mutationId: string }>;
    };
    expect(body.acks).toHaveLength(1);
    expect(body.acks[0]?.status).toBe("acked");

    const rows = await server.drizzle.select().from(projectsTable);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe("Bulk created project");

    const logRows = await readOperationsLogRows(server);
    const successRows = logRows.filter(
      (row) =>
        row.backend === backend &&
        row.source === "batch" &&
        row.tableName === "projects" &&
        row.operationKind === "create" &&
        row.status === "succeeded",
    );
    expect(successRows).toHaveLength(1);
  });

  it("updates a row via POST /api/mutations", async () => {
    const id = "02000001-0000-4002-8002-000000000002";

    // Insert directly so we have a row to update.
    await server.drizzle.insert(projectsTable).values({ id, name: "Before update" });

    const response = await server.request("/api/mutations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mutations: [
          {
            tableName: "projects",
            entityKey: { id },
            mutationId: "12345678-1234-1234-8234-123456780002",
            mutationSeq: 1,
            kind: "update",
            payload: { name: "After update" },
            clientTimestampUs: String(Date.now() * 1000),
          },
        ],
      }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { acks: Array<{ status: string }> };
    expect(body.acks[0]?.status).toBe("acked");

    const rows = await server.drizzle.select().from(projectsTable);
    expect(rows[0]?.name).toBe("After update");
  });

  it("deletes a row via POST /api/mutations", async () => {
    const id = "02000001-0000-4003-8003-000000000003";

    await server.drizzle.insert(projectsTable).values({ id, name: "To be deleted" });

    const response = await server.request("/api/mutations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mutations: [
          {
            tableName: "projects",
            entityKey: { id },
            mutationId: "12345678-1234-1234-8234-123456780003",
            mutationSeq: 1,
            kind: "delete",
            payload: { id },
            clientTimestampUs: String(Date.now() * 1000),
          },
        ],
      }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { acks: Array<{ status: string }> };
    expect(body.acks[0]?.status).toBe("acked");

    const rows = await server.drizzle.select().from(projectsTable);
    expect(rows).toHaveLength(0);
  });

  it("rejects CRUD write routes when using bulk-plpgsql-artifact", async () => {
    if (backend !== "bulk-plpgsql-artifact") {
      return;
    }

    const createResponse = await server.request("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "02000001-0000-4006-8006-000000000006",
        name: "Should be rejected",
      }),
    });

    expect(createResponse.status).toBe(405);
    expect(await createResponse.json()).toEqual({
      message:
        "CRUD POST routes are disabled for projects when WRITE_API_BACKEND=bulk-plpgsql-artifact. Use POST /api/mutations instead.",
    });

    await server.drizzle.insert(projectsTable).values({
      id: "02000001-0000-4007-8007-000000000007",
      name: "Existing row",
    });

    const patchResponse = await server.request("/api/projects/02000001-0000-4007-8007-000000000007", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Rejected patch" }),
    });

    expect(patchResponse.status).toBe(405);
    expect(await patchResponse.json()).toEqual({
      message:
        "CRUD PATCH routes are disabled for projects when WRITE_API_BACKEND=bulk-plpgsql-artifact. Use POST /api/mutations instead.",
    });

    const deleteResponse = await server.request("/api/projects/02000001-0000-4007-8007-000000000007", {
      method: "DELETE",
    });

    expect(deleteResponse.status).toBe(405);
    expect(await deleteResponse.json()).toEqual({
      message:
        "CRUD DELETE routes are disabled for projects when WRITE_API_BACKEND=bulk-plpgsql-artifact. Use POST /api/mutations instead.",
    });
  });

  it("returns 400 for an unknown table name", async () => {
    const response = await server.request("/api/mutations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mutations: [
          {
            tableName: "nonexistent_table",
            entityKey: { id: "02000001-0000-4099-8099-000000000099" },
            mutationId: "12345678-1234-1234-8234-123456780099",
            mutationSeq: 1,
            kind: "create",
            payload: {},
            clientTimestampUs: String(Date.now() * 1000),
          },
        ],
      }),
    });

    expect(response.status).toBe(400);

    const logRows = await readOperationsLogRows(server);
    const validationFailures = logRows.filter(
      (row) =>
        row.backend === backend &&
        row.source === "batch" &&
        row.tableName === "nonexistent_table" &&
        row.status === "validation_failed",
    );
    expect(validationFailures).toHaveLength(1);
  });

  it("rolls back all mutations when one fails (cross-table atomicity)", async () => {
    // Both mutations target 'projects' — the second one has a deliberately bad
    // table name to force a server-side error, proving the first is rolled back.
    const id = "02000001-0000-4004-8004-000000000004";

    const response = await server.request("/api/mutations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mutations: [
          {
            tableName: "projects",
            entityKey: { id },
            mutationId: "12345678-1234-1234-8234-123456780004",
            mutationSeq: 1,
            kind: "create",
            payload: { id, name: "Should roll back" },
            clientTimestampUs: String(Date.now() * 1000),
          },
          // The extra `created_at_us` field passes Zod (not in createSchema) but
          // causes a DB-level cast error ('not-a-bigint'::bigint), forcing a rollback.
          {
            tableName: "projects",
            entityKey: { id: "02000001-0000-4005-8005-000000000005" },
            mutationId: "12345678-1234-1234-8234-123456780005",
            mutationSeq: 1,
            kind: "create",
            payload: {
              id: "02000001-0000-4005-8005-000000000005",
              name: "OK",
              created_at_us: "not-a-bigint",
            },
            clientTimestampUs: String(Date.now() * 1000),
          },
        ],
      }),
    });

    // Server should return 500 from the transaction error.
    expect(response.status).toBe(500);

    // First row must NOT have been committed (transaction rolled back).
    const rows = await server.drizzle.select().from(projectsTable);
    expect(rows).toHaveLength(0);

    const logRows = await readOperationsLogRows(server);
    const successRows = logRows.filter(
      (row) =>
        row.backend === backend && row.source === "batch" && row.tableName === "projects" && row.status === "succeeded",
    );
    const executionFailures = logRows.filter(
      (row) =>
        row.backend === backend &&
        row.source === "batch" &&
        row.tableName === "projects" &&
        row.status === "execution_failed",
    );

    expect(successRows).toHaveLength(0);
    expect(executionFailures).toHaveLength(2);
  });
});

type OpsLogRow = {
  source: string;
  backend: string;
  tableName: string | null;
  operationKind: string | null;
  status: string;
};

async function clearOperationsLog(server: ReturnType<typeof createSyncServer<typeof projectsSyncRegistry>>) {
  await server.drizzle.execute(
    sql.raw(`
    DO $$
    BEGIN
      IF to_regclass('public.operations_log') IS NOT NULL THEN
        TRUNCATE TABLE operations_log;
      END IF;
    END $$;
  `),
  );
}

async function readOperationsLogRows(
  server: ReturnType<typeof createSyncServer<typeof projectsSyncRegistry>>,
): Promise<OpsLogRow[]> {
  const result = await server.drizzle.execute<OpsLogRow>(sql`
    SELECT
      source,
      backend,
      table_name AS "tableName",
      operation_kind AS "operationKind",
      status
    FROM operations_log
    ORDER BY id ASC
  `);

  return Array.from(result, (row) => row as OpsLogRow);
}
