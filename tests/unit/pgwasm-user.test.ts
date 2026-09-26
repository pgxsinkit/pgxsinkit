// Began as a copy of `@electric-sql/pglite`'s tests (taken under its PostgreSQL License option,
// © ElectricSQL — see NOTICE). Owned outright (ADR-0062); compatibility with PGlite is an anti-goal.

import { afterEach, describe, expect, it } from "bun:test";

import { closeTestPgwasms, createTestPgwasm, scratchDir } from "./support/pgwasm";
import { rejectionOf } from "./support/rejection";

afterEach(closeTestPgwasms);

describe("the username and database options", () => {
  it("runs as another role, with that role's permissions", async () => {
    const dir = scratchDir("pgwasm-user");
    try {
      const dataDir = `file://${dir.path}/db`;
      const db = await createTestPgwasm({ dataDir });
      await db.exec(`
        CREATE USER test_user WITH PASSWORD 'md5abdbecd56d5fbd2cdaee3d0fa9e4f434';
        CREATE TABLE test (id SERIAL PRIMARY KEY, number INT);
        INSERT INTO test (number) VALUES (42);
        CREATE TABLE test2 (id SERIAL PRIMARY KEY, number INT);
        INSERT INTO test2 (number) VALUES (42);
        ALTER TABLE test2 OWNER TO test_user;
      `);
      await db.close();

      const asUser = await createTestPgwasm({ dataDir, username: "test_user" });
      expect((await asUser.query("SELECT current_user;")).rows).toEqual([{ current_user: "test_user" }]);
      expect((await rejectionOf(asUser.query("SELECT * FROM test;"))).message).toBe("permission denied for table test");
      expect((await asUser.query("SELECT * FROM test2;")).rows).toEqual([{ id: 1, number: 42 }]);
      await rejectionOf(asUser.query("SET ROLE no_such_user;"));
    } finally {
      dir.cleanup();
    }
  });

  it("opens another database in the same data directory", async () => {
    const dir = scratchDir("pgwasm-user-db");
    try {
      const dataDir = `file://${dir.path}/db`;
      const db = await createTestPgwasm({ dataDir });
      await db.exec("CREATE USER test_user WITH PASSWORD 'md5abdbecd56d5fbd2cdaee3d0fa9e4f434';");
      await db.exec("CREATE DATABASE test_db OWNER test_user;");
      await db.close();

      const other = await createTestPgwasm({ dataDir, username: "test_user", database: "test_db" });
      expect((await other.query("SELECT current_user;")).rows).toEqual([{ current_user: "test_user" }]);
      expect((await other.query("SELECT current_database();")).rows).toEqual([{ current_database: "test_db" }]);
    } finally {
      dir.cleanup();
    }
  });

  it("fails the boot for a role that does not exist, and releases the storage", async () => {
    const dir = scratchDir("pgwasm-user-missing");
    try {
      const dataDir = `file://${dir.path}/db`;
      const db = await createTestPgwasm({ dataDir });
      await db.close();
      await rejectionOf(createTestPgwasm({ dataDir, username: "role_that_does_not_exist" }));
      const again = await createTestPgwasm({ dataDir });
      expect((await again.query<{ one: number }>("SELECT 1 AS one")).rows).toEqual([{ one: 1 }]);
    } finally {
      dir.cleanup();
    }
  });
});
