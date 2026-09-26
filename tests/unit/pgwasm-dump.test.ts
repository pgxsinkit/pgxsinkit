// Began as a copy of `@electric-sql/pglite`'s tests (taken under its PostgreSQL License option,
// © ElectricSQL — see NOTICE). Owned outright (ADR-0062); compatibility with PGlite is an anti-goal.

import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";

import { BackupFormatError, DataDirExistsError } from "../../packages/pgwasm/src";
import { readDataDirArchive } from "../../packages/pgwasm/src/core/data-dir-archive";
import { decodeBuildMarker } from "../../packages/pgwasm/src/core/marker";
import { closeTestPgwasms, createTestPgwasm } from "./support/pgwasm";
import { rejectionOf } from "./support/rejection";

afterEach(closeTestPgwasms);

async function withRow() {
  const db = await createTestPgwasm();
  await db.exec(`
    CREATE TABLE IF NOT EXISTS test (id SERIAL PRIMARY KEY, name TEXT);
    INSERT INTO test (name) VALUES ('test');
  `);
  return db;
}

describe("Store backups", () => {
  it("dumps a data directory and restores it", async () => {
    const db = await withRow();
    const before = await db.query("SELECT * FROM test;");
    const backup = await db.dumpDataDir();
    expect(backup.name).toBe("pgdata.tar.gz");
    expect(backup.type).toBe("application/x-gzip");
    const restored = await createTestPgwasm({ loadDataDir: backup });
    expect(await restored.query("SELECT * FROM test;")).toEqual(before);
  });

  it("dumps uncompressed", async () => {
    const db = await withRow();
    const backup = await db.dumpDataDir("none");
    expect(backup.name).toBe("pgdata.tar");
    expect(backup.type).toBe("application/x-tar");
    const restored = await createTestPgwasm({ loadDataDir: backup });
    expect((await restored.query("SELECT name FROM test;")).rows).toEqual([{ name: "test" }]);
  });

  it("restores a gzipped backup that lost its type and name", async () => {
    const db = await withRow();
    const backup = new Blob([await db.dumpDataDir()]);
    const restored = await createTestPgwasm({ loadDataDir: backup });
    expect((await restored.query("SELECT name FROM test;")).rows).toEqual([{ name: "test" }]);
  });

  it("dumps a data directory on disk", async () => {
    const scratchParent = path.resolve("tmp/agents");
    mkdirSync(scratchParent, { recursive: true });
    const dir = mkdtempSync(path.join(scratchParent, "pgwasm-dump-"));
    try {
      const db = await createTestPgwasm({ dataDir: `file://${dir}/db` });
      await db.exec("CREATE TABLE test (id SERIAL PRIMARY KEY, name TEXT); INSERT INTO test (name) VALUES ('disk');");
      const backup = await db.dumpDataDir();
      expect(backup.name).toBe("db.tar.gz");
      await db.close();
      const restored = await createTestPgwasm({ loadDataDir: backup });
      expect((await restored.query("SELECT name FROM test;")).rows).toEqual([{ name: "disk" }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a backup cut short, rather than restoring the members before the cut", async () => {
    const db = await withRow();
    const whole = new Uint8Array(await (await db.dumpDataDir("none")).arrayBuffer());
    // Cut at a member boundary: every remaining member is intact, the end records are gone.
    const cut = new File([whole.subarray(0, whole.byteLength - 1024)], "pgdata.tar", { type: "application/x-tar" });
    const error = await rejectionOf(createTestPgwasm({ loadDataDir: cut }));
    expect(error).toBeInstanceOf(BackupFormatError);
    expect(error.message).toContain("truncated");
  });

  it("carries the build marker, in the layout backups have always had", async () => {
    const db = await withRow();
    const entries = await readDataDirArchive(await db.dumpDataDir());
    const paths = entries.map((entry) => entry.path);
    expect(paths).toContain("/PG_VERSION");
    expect(paths.indexOf("/base")).toBeLessThan(paths.findIndex((entry) => entry.startsWith("/base/")));
    const marker = entries.find((entry) => entry.path === "/PGWASM_BUILD");
    expect(decodeBuildMarker(marker?.data ?? new Uint8Array())).toEqual({ build: "c", dataFormat: 1 });
  });

  it("refuses to restore into a data directory that holds a database", async () => {
    const scratchParent = path.resolve("tmp/agents");
    mkdirSync(scratchParent, { recursive: true });
    const dir = mkdtempSync(path.join(scratchParent, "pgwasm-dump-exists-"));
    try {
      const db = await withRow();
      const backup = await db.dumpDataDir();
      const existing = await createTestPgwasm({ dataDir: `file://${dir}/db` });
      await existing.close();
      expect(await rejectionOf(createTestPgwasm({ dataDir: `file://${dir}/db`, loadDataDir: backup }))).toBeInstanceOf(
        DataDirExistsError,
      );
      // The refused open left the directory a working database. (That a refusal releases the storage is
      // proven where storage is held: the spy build in pgwasm-create.test.ts records the release, and the
      // IndexedDB browser lane opens a store again after a failed boot. A file:// directory holds nothing.)
      const reopened = await createTestPgwasm({ dataDir: `file://${dir}/db` });
      expect((await reopened.query<{ one: number }>("SELECT 1 AS one")).rows).toEqual([{ one: 1 }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
