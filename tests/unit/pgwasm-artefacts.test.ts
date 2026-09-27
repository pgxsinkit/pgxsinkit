import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { TarEntry } from "../../packages/pgwasm/src/tar/tar";
import {
  ARTEFACT_PACKAGES,
  artefactDir,
  artefactPackage,
  cachedTarballPath,
  discardMismatchedArtefacts,
  extractPinned,
  verifyArtefacts,
  type ArtefactPin,
} from "../../scripts/pgwasm-artefacts";
import { scratchDir } from "./support/pgwasm";

// The build packages' artefacts are pinned by version and checksum and fetched by the root postinstall
// (scripts/pgwasm-artefacts.ts); they are never committed. This file checks what is on disk against the
// pins, the extraction of each kind of pin, and the rule that keeps the packages' relative references
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
  it("are pinned to npm tarballs by registry URL and sha512, each cached under its own name", () => {
    expect(ARTEFACT_PACKAGES.map((pkg) => pkg.packageDir).sort()).toEqual(Object.keys(pinnedNames).sort());
    const sources = new Map<string, ArtefactPin["source"]>();
    for (const pkg of ARTEFACT_PACKAGES) {
      expect(Object.keys(pkg.files).sort()).toEqual(pinnedNames[pkg.packageDir] ?? []);
      for (const pin of Object.values(pkg.files)) sources.set(pin.source.tarball, pin.source);
    }
    for (const source of sources.values()) {
      const unscoped = source.package.replace(/^@[^/]+\//, "");
      expect(source.tarball).toBe(`https://registry.npmjs.org/${source.package}/-/${unscoped}-${source.version}.tgz`);
      expect(source.integrity).toMatch(/^sha512-[A-Za-z0-9+/]{86}==$/);
    }
    const cachePaths = [...sources.values()].map(cachedTarballPath);
    expect(new Set(cachePaths).size).toBe(cachePaths.length);
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
});

describe("extracting a pinned file from its tarball", () => {
  const source = { package: "example", version: "1.0.0", tarball: "https://example.test/x.tgz", integrity: "" };
  const encode = (text: string) => new TextEncoder().encode(text);
  const members = (entries: Record<string, string>) =>
    new Map<string, TarEntry>(
      Object.entries(entries).map(([name, text]) => [
        name,
        { name, type: "file", mode: 0o644, mtimeSeconds: 0, data: encode(text) },
      ]),
    );
  const loader = "var Module = 1;\nexport default Module;\n";
  const map = JSON.stringify({
    version: 3,
    sources: ["../src/a.ts", "../release/x.js"],
    sourcesContent: ["a", loader],
  });

  it("takes a member byte for byte", () => {
    const pin = { source, from: { member: "package/dist/x.wasm" }, bytes: 3, sha256: "" };
    expect(extractPinned(members({ "package/dist/x.wasm": "abc" }), pin)).toEqual(encode("abc"));
  });

  it("takes a source map's sourcesContent entry, UTF-8 encoded", () => {
    const pin = {
      source,
      from: { sourceMap: "package/dist/x.js.map", source: "../release/x.js" },
      bytes: 0,
      sha256: "",
    };
    expect(extractPinned(members({ "package/dist/x.js.map": map }), pin)).toEqual(encode(loader));
  });

  it("refuses a missing member, a source the map does not name, and a source without content", () => {
    const pin = (from: ArtefactPin["from"]) => ({ source, from, bytes: 0, sha256: "" });
    expect(() => extractPinned(members({}), pin({ member: "package/dist/x.wasm" }))).toThrow(/has no member/);
    expect(() =>
      extractPinned(members({ "m.map": map }), pin({ sourceMap: "m.map", source: "../release/y.js" })),
    ).toThrow(/does not name the source/);
    const withoutContent = JSON.stringify({ version: 3, sources: ["../release/x.js"], sourcesContent: [null] });
    expect(() =>
      extractPinned(members({ "m.map": withoutContent }), pin({ sourceMap: "m.map", source: "../release/x.js" })),
    ).toThrow(/carries no content/);
    expect(() =>
      extractPinned(members({ "m.map": "not json" }), pin({ sourceMap: "m.map", source: "../release/x.js" })),
    ).toThrow(/not a JSON source map/);
  });
});
