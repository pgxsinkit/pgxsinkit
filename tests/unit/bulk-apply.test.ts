import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import type { PGlite } from "@electric-sql/pglite";
import { asc, sql } from "drizzle-orm";
import { bigint, integer, pgTable, primaryKey, text } from "drizzle-orm/pg-core";

import {
  applyBulkDeletesToTable,
  applyBulkUpdatesToTable,
  applyInsertsToTable,
  applyMessageToTable,
  applyUpsertsToTable,
} from "../../packages/client/src/sync/apply";
import { foldChangeBatch } from "../../packages/client/src/sync/shape-inbox";
import { createTablesFromSchema, drizzleOver } from "../support/drizzle";
import { createFreshTestPGlite } from "../support/pglite";

// Tier-① fixture tables for the ad-hoc apply targets — the appliers still address them by name, so the
// pgTable names must match the string `table` arguments below.
const delAuthors = pgTable("del_authors", { id: text("id").primaryKey(), name: text("name").notNull() });
const updAuthors = pgTable("upd_authors", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  score: integer("score").notNull(),
});
const bn = pgTable("bn", {
  id: text("id").primaryKey(),
  updatedAtUs: bigint("updated_at_us", { mode: "bigint" }).notNull(),
  marks: bigint("marks", { mode: "bigint" }).array().notNull(),
});
const parts = pgTable(
  "parts",
  { org: text("org").notNull(), sku: text("sku").notNull(), qty: integer("qty").notNull() },
  (t) => [primaryKey({ columns: [t.org, t.sku] })],
);
const foldedTable = pgTable("folded", { id: text("id").primaryKey(), name: text("name"), score: integer("score") });
const perrowTable = pgTable("perrow", { id: text("id").primaryKey(), name: text("name"), score: integer("score") });
const mi = pgTable("mi", { id: text("id").primaryKey(), name: text("name"), score: integer("score") });
const miPk = pgTable("mi_pk", { org: text("org").notNull(), sku: text("sku").notNull() }, (t) => [
  primaryKey({ columns: [t.org, t.sku] }),
]);

// Derive the change-message type from an applier signature so the test does not import
// `@electric-sql/client` directly (it does not resolve from the tests/ typecheck scope).
type BulkMessage = Parameters<typeof applyBulkUpdatesToTable>[0]["messages"][number];
type Operation = "insert" | "update" | "delete";
function msg(key: string, operation: Operation, value: Record<string, unknown>): BulkMessage {
  return { key, value, headers: { operation } } as unknown as BulkMessage;
}

