import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";

import { asc, eq } from "drizzle-orm";

import { projectsSyncRegistry, projectsTable } from "@pgxsinkit/schema";
import { createSyncServer, operationsLogTable } from "@pgxsinkit/server";
import { createServerDb, readIntegrationEnv } from "@pgxsinkit/test-utils";

import { installPlpgsqlBatchFunction } from "../../packages/server/src/mutations/plpgsql-apply";

const env = readIntegrationEnv();

describe("server facade contract", () => {
  let server!: ReturnType<typeof createSyncServer<typeof projectsSyncRegistry>>;
  const serverDb = createServerDb(projectsSyncRegistry, env.databaseUrl);

  beforeAll(async () => {
    const provisioningServer = createSyncServer({
      registry: projectsSyncRegistry,
      db: serverDb.db,
    });

    try {
      await installPlpgsqlBatchFunction(provisioningServer.drizzle, projectsSyncRegistry);
    } finally {
      await provisioningServer.stop();
    }

    server = createSyncServer({
      registry: projectsSyncRegistry,
      db: serverDb.db,
    });
  });

  beforeEach(async () => {
    await server.drizzle.delete(projectsTable);
    await clearOperationsLog(server);
  });

  afterAll(async () => {
    await server.stop();
    await serverDb.close();
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
            payload: { id, name: "Created project" },
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
            payload: { name: "Updated project" },
            clientTimestampUs: String(Date.now() * 1000),
          },
        ],
      }),
    });

    expect(updateResponse.status).toBe(200);

    const rowsAfterUpdate = await server.drizzle.select().from(projectsTable).where(eq(projectsTable.id, id));
    expect(rowsAfterUpdate).toHaveLength(1);
    expect(rowsAfterUpdate[0]?.name).toBe("Updated project");

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
    const successRows = logRows.filter((row) => row.tableName === "projects" && row.status === "succeeded");
    expect(successRows).toHaveLength(3);
  });

  it("does not expose a /mutations alias", async () => {
    const response = await server.request("/mutations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mutations: [] }),
    });

    expect(response.status).toBe(404);
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
      (row) => row.tableName === "nonexistent_table" && row.status === "validation_failed",
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

    // The 400 attributes the failure to the invalid (second) mutation only, so the client can
    // quarantine exactly it and keep the valid sibling retryable.
    const body = (await response.json()) as { rejections?: Array<{ mutationId: string }> };
    expect(body.rejections?.map((rejection) => rejection.mutationId)).toEqual(["12345678-1234-1234-8234-123456780005"]);

    const rows = await server.drizzle.select().from(projectsTable);
    expect(rows).toHaveLength(0);
  });
});

type OpsLogRow = {
  tableName: string | null;
  operationKind: string | null;
  status: string;
};

async function clearOperationsLog(server: ReturnType<typeof createSyncServer<typeof projectsSyncRegistry>>) {
  await server.drizzle.delete(operationsLogTable);
}

async function readOperationsLogRows(
  server: ReturnType<typeof createSyncServer<typeof projectsSyncRegistry>>,
): Promise<OpsLogRow[]> {
  return await server.drizzle
    .select({
      tableName: operationsLogTable.tableName,
      operationKind: operationsLogTable.operationKind,
      status: operationsLogTable.status,
    })
    .from(operationsLogTable)
    .orderBy(asc(operationsLogTable.id));
}
