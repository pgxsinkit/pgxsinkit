import { afterEach, describe, expect, it } from "bun:test";

import { PGlite } from "@electric-sql/pglite";

import { readDataDirArchive } from "../../packages/pgwasm/src/core/data-dir-archive";
import { closeTestPgwasms, createTestPgwasm, scratchDir } from "./support/pgwasm";

// Existing stores and backups were made by PGlite (the fork pgxsinkit ran on until ADR-0062). They are
// unmarked C-build data directories and must open, and restore, on pgwasm's C build; a pgwasm backup
// restores into PGlite too, which keeps going back possible while the switch is under way. This file
// goes with @electric-sql/pglite in step 3 of ADR-0062; the unmarked prepopulated seed covers the rest.

afterEach(closeTestPgwasms);

describe("data directories made by PGlite", () => {
  it("opens one on disk, leaving it unmarked", async () => {
    const dir = scratchDir("pgwasm-legacy");
    try {
      const pglite = await PGlite.create({ dataDir: `file://${dir.path}/db` });
      await pglite.exec("CREATE TABLE legacy (id int, note text); INSERT INTO legacy VALUES (1, 'from pglite');");
      await pglite.close();

      const pg = await createTestPgwasm({ dataDir: `file://${dir.path}/db` });
      expect((await pg.query("SELECT * FROM legacy")).rows).toEqual([{ id: 1, note: "from pglite" }]);
      const entries = await readDataDirArchive(await pg.dumpDataDir("none"));
      expect(entries.some((entry) => entry.path === "/PGWASM_BUILD")).toBe(false);
    } finally {
      dir.cleanup();
    }
  });

  it("restores PGlite's backups, and PGlite restores pgwasm's", async () => {
    const pglite = await PGlite.create();
    await pglite.exec("CREATE TABLE t (id int); INSERT INTO t VALUES (1);");
    const fromPglite = await pglite.dumpDataDir();
    await pglite.close();

    const pg = await createTestPgwasm({ loadDataDir: fromPglite });
    expect((await pg.query("SELECT id FROM t")).rows).toEqual([{ id: 1 }]);
    await pg.exec("INSERT INTO t VALUES (2);");

    const back = await PGlite.create({ loadDataDir: await pg.dumpDataDir() });
    expect((await back.query("SELECT id FROM t ORDER BY id")).rows).toEqual([{ id: 1 }, { id: 2 }]);
    await back.close();
  });
});
