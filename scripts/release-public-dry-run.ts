#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { readdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

const publicPackageDirs = [
  "packages/contracts",
  "packages/pglite-sync",
  "packages/sync-engine",
  "packages/client",
  "packages/server",
] as const;

for (const packageDir of publicPackageDirs) {
  const packagePath = resolve(repoRoot, packageDir);
  console.log(`Packing ${packageDir} for release verification`);
  const filesBefore = new Set(readdirSync(packagePath));

  const result = spawnSync("bun", ["pm", "pack"], {
    cwd: packagePath,
    stdio: "inherit",
  });

  if (result.status !== 0) {
    throw new Error(`Pack verification failed for ${packageDir}`);
  }

  for (const fileName of readdirSync(packagePath)) {
    if (filesBefore.has(fileName)) {
      continue;
    }

    if (fileName.endsWith(".tgz")) {
      rmSync(resolve(packagePath, fileName), { force: true });
    }
  }
}

console.log("Release pack verification succeeded for all public packages.");
