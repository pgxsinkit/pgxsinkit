import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  ARTEFACT_PACKAGES,
  artefactDir,
  artefactPackage,
  assertArtefactsVerified,
  cachedAssetPath,
  discardMismatchedArtefacts,
  ensureArtefacts,
  fetchReleaseAssets,
  releaseAssetUrl,
  verifyArtefacts,
  type ArtefactPackage,
} from "../../scripts/pgwasm-artefacts";
import { scratchDir } from "./support/pgwasm";
import { rejectionOf } from "./support/rejection";

// The build packages' artefacts are pinned by version and checksum and fetched by the root postinstall
// (scripts/pgwasm-artefacts.ts); they are never committed. This file checks what is on disk against the
// pins, the fetching of a release's assets, and the rule that keeps the packages' relative references
// valid once bundled.

const repoRoot = path.join(import.meta.dir, "..", "..");

function sha256(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? sourceFiles(full) : /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

/**
 * Bun.build rewrites neither `new URL("../artefacts/…", import.meta.url)` nor a relative external import
 * when it bundles a nested module into a shallower output file. So a reference to the artefacts may only
 * sit in a module emitted at its own depth: `src/artefacts.ts` (bundled into `dist/index.js`) and a
 * package's other entry points.
 */
const referencingModules: Record<string, (relative: string) => boolean> = {
  "packages/pgwasm-c": (relative) =>
    relative === "src/artefacts.ts" || relative === "src/prepopulated.ts" || path.dirname(relative) === "src/contrib",
  "packages/pgwasm-pg-dump": (relative) => relative === "src/artefacts.ts",
};

const pinnedNames: Record<string, string[]> = {
  "packages/pgwasm-c": [
    "amcheck.tar.gz",
    "initdb.js",
    "initdb.wasm",
    "pglite.data",
    "pglite.js",
    "pglite.wasm",
    "prepopulated.tar.gz",
  ],
  "packages/pgwasm-pg-dump": ["pg_dump.js", "pg_dump.wasm"],
};

describe("the build packages' artefacts", () => {
  it("are pinned to one pgwasm-postgres release's assets, each cached under its release", () => {
    expect(ARTEFACT_PACKAGES.map((pkg) => pkg.packageDir).sort()).toEqual(Object.keys(pinnedNames).sort());
    for (const pkg of ARTEFACT_PACKAGES) {
      expect(Object.keys(pkg.files).sort()).toEqual(pinnedNames[pkg.packageDir] ?? []);
      expect(pkg.release).toEqual(artefactPackage("packages/pgwasm-c").release);
      for (const pin of Object.values(pkg.files)) expect(pin.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    const release = { repository: "pgxsinkit/pgwasm-postgres", tag: "18.3.0" };
    expect(releaseAssetUrl(release, "pglite.wasm")).toBe(
      "https://github.com/pgxsinkit/pgwasm-postgres/releases/download/18.3.0/pglite.wasm",
    );
    expect(path.relative(repoRoot, cachedAssetPath(release, "pglite.wasm"))).toBe(
      ".buildcache/pgwasm-artefacts/pgxsinkit/pgwasm-postgres/18.3.0/pglite.wasm",
    );
  });

  for (const pkg of ARTEFACT_PACKAGES) {
    for (const [name, pin] of Object.entries(pkg.files)) {
      it(`${pkg.packageDir}: ${name} is present with its pinned size and sha256`, async () => {
        const bytes = new Uint8Array(await Bun.file(path.join(artefactDir(pkg), name)).arrayBuffer());
        expect(bytes.byteLength).toBe(pin.bytes);
        expect(sha256(bytes)).toBe(pin.sha256);
      });
    }

    it(`${pkg.packageDir}: are referenced only from modules emitted at their own depth`, () => {
      const packageDir = path.join(repoRoot, pkg.packageDir);
      const allowed = referencingModules[pkg.packageDir] ?? (() => false);
      const offenders = sourceFiles(path.join(packageDir, "src"))
        .map((file) => path.relative(packageDir, file))
        .filter(
          (relative) =>
            /["'`](\.\.\/)+artefacts\//.test(readFileSync(path.join(packageDir, relative), "utf8")) &&
            !allowed(relative),
        );
      expect(offenders).toEqual([]);
    });
  }

  it("deletes a file that fails its pin, and leaves a missing one missing", async () => {
    const pkg = artefactPackage("packages/pgwasm-c");
    const scratch = scratchDir("pgwasm-artefacts");
    try {
      writeFileSync(path.join(scratch.path, "pglite.js"), "not the glue");
      const problems = await verifyArtefacts(pkg, scratch.path);
      expect(problems.find((problem) => problem.name === "pglite.js")?.problem).toMatch(/^size 12, expected \d+$/);
      expect(problems.filter((problem) => problem.problem === "missing")).toHaveLength(
        Object.keys(pkg.files).length - 1,
      );
      discardMismatchedArtefacts(problems, scratch.path);
      expect(existsSync(path.join(scratch.path, "pglite.js"))).toBe(false);
      expect(readdirSync(scratch.path)).toEqual([]);
    } finally {
      scratch.cleanup();
    }
  });

  describe("across packages", () => {
    const cBuild = artefactPackage("packages/pgwasm-c");
    const pgDump = artefactPackage("packages/pgwasm-pg-dump");

    /** Each package's artefacts in its own scratch subdirectory: the C build's empty, pg_dump's with a wrong wasm. */
    function scratchPackages(scratch: { readonly path: string }) {
      const dirOf = (pkg: ArtefactPackage) => path.join(scratch.path, path.basename(pkg.packageDir));
      for (const pkg of [cBuild, pgDump]) mkdirSync(dirOf(pkg));
      const wrong = path.join(dirOf(pgDump), "pg_dump.wasm");
      writeFileSync(wrong, "not pg_dump");
      return { dirOf, wrong };
    }

    it("deletes every package's wrong files before fetching any, so a failed fetch leaves none behind", async () => {
      const scratch = scratchDir("pgwasm-artefacts");
      try {
        const { dirOf, wrong } = scratchPackages(scratch);
        const fetched: string[] = [];
        const failure = await rejectionOf(
          ensureArtefacts([cBuild, pgDump], {
            dirOf,
            fetchPinned: async (pkg) => {
              fetched.push(pkg.packageDir);
              throw new Error("offline");
            },
          }),
        );
        expect(failure.message).toBe("offline");
        expect(fetched).toEqual([cBuild.packageDir]);
        expect(existsSync(wrong)).toBe(false);
      } finally {
        scratch.cleanup();
      }
    });

    it("verify-only names every package's problems, and deletes every wrong file", async () => {
      const scratch = scratchDir("pgwasm-artefacts");
      try {
        const { dirOf, wrong } = scratchPackages(scratch);
        const failure = await rejectionOf(assertArtefactsVerified([cBuild, pgDump], { dirOf }));
        const [cProblems, pgDumpProblems] = failure.message.split(" | ");
        expect(cProblems).toContain(`${cBuild.packageDir}/artefacts/: `);
        expect(cProblems).toContain("amcheck.tar.gz: missing");
        expect(pgDumpProblems).toContain(`${pgDump.packageDir}/artefacts/: `);
        expect(pgDumpProblems).toContain("pg_dump.js: missing");
        expect(pgDumpProblems).toMatch(/pg_dump\.wasm: size 11, expected \d+/);
        expect(existsSync(wrong)).toBe(false);
      } finally {
        scratch.cleanup();
      }
    });
  });
});

describe("fetching a release's assets", () => {
  const encode = (text: string) => new TextEncoder().encode(text);
  const content = encode("the server");
  const pkg: ArtefactPackage = {
    packageDir: "packages/example",
    release: { repository: "pgxsinkit/pgwasm-postgres", tag: "18.3.0" },
    files: { "x.wasm": { bytes: content.byteLength, sha256: sha256(content) } },
  };

  /** A scratch cache and artefacts directory, and a stand-in for GitHub serving `served`. */
  function setUp(served: Uint8Array) {
    const scratch = scratchDir("pgwasm-artefacts");
    const cacheDir = path.join(scratch.path, "cache");
    const dir = path.join(scratch.path, "artefacts");
    const urls: string[] = [];
    const download = async (url: string) => {
      urls.push(url);
      return served;
    };
    return { scratch, cacheDir, dir, urls, download };
  }

  it("downloads each asset once, checks it, caches it, and leaves no .part behind", async () => {
    const { scratch, cacheDir, dir, urls, download } = setUp(content);
    try {
      await fetchReleaseAssets(pkg, dir, ["x.wasm"], { cacheDir, download });
      expect(urls).toEqual(["https://github.com/pgxsinkit/pgwasm-postgres/releases/download/18.3.0/x.wasm"]);
      expect(readFileSync(path.join(dir, "x.wasm"))).toEqual(Buffer.from(content));
      expect(readFileSync(cachedAssetPath(pkg.release, "x.wasm", cacheDir))).toEqual(Buffer.from(content));
      await fetchReleaseAssets(pkg, dir, ["x.wasm"], { cacheDir, download });
      expect(urls).toHaveLength(1);
      expect(readdirSync(dir)).toEqual(["x.wasm"]);
    } finally {
      scratch.cleanup();
    }
  });

  it("refuses an asset that does not match its pin, writing it nowhere", async () => {
    const { scratch, cacheDir, dir, urls, download } = setUp(encode("not the server"));
    try {
      const failure = await rejectionOf(fetchReleaseAssets(pkg, dir, ["x.wasm"], { cacheDir, download }));
      expect(failure.message).toContain("could not download https://github.com/");
      expect(failure.message).toMatch(/does not match its pin: size 14, expected 10/);
      expect(urls).toHaveLength(3);
      expect(existsSync(path.join(dir, "x.wasm"))).toBe(false);
      expect(existsSync(cachedAssetPath(pkg.release, "x.wasm", cacheDir))).toBe(false);
    } finally {
      scratch.cleanup();
    }
  });

  it("replaces a cached asset that no longer matches its pin", async () => {
    const { scratch, cacheDir, dir, urls, download } = setUp(content);
    try {
      const cached = cachedAssetPath(pkg.release, "x.wasm", cacheDir);
      mkdirSync(path.dirname(cached), { recursive: true });
      writeFileSync(cached, "corrupt");
      await fetchReleaseAssets(pkg, dir, ["x.wasm"], { cacheDir, download });
      expect(urls).toHaveLength(1);
      expect(readFileSync(cached)).toEqual(Buffer.from(content));
      expect(readFileSync(path.join(dir, "x.wasm"))).toEqual(Buffer.from(content));
    } finally {
      scratch.cleanup();
    }
  });
});
