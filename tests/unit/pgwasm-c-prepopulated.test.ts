import { afterEach, describe, expect, it } from "bun:test";

import { ARTEFACT_FILES } from "../../packages/pgwasm-c/src/artefact-pins";
import { prepopulatedDataDir } from "../../packages/pgwasm-c/src/prepopulated";
import type { DataDirEntry } from "../../packages/pgwasm/src/build";
import { readDataDirArchive } from "../../packages/pgwasm/src/core/data-dir-archive";
import { decodeBuildMarker } from "../../packages/pgwasm/src/core/marker";
import { closeTestPgwasms, createTestPgwasm, scratchDir } from "./support/pgwasm";

// `@pgxsinkit/pgwasm-c/prepopulated`: the pinned prepopulated data directory, the seed every other
// pgwasm test boots from. What is special about it is proven here: it is unmarked (the release leaves
// marking to the restore), a database created from it is marked, its owner-and-group modes restore, and
// the lock file it carries from the live database it was taken from is treated as stale.

afterEach(closeTestPgwasms);

const decode = (data: Uint8Array) => new TextDecoder().decode(data);
const entryAt = (entries: readonly DataDirEntry[], path: string) => entries.find((entry) => entry.path === path);

describe("the prepopulated data directory", () => {
  it("is the pinned file", async () => {
    const bytes = new Uint8Array(await (await prepopulatedDataDir()).arrayBuffer());
    const pin = ARTEFACT_FILES["prepopulated.tar.gz"];
    expect(bytes.byteLength).toBe(pin.bytes);
    expect(new Bun.CryptoHasher("sha256").update(bytes).digest("hex")).toBe(pin.sha256);
  });

  it("is an unmarked PostgreSQL 18 data directory, with the lock file of the database it was taken from", async () => {
    const entries = await readDataDirArchive(await prepopulatedDataDir());
    expect(decode(entryAt(entries, "/PG_VERSION")?.data ?? new Uint8Array())).toBe("18\n");
    expect(entryAt(entries, "/PGWASM_BUILD")).toBeUndefined();
    const lockFile = decode(entryAt(entries, "/postmaster.pid")?.data ?? new Uint8Array()).split("\n");
    // A standalone backend records its process id negated; Emscripten's getpid() is 42.
    expect(lockFile[0]).toBe("-42");
  });

  it("is owner-and-group only: directories 0750, files 0640", async () => {
    const entries = await readDataDirArchive(await prepopulatedDataDir());
    const modes = new Set(entries.map((entry) => `${entry.type} ${entry.mode.toString(8)}`));
    expect([...modes].sort()).toEqual(["directory 750", "file 640"]);
  });

  it("restores whatever the modes, into memory and file storage, and every restored file stays writable", async () => {
    // Its modes are not the 0777/0666 of the backups before it: a restore must not carry a mode into the
    // data directory that stops the engine rewriting the files initdb made (the catalogs, pg_control, the WAL).
    const dir = scratchDir("pgwasm-prepopulated-modes");
    try {
      for (const dataDir of [undefined, `file://${dir.path}/db`]) {
        const pg = await createTestPgwasm({
          ...(dataDir === undefined ? {} : { dataDir }),
          loadDataDir: await prepopulatedDataDir(),
        });
        await pg.exec(`
          CREATE TABLE seeded (id int PRIMARY KEY, note text);
          INSERT INTO seeded SELECT n, repeat('x', 100) FROM generate_series(1, 1000) AS n;
        `);
        // Each outside a transaction block: they rewrite catalog files initdb made, and pg_control.
        for (const statement of ["VACUUM FULL pg_class", "VACUUM FULL pg_attribute", "CHECKPOINT"]) {
          await pg.exec(statement);
        }
        const restoredAgain = await createTestPgwasm({ loadDataDir: await pg.dumpDataDir("gzip") });
        expect((await restoredAgain.query("SELECT count(*)::int AS n FROM seeded")).rows).toEqual([{ n: 1000 }]);
        await pg.close();
      }
      const reopened = await createTestPgwasm({ dataDir: `file://${dir.path}/db` });
      expect((await reopened.query("SELECT count(*)::int AS n FROM seeded")).rows).toEqual([{ n: 1000 }]);
      await reopened.close();
    } finally {
      dir.cleanup();
    }
  });

  it("creates databases marked as the C build's", async () => {
    const pg = await createTestPgwasm({ loadDataDir: await prepopulatedDataDir() });
    const marker = entryAt(await readDataDirArchive(await pg.dumpDataDir("none")), "/PGWASM_BUILD");
    expect(marker === undefined ? "unmarked" : decodeBuildMarker(marker.data)).toEqual({ build: "c", dataFormat: 1 });
  });

  it("starts although it holds a lock file, which the engine then writes afresh", async () => {
    const lockFileOf = async (archive: Blob) =>
      decode(entryAt(await readDataDirArchive(archive), "/postmaster.pid")?.data ?? new Uint8Array()).split("\n");
    const taken = await lockFileOf(await prepopulatedDataDir());
    const pg = await createTestPgwasm({ loadDataDir: await prepopulatedDataDir() });
    expect((await pg.query("SELECT 1 AS one")).rows).toEqual([{ one: 1 }]);
    const running = await lockFileOf(await pg.dumpDataDir("none"));
    // The same process id (its own), a new start time: the backend found the file stale and replaced it.
    expect(running[0]).toBe(taken[0]);
    expect(running[2]).not.toBe(taken[2]);
  });

  it("restores into file storage, which then reopens", async () => {
    const dir = scratchDir("pgwasm-prepopulated");
    try {
      const dataDir = `file://${dir.path}/db`;
      const pg = await createTestPgwasm({ dataDir, loadDataDir: await prepopulatedDataDir() });
      await pg.exec("CREATE TABLE seeded (id int); INSERT INTO seeded VALUES (1);");
      await pg.close();
      const reopened = await createTestPgwasm({ dataDir });
      expect((await reopened.query("SELECT id FROM seeded")).rows).toEqual([{ id: 1 }]);
      await reopened.close();
    } finally {
      dir.cleanup();
    }
  });
});
