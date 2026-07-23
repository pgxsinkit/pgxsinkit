#!/usr/bin/env bun

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface BuildLog {
  message?: string;
}

interface BuildResult {
  success: boolean;
  logs: BuildLog[];
}

interface BunBuildApi {
  build(options: {
    entrypoints: string[];
    outdir: string;
    format: "esm";
    target: "bun";
    sourcemap: "external";
    external: string[];
    splitting: false;
    write: true;
  }): Promise<BuildResult>;
}

declare const Bun: BunBuildApi;

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const tscBinPath = resolve(repoRoot, "node_modules/.bin/tsc");
const viteBinPath = resolve(repoRoot, "node_modules/.bin/vite");

export interface PublicPackage {
  packageDir: string;
  entrypoints: readonly string[];
  /**
   * How the runtime bundle is produced. `bun` (`Bun.build`, target bun) fits the server/client
   * packages, but it compiles JSX against `react/jsx-dev-runtime` — a module downstream Vite
   * PRODUCTION builds rewrite to `jsxDEV = undefined`, which made the published
   * `SyncClientProvider` throw at render. The browser-oriented React package therefore builds
   * through Vite library mode (`packages/react/vite.config.ts`, ADR-0037), which emits the
   * production `react/jsx-runtime` and leaves every bare import external.
   */
  bundler: "bun" | "vite";
}

// Declaration emit resolves workspace dependencies to their already-built
// dist/index.d.ts (see each package's tsconfig.dts.json), so this list must
// stay in dependency order.
export const publicPackages: readonly PublicPackage[] = [
  {
    packageDir: "packages/contracts",
    entrypoints: ["src/index.ts"],
    bundler: "bun",
  },
  {
    packageDir: "packages/pglite-opfs-repacked",
    entrypoints: ["src/index.ts"],
    bundler: "bun",
  },
  {
    // `src/testing.ts` is the `@pgxsinkit/client/testing` subpath (ADR-0036) — a SEPARATE standalone bundle
    // so app builds tree-shake the memory-store helpers away; the two share the `TEST_STORE_BACKEND` marker
    // via `Symbol.for` (see store-path.ts) precisely because they are bundled independently.
    packageDir: "packages/client",
    entrypoints: ["src/index.ts", "src/testing.ts"],
    bundler: "bun",
  },
  {
    packageDir: "packages/server",
    entrypoints: ["src/index.ts"],
    bundler: "bun",
  },
  {
    packageDir: "packages/react",
    entrypoints: ["src/index.ts"],
    bundler: "vite",
  },
];

function expectedOutFile(outdir: string, entrypointRelativePath: string): string {
  const outFileRelativePath = entrypointRelativePath.replace(/^src\//, "").replace(/\.ts$/, ".js");
  return resolve(outdir, outFileRelativePath);
}

export async function buildPackage(publicPackage: PublicPackage): Promise<void> {
  const { packageDir, entrypoints } = publicPackage;
  const outdir = resolve(repoRoot, packageDir, "dist");

  rmSync(outdir, { recursive: true, force: true });

  if (publicPackage.bundler === "vite") {
    // The vite bin is spawned the same way as tsc below (its own runtime, not this script's);
    // the package's vite.config.ts carries the whole library-mode contract. NODE_ENV is pinned so
    // a caller's ambient value (e.g. `test` under `bun test`) can never flip the published
    // artifact back to the development JSX transform.
    execFileSync(viteBinPath, ["build"], {
      cwd: resolve(repoRoot, packageDir),
      stdio: "inherit",
      env: { ...process.env, NODE_ENV: "production" },
    });

    for (const entrypointRelativePath of entrypoints) {
      const outFilePath = expectedOutFile(outdir, entrypointRelativePath);
      if (!existsSync(outFilePath)) {
        throw new Error(`Build did not emit expected output file: ${outFilePath}`);
      }
    }

    console.log(`Built ${packageDir} (vite)`);
    return;
  }

  // The artifact contract (ADR-0038): every static import in a published bundle is declared in
  // that package's manifest; nothing is bundled but the package's own source. `packages:
  // "external"` cannot deliver that — the root tsconfig `paths` resolve drizzle-orm and the
  // @pgxsinkit/* workspace names to FILE paths before the bare/packaged classification runs, so
  // those dependencies were silently inlined. `external` matches specifiers AS WRITTEN (before
  // resolution), so deriving it from the manifest pins the contract to the package.json itself.
  // The two options do NOT compose: setting `packages: "external"` alongside `external` makes the
  // paths-mapped names inline again (probed on Bun 1.3.14), so `external` stands alone here. The
  // backstop against a bare-but-UNDECLARED import being silently vendored is the artifact test's
  // sourcemap assertion: no bundled module may originate from node_modules
  // (tests/unit/public-package-artifacts.test.ts).
  const manifest = JSON.parse(readFileSync(resolve(repoRoot, packageDir, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  };
  const external = [...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {})];

  for (const entrypointRelativePath of entrypoints) {
    const entrypoint = resolve(repoRoot, packageDir, entrypointRelativePath);

    if (!existsSync(entrypoint)) {
      continue;
    }

    const outFilePath = expectedOutFile(outdir, entrypointRelativePath);
    const outFileDir = dirname(outFilePath);

    mkdirSync(outFileDir, { recursive: true });

    const result = await Bun.build({
      entrypoints: [entrypoint],
      outdir: outFileDir,
      format: "esm",
      target: "bun",
      sourcemap: "external",
      external,
      splitting: false,
      write: true,
    });

    if (!result.success) {
      for (const log of result.logs) {
        console.error(log.message ?? log);
      }
      throw new Error(`Build failed for ${packageDir} (${entrypointRelativePath})`);
    }

    if (!existsSync(outFilePath)) {
      throw new Error(`Build did not emit expected output file: ${outFilePath}`);
    }
  }

  console.log(`Built ${packageDir}`);
}

export function emitPackageDeclarations(packageDir: string): void {
  execFileSync(tscBinPath, ["-p", resolve(repoRoot, packageDir, "tsconfig.dts.json")], {
    cwd: repoRoot,
    stdio: "inherit",
  });

  const declarationEntryPath = resolve(repoRoot, packageDir, "dist/index.d.ts");
  if (!existsSync(declarationEntryPath)) {
    throw new Error(`Declaration emit did not produce expected output file: ${declarationEntryPath}`);
  }

  console.log(`Emitted declarations for ${packageDir}`);
}

// `--bundles-only [packageDir…]`: build just the runtime bundles (no declaration emit) for the
// given packages (default all). This is the artifact test's door: in-process `Bun.build` corrupts
// module resolution for code imported LATER in the same process (probed on Bun 1.3.14 — a
// subsequent `import "@electric-sql/experimental"` from source fails to resolve), so the test
// spawns this script instead of calling buildPackage() in its own process.
if (import.meta.main) {
  const args = process.argv.slice(2);
  const bundlesOnly = args[0] === "--bundles-only";
  const requested = bundlesOnly ? args.slice(1) : [];
  const selected =
    requested.length > 0 ? publicPackages.filter((pkg) => requested.includes(pkg.packageDir)) : publicPackages;

  if (requested.length > 0 && selected.length !== requested.length) {
    throw new Error(
      `Unknown package dir(s): ${requested.filter((dir) => !selected.some((pkg) => pkg.packageDir === dir)).join(", ")}`,
    );
  }

  for (const publicPackage of selected) {
    await buildPackage(publicPackage);
    if (!bundlesOnly) {
      emitPackageDeclarations(publicPackage.packageDir);
    }
  }
}
