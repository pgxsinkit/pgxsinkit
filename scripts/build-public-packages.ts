#!/usr/bin/env bun

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
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
    packages: "external";
    splitting: false;
    write: true;
  }): Promise<BuildResult>;
}

declare const Bun: BunBuildApi;

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const tsgoBinPath = resolve(repoRoot, "node_modules/.bin/tsgo");

// Declaration emit resolves workspace dependencies to their already-built
// dist/index.d.ts (see each package's tsconfig.dts.json), so this list must
// stay in dependency order.
const publicPackages = [
  {
    packageDir: "packages/contracts",
    entrypoints: ["src/index.ts"],
  },
  {
    packageDir: "packages/pglite-sync",
    entrypoints: ["src/index.ts"],
  },
  {
    packageDir: "packages/sync-engine",
    entrypoints: ["src/index.ts"],
  },
  {
    packageDir: "packages/client",
    entrypoints: ["src/index.ts"],
  },
  {
    packageDir: "packages/server",
    entrypoints: ["src/index.ts"],
  },
  {
    packageDir: "packages/react",
    entrypoints: ["src/index.ts"],
  },
] as const;

async function buildPackage(packageDir: string, entrypoints: readonly string[]): Promise<void> {
  const outdir = resolve(repoRoot, packageDir, "dist");

  rmSync(outdir, { recursive: true, force: true });

  for (const entrypointRelativePath of entrypoints) {
    const entrypoint = resolve(repoRoot, packageDir, entrypointRelativePath);

    if (!existsSync(entrypoint)) {
      continue;
    }

    const outFileRelativePath = entrypointRelativePath.replace(/^src\//, "").replace(/\.ts$/, ".js");
    const outFilePath = resolve(outdir, outFileRelativePath);
    const outFileDir = dirname(outFilePath);

    mkdirSync(outFileDir, { recursive: true });

    const result = await Bun.build({
      entrypoints: [entrypoint],
      outdir: outFileDir,
      format: "esm",
      target: "bun",
      sourcemap: "external",
      packages: "external",
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

function emitPackageDeclarations(packageDir: string): void {
  execFileSync(tsgoBinPath, ["-p", resolve(repoRoot, packageDir, "tsconfig.dts.json")], {
    cwd: repoRoot,
    stdio: "inherit",
  });

  const declarationEntryPath = resolve(repoRoot, packageDir, "dist/index.d.ts");
  if (!existsSync(declarationEntryPath)) {
    throw new Error(`Declaration emit did not produce expected output file: ${declarationEntryPath}`);
  }

  console.log(`Emitted declarations for ${packageDir}`);
}

for (const publicPackage of publicPackages) {
  await buildPackage(publicPackage.packageDir, publicPackage.entrypoints);
  emitPackageDeclarations(publicPackage.packageDir);
}
