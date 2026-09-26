// Began as a copy of `@electric-sql/pglite`'s tests (taken under its PostgreSQL License option,
// © ElectricSQL — see NOTICE). Owned outright (ADR-0062); compatibility with PGlite is an anti-goal.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import type { Pgwasm } from "../../packages/pgwasm/src";
import { formatQuery } from "../../packages/pgwasm/src/live/format-query";
import { closeTestPgwasms, createTestPgwasm } from "./support/pgwasm";

describe("formatQuery inlines parameters as literals", () => {
  let pg: Pgwasm;
  beforeAll(async () => {
    pg = await createTestPgwasm();
    await pg.exec(`
      CREATE TABLE t_bool (id SERIAL PRIMARY KEY, value BOOLEAN);
      CREATE TABLE t_int (id SERIAL PRIMARY KEY, value INTEGER);
      CREATE TABLE t_text (id SERIAL PRIMARY KEY, value VARCHAR);
      CREATE TABLE t_json (id SERIAL PRIMARY KEY, value JSONB);
    `);
  });
  afterAll(closeTestPgwasms);

  it("formats booleans, numbers and strings by their column types", async () => {
    expect(await formatQuery(pg, "SELECT * FROM t_bool WHERE value = $1;", [true])).toBe(
      "SELECT * FROM t_bool WHERE value = 't';",
    );
    expect(await formatQuery(pg, "SELECT * FROM t_int WHERE value = $1;", [1])).toBe(
      "SELECT * FROM t_int WHERE value = '1';",
    );
    expect(await formatQuery(pg, "SELECT * FROM t_text WHERE value = $1;", ["test"])).toBe(
      "SELECT * FROM t_text WHERE value = 'test';",
    );
  });

  it("binds each placeholder to its own parameter, in any order, repeated or not", async () => {
    expect(await formatQuery(pg, "SELECT * FROM t_text WHERE value = $2 AND id = $1;", [1, "test"])).toBe(
      "SELECT * FROM t_text WHERE value = 'test' AND id = '1';",
    );
    expect(await formatQuery(pg, "SELECT * FROM t_text WHERE value = $1 OR value = $1;", ["test"])).toBe(
      "SELECT * FROM t_text WHERE value = 'test' OR value = 'test';",
    );
  });

  it("formats json", async () => {
    expect(await formatQuery(pg, "SELECT * FROM t_json WHERE value = $1;", [{ test: "test" }])).toBe(
      `SELECT * FROM t_json WHERE value = '{"test": "test"}';`,
    );
  });

  it("returns a query without parameters as it is", async () => {
    expect(await formatQuery(pg, "SELECT 1", [])).toBe("SELECT 1");
  });
});
