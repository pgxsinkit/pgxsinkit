import { describe, expect, it } from "bun:test";
import { mock } from "bun:test";

import { and, asc, count, eq, inArray, sql } from "drizzle-orm";
import { bigint, boolean, text, uuid, varchar, type PgColumn } from "drizzle-orm/pg-core";

import { getJournalTable, getOverlayTable } from "@pgxsinkit/client";
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
import { createTablesFromSchema, drizzleOver } from "../support/drizzle";
import { createFreshTestPGlite, createSchemaTestPGlite } from "../support/pglite";

const overlaySchemaSql = generateLocalSchemaSql(demoSyncRegistry);
const batchWriteUrl = "http://localhost:3001/api/mutations";

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

// A writable table with an `authClaim` create-managed field that is NOT NULL (owner/author/created_by —
// the board's `message.author_id`). The field is stripped from the create input (the server stamps it
// from the `sub` claim), so the optimistic overlay must fill it from the decoded claim or the overlay
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
        { column: "ownerId", applyOn: ["create"], strategy: "authClaim", claimPath: ["sub"] },
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
      batchWriteUrl,
    }),
  };
}

describe("overlay state helpers", () => {
  it("builds optimistic todos with bigint microsecond timestamps", () => {
    const runtime = createMutationRuntime({
      db: {} as never,
      registry: demoSyncRegistry,
      batchWriteUrl,
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
      batchWriteUrl,
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
      batchWriteUrl,
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
      batchWriteUrl,
    });

    // Omit `researchExcluded` and `channel` — both are NOT NULL with defaults. Before the
    // fix the overlay INSERT passed explicit NULLs and violated the NOT NULL constraint.
    await runtime.create("defaultedColumnItems", {
      id: "01963227-d4c7-72db-b858-f89f6af8fa01",
      title: "Defaults filled locally",
      createdAtUs: 100n,
    });

    const overlay = getOverlayTable(defaultedColumnRegistry, "defaultedColumnItems");
    const overlayRows = await drizzleOver(db)
      .select({
        researchExcluded: overlay.researchExcluded,
        channel: overlay.channel,
        overlayKind: overlay.overlayKind,
      })
      .from(overlay)
      .where(eq(overlay.id, "01963227-d4c7-72db-b858-f89f6af8fa01"));

    expect(overlayRows[0]).toEqual({
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
      batchWriteUrl,
    });

    await runtime.create("defaultedColumnItems", {
      id: "01963227-d4c7-72db-b858-f89f6af8fa02",
      title: "Explicit values win",
      researchExcluded: true,
      channel: "explicit-channel",
      createdAtUs: 100n,
    });

    const overlay = getOverlayTable(defaultedColumnRegistry, "defaultedColumnItems");
    const overlayRows = await drizzleOver(db)
      .select({
        researchExcluded: overlay.researchExcluded,
        channel: overlay.channel,
      })
      .from(overlay)
      .where(eq(overlay.id, "01963227-d4c7-72db-b858-f89f6af8fa02"));

    expect(overlayRows[0]).toEqual({
      researchExcluded: true,
      channel: "explicit-channel",
    });

    await db.close();
  });

  it("materialises a custom-named Server version on optimistic create (governance-driven, not by convention) — finding 4", async () => {
    const db = await createFreshTestPGlite();
    await db.exec(generateLocalSchemaSql(customServerVersionRegistry));
    const runtime = createMutationRuntime({ db, registry: customServerVersionRegistry, batchWriteUrl });

    // `modifiedAtUs` is a managed-on-create field, so it is omitted from the create input; the
    // optimistic overlay must fill it from governance. Before finding 4 the convention-only fill left
    // it NULL → NOT NULL violation on the overlay INSERT.
    await runtime.create("customVersionItems", {
      id: "01963227-d4c7-72db-b858-f89f6af8fb01",
      title: "Custom version field",
    });

    const overlay = getOverlayTable(customServerVersionRegistry, "customVersionItems");
    const rows = await drizzleOver(db)
      .select({ modifiedAtUs: sql<string | null>`${overlay.modifiedAtUs}::text`.as("modifiedAtUs") })
      .from(overlay)
      .where(eq(overlay.id, "01963227-d4c7-72db-b858-f89f6af8fb01"));
    expect(rows[0]?.modifiedAtUs).not.toBeNull();
    expect(Number(rows[0]?.modifiedAtUs)).toBeGreaterThan(0);

    await db.close();
  });

  it("stamps an authClaim create-managed field into the optimistic overlay from the decoded claim — board Phase 7", async () => {
    const db = await createFreshTestPGlite();
    await db.exec(generateLocalSchemaSql(authOwnedRegistry));
    const subject = "01963227-d4c7-72db-b858-f89f6af8fc10";
    const runtime = createMutationRuntime({
      db,
      registry: authOwnedRegistry,
      batchWriteUrl,
      getAuthToken: async () => fakeJwtWithSub(subject),
    });

    // `ownerId` is an authClaim create-managed field (claimPath ["sub"]), so it is stripped from the
    // create input. Before the fix the overlay INSERT passed an explicit NULL → NOT NULL violation; now
    // it is filled from the decoded `sub` claim so the local row is attributed immediately.
    await runtime.create("authOwnedItems", {
      id: "01963227-d4c7-72db-b858-f89f6af8fc01",
      body: "optimistic message",
    });

    const overlay = getOverlayTable(authOwnedRegistry, "authOwnedItems");
    const rows = await drizzleOver(db)
      .select({ ownerId: overlay.ownerId, overlayKind: overlay.overlayKind })
      .from(overlay)
      .where(eq(overlay.id, "01963227-d4c7-72db-b858-f89f6af8fc01"));
    expect(rows[0]).toEqual({ ownerId: subject, overlayKind: "pending_create" });

    // The server stamps the claim authoritatively, so the flushed payload must NOT carry the
    // authClaim field — the server rejects a payload that includes a server-managed field.
    const journalTable = getJournalTable(authOwnedRegistry, "authOwnedItems");
    const journal = await drizzleOver(db)
      .select({ payloadJson: journalTable.payloadJson })
      .from(journalTable)
      .where(eq(journalTable["id"]!, "01963227-d4c7-72db-b858-f89f6af8fc01"));
    const payload = JSON.parse(journal[0]!.payloadJson) as { value: Record<string, unknown> };
    expect(payload.value).not.toHaveProperty("ownerId");

    await db.close();
  });

  it("re-stamps a custom-named Server version on optimistic update — finding 4", async () => {
    const db = await createFreshTestPGlite();
    await db.exec(generateLocalSchemaSql(customServerVersionRegistry));
    const runtime = createMutationRuntime({ db, registry: customServerVersionRegistry, batchWriteUrl });

    const id = "01963227-d4c7-72db-b858-f89f6af8fb02";
    await runtime.create("customVersionItems", { id, title: "v1" });

    // Force a known-stale managed value so a successful re-stamp is unmistakable (the wall clock is
    // millisecond-grained, so a fresh create+update could otherwise share a value).
    const overlay = getOverlayTable(customServerVersionRegistry, "customVersionItems");
    await drizzleOver(db).update(overlay).set({ modifiedAtUs: 1n }).where(eq(overlay.id, id));

    await runtime.update("customVersionItems", { id }, { title: "v2" });

    const rows = await drizzleOver(db)
      .select({
        title: overlay.title,
        modifiedAtUs: sql<string | null>`${overlay.modifiedAtUs}::text`.as("modifiedAtUs"),
      })
      .from(overlay)
      .where(eq(overlay.id, id));
    expect(rows[0]?.title).toBe("v2");
    // The on-update stamp targeted `modified_at_us` generically (not a hard-coded `updatedAtUs`),
    // overwriting the sentinel with a fresh now-microseconds value.
    expect(Number(rows[0]?.modifiedAtUs)).toBeGreaterThan(1);

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
      batchWriteUrl,
    });

    await drizzleOver(db).insert(registry[tableName]!.localTable).values({
      id: rowId,
      field00: "seed-0",
      field01: "seed-1",
      ownerId: "11111111-1111-4111-8111-111111111111",
      modifiedBy: "11111111-1111-4111-8111-111111111111",
      status: "todo",
      priority: "medium",
      createdAtUs: 100n,
      updatedAtUs: 100n,
    });

    await runtime.update(
      tableName,
      { id: rowId },
      {
        field00: "updated-field",
        status: "done",
      },
    );

    const overlay = getOverlayTable(registry, tableName);
    const overlayRows = await drizzleOver(db)
      .select({
        field00: sql<string>`${overlay["field00"]!}`.as("field00"),
        status: sql<string>`${overlay["status"]!}`.as("status"),
        overlayKind: overlay.overlayKind,
      })
      .from(overlay)
      .where(eq(overlay["id"]!, rowId));

    expect(overlayRows[0]).toEqual({
      field00: "updated-field",
      status: "done",
      overlayKind: "pending_update",
    });

    const view = registry[tableName]!.view!;
    const viewCols = view as unknown as Record<string, PgColumn>;
    const visibleRows = await drizzleOver(db)
      .select({
        overlayKind: viewCols["overlay_kind"]!,
        localUpdatedAtUs: sql<string>`${viewCols["local_updated_at_us"]!}::text`.as("localUpdatedAtUs"),
      })
      .from(view)
      .where(eq(viewCols["id"]!, rowId));

    expect(visibleRows[0]?.overlayKind).toBe("pending_update");
    expect(visibleRows[0]?.localUpdatedAtUs).toMatch(/^[0-9]+$/);
  });

  it("queues authors into the local read model and author journal", async () => {
    const { db, runtime } = await createOverlayTestContext();

    await runtime.create("authors", {
      id: "01963227-d4c7-72db-b858-f89f6af8f931",
      name: "Ada Lovelace",
    });

    const authorsView = demoSyncRegistry.authors.view!;
    const authorRows = await drizzleOver(db)
      .select({ name: authorsView.name, overlayKind: authorsView.overlay_kind })
      .from(authorsView)
      .where(eq(authorsView.id, "01963227-d4c7-72db-b858-f89f6af8f931"));

    expect(authorRows[0]).toEqual({
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
    const todosJournal = getJournalTable(demoSyncRegistry, "todos");
    await drizzleOver(db)
      .update(todosJournal)
      .set({ status: "acked", serverUpdatedAtUs: "500" })
      .where(and(eq(todosJournal["id"]!, "01963227-d4c7-72db-b858-f89f6af8f994"), eq(todosJournal.mutationSeq, 1)));

    // Step 2: write synced data — the trigger fires and clears overlay + journal
    await drizzleOver(db).insert(demoSyncRegistry.todos.localTable).values({
      id: "01963227-d4c7-72db-b858-f89f6af8f994",
      title: "Trigger test",
      description: null,
      authorId: "01963227-d4c7-72db-b858-f89f6af8f920",
      status: "todo",
      priority: "medium",
      createdAtUs: 400n,
      updatedAtUs: 600n,
    });

    // Step 3: verify trigger cleared everything — no explicit reconcile() call needed
    const stats = await runtime.readMutationStats("todos");
    expect(stats.ackedCount).toBe(0);

    const todosOverlay = getOverlayTable(demoSyncRegistry, "todos");
    const overlayRows = await drizzleOver(db).select({ count: count() }).from(todosOverlay);
    expect(overlayRows[0]?.count).toBe(0);
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
    const todosJournal = getJournalTable(demoSyncRegistry, "todos");
    const todosOverlay = getOverlayTable(demoSyncRegistry, "todos");
    const todosTable = demoSyncRegistry.todos.localTable;
    await drizzleOver(db)
      .update(todosJournal)
      .set({ status: "acked", serverUpdatedAtUs: "500" })
      .where(and(eq(todosJournal["id"]!, id), eq(todosJournal.mutationSeq, 1)));

    // A STALE echo (older Server version 400 < 500) must NOT clear the optimistic write — the
    // overlay and the acked journal entry both survive (the regression the barrier exists to catch).
    await drizzleOver(db).insert(todosTable).values({
      id,
      title: "Stale server row",
      description: null,
      authorId: "01963227-d4c7-72db-b858-f89f6af8f920",
      status: "todo",
      priority: "medium",
      createdAtUs: 100n,
      updatedAtUs: 400n,
    });

    expect((await drizzleOver(db).select({ count: count() }).from(todosOverlay))[0]?.count).toBe(1);
    expect((await runtime.readMutationStats("todos")).ackedCount).toBe(1);

    // The real echo (Server version 600 >= 500) crosses the barrier and clears overlay + journal.
    await drizzleOver(db).update(todosTable).set({ updatedAtUs: 600n }).where(eq(todosTable.id, id));

    expect((await drizzleOver(db).select({ count: count() }).from(todosOverlay))[0]?.count).toBe(0);
    expect((await runtime.readMutationStats("todos")).ackedCount).toBe(0);

    await db.close();
  });

  it("reconciles multiple acknowledged overlays in one pass", async () => {
    const { db, runtime } = await createOverlayTestContext();

    const rowIds = ["01963227-d4c7-72db-b858-f89f6af8f980", "01963227-d4c7-72db-b858-f89f6af8f981"];
    for (const rowId of rowIds) {
      await drizzleOver(db)
        .insert(demoSyncRegistry.todos.localTable)
        .values({
          id: rowId,
          title: `Synced ${rowId}`,
          description: null,
          authorId: "01963227-d4c7-72db-b858-f89f6af8f920",
          status: "todo",
          priority: "medium",
          createdAtUs: 100n,
          updatedAtUs: 500n,
        });

      await runtime.update(
        "todos",
        { id: rowId },
        {
          status: "done",
        },
      );
    }

    const todosJournal = getJournalTable(demoSyncRegistry, "todos");
    await drizzleOver(db)
      .update(todosJournal)
      .set({ status: "acked", serverUpdatedAtUs: "500", updatedAtUs: "500" })
      .where(inArray(todosJournal["id"]!, rowIds));

    await runtime.reconcile("todos");

    const stats = await runtime.readMutationStats("todos");
    expect(stats.ackedCount).toBe(0);

    const overlayRows = await drizzleOver(db)
      .select({ count: count() })
      .from(getOverlayTable(demoSyncRegistry, "todos"));
    expect(overlayRows[0]?.count).toBe(0);
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

    await drizzleOver(db).insert(demoSyncRegistry.todos.localTable).values({
      id: "01963227-d4c7-72db-b858-f89f6af8f995",
      title: "Original",
      description: null,
      authorId: "01963227-d4c7-72db-b858-f89f6af8f920",
      status: "todo",
      priority: "medium",
      createdAtUs: 100n,
      updatedAtUs: 100n,
    });

    await runtime.update(
      "todos",
      { id: "01963227-d4c7-72db-b858-f89f6af8f995" },
      {
        status: "done",
        title: "Updated",
      },
    );

    const todosOverlay = getOverlayTable(demoSyncRegistry, "todos");
    const overlayRows = await drizzleOver(db)
      .select({
        title: todosOverlay.title,
        status: todosOverlay.status,
        overlayKind: todosOverlay.overlayKind,
      })
      .from(todosOverlay)
      .where(eq(todosOverlay.id, "01963227-d4c7-72db-b858-f89f6af8f995"));

    expect(overlayRows[0]).toEqual({
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

    const visibleRows = await drizzleOver(db).select({ count: count() }).from(demoSyncRegistry.todos.view!);
    expect(visibleRows[0]?.count).toBe(0);

    const todosOverlay = getOverlayTable(demoSyncRegistry, "todos");
    const overlays = await drizzleOver(db)
      .select({ overlayKind: todosOverlay.overlayKind })
      .from(todosOverlay)
      .where(eq(todosOverlay.id, "01963227-d4c7-72db-b858-f89f6af8f996"));
    expect(overlays[0]?.overlayKind).toBe("pending_delete");

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

    const authorsView = demoSyncRegistry.authors.view!;
    const todosView = demoSyncRegistry.todos.view!;
    const authorRows = await drizzleOver(db)
      .select({ overlayKind: authorsView.overlay_kind })
      .from(authorsView)
      .where(eq(authorsView.id, "01963227-d4c7-72db-b858-f89f6af8f937"));
    const todoRows = await drizzleOver(db)
      .select({ overlayKind: todosView.overlay_kind })
      .from(todosView)
      .where(eq(todosView.id, "01963227-d4c7-72db-b858-f89f6af8f938"));

    expect(authorRows[0]?.overlayKind).toBe("pending_create");
    expect(todoRows[0]?.overlayKind).toBe("pending_create");

    const authorStats = await runtime.readMutationStats("authors");
    const todoStats = await runtime.readMutationStats("todos");

    expect(authorStats.pendingCount).toBe(1);
    expect(todoStats.pendingCount).toBe(1);
  });

  it("allocates per-entity mutation sequences inside a local batch", async () => {
    const { db, runtime } = await createOverlayTestContext();
    const todoId = "01963227-d4c7-72db-b858-f89f6af8f939";

    await drizzleOver(db).insert(demoSyncRegistry.todos.localTable).values({
      id: todoId,
      title: "Seeded todo",
      description: null,
      authorId: "01963227-d4c7-72db-b858-f89f6af8f920",
      status: "todo",
      priority: "medium",
      createdAtUs: 100n,
      updatedAtUs: 100n,
    });

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

    const todosOverlay = getOverlayTable(demoSyncRegistry, "todos");
    const overlayRows = await drizzleOver(db)
      .select({
        title: todosOverlay.title,
        status: todosOverlay.status,
      })
      .from(todosOverlay)
      .where(eq(todosOverlay.id, todoId));
    const mutations = await runtime.readMutationDetails("todos");

    expect(overlayRows[0]).toEqual({
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

    await drizzleOver(db)
      .insert(demoSyncRegistry.todos.localTable)
      .values([
        {
          id: firstTodoId,
          title: "First seeded todo",
          description: null,
          authorId: "01963227-d4c7-72db-b858-f89f6af8f920",
          status: "todo",
          priority: "medium",
          createdAtUs: 100n,
          updatedAtUs: 100n,
        },
        {
          id: secondTodoId,
          title: "Second seeded todo",
          description: null,
          authorId: "01963227-d4c7-72db-b858-f89f6af8f920",
          status: "todo",
          priority: "medium",
          createdAtUs: 100n,
          updatedAtUs: 100n,
        },
      ]);

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

    const todosJournal = getJournalTable(demoSyncRegistry, "todos");
    const journalRows = await drizzleOver(db)
      .select({ id: sql<string>`${todosJournal["id"]!}`.as("id"), mutationSeq: todosJournal.mutationSeq })
      .from(todosJournal)
      .orderBy(asc(todosJournal.mutationSeq));

    expect(journalRows).toEqual([
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

    const todosView = demoSyncRegistry.todos.view!;
    const visibleRows = await drizzleOver(db)
      .select({ count: count() })
      .from(todosView)
      .where(eq(todosView.id, todoId));
    expect(visibleRows[0]?.count).toBe(0);

    const todosOverlay = getOverlayTable(demoSyncRegistry, "todos");
    const overlays = await drizzleOver(db)
      .select({ overlayKind: todosOverlay.overlayKind })
      .from(todosOverlay)
      .where(eq(todosOverlay.id, todoId));
    expect(overlays[0]?.overlayKind).toBe("pending_delete");

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

    const todosOverlay = getOverlayTable(demoSyncRegistry, "todos");
    const todosJournal = getJournalTable(demoSyncRegistry, "todos");
    const [overlayRows, mutationRows] = await Promise.all([
      drizzleOver(db).select({ count: count() }).from(todosOverlay).where(eq(todosOverlay.id, todoId)),
      drizzleOver(db).select({ count: count() }).from(todosJournal).where(eq(todosJournal["id"]!, todoId)),
    ]);

    expect(overlayRows[0]?.count).toBe(0);
    expect(mutationRows[0]?.count).toBe(0);
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
      drizzleOver(db).select({ count: count() }).from(getOverlayTable(demoSyncRegistry, "authors")),
      drizzleOver(db).select({ count: count() }).from(getJournalTable(demoSyncRegistry, "authors")),
      drizzleOver(db).select({ count: count() }).from(getOverlayTable(demoSyncRegistry, "todos")),
      drizzleOver(db).select({ count: count() }).from(getJournalTable(demoSyncRegistry, "todos")),
    ]);

    expect(authorOverlay[0]?.count).toBe(0);
    expect(authorJournal[0]?.count).toBe(0);
    expect(todoOverlay[0]?.count).toBe(0);
    expect(todoJournal[0]?.count).toBe(0);
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

    const todosJournal = getJournalTable(demoSyncRegistry, "todos");
    await drizzleOver(db)
      .update(todosJournal)
      .set({ status: "acked", updatedAtUs: "600", ackedAtUs: "600" })
      .where(
        and(
          eq(todosJournal.mutationKind, "delete"),
          inArray(todosJournal["id"]!, [
            "01963227-d4c7-72db-b858-f89f6af8f982",
            "01963227-d4c7-72db-b858-f89f6af8f983",
          ]),
        ),
      );

    await runtime.reconcile("todos");

    const stats = await runtime.readMutationStats("todos");
    // Delete mutations are acked and cleared by reconcile.
    // Create mutations remain pending (no server_updated_at_us).
    expect(stats.pendingCount).toBe(2);
    expect(stats.ackedCount).toBe(0);

    const overlays = await drizzleOver(db).select({ count: count() }).from(getOverlayTable(demoSyncRegistry, "todos"));
    expect(overlays[0]?.count).toBe(0);

    const journal = await drizzleOver(db).select({ count: count() }).from(todosJournal);
    // Create mutations remain in journal as pending
    expect(journal[0]?.count).toBe(2);
  });

  it("appends multiple queued updates for the same todo", async () => {
    const { db, runtime } = await createOverlayTestContext();

    await drizzleOver(db).insert(demoSyncRegistry.todos.localTable).values({
      id: "01963227-d4c7-72db-b858-f89f6af8f910",
      title: "Original",
      description: null,
      authorId: "01963227-d4c7-72db-b858-f89f6af8f920",
      status: "todo",
      priority: "medium",
      createdAtUs: 100n,
      updatedAtUs: 100n,
    });

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

    const todosOverlay = getOverlayTable(demoSyncRegistry, "todos");
    const overlayRows = await drizzleOver(db)
      .select({
        title: todosOverlay.title,
        status: todosOverlay.status,
      })
      .from(todosOverlay)
      .where(eq(todosOverlay.id, "01963227-d4c7-72db-b858-f89f6af8f910"));
    expect(overlayRows[0]).toEqual({
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

    const todosOverlay = getOverlayTable(demoSyncRegistry, "todos");
    const overlayRows = await drizzleOver(db)
      .select({
        title: todosOverlay.title,
        status: todosOverlay.status,
        overlayKind: todosOverlay.overlayKind,
      })
      .from(todosOverlay)
      .where(eq(todosOverlay.id, "01963227-d4c7-72db-b858-f89f6af8f909"));

    expect(overlayRows[0]).toEqual({
      title: "Updated before sync",
      status: "done",
      overlayKind: "pending_create",
    });

    const todosView = demoSyncRegistry.todos.view!;
    const visibleRows = await drizzleOver(db)
      .select({ title: todosView.title, status: todosView.status, overlayKind: todosView.overlay_kind })
      .from(todosView)
      .where(eq(todosView.id, "01963227-d4c7-72db-b858-f89f6af8f909"));

    expect(visibleRows[0]).toEqual({
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
      batchWriteUrl,
    });

    const todosJournal = getJournalTable(demoSyncRegistry, "todos");
    await createTablesFromSchema(db, { todosJournal });

    await drizzleOver(db)
      .insert(todosJournal)
      .values({
        mutationId: "01963227-d4c7-72db-b858-f89f6af8f997",
        id: "01963227-d4c7-72db-b858-f89f6af8f998",
        entityKeyJson: '{"id":"01963227-d4c7-72db-b858-f89f6af8f998"}',
        mutationSeq: 1,
        mutationKind: "update",
        status: "failed",
        registryVersion: "test-registry",
        payloadJson: '{"kind":"update","patch":{"status":"done"}}',
        attemptCount: 2,
        lastError: "boom",
        conflictReason: "409 conflict",
        enqueuedAtUs: "100",
        nextRetryAtUs: "1000",
        updatedAtUs: "1000",
      } as typeof todosJournal.$inferInsert);

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

    const sendingMutationId = (await runtime.readMutationDetails("authors"))[0]?.mutationId;
    const authorsJournal = getJournalTable(demoSyncRegistry, "authors");
    await drizzleOver(db)
      .update(authorsJournal)
      .set({ status: "sending", sentAtUs: "1000", updatedAtUs: "1000" })
      .where(eq(authorsJournal.mutationId, sendingMutationId!));

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
      batchWriteUrl,
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
        "http://localhost:3001/api/mutations",
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
      batchWriteUrl,
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

  it("uses an explicit batch endpoint as-is without appending implicit path segments", async () => {
    const db = await createSchemaTestPGlite(overlaySchemaSql);

    const runtime = createMutationRuntime({
      db,
      registry: demoSyncRegistry,
      batchWriteUrl,
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
        "http://localhost:3001/api/mutations",
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
      batchWriteUrl,
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
      batchWriteUrl,
      flushBatchSize,
    });
    const mutationCount = flushBatchSize + 1;

    for (let index = 0; index < mutationCount; index += 1) {
      const authorId = `01963227-d4c7-72db-b858-${(910000000000 + index).toString().padStart(12, "0")}`;

      await drizzleOver(db)
        .insert(demoSyncRegistry.authors.localTable)
        .values({ id: authorId, name: `Seeded Author ${index}`, createdAtUs: 100n, updatedAtUs: 100n });

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
      const overlays = await drizzleOver(db)
        .select({ count: count() })
        .from(getOverlayTable(demoSyncRegistry, "authors"));

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(mutationStats.pendingCount).toBe(0);
      expect(mutationStats.ackedCount).toBe(0);
      expect(overlays[0]?.count).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("applies mixed batch acknowledgements without row-by-row status drift", async () => {
    const db = await createSchemaTestPGlite(overlaySchemaSql);

    const runtime = createMutationRuntime({
      db,
      registry: demoSyncRegistry,
      batchWriteUrl,
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
    const runtime = createMutationRuntime({ db, registry: renamedPkRegistry, batchWriteUrl });

    const groupId = "30000000-0000-4000-8000-00000000000a";
    await runtime.create("renamedPk", { groupId, label: "first" });
    await runtime.update("renamedPk", { groupId }, { label: "second" });

    // The journal's real PK column is populated, and entity_key_json is the canonical
    // column-keyed identity ({ group_id }), never the drizzle property ({ groupId }).
    const journalTable = getJournalTable(renamedPkRegistry, "renamedPk");
    const journal = await drizzleOver(db)
      .select({
        groupId: sql<string>`${journalTable["group_id"]!}`.as("groupId"),
        entityKeyJson: journalTable.entityKeyJson,
      })
      .from(journalTable)
      .orderBy(asc(journalTable.mutationSeq));
    expect(journal).toHaveLength(2);
    for (const row of journal) {
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
