import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import type { PGlite } from "@electric-sql/pglite";
import { asc, sql } from "drizzle-orm";
import { bigint, integer, jsonb, pgEnum, pgTable, primaryKey, real, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { classifyApplyStrategy } from "@pgxsinkit/contracts";

import {
  applyBulkDeletesToTable,
  applyBulkUpdatesToTable,
  applyInsertsToTable,
  applyMessagesToTableWithCopy,
  applyMessagesToTableWithJson,
  applyMessageToTable,
  applyUpsertsToTable,
  applyUpsertsToTableWithJson,
} from "../../packages/client/src/sync/apply";
import { foldChangeBatch } from "../../packages/client/src/sync/shape-inbox";
import { createTablesFromSchema, drizzleOver, makeApplyTarget } from "../support/drizzle";
import { createFreshTestPGlite } from "../support/pglite";

// Tier-① fixture tables for the ad-hoc apply targets. The appliers now receive a resolved
// {@link ApplyTarget} built from the real `pgTable` via `makeApplyTarget` (ADR-0029 D1) — no name strings.
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

// A synced table whose PK is a GENERATED ALWAYS identity — the drizzle OBJECT carries the identity
// metadata (as the registry defines it) even though pgxsinkit's local-schema generator renders the
// physical column PLAIN (`getSQLType()`, no identity clause). The applier must preserve the SERVER's id.
const idn = pgTable("idn", {
  id: bigint("id", { mode: "bigint" }).generatedAlwaysAsIdentity().primaryKey(),
  sourceText: text("source_text").notNull(),
});
// Enum fixtures — a scalar enum (COPY tier) and a mixed-case enum alongside jsonb (JSON tier), the latter
// exercising the recordset cast's identifier quoting (an unquoted mixed-case type name folds to lowercase).
const issueStatus = pgEnum("issue_status", ["backlog", "todo", "in_progress", "done"]);
const enumScalar = pgTable("enum_scalar", { id: text("id").primaryKey(), status: issueStatus("status").notNull() });
const mixedCaseEnum = pgEnum("IssueStatus", ["backlog", "todo", "in_progress", "done"]);
const enumJson = pgTable("enum_json", {
  id: text("id").primaryKey(),
  status: mixedCaseEnum("status").notNull(),
  meta: jsonb("meta").notNull(),
});

// SRS-card shape (a consumer's real failure case): timestamptz + real + bigint through the bulk-update
// recordset — types the other fixtures don't cover, with values in both wire shapes (raw JSON strings
// and parsed Date instances).
const srsCard = pgTable("srs_card", {
  id: uuid("id").primaryKey(),
  dueDate: timestamp("due_date", { withTimezone: true }),
  efactor: real("efactor"),
  gap: integer("gap"),
  lastRevisionDate: timestamp("last_revision_date", { withTimezone: true }),
  modifiedus: bigint("modifiedus", { mode: "bigint" }),
  repetition: integer("repetition"),
});

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
      target: makeApplyTarget(delAuthors, ["id"]),
      messages: [msg("a1", "delete", { id: "a1" }), msg("a3", "delete", { id: "a3" })],
      debug: false,
    });

    const result = await drizzleOver(pg).select({ id: delAuthors.id }).from(delAuthors).orderBy(asc(delAuthors.id));
    expect(result).toEqual([{ id: "a2" }]);
  });

  it("applyBulkUpdatesToTable round-trips timestamptz/real/bigint (string-valued rows)", async () => {
    await createTablesFromSchema(pg, { srsCard });
    const id = "c0000000-0000-0000-0000-000000000001";
    await drizzleOver(pg)
      .insert(srsCard)
      .values([{ id, gap: 0, repetition: 0, modifiedus: 0n }]);

    await applyBulkUpdatesToTable({
      pg,
      target: makeApplyTarget(srsCard, ["id"]),
      messages: [
        msg(id, "update", {
          id,
          due_date: "2026-07-18 03:12:45.123+00",
          efactor: 2.6,
          gap: 3,
          last_revision_date: "2026-07-17 03:12:45.123+00",
          modifiedus: "1784300000000000",
          repetition: 4,
        }),
      ],
      debug: false,
    });

    const [row] = await drizzleOver(pg).select().from(srsCard);
    expect(row?.repetition).toBe(4);
    expect(row?.modifiedus).toBe(1784300000000000n);
    expect(row?.dueDate?.toISOString()).toBe("2026-07-18T03:12:45.123Z");
  });

  it("applyBulkUpdatesToTable round-trips timestamptz given parsed Date instances", async () => {
    // srs_card was created by the string-valued round-trip test above (shared PGlite instance).
    const id = "c0000000-0000-0000-0000-000000000002";
    await drizzleOver(pg)
      .insert(srsCard)
      .values([{ id, gap: 0, repetition: 0, modifiedus: 0n }]);

    await applyBulkUpdatesToTable({
      pg,
      target: makeApplyTarget(srsCard, ["id"]),
      messages: [
        msg(id, "update", {
          id,
          due_date: new Date("2026-07-18T03:12:45.123Z"),
          efactor: 2.6,
          gap: 3,
          last_revision_date: new Date("2026-07-17T03:12:45.123Z"),
          modifiedus: "1784300000000000",
          repetition: 4,
        }),
      ],
      debug: false,
    });

    const [row] = await drizzleOver(pg)
      .select()
      .from(srsCard)
      .where(sql`id = ${id}`);
    expect(row?.repetition).toBe(4);
    expect(row?.dueDate?.toISOString()).toBe("2026-07-18T03:12:45.123Z");
  });

  it("applyBulkUpdatesToTable round-trips the srs-card shape INSIDE pg.transaction (the engine's real context)", async () => {
    // The engine applies every Electric batch inside `pg.transaction(tx => …)` and hands the applier the
    // TRANSACTION, not the instance — a different executor/serialization path than the raw-pg tests above.
    const id = "c0000000-0000-0000-0000-000000000003";
    await drizzleOver(pg)
      .insert(srsCard)
      .values([{ id, gap: 0, repetition: 0, modifiedus: 0n }]);

    await pg.transaction(async (tx) => {
      await applyBulkUpdatesToTable({
        pg: tx,
        target: makeApplyTarget(srsCard, ["id"]),
        messages: [
          msg(id, "update", {
            id,
            due_date: "2026-07-18 03:12:45.123+00",
            efactor: 2.6,
            gap: 3,
            last_revision_date: "2026-07-17 03:12:45.123+00",
            modifiedus: "1784300000000000",
            repetition: 4,
          }),
        ],
        debug: false,
      });
    });

    const [row] = await drizzleOver(pg)
      .select()
      .from(srsCard)
      .where(sql`id = ${id}`);
    expect(row?.repetition).toBe(4);
    expect(row?.dueDate?.toISOString()).toBe("2026-07-18T03:12:45.123Z");
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
      target: makeApplyTarget(updAuthors, ["id"]),
      messages: [msg("a1", "update", { id: "a1", name: "A2" }), msg("a2", "update", { id: "a2", score: 99 })],
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
      target: makeApplyTarget(bn, ["id"]),
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
      target: makeApplyTarget(parts, ["org", "sku"]),
      messages: [msg("o/x", "update", { org: "o", sku: "x", qty: 10 })],
      debug: false,
    });
    await applyBulkDeletesToTable({
      pg,
      target: makeApplyTarget(parts, ["org", "sku"]),
      messages: [msg("o/z", "delete", { org: "o", sku: "z" })],
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
        await applyInsertsToTable({
          pg,
          target: makeApplyTarget(perrowTable, ["id"]),
          messages: [m as never],
          debug: false,
        });
      } else {
        await applyMessageToTable({ pg, target: makeApplyTarget(perrowTable, ["id"]), message: m, debug: false });
      }
    }

    // Folded bulk path: DELETE → INSERT → UPDATE.
    const folded = foldChangeBatch(batch);
    await applyBulkDeletesToTable({
      pg,
      target: makeApplyTarget(foldedTable, ["id"]),
      messages: folded.deletes,
      debug: false,
    });
    await applyInsertsToTable({
      pg,
      target: makeApplyTarget(foldedTable, ["id"]),
      messages: folded.inserts,
      debug: false,
    });
    await applyBulkUpdatesToTable({
      pg,
      target: makeApplyTarget(foldedTable, ["id"]),
      messages: folded.updates,
      debug: false,
    });

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
        target: makeApplyTarget(mi, ["id"]),
        messages: [msg("a1", "insert", { id: "a1", name: "A", score: 1 })],
        debug: false,
      });
      // Re-delivery / second grant for the SAME pk with a refreshed value — must upsert, not throw.
      await applyUpsertsToTable({
        pg,
        target: makeApplyTarget(mi, ["id"]),
        messages: [msg("a1", "insert", { id: "a1", name: "A-refreshed", score: 2 })],
        debug: false,
      });

      const rows = await drizzleOver(pg).select().from(mi).orderBy(asc(mi.id));
      expect(rows).toEqual([{ id: "a1", name: "A-refreshed", score: 2 }]);
    });

    it("is a DO NOTHING no-op for a primary-key-only table", async () => {
      await createTablesFromSchema(pg, { miPk });

      const moveIn = [msg("o/x", "insert", { org: "o", sku: "x" })];
      await applyUpsertsToTable({ pg, target: makeApplyTarget(miPk, ["org", "sku"]), messages: moveIn, debug: false });
      // Idempotent: a pk-only conflict has no columns to update, so DO NOTHING — applying twice is fine.
      await applyUpsertsToTable({ pg, target: makeApplyTarget(miPk, ["org", "sku"]), messages: moveIn, debug: false });

      const rows = await drizzleOver(pg).select().from(miPk);
      expect(rows).toEqual([{ org: "o", sku: "x" }]);
    });
  });

  // Defect 1 — a GENERATED ALWAYS identity PK must NOT be dropped by the insert builder. Drizzle omits
  // such a column from `.values()`, so a plain insert would either lose the PK (NOT NULL death) or let a
  // local sequence mint its own id; `INSERT … OVERRIDING SYSTEM VALUE` re-includes it with the SERVER's id.
  describe("generated-identity PK (insert tier, ADR-0009)", () => {
    it("preserves the server's identity id on the bulk insert tier (not a local sequence)", async () => {
      // Physical column is PLAIN, exactly as the local-schema generator renders it (no identity clause);
      // the drizzle object still carries the identity metadata that triggers OVERRIDING SYSTEM VALUE.
      await pg.exec(`CREATE TABLE idn (id BIGINT PRIMARY KEY, source_text TEXT NOT NULL);`);

      await applyInsertsToTable({
        pg,
        target: makeApplyTarget(idn, ["id"]),
        messages: [
          msg("100", "insert", { id: 100n, source_text: "alpha" }),
          msg("200", "insert", { id: 200n, source_text: "beta" }),
        ] as never,
        debug: false,
      });

      const rows = await drizzleOver(pg)
        .select({ id: sql<string>`${idn.id}::text`.as("id"), sourceText: idn.sourceText })
        .from(idn)
        .orderBy(asc(idn.id));
      // The ids MATCH the delivered server values, proving the PK column was carried, not dropped/regenerated.
      expect(rows).toEqual([
        { id: "100", sourceText: "alpha" },
        { id: "200", sourceText: "beta" },
      ]);
    });

    it("preserves the server id through the per-row CDC insert and the move-in upsert paths too", async () => {
      await pg.exec(`CREATE TABLE idn2 (id BIGINT PRIMARY KEY, source_text TEXT NOT NULL);`);
      const idn2 = pgTable("idn2", {
        id: bigint("id", { mode: "bigint" }).generatedAlwaysAsIdentity().primaryKey(),
        sourceText: text("source_text").notNull(),
      });

      await applyMessageToTable({
        pg,
        target: makeApplyTarget(idn2, ["id"]),
        message: msg("7", "insert", { id: 7n, source_text: "cdc" }),
        debug: false,
      });
      await applyUpsertsToTable({
        pg,
        target: makeApplyTarget(idn2, ["id"]),
        messages: [msg("9", "insert", { id: 9n, source_text: "movein" })],
        debug: false,
      });

      const rows = await drizzleOver(pg)
        .select({ id: sql<string>`${idn2.id}::text`.as("id"), sourceText: idn2.sourceText })
        .from(idn2)
        .orderBy(asc(idn2.id));
      expect(rows).toEqual([
        { id: "7", sourceText: "cdc" },
        { id: "9", sourceText: "movein" },
      ]);
    });
  });

  // Defect 2 — enum columns keep a table off the insert floor and round-trip losslessly on their tier.
  describe("enum columns (COPY / JSON tiers, ADR-0009)", () => {
    it("classifies a scalar-enum table as copy and round-trips labels via COPY", async () => {
      await createTablesFromSchema(pg, { issueStatus, enumScalar });
      const target = makeApplyTarget(enumScalar, ["id"]);
      expect(target.columnTypes.find((c) => c.name === "status")?.isEnum).toBe(true);
      expect(classifyApplyStrategy(target.columnTypes)).toBe("copy");

      await applyMessagesToTableWithCopy({
        pg,
        target,
        messages: [
          msg("a", "insert", { id: "a", status: "todo" }),
          msg("b", "insert", { id: "b", status: "done" }),
        ] as never,
        debug: false,
      });

      const rows = await drizzleOver(pg).select().from(enumScalar).orderBy(asc(enumScalar.id));
      expect(rows).toEqual([
        { id: "a", status: "todo" },
        { id: "b", status: "done" },
      ]);
    });

    it("round-trips a MIXED-CASE enum through the JSON tier (recordset cast must quote the type name)", async () => {
      await createTablesFromSchema(pg, { mixedCaseEnum, enumJson });
      const target = makeApplyTarget(enumJson, ["id"]);
      // enum + jsonb → json tier (jsonb is not COPY-safe), so the enum flows through the recordset cast.
      expect(classifyApplyStrategy(target.columnTypes)).toBe("json");

      await applyMessagesToTableWithJson({
        pg,
        target,
        messages: [
          msg("a", "insert", { id: "a", status: "in_progress", meta: { seen: true } }),
          msg("b", "insert", { id: "b", status: "backlog", meta: { seen: false } }),
        ] as never,
        debug: false,
      });

      const rows = await drizzleOver(pg).select().from(enumJson).orderBy(asc(enumJson.id));
      expect(rows).toEqual([
        { id: "a", status: "in_progress", meta: { seen: true } },
        { id: "b", status: "backlog", meta: { seen: false } },
      ]);
    });
  });

  // ADR-0045 — `applyMode: "upsert"`. A table that legitimately receives locally-derived provisional rows
  // (e.g. written by a local trigger from another synced table) routes server CDC inserts through the
  // idempotent upsert applier, so the authoritative server row overwrites the provisional local row
  // instead of the plain-INSERT path failing the commit on the 23505 collision. Default `"insert"` keeps
  // the strict collision-surfacing invariant: the same pre-existing-row scenario must reject.
  describe("applyMode: upsert (ADR-0045)", () => {
    // A synced cache table whose rows an app can also derive locally via a trigger — id is the pk, the
    // rest are the server-authoritative values a provisional local row starts out guessing.
    const provisional = pgTable("provisional_word", {
      id: text("id").primaryKey(),
      grade: integer("grade").notNull(),
      note: text("note"),
    });

    it("folded/initial applier (applyUpsertsToTable) overwrites a pre-existing provisional row", async () => {
      await createTablesFromSchema(pg, { provisional });
      // A local trigger already inserted a provisional row for id "w1" with a guessed grade.
      await drizzleOver(pg).insert(provisional).values({ id: "w1", grade: 0, note: "provisional" });

      // The server's authoritative CDC insert for the SAME pk — routed (applyMode: "upsert") through the
      // idempotent applier the engine uses for the folded and initial-bulk insert paths.
      await applyUpsertsToTable({
        pg,
        target: makeApplyTarget(provisional, ["id"], "upsert"),
        messages: [msg("w1", "insert", { id: "w1", grade: 7, note: "server" })],
        debug: false,
      });

      const rows = await drizzleOver(pg).select().from(provisional).orderBy(asc(provisional.id));
      // The server row (authoritative) overwrote the provisional local row's non-pk values.
      expect(rows).toEqual([{ id: "w1", grade: 7, note: "server" }]);
    });

    it("default insert applier (applyInsertsToTable) rejects the same pre-existing-row scenario", async () => {
      const strict = pgTable("provisional_strict", {
        id: text("id").primaryKey(),
        grade: integer("grade").notNull(),
        note: text("note"),
      });
      await createTablesFromSchema(pg, { strict });
      await drizzleOver(pg).insert(strict).values({ id: "w1", grade: 0, note: "provisional" });

      // Default applyMode ("insert") is a plain INSERT with no conflict clause — a genuine PK collision
      // must surface (ADR-0014), never be silently upserted.
      // oxlint-disable-next-line typescript/await-thenable -- bun-types gap: .rejects matchers return a real promise typed as void
      await expect(
        applyInsertsToTable({
          pg,
          target: makeApplyTarget(strict, ["id"]),
          messages: [msg("w1", "insert", { id: "w1", grade: 7, note: "server" })] as never,
          debug: false,
        }),
      ).rejects.toThrow();
    });

    it("per-message CDC insert (applyMessageToTable) upserts under applyMode: upsert, rejects under insert", async () => {
      const perMsg = pgTable("provisional_permsg", {
        id: text("id").primaryKey(),
        grade: integer("grade").notNull(),
        note: text("note"),
      });
      await createTablesFromSchema(pg, { perMsg });
      await drizzleOver(pg).insert(perMsg).values({ id: "w1", grade: 0, note: "provisional" });

      // applyMode: "upsert" — the per-message insert case applies idempotently.
      await applyMessageToTable({
        pg,
        target: makeApplyTarget(perMsg, ["id"], "upsert"),
        message: msg("w1", "insert", { id: "w1", grade: 7, note: "server" }),
        debug: false,
      });
      expect(await drizzleOver(pg).select().from(perMsg)).toEqual([{ id: "w1", grade: 7, note: "server" }]);

      // Default applyMode ("insert") — the same pre-existing pk must reject.
      // oxlint-disable-next-line typescript/await-thenable -- bun-types gap: .rejects matchers return a real promise typed as void
      await expect(
        applyMessageToTable({
          pg,
          target: makeApplyTarget(perMsg, ["id"]),
          message: msg("w1", "insert", { id: "w1", grade: 9, note: "again" }),
          debug: false,
        }),
      ).rejects.toThrow();
    });

    it("json upsert applier overwrites a colliding row and inserts new rows in the same batch", async () => {
      const jsonUpsert = pgTable("provisional_json", {
        id: text("id").primaryKey(),
        grade: integer("grade").notNull(),
        note: text("note"),
      });
      await createTablesFromSchema(pg, { jsonUpsert });
      // A local trigger already created a provisional row for "w1"; "w2"/"w3" are not present yet.
      await drizzleOver(pg).insert(jsonUpsert).values({ id: "w1", grade: 0, note: "provisional" });

      // One 3-row snapshot batch through the initial-load json upsert tier: one colliding pk + two new.
      await applyUpsertsToTableWithJson({
        pg,
        target: makeApplyTarget(jsonUpsert, ["id"], "upsert"),
        messages: [
          msg("w1", "insert", { id: "w1", grade: 7, note: "server" }),
          msg("w2", "insert", { id: "w2", grade: 3, note: "b" }),
          msg("w3", "insert", { id: "w3", grade: 5, note: "c" }),
        ] as never,
        debug: false,
      });

      const rows = await drizzleOver(pg).select().from(jsonUpsert).orderBy(asc(jsonUpsert.id));
      // The colliding row was refreshed to the server values; the two new rows were inserted.
      expect(rows).toEqual([
        { id: "w1", grade: 7, note: "server" },
        { id: "w2", grade: 3, note: "b" },
        { id: "w3", grade: 5, note: "c" },
      ]);
    });

    it("json upsert applier is a pk-targeted DO NOTHING no-op for a pk-only table", async () => {
      const jsonPk = pgTable("provisional_json_pk", { org: text("org").notNull(), sku: text("sku").notNull() }, (t) => [
        primaryKey({ columns: [t.org, t.sku] }),
      ]);
      await createTablesFromSchema(pg, { jsonPk });

      const batch = [msg("o/x", "insert", { org: "o", sku: "x" })] as never;
      await applyUpsertsToTableWithJson({
        pg,
        target: makeApplyTarget(jsonPk, ["org", "sku"], "upsert"),
        messages: batch,
        debug: false,
      });
      // Idempotent: a pk-only conflict has nothing to refresh → DO NOTHING, so re-applying is a no-op.
      await applyUpsertsToTableWithJson({
        pg,
        target: makeApplyTarget(jsonPk, ["org", "sku"], "upsert"),
        messages: batch,
        debug: false,
      });

      const rows = await drizzleOver(pg).select().from(jsonPk);
      expect(rows).toEqual([{ org: "o", sku: "x" }]);
    });
  });
});
