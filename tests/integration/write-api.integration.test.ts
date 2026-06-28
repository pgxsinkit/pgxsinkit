import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";

import { count, eq, sql } from "drizzle-orm";

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
import { createSyncServer, operationsLogTable } from "@pgxsinkit/server";
import { createServerDb, readIntegrationEnv } from "@pgxsinkit/test-utils";

import { parseDemoAuthClaimsFromRequest } from "../../apps/write-api/src/demo-auth";
import { installPlpgsqlBatchFunction } from "../../packages/server/src/mutations/plpgsql-apply";

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

    // Batch 1: three authors (one set-based INSERT of 3 rows) + two todos (a second set-based INSERT),
    // across two (table, kind) groups, ordered authors-before-todos by min(mutationSeq) for the FK.
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
        mutationSeq: 4,
        kind: "create",
        payload: { id: t1, title: "T1", description: null, author_id: a1, status: "todo", priority: "low" },
      }),
      buildBatchMutation({
        tableName: "todos",
        entityKey: { id: t2 },
        mutationId: "0196322c-0000-4000-8000-0000000000c5",
        mutationSeq: 5,
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
    await serverDb.db.execute(sql`DROP TABLE IF EXISTS operations_log`);
    server = createSyncServer({
      registry: demoSyncRegistry,
      db: serverDb.db,
      resolveAuthClaims: () => ({ role: "authenticated", sub: DEMO_USER1_ID }),
      // operationsLog omitted → defaults to { enabled: true }, the board's configuration.
    });
    await installPlpgsqlBatchFunction(server.drizzle, demoSyncRegistry);
  });

  afterAll(async () => {
    // Restore the optional table (and its indexes — mirrors operations-log/schema.ts) so the later
    // integration files that share this database keep logging.
    await serverDb.db.execute(sql`
      CREATE TABLE IF NOT EXISTS operations_log (
        id bigserial PRIMARY KEY,
        table_name varchar(255),
        operation_kind varchar(24),
        user_id uuid,
        entity_key_json jsonb,
        payload_json jsonb,
        status varchar(32) NOT NULL,
        error_message text,
        http_status integer,
        mutation_id uuid,
        mutation_seq integer,
        client_timestamp_us bigint,
        request_path text,
        server_timestamp_us bigint NOT NULL DEFAULT (floor((EXTRACT(epoch FROM clock_timestamp()) * 1000000::numeric))),
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await serverDb.db.execute(
      sql`CREATE INDEX IF NOT EXISTS operations_log_created_at_idx ON operations_log (created_at DESC)`,
    );
    await serverDb.db.execute(
      sql`CREATE INDEX IF NOT EXISTS operations_log_table_name_idx ON operations_log (table_name)`,
    );
    await serverDb.db.execute(sql`CREATE INDEX IF NOT EXISTS operations_log_user_id_idx ON operations_log (user_id)`);
    await serverDb.db.execute(sql`CREATE INDEX IF NOT EXISTS operations_log_status_idx ON operations_log (status)`);
    await serverDb.db.execute(
      sql`CREATE INDEX IF NOT EXISTS operations_log_mutation_id_idx ON operations_log (mutation_id)`,
    );
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

    // Degraded, not auto-created: the optional table is still absent.
    const presence = await serverDb.db.execute<{ tableName: string | null }>(
      sql`SELECT to_regclass('public.operations_log')::text AS "tableName"`,
    );
    const presenceRow = Array.from(presence as Iterable<unknown>, (e) => e as { tableName: string | null })[0];
    expect(presenceRow?.tableName).toBeNull();
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
