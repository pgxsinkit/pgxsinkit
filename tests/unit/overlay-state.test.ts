import { bigint, pgTable, uuid, varchar } from "drizzle-orm/pg-core";

import { defineSyncRegistry, defineSyncTable } from "@pgxsinkit/contracts";
import { buildSyntheticRegistry, demoSyncRegistry } from "@pgxsinkit/schema";

import {
  DEFAULT_FLUSH_BATCH_SIZE,
  computeBackoffDelayMs,
  computeNextRetryAtUs,
  createMutationRuntime,
  nowMicroseconds,
  shouldClearOverlayRow,
} from "../../packages/client/src/mutation";
import { generateLocalSchemaSql } from "../../packages/client/src/schema";
import { createFreshTestPGlite } from "../support/pglite";

const overlaySchemaSql = generateLocalSchemaSql(demoSyncRegistry);
const writeUrl = "http://localhost:3001";

const routeOptionalBatchTable = pgTable("route_optional_batch_items", {
  id: uuid("id").primaryKey(),
  title: varchar("title", { length: 120 }).notNull(),
  createdAtUs: bigint("created_at_us", { mode: "bigint" }).notNull(),
  updatedAtUs: bigint("updated_at_us", { mode: "bigint" }).notNull(),
});

const routeOptionalBatchRegistry = defineSyncRegistry({
  routeOptionalBatchItems: defineSyncTable({
    table: routeOptionalBatchTable,
    mode: "readwrite",
    primaryKey: { columns: ["id"] },
    shape: { tableName: "route_optional_batch_items", shapeKey: "route_optional_batch_items" },
    clientProjection: {
      syncedTable: "route_optional_batch_items",
      overlayTable: "route_optional_batch_items_overlay",
      journalTable: "route_optional_batch_items_mutations",
      readModel: "route_optional_batch_items_read_model",
    },
  }),
});

async function createOverlayTestContext() {
  const db = await createFreshTestPGlite();
  await db.exec(overlaySchemaSql);

  return {
    db,
    runtime: createMutationRuntime({
      db,
      registry: demoSyncRegistry,
      writeUrl,
    }),
  };
}

