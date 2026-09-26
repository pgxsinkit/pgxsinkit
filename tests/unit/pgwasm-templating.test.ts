// Began as a copy of `@electric-sql/pglite`'s tests (taken under its PostgreSQL License option,
// © ElectricSQL — see NOTICE). Owned outright (ADR-0062); compatibility with PGlite is an anti-goal.

import { describe, expect, it } from "bun:test";

import { identifier, query, raw, sql } from "../../packages/pgwasm/src/templating";

describe("SQL templates", () => {
  it("leaves a plain query untouched", () => {
    expect(query`SELECT * FROM test WHERE value = $1;`).toEqual({
      query: "SELECT * FROM test WHERE value = $1;",
      params: [],
    });
  });

  it("parametrizes interpolated values, null included", () => {
    expect(query`SELECT * FROM test WHERE value = ${"foo"} AND num = ${3};`).toEqual({
      query: "SELECT * FROM test WHERE value = $1 AND num = $2;",
      params: ["foo", 3],
    });
    expect(query`SELECT * FROM test WHERE value = ${null} AND num = ${3};`).toEqual({
      query: "SELECT * FROM test WHERE value = $1 AND num = $2;",
      params: [null, 3],
    });
  });

  it("quotes identifiers", () => {
    expect(query`CREATE TABLE ${identifier`test`} (id int);`).toEqual({
      query: 'CREATE TABLE "test" (id int);',
      params: [],
    });
    expect(query`SELECT * FROM ${identifier`test_${2 + 3}_${"dance"}`};`).toEqual({
      query: 'SELECT * FROM "test_5_dance";',
      params: [],
    });
  });

  it("splices raw SQL as it is", () => {
    expect(query`SELECT * FROM test ${raw`WHERE value = ${"'foo'"} AND num = ${3}`};`).toEqual({
      query: "SELECT * FROM test WHERE value = 'foo' AND num = 3;",
      params: [],
    });
  });

  it("nests templates, keeping their parameters", () => {
    const statement = (filter?: string) =>
      query`SELECT * FROM ${identifier`test`}${filter !== undefined ? sql` WHERE ${identifier`foo`} = ${filter}` : sql``};`;
    expect(statement("foo")).toEqual({ query: 'SELECT * FROM "test" WHERE "foo" = $1;', params: ["foo"] });
    expect(statement()).toEqual({ query: 'SELECT * FROM "test";', params: [] });
  });

  it("numbers parameters without counting spliced pieces", () => {
    expect(query`SELECT * FROM ${identifier`test`} ${raw`WHERE value = ${"'foo'"}`} AND num = ${3};`).toEqual({
      query: "SELECT * FROM \"test\" WHERE value = 'foo' AND num = $1;",
      params: [3],
    });
  });
});
