import { describe, expect, it } from "bun:test";
import { mock } from "bun:test";

import { bigint, boolean, text, uuid, varchar } from "drizzle-orm/pg-core";

import { defineSyncRegistry, defineSyncTable } from "@pgxsinkit/contracts";
import { buildSyntheticRegistry, demoSyncRegistry } from "@pgxsinkit/schema";

import {
  computeBackoffDelayMs,
  computeNextRetryAtUs,
  computeRetryDelayMs,
  createMutationRuntime,
  nowMicroseconds,
} from "../../packages/client/src/mutation";
import { generateLocalSchemaSql } from "../../packages/client/src/schema";
import { createFreshTestPGlite, createSchemaTestPGlite } from "../support/pglite";

const overlaySchemaSql = generateLocalSchemaSql(demoSyncRegistry);
const writeUrl = "http://localhost:3001";

const routeOptionalBatchRegistry = defineSyncRegistry({
  routeOptionalBatchItems: defineSyncTable({
    tableName: "route_optional_batch_items",
    makeColumns: () => ({
      id: uuid("id").primaryKey(),
      title: varchar("title", { length: 120 }).notNull(),
      createdAtUs: bigint("created_at_us", { mode: "bigint" }).notNull(),
      updatedAtUs: bigint("updated_at_us", { mode: "bigint" }).notNull(),
    }),
    mode: "readwrite",
    conflictPolicy: "last-write-wins",
    governance: {
      managedFields: [{ column: "updatedAtUs", applyOn: ["create", "update"], strategy: "nowMicroseconds" }],
    },
  }),
});

const defaultedColumnRegistry = defineSyncRegistry({
  defaultedColumnItems: defineSyncTable({
    tableName: "defaulted_column_items",
    makeColumns: () => ({
      id: uuid("id").primaryKey(),
      title: varchar("title", { length: 120 }).notNull(),
      // NOT NULL with a literal default the caller may omit (the regression case:
      // `research_excluded boolean NOT NULL DEFAULT false`).
      researchExcluded: boolean("research_excluded").notNull().default(false),
      // NOT NULL with a value-returning defaultFn the caller may omit.
      channel: text("channel")
        .notNull()
        .$defaultFn(() => "default-channel"),
      createdAtUs: bigint("created_at_us", { mode: "bigint" }).notNull(),
      updatedAtUs: bigint("updated_at_us", { mode: "bigint" }).notNull(),
    }),
    mode: "readwrite",
    conflictPolicy: "last-write-wins",
    governance: {
      managedFields: [{ column: "updatedAtUs", applyOn: ["create", "update"], strategy: "nowMicroseconds" }],
    },
  }),
});

// ADR-0012: a writable table whose PK drizzle property (`groupId`) differs from its column
// (`group_id`). The client must persist the canonical column-keyed identity.
const renamedPkRegistry = defineSyncRegistry({
  renamedPk: defineSyncTable({
    tableName: "renamed_pk_items",
    makeColumns: () => ({
      groupId: uuid("group_id").primaryKey(),
      label: varchar("label", { length: 120 }).notNull(),
      updatedAtUs: bigint("updated_at_us", { mode: "bigint" }).notNull(),
    }),
    mode: "readwrite",
    conflictPolicy: "last-write-wins",
    primaryKey: ["group_id"],
    governance: {
      managedFields: [{ column: "updatedAtUs", applyOn: ["create", "update"], strategy: "nowMicroseconds" }],
    },
  }),
});

// Audit finding 4: a writable table whose Server version managed field is NOT the conventional
// `updated_at_us`. Governance resolves it generically, so the optimistic local path must materialise
// it by governance too — not by the `createdAtUs`/`updatedAtUs` name. `modified_at_us` is NOT NULL
// with no client-materialisable default, so only the governance-driven fill can populate it.
const customServerVersionRegistry = defineSyncRegistry({
  customVersionItems: defineSyncTable({
    tableName: "custom_version_items",
    makeColumns: () => ({
      id: uuid("id").primaryKey(),
      title: varchar("title", { length: 120 }).notNull(),
      modifiedAtUs: bigint("modified_at_us", { mode: "bigint" }).notNull(),
    }),
    mode: "readwrite",
    conflictPolicy: "last-write-wins",
    governance: {
      managedFields: [{ column: "modifiedAtUs", applyOn: ["create", "update"], strategy: "nowMicroseconds" }],
    },
  }),
});

