#!/usr/bin/env bun

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
    outfile: string;
    format: "esm";
    target: "bun";
    sourcemap: "external";
    packages: "external";
    splitting: false;
  }): Promise<BuildResult>;
}

declare const Bun: BunBuildApi;

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

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
    entrypoints: ["src/index.ts", "src/experimental/index.ts"],
  },
  {
    packageDir: "packages/server",
    entrypoints: ["src/index.ts", "src/experimental/index.ts"],
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

    mkdirSync(dirname(outFilePath), { recursive: true });

    const result = await Bun.build({
      entrypoints: [entrypoint],
      outfile: outFilePath,
      format: "esm",
      target: "bun",
      sourcemap: "external",
      packages: "external",
      splitting: false,
    });

    if (!result.success) {
      for (const log of result.logs) {
        console.error(log.message ?? log);
      }
      throw new Error(`Build failed for ${packageDir} (${entrypointRelativePath})`);
    }
  }

  console.log(`Built ${packageDir}`);
}

for (const publicPackage of publicPackages) {
  await buildPackage(publicPackage.packageDir, publicPackage.entrypoints);
}
