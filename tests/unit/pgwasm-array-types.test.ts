// Began as a copy of `@electric-sql/pglite`'s tests (taken under its PostgreSQL License option,
// © ElectricSQL — see NOTICE). Owned outright (ADR-0062); compatibility with PGlite is an anti-goal.

import { afterEach, describe, expect, it } from "bun:test";

import { closeTestPgwasms, createTestPgwasm } from "./support/pgwasm";
import { rejectionOf } from "./support/rejection";

afterEach(closeTestPgwasms);

async function withMoodTable() {
  const db = await createTestPgwasm();
  await db.query("CREATE TYPE mood AS ENUM ('sad', 'happy');");
  await db.query("CREATE TABLE IF NOT EXISTS test (id SERIAL PRIMARY KEY, name TEXT, moods mood[]);");
  return db;
}

describe("array types", () => {
  it("does not know an array type created after start", async () => {
    const db = await withMoodTable();
    const error = await rejectionOf(
      db.query("INSERT INTO test (name, moods) VALUES ($1, $2);", ["test2", ["sad", "happy"]]),
    );
    expect(error.message).toBe('malformed array literal: "sad,happy"');
  });

  it("knows it after refreshArrayTypes", async () => {
    const db = await withMoodTable();
    await db.refreshArrayTypes();
    await db.query("INSERT INTO test (name, moods) VALUES ($1, $2);", ["test2", ["sad", "happy"]]);
    const result = await db.query("SELECT * FROM test;");
    expect(result.rows).toEqual([{ id: 1, name: "test2", moods: ["sad", "happy"] }]);
    expect(result.fields.map((field) => field.name)).toEqual(["id", "name", "moods"]);
  });

  it("refreshes idempotently", async () => {
    const db = await withMoodTable();
    await db.refreshArrayTypes();
    await db.refreshArrayTypes();
    await db.query("INSERT INTO test (name, moods) VALUES ($1, $2);", ["x", ["happy"]]);
    expect((await db.query<{ moods: string[] }>("SELECT moods FROM test;")).rows).toEqual([{ moods: ["happy"] }]);
  });
});