// A writable table with an `authUid` create-managed field that is NOT NULL (owner/author/created_by —
// the board's `message.author_id`). The field is stripped from the create input (the server stamps
// `auth.uid()`), so the optimistic overlay must fill it from the decoded auth subject or the overlay
// INSERT violates NOT NULL. Regression: board Phase 7 finding (first `create` in the demo).
const authOwnedRegistry = defineSyncRegistry({
  authOwnedItems: defineSyncTable({
    tableName: "auth_owned_items",
    makeColumns: () => ({
      id: uuid("id").primaryKey(),
      ownerId: uuid("owner_id").notNull(),
      body: varchar("body", { length: 200 }).notNull(),
      createdAtUs: bigint("created_at_us", { mode: "bigint" }).notNull(),
      updatedAtUs: bigint("updated_at_us", { mode: "bigint" }).notNull(),
    }),
    mode: "readwrite",
    conflictPolicy: "last-write-wins",
    governance: {
      managedFields: [
        { column: "ownerId", applyOn: ["create"], strategy: "authUid" },
        { column: "createdAtUs", applyOn: ["create"], strategy: "nowMicroseconds" },
        { column: "updatedAtUs", applyOn: ["create", "update"], strategy: "nowMicroseconds" },
      ],
    },
  }),
});

