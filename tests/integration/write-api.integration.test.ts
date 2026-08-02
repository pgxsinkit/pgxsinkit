import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";

import { asc, count, eq, sql } from "drizzle-orm";
import { bigint, jsonb, uuid, varchar } from "drizzle-orm/pg-core";

import { defineSyncRegistry, defineSyncTable } from "@pgxsinkit/contracts";
import {
  authorsTable,
  demoSyncRegistry,
  DEMO_JWT_ADMIN,
  DEMO_JWT_USER1,
  DEMO_JWT_USER2,
  DEMO_USER1_ID,
  fkChildrenTable,
  fkParentsTable,
  fkSyncRegistry,
  rlsSyncRegistry,
  rlsTodosTable,
  todosTable,
} from "@pgxsinkit/schema";
import { createSyncServer, operationsLogRegclassTarget, operationsLogTable } from "@pgxsinkit/server";
import { createServerDb, readIntegrationEnv } from "@pgxsinkit/test-utils";

import { parseDemoAuthClaimsFromRequest } from "../../apps/write-api/src/demo-auth";
import { installPlpgsqlBatchFunction } from "../../packages/server/src/mutations/plpgsql-apply";
import { createTablesFromSchema } from "../support/drizzle";

const env = readIntegrationEnv();

describe("write api implementation integration", () => {
  let server!: ReturnType<typeof createSyncServer<typeof demoSyncRegistry>>;
  const serverDb = createServerDb(demoSyncRegistry, env.databaseUrl);

  beforeAll(async () => {
    server = createSyncServer({
      registry: demoSyncRegistry,
      db: serverDb.db,
      resolveAuthClaims: () => ({
        role: "authenticated",
        sub: DEMO_USER1_ID,
      }),
    });
    await installPlpgsqlBatchFunction(server.drizzle, demoSyncRegistry);
  });

  beforeEach(async () => {
    await server.drizzle.delete(todosTable);
    await server.drizzle.delete(authorsTable);
  });

  afterAll(async () => {
    await server.stop();
    await serverDb.close();
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

  it("allows the apikey header in the preflight (a deployment gateway sends it alongside Authorization)", async () => {
    // Regression: a Supabase-style client sends `apikey` on every request; a preflight that does not
    // allow it blocks the write path entirely (browser "Request header field apikey is not allowed").
    const response = await server.request("/api/todos", {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:5173",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization,apikey",
      },
    });

    expect(response.headers.get("Access-Control-Allow-Headers")?.toLowerCase()).toContain("apikey");
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
      db: serverDb.db,
      resolveAuthClaims: () => ({
        role: "authenticated",
        sub: DEMO_USER1_ID,
      }),
      operationsLog: {
        enabled: false,
      },
    });

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

  it("applies a multi-row, multi-(table,kind,column-set) batch set-based (ADR-0014 Phase 4)", async () => {
    const a1 = "0196322c-0000-7000-8000-0000000000a1";
    const a2 = "0196322c-0000-7000-8000-0000000000a2";
    const a3 = "0196322c-0000-7000-8000-0000000000a3";
    const t1 = "0196322c-0000-7000-8000-0000000000b1";
    const t2 = "0196322c-0000-7000-8000-0000000000b2";

    // Batch 1: three authors (one set-based INSERT of 3 rows) + two todos (a second set-based INSERT).
    // Each table has its own mutation sequence, so both groups start at 1. The submitted array order,
    // rather than those table-local sequences, must keep the author group before its dependent todos.
    const createResponse = await postBatchMutations(server, [
      buildBatchMutation({
        tableName: "authors",
        entityKey: { id: a1 },
        mutationId: "0196322c-0000-4000-8000-0000000000c1",
        mutationSeq: 1,
        kind: "create",
        payload: { id: a1, name: "Author One" },
      }),
      buildBatchMutation({
        tableName: "authors",
        entityKey: { id: a2 },
        mutationId: "0196322c-0000-4000-8000-0000000000c2",
        mutationSeq: 2,
        kind: "create",
        payload: { id: a2, name: "Author Two" },
      }),
      buildBatchMutation({
        tableName: "authors",
        entityKey: { id: a3 },
        mutationId: "0196322c-0000-4000-8000-0000000000c3",
        mutationSeq: 3,
        kind: "create",
        payload: { id: a3, name: "Author Three" },
      }),
      buildBatchMutation({
        tableName: "todos",
        entityKey: { id: t1 },
        mutationId: "0196322c-0000-4000-8000-0000000000c4",
        mutationSeq: 1,
        kind: "create",
        payload: { id: t1, title: "T1", description: null, author_id: a1, status: "todo", priority: "low" },
      }),
      buildBatchMutation({
        tableName: "todos",
        entityKey: { id: t2 },
        mutationId: "0196322c-0000-4000-8000-0000000000c5",
        mutationSeq: 2,
        kind: "create",
        payload: { id: t2, title: "T2", description: null, author_id: a2, status: "todo", priority: "low" },
      }),
    ]);

    await expectResponseStatus(createResponse, 200);
    const createBody = (await createResponse.json()) as {
      acks: Array<{ status: string; serverUpdatedAtUs?: string }>;
    };
    expect(createBody.acks).toHaveLength(5);
    expect(createBody.acks.every((ack) => ack.status === "acked")).toBe(true);
    expect(createBody.acks.every((ack) => /^[0-9]+$/.test(ack.serverUpdatedAtUs ?? ""))).toBe(true);

    expect(await server.drizzle.select().from(authorsTable)).toHaveLength(3);
    const todosAfterCreate = await server.drizzle.select().from(todosTable);
    expect(todosAfterCreate).toHaveLength(2);
    for (const todo of todosAfterCreate) {
      // Managed fields stamped by the set-based INSERT, not read from payload.
      expect(todo.createdAtUs).toBeTypeOf("bigint");
      expect(todo.updatedAtUs).toBeTypeOf("bigint");
    }

    // Batch 2: two partial updates with DIFFERENT column-sets ({status} vs {priority, title}) — two
    // UPDATE groups — plus a delete. All set-based; each row's untouched columns must survive.
    const updateResponse = await postBatchMutations(server, [
      buildBatchMutation({
        tableName: "todos",
        entityKey: { id: t1 },
        mutationId: "0196322c-0000-4000-8000-0000000000c6",
        mutationSeq: 6,
        kind: "update",
        payload: { status: "done" },
      }),
      buildBatchMutation({
        tableName: "todos",
        entityKey: { id: t2 },
        mutationId: "0196322c-0000-4000-8000-0000000000c7",
        mutationSeq: 7,
        kind: "update",
        payload: { title: "T2-renamed", priority: "high" },
      }),
      buildBatchMutation({
        tableName: "authors",
        entityKey: { id: a3 },
        mutationId: "0196322c-0000-4000-8000-0000000000c8",
        mutationSeq: 8,
        kind: "delete",
        payload: { id: a3 },
      }),
    ]);

    await expectResponseStatus(updateResponse, 200);

    const t1Row = (await server.drizzle.select().from(todosTable).where(eq(todosTable.id, t1)))[0];
    const t2Row = (await server.drizzle.select().from(todosTable).where(eq(todosTable.id, t2)))[0];
    expect(t1Row?.status).toBe("done");
    expect(t1Row?.title).toBe("T1"); // untouched by the {status} group
    expect(t2Row?.title).toBe("T2-renamed");
    expect(t2Row?.priority).toBe("high");
    expect(t2Row?.status).toBe("todo"); // untouched by the {priority, title} group

    const remainingAuthors = await server.drizzle.select().from(authorsTable);
    expect(remainingAuthors.map((author) => author.id).sort()).toEqual([a1, a2].sort()); // a3 deleted
  });

  // ADR-0015 Phase 5: the interleave proof against real Postgres. An external write advances the row
  // BETWEEN a mutation's Base server version and its apply; the table's Conflict policy decides the
  // outcome. The applier ran via the regenerated sync-function migration (db:migrate) + the runtime
  // install, so this also proves the RETURNS TABLE function applies on a real database.
  it("reject-if-stale: an interleaving external write conflicts a stale write instead of clobbering it", async () => {
    const authorId = "01963227-d4c7-72db-b858-f89f6af8c001";
    const todoId = "01963227-d4c7-72db-b858-f89f6af8c002";

    await expectResponseStatus(
      await postBatchMutations(server, [
        buildBatchMutation({
          tableName: "authors",
          entityKey: { id: authorId },
          mutationId: "a1000000-0000-4000-8000-000000000001",
          mutationSeq: 1,
          kind: "create",
          payload: { id: authorId, name: "Author" },
        }),
      ]),
      200,
    );

    // Create the reject-if-stale todo and capture the Server version the first client now "sees".
    const createResponse = await postBatchMutations(server, [
      buildBatchMutation({
        tableName: "todos",
        entityKey: { id: todoId },
        mutationId: "a1000000-0000-4000-8000-000000000002",
        mutationSeq: 1,
        kind: "create",
        payload: { id: todoId, title: "original", author_id: authorId },
      }),
    ]);
    const baseVersion = (await readFirstAck(createResponse)).serverUpdatedAtUs;
    if (baseVersion === undefined) {
      throw new Error("create ack did not carry a Server version");
    }

    // An external writer (authored against the same base, so NOT itself stale) advances the row.
    const externalResponse = await postBatchMutations(server, [
      buildBatchMutation({
        tableName: "todos",
        entityKey: { id: todoId },
        mutationId: "a1000000-0000-4000-8000-000000000003",
        mutationSeq: 2,
        kind: "update",
        payload: { title: "external write" },
        baseServerVersion: baseVersion,
      }),
    ]);
    const externalAck = await readFirstAck(externalResponse);
    expect(externalAck.status).toBe("acked");
    const currentVersion = externalAck.serverUpdatedAtUs!;
    expect(BigInt(currentVersion)).toBeGreaterThan(BigInt(baseVersion));

    // A second client, still on the OLD base, submits its edit — the row has moved on: stale.
    const staleResponse = await postBatchMutations(server, [
      buildBatchMutation({
        tableName: "todos",
        entityKey: { id: todoId },
        mutationId: "a1000000-0000-4000-8000-000000000004",
        mutationSeq: 3,
        kind: "update",
        payload: { title: "stale write" },
        baseServerVersion: baseVersion,
      }),
    ]);
    expect(staleResponse.status).toBe(200);
    const staleAck = await readFirstAck(staleResponse);
    expect(staleAck.status).toBe("conflicted");
    expect(staleAck.serverUpdatedAtUs).toBe(currentVersion);
    expect(staleAck.conflictReason).toContain("reject-if-stale");

    // The row keeps the external writer's value — the stale write was NOT applied.
    const row = (await server.drizzle.select().from(todosTable).where(eq(todosTable.id, todoId)))[0];
    expect(row?.title).toBe("external write");
  });

  it("authoritative endpoint: applies a clean unit and acks every member with its Server version (ADR-0022)", async () => {
    const authorId = "01963227-d4c7-72db-b858-f89f6af8d001";

    const response = await postAuthoritativeUnit(
      server,
      [
        buildBatchMutation({
          tableName: "authors",
          entityKey: { id: authorId },
          mutationId: "b1000000-0000-4000-8000-000000000001",
          mutationSeq: 1,
          kind: "create",
          payload: { id: authorId, name: "Authoritative author" },
        }),
      ],
      "unit-ok",
    );

    expect(response.status).toBe(200);
    const ack = await readFirstAck(response);
    expect(ack.status).toBe("acked");
    expect(ack.serverUpdatedAtUs).toBeDefined();

    const rows = await server.drizzle.select().from(authorsTable).where(eq(authorsTable.id, authorId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe("Authoritative author");
  });

  it("authoritative endpoint: a constraint violation rejects the whole unit (not a 500) and rolls it back", async () => {
    const authorId = "01963227-d4c7-72db-b858-f89f6af8d002";

    await expectResponseStatus(
      await postAuthoritativeUnit(server, [
        buildBatchMutation({
          tableName: "authors",
          entityKey: { id: authorId },
          mutationId: "b1000000-0000-4000-8000-000000000010",
          mutationSeq: 1,
          kind: "create",
          payload: { id: authorId, name: "First" },
        }),
      ]),
      200,
    );

    // A second create with the SAME id violates the PK — a DB-enforced invariant. The authoritative path
    // turns the raised exception into a clean per-mutation `rejected` ack; the batch path would 500.
    const dupResponse = await postAuthoritativeUnit(server, [
      buildBatchMutation({
        tableName: "authors",
        entityKey: { id: authorId },
        mutationId: "b1000000-0000-4000-8000-000000000011",
        mutationSeq: 1,
        kind: "create",
        payload: { id: authorId, name: "Second" },
      }),
    ]);

    expect(dupResponse.status).toBe(200);
    const ack = await readFirstAck(dupResponse);
    expect(ack.status).toBe("rejected");
    expect(ack.rejectionReason).toBeDefined();
    // ADR-0022 §4: the client-facing reason is SANITISED — it must not leak the raw DB error internals
    // (constraint name, the offending key value/PII). Full detail stays in the operations log.
    expect(ack.rejectionReason).not.toContain("constraint");
    expect(ack.rejectionReason).not.toContain("duplicate key");
    expect(ack.rejectionReason).not.toContain(authorId);

    // The unit rolled back: the original row is untouched and there is no second row.
    const rows = await server.drizzle.select().from(authorsTable).where(eq(authorsTable.id, authorId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe("First");
  });

  it("authoritative endpoint: a stale member conflicts the atomic unit (overlay kept, nothing applied)", async () => {
    const authorId = "01963227-d4c7-72db-b858-f89f6af8d003";
    const todoId = "01963227-d4c7-72db-b858-f89f6af8d004";

    await expectResponseStatus(
      await postBatchMutations(server, [
        buildBatchMutation({
          tableName: "authors",
          entityKey: { id: authorId },
          mutationId: "b1000000-0000-4000-8000-000000000020",
          mutationSeq: 1,
          kind: "create",
          payload: { id: authorId, name: "Author" },
        }),
      ]),
      200,
    );

    const createResponse = await postBatchMutations(server, [
      buildBatchMutation({
        tableName: "todos",
        entityKey: { id: todoId },
        mutationId: "b1000000-0000-4000-8000-000000000021",
        mutationSeq: 1,
        kind: "create",
        payload: { id: todoId, title: "original", author_id: authorId },
      }),
    ]);
    const baseVersion = (await readFirstAck(createResponse)).serverUpdatedAtUs;
    if (baseVersion === undefined) {
      throw new Error("create ack did not carry a Server version");
    }

    // An external writer advances the row, so the next write authored against `baseVersion` is stale.
    await expectResponseStatus(
      await postBatchMutations(server, [
        buildBatchMutation({
          tableName: "todos",
          entityKey: { id: todoId },
          mutationId: "b1000000-0000-4000-8000-000000000022",
          mutationSeq: 2,
          kind: "update",
          payload: { title: "external write" },
          baseServerVersion: baseVersion,
        }),
      ]),
      200,
    );

    // The stale update goes through the AUTHORITATIVE endpoint: the atomic unit conflicts (overlay kept),
    // and — being atomic — applies nothing.
    const staleResponse = await postAuthoritativeUnit(server, [
      buildBatchMutation({
        tableName: "todos",
        entityKey: { id: todoId },
        mutationId: "b1000000-0000-4000-8000-000000000023",
        mutationSeq: 3,
        kind: "update",
        payload: { title: "stale write" },
        baseServerVersion: baseVersion,
      }),
    ]);

    expect(staleResponse.status).toBe(200);
    const staleAck = await readFirstAck(staleResponse);
    expect(staleAck.status).toBe("conflicted");
    expect(staleAck.conflictReason).toContain("reject-if-stale");

    const row = (await server.drizzle.select().from(todosTable).where(eq(todosTable.id, todoId)))[0];
    expect(row?.title).toBe("external write");
  });

  it("last-write-wins: a stale write is applied anyway — today's behaviour, now a named choice", async () => {
    const authorId = "01963227-d4c7-72db-b858-f89f6af8c003";

    const createResponse = await postBatchMutations(server, [
      buildBatchMutation({
        tableName: "authors",
        entityKey: { id: authorId },
        mutationId: "b1000000-0000-4000-8000-000000000001",
        mutationSeq: 1,
        kind: "create",
        payload: { id: authorId, name: "v0" },
      }),
    ]);
    const baseVersion = (await readFirstAck(createResponse)).serverUpdatedAtUs;
    if (baseVersion === undefined) {
      throw new Error("create ack did not carry a Server version");
    }

    const externalResponse = await postBatchMutations(server, [
      buildBatchMutation({
        tableName: "authors",
        entityKey: { id: authorId },
        mutationId: "b1000000-0000-4000-8000-000000000002",
        mutationSeq: 2,
        kind: "update",
        payload: { name: "external" },
        baseServerVersion: baseVersion,
      }),
    ]);
    expect((await readFirstAck(externalResponse)).status).toBe("acked");

    // A stale write on the old base: last-write-wins applies it (and acks), clobbering the external
    // write — the deliberate, named choice (no silent default).
    const staleResponse = await postBatchMutations(server, [
      buildBatchMutation({
        tableName: "authors",
        entityKey: { id: authorId },
        mutationId: "b1000000-0000-4000-8000-000000000003",
        mutationSeq: 3,
        kind: "update",
        payload: { name: "stale-but-applied" },
        baseServerVersion: baseVersion,
      }),
    ]);
    const staleAck = await readFirstAck(staleResponse);
    expect(staleAck.status).toBe("acked");

    const row = (await server.drizzle.select().from(authorsTable).where(eq(authorsTable.id, authorId)))[0];
    expect(row?.name).toBe("stale-but-applied");
  });
});

describe("write api deferred FK behavior", () => {
  let server!: ReturnType<typeof createSyncServer<typeof fkSyncRegistry>>;
  const serverDb = createServerDb(fkSyncRegistry, env.databaseUrl);

  beforeAll(async () => {
    const provisioningServer = createSyncServer({
      registry: fkSyncRegistry,
      db: serverDb.db,
    });

    try {
      await installPlpgsqlBatchFunction(provisioningServer.drizzle, fkSyncRegistry);
    } finally {
      await provisioningServer.stop();
    }

    server = createSyncServer({
      registry: fkSyncRegistry,
      db: serverDb.db,
    });
  });

  beforeEach(async () => {
    await server.drizzle.delete(fkChildrenTable);
    await server.drizzle.delete(fkParentsTable);
  });

  afterAll(async () => {
    await server.stop();
    await serverDb.close();
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

describe("write api RLS auth context", () => {
  let server!: ReturnType<typeof createSyncServer<typeof rlsSyncRegistry>>;
  const serverDb = createServerDb(rlsSyncRegistry, env.databaseUrl);

  beforeAll(async () => {
    const provisioningServer = createSyncServer({
      registry: rlsSyncRegistry,
      db: serverDb.db,
    });

    try {
      await installPlpgsqlBatchFunction(provisioningServer.drizzle, rlsSyncRegistry);
    } finally {
      await provisioningServer.stop();
    }

    server = createSyncServer({
      registry: rlsSyncRegistry,
      db: serverDb.db,
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
    await serverDb.close();
  });

  it("returns 401 when claims are missing in RLS mode", async () => {
    const unauthorizedServer = createSyncServer({
      registry: rlsSyncRegistry,
      db: serverDb.db,
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

  it("applies claims context so an authClaim default (owner_id from the sub claim) is stamped", async () => {
    const id = "91e2a1e4-940f-4d4a-b61b-f0b89e0f24ce";
    // owner_id is an authClaim managed field at claimPath ["sub"], so the applier stamps it from the
    // verified request claims — the same value `auth.uid()` would have read, now via one general path.
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

describe("write api missing governance prerequisites", () => {
  let server!: ReturnType<typeof createSyncServer<typeof demoSyncRegistry>>;
  const serverDb = createServerDb(demoSyncRegistry, env.databaseUrl);

  beforeAll(async () => {
    const provisioningServer = createSyncServer({
      registry: demoSyncRegistry,
      db: serverDb.db,
    });

    try {
      await installPlpgsqlBatchFunction(provisioningServer.drizzle, demoSyncRegistry);
    } finally {
      await provisioningServer.stop();
    }

    server = createSyncServer({
      registry: demoSyncRegistry,
      db: serverDb.db,
      resolveAuthClaims: (request) => {
        const claims = parseDemoAuthClaimsFromRequest(request);
        return claims ? { ...claims } : null;
      },
    });
  });

  afterAll(async () => {
    await server.stop();
    await serverDb.close();
  });

  it("stamps an authClaim owner from the sub claim and acks under Supabase-native RLS helpers", async () => {
    // `authors.owner_id` is an authClaim managed field (claimPath ["sub"]) — the applier stamps it from
    // the verified claims (no `auth.uid()` in the write path anymore). The table's RLS still uses
    // `auth.uid()`, which is native to Supabase, so the claim-stamped create applies and acks.
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
    // The verifyRlsAuthHelpers check only requires auth.uid()
    // which is always present in a Supabase-compatible database.
    await expectResponseStatus(response, 200);
    const body = (await response.json()) as { acks: Array<{ status?: string }> };
    expect(body.acks).toBeDefined();
    expect(body.acks).toHaveLength(1);
    expect(body.acks[0]?.status).toBe("acked");
  });
});

describe("write api demo auth RLS", () => {
  let server!: ReturnType<typeof createSyncServer<typeof demoSyncRegistry>>;
  const serverDb = createServerDb(demoSyncRegistry, env.databaseUrl);

  const demoAdminId = "22222222-2222-4222-8222-222222222222";

  beforeAll(async () => {
    const provisioningServer = createSyncServer({
      registry: demoSyncRegistry,
      db: serverDb.db,
    });

    try {
      await installPlpgsqlBatchFunction(provisioningServer.drizzle, demoSyncRegistry);
    } finally {
      await provisioningServer.stop();
    }

    server = createSyncServer({
      registry: demoSyncRegistry,
      db: serverDb.db,
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
    await serverDb.close();
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

  it("rejects client-supplied managed fields", async () => {
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
    const reason =
      "authors/de76c555-659c-40be-af41-848a845d6f2c includes server-managed fields: ownerId, modifiedBy, createdAtUs, updatedAtUs";
    expect(await response.json()).toEqual({
      message: `Payload validation failed: ${reason}`,
      // The 400 attributes the rejection to the offending mutation so the client can quarantine
      // exactly it and keep innocent siblings retryable.
      rejections: [
        {
          tableName: "authors",
          mutationId: "de76c555-659c-40be-af41-848a845d6f2c",
          mutationSeq: 1,
          reason,
        },
      ],
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

describe("write api tolerates a missing operations_log table", () => {
  // Regression (board dogfooding): operations_log is an *optional*, default-enabled feature. A
  // consumer that leaves it enabled but never creates the table (exactly the board's setup) must still
  // have writes succeed — the startup probe disables logging when the table is absent. The bug: the
  // probe's boolean was discarded, so the success-path log INSERT 500'd on the missing table and
  // rolled back every write. The suite shares one database (db:migrate runs once), so this drops the
  // table for the scenario and restores it afterwards for the later integration files.
  const serverDb = createServerDb(demoSyncRegistry, env.databaseUrl);
  let server!: ReturnType<typeof createSyncServer<typeof demoSyncRegistry>>;

  beforeAll(async () => {
    await serverDb.db.execute(sql`DROP TABLE IF EXISTS ${operationsLogTable}`);
    server = createSyncServer({
      registry: demoSyncRegistry,
      db: serverDb.db,
      resolveAuthClaims: () => ({ role: "authenticated", sub: DEMO_USER1_ID }),
      // operationsLog omitted → defaults to { enabled: true }, the board's configuration.
    });
    await installPlpgsqlBatchFunction(server.drizzle, demoSyncRegistry);
  });

  afterAll(async () => {
    // Restore the optional table (with its indexes) so the later integration files that share this
    // database keep logging — the DDL is generated from `operationsLogTable` itself, so there is no
    // hand-mirrored copy to drift. The beforeAll DROP in this describe guarantees absence, so the
    // generated bare `CREATE TABLE` (no IF NOT EXISTS) cannot collide.
    await createTablesFromSchema(serverDb.db, { operationsLogTable });
    await server.stop();
    await serverDb.close();
  });

  beforeEach(async () => {
    await serverDb.db.delete(todosTable);
    await serverDb.db.delete(authorsTable);
  });

  it("applies a write with operation logging silently disabled", async () => {
    const authorId = "01963227-d4c7-72db-b858-f89f6af8fa01";
    const todoId = "01963227-d4c7-72db-b858-f89f6af8fa02";

    const response = await postBatchMutations(server, [
      buildBatchMutation({
        tableName: "authors",
        entityKey: { id: authorId },
        mutationId: "0a111111-0000-4000-8000-000000000001",
        mutationSeq: 1,
        kind: "create",
        payload: { id: authorId, name: "No-ops-log author" },
      }),
      buildBatchMutation({
        tableName: "todos",
        entityKey: { id: todoId },
        mutationId: "0a111111-0000-4000-8000-000000000002",
        mutationSeq: 2,
        kind: "create",
        payload: {
          id: todoId,
          title: "Write without an operations_log table",
          description: null,
          author_id: authorId,
          status: "todo",
          priority: "medium",
        },
      }),
    ]);

    expect(response.status).toBe(200);

    const rows = await serverDb.db.select().from(todosTable).where(eq(todosTable.id, todoId));
    expect(rows).toHaveLength(1);

    // Degraded, not auto-created: the optional table is still absent. The probe target is derived
    // from the real pgTable (same identity the server's startup probe uses), bound as a parameter.
    const presence = await serverDb.db.execute<{ tableName: string | null }>(
      sql`SELECT to_regclass(${operationsLogRegclassTarget()})::text AS "tableName"`,
    );
    const presenceRow = Array.from(presence as Iterable<unknown>, (e) => e as { tableName: string | null })[0];
    expect(presenceRow?.tableName).toBeNull();
  });
});

describe("pgxsinkit_clock_us canonical microsecond clock", () => {
  const clockDb = createServerDb(demoSyncRegistry, env.databaseUrl);

  afterAll(async () => {
    await clockDb.close();
  });

  it("advances WITHIN a transaction (clock_timestamp, not now())", async () => {
    // Two stamps in ONE transaction separated by a 1ms pg_sleep. This is the DISCRIMINATING assertion:
    // under a now()/transaction_timestamp() clock both reads are frozen at tx start, so they would be
    // EQUAL despite the sleep; only clock_timestamp() advances mid-transaction, so the second stamp is
    // STRICTLY greater. (Two immediate stamps would be flaky — same microsecond — and would NOT catch a
    // now() regression, which is exactly the semantic this function is chosen to guarantee.)
    const { first, second } = await clockDb.db.transaction(async (tx) => {
      const before = await tx.execute<{ us: string }>(sql`SELECT public.pgxsinkit_clock_us()::text AS us`);
      await tx.execute(sql`SELECT pg_sleep(0.001)`);
      const after = await tx.execute<{ us: string }>(sql`SELECT public.pgxsinkit_clock_us()::text AS us`);
      const read = (result: unknown) => BigInt(Array.from(result as Iterable<{ us: string }>)[0]!.us);
      return { first: read(before), second: read(after) };
    });

    expect(second).toBeGreaterThan(first);
  });
});

// ADR-0054 + array columns in the write path. Both need the REAL installed function on a
// Supabase-shaped cluster: the ACL is invisible to a pure renderer test, and an array cast that is
// wrong dies at the DB, not in a payload builder. The scratch table is created by this suite (it is
// not part of the committed schema) and its registry is installed for the duration.
const arrayPrefsRegistry = defineSyncRegistry({
  arrayPrefs: defineSyncTable({
    tableName: "arrayPrefs",
    makeColumns: () => ({
      id: uuid("id").primaryKey(),
      label: varchar("label", { length: 120 }).notNull(),
      sourceIds: uuid("source_ids").array(),
      // A `jsonb[]`: the element is itself a JSON value, so the array cast must NOT go through
      // `jsonb_array_elements_text` (that strips the element's JSON quoting — the string "123" became
      // the NUMBER 123, and "hi" failed the cast outright). Cheap to carry here: the whole table is a
      // scratch table this suite creates.
      prefs: jsonb("prefs").array(),
      updatedAtUs: bigint("updated_at_us", { mode: "bigint" }).notNull().default(0n),
    }),
    mode: "readwrite",
    conflictPolicy: "last-write-wins",
    governance: {
      managedFields: [{ column: "updatedAtUs", applyOn: ["create", "update"], strategy: "nowMicroseconds" }],
    },
  }),
});

const arrayPrefsTable = arrayPrefsRegistry.arrayPrefs.table;

/** Every message down an error's `cause` chain, joined — drizzle wraps PG errors and buries the SQLSTATE text. */
function collectErrorChainText(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  while (current != null && parts.length < 10) {
    if (current instanceof Error) {
      parts.push(current.message);
      current = current.cause;
    } else {
      parts.push(typeof current === "string" ? current : (JSON.stringify(current) ?? "<unstringifiable>"));
      current = null;
    }
  }
  return parts.join(" | ");
}

describe("apply-function ACL + array columns (ADR-0054)", () => {
  let server!: ReturnType<typeof createSyncServer<typeof arrayPrefsRegistry>>;
  const serverDb = createServerDb(arrayPrefsRegistry, env.databaseUrl);

  const applySignature = "pgxsinkit_apply_mutations(jsonb,text,boolean,boolean,jsonb,text)";

  /** The fingerprint the CURRENTLY INSTALLED function is stamped with (ADR-0030 self-verification). */
  async function installedFingerprint(): Promise<string> {
    const result = await serverDb.db.execute<{ fingerprint: string | null }>(
      sql`SELECT obj_description(to_regprocedure(${`public.${applySignature}`})::oid, 'pg_proc') AS "fingerprint"`,
    );
    return Array.from(result as Iterable<{ fingerprint: string | null }>)[0]?.fingerprint ?? "";
  }

  /**
   * Call the installed function DIRECTLY as `authenticated` — the shape of the attack ADR-0054 closes:
   * a caller who reaches the function chooses its own `p_user_claims`, so the ACL is the only control.
   * `SET LOCAL ROLE` inside a transaction proves the ACL for a role the test session is a member of;
   * it is NOT a full PostgREST/HTTP auth path (there is none in this harness), and it does not need to
   * be — the privilege check Postgres runs on the function call is identical either way.
   */
  async function callAsRole(role: string, fingerprint: string): Promise<void> {
    await serverDb.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE ${sql.identifier(role)}`);
      await tx.execute(
        sql`SELECT * FROM pgxsinkit_apply_mutations(${JSON.stringify({ mutations: [] })}::text::jsonb, ${"/api/mutations"}, ${false}, ${false}, ${JSON.stringify({ sub: DEMO_USER1_ID, role })}::text::jsonb, ${fingerprint})`,
      );
    });
  }

  async function callAsAuthenticated(fingerprint: string): Promise<void> {
    await callAsRole("authenticated", fingerprint);
  }

  /** Does `role` hold EXECUTE on the installed apply function, per Postgres itself? */
  async function hasExecutePrivilege(role: string): Promise<boolean> {
    const result = await serverDb.db.execute<{ allowed: boolean }>(
      sql`SELECT has_function_privilege(${role}, ${`public.${applySignature}`}, 'EXECUTE') AS "allowed"`,
    );
    return Array.from(result as Iterable<{ allowed: boolean }>)[0]?.allowed === true;
  }

  beforeAll(async () => {
    const provisioningServer = createSyncServer({ registry: arrayPrefsRegistry, db: serverDb.db });

    try {
      await createTablesFromSchema(provisioningServer.drizzle, { arrayPrefsTable });
      await installPlpgsqlBatchFunction(provisioningServer.drizzle, arrayPrefsRegistry);
    } finally {
      await provisioningServer.stop();
    }

    server = createSyncServer({
      registry: arrayPrefsRegistry,
      db: serverDb.db,
      resolveAuthClaims: () => ({ role: "authenticated", sub: DEMO_USER1_ID }),
    });
  });

  beforeEach(async () => {
    await server.drizzle.delete(arrayPrefsTable);
  });

  afterAll(async () => {
    await server.stop();
    await serverDb.close();
  });

  it("refuses a direct call from `authenticated` — the default install grants EXECUTE to nobody", async () => {
    const fingerprint = await installedFingerprint();
    expect(fingerprint).not.toBe("");

    // 42501 insufficient_privilege, raised at call resolution — before any claim in p_user_claims is
    // read, which is exactly why the forged-claims RPC is closed rather than merely validated.
    const refusal = await callAsAuthenticated(fingerprint).then(
      () => null,
      (reason: unknown) => reason,
    );

    expect(refusal).not.toBeNull();
    // Drizzle wraps the Postgres error, and the wrapper's own message carries only the failed query
    // text — the 42501 lives down the `cause` chain, so match against every message in it.
    expect(collectErrorChainText(refusal)).toMatch(/permission denied for function/i);
  });

  it("admits `authenticated` only after an explicit grantExecuteTo install", async () => {
    // A granted role's forged claims are trusted BY DESIGN — the server is the component trusted to
    // verify claims before passing them, so the grant list is the write path's entire trust boundary
    // and must name only SERVER roles. `authenticated` here is the proof of the grant path, not advice.
    await installPlpgsqlBatchFunction(server.drizzle, arrayPrefsRegistry, { grantExecuteTo: ["authenticated"] });

    try {
      // The fingerprint moved with the ACL (it is inside the hashed body), so read it back rather than
      // reusing the ungranted one — passing a stale one would fail with PXS01, not with a privilege error.
      await callAsAuthenticated(await installedFingerprint());
    } finally {
      // Restore the owner-only artifact so this suite leaves the database as it found it.
      await installPlpgsqlBatchFunction(server.drizzle, arrayPrefsRegistry);
    }
  });

  it("revokes a grantee it cannot name — an inherited default-privilege grant — on the next install", async () => {
    // The exposure the named revokes could not close: a grant to a role the LIBRARY cannot enumerate.
    // A direct grant would not prove it (the artifact's own DROP FUNCTION clears those), so the grant
    // here is re-applied by the cluster at the CREATE inside every install — exactly how Supabase's
    // trio comes back, but under a name only this deployment knows.
    const scratchRole = "pgxsinkit_acl_scratch";

    await serverDb.db.execute(sql`DROP ROLE IF EXISTS ${sql.identifier(scratchRole)}`);
    await serverDb.db.execute(sql`CREATE ROLE ${sql.identifier(scratchRole)} NOLOGIN`);

    try {
      // A direct grant on the CURRENT install, to show the starting state is genuinely "granted".
      // (GRANT / ALTER DEFAULT PRIVILEGES have no Drizzle object form; the signature is the one raw
      // fragment, and every name goes through a typed identifier.)
      await serverDb.db.execute(
        sql`GRANT EXECUTE ON FUNCTION ${sql.raw(applySignature)} TO ${sql.identifier(scratchRole)}`,
      );
      expect(await hasExecutePrivilege(scratchRole)).toBe(true);

      // …and a default privilege, so the grant is RE-created by the install's own CREATE FUNCTION.
      await serverDb.db.execute(
        sql`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO ${sql.identifier(scratchRole)}`,
      );

      await installPlpgsqlBatchFunction(server.drizzle, arrayPrefsRegistry);

      // The converger enumerated the real grantees and revoked the one that is neither owner nor
      // allowlisted — a re-granted role does not survive an install.
      expect(await hasExecutePrivilege(scratchRole)).toBe(false);

      const refusal = await callAsRole(scratchRole, await installedFingerprint()).then(
        () => null,
        (reason: unknown) => reason,
      );
      expect(refusal).not.toBeNull();
      expect(collectErrorChainText(refusal)).toMatch(/permission denied for function/i);

      // An allowlisted role, inheriting the SAME default privilege, is deliberately kept.
      await installPlpgsqlBatchFunction(server.drizzle, arrayPrefsRegistry, { grantExecuteTo: [scratchRole] });
      expect(await hasExecutePrivilege(scratchRole)).toBe(true);
    } finally {
      await serverDb.db.execute(
        sql`ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM ${sql.identifier(scratchRole)}`,
      );
      // Back to the owner-only artifact first: the function must hold no grant to the role being dropped.
      await installPlpgsqlBatchFunction(server.drizzle, arrayPrefsRegistry);
      await serverDb.db.execute(sql`DROP ROLE IF EXISTS ${sql.identifier(scratchRole)}`);
    }
  });

  it("round-trips a write through an install in a custom --function-schema", async () => {
    // The generate flag was always honoured; the RUNTIME half is `applyFunctionSchema`, which both
    // reproduces the schema-qualified artifact's fingerprint AND qualifies the call this server makes.
    const functionSchema = "pgxsinkit_test_fns";
    await serverDb.db.execute(sql`CREATE SCHEMA IF NOT EXISTS ${sql.identifier(functionSchema)}`);

    const schemaServer = createSyncServer({
      registry: arrayPrefsRegistry,
      db: serverDb.db,
      resolveAuthClaims: () => ({ role: "authenticated", sub: DEMO_USER1_ID }),
      applyFunctionSchema: functionSchema,
    });

    try {
      await installPlpgsqlBatchFunction(schemaServer.drizzle, arrayPrefsRegistry, { functionSchema });

      const id = "9f10c3d2-0000-4000-8000-000000000001";
      const response = await schemaServer.request("/api/mutations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mutations: [
            buildBatchMutation({
              tableName: "arrayPrefs",
              entityKey: { id },
              mutationId: "9f10c3d2-0000-4000-8000-0000000000a1",
              mutationSeq: 1,
              kind: "create",
              payload: { id, label: "custom schema" },
            }),
          ],
        }),
      });

      await expectResponseStatus(response, 200);

      const rows = await schemaServer.drizzle.select().from(arrayPrefsTable).where(eq(arrayPrefsTable.id, id));
      expect(rows.map((row) => row.label)).toEqual(["custom schema"]);
    } finally {
      await schemaServer.stop();
      await serverDb.db.execute(sql`DROP SCHEMA IF EXISTS ${sql.identifier(functionSchema)} CASCADE`);
    }
  });

  it("round-trips an empty, a non-empty and a null uuid[] through create and update", async () => {
    const idEmpty = "6a52f7d0-0000-4000-8000-00000000000e";
    const idFull = "6a52f7d0-0000-4000-8000-00000000000f";
    const idNull = "6a52f7d0-0000-4000-8000-00000000000d";
    const first = "7b63a8e1-0000-4000-8000-000000000001";
    const second = "7b63a8e1-0000-4000-8000-000000000002";

    const created = await server.request("/api/mutations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mutations: [
          buildBatchMutation({
            tableName: "arrayPrefs",
            entityKey: { id: idEmpty },
            mutationId: "c1a0b6b4-0000-4000-8000-00000000000e",
            mutationSeq: 1,
            kind: "create",
            payload: { id: idEmpty, label: "empty", source_ids: [] },
          }),
          buildBatchMutation({
            tableName: "arrayPrefs",
            entityKey: { id: idFull },
            mutationId: "c1a0b6b4-0000-4000-8000-00000000000f",
            mutationSeq: 2,
            kind: "create",
            payload: { id: idFull, label: "full", source_ids: [second, first] },
          }),
          buildBatchMutation({
            tableName: "arrayPrefs",
            entityKey: { id: idNull },
            mutationId: "c1a0b6b4-0000-4000-8000-00000000000d",
            mutationSeq: 3,
            kind: "create",
            payload: { id: idNull, label: "null", source_ids: null },
          }),
        ],
      }),
    });

    await expectResponseStatus(created, 200);

    const afterCreate = await server.drizzle.select().from(arrayPrefsTable).orderBy(asc(arrayPrefsTable.label));
    expect(afterCreate.map((row) => [row.label, row.sourceIds])).toEqual([
      // An empty array is a VALUE the client meant to write, never NULL...
      ["empty", []],
      // ...element order is the client's array order...
      ["full", [second, first]],
      // ...and a JSON null is SQL NULL, matching the scalar cast's semantics.
      ["null", null],
    ]);

    const updated = await server.request("/api/mutations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mutations: [
          buildBatchMutation({
            tableName: "arrayPrefs",
            entityKey: { id: idEmpty },
            mutationId: "d2b1c7c5-0000-4000-8000-00000000000e",
            mutationSeq: 4,
            kind: "update",
            payload: { source_ids: [first] },
          }),
          buildBatchMutation({
            tableName: "arrayPrefs",
            entityKey: { id: idFull },
            mutationId: "d2b1c7c5-0000-4000-8000-00000000000f",
            mutationSeq: 5,
            kind: "update",
            payload: { source_ids: null },
          }),
          // An update that never mentions the array column must leave it alone.
          buildBatchMutation({
            tableName: "arrayPrefs",
            entityKey: { id: idNull },
            mutationId: "d2b1c7c5-0000-4000-8000-00000000000d",
            mutationSeq: 6,
            kind: "update",
            payload: { label: "still null" },
          }),
        ],
      }),
    });

    await expectResponseStatus(updated, 200);

    const afterUpdate = await server.drizzle.select().from(arrayPrefsTable).orderBy(asc(arrayPrefsTable.id));
    expect(afterUpdate.map((row) => [row.id, row.sourceIds])).toEqual([
      [idNull, null],
      [idEmpty, [first]],
      [idFull, null],
    ]);
  });

  it("round-trips a jsonb[] whose elements are JSON strings, objects and nulls", async () => {
    // The corruption this pins: a uniform `jsonb_array_elements_text` expansion strips each element's
    // JSON quoting, so the STRING "123" was stored as the NUMBER 123 (silent) and "hi" failed the cast
    // outright (loud). Both go through a real HTTP batch here, against the real installed function.
    const id = "8e07b2c1-0000-4000-8000-000000000001";
    const created = await server.request("/api/mutations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mutations: [
          buildBatchMutation({
            tableName: "arrayPrefs",
            entityKey: { id },
            mutationId: "8e07b2c1-0000-4000-8000-0000000000a1",
            mutationSeq: 1,
            kind: "create",
            payload: { id, label: "json prefs", prefs: ["123", "hi", { theme: "dark" }, null] },
          }),
        ],
      }),
    });

    await expectResponseStatus(created, 200);

    // Read the element TYPES from Postgres, not the driver's JS values: `"123"` and `123` both arrive
    // as truthy JS values, and only `jsonb_typeof` distinguishes the string from the number.
    const elementTypes = await serverDb.db.execute<{
      first: string;
      second: string;
      third: string;
      fourth: string;
      len: number;
    }>(
      sql`SELECT jsonb_typeof(prefs[1]) AS "first",
                 jsonb_typeof(prefs[2]) AS "second",
                 jsonb_typeof(prefs[3]) AS "third",
                 jsonb_typeof(prefs[4]) AS "fourth",
                 cardinality(prefs) AS "len"
          FROM ${arrayPrefsTable} WHERE ${eq(arrayPrefsTable.id, id)}`,
    );
    expect(Array.from(elementTypes as Iterable<unknown>)[0]).toMatchObject({
      first: "string",
      second: "string",
      third: "object",
      // A JSON null ELEMENT is preserved verbatim as a JSON null value, not collapsed to a SQL NULL.
      fourth: "null",
      len: 4,
    });

    // Update over the same column: an empty array is a value, never NULL.
    const updated = await server.request("/api/mutations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mutations: [
          buildBatchMutation({
            tableName: "arrayPrefs",
            entityKey: { id },
            mutationId: "8e07b2c1-0000-4000-8000-0000000000a2",
            mutationSeq: 2,
            kind: "update",
            payload: { prefs: [] },
          }),
        ],
      }),
    });

    await expectResponseStatus(updated, 200);

    const afterUpdate = await server.drizzle.select().from(arrayPrefsTable).where(eq(arrayPrefsTable.id, id));
    expect(afterUpdate.map((row) => row.prefs)).toEqual([[]]);
  });
});

async function readOperationsLogRowCount(
  server: ReturnType<typeof createSyncServer<typeof demoSyncRegistry>>,
): Promise<number> {
  const result = await server.drizzle.select({ count: count() }).from(operationsLogTable);
  return result[0]?.count ?? 0;
}

function buildBatchMutation(input: {
  tableName: string;
  entityKey: Record<string, string>;
  mutationId: string;
  mutationSeq: number;
  kind: "create" | "update" | "delete";
  payload: Record<string, unknown>;
  baseServerVersion?: string;
}) {
  return {
    ...input,
    clientTimestampUs: String(Date.now() * 1000),
  };
}

interface AckShape {
  status: string;
  serverUpdatedAtUs?: string;
  conflictReason?: string;
  rejectionReason?: string;
}

/** Read the first ack of a /api/mutations response with a typed shape (ADR-0015 proofs). */
async function readFirstAck(response: Response): Promise<AckShape> {
  const text = await response.clone().text();
  const body = JSON.parse(text) as { acks?: AckShape[] };
  const ack = body.acks?.[0];
  if (!ack) {
    throw new Error(`expected at least one ack (HTTP ${response.status}): ${text}`);
  }
  return ack;
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

/** POST one pessimistic write-unit to the authoritative endpoint (ADR-0022 §3). */
async function postAuthoritativeUnit(
  server: ReturnType<typeof createSyncServer<typeof demoSyncRegistry>>,
  mutations: Array<ReturnType<typeof buildBatchMutation>>,
  writeUnit?: string,
) {
  return server.request("/api/mutations/unit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...(writeUnit ? { writeUnit } : {}), mutations }),
  });
}

async function expectResponseStatus(response: Response, expectedStatus: number): Promise<void> {
  const responseText = await response.clone().text();

  if (response.status !== expectedStatus) {
    throw new Error(`Expected HTTP ${expectedStatus}, got ${response.status}: ${responseText}`);
  }
}
