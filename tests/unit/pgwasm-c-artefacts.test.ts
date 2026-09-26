import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { ARTEFACT_FILES, ARTEFACT_SOURCE, type ArtefactName } from "../../packages/pgwasm-c/src/artefact-pins";
import { discardMismatchedArtefacts, verifyPgwasmArtefacts } from "../../scripts/pgwasm-artefacts";
import { scratchDir } from "./support/pgwasm";

// The C build's artefacts are pinned by version and checksum and fetched by the root postinstall
// (scripts/pgwasm-artefacts.ts); they are never committed. This file checks what is on disk against the
// pins, and the rule that keeps their relative references valid once bundled.

const packageDir = path.join(import.meta.dir, "..", "..", "packages", "pgwasm-c");
const names = Object.keys(ARTEFACT_FILES) as ArtefactName[];

function sha256(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? sourceFiles(full) : entry.name.endsWith(".ts") ? [full] : [];
  });
}

describe("the C build's artefacts", () => {
  it("pin the npm tarball they are republished from", () => {
    expect(ARTEFACT_SOURCE.tarball).toBe(
      `https://registry.npmjs.org/${ARTEFACT_SOURCE.package}/-/pglite-${ARTEFACT_SOURCE.version}.tgz`,
    );
    expect(ARTEFACT_SOURCE.integrity).toMatch(/^sha512-[A-Za-z0-9+/]{86}==$/);
    expect(names.map(String).sort()).toEqual(
      ["amcheck.tar.gz", "initdb.js", "initdb.wasm", "pglite.data", "pglite.js", "pglite.wasm"].sort(),
    );
  });

  for (const name of names) {
    it(`${name} is present with its pinned size and sha256`, async () => {
      const bytes = new Uint8Array(await Bun.file(path.join(packageDir, "artefacts", name)).arrayBuffer());
      expect(bytes.byteLength).toBe(ARTEFACT_FILES[name].bytes);
      expect(sha256(bytes)).toBe(ARTEFACT_FILES[name].sha256);
    });
  }

  // Bun.build rewrites neither `new URL("../artefacts/…", import.meta.url)` nor a relative external
  // import when it bundles a nested module into a shallower output file. So a reference to the
  // artefacts may only sit in a module that is emitted at its own depth: src/artefacts.ts (bundled into
  // dist/index.js) and the src/contrib/*.ts entry points (dist/contrib/*.js).
  it("are referenced only from modules emitted at their own depth", () => {
    const allowed = (file: string) =>
      file === path.join(packageDir, "src", "artefacts.ts") ||
      path.dirname(file) === path.join(packageDir, "src", "contrib");
    const offenders = sourceFiles(path.join(packageDir, "src")).filter(
      (file) => /["'`](\.\.\/)+artefacts\//.test(readFileSync(file, "utf8")) && !allowed(file),
    );
    expect(offenders.map((file) => path.relative(packageDir, file))).toEqual([]);
  });

  it("deletes a file that fails its pin, and leaves a missing one missing", async () => {
    const scratch = scratchDir("pgwasm-artefacts");
    try {
      writeFileSync(path.join(scratch.path, "pglite.js"), "not the glue");
      const problems = await verifyPgwasmArtefacts(scratch.path);
      expect(problems.find((problem) => problem.name === "pglite.js")?.problem).toMatch(/^size 12, expected \d+$/);
      expect(problems.filter((problem) => problem.problem === "missing").map((problem) => problem.name)).toHaveLength(
        names.length - 1,
      );
      discardMismatchedArtefacts(problems, scratch.path);
      expect(existsSync(path.join(scratch.path, "pglite.js"))).toBe(false);
      expect(readdirSync(scratch.path)).toEqual([]);
    } finally {
      scratch.cleanup();
    }
  });
});
