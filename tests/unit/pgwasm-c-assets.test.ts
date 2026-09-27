import { afterEach, describe, expect, it } from "bun:test";
// pgwasm step 3 (bite B2): `createCBuild({ assets })` takes the artefacts an app warmed ahead. A resolved
// promise stands in for the build's own loads; a rejected one is a missed warm-up, never a boot failure —
// the build falls back to loading the artefacts itself.

import { cBuildArtefacts, type CBuildAssets, createCBuild } from "../../packages/pgwasm-c/src";
import { compileModule } from "../../packages/pgwasm-c/src/host/artefact-loader";
import { closeTestPgwasms, createTestPgwasm } from "./support/pgwasm";

afterEach(closeTestPgwasms);

async function warmAssets(): Promise<Required<CBuildAssets>> {
  const [postgresWasmModule, initdbWasmModule, fsBundle] = await Promise.all([
    compileModule(cBuildArtefacts.postgresWasm),
    compileModule(cBuildArtefacts.initdbWasm),
    fetch(cBuildArtefacts.fsBundle).then((response) => response.blob()),
  ]);
  return { postgresWasmModule, initdbWasmModule, fsBundle };
}

describe("createCBuild({ assets })", () => {
  it("boots a fresh data directory on the warmed assets", async () => {
    const warm = await warmAssets();
    const read = new Set<keyof CBuildAssets>();
    // Each getter records that the build took the warmed asset instead of loading its own.
    const assets: CBuildAssets = {
      get postgresWasmModule() {
        read.add("postgresWasmModule");
        return warm.postgresWasmModule;
      },
      get initdbWasmModule() {
        read.add("initdbWasmModule");
        return warm.initdbWasmModule;
      },
      get fsBundle() {
        read.add("fsBundle");
        return warm.fsBundle;
      },
    };
    const pg = await createTestPgwasm({ build: createCBuild({ assets: Promise.resolve(assets) }), fresh: true });
    expect((await pg.query<{ one: number }>("SELECT 1 AS one")).rows).toEqual([{ one: 1 }]);
    expect([...read].sort()).toEqual(["fsBundle", "initdbWasmModule", "postgresWasmModule"]);
  });

  it("falls back to the lazy load when the warm-up rejects", async () => {
    const assets = Promise.reject(new Error("the warm-up failed"));
    const pg = await createTestPgwasm({ build: createCBuild({ assets }), fresh: true });
    expect((await pg.query<{ one: number }>("SELECT 1 AS one")).rows).toEqual([{ one: 1 }]);
  });

  it("an explicit module option wins over the same warmed asset", async () => {
    const warm = await warmAssets();
    let warmedModuleRead = false;
    const assets: CBuildAssets = {
      get postgresWasmModule() {
        warmedModuleRead = true;
        return warm.postgresWasmModule;
      },
    };
    const build = createCBuild({ postgresWasmModule: warm.postgresWasmModule, assets: Promise.resolve(assets) });
    const pg = await createTestPgwasm({ build, fresh: true });
    expect((await pg.query<{ one: number }>("SELECT 1 AS one")).rows).toEqual([{ one: 1 }]);
    expect(warmedModuleRead).toBe(false);
  });
});
