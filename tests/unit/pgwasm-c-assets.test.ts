import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { runInNewContext } from "node:vm";
// pgwasm step 3 (bite B2): `createCBuild({ assets })` takes the artefacts an app warmed ahead. A resolved
// promise stands in for the build's own loads; a rejected one is a missed warm-up, never a boot failure —
// the build falls back to loading the artefacts itself.

import { cBuildArtefacts, type CBuildAssets, createCBuild } from "../../packages/pgwasm-c/src";
import { pinnedCBuildArtefacts, type CBuildArtefactSet } from "../../packages/pgwasm-c/src/artefacts";
import { C_BUILD_IDENTITY, createCBuildFrom } from "../../packages/pgwasm-c/src/build";
import { compileModule } from "../../packages/pgwasm-c/src/host/artefact-loader";
import { closeTestPgwasms, createTestPgwasm, scratchDir } from "./support/pgwasm";

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
  it("keeps the default URLs lazy through an IIFE import and supplied-asset build creation", async () => {
    const scratch = scratchDir("pgwasm-c-iife");
    try {
      const output = path.join(scratch.path, "probe.js");
      execFileSync("bun", [path.join(import.meta.dir, "support/build-pgwasm-c-iife.ts"), output]);
      const context = {
        URL,
        Blob,
        WebAssembly,
        TextEncoder,
        TextDecoder,
        console,
      } as Record<string, unknown>;
      // IIFE output has no usable import.meta.url. The old eager defaults threw while importing.
      runInNewContext(readFileSync(output, "utf8"), context);
      const probe = context["pgwasmCAssetProbe"] as {
        createCBuild: typeof createCBuild;
        cBuildArtefacts: typeof cBuildArtefacts;
      };
      const module = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
      const build = probe.createCBuild({ postgresWasmModule: module, initdbWasmModule: module, fsBundle: new Blob() });
      await build.prepare!();
      // Defaults are still resolved on demand, and consequently need a valid module URL.
      expect(() => probe.cBuildArtefacts.postgresWasm).toThrow();
    } finally {
      scratch.cleanup();
    }
  });

  it("reuses each lazily resolved public URL through the pinned asset set", () => {
    for (const key of ["postgresWasm", "initdbWasm", "fsBundle"] as const) {
      const first = cBuildArtefacts[key];
      expect(first).toBeInstanceOf(URL);
      expect(cBuildArtefacts[key]).toBe(first);
      expect(pinnedCBuildArtefacts[key]).toBe(first);
    }
  });

  it("boots with supplied assets without consulting any default URL", async () => {
    const warm = await warmAssets();
    const noDefaultUrls: CBuildArtefactSet = {
      createPostgresModule: pinnedCBuildArtefacts.createPostgresModule,
      createInitdbModule: pinnedCBuildArtefacts.createInitdbModule,
      fsBundleBytes: pinnedCBuildArtefacts.fsBundleBytes,
      get postgresWasm(): URL {
        throw new Error("default Postgres URL accessed");
      },
      get initdbWasm(): URL {
        throw new Error("default initdb URL accessed");
      },
      get fsBundle(): URL {
        throw new Error("default bundle URL accessed");
      },
    };
    const build = createCBuildFrom(C_BUILD_IDENTITY, noDefaultUrls, { assets: Promise.resolve(warm) });
    const pg = await createTestPgwasm({ build, fresh: true });
    expect((await pg.query<{ one: number }>("SELECT 1 AS one")).rows).toEqual([{ one: 1 }]);
  });

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

describe("createCBuild prepare()", () => {
  it("settles once the warm settles, and never rejects when the warm does", async () => {
    let release!: () => void;
    const warm = new Promise<CBuildAssets>((resolve) => {
      release = () => resolve({});
    });
    const build = createCBuild({ assets: warm });
    let prepared = false;
    const preparing = build.prepare!().then(() => {
      prepared = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(prepared).toBe(false);
    release();
    await preparing;
    expect(prepared).toBe(true);

    const rejected = Promise.reject(new Error("warm failed"));
    rejected.catch(() => undefined);
    // oxlint-disable-next-line typescript/await-thenable -- bun-types gap: .resolves/.rejects matchers return a real promise typed as void
    await expect(createCBuild({ assets: rejected }).prepare!()).resolves.toBeUndefined();
    // With nothing warmed ahead there is nothing to wait for.
    // oxlint-disable-next-line typescript/await-thenable -- bun-types gap: .resolves/.rejects matchers return a real promise typed as void
    await expect(createCBuild().prepare!()).resolves.toBeUndefined();
  });
});
