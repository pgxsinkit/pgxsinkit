import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import type { PGlite } from "@electric-sql/pglite";
import { asc, count, eq, sql } from "drizzle-orm";
import { bigint, boolean, integer, jsonb, pgTable, text } from "drizzle-orm/pg-core";

import type { SyncColumnType } from "@pgxsinkit/contracts";

import {
  applyInsertsToTable,
  applyMessagesToTableWithCopy,
  applyMessagesToTableWithJson,
} from "../../packages/client/src/sync/apply";
import { createTablesFromSchema, drizzleOver } from "../support/drizzle";
import { createFreshTestPGlite } from "../support/pglite";

// Tier-① fixture tables for the ladder's ad-hoc apply targets — the appliers still address them by
// name, so each pgTable name must match the string `table` argument below.
const rich = pgTable("rich", {
  id: text("id").primaryKey(),
  big: bigint("big", { mode: "bigint" }).notNull(),
  nums: bigint("nums", { mode: "bigint" }).array().notNull(),
  doc: jsonb("doc").notNull(),
});
const camelRich = pgTable("camelRich", {
  id: text("id").primaryKey(),
  firstName: text("firstName"),
  tags: text("tags").array(),
});
const copyTarget = pgTable("copy_target", {
  id: text("id").primaryKey(),
  task: text("task").notNull(),
  done: boolean("done").notNull(),
});
const scalars = pgTable("scalars", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  count: integer("count").notNull(),
});

// The static apply ladder (ADR-0009 decision 3) executing on the pinned PGlite: each tier applies
// correctly, the json tier builds its casts from registry-supplied column types (no
// information_schema round-trip), and the legacy information_schema fallback still works for callers
// that drive the engine without a registry.

interface InsertMsg {
  headers: { operation: "insert" };
  key: string;
  value: Record<string, unknown>;
}

const insert = (key: string, value: Record<string, unknown>): InsertMsg => ({
  headers: { operation: "insert" },
  key,
  value,
});

describe("apply ladder", () => {
  let pg: PGlite;

  beforeAll(async () => {
    pg = await createFreshTestPGlite();
  });

  afterAll(async () => {
    await pg.close();
  });

  it("json tier applies jsonb + bigint[] using supplied column types (no information_schema)", async () => {
    await createTablesFromSchema(pg, { rich });

    const columnTypes: SyncColumnType[] = [
      { name: "id", sqlType: "text", isArray: false },
      { name: "big", sqlType: "bigint", isArray: false },
      { name: "nums", sqlType: "bigint", isArray: true },
      { name: "doc", sqlType: "jsonb", isArray: false },
    ];

    await applyMessagesToTableWithJson({
      pg,
      table: "rich",
      messages: [
        insert("r1", { id: "r1", big: 100, nums: [1, 2, 3], doc: { a: 1 } }),
        insert("r2", { id: "r2", big: 200, nums: [4, 5], doc: { b: 2 } }),
      ],
      primaryKey: ["id"],
      columnTypes,
      debug: false,
    });

    // Re-read with deterministic text casts so the array/bigint comparison is stable across PGlite
    // return-type choices.
    const result = await drizzleOver(pg)
      .select({
        id: rich.id,
        big: sql<string>`${rich.big}::text`.as("big"),
        nums: sql<string>`${rich.nums}::text`.as("nums"),
        doc: rich.doc,
      })
      .from(rich)
      .orderBy(asc(rich.id));
    expect(result).toEqual([
      { id: "r1", big: "100", nums: "{1,2,3}", doc: { a: 1 } },
      { id: "r2", big: "200", nums: "{4,5}", doc: { b: 2 } },
    ]);

    // Operation-faithful: replaying an existing key fails instead of silently upserting.
    // oxlint-disable-next-line typescript/await-thenable -- bun-types gap: .resolves/.rejects matchers return a real promise typed as void
    await expect(
      applyMessagesToTableWithJson({
        pg,
        table: "rich",
        messages: [insert("r1", { id: "r1", big: 999, nums: [9], doc: { a: 9 } })],
        primaryKey: ["id"],
        columnTypes,
        debug: false,
      }),
    ).rejects.toThrow();

    const replayed = await drizzleOver(pg).select({ count: count() }).from(rich);
    expect(replayed[0]!.count).toBe(2);
    const r1 = await drizzleOver(pg)
      .select({
        big: sql<string>`${rich.big}::text`.as("big"),
        nums: sql<string>`${rich.nums}::text`.as("nums"),
      })
      .from(rich)
      .where(eq(rich.id, "r1"));
    // Original row untouched.
    expect(r1[0]).toEqual({ big: "100", nums: "{1,2,3}" });
  });

  it("json tier still works via the information_schema fallback when no column types are supplied", async () => {
    await createTablesFromSchema(pg, { camelRich });

    await applyMessagesToTableWithJson({
      pg,
      table: "camelRich",
      messages: [insert("c1", { id: "c1", firstName: "Alice", tags: ["x", "y"] })],
      primaryKey: ["id"],
      debug: false,
    });

    const result = await drizzleOver(pg)
      .select({
        id: camelRich.id,
        firstName: camelRich.firstName,
        tags: sql<string>`${camelRich.tags}::text`.as("tags"),
      })
      .from(camelRich);
    expect(result).toEqual([{ id: "c1", firstName: "Alice", tags: "{x,y}" }]);
  });

  it("copy tier runs COPY even for a table with a primary key (no PK guard), escaping special chars", async () => {
    // COPY needs no ON CONFLICT: an Electric `insert` is a new row (post-truncate or first send), so
    // it cannot legitimately collide. A primary key must NOT divert away from COPY.
    await createTablesFromSchema(pg, { copyTarget });

    await applyMessagesToTableWithCopy({
      pg,
      table: "copy_target",
      messages: [
        insert("c1", { id: "c1", task: "task with, comma", done: false }),
        insert("c2", { id: "c2", task: 'task with "quotes"', done: true }),
      ],
      primaryKey: ["id"],
      debug: false,
    });

    const result = await drizzleOver(pg).select().from(copyTarget).orderBy(asc(copyTarget.id));
    expect(result).toEqual([
      { id: "c1", task: "task with, comma", done: false },
      { id: "c2", task: 'task with "quotes"', done: true },
    ]);
  });

  it("insert tier applies scalar rows; a replayed primary key fails instead of upserting", async () => {
    await createTablesFromSchema(pg, { scalars });

    await applyInsertsToTable({
      pg,
      table: "scalars",
      messages: [insert("s1", { id: "s1", name: "first", count: 1 })],
      primaryKey: ["id"],
      debug: false,
    });
    // oxlint-disable-next-line typescript/await-thenable -- bun-types gap: .resolves/.rejects matchers return a real promise typed as void
    await expect(
      applyInsertsToTable({
        pg,
        table: "scalars",
        messages: [insert("s1", { id: "s1", name: "second", count: 2 })],
        primaryKey: ["id"],
        debug: false,
      }),
    ).rejects.toThrow();

    const result = await drizzleOver(pg).select().from(scalars);
    expect(result).toEqual([{ id: "s1", name: "first", count: 1 }]);
  });
});
