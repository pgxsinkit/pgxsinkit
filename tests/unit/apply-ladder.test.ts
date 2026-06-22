import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import type { PGlite } from "@electric-sql/pglite";

import type { SyncColumnType } from "@pgxsinkit/contracts";

import {
  applyInsertsToTable,
  applyMessagesToTableWithCopy,
  applyMessagesToTableWithJson,
} from "../../packages/client/src/sync/apply";
import { createFreshTestPGlite } from "../support/pglite";

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
    await pg.exec(`
      CREATE TABLE public.rich (
        id text PRIMARY KEY,
        big bigint NOT NULL,
        nums bigint[] NOT NULL,
        doc jsonb NOT NULL
      );
    `);

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
    const result = await pg.query<{ id: string; big: string; nums: string; doc: unknown }>(
      `SELECT id, big::text AS big, nums::text AS nums, doc FROM public.rich ORDER BY id`,
    );
    expect(result.rows).toEqual([
      { id: "r1", big: "100", nums: "{1,2,3}", doc: { a: 1 } },
      { id: "r2", big: "200", nums: "{4,5}", doc: { b: 2 } },
    ]);

    // Replay upserts on the primary key rather than duplicating.
    await applyMessagesToTableWithJson({
      pg,
      table: "rich",
      messages: [insert("r1", { id: "r1", big: 999, nums: [9], doc: { a: 9 } })],
      primaryKey: ["id"],
      columnTypes,
      debug: false,
    });

    const replayed = await pg.query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM public.rich`);
    expect(replayed.rows[0]!.count).toBe(2);
    const r1 = await pg.query<{ big: string; nums: string }>(
      `SELECT big::text AS big, nums::text AS nums FROM public.rich WHERE id = 'r1'`,
    );
    expect(r1.rows[0]).toEqual({ big: "999", nums: "{9}" });
  });

  it("json tier still works via the information_schema fallback when no column types are supplied", async () => {
    await pg.exec(`
      CREATE TABLE public."camelRich" (
        id text PRIMARY KEY,
        "firstName" text,
        tags text[]
      );
    `);

    await applyMessagesToTableWithJson({
      pg,
      table: "camelRich",
      messages: [insert("c1", { id: "c1", firstName: "Alice", tags: ["x", "y"] })],
      primaryKey: ["id"],
      debug: false,
    });

    const result = await pg.query<{ id: string; firstName: string; tags: string }>(
      `SELECT id, "firstName", tags::text AS tags FROM public."camelRich"`,
    );
    expect(result.rows).toEqual([{ id: "c1", firstName: "Alice", tags: "{x,y}" }]);
  });

  it("copy tier applies a primary-key-less scalar table, escaping special characters", async () => {
    await pg.exec(`
      CREATE TABLE public.copy_target (
        task text NOT NULL,
        done boolean NOT NULL
      );
    `);

    await applyMessagesToTableWithCopy({
      pg,
      table: "copy_target",
      messages: [
        insert("t1", { task: "task with, comma", done: false }),
        insert("t2", { task: 'task with "quotes"', done: true }),
      ],
      primaryKey: [],
      debug: false,
    });

    const result = await pg.query<{ task: string; done: boolean }>(
      `SELECT task, done FROM public.copy_target ORDER BY task`,
    );
    // Ordered by task: '"' (0x22) sorts before ',' (0x2C).
    expect(result.rows).toEqual([
      { task: 'task with "quotes"', done: true },
      { task: "task with, comma", done: false },
    ]);
  });

  it("insert tier upserts scalar rows on the primary key", async () => {
    await pg.exec(`
      CREATE TABLE public.scalars (
        id text PRIMARY KEY,
        name text NOT NULL,
        count integer NOT NULL
      );
    `);

    await applyInsertsToTable({
      pg,
      table: "scalars",
      messages: [insert("s1", { id: "s1", name: "first", count: 1 })],
      primaryKey: ["id"],
      debug: false,
    });
    await applyInsertsToTable({
      pg,
      table: "scalars",
      messages: [insert("s1", { id: "s1", name: "second", count: 2 })],
      primaryKey: ["id"],
      debug: false,
    });

    const result = await pg.query<{ id: string; name: string; count: number }>(
      `SELECT id, name, count FROM public.scalars`,
    );
    expect(result.rows).toEqual([{ id: "s1", name: "second", count: 2 }]);
  });
});
