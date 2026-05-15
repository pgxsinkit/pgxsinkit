import { eq, sql } from "drizzle-orm";

import { createSyncServer } from "@pgxsinkit/server";
import { readIntegrationEnv } from "@pgxsinkit/test-utils";

import { installPlpgsqlBatchFunction } from "../../packages/server/src/mutations/bulk/plpgsql-strategy";
import { ensureProjectsTableSql, projectsSyncRegistry, projectsTable } from "../fixtures/projects-fixture";

const env = readIntegrationEnv();

describe("server facade contract", () => {
  let server!: ReturnType<typeof createSyncServer<typeof projectsSyncRegistry>>;

  beforeAll(async () => {
    const provisioningServer = createSyncServer({
      registry: projectsSyncRegistry,
      databaseUrl: env.databaseUrl,
    });

    try {
      await installPlpgsqlBatchFunction(provisioningServer.drizzle, projectsSyncRegistry);
    } finally {
      await provisioningServer.stop();
    }

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
    });

    const response = await server.fetch(new Request("http://localhost/health"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it("creates, updates, and deletes via POST /api/mutations", async () => {
    const id = "02000001-0000-4001-8001-000000000001";

    const createResponse = await server.request("/api/mutations", {
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
            payload: { id, name: "Artifact-created project" },
            clientTimestampUs: String(Date.now() * 1000),
          },
        ],
      }),
    });

    expect(createResponse.status).toBe(200);
    expect(await createResponse.json()).toEqual({
      acks: [
        expect.objectContaining({
          mutationId: "12345678-1234-1234-8234-123456780001",
          status: "acked",
        }),
      ],
    });

    const updateResponse = await server.request("/api/mutations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mutations: [
          {
            tableName: "projects",
            entityKey: { id },
            mutationId: "12345678-1234-1234-8234-123456780002",
            mutationSeq: 2,
            kind: "update",
            payload: { name: "Artifact-updated project" },
            clientTimestampUs: String(Date.now() * 1000),
          },
        ],
      }),
    });

    expect(updateResponse.status).toBe(200);

    const rowsAfterUpdate = await server.drizzle.select().from(projectsTable).where(eq(projectsTable.id, id));
    expect(rowsAfterUpdate).toHaveLength(1);
    expect(rowsAfterUpdate[0]?.name).toBe("Artifact-updated project");

    const deleteResponse = await server.request("/api/mutations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mutations: [
          {
            tableName: "projects",
            entityKey: { id },
            mutationId: "12345678-1234-1234-8234-123456780003",
            mutationSeq: 3,
            kind: "delete",
            payload: { id },
            clientTimestampUs: String(Date.now() * 1000),
          },
        ],
      }),
    });

    expect(deleteResponse.status).toBe(200);

    const remainingRows = await server.drizzle.select().from(projectsTable).where(eq(projectsTable.id, id));
    expect(remainingRows).toHaveLength(0);

    const logRows = await readOperationsLogRows(server);
    const successRows = logRows.filter(
      (row) =>
        row.backend === "bulk-plpgsql-artifact" &&
        row.source === "batch" &&
        row.tableName === "projects" &&
        row.status === "succeeded",
    );
    expect(successRows).toHaveLength(3);
  });

  it("accepts the functions batch mutation alias", async () => {
    const id = "02000001-0000-4001-8001-000000000021";

    const response = await server.request("/mutations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mutations: [
          {
            tableName: "projects",
            entityKey: { id },
            mutationId: "12345678-1234-1234-8234-123456780021",
            mutationSeq: 1,
            kind: "create",
            payload: { id, name: "Functions-route project" },
            clientTimestampUs: String(Date.now() * 1000),
          },
        ],
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      acks: [
        expect.objectContaining({
          mutationId: "12345678-1234-1234-8234-123456780021",
          status: "acked",
        }),
      ],
    });
  });

  it("accepts ISO timestamp strings in /api/mutations payloads", async () => {
    const id = "02000001-0000-4001-8001-000000000031";
    const createdAt = "2026-05-15T10:11:12.345Z";
    const updatedAt = "2026-05-16T11:12:13.456Z";

    const createResponse = await server.request("/api/mutations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mutations: [
          {
            tableName: "projects",
            entityKey: { id },
            mutationId: "12345678-1234-1234-8234-123456780031",
            mutationSeq: 1,
            kind: "create",
            payload: {
              id,
              name: "Timestamp-coerced project",
              scheduled_at: createdAt,
            },
            clientTimestampUs: String(Date.now() * 1000),
          },
        ],
      }),
    });

    expect(createResponse.status).toBe(200);

    const updateResponse = await server.request("/api/mutations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mutations: [
          {
            tableName: "projects",
            entityKey: { id },
            mutationId: "12345678-1234-1234-8234-123456780032",
            mutationSeq: 2,
            kind: "update",
            payload: {
              scheduled_at: updatedAt,
            },
            clientTimestampUs: String(Date.now() * 1000),
          },
        ],
      }),
    });

    expect(updateResponse.status).toBe(200);

    const rows = await server.drizzle.select().from(projectsTable).where(eq(projectsTable.id, id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.scheduledAt?.toISOString()).toBe(updatedAt);
  });

  it("per-table CRUD routes are not registered — all writes go through /api/mutations", async () => {
    const createResponse = await server.request("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "02000001-0000-4006-8006-000000000006",
        name: "Should not exist",
      }),
    });

    expect(createResponse.status).toBe(404);

    await server.drizzle.insert(projectsTable).values({
      id: "02000001-0000-4007-8007-000000000007",
      name: "Existing row",
    });

    const patchResponse = await server.request("/api/projects/02000001-0000-4007-8007-000000000007", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "No route" }),
    });

    expect(patchResponse.status).toBe(404);

    const deleteResponse = await server.request("/api/projects/02000001-0000-4007-8007-000000000007", {
      method: "DELETE",
    });

    expect(deleteResponse.status).toBe(404);

    const listResponse = await server.request("/api/projects");
    expect(listResponse.status).toBe(404);
  });

  it("returns 400 for unknown table names", async () => {
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
        row.backend === "bulk-plpgsql-artifact" &&
        row.source === "batch" &&
        row.tableName === "nonexistent_table" &&
        row.status === "validation_failed",
    );
    expect(validationFailures).toHaveLength(1);
  });

  it("rolls back all mutations when one fails", async () => {
    const response = await server.request("/api/mutations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mutations: [
          {
            tableName: "projects",
            entityKey: { id: "02000001-0000-4004-8004-000000000004" },
            mutationId: "12345678-1234-1234-8234-123456780004",
            mutationSeq: 1,
            kind: "create",
            payload: { id: "02000001-0000-4004-8004-000000000004", name: "Should roll back" },
            clientTimestampUs: String(Date.now() * 1000),
          },
          {
            tableName: "projects",
            entityKey: { id: "02000001-0000-4005-8005-000000000005" },
            mutationId: "12345678-1234-1234-8234-123456780005",
            mutationSeq: 2,
            kind: "create",
            payload: {
              id: "02000001-0000-4005-8005-000000000005",
              name: "Invalid row",
              created_at_us: "not-a-bigint",
            },
            clientTimestampUs: String(Date.now() * 1000),
          },
        ],
      }),
    });

    expect(response.status).toBe(400);

    const rows = await server.drizzle.select().from(projectsTable);
    expect(rows).toHaveLength(0);
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
