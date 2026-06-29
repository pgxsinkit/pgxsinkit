import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import type { PGlite } from "@electric-sql/pglite";

import {
  applyBulkDeletesToTable,
  applyBulkUpdatesToTable,
  applyInsertsToTable,
  applyMessageToTable,
  applyUpsertsToTable,
} from "../../packages/client/src/sync/apply";
import { foldChangeBatch } from "../../packages/client/src/sync/shape-inbox";
import { createFreshTestPGlite } from "../support/pglite";

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
    await pg.exec(`CREATE TABLE public.del_authors (id text PRIMARY KEY, name text NOT NULL);`);
    await pg.exec(`
      INSERT INTO public.del_authors VALUES ('a1','A'), ('a2','B'), ('a3','C');
    `);

    await applyBulkDeletesToTable({
      pg,
      table: "del_authors",
      messages: [msg("a1", "delete", { id: "a1" }), msg("a3", "delete", { id: "a3" })],
      primaryKey: ["id"],
      debug: false,
    });

    const result = await pg.query<{ id: string }>(`SELECT id FROM public.del_authors ORDER BY id`);
    expect(result.rows).toEqual([{ id: "a2" }]);
  });

  it("applyBulkUpdatesToTable groups by column-set so partial updates never clobber sibling columns", async () => {
    await pg.exec(`
      CREATE TABLE public.upd_authors (id text PRIMARY KEY, name text NOT NULL, score int NOT NULL);
    `);
    await pg.exec(`INSERT INTO public.upd_authors VALUES ('a1','A',1), ('a2','B',2);`);

    // Two rows in one batch touch *different* columns. A single uniform UPDATE..FROM would set both
    // name and score for both rows; grouping by column-set keeps each row's untouched column intact.
    await applyBulkUpdatesToTable({
      pg,
      table: "upd_authors",
      messages: [msg("a1", "update", { id: "a1", name: "A2" }), msg("a2", "update", { id: "a2", score: 99 })],
      primaryKey: ["id"],
      debug: false,
    });

    const result = await pg.query<{ id: string; name: string; score: number }>(
      `SELECT id, name, score FROM public.upd_authors ORDER BY id`,
    );
    expect(result.rows).toEqual([
      { id: "a1", name: "A2", score: 1 }, // score untouched
      { id: "a2", name: "B", score: 99 }, // name untouched
    ]);
  });

  it("survives a bigint scalar AND a bigint[] array through json_to_recordset (number + BigInt inputs)", async () => {
    await pg.exec(`
      CREATE TABLE public.bn (id text PRIMARY KEY, updated_at_us bigint NOT NULL, marks bigint[] NOT NULL);
    `);
    await pg.exec(`INSERT INTO public.bn VALUES ('n', 0, '{}'), ('b', 0, '{}');`);

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

    const result = await pg.query<{ id: string; updated_at_us: string; marks: string }>(
      `SELECT id, updated_at_us::text AS updated_at_us, marks::text AS marks FROM public.bn ORDER BY id`,
    );
    expect(result.rows).toEqual([
      { id: "b", updated_at_us: "9007199254740993", marks: "{9007199254740993,9007199254740994}" },
      { id: "n", updated_at_us: "1700000000000000", marks: "{1,2,3}" },
    ]);
  });

  it("handles a composite primary key on both update and delete", async () => {
    await pg.exec(`
      CREATE TABLE public.parts (org text, sku text, qty int NOT NULL, PRIMARY KEY (org, sku));
    `);
    await pg.exec(`INSERT INTO public.parts VALUES ('o','x',1), ('o','y',2), ('o','z',3);`);

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

    const result = await pg.query<{ org: string; sku: string; qty: number }>(
      `SELECT org, sku, qty FROM public.parts ORDER BY sku`,
    );
    expect(result.rows).toEqual([
      { org: "o", sku: "x", qty: 10 },
      { org: "o", sku: "y", qty: 2 },
    ]);
  });

  it("fold + three bulk statements (DELETE→INSERT→UPDATE) ≡ ordered per-row apply, against real Postgres", async () => {
    // Two tables seeded identically: one driven by the folded bulk path, one by the per-row applier.
    for (const table of ["folded", "perrow"]) {
      await pg.exec(`CREATE TABLE public.${table} (id text PRIMARY KEY, name text, score int);`);
      await pg.exec(`INSERT INTO public.${table} VALUES ('keep','seed',0), ('repl','old',1), ('gone','bye',2);`);
    }

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

    const folledRows = (await pg.query(`SELECT id, name, score FROM public.folded ORDER BY id`)).rows;
    const perRowRows = (await pg.query(`SELECT id, name, score FROM public.perrow ORDER BY id`)).rows;
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
      await pg.exec(`CREATE TABLE public.mi (id text PRIMARY KEY, name text, score int);`);

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

      const rows = (await pg.query(`SELECT id, name, score FROM public.mi ORDER BY id`)).rows;
      expect(rows).toEqual([{ id: "a1", name: "A-refreshed", score: 2 }]);
    });

    it("is a DO NOTHING no-op for a primary-key-only table", async () => {
      await pg.exec(`CREATE TABLE public.mi_pk (org text, sku text, PRIMARY KEY (org, sku));`);

      const moveIn = [msg("o/x", "insert", { org: "o", sku: "x" })];
      await applyUpsertsToTable({ pg, table: "mi_pk", messages: moveIn, primaryKey: ["org", "sku"], debug: false });
      // Idempotent: a pk-only conflict has no columns to update, so DO NOTHING — applying twice is fine.
      await applyUpsertsToTable({ pg, table: "mi_pk", messages: moveIn, primaryKey: ["org", "sku"], debug: false });

      const rows = (await pg.query(`SELECT org, sku FROM public.mi_pk`)).rows;
      expect(rows).toEqual([{ org: "o", sku: "x" }]);
    });
  });
});
