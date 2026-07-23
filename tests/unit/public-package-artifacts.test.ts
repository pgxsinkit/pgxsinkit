import { beforeAll, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

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
  "packages/pglite-opfs-repacked": ["@electric-sql/pglite"],
  "packages/client": ["@pgxsinkit/contracts", "drizzle-orm", "@electric-sql/pglite"],
  // zod is a server peer but its bundle never imports it directly — the zod usage the old inlined
  // bundle showed belonged to the vendored contracts copy.
  "packages/server": ["@pgxsinkit/contracts", "drizzle-orm"],
  "packages/react": ["react", "react/jsx-runtime", "@pgxsinkit/client"],
};

const OPFS_REPACKED_RUNTIME_EXPORTS = [
  "CorruptStoreError",
  "DurabilityModeMismatchError",
  "ExtentSizeMismatchError",
  "FsError",
  "OpfsRepackedFS",
  "StoreClosedError",
  "StoreFailedError",
  "StoreLimitError",
  "StoreOwnedError",
  "StoreRecreationRequiredError",
  "UnexpectedStoreEntryError",
  "createOpfsRepackedPGlite",
] as const;

/** Every static import specifier in an (unminified, double-quoted) ESM bundle. */
function importSpecifiers(bundle: string): string[] {
  const specifiers = new Set<string>();
  for (const match of bundle.matchAll(/(?:^|\n)\s*import\s+(?:[^"';]+?from\s+)?["']([^"']+)["']/g)) {
    specifiers.add(match[1]!);
  }
  return [...specifiers].sort();
}

function bundlePaths(pkg: PublicPackage): string[] {
  return pkg.entrypoints.map((entry) =>
    join(repoRoot, pkg.packageDir, "dist", entry.replace(/^src\//, "").replace(/\.ts$/, ".js")),
  );
}

for (const pkg of publicPackages) {
  describe(`${pkg.packageDir} built artifact`, () => {
    let bundles: string[] = [];

    beforeAll(() => {
      // Spawned, not in-process: `Bun.build` inside a test process corrupts module resolution for
      // files bun test loads AFTERWARDS in the same process (see the script's --bundles-only note).
      execFileSync("bun", [join(repoRoot, "scripts", "build-public-packages.ts"), "--bundles-only", pkg.packageDir], {
        cwd: repoRoot,
        stdio: "inherit",
      });
      bundles = bundlePaths(pkg).map((path) => readFileSync(path, "utf8"));
    });

    it("only imports packages its manifest declares — nothing is inlined", () => {
      const manifest = JSON.parse(readFileSync(join(repoRoot, pkg.packageDir, "package.json"), "utf8")) as {
        dependencies?: Record<string, string>;
        peerDependencies?: Record<string, string>;
      };
      const declared = Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies });
      // Subpaths of a declared package (react/jsx-runtime, @electric-sql/pglite/live, zod/v4)
      // count as declared.
      const allowed = (specifier: string) =>
        declared.some((name) => specifier === name || specifier.startsWith(`${name}/`));

      for (const bundle of bundles) {
        expect(importSpecifiers(bundle).filter((specifier) => !allowed(specifier))).toEqual([]);
        // The canary for an inlined dependency implementation: drizzle's entity machinery carries
        // this Symbol.for key in every copy.
        expect(bundle).not.toContain("drizzle:entityKind");
      }
    });

    it("imports its known runtime dependencies as externals", () => {
      const specifiers = new Set(bundles.flatMap((bundle) => importSpecifiers(bundle)));
      for (const expected of EXPECTED_IMPORTS[pkg.packageDir] ?? []) {
        expect([...specifiers]).toContain(expected);
      }
    });

    it("emits an external source map whose sources are all the package's own", () => {
      for (const path of bundlePaths(pkg)) {
        const mapPath = `${path}.map`;
        expect(existsSync(mapPath)).toBe(true);
        const map = JSON.parse(readFileSync(mapPath, "utf8")) as { sources?: string[] };
        expect(map.sources?.length ?? 0).toBeGreaterThan(0);
        // The backstop for the whole contract: the sourcemap names every module the bundle
        // carries, so ANY vendored dependency — declared or not — shows up as a node_modules
        // source. (`packages: "external"` can't serve as the backstop: combined with an explicit
        // `external` list it re-inlines the tsconfig-`paths`-mapped names.)
        const vendored = (map.sources ?? []).filter((source) => source.includes("node_modules"));
        expect(vendored).toEqual([]);
      }
    });

    if (pkg.packageDir === "packages/react") {
      it("uses the production JSX runtime, never the dev runtime", () => {
        for (const bundle of bundles) {
          expect(bundle).not.toContain("react/jsx-dev-runtime");
          expect(bundle).not.toContain("jsxDEV");
        }
      });
    }

    if (pkg.packageDir === "packages/pglite-opfs-repacked") {
      it("exports only the adapter, factory, and stable runtime errors", async () => {
        const entry = join(repoRoot, pkg.packageDir, "dist", "index.js");
        const publicApi = (await import(pathToFileURL(entry).href)) as Record<string, unknown>;
        expect(Object.keys(publicApi).sort()).toEqual([...OPFS_REPACKED_RUNTIME_EXPORTS].sort());
      });
    }
  });
}
