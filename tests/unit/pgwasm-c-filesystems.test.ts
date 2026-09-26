// Began as a copy of `@electric-sql/pglite`'s tests (taken under its PostgreSQL License option,
// © ElectricSQL — see NOTICE). Owned outright (ADR-0062); compatibility with PGlite is an anti-goal.

import { afterEach, describe, expect, it } from "bun:test";

import { idbDatabaseName, idbLockName } from "../../packages/pgwasm-c/src/host/mounts/idb";
import { closeTestPgwasms, createTestPgwasm, scratchDir } from "./support/pgwasm";

afterEach(closeTestPgwasms);

async function basics(dataDir: string) {
  const db = await createTestPgwasm({ dataDir });
  await db.exec("CREATE TABLE IF NOT EXISTS test (id SERIAL PRIMARY KEY, name TEXT);");
  await db.query("INSERT INTO test (name) VALUES ($1);", ["test"]);
  expect((await db.query("SELECT * FROM test;")).rows).toEqual([{ id: 1, name: "test" }]);
  return db;
}

describe("memory storage", () => {
  it("runs a database in memory, reported as such", async () => {
    const db = await basics("memory://");
    expect(db.storage).toEqual({ kind: "memory" });
  });

  it("starts empty on every open", async () => {
    const first = await createTestPgwasm({ dataDir: "memory://same" });
    await first.exec("CREATE TABLE only_here (id int)");
    await first.close();
    const second = await createTestPgwasm({ dataDir: "memory://same" });
    expect((await second.query("SELECT to_regclass('only_here') AS t")).rows).toEqual([{ t: null }]);
  });
});

describe("file storage", () => {
  it("persists across close and reopen", async () => {
    const dir = scratchDir("pgwasm-file");
    try {
      const dataDir = `file://${dir.path}/db`;
      const db = await basics(dataDir);
      expect(db.storage).toEqual({ kind: "file", path: `${dir.path}/db` });
      await db.close();
      const reopened = await createTestPgwasm({ dataDir });
      expect((await reopened.query("SELECT * FROM test;")).rows).toEqual([{ id: 1, name: "test" }]);
    } finally {
      dir.cleanup();
    }
  });

  it("restarts after an unclean shutdown, keeping what was written", async () => {
    const dir = scratchDir("pgwasm-file-unclean");
    try {
      const dataDir = `file://${dir.path}/db`;
      const db = await createTestPgwasm({ dataDir });
      await db.exec("CREATE TABLE IF NOT EXISTS test (id SERIAL PRIMARY KEY, name TEXT);");
      await db.exec("INSERT INTO test (name) VALUES ('test');");
      // One statement per exec: a multi-statement exec is one implicit transaction, and these refuse one.
      await db.exec("DROP DATABASE IF EXISTS mypostgres;");
      await db.exec("CREATE DATABASE mypostgres TEMPLATE template1;");
      // Never closed: the next open recovers.
      const reopened = await createTestPgwasm({ dataDir, database: "postgres" });
      expect((await reopened.query("SELECT * FROM test;")).rows).toEqual([{ id: 1, name: "test" }]);
    } finally {
      dir.cleanup();
    }
  });

  it("creates a database from another and opens it", async () => {
    const dir = scratchDir("pgwasm-file-template");
    try {
      const dataDir = `file://${dir.path}/db`;
      const db = await createTestPgwasm({ dataDir });
      await db.exec("CREATE TABLE IF NOT EXISTS test (id SERIAL PRIMARY KEY, name TEXT);");
      await db.exec("INSERT INTO test (name) VALUES ('test');");
      await db.exec("CREATE DATABASE mypostgres TEMPLATE postgres;");
      await db.close();
      const other = await createTestPgwasm({ dataDir, database: "mypostgres" });
      expect((await other.query("SELECT * FROM test;")).rows).toEqual([{ id: 1, name: "test" }]);
    } finally {
      dir.cleanup();
    }
  });
});

describe("IndexedDB storage identities", () => {
  // Existing stores are found by these names: the IndexedDB database (IDBFS names it after the mount
  // point) and the Web Lock that guards it. Changing either would orphan every store made before.
  it("keeps the database name /pglite/<name> and the Web Lock pglite-idbfs:/pglite/<name>", () => {
    expect(idbDatabaseName("store")).toBe("/pglite/store");
    expect(idbLockName("store")).toBe("pglite-idbfs:/pglite/store");
    expect(idbDatabaseName("a b/c")).toBe("/pglite/a b/c");
    expect(idbLockName("a b/c")).toBe("pglite-idbfs:/pglite/a b/c");
  });
});
