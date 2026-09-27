import { beforeAll, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

import { publicPackages, type PublicPackage } from "../../scripts/build-public-packages";

// The published-bundle artifact contract (ADR-0037 §2 for react, generalized to every public
// package by ADR-0038): every static import in a published bundle is declared in that package's
// manifest, and nothing is bundled except the package's own source. The Bun bundler previously
// inlined every tsconfig-`paths`-mapped dependency (drizzle-orm, @pgxsinkit/contracts) into
// contracts/client/server — `paths` resolution runs before `packages: "external"` classifies
// imports, so those specifiers were no longer bare when the externalization decision was made.
// These tests exercise the REAL built bundles through the same build path `build:public-packages`
// runs, never the source. The render-time downstream proof (packed install, production Vite build,
// consumer typecheck) lives in `scripts/fixture-smoke.ts`.

const repoRoot = join(import.meta.dir, "..", "..");

/**
 * Externals each package's bundles must actually IMPORT (not merely leave undeclared): the
 * dependencies its runtime code is known to reach. Deliberately a positive pin, not "every
 * manifest entry" — a manifest dependency used only for types (react's @pgxsinkit/contracts)
 * legitimately never appears in the emitted bundle.
 */
const EXPECTED_IMPORTS: Record<string, readonly string[]> = {
  "packages/contracts": ["drizzle-orm", "zod"],
  // Only the /drizzle entry imports drizzle-orm (an optional peer); the rest of pgwasm imports nothing.
  "packages/pgwasm": ["drizzle-orm/pg-core/async/session"],
  "packages/pgwasm-c": ["@pgxsinkit/pgwasm", "@pgxsinkit/pgwasm/build", "@pgxsinkit/pgwasm/fs"],
  "packages/pgwasm-pg-dump": ["@pgxsinkit/pgwasm", "@pgxsinkit/pgwasm/protocol"],
  "packages/pgwasm-repl": [
    "react",
    "react/jsx-runtime",
    "@uiw/react-codemirror",
    "@uiw/codemirror-theme-github",
    "@codemirror/commands",
    "@codemirror/lang-sql",
    "@codemirror/language",
    "@codemirror/view",
    "psql-describe",
  ],
  "packages/client": ["@pgxsinkit/contracts", "drizzle-orm", "@pgxsinkit/pgwasm", "@pgxsinkit/pgwasm-c"],
  // zod is a server peer but its bundle never imports it directly — the zod usage the old inlined
  // bundle showed belonged to the vendored contracts copy.
  "packages/server": ["@pgxsinkit/contracts", "drizzle-orm"],
  "packages/react": ["react", "react/jsx-runtime", "@pgxsinkit/client"],
};

/**
 * The files `bun pm pack` puts in a package's tarball — the same pack `bun publish` makes — listed by a
 * dry run, so nothing is written. Paths are relative to the package root.
 */
function packedFiles(packageDir: string): string[] {
  const output = execFileSync("bun", ["pm", "pack", "--dry-run", "--ignore-scripts"], {
    cwd: join(repoRoot, packageDir),
    encoding: "utf8",
  });
  return [...output.matchAll(/^packed\s+\S+\s+(\S.*)$/gm)].map((match) => match[1]!.trim());
}

/** Whether a package.json `license` expression names the Apache License 2.0 (`MIT AND Apache-2.0`). */
function namesApache(license: string | undefined): boolean {
  return /(?:^|[\s(])Apache-2\.0(?:$|[\s)])/.test(license ?? "");
}

/** Every static import specifier in an (unminified, double-quoted) ESM bundle. */
function importSpecifiers(bundle: string): string[] {
  const specifiers = new Set<string>();
  for (const match of bundle.matchAll(/(?:^|\n)\s*import\s+(?:[^"';]+?from\s+)?["']([^"']+)["']/g)) {
    specifiers.add(match[1]!);
  }
  return [...specifiers].sort();
}

function bundlePaths(pkg: PublicPackage): string[] {
  const entries = pkg.entrypoints.map((entry) =>
    join(repoRoot, pkg.packageDir, "dist", entry.replace(/^src\//, "").replace(/\.ts$/, ".js")),
  );
  if (pkg.splitting !== true) return entries;
  // A split build's shared modules live in chunks next to the entries: they are bundles too.
  const dist = join(repoRoot, pkg.packageDir, "dist");
  const chunks = readdirSync(dist)
    .filter((name) => /^chunk-.*\.js$/.test(name))
    .map((name) => join(dist, name));
  return [...entries, ...chunks];
}

/**
 * A relative specifier is the package's own file (a split build's chunk, a build package's artefact):
 * allowed when it resolves inside the package and exists.
 */
function isOwnRelativeFile(pkg: PublicPackage, bundlePath: string, specifier: string): boolean {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return false;
  const packageRoot = join(repoRoot, pkg.packageDir);
  const target = resolve(dirname(bundlePath), specifier);
  return target.startsWith(`${packageRoot}${sep}`) && existsSync(target);
}

for (const pkg of publicPackages) {
  describe(`${pkg.packageDir} built artifact`, () => {
    let bundles: string[] = [];
    let paths: string[] = [];

    beforeAll(() => {
      // Spawned, not in-process: `Bun.build` inside a test process corrupts module resolution for
      // files bun test loads AFTERWARDS in the same process (see the script's --bundles-only note).
      execFileSync("bun", [join(repoRoot, "scripts", "build-public-packages.ts"), "--bundles-only", pkg.packageDir], {
        cwd: repoRoot,
        stdio: "inherit",
      });
      paths = bundlePaths(pkg);
      bundles = paths.map((path) => readFileSync(path, "utf8"));
    });

    it("only imports packages its manifest declares — nothing is inlined", () => {
      const manifest = JSON.parse(readFileSync(join(repoRoot, pkg.packageDir, "package.json"), "utf8")) as {
        dependencies?: Record<string, string>;
        peerDependencies?: Record<string, string>;
      };
      const declared = Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies });
      // Subpaths of a declared package (react/jsx-runtime, @pgxsinkit/pgwasm/live, zod/v4)
      // count as declared.
      const allowed = (specifier: string) =>
        declared.some((name) => specifier === name || specifier.startsWith(`${name}/`));

      bundles.forEach((bundle, index) => {
        const path = paths[index] ?? "";
        expect(
          importSpecifiers(bundle).filter(
            (specifier) => !allowed(specifier) && !isOwnRelativeFile(pkg, path, specifier),
          ),
        ).toEqual([]);
        // The canary for an inlined dependency implementation: drizzle's entity machinery carries
        // this Symbol.for key in every copy.
        expect(bundle).not.toContain("drizzle:entityKind");
      });
    });

    it("imports its known runtime dependencies as externals", () => {
      const specifiers = new Set(bundles.flatMap((bundle) => importSpecifiers(bundle)));
      for (const expected of EXPECTED_IMPORTS[pkg.packageDir] ?? []) {
        expect([...specifiers]).toContain(expected);
      }
    });

    it("emits an external source map whose sources are all the package's own", () => {
      const allSources: string[] = [];
      for (const path of paths) {
        const mapPath = `${path}.map`;
        expect(existsSync(mapPath)).toBe(true);
        const map = JSON.parse(readFileSync(mapPath, "utf8")) as { sources?: string[] };
        // In a split build an entry that only re-exports, or a chunk of bundler runtime helpers, has no
        // sources of its own; the package's bundles together still must (checked below).
        if (pkg.splitting !== true) {
          expect(map.sources?.length ?? 0).toBeGreaterThan(0);
        }
        allSources.push(...(map.sources ?? []));
        // The backstop for the whole contract: the sourcemap names every module the bundle
        // carries, so ANY vendored dependency — declared or not — shows up as a node_modules
        // source. (`packages: "external"` can't serve as the backstop: combined with an explicit
        // `external` list it re-inlines the tsconfig-`paths`-mapped names.)
        const vendored = (map.sources ?? []).filter((source) => source.includes("node_modules"));
        expect(vendored).toEqual([]);
      }
      expect(allSources.length).toBeGreaterThan(0);
    });

    if (pkg.packageDir === "packages/react" || pkg.packageDir === "packages/pgwasm-repl") {
      it("uses the production JSX runtime, never the dev runtime", () => {
        for (const bundle of bundles) {
          expect(bundle).not.toContain("react/jsx-dev-runtime");
          expect(bundle).not.toContain("jsxDEV");
        }
      });
    }

    if (pkg.packageDir === "packages/pgwasm-repl") {
      // Not every bundler can load an imported stylesheet: the styles ship as a string the component renders.
      it("imports no stylesheet", () => {
        for (const bundle of bundles) {
          expect(importSpecifiers(bundle).filter((specifier) => /\.css($|\?)/.test(specifier))).toEqual([]);
          expect(bundle).toContain("pgwasm-repl-root");
        }
      });
    }

    const artefactReferences: Record<string, number> = {
      // pglite.wasm, pglite.data, initdb.wasm (index), prepopulated.tar.gz, amcheck.tar.gz
      "packages/pgwasm-c": 5,
      // pg_dump.wasm (index)
      "packages/pgwasm-pg-dump": 1,
    };
    const expectedReferences = artefactReferences[pkg.packageDir];
    if (expectedReferences !== undefined) {
      // Bundlers copy and fingerprint the artefacts from these literals, so each must point at a file
      // the package ships, from wherever the bundle was emitted.
      it("references artefacts that exist next to every bundle", () => {
        const references = paths.flatMap((path, index) =>
          [...(bundles[index] ?? "").matchAll(/new URL\("([^"]+)", import\.meta\.url\)/g)].map((match) =>
            resolve(dirname(path), match[1] ?? ""),
          ),
        );
        expect(references.length).toBe(expectedReferences);
        for (const target of references) {
          expect(target.startsWith(join(repoRoot, pkg.packageDir, "artefacts") + sep)).toBe(true);
          expect(existsSync(target)).toBe(true);
        }
      });
    }
  });
}

// The licence files every published tarball must carry. Apache-2.0 §4 obliges a package that ships
// Apache-licensed code to give recipients the licence text and keep its attribution notices, so a
// package whose `license` names Apache-2.0 packs its NOTICE and LICENSE-APACHE-2.0 too. `bun pm pack`
// adds a LICENSE by itself but neither of those: they reach the tarball only through `files`.
describe("published licence files", () => {
  for (const pkg of publicPackages) {
    it(`${pkg.packageDir} packs its LICENSE, and its NOTICE and LICENSE-APACHE-2.0 where Apache-2.0 applies`, () => {
      const manifest = JSON.parse(readFileSync(join(repoRoot, pkg.packageDir, "package.json"), "utf8")) as {
        license?: string;
      };
      const packed = packedFiles(pkg.packageDir);
      // An unrecognised dry-run listing must fail here rather than pass by listing nothing.
      expect(packed).toContain("package.json");

      const required = new Set(["LICENSE"]);
      if (namesApache(manifest.license)) {
        required.add("NOTICE");
        required.add("LICENSE-APACHE-2.0");
      }
      // A NOTICE the package keeps holds attributions its recipients are owed (pgwasm-c's reproduces the
      // notices of the components compiled into its artefacts), whatever the package's own licence.
      if (existsSync(join(repoRoot, pkg.packageDir, "NOTICE"))) required.add("NOTICE");

      // Names exactly what the tarball lacks.
      expect([...required].filter((file) => !packed.includes(file))).toEqual([]);
    });
  }
});
