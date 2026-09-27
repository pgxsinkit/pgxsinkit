// Began as a port of `@electric-sql/pglite-repl`'s query helpers (taken under PGlite's PostgreSQL License
// option, © ElectricSQL — see NOTICE). Owned outright (ADR-0062); compatibility with PGlite is an anti-goal.

import { afterEach, describe, expect, it } from "bun:test";

import { getSchema, runQuery } from "../../packages/pgwasm-repl/src/run-query";
import { closeTestPgwasms, createTestPgwasm } from "./support/pgwasm";

// The REPL's logic that is not the DOM: what an input runs and returns, and the tables autocompletion
// offers, on a real pgwasm database (a `Pgwasm` is a `ReplDatabase` as it is). The component itself is
// mounted in the browser lane (tests/e2e/pgwasm-idb).

afterEach(closeTestPgwasms);

describe("runQuery", () => {
  it("runs SQL, every statement of it, with rows as arrays", async () => {
    const pg = await createTestPgwasm();
    const response = await runQuery("SELECT 1 AS one, 'x' AS two; SELECT 2 AS three", pg);
    expect(response.error).toBeUndefined();
    expect(response.query).toBe("SELECT 1 AS one, 'x' AS two; SELECT 2 AS three");
    expect(response.results?.map((result) => result.rows)).toEqual([[[1, "x"]], [[2]]]);
    expect(response.results?.[0]?.fields.map((field) => field.name)).toEqual(["one", "two"]);
    expect(response.time).toBeGreaterThanOrEqual(0);
  });

  it("answers a statement without rows with no fields", async () => {
    const pg = await createTestPgwasm();
    const response = await runQuery("CREATE TABLE made (id int)", pg);
    expect(response.results).toEqual([{ rows: [], fields: [] }]);
  });

  it("returns an SQL error as a response, not a throw", async () => {
    const pg = await createTestPgwasm();
    const response = await runQuery("SELEC 1", pg);
    expect(response.error).toMatch(/syntax error/);
    expect(response.results).toBeUndefined();
    // The database is still usable.
    expect((await runQuery("SELECT 1 AS one", pg)).results?.[0]?.rows).toEqual([[1]]);
  });

  it("runs psql's describe commands, showing the tables they produce", async () => {
    const pg = await createTestPgwasm();
    await pg.exec("CREATE TABLE notes (id serial PRIMARY KEY, body text NOT NULL)");

    const tables = await runQuery("\\dt", pg);
    expect(tables.error).toBeUndefined();
    expect(tables.results?.map((result) => result.title)).toEqual(["List of tables"]);
    expect(tables.results?.[0]?.fields.map((field) => field.name)).toEqual(["Schema", "Name", "Type", "Owner"]);
    expect(tables.results?.[0]?.rows).toEqual([["public", "notes", "table", "postgres"]]);

    // Several queries run behind \d <table>; the table shown is the description, not the last of them.
    const table = await runQuery("\\d notes", pg);
    expect(table.error).toBeUndefined();
    expect(table.results?.map((result) => result.title)).toEqual(['Table "public.notes"']);
    expect(table.results?.[0]?.fields.map((field) => field.name)).toContain("Column");
    expect(table.results?.[0]?.rows.map((row) => row[0])).toEqual(["id", "body"]);
  });

  it("reports what a describe command says when it finds nothing", async () => {
    const pg = await createTestPgwasm();
    const response = await runQuery("\\d no_such_table", pg);
    expect(response.results).toBeUndefined();
    expect(response.text).toBe('Did not find any relation named "no_such_table".');
    expect((await runQuery("\\nope", pg)).text).toContain("unsupported command");
  });
});

describe("getSchema", () => {
  it("lists every table's columns, in order, by schema-qualified name", async () => {
    const pg = await createTestPgwasm();
    await pg.exec(`
      CREATE SCHEMA "odd schema";
      CREATE TABLE notes (id serial PRIMARY KEY, body text, "Mixed Case" int);
      CREATE TABLE "odd schema".items (name text);
    `);
    const schema = await getSchema(pg);
    expect(schema["public.notes"]).toEqual(["id", "body", "Mixed Case"]);
    expect(schema["odd schema.items"]).toEqual(["name"]);
    expect(schema["pg_catalog.pg_class"]).toContain("relname");
  });
});
