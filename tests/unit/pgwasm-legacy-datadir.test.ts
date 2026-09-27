import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { readDataDirArchive } from "../../packages/pgwasm/src/core/data-dir-archive";
import { closeTestPgwasms, createTestPgwasm, scratchDir } from "./support/pgwasm";

// Existing stores and backups were made by PGlite (the fork pgxsinkit ran on until ADR-0062). They are
// unmarked C-build data directories and must open, and restore, on pgwasm's C build. The fork left the
// graph in step 3 of ADR-0062, so what it made is checked in under `fixtures/pgwasm-legacy/`, each a
// ustar compressed with zstd, both made by the fork `@electric-sql/pglite` 0.5.8-pgx.2:
// - `fork-datadir.tar.zst`: a `file://` data directory, closed cleanly after
//   `CREATE TABLE legacy (id int, note text); INSERT INTO legacy VALUES (1, 'from pglite');`;
// - `fork-backup.tar.zst`: `dumpDataDir()` of an in-memory store after
//   `CREATE TABLE t (id int); INSERT INTO t VALUES (1);` (the fork's tarball, taken out of its gzip).
// Restoring pgwasm's backups into PGlite was retired with the switch (docs/testing-strategy.md).

const fixtures = path.join(import.meta.dir, "fixtures", "pgwasm-legacy");

function fixture(name: string): Blob {
  return new Blob([new Uint8Array(Bun.zstdDecompressSync(readFileSync(path.join(fixtures, name))))]);
}

afterEach(closeTestPgwasms);

describe("data directories made by PGlite", () => {
  it("opens one on disk, leaving it unmarked", async () => {
    const dir = scratchDir("pgwasm-legacy");
    try {
      const db = path.join(dir.path, "db");
      mkdirSync(db);
      for (const entry of await readDataDirArchive(fixture("fork-datadir.tar.zst"))) {
        const target = path.join(db, entry.path);
        if (entry.type === "directory") {
          mkdirSync(target, { recursive: true, mode: entry.mode });
        } else {
          mkdirSync(path.dirname(target), { recursive: true });
          writeFileSync(target, entry.data, { mode: entry.mode });
        }
      }

      const pg = await createTestPgwasm({ dataDir: `file://${db}` });
      expect((await pg.query("SELECT * FROM legacy")).rows).toEqual([{ id: 1, note: "from pglite" }]);
      const entries = await readDataDirArchive(await pg.dumpDataDir("none"));
      expect(entries.some((entry) => entry.path === "/PGWASM_BUILD")).toBe(false);
    } finally {
      dir.cleanup();
    }
  });

  it("restores PGlite's backups", async () => {
    const pg = await createTestPgwasm({ loadDataDir: fixture("fork-backup.tar.zst") });
    expect((await pg.query("SELECT id FROM t")).rows).toEqual([{ id: 1 }]);
    await pg.exec("INSERT INTO t VALUES (2);");
    expect((await pg.query("SELECT id FROM t ORDER BY id")).rows).toEqual([{ id: 1 }, { id: 2 }]);
  });
});