describe("bulk apply (ADR-0014 Phase 3)", () => {
  let pg: PGlite;
  beforeAll(async () => {
    pg = await createFreshTestPGlite();
  });
  afterAll(async () => {
    await pg.close();
  });

  it("applyBulkDeletesToTable deletes exactly the addressed PKs", async () => {
    await createTablesFromSchema(pg, { delAuthors });
    await drizzleOver(pg)
      .insert(delAuthors)
      .values([
        { id: "a1", name: "A" },
        { id: "a2", name: "B" },
        { id: "a3", name: "C" },
      ]);

    await applyBulkDeletesToTable({
      pg,
      table: "del_authors",
      messages: [msg("a1", "delete", { id: "a1" }), msg("a3", "delete", { id: "a3" })],
      primaryKey: ["id"],
      debug: false,
    });

    const result = await drizzleOver(pg).select({ id: delAuthors.id }).from(delAuthors).orderBy(asc(delAuthors.id));
    expect(result).toEqual([{ id: "a2" }]);
  });

  it("applyBulkUpdatesToTable groups by column-set so partial updates never clobber sibling columns", async () => {
    await createTablesFromSchema(pg, { updAuthors });
    await drizzleOver(pg)
      .insert(updAuthors)
      .values([
        { id: "a1", name: "A", score: 1 },
        { id: "a2", name: "B", score: 2 },
      ]);

    // Two rows in one batch touch *different* columns. A single uniform UPDATE..FROM would set both
    // name and score for both rows; grouping by column-set keeps each row's untouched column intact.
    await applyBulkUpdatesToTable({
      pg,
      table: "upd_authors",
      messages: [msg("a1", "update", { id: "a1", name: "A2" }), msg("a2", "update", { id: "a2", score: 99 })],
      primaryKey: ["id"],
      debug: false,
    });

    const result = await drizzleOver(pg).select().from(updAuthors).orderBy(asc(updAuthors.id));
    expect(result).toEqual([
      { id: "a1", name: "A2", score: 1 }, // score untouched
      { id: "a2", name: "B", score: 99 }, // name untouched
    ]);
  });

  it("survives a bigint scalar AND a bigint[] array through json_to_recordset (number + BigInt inputs)", async () => {
    await createTablesFromSchema(pg, { bn });
    await drizzleOver(pg)
      .insert(bn)
      .values([
        { id: "n", updatedAtUs: 0n, marks: [] },
        { id: "b", updatedAtUs: 0n, marks: [] },
      ]);

    await applyBulkUpdatesToTable({
      pg,
      table: "bn",
      messages: [
        // JS numbers
        msg("n", "update", { id: "n", updated_at_us: 1_700_000_000_000_000, marks: [1, 2, 3] }),
        // JS BigInt scalar + a bigint[] array of BigInt elements, all beyond Number.MAX_SAFE_INTEGER
        msg("b", "update", {
          id: "b",
          updated_at_us: 9_007_199_254_740_993n,
          marks: [9_007_199_254_740_993n, 9_007_199_254_740_994n],
        }),
      ],
      primaryKey: ["id"],
      debug: false,
    });

    const result = await drizzleOver(pg)
      .select({
        id: bn.id,
        updated_at_us: sql<string>`${bn.updatedAtUs}::text`.as("updated_at_us"),
        marks: sql<string>`${bn.marks}::text`.as("marks"),
      })
      .from(bn)
      .orderBy(asc(bn.id));
    expect(result).toEqual([
      { id: "b", updated_at_us: "9007199254740993", marks: "{9007199254740993,9007199254740994}" },
      { id: "n", updated_at_us: "1700000000000000", marks: "{1,2,3}" },
    ]);
  });

  it("handles a composite primary key on both update and delete", async () => {
    await createTablesFromSchema(pg, { parts });
    await drizzleOver(pg)
      .insert(parts)
      .values([
        { org: "o", sku: "x", qty: 1 },
        { org: "o", sku: "y", qty: 2 },
        { org: "o", sku: "z", qty: 3 },
      ]);

    await applyBulkUpdatesToTable({
      pg,
      table: "parts",
      messages: [msg("o/x", "update", { org: "o", sku: "x", qty: 10 })],
      primaryKey: ["org", "sku"],
      debug: false,
    });
    await applyBulkDeletesToTable({
      pg,
      table: "parts",
      messages: [msg("o/z", "delete", { org: "o", sku: "z" })],
      primaryKey: ["org", "sku"],
      debug: false,
    });

    const result = await drizzleOver(pg).select().from(parts).orderBy(asc(parts.sku));
    expect(result).toEqual([
      { org: "o", sku: "x", qty: 10 },
      { org: "o", sku: "y", qty: 2 },
    ]);
  });

  it("fold + three bulk statements (DELETE→INSERT→UPDATE) ≡ ordered per-row apply, against real Postgres", async () => {
    // Two tables seeded identically: one driven by the folded bulk path, one by the per-row applier.
    await createTablesFromSchema(pg, { foldedTable, perrowTable });
    const seedRows = [
      { id: "keep", name: "seed", score: 0 },
      { id: "repl", name: "old", score: 1 },
      { id: "gone", name: "bye", score: 2 },
    ];
    await drizzleOver(pg).insert(foldedTable).values(seedRows);
    await drizzleOver(pg).insert(perrowTable).values(seedRows);

    // A faithful batch: 'repl' is deleted then re-inserted (re-create — its delete must run first),
    // 'gone' is deleted, 'keep' gets two partial updates (merged), 'new' is inserted then updated.
    const batch = [
      msg("repl", "delete", { id: "repl" }),
      msg("keep", "update", { id: "keep", name: "k2" }),
      msg("gone", "delete", { id: "gone" }),
      msg("repl", "insert", { id: "repl", name: "fresh", score: 7 }),
      msg("new", "insert", { id: "new", name: "n", score: 5 }),
      msg("keep", "update", { id: "keep", score: 42 }),
      msg("new", "update", { id: "new", name: "n2" }),
    ];

    // Per-row path (the oracle).
    for (const m of batch) {
      if (m.headers.operation === "insert") {
        await applyInsertsToTable({ pg, table: "perrow", messages: [m as never], primaryKey: ["id"], debug: false });
      } else {
        await applyMessageToTable({ pg, table: "perrow", message: m, primaryKey: ["id"], debug: false });
      }
    }

    // Folded bulk path: DELETE → INSERT → UPDATE.
    const folded = foldChangeBatch(batch);
    await applyBulkDeletesToTable({ pg, table: "folded", messages: folded.deletes, primaryKey: ["id"], debug: false });
    await applyInsertsToTable({ pg, table: "folded", messages: folded.inserts, primaryKey: ["id"], debug: false });
    await applyBulkUpdatesToTable({ pg, table: "folded", messages: folded.updates, primaryKey: ["id"], debug: false });

    const folledRows = await drizzleOver(pg).select().from(foldedTable).orderBy(asc(foldedTable.id));
    const perRowRows = await drizzleOver(pg).select().from(perrowTable).orderBy(asc(perrowTable.id));
    expect(folledRows).toEqual(perRowRows);
    // And the concrete expected end-state, so the oracle itself can't be vacuously wrong.
    expect(folledRows).toEqual([
      { id: "keep", name: "k2", score: 42 },
      { id: "new", name: "n2", score: 5 },
      { id: "repl", name: "fresh", score: 7 },
    ]);
  });

  // ADR-0024 — the move-in apply path. A move-in is an existing row ENTERING the shape, so it must be
  // idempotent: applying it when the row is already present (another grant, or a resume re-delivery)
  // must not raise the PK collision the plain-INSERT CDC path deliberately surfaces.
  describe("applyUpsertsToTable (move-in)", () => {
    it("inserts a fresh move-in row, then upserts an already-present row without colliding", async () => {
      await createTablesFromSchema(pg, { mi });

      // First delivery — a plain insert of the entering row.
      await applyUpsertsToTable({
        pg,
        table: "mi",
        messages: [msg("a1", "insert", { id: "a1", name: "A", score: 1 })],
        primaryKey: ["id"],
        debug: false,
      });
      // Re-delivery / second grant for the SAME pk with a refreshed value — must upsert, not throw.
      await applyUpsertsToTable({
        pg,
        table: "mi",
        messages: [msg("a1", "insert", { id: "a1", name: "A-refreshed", score: 2 })],
        primaryKey: ["id"],
        debug: false,
      });

      const rows = await drizzleOver(pg).select().from(mi).orderBy(asc(mi.id));
      expect(rows).toEqual([{ id: "a1", name: "A-refreshed", score: 2 }]);
    });

    it("is a DO NOTHING no-op for a primary-key-only table", async () => {
      await createTablesFromSchema(pg, { miPk });

      const moveIn = [msg("o/x", "insert", { org: "o", sku: "x" })];
      await applyUpsertsToTable({ pg, table: "mi_pk", messages: moveIn, primaryKey: ["org", "sku"], debug: false });
      // Idempotent: a pk-only conflict has no columns to update, so DO NOTHING — applying twice is fine.
      await applyUpsertsToTable({ pg, table: "mi_pk", messages: moveIn, primaryKey: ["org", "sku"], debug: false });

      const rows = await drizzleOver(pg).select().from(miPk);
      expect(rows).toEqual([{ org: "o", sku: "x" }]);
    });
  });
});