// Minimal unsigned JWT carrying just a `sub` claim (the runtime only decodes it; it never verifies).
function fakeJwtWithSub(sub: string): string {
  const encode = (value: object): string =>
    btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode({ sub })}.`;
}

async function createOverlayTestContext() {
  const db = await createSchemaTestPGlite(overlaySchemaSql);

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
    });

    // oxlint-disable-next-line typescript/await-thenable -- bun-types gap: .resolves/.rejects matchers return a real promise typed as void
    await expect(
      runtime.create("routeOptionalBatchItems", {
        id: "01963227-d4c7-72db-b858-f89f6af8f901",
        title: "Queued without per-table routes",
        createdAtUs: 100n,
      }),
    ).resolves.toBeUndefined();

    await db.close();
  });

  it("materialises NOT NULL column defaults into the optimistic overlay row on create", async () => {
    const db = await createFreshTestPGlite();
    await db.exec(generateLocalSchemaSql(defaultedColumnRegistry));

    const runtime = createMutationRuntime({
      db,
      registry: defaultedColumnRegistry,
      writeUrl,
    });

    // Omit `researchExcluded` and `channel` — both are NOT NULL with defaults. Before the
    // fix the overlay INSERT passed explicit NULLs and violated the NOT NULL constraint.
    await runtime.create("defaultedColumnItems", {
      id: "01963227-d4c7-72db-b858-f89f6af8fa01",
      title: "Defaults filled locally",
      createdAtUs: 100n,
    });

    const overlayRows = await db.query<{ researchExcluded: boolean; channel: string; overlayKind: string }>(
      `
        SELECT research_excluded AS "researchExcluded", channel, overlay_kind AS "overlayKind"
        FROM defaulted_column_items_overlay
        WHERE id = $1
      `,
      ["01963227-d4c7-72db-b858-f89f6af8fa01"],
    );

    expect(overlayRows.rows[0]).toEqual({
      researchExcluded: false,
      channel: "default-channel",
      overlayKind: "pending_create",
    });

    await db.close();
  });

  it("keeps caller-supplied values over column defaults on create", async () => {
    const db = await createFreshTestPGlite();
    await db.exec(generateLocalSchemaSql(defaultedColumnRegistry));

    const runtime = createMutationRuntime({
      db,
      registry: defaultedColumnRegistry,
      writeUrl,
    });

    await runtime.create("defaultedColumnItems", {
      id: "01963227-d4c7-72db-b858-f89f6af8fa02",
      title: "Explicit values win",
      researchExcluded: true,
      channel: "explicit-channel",
      createdAtUs: 100n,
    });

    const overlayRows = await db.query<{ researchExcluded: boolean; channel: string }>(
      `
        SELECT research_excluded AS "researchExcluded", channel
        FROM defaulted_column_items_overlay
        WHERE id = $1
      `,
      ["01963227-d4c7-72db-b858-f89f6af8fa02"],
    );

    expect(overlayRows.rows[0]).toEqual({
      researchExcluded: true,
      channel: "explicit-channel",
    });

    await db.close();
  });

  it("materialises a custom-named Server version on optimistic create (governance-driven, not by convention) — finding 4", async () => {
    const db = await createFreshTestPGlite();
    await db.exec(generateLocalSchemaSql(customServerVersionRegistry));
    const runtime = createMutationRuntime({ db, registry: customServerVersionRegistry, writeUrl });

    // `modifiedAtUs` is a managed-on-create field, so it is omitted from the create input; the
    // optimistic overlay must fill it from governance. Before finding 4 the convention-only fill left
    // it NULL → NOT NULL violation on the overlay INSERT.
    await runtime.create("customVersionItems", {
      id: "01963227-d4c7-72db-b858-f89f6af8fb01",
      title: "Custom version field",
    });

    const rows = await db.query<{ modifiedAtUs: string | null }>(
      `SELECT modified_at_us::text AS "modifiedAtUs" FROM custom_version_items_overlay WHERE id = $1`,
      ["01963227-d4c7-72db-b858-f89f6af8fb01"],
    );
    expect(rows.rows[0]?.modifiedAtUs).not.toBeNull();
    expect(Number(rows.rows[0]?.modifiedAtUs)).toBeGreaterThan(0);

    await db.close();
  });

  it("stamps an authUid create-managed field into the optimistic overlay from the decoded subject — board Phase 7", async () => {
    const db = await createFreshTestPGlite();
    await db.exec(generateLocalSchemaSql(authOwnedRegistry));
    const subject = "01963227-d4c7-72db-b858-f89f6af8fc10";
    const runtime = createMutationRuntime({
      db,
      registry: authOwnedRegistry,
      writeUrl,
      getAuthToken: async () => fakeJwtWithSub(subject),
    });

    // `ownerId` is an authUid create-managed field, so it is stripped from the create input. Before the
    // fix the overlay INSERT passed an explicit NULL → NOT NULL violation; now it is filled from the
    // decoded `sub` so the local row is attributed immediately.
    await runtime.create("authOwnedItems", {
      id: "01963227-d4c7-72db-b858-f89f6af8fc01",
      body: "optimistic message",
    });

    const rows = await db.query<{ ownerId: string; overlayKind: string }>(
      `SELECT owner_id AS "ownerId", overlay_kind AS "overlayKind" FROM auth_owned_items_overlay WHERE id = $1`,
      ["01963227-d4c7-72db-b858-f89f6af8fc01"],
    );
    expect(rows.rows[0]).toEqual({ ownerId: subject, overlayKind: "pending_create" });

    // The server stamps `auth.uid()` authoritatively, so the flushed payload must NOT carry the
    // authUid field — the server rejects a payload that includes a server-managed field.
    const journal = await db.query<{ payloadJson: string }>(
      `SELECT payload_json AS "payloadJson" FROM auth_owned_items_mutations WHERE id = $1`,
      ["01963227-d4c7-72db-b858-f89f6af8fc01"],
    );
    const payload = JSON.parse(journal.rows[0]!.payloadJson) as { value: Record<string, unknown> };
    expect(payload.value).not.toHaveProperty("ownerId");

    await db.close();
  });

  it("re-stamps a custom-named Server version on optimistic update — finding 4", async () => {
    const db = await createFreshTestPGlite();
    await db.exec(generateLocalSchemaSql(customServerVersionRegistry));
    const runtime = createMutationRuntime({ db, registry: customServerVersionRegistry, writeUrl });

    const id = "01963227-d4c7-72db-b858-f89f6af8fb02";
    await runtime.create("customVersionItems", { id, title: "v1" });

    // Force a known-stale managed value so a successful re-stamp is unmistakable (the wall clock is
    // millisecond-grained, so a fresh create+update could otherwise share a value).
    await db.query(`UPDATE custom_version_items_overlay SET modified_at_us = 1 WHERE id = $1`, [id]);

    await runtime.update("customVersionItems", { id }, { title: "v2" });

    const rows = await db.query<{ title: string; modifiedAtUs: string | null }>(
      `SELECT title, modified_at_us::text AS "modifiedAtUs" FROM custom_version_items_overlay WHERE id = $1`,
      [id],
    );
    expect(rows.rows[0]?.title).toBe("v2");
    // The on-update stamp targeted `modified_at_us` generically (not a hard-coded `updatedAtUs`),
    // overwriting the sentinel with a fresh now-microseconds value.
    expect(Number(rows.rows[0]?.modifiedAtUs)).toBeGreaterThan(1);

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
      FROM authors_read_model
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

  it("trigger clears acked journal and overlay when synced data arrives", async () => {
    const { db, runtime } = await createOverlayTestContext();

    await runtime.create("todos", {
      id: "01963227-d4c7-72db-b858-f89f6af8f994",
      title: "Trigger test",
      description: null,
      authorId: "01963227-d4c7-72db-b858-f89f6af8f920",
      status: "todo",
      priority: "medium",
    });

    // Step 1: simulate ack — journal entry is acked
    await db.query(
      `UPDATE todos_mutations SET status = 'acked', server_updated_at_us = $2::bigint WHERE id = $1 AND mutation_seq = 1`,
      ["01963227-d4c7-72db-b858-f89f6af8f994", "500"],
    );

    // Step 2: write synced data — the trigger fires and clears overlay + journal
    await db.query(
      `INSERT INTO todos (id, title, description, author_id, status, priority, created_at_us, updated_at_us) VALUES ($1, $2, $3, $4, $5, $6, $7::bigint, $8::bigint)`,
      [
        "01963227-d4c7-72db-b858-f89f6af8f994",
        "Trigger test",
        null,
        "01963227-d4c7-72db-b858-f89f6af8f920",
        "todo",
        "medium",
        "400",
        "600",
      ],
    );

    // Step 3: verify trigger cleared everything — no explicit reconcile() call needed
    const stats = await runtime.readMutationStats("todos");
    expect(stats.ackedCount).toBe(0);

    const overlayRows = await db.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM todos_overlay");
    expect(overlayRows.rows[0]?.count).toBe(0);
  });

  it("holds the optimistic overlay until the synced echo reaches the acked Server version (ADR-0010 barrier)", async () => {
    const { db, runtime } = await createOverlayTestContext();

    const id = "01963227-d4c7-72db-b858-f89f6af8f9b0";
    await runtime.create("todos", {
      id,
      title: "Barrier test",
      description: null,
      authorId: "01963227-d4c7-72db-b858-f89f6af8f920",
      status: "todo",
      priority: "medium",
    });

    // Ack at Server version 500.
    await db.query(
      `UPDATE todos_mutations SET status = 'acked', server_updated_at_us = 500 WHERE id = $1 AND mutation_seq = 1`,
      [id],
    );

    // A STALE echo (older Server version 400 < 500) must NOT clear the optimistic write — the
    // overlay and the acked journal entry both survive (the regression the barrier exists to catch).
    await db.query(
      `INSERT INTO todos (id, title, description, author_id, status, priority, created_at_us, updated_at_us) VALUES ($1, $2, $3, $4, $5, $6, $7::bigint, $8::bigint)`,
      [id, "Stale server row", null, "01963227-d4c7-72db-b858-f89f6af8f920", "todo", "medium", "100", "400"],
    );

    expect((await db.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM todos_overlay")).rows[0]?.count).toBe(
      1,
    );
    expect((await runtime.readMutationStats("todos")).ackedCount).toBe(1);

    // The real echo (Server version 600 >= 500) crosses the barrier and clears overlay + journal.
    await db.query(`UPDATE todos SET updated_at_us = 600 WHERE id = $1`, [id]);

    expect((await db.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM todos_overlay")).rows[0]?.count).toBe(
      0,
    );
    expect((await runtime.readMutationStats("todos")).ackedCount).toBe(0);

    await db.close();
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
      UPDATE todos_mutations
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

    const overlayRows = await db.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM todos_overlay");
    expect(overlayRows.rows[0]?.count).toBe(0);
  });

  it("returns microsecond timestamps as decimal strings", () => {
    expect(nowMicroseconds()).toMatch(/^[0-9]+$/);
  });

  it("computes bounded retry backoff metadata", () => {
    expect(computeBackoffDelayMs(1)).toBe(1000);
    expect(computeBackoffDelayMs(2)).toBe(2000);
    expect(computeBackoffDelayMs(10)).toBe(30000);
  });

  it("applies equal jitter around the backoff ceiling (ADR-0005 congestion policy)", () => {
    // Equal jitter: half the ceiling, plus a random share of the other half.
    expect(computeRetryDelayMs(2, () => 0)).toBe(1000); // floor = ceiling / 2
    expect(computeRetryDelayMs(2, () => 1)).toBe(2000); // ceiling
    expect(computeRetryDelayMs(2, () => 0.5)).toBe(1500); // midpoint
    // next-retry timestamp threads the same jitter (us = nowUs + delayMs * 1000).
    expect(computeNextRetryAtUs("1000", 2, () => 0)).toBe("1001000");
    expect(computeNextRetryAtUs("1000", 2, () => 1)).toBe("2001000");
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
      FROM todos_overlay
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

    const visibleRows = await db.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM todos_read_model");
    expect(visibleRows.rows[0]?.count).toBe(0);

    const overlays = await db.query<{ overlayKind: string }>(
      `SELECT overlay_kind AS "overlayKind" FROM todos_overlay WHERE id = $1`,
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
      `SELECT overlay_kind AS "overlayKind" FROM authors_read_model WHERE id = $1`,
      ["01963227-d4c7-72db-b858-f89f6af8f937"],
    );
    const todoRows = await db.query<{ overlayKind: string }>(
      `SELECT overlay_kind AS "overlayKind" FROM todos_read_model WHERE id = $1`,
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
      `SELECT title, status FROM todos_overlay WHERE id = $1`,
      [todoId],
    );
    const mutations = await runtime.readMutationDetails("todos");

    expect(overlayRows.rows[0]).toEqual({
      title: "First in batch",
      status: "done",
    });
    expect(
      mutations
        .filter((mutation) => mutation.entityKey["id"] === todoId)
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
        FROM todos_mutations
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
      "SELECT COUNT(*)::int AS count FROM todos_read_model WHERE id = $1",
      [todoId],
    );
    expect(visibleRows.rows[0]?.count).toBe(0);

    const overlays = await db.query<{ overlayKind: string }>(
      `SELECT overlay_kind AS "overlayKind" FROM todos_overlay WHERE id = $1`,
      [todoId],
    );
    expect(overlays.rows[0]?.overlayKind).toBe("pending_delete");

    const mutations = await runtime.readMutationDetails("todos");
    expect(
      mutations
        .filter((mutation) => mutation.entityKey["id"] === todoId)
        .map((mutation) => ({ kind: mutation.mutationKind, seq: mutation.mutationSeq })),
    ).toEqual([
      { kind: "delete", seq: 2 },
      { kind: "create", seq: 1 },
    ]);
  });

  it("rolls back semantic batch failures after an in-batch delete", async () => {
    const { db, runtime } = await createOverlayTestContext();
    const todoId = "01963227-d4c7-72db-b858-f89f6af8f943";

    // oxlint-disable-next-line typescript/await-thenable -- bun-types gap: .resolves/.rejects matchers return a real promise typed as void
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
      db.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM todos_overlay WHERE id = $1", [todoId]),
      db.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM todos_mutations WHERE id = $1", [todoId]),
    ]);

    expect(overlayRows.rows[0]?.count).toBe(0);
    expect(mutationRows.rows[0]?.count).toBe(0);
  });

  it("rejects invalid local batches without partial journaling", async () => {
    const { db, runtime } = await createOverlayTestContext();

    // oxlint-disable-next-line typescript/await-thenable -- bun-types gap: .resolves/.rejects matchers return a real promise typed as void
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
            title: "x".repeat(200),
            description: null,
            authorId: "01963227-d4c7-72db-b858-f89f6af8f940",
            status: "todo",
            priority: "medium",
          },
        },
      ]),
    ).rejects.toThrow(/value too long for type character varying/);

    const [authorOverlay, authorJournal, todoOverlay, todoJournal] = await Promise.all([
      db.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM authors_overlay"),
      db.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM authors_mutations"),
      db.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM todos_overlay"),
      db.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM todos_mutations"),
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
      UPDATE todos_mutations
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
    // Delete mutations are acked and cleared by reconcile.
    // Create mutations remain pending (no server_updated_at_us).
    expect(stats.pendingCount).toBe(2);
    expect(stats.ackedCount).toBe(0);

    const overlays = await db.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM todos_overlay");
    expect(overlays.rows[0]?.count).toBe(0);

    const journal = await db.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM todos_mutations");
    // Create mutations remain in journal as pending
    expect(journal.rows[0]?.count).toBe(2);
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
      `SELECT title, status FROM todos_overlay WHERE id = $1`,
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
      `SELECT title, status, overlay_kind AS "overlayKind" FROM todos_overlay WHERE id = $1`,
      ["01963227-d4c7-72db-b858-f89f6af8f909"],
    );

    expect(overlayRows.rows[0]).toEqual({
      title: "Updated before sync",
      status: "done",
      overlayKind: "pending_create",
    });

    const visibleRows = await db.query<{ title: string; status: string; overlayKind: string }>(
      `SELECT title, status, overlay_kind AS "overlayKind" FROM todos_read_model WHERE id = $1`,
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
      CREATE TABLE todos_mutations (
        mutation_id UUID PRIMARY KEY,
        todo_id UUID NOT NULL,
        entity_key_json TEXT NOT NULL,
        mutation_seq INTEGER NOT NULL,
        mutation_kind VARCHAR(24) NOT NULL,
        status VARCHAR(24) NOT NULL,
        registry_version TEXT,
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
        INSERT INTO todos_mutations (
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
        UPDATE authors_mutations
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

  it("forwards auth headers on batch mutation flushes", async () => {
    const db = await createSchemaTestPGlite(overlaySchemaSql);

    const runtime = createMutationRuntime({
      db,
      registry: demoSyncRegistry,
      writeUrl,
      getAuthToken: async () => "demo-token",
    });

    const originalFetch = globalThis.fetch;
    const fetchMock = mock(async (input) => {
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

    globalThis.fetch = fetchMock as unknown as typeof fetch;

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
    const db = await createSchemaTestPGlite(overlaySchemaSql);

    const runtime = createMutationRuntime({
      db,
      registry: demoSyncRegistry,
      writeUrl,
    });

    const originalFetch = globalThis.fetch;
    let resolveFetch!: () => void;
    const fetchRelease = new Promise<void>((resolve) => {
      resolveFetch = resolve;
    });
    const fetchMock = mock(async (input) => {
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

    globalThis.fetch = fetchMock as unknown as typeof fetch;

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
    const db = await createSchemaTestPGlite(overlaySchemaSql);

    const runtime = createMutationRuntime({
      db,
      registry: demoSyncRegistry,
      writeUrl,
    });

    const originalFetch = globalThis.fetch;
    const fetchMock = mock(async (_input, init) => {
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

    globalThis.fetch = fetchMock as unknown as typeof fetch;

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
    const db = await createSchemaTestPGlite(overlaySchemaSql);

    // A small flush slice exercises the multi-slice drain (3 HTTP rounds) with 15 mutations instead
    // of 205 — the behaviour under test is the slicing, not the count.
    const flushBatchSize = 5;
    const runtime = createMutationRuntime({
      db,
      registry: demoSyncRegistry,
      writeUrl,
      flushBatchSize,
    });

    const originalFetch = globalThis.fetch;
    const fetchMock = mock(async (_input, init) => {
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

    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      const mutationCount = flushBatchSize * 2 + 5;

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
      // ADR-0010: acked optimistic creates are HELD (not cleared) until the synced echo reaches
      // their acked Server version. No echo is simulated here, so every drained mutation remains
      // acked-but-unobserved — the barrier is exactly what stops a premature clear.
      expect(mutationStats.ackedCount).toBe(mutationCount);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("reconciles acknowledged batch updates after the full drain completes", async () => {
    const db = await createSchemaTestPGlite(overlaySchemaSql);

    // Small flush slice: 6 mutations across 2 HTTP rounds, not 101 — same multi-slice drain.
    const flushBatchSize = 5;
    const runtime = createMutationRuntime({
      db,
      registry: demoSyncRegistry,
      writeUrl,
      flushBatchSize,
    });
    const mutationCount = flushBatchSize + 1;

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
    const fetchMock = mock(async (_input, init) => {
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

    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      await runtime.flush("authors");
      await runtime.reconcile("authors");

      const mutationStats = await runtime.readMutationStats("authors");
      const overlays = await db.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM authors_overlay");

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(mutationStats.pendingCount).toBe(0);
      expect(mutationStats.ackedCount).toBe(0);
      expect(overlays.rows[0]?.count).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("applies mixed batch acknowledgements without row-by-row status drift", async () => {
    const db = await createSchemaTestPGlite(overlaySchemaSql);

    const runtime = createMutationRuntime({
      db,
      registry: demoSyncRegistry,
      writeUrl,
    });

    const originalFetch = globalThis.fetch;
    const fetchMock = mock(async (_input, init) => {
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

    globalThis.fetch = fetchMock as unknown as typeof fetch;

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
      const mutationById = new Map(mutations.map((mutation) => [mutation.entityKey["id"], mutation]));

      // ADR-0010: the acked create is HELD (status 'acked') until its synced echo arrives — none is
      // simulated here, so it is not cleared. The 409 `conflicted` ack is the distinct stale-write
      // outcome (ADR-0015): it lands in the terminal `conflicted` state — NOT quarantined — keeping
      // its conflict metadata. The point: the two statuses apply without row-by-row drift.
      expect(mutationById.get("01963227-d4c7-72db-b858-f89f6af8f970")?.status).toBe("acked");
      expect(mutationById.get("01963227-d4c7-72db-b858-f89f6af8f971")?.status).toBe("conflicted");
      expect(mutationById.get("01963227-d4c7-72db-b858-f89f6af8f971")?.conflictReason).toBe("duplicate name");
      expect(mutationById.get("01963227-d4c7-72db-b858-f89f6af8f971")?.lastHttpStatus).toBe(409);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("canonical entity identity — property≠column PK (ADR-0012)", () => {
  it("persists the column-keyed identity in the journal for create and update", async () => {
    const db = await createFreshTestPGlite();
    await db.exec(generateLocalSchemaSql(renamedPkRegistry));
    const runtime = createMutationRuntime({ db, registry: renamedPkRegistry, writeUrl });

    const groupId = "30000000-0000-4000-8000-00000000000a";
    await runtime.create("renamedPk", { groupId, label: "first" });
    await runtime.update("renamedPk", { groupId }, { label: "second" });

    // The journal's real PK column is populated, and entity_key_json is the canonical
    // column-keyed identity ({ group_id }), never the drizzle property ({ groupId }).
    const journal = await db.query<{ groupId: string; entityKeyJson: string }>(
      `SELECT group_id AS "groupId", entity_key_json AS "entityKeyJson"
         FROM renamed_pk_items_mutations ORDER BY mutation_seq`,
    );
    expect(journal.rows).toHaveLength(2);
    for (const row of journal.rows) {
      expect(row.groupId).toBe(groupId);
      expect(JSON.parse(row.entityKeyJson)).toEqual({ group_id: groupId });
    }

    // readMutationDetails surfaces the same canonical identity past the boundary.
    const details = await runtime.readMutationDetails("renamedPk");
    for (const detail of details) {
      expect(detail.entityKey).toEqual({ group_id: groupId });
    }
  });
});
