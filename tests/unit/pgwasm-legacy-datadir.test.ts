import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { readDataDirArchive } from "../../packages/pgwasm/src/core/data-dir-archive";
import { closeTestPgwasms, createTestPgwasm, scratchDir } from "./support/pgwasm";
import { rejectionOf } from "./support/rejection";

// Existing stores and backups were made by PGlite (the fork pgxsinkit ran on until ADR-0062). They are
// unmarked PostgreSQL 18 C-build directories. The PG19 build must refuse them before startup or any
// restore write, preserving the original data for the PG18 build. The fork left the graph in step 3 of
// ADR-0062, so what it made is checked in under `fixtures/pgwasm-legacy/`, each a
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

describe("PostgreSQL 18 data directories made by PGlite", () => {
  it("refuses the real historical directory before startup, preserving every file and its unmarked state", async () => {
    const dir = scratchDir("pgwasm-legacy");
    try {
      const db = path.join(dir.path, "db");
      mkdirSync(db);
      const entries = await readDataDirArchive(fixture("fork-datadir.tar.zst"));
      expect(new TextDecoder().decode(entries.find((entry) => entry.path === "/PG_VERSION")?.data)).toBe("18\n");
      expect(entries.some((entry) => entry.path === "/PGWASM_BUILD")).toBe(false);
      for (const entry of entries) {
        const target = path.join(db, entry.path);
        if (entry.type === "directory") {
          mkdirSync(target, { recursive: true, mode: entry.mode });
        } else {
          mkdirSync(path.dirname(target), { recursive: true });
          writeFileSync(target, entry.data, { mode: entry.mode });
        }
      }

      const pathsBefore = readdirSync(db, { recursive: true, encoding: "utf8" }).sort((a, b) => a.localeCompare(b));
      const error = await rejectionOf(createTestPgwasm({ dataDir: `file://${db}` }));
      expect(error.message).toContain("requires PostgreSQL 19");
      expect(error.message).toContain('PG_VERSION is "18"');
      expect(readdirSync(db, { recursive: true, encoding: "utf8" }).sort((a, b) => a.localeCompare(b))).toEqual(
        pathsBefore,
      );
      for (const entry of entries) {
        if (entry.type === "file") {
          expect(new Uint8Array(readFileSync(path.join(db, entry.path)))).toEqual(new Uint8Array(entry.data));
        }
      }
    } finally {
      dir.cleanup();
    }
  });

  it("refuses the real historical backup before restoring any member, leaving source and destination intact", async () => {
    const dir = scratchDir("pgwasm-legacy-backup");
    try {
      const archive = fixture("fork-backup.tar.zst");
      const bytesBefore = new Uint8Array(await archive.arrayBuffer());
      const entries = await readDataDirArchive(archive);
      expect(new TextDecoder().decode(entries.find((entry) => entry.path === "/PG_VERSION")?.data)).toBe("18\n");
      expect(entries.some((entry) => entry.path === "/PGWASM_BUILD")).toBe(false);
      const db = path.join(dir.path, "fresh-pg19");
      mkdirSync(db);
      writeFileSync(path.join(db, "keep"), "untouched destination");

      const error = await rejectionOf(createTestPgwasm({ dataDir: `file://${db}`, loadDataDir: archive }));
      expect(error.message).toContain("requires PostgreSQL 19");
      expect(error.message).toContain('PG_VERSION is "18"');
      expect(readdirSync(db)).toEqual(["keep"]);
      expect(readFileSync(path.join(db, "keep"), "utf8")).toBe("untouched destination");
      expect(new Uint8Array(await archive.arrayBuffer())).toEqual(bytesBefore);
    } finally {
      dir.cleanup();
    }
  });
});
