import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import type { PGlite } from "@electric-sql/pglite";
import { asc, count, eq, sql } from "drizzle-orm";
import { bigint, boolean, integer, jsonb, pgTable, text } from "drizzle-orm/pg-core";

import {
  applyInsertsToTable,
  applyMessagesToTableWithCopy,
  applyMessagesToTableWithJson,
} from "../../packages/client/src/sync/apply";
import { createTablesFromSchema, drizzleOver, makeApplyTarget } from "../support/drizzle";
import { createFreshTestPGlite } from "../support/pglite";

// Tier-① fixture tables for the ladder's ad-hoc apply targets. The appliers receive a resolved
// {@link ApplyTarget} built from the real `pgTable` via `makeApplyTarget` (ADR-0029 D1/D2), so the
// json/copy casts are always model-derived — never introspected from `information_schema`.
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
// correctly. The json/copy tiers take their casts from the resolved target's model-derived column
// types (ADR-0029 D2) — there is no `information_schema` round-trip to fall back to.

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

  it("json tier applies jsonb + bigint[] from model-derived column types (no information_schema)", async () => {
    await createTablesFromSchema(pg, { rich });

    await applyMessagesToTableWithJson({
      pg,
      target: makeApplyTarget(rich, ["id"]),
      messages: [
        insert("r1", { id: "r1", big: 100, nums: [1, 2, 3], doc: { a: 1 } }),
        insert("r2", { id: "r2", big: 200, nums: [4, 5], doc: { b: 2 } }),
      ],
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
        target: makeApplyTarget(rich, ["id"]),
        messages: [insert("r1", { id: "r1", big: 999, nums: [9], doc: { a: 9 } })],
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

  it("json tier applies camelCase columns + arrays from model-derived casts", async () => {
    await createTablesFromSchema(pg, { camelRich });

    await applyMessagesToTableWithJson({
      pg,
      target: makeApplyTarget(camelRich, ["id"]),
      messages: [insert("c1", { id: "c1", firstName: "Alice", tags: ["x", "y"] })],
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
      target: makeApplyTarget(copyTarget, ["id"]),
      messages: [
        insert("c1", { id: "c1", task: "task with, comma", done: false }),
        insert("c2", { id: "c2", task: 'task with "quotes"', done: true }),
      ],
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
      target: makeApplyTarget(scalars, ["id"]),
      messages: [insert("s1", { id: "s1", name: "first", count: 1 })],
      debug: false,
    });
    // oxlint-disable-next-line typescript/await-thenable -- bun-types gap: .resolves/.rejects matchers return a real promise typed as void
    await expect(
      applyInsertsToTable({
        pg,
        target: makeApplyTarget(scalars, ["id"]),
        messages: [insert("s1", { id: "s1", name: "second", count: 2 })],
        debug: false,
      }),
    ).rejects.toThrow();

    const result = await drizzleOver(pg).select().from(scalars);
    expect(result).toEqual([{ id: "s1", name: "first", count: 1 }]);
  });
});
