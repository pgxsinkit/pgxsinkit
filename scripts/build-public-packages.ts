#!/usr/bin/env bun

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { artefactPackage, assertArtefactsVerified } from "./pgwasm-artefacts";

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
    root?: string;
    format: "esm";
    target: "bun";
    sourcemap: "external";
    external: string[];
    splitting: boolean;
    write: true;
  }): Promise<BuildResult>;
}

declare const Bun: BunBuildApi;

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const tscBinPath = resolve(repoRoot, "node_modules/.bin/tsc");
const viteBinPath = resolve(repoRoot, "node_modules/.bin/vite");

/** Where a browser bundle comes from and goes, relative to the package; `true` is the first entry into dist/. */
export interface BrowserBundle {
  readonly entrypoint: string;
  readonly outFile: string;
}

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
  /**
   * Also emit `dist/browser-bundle.js`: ONE self-contained ESM file with no imports at all, for a
   * host that has no bundler and cannot resolve a bare specifier — a plain `<script type="module">`
   * or worker in a browser, and a `file://` import in Node. The published `dist/index.js` cannot serve
   * that purpose by design: it leaves every declared dependency external (the ADR-0038 artifact
   * contract), so it carries bare `@pgxsinkit/*` imports.
   *
   * This is a REDISTRIBUTION artifact, not the publish surface: it vendors whatever the entry pulls
   * in, is not referenced from `exports`, and is gitignored with the rest of `dist`. The artifact
   * contract tests deliberately do not look at it — they pin `dist/index.js`, which is what consumers
   * install.
   */
  browserBundle?: boolean | BrowserBundle;
  /**
   * Bundle every entry point in one build with code splitting, so modules the entries share are emitted
   * once, as chunks. Needed where entry points share runtime identity: pgwasm's error classes, protocol
   * messages and the registry its `/protocol` and `/live` entries read must be ONE module across them.
   */
  splitting?: boolean;
  /**
   * Relative specifiers kept as imports (Bun.build `external` patterns): a build package's artefacts,
   * which ship next to the bundle and are referenced relative to it.
   */
  relativeExternals?: readonly string[];
  /** Checked before bundling; throws when the package's pinned artefacts are missing or wrong. */
  verify?: () => Promise<void>;
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
    packageDir: "packages/pgwasm",
    entrypoints: [
      "src/index.ts",
      "src/build/index.ts",
      "src/drizzle/index.ts",
      "src/fs/index.ts",
      "src/live/index.ts",
      "src/opfs/index.ts",
      "src/protocol/index.ts",
    ],
    bundler: "bun",
    splitting: true,
    // The wasm hosts that drive the OPFS store's sync broker + WASI adapter (a wasm engine worker, a
    // coordinator worker) are plain JS with no build step: they need one file they can import by URL.
    browserBundle: { entrypoint: "src/opfs/index.ts", outFile: "dist/opfs/browser-bundle.js" },
  },
  {
    // The C Postgres build: its artefacts live in `artefacts/`, one level above both `src/` and `dist/`,
    // and every module that references them is emitted at its own depth (src/artefacts.ts into
    // dist/index.js, src/prepopulated.ts into dist/prepopulated.js, src/contrib/*.ts into dist/contrib/),
    // so the references stay valid unrewritten.
    packageDir: "packages/pgwasm-c",
    entrypoints: ["src/index.ts", "src/prepopulated.ts", "src/contrib/amcheck.ts"],
    bundler: "bun",
    relativeExternals: ["../artefacts/*", "../../artefacts/*"],
    verify: () => assertArtefactsVerified([artefactPackage("packages/pgwasm-c")]),
  },
  {
    // pg_dump: its artefacts sit in `artefacts/` like pgwasm-c's, referenced only from src/artefacts.ts,
    // which is bundled into dist/index.js at its own depth.
    packageDir: "packages/pgwasm-pg-dump",
    entrypoints: ["src/index.ts"],
    bundler: "bun",
    relativeExternals: ["../artefacts/*"],
    verify: () => assertArtefactsVerified([artefactPackage("packages/pgwasm-pg-dump")]),
  },
  {
    // A React component: built through Vite library mode for the production JSX runtime, like
    // packages/react (see `bundler`).
    packageDir: "packages/pgwasm-repl",
    entrypoints: ["src/index.ts"],
    bundler: "vite",
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
  const external = [
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
    ...(publicPackage.relativeExternals ?? []),
  ];

  await publicPackage.verify?.();

  if (publicPackage.splitting === true) {
    const result = await Bun.build({
      entrypoints: entrypoints.map((entrypoint) => resolve(repoRoot, packageDir, entrypoint)),
      outdir,
      root: resolve(repoRoot, packageDir, "src"),
      format: "esm",
      target: "bun",
      sourcemap: "external",
      external,
      splitting: true,
      write: true,
    });
    if (!result.success) {
      for (const log of result.logs) {
        console.error(log.message ?? log);
      }
      throw new Error(`Build failed for ${packageDir}`);
    }
    for (const entrypointRelativePath of entrypoints) {
      const outFilePath = expectedOutFile(outdir, entrypointRelativePath);
      if (!existsSync(outFilePath)) {
        throw new Error(`Build did not emit expected output file: ${outFilePath}`);
      }
    }
    console.log(`Built ${packageDir} (split)`);
    return;
  }

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

  if (publicPackage.browserBundle !== undefined && publicPackage.browserBundle !== false) {
    emitBrowserBundle(publicPackage);
  }

  console.log(`Built ${packageDir}`);
}

/**
 * The self-contained ESM redistribution bundle. Spawned rather than built in-process for the same
 * reason the artifact test spawns this script: an in-process `Bun.build` corrupts module resolution
 * for anything imported afterwards in the same process.
 */
export function emitBrowserBundle(publicPackage: PublicPackage): void {
  const bundle =
    typeof publicPackage.browserBundle === "object"
      ? publicPackage.browserBundle
      : { entrypoint: publicPackage.entrypoints[0]!, outFile: "dist/browser-bundle.js" };
  const outFile = resolve(repoRoot, publicPackage.packageDir, bundle.outFile);
  const entrypoint = resolve(repoRoot, publicPackage.packageDir, bundle.entrypoint);
  execFileSync("bun", ["build", entrypoint, "--target", "browser", "--format", "esm", "--outfile", outFile], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if (!existsSync(outFile)) {
    throw new Error(`Browser bundle did not emit expected output file: ${outFile}`);
  }
  console.log(`Built ${publicPackage.packageDir} browser bundle`);
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
