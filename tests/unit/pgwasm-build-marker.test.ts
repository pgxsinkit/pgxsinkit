import { afterEach, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";

import { cBuild } from "../../packages/pgwasm-c/src";
import { BuildMismatchError, DataFormatMismatchError, type Pgwasm } from "../../packages/pgwasm/src";
import { readDataDirArchive } from "../../packages/pgwasm/src/core/data-dir-archive";
import { decodeBuildMarker } from "../../packages/pgwasm/src/core/marker";
import { closeTestPgwasms, createTestPgwasm, scratchDir } from "./support/pgwasm";
import { foreignIdentityBuild } from "./support/pgwasm-build-decorators";
import { rejectionOf } from "./support/rejection";

// Build permanence (ADR-0063): a data directory records the Postgres build that created it, and another
// build refuses it before writing anything. A second build is simulated by the C build under another
// identity.

afterEach(closeTestPgwasms);

async function recordedBuild(db: Pgwasm): Promise<{ build: string; dataFormat: number } | "unmarked"> {
  const marker = (await readDataDirArchive(await db.dumpDataDir("none"))).find(
    (entry) => entry.path === "/PGWASM_BUILD",
  );
  return marker === undefined ? "unmarked" : decodeBuildMarker(marker.data);
}

const foreign = foreignIdentityBuild(cBuild, { name: "foreign" });

describe("the build marker on the C build", () => {
  it("marks a new data directory, and a restored unmarked one", async () => {
    expect(await recordedBuild(await createTestPgwasm({ fresh: true }))).toEqual({ build: "c", dataFormat: 1 });
    // The seed is an unmarked data directory from before builds were recorded.
    expect(await recordedBuild(await createTestPgwasm())).toEqual({ build: "c", dataFormat: 1 });
  });

  it("opens an existing unmarked directory, and leaves it unmarked", async () => {
    const dir = scratchDir("pgwasm-marker-unmarked");
    try {
      const dataDir = `file://${dir.path}/db`;
      await (await createTestPgwasm({ dataDir })).close();
      rmSync(`${dir.path}/db/PGWASM_BUILD`);
      const reopened = await createTestPgwasm({ dataDir });
      expect(reopened.build.name).toBe("c");
      expect(await recordedBuild(reopened)).toBe("unmarked");
      await reopened.close();

      // Another build claims no unmarked directory: refused, and the directory is left as it was.
      const refusal = await rejectionOf(createTestPgwasm({ dataDir, build: foreign }));
      expect(refusal).toBeInstanceOf(BuildMismatchError);
      expect((refusal as BuildMismatchError).found).toBe("unmarked");
      expect(await recordedBuild(await createTestPgwasm({ dataDir }))).toBe("unmarked");
    } finally {
      dir.cleanup();
    }
  });

  // That a refusal also releases the storage is proven where storage is held: the spy build in
  // pgwasm-create.test.ts records the release, and the IndexedDB browser lane opens a store again after a
  // failed boot. A file:// directory holds nothing, so this test cannot show it.
  it("refuses another build's directory before writing, both ways, leaving each directory intact", async () => {
    const dir = scratchDir("pgwasm-marker-mismatch");
    try {
      const cDir = `file://${dir.path}/c`;
      const foreignDir = `file://${dir.path}/foreign`;
      await (await createTestPgwasm({ dataDir: cDir })).close();
      const made = await createTestPgwasm({ dataDir: foreignDir, build: foreign });
      expect(await recordedBuild(made)).toEqual({ build: "foreign", dataFormat: 1 });
      await made.close();

      const intoForeign = await rejectionOf(createTestPgwasm({ dataDir: foreignDir }));
      expect(intoForeign).toBeInstanceOf(BuildMismatchError);
      expect((intoForeign as BuildMismatchError).found).toEqual({ build: "foreign", dataFormat: 1 });
      expect((intoForeign as BuildMismatchError).expected).toEqual({ build: "c", dataFormat: 1 });

      const intoC = await rejectionOf(createTestPgwasm({ dataDir: cDir, build: foreign }));
      expect(intoC).toBeInstanceOf(BuildMismatchError);
      expect((intoC as BuildMismatchError).found).toEqual({ build: "c", dataFormat: 1 });

      // Nothing was written: each directory still opens with its own build.
      expect((await (await createTestPgwasm({ dataDir: cDir })).query("SELECT 1 AS one")).rows).toEqual([{ one: 1 }]);
      const again = await createTestPgwasm({ dataDir: foreignDir, build: foreign });
      expect((await again.query("SELECT 1 AS one")).rows).toEqual([{ one: 1 }]);
    } finally {
      dir.cleanup();
    }
  });

  it("refuses the same build in another data format", async () => {
    const dir = scratchDir("pgwasm-marker-format");
    try {
      const dataDir = `file://${dir.path}/db`;
      await (await createTestPgwasm({ dataDir })).close();
      const nextFormat = foreignIdentityBuild(cBuild, { name: "c", dataFormat: 2, claimsUnmarkedDirectories: true });
      const refusal = await rejectionOf(createTestPgwasm({ dataDir, build: nextFormat }));
      expect(refusal).toBeInstanceOf(DataFormatMismatchError);
      expect((refusal as DataFormatMismatchError).found).toBe(1);
    } finally {
      dir.cleanup();
    }
  });

  it("refuses another build's Store backup, and restores its own", async () => {
    const foreignBackup = await (await createTestPgwasm({ build: foreign, fresh: true })).dumpDataDir();
    const refusal = await rejectionOf(createTestPgwasm({ loadDataDir: foreignBackup }));
    expect(refusal).toBeInstanceOf(BuildMismatchError);
    expect((refusal as BuildMismatchError).source).toBe("backup");
    const restored = await createTestPgwasm({ build: foreign, loadDataDir: foreignBackup });
    expect(await recordedBuild(restored)).toEqual({ build: "foreign", dataFormat: 1 });
  });
});