describe("overlay state helpers", () => {
  it("compares synced and acknowledged timestamps numerically", () => {
    expect(shouldClearOverlayRow("200", "199")).toBe(true);
    expect(shouldClearOverlayRow("200", "200")).toBe(true);
    expect(shouldClearOverlayRow("199", "200")).toBe(false);
    expect(shouldClearOverlayRow("200", null)).toBe(false);
  });

  it("builds optimistic todos with bigint microsecond timestamps", () => {
    const runtime = createMutationRuntime({
      db: {} as never,
      registry: demoSyncRegistry,
      writeUrl,
    });
    const todo = runtime.createOptimisticRecord("todos", {
      id: "01963227-d4c7-72db-b858-f89f6af8f993",
      title: "Local optimistic row",
      description: null,
      authorId: "01963227-d4c7-72db-b858-f89f6af8f920",
      status: "todo",
      priority: "medium",
    });

    expect(todo.createdAtUs).toMatch(/^[0-9]+$/);
    expect(todo.updatedAtUs).toMatch(/^[0-9]+$/);
  });

  it("builds optimistic authors with bigint microsecond timestamps", () => {
    const runtime = createMutationRuntime({
      db: {} as never,
      registry: demoSyncRegistry,
      writeUrl,
    });
    const author = runtime.createOptimisticRecord("authors", {
      id: "01963227-d4c7-72db-b858-f89f6af8f930",
      name: "Local optimistic author",
    });

    expect(author.createdAtUs).toMatch(/^[0-9]+$/);
    expect(author.updatedAtUs).toMatch(/^[0-9]+$/);
  });

  it("allows batch mutation runtime setup without per-table routes", async () => {
    const db = await createFreshTestPGlite();
    await db.exec(generateLocalSchemaSql(routeOptionalBatchRegistry));

    const runtime = createMutationRuntime({
      db,
      registry: routeOptionalBatchRegistry,
      writeUrl,
      batchWriteUrl: writeUrl,
    });

    await expect(
      runtime.create("routeOptionalBatchItems", {
        id: "01963227-d4c7-72db-b858-f89f6af8f901",
        title: "Queued without per-table routes",
        createdAtUs: "100",
        updatedAtUs: "100",
      }),
    ).resolves.toBeUndefined();

    await db.close();
  });

  it("updates synthetic perf rows whose record schema includes overlay metadata", async () => {
    const { registry, tableNames } = buildSyntheticRegistry({
      tableCount: 1,
      extraColumnCount: 2,
    });
    const tableName = tableNames[0]!;
    const rowId = "01963227-d4c7-72db-b858-f89f6af8f901";
    const db = await createFreshTestPGlite();
    await db.exec(generateLocalSchemaSql(registry));
    const runtime = createMutationRuntime({
      db,
      registry,
      writeUrl,
    });

    await db.query(
      `
        INSERT INTO ${tableName} (
          id,
          field_00,
          field_01,
          owner_id,
          modified_by,
          status,
          priority,
          created_at_us,
          updated_at_us
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::bigint, $9::bigint)
      `,
      [
        rowId,
        "seed-0",
        "seed-1",
        "11111111-1111-4111-8111-111111111111",
        "11111111-1111-4111-8111-111111111111",
        "todo",
        "medium",
        "100",
        "100",
      ],
    );

    await runtime.update(
      tableName,
      { id: rowId },
      {
        field00: "updated-field",
        status: "done",
      },
    );

    const overlayRows = await db.query<{ field00: string; status: string; overlayKind: string }>(
      `
        SELECT field_00 AS "field00", status, overlay_kind AS "overlayKind"
        FROM ${tableName}_overlay
        WHERE id = $1
      `,
      [rowId],
    );

    expect(overlayRows.rows[0]).toEqual({
      field00: "updated-field",
      status: "done",
      overlayKind: "pending_update",
    });

    const visibleRows = await db.query<{ overlayKind: string; localUpdatedAtUs: string }>(
      `
        SELECT overlay_kind AS "overlayKind", local_updated_at_us::text AS "localUpdatedAtUs"
        FROM ${tableName}_read_model
        WHERE id = $1
      `,
      [rowId],
    );

    expect(visibleRows.rows[0]?.overlayKind).toBe("pending_update");
    expect(visibleRows.rows[0]?.localUpdatedAtUs).toMatch(/^[0-9]+$/);
  });

  it("queues authors into the local read model and author journal", async () => {
    const { db, runtime } = await createOverlayTestContext();

    await runtime.create("authors", {
      id: "01963227-d4c7-72db-b858-f89f6af8f931",
      name: "Ada Lovelace",
    });

    const authorRows = await db.query<{ name: string; overlayKind: string }>(`
      SELECT name, overlay_kind AS "overlayKind"
      FROM author_read_model
      WHERE id = '01963227-d4c7-72db-b858-f89f6af8f931'
    `);

    expect(authorRows.rows[0]).toEqual({
      name: "Ada Lovelace",
      overlayKind: "pending_create",
    });

    const mutations = await runtime.readMutationDetails("authors");
    expect(mutations[0]?.tableName).toBe("authors");
    expect(mutations[0]?.mutationKind).toBe("create");
  });

  it("keeps overlay rows until the synced echo reaches the acknowledged timestamp", async () => {
    const { db, runtime } = await createOverlayTestContext();

    await runtime.create("todos", {
      id: "01963227-d4c7-72db-b858-f89f6af8f994",
      title: "Queued create",
      description: null,
      authorId: "01963227-d4c7-72db-b858-f89f6af8f920",
      status: "todo",
      priority: "medium",
    });

    await db.query(
      `
        UPDATE todo_mutations
        SET status = 'acked', server_updated_at_us = $2::bigint
        WHERE id = $1 AND mutation_seq = 1
      `,
      ["01963227-d4c7-72db-b858-f89f6af8f994", "500"],
    );

    await db.query(
      `
        INSERT INTO todos (
          id,
          title,
          description,
          author_id,
          status,
          priority,
          created_at_us,
          updated_at_us
        ) VALUES ($1, $2, $3, $4, $5, $6, $7::bigint, $8::bigint)
      `,
      [
        "01963227-d4c7-72db-b858-f89f6af8f994",
        "Queued create",
        null,
        "01963227-d4c7-72db-b858-f89f6af8f920",
        "todo",
        "medium",
        "400",
        "499",
      ],
    );

    await runtime.reconcile("todos");

    let stats = await runtime.readMutationStats("todos");
    expect(stats.ackedCount).toBe(1);

    await db.query("UPDATE todos SET updated_at_us = $2::bigint WHERE id = $1", [
      "01963227-d4c7-72db-b858-f89f6af8f994",
      "500",
    ]);

    await runtime.reconcile("todos");

    stats = await runtime.readMutationStats("todos");
    expect(stats.ackedCount).toBe(0);

    const overlayRows = await db.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM todo_overlay");
    expect(overlayRows.rows[0]?.count).toBe(0);
  });

  it("reconciles multiple acknowledged overlays in one pass", async () => {
    const { db, runtime } = await createOverlayTestContext();

    for (const rowId of ["01963227-d4c7-72db-b858-f89f6af8f980", "01963227-d4c7-72db-b858-f89f6af8f981"]) {
      await db.query(
        `
          INSERT INTO todos (
            id,
            title,
            description,
            author_id,
            status,
            priority,
            created_at_us,
            updated_at_us
          ) VALUES ($1, $2, $3, $4, $5, $6, $7::bigint, $8::bigint)
        `,
        [rowId, `Synced ${rowId}`, null, "01963227-d4c7-72db-b858-f89f6af8f920", "todo", "medium", "100", "500"],
      );

      await runtime.update(
        "todos",
        { id: rowId },
        {
          status: "done",
        },
      );
    }

    await db.query(`
      UPDATE todo_mutations
      SET
        status = 'acked',
        server_updated_at_us = 500,
        updated_at_us = 500
      WHERE id IN (
        '01963227-d4c7-72db-b858-f89f6af8f980',
        '01963227-d4c7-72db-b858-f89f6af8f981'
      )
    `);

    await runtime.reconcile("todos");

    const stats = await runtime.readMutationStats("todos");
    expect(stats.ackedCount).toBe(0);

    const overlayRows = await db.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM todo_overlay");
    expect(overlayRows.rows[0]?.count).toBe(0);
  });

  it("returns microsecond timestamps as decimal strings", () => {
    expect(nowMicroseconds()).toMatch(/^[0-9]+$/);
  });

  it("computes bounded retry backoff metadata", () => {
    expect(computeBackoffDelayMs(1)).toBe(1000);
    expect(computeBackoffDelayMs(2)).toBe(2000);
    expect(computeBackoffDelayMs(10)).toBe(30000);
    expect(computeNextRetryAtUs("1000", 2)).toBe("2001000");
  });

  it("queues updates into the overlay and journal", async () => {
    const { db, runtime } = await createOverlayTestContext();

    await db.query(
      `
        INSERT INTO todos (
          id,
          title,
          description,
          author_id,
          status,
          priority,
          created_at_us,
          updated_at_us
        ) VALUES ($1, $2, $3, $4, $5, $6, $7::bigint, $8::bigint)
      `,
      [
        "01963227-d4c7-72db-b858-f89f6af8f995",
        "Original",
        null,
        "01963227-d4c7-72db-b858-f89f6af8f920",
        "todo",
        "medium",
        "100",
        "100",
      ],
    );

    await runtime.update(
      "todos",
      { id: "01963227-d4c7-72db-b858-f89f6af8f995" },
      {
        status: "done",
        title: "Updated",
      },
    );

    const overlayRows = await db.query<{ title: string; status: string; overlayKind: string }>(`
      SELECT title, status, overlay_kind AS "overlayKind"
      FROM todo_overlay
      WHERE id = '01963227-d4c7-72db-b858-f89f6af8f995'
    `);

    expect(overlayRows.rows[0]).toEqual({
      title: "Updated",
      status: "done",
      overlayKind: "pending_update",
    });

    const mutations = await runtime.readMutationDetails("todos");
    expect(mutations[0]?.mutationKind).toBe("update");
    expect(mutations[0]?.mutationSeq).toBe(1);
  });

  it("queues create and delete as a mutation chain", async () => {
    const { db, runtime } = await createOverlayTestContext();

    await runtime.create("todos", {
      id: "01963227-d4c7-72db-b858-f89f6af8f996",
      title: "Transient local create",
      description: null,
      authorId: "01963227-d4c7-72db-b858-f89f6af8f920",
      status: "todo",
      priority: "medium",
    });

    await runtime.delete("todos", { id: "01963227-d4c7-72db-b858-f89f6af8f996" });

    const stats = await runtime.readMutationStats("todos");
    expect(stats.pendingCount).toBe(2);

    const visibleRows = await db.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM todo_read_model");
    expect(visibleRows.rows[0]?.count).toBe(0);

    const overlays = await db.query<{ overlayKind: string }>(
      `SELECT overlay_kind AS "overlayKind" FROM todo_overlay WHERE id = $1`,
      ["01963227-d4c7-72db-b858-f89f6af8f996"],
    );
    expect(overlays.rows[0]?.overlayKind).toBe("pending_delete");

    const mutations = await runtime.readMutationDetails("todos");
    expect(mutations.map((mutation) => ({ kind: mutation.mutationKind, seq: mutation.mutationSeq }))).toEqual([
      { kind: "delete", seq: 2 },
      { kind: "create", seq: 1 },
    ]);
  });

  it("stages mixed-table local batches atomically", async () => {
    const { db, runtime } = await createOverlayTestContext();

    await runtime.batch([
      {
        table: "authors",
        kind: "create",
        input: {
          id: "01963227-d4c7-72db-b858-f89f6af8f937",
          name: "Batch Author",
        },
      },
      {
        table: "todos",
        kind: "create",
        input: {
          id: "01963227-d4c7-72db-b858-f89f6af8f938",
          title: "Batch Todo",
          description: null,
          authorId: "01963227-d4c7-72db-b858-f89f6af8f937",
          status: "todo",
          priority: "medium",
        },
      },
    ]);

    const authorRows = await db.query<{ overlayKind: string }>(
      `SELECT overlay_kind AS "overlayKind" FROM author_read_model WHERE id = $1`,
      ["01963227-d4c7-72db-b858-f89f6af8f937"],
    );
    const todoRows = await db.query<{ overlayKind: string }>(
      `SELECT overlay_kind AS "overlayKind" FROM todo_read_model WHERE id = $1`,
      ["01963227-d4c7-72db-b858-f89f6af8f938"],
    );

    expect(authorRows.rows[0]?.overlayKind).toBe("pending_create");
    expect(todoRows.rows[0]?.overlayKind).toBe("pending_create");

    const authorStats = await runtime.readMutationStats("authors");
    const todoStats = await runtime.readMutationStats("todos");

    expect(authorStats.pendingCount).toBe(1);
    expect(todoStats.pendingCount).toBe(1);
  });

  it("allocates per-entity mutation sequences inside a local batch", async () => {
    const { db, runtime } = await createOverlayTestContext();
    const todoId = "01963227-d4c7-72db-b858-f89f6af8f939";

    await db.query(
      `
        INSERT INTO todos (
          id,
          title,
          description,
          author_id,
          status,
          priority,
          created_at_us,
          updated_at_us
        ) VALUES ($1, $2, $3, $4, $5, $6, $7::bigint, $8::bigint)
      `,
      [todoId, "Seeded todo", null, "01963227-d4c7-72db-b858-f89f6af8f920", "todo", "medium", "100", "100"],
    );

    await runtime.batch([
      {
        table: "todos",
        kind: "update",
        entityKey: { id: todoId },
        patch: { title: "First in batch" },
      },
      {
        table: "todos",
        kind: "update",
        entityKey: { id: todoId },
        patch: { status: "done" },
      },
    ]);

    const overlayRows = await db.query<{ title: string; status: string }>(
      `SELECT title, status FROM todo_overlay WHERE id = $1`,
      [todoId],
    );
    const mutations = await runtime.readMutationDetails("todos");

    expect(overlayRows.rows[0]).toEqual({
      title: "First in batch",
      status: "done",
    });
    expect(
      mutations
        .filter((mutation) => mutation.entityKey.id === todoId)
        .map((mutation) => ({ kind: mutation.mutationKind, seq: mutation.mutationSeq })),
    ).toEqual([
      { kind: "update", seq: 2 },
      { kind: "update", seq: 1 },
    ]);
  });

  it("assigns globally unique mutation sequences in planner order", async () => {
    const { db, runtime } = await createOverlayTestContext();
    const firstTodoId = "01963227-d4c7-72db-b858-f89f6af8f944";
    const secondTodoId = "01963227-d4c7-72db-b858-f89f6af8f945";

    await db.query(
      `
        INSERT INTO todos (
          id,
          title,
          description,
          author_id,
          status,
          priority,
          created_at_us,
          updated_at_us
        ) VALUES
          ($1, $2, $3, $4, $5, $6, $7::bigint, $8::bigint),
          ($9, $10, $11, $12, $13, $14, $15::bigint, $16::bigint)
      `,
      [
        firstTodoId,
        "First seeded todo",
        null,
        "01963227-d4c7-72db-b858-f89f6af8f920",
        "todo",
        "medium",
        "100",
        "100",
        secondTodoId,
        "Second seeded todo",
        null,
        "01963227-d4c7-72db-b858-f89f6af8f920",
        "todo",
        "medium",
        "100",
        "100",
      ],
    );

    await runtime.batch([
      {
        table: "todos",
        kind: "update",
        entityKey: { id: firstTodoId },
        patch: { title: "First planner update" },
      },
      {
        table: "todos",
        kind: "update",
        entityKey: { id: secondTodoId },
        patch: { title: "Second planner update" },
      },
      {
        table: "todos",
        kind: "update",
        entityKey: { id: firstTodoId },
        patch: { status: "done" },
      },
    ]);

    const journalRows = await db.query<{ id: string; mutationSeq: number }>(
      `
        SELECT id, mutation_seq AS "mutationSeq"
        FROM todo_mutations
        ORDER BY mutation_seq ASC
      `,
    );

    expect(journalRows.rows).toEqual([
      { id: firstTodoId, mutationSeq: 1 },
      { id: secondTodoId, mutationSeq: 2 },
      { id: firstTodoId, mutationSeq: 3 },
    ]);
  });

  it("supports create-then-delete chains inside a local batch", async () => {
    const { db, runtime } = await createOverlayTestContext();
    const todoId = "01963227-d4c7-72db-b858-f89f6af8f942";

    await runtime.batch([
      {
        table: "todos",
        kind: "create",
        input: {
          id: todoId,
          title: "Transient batch todo",
          description: null,
          authorId: "01963227-d4c7-72db-b858-f89f6af8f920",
          status: "todo",
          priority: "medium",
        },
      },
      {
        table: "todos",
        kind: "delete",
        entityKey: { id: todoId },
      },
    ]);

    const stats = await runtime.readMutationStats("todos");
    expect(stats.pendingCount).toBe(2);

    const visibleRows = await db.query<{ count: number }>(
      "SELECT COUNT(*)::int AS count FROM todo_read_model WHERE id = $1",
      [todoId],
    );
    expect(visibleRows.rows[0]?.count).toBe(0);

    const overlays = await db.query<{ overlayKind: string }>(
      `SELECT overlay_kind AS "overlayKind" FROM todo_overlay WHERE id = $1`,
      [todoId],
    );
    expect(overlays.rows[0]?.overlayKind).toBe("pending_delete");

    const mutations = await runtime.readMutationDetails("todos");
    expect(
      mutations
        .filter((mutation) => mutation.entityKey.id === todoId)
        .map((mutation) => ({ kind: mutation.mutationKind, seq: mutation.mutationSeq })),
    ).toEqual([
      { kind: "delete", seq: 2 },
      { kind: "create", seq: 1 },
    ]);
  });

  it("rolls back semantic batch failures after an in-batch delete", async () => {
    const { db, runtime } = await createOverlayTestContext();
    const todoId = "01963227-d4c7-72db-b858-f89f6af8f943";

    await expect(
      runtime.batch([
        {
          table: "todos",
          kind: "create",
          input: {
            id: todoId,
            title: "Transient batch todo",
            description: null,
            authorId: "01963227-d4c7-72db-b858-f89f6af8f920",
            status: "todo",
            priority: "medium",
          },
        },
        {
          table: "todos",
          kind: "delete",
          entityKey: { id: todoId },
        },
        {
          table: "todos",
          kind: "update",
          entityKey: { id: todoId },
          patch: { title: "Should not enqueue" },
        },
      ]),
    ).rejects.toThrow("todos is already queued for deletion");

    const [overlayRows, mutationRows] = await Promise.all([
      db.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM todo_overlay WHERE id = $1", [todoId]),
      db.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM todo_mutations WHERE id = $1", [todoId]),
    ]);

    expect(overlayRows.rows[0]?.count).toBe(0);
    expect(mutationRows.rows[0]?.count).toBe(0);
  });

  it("rejects invalid local batches without partial journaling", async () => {
    const { db, runtime } = await createOverlayTestContext();

    await expect(
      runtime.batch([
        {
          table: "authors",
          kind: "create",
          input: {
            id: "01963227-d4c7-72db-b858-f89f6af8f940",
            name: "Valid Author",
          },
        },
        {
          table: "todos",
          kind: "create",
          input: {
            id: "01963227-d4c7-72db-b858-f89f6af8f941",
            title: "",
            description: null,
            authorId: "01963227-d4c7-72db-b858-f89f6af8f940",
            status: "todo",
            priority: "medium",
          },
        },
      ]),
    ).rejects.toThrow("[");

    const [authorOverlay, authorJournal, todoOverlay, todoJournal] = await Promise.all([
      db.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM author_overlay"),
      db.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM author_mutations"),
      db.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM todo_overlay"),
      db.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM todo_mutations"),
    ]);

    expect(authorOverlay.rows[0]?.count).toBe(0);
    expect(authorJournal.rows[0]?.count).toBe(0);
    expect(todoOverlay.rows[0]?.count).toBe(0);
    expect(todoJournal.rows[0]?.count).toBe(0);
  });

  it("clears acknowledged deletes in one reconcile pass once the synced row is gone", async () => {
    const { db, runtime } = await createOverlayTestContext();

    for (const rowId of ["01963227-d4c7-72db-b858-f89f6af8f982", "01963227-d4c7-72db-b858-f89f6af8f983"]) {
      await runtime.create("todos", {
        id: rowId,
        title: `Transient ${rowId}`,
        description: null,
        authorId: "01963227-d4c7-72db-b858-f89f6af8f920",
        status: "todo",
        priority: "medium",
      });

      await runtime.delete("todos", { id: rowId });
    }

    await db.query(`
      UPDATE todo_mutations
      SET
        status = 'acked',
        updated_at_us = 600,
        acked_at_us = 600
      WHERE mutation_kind = 'delete'
        AND id IN (
          '01963227-d4c7-72db-b858-f89f6af8f982',
          '01963227-d4c7-72db-b858-f89f6af8f983'
        )
    `);

    await runtime.reconcile("todos");

    const stats = await runtime.readMutationStats("todos");
    expect(stats.pendingCount).toBe(0);
    expect(stats.ackedCount).toBe(0);

    const overlays = await db.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM todo_overlay");
    expect(overlays.rows[0]?.count).toBe(0);

    const journal = await db.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM todo_mutations");
    expect(journal.rows[0]?.count).toBe(0);
  });

  it("appends multiple queued updates for the same todo", async () => {
    const { db, runtime } = await createOverlayTestContext();

    await db.query(
      `
        INSERT INTO todos (
          id,
          title,
          description,
          author_id,
          status,
          priority,
          created_at_us,
          updated_at_us
        ) VALUES ($1, $2, $3, $4, $5, $6, $7::bigint, $8::bigint)
      `,
      [
        "01963227-d4c7-72db-b858-f89f6af8f910",
        "Original",
        null,
        "01963227-d4c7-72db-b858-f89f6af8f920",
        "todo",
        "medium",
        "100",
        "100",
      ],
    );

    await runtime.update(
      "todos",
      { id: "01963227-d4c7-72db-b858-f89f6af8f910" },
      {
        title: "First update",
      },
    );
    await runtime.update(
      "todos",
      { id: "01963227-d4c7-72db-b858-f89f6af8f910" },
      {
        status: "done",
      },
    );

    const overlayRows = await db.query<{ title: string; status: string }>(
      `SELECT title, status FROM todo_overlay WHERE id = $1`,
      ["01963227-d4c7-72db-b858-f89f6af8f910"],
    );
    expect(overlayRows.rows[0]).toEqual({
      title: "First update",
      status: "done",
    });

    const mutations = await runtime.readMutationDetails("todos");
    expect(mutations.map((mutation) => ({ kind: mutation.mutationKind, seq: mutation.mutationSeq }))).toEqual([
      { kind: "update", seq: 2 },
      { kind: "update", seq: 1 },
    ]);
  });

  it("updates a pending local create without needing a synced row lookup", async () => {
    const { db, runtime } = await createOverlayTestContext();

    await runtime.create("todos", {
      id: "01963227-d4c7-72db-b858-f89f6af8f909",
      title: "Created offline",
      description: null,
      authorId: "01963227-d4c7-72db-b858-f89f6af8f920",
      status: "todo",
      priority: "medium",
    });

    await runtime.update(
      "todos",
      { id: "01963227-d4c7-72db-b858-f89f6af8f909" },
      {
        title: "Updated before sync",
        status: "done",
      },
    );

    const overlayRows = await db.query<{ title: string; status: string; overlayKind: string }>(
      `SELECT title, status, overlay_kind AS "overlayKind" FROM todo_overlay WHERE id = $1`,
      ["01963227-d4c7-72db-b858-f89f6af8f909"],
    );

    expect(overlayRows.rows[0]).toEqual({
      title: "Updated before sync",
      status: "done",
      overlayKind: "pending_create",
    });

    const visibleRows = await db.query<{ title: string; status: string; overlayKind: string }>(
      `SELECT title, status, overlay_kind AS "overlayKind" FROM todo_read_model WHERE id = $1`,
      ["01963227-d4c7-72db-b858-f89f6af8f909"],
    );

    expect(visibleRows.rows[0]).toEqual({
      title: "Updated before sync",
      status: "done",
      overlayKind: "pending_create",
    });

    const mutations = await runtime.readMutationDetails("todos");
    expect(mutations.map((mutation) => ({ kind: mutation.mutationKind, seq: mutation.mutationSeq }))).toEqual([
      { kind: "update", seq: 2 },
      { kind: "create", seq: 1 },
    ]);
  });

  it("resets failed mutations for immediate retry", async () => {
    const db = await createFreshTestPGlite();
    const runtime = createMutationRuntime({
      db,
      registry: demoSyncRegistry,
      writeUrl,
    });

    await db.exec(`
      CREATE TABLE todo_mutations (
        mutation_id UUID PRIMARY KEY,
        todo_id UUID NOT NULL,
        entity_key_json TEXT NOT NULL,
        mutation_seq INTEGER NOT NULL,
        mutation_kind VARCHAR(24) NOT NULL,
        status VARCHAR(24) NOT NULL,
        payload_json TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        last_http_status INTEGER,
        conflict_reason TEXT,
        server_updated_at_us BIGINT,
        enqueued_at_us BIGINT NOT NULL,
        next_retry_at_us BIGINT,
        sent_at_us BIGINT,
        acked_at_us BIGINT,
        updated_at_us BIGINT NOT NULL,
        UNIQUE (todo_id, mutation_seq)
      );
    `);

    await db.query(
      `
        INSERT INTO todo_mutations (
          mutation_id,
          todo_id,
          entity_key_json,
          mutation_seq,
          mutation_kind,
          status,
          payload_json,
          attempt_count,
          last_error,
          conflict_reason,
          enqueued_at_us,
          next_retry_at_us,
          updated_at_us
        ) VALUES ($1, $2, $3, 1, 'update', 'failed', $4, 2, 'boom', '409 conflict', $5::bigint, $6::bigint, $7::bigint)
      `,
      [
        "01963227-d4c7-72db-b858-f89f6af8f997",
        "01963227-d4c7-72db-b858-f89f6af8f998",
        '{"id":"01963227-d4c7-72db-b858-f89f6af8f998"}',
        '{"kind":"update","patch":{"status":"done"}}',
        "100",
        "1000",
        "1000",
      ],
    );

    await runtime.retryFailed("todos");

    const mutations = await runtime.readMutationDetails("todos");
    expect(mutations[0]?.status).toBe("pending");
    expect(mutations[0]?.conflictReason).toBeNull();
    expect(mutations[0]?.mutationSeq).toBe(1);
  });

  it("requeues interrupted sending mutations on startup", async () => {
    const { db, runtime } = await createOverlayTestContext();

    await runtime.create("authors", {
      id: "01963227-d4c7-72db-b858-f89f6af8f935",
      name: "Interrupted author",
    });

    await db.query(
      `
        UPDATE author_mutations
        SET
          status = 'sending',
          sent_at_us = $2::bigint,
          updated_at_us = $2::bigint
        WHERE mutation_id = $1
      `,
      [(await runtime.readMutationDetails("authors"))[0]?.mutationId, "1000"],
    );

    await runtime.recoverSending("authors");

    const mutations = await runtime.readMutationDetails("authors");
    expect(mutations[0]?.status).toBe("pending");
    expect(mutations[0]?.lastHttpStatus).toBeNull();
    expect(mutations[0]?.conflictReason).toBeNull();
  });

  it("flushes parent author mutations before child todo mutations", async () => {
    const { runtime } = await createOverlayTestContext();
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn<typeof fetch>(async (input, _init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      if (url.endsWith("/api/authors")) {
        return new Response(
          JSON.stringify({
            id: "01963227-d4c7-72db-b858-f89f6af8f932",
            name: "Grace Hopper",
            createdAtUs: "100",
            updatedAtUs: "100",
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        );
      }

      return new Response(
        JSON.stringify({
          id: "01963227-d4c7-72db-b858-f89f6af8f933",
          title: "Child todo",
          description: null,
          authorId: "01963227-d4c7-72db-b858-f89f6af8f932",
          status: "todo",
          priority: "medium",
          createdAtUs: "101",
          updatedAtUs: "101",
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    });

    globalThis.fetch = fetchMock;

    try {
      await runtime.create("authors", {
        id: "01963227-d4c7-72db-b858-f89f6af8f932",
        name: "Grace Hopper",
      });
      await runtime.create("todos", {
        id: "01963227-d4c7-72db-b858-f89f6af8f933",
        title: "Child todo",
        description: null,
        authorId: "01963227-d4c7-72db-b858-f89f6af8f932",
        status: "todo",
        priority: "medium",
      });

      await runtime.flush("authors");
      await runtime.flush("todos");

      expect(fetchMock).toHaveBeenNthCalledWith(
        1,
        "http://localhost:3001/api/authors",
        expect.objectContaining({ method: "POST" }),
      );
      expect(fetchMock).toHaveBeenNthCalledWith(
        2,
        "http://localhost:3001/api/todos",
        expect.objectContaining({ method: "POST" }),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("forwards auth headers on batch mutation flushes", async () => {
    const db = await createFreshTestPGlite();
    await db.exec(overlaySchemaSql);

    const runtime = createMutationRuntime({
      db,
      registry: demoSyncRegistry,
      writeUrl,
      batchWriteUrl: writeUrl,
      getAuthToken: async () => "demo-token",
    });

    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const bodyText =
        typeof input === "string"
          ? null
          : input instanceof URL
            ? null
            : typeof input.text === "function"
              ? await input.text()
              : null;
      const requestBody = bodyText ? (JSON.parse(bodyText) as { mutations: Array<{ mutationId: string }> }) : null;
      const mutationId = requestBody?.mutations[0]?.mutationId ?? "missing-mutation-id";

      return new Response(
        JSON.stringify({
          acks: [
            {
              mutationId,
              status: "acked",
              httpStatus: 200,
              serverUpdatedAtUs: "100",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    globalThis.fetch = fetchMock;

    try {
      await runtime.create("authors", {
        id: "01963227-d4c7-72db-b858-f89f6af8f934",
        name: "Authenticated author",
      });

      await runtime.flush("authors");

      expect(fetchMock).toHaveBeenCalledWith(
        "http://localhost:3001/mutations",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            Authorization: "Bearer demo-token",
          }),
        }),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("serializes concurrent batch flushes for the same mutation", async () => {
    const db = await createFreshTestPGlite();
    await db.exec(overlaySchemaSql);

    const runtime = createMutationRuntime({
      db,
      registry: demoSyncRegistry,
      writeUrl,
      batchWriteUrl: writeUrl,
    });

    const originalFetch = globalThis.fetch;
    let resolveFetch!: () => void;
    const fetchRelease = new Promise<void>((resolve) => {
      resolveFetch = resolve;
    });
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const bodyText =
        typeof input === "string"
          ? null
          : input instanceof URL
            ? null
            : typeof input.text === "function"
              ? await input.text()
              : null;
      const requestBody = bodyText ? (JSON.parse(bodyText) as { mutations: Array<{ mutationId: string }> }) : null;
      const mutationId = requestBody?.mutations[0]?.mutationId ?? "missing-mutation-id";

      await fetchRelease;

      return new Response(
        JSON.stringify({
          acks: [
            {
              mutationId,
              status: "acked",
              httpStatus: 200,
              serverUpdatedAtUs: "100",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    globalThis.fetch = fetchMock;

    try {
      await runtime.create("authors", {
        id: "01963227-d4c7-72db-b858-f89f6af8f936",
        name: "Concurrent flush author",
      });

      const firstFlush = runtime.flush("authors");
      const secondFlush = runtime.flush("authors");

      resolveFetch();
      await Promise.all([firstFlush, secondFlush]);

      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("uses an explicit batch endpoint as-is without appending legacy path segments", async () => {
    const db = await createFreshTestPGlite();
    await db.exec(overlaySchemaSql);

    const runtime = createMutationRuntime({
      db,
      registry: demoSyncRegistry,
      writeUrl,
      batchWriteUrl: "http://localhost:3001/mutations",
    });

    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      const bodyText = typeof init?.body === "string" ? init.body : null;
      const requestBody = bodyText
        ? (JSON.parse(bodyText) as { mutations: Array<{ mutationId: string }> })
        : { mutations: [] };

      return new Response(
        JSON.stringify({
          acks: requestBody.mutations.map((mutation) => ({
            mutationId: mutation.mutationId,
            status: "acked",
            httpStatus: 200,
            serverUpdatedAtUs: "100",
          })),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    globalThis.fetch = fetchMock;

    try {
      await runtime.create("authors", {
        id: "01963227-d4c7-72db-b858-f89f6af8f937",
        name: "Endpoint-preserving author",
      });

      await runtime.flush("authors");

      expect(fetchMock).toHaveBeenCalledWith(
        "http://localhost:3001/mutations",
        expect.objectContaining({ method: "POST" }),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("drains multiple batch slices in a single flush call", async () => {
    const db = await createFreshTestPGlite();
    await db.exec(overlaySchemaSql);

    const runtime = createMutationRuntime({
      db,
      registry: demoSyncRegistry,
      writeUrl,
      batchWriteUrl: writeUrl,
    });

    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      const bodyText = typeof init?.body === "string" ? init.body : null;
      const requestBody = bodyText
        ? (JSON.parse(bodyText) as { mutations: Array<{ mutationId: string }> })
        : { mutations: [] };

      return new Response(
        JSON.stringify({
          acks: requestBody.mutations.map((mutation) => ({
            mutationId: mutation.mutationId,
            status: "acked",
            httpStatus: 200,
            serverUpdatedAtUs: "100",
          })),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    globalThis.fetch = fetchMock;

    try {
      const mutationCount = DEFAULT_FLUSH_BATCH_SIZE * 2 + 5;

      for (let index = 0; index < mutationCount; index += 1) {
        await runtime.create("authors", {
          id: `01963227-d4c7-72db-b858-${(900000000000 + index).toString().padStart(12, "0")}`,
          name: `Batch Author ${index}`,
        });
      }

      await runtime.flush("authors");

      const mutationStats = await runtime.readMutationStats("authors");

      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(mutationStats.pendingCount).toBe(0);
      expect(mutationStats.failedCount).toBe(0);
      expect(mutationStats.ackedCount).toBe(mutationCount);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("reconciles acknowledged batch updates after the full drain completes", async () => {
    const db = await createFreshTestPGlite();
    await db.exec(overlaySchemaSql);

    const runtime = createMutationRuntime({
      db,
      registry: demoSyncRegistry,
      writeUrl,
      batchWriteUrl: writeUrl,
    });
    const mutationCount = DEFAULT_FLUSH_BATCH_SIZE + 1;

    for (let index = 0; index < mutationCount; index += 1) {
      const authorId = `01963227-d4c7-72db-b858-${(910000000000 + index).toString().padStart(12, "0")}`;

      await db.query(
        `
          INSERT INTO authors (
            id,
            name,
            created_at_us,
            updated_at_us
          ) VALUES ($1, $2, $3::bigint, $4::bigint)
        `,
        [authorId, `Seeded Author ${index}`, "100", "100"],
      );

      await runtime.update("authors", { id: authorId }, { name: `Updated Author ${index}` });
    }

    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      const bodyText = typeof init?.body === "string" ? init.body : null;
      const requestBody = bodyText
        ? (JSON.parse(bodyText) as { mutations: Array<{ mutationId: string }> })
        : { mutations: [] };

      return new Response(
        JSON.stringify({
          acks: requestBody.mutations.map((mutation) => ({
            mutationId: mutation.mutationId,
            status: "acked",
            httpStatus: 200,
            serverUpdatedAtUs: "100",
          })),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    globalThis.fetch = fetchMock;

    try {
      await runtime.flush("authors");

      const mutationStats = await runtime.readMutationStats("authors");
      const overlays = await db.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM author_overlay");

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(mutationStats.pendingCount).toBe(0);
      expect(mutationStats.ackedCount).toBe(0);
      expect(overlays.rows[0]?.count).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("applies mixed batch acknowledgements without row-by-row status drift", async () => {
    const db = await createFreshTestPGlite();
    await db.exec(overlaySchemaSql);

    const runtime = createMutationRuntime({
      db,
      registry: demoSyncRegistry,
      writeUrl,
      batchWriteUrl: writeUrl,
    });

    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      const bodyText = typeof init?.body === "string" ? init.body : null;
      const requestBody = bodyText
        ? (JSON.parse(bodyText) as { mutations: Array<{ mutationId: string; entityKey: { id: string } }> })
        : { mutations: [] };
      const [firstMutation, secondMutation] = requestBody.mutations;

      return new Response(
        JSON.stringify({
          acks: [
            {
              tableName: "authors",
              entityKey: firstMutation?.entityKey ?? { id: "missing" },
              mutationId: firstMutation?.mutationId ?? "01963227-d4c7-72db-b858-f89f6af8f970",
              mutationSeq: 1,
              status: "acked",
              serverUpdatedAtUs: "100",
              httpStatus: 200,
            },
            {
              tableName: "authors",
              entityKey: secondMutation?.entityKey ?? { id: "missing" },
              mutationId: secondMutation?.mutationId ?? "01963227-d4c7-72db-b858-f89f6af8f971",
              mutationSeq: 1,
              status: "conflicted",
              conflictReason: "duplicate name",
              httpStatus: 409,
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    globalThis.fetch = fetchMock;

    try {
      await runtime.create("authors", {
        id: "01963227-d4c7-72db-b858-f89f6af8f970",
        name: "Batch Ack Author",
      });
      await runtime.create("authors", {
        id: "01963227-d4c7-72db-b858-f89f6af8f971",
        name: "Batch Conflict Author",
      });

      await runtime.flush("authors");

      const mutations = await runtime.readMutationDetails("authors");
      const mutationById = new Map(mutations.map((mutation) => [mutation.entityKey.id, mutation]));

      expect(mutationById.get("01963227-d4c7-72db-b858-f89f6af8f970")?.status).toBe("acked");
      expect(mutationById.get("01963227-d4c7-72db-b858-f89f6af8f971")?.status).toBe("failed");
      expect(mutationById.get("01963227-d4c7-72db-b858-f89f6af8f971")?.conflictReason).toBe("duplicate name");
      expect(mutationById.get("01963227-d4c7-72db-b858-f89f6af8f971")?.lastHttpStatus).toBe(409);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
