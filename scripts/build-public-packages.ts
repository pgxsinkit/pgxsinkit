#!/usr/bin/env bun

import { rmSync } from "node:fs";
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
  }): Promise<BuildResult>;
}

declare const Bun: BunBuildApi;

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

const publicPackageDirs = [
  "packages/contracts",
  "packages/pglite-sync",
  "packages/sync-engine",
  "packages/client",
  "packages/server",
] as const;

async function buildPackage(packageDir: string): Promise<void> {
  const entrypoint = resolve(repoRoot, packageDir, "src/index.ts");
  const outdir = resolve(repoRoot, packageDir, "dist");

  rmSync(outdir, { recursive: true, force: true });

  const result = await Bun.build({
    entrypoints: [entrypoint],
    outdir,
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
    throw new Error(`Build failed for ${packageDir}`);
  }

  console.log(`Built ${packageDir}`);
}

for (const packageDir of publicPackageDirs) {
  await buildPackage(packageDir);
}
