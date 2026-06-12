#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
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
  "packages/react",
] as const;

interface PackageManifest {
  main?: unknown;
  types?: unknown;
  exports?: unknown;
}

function normalizeManifestPath(value: string): string {
  return value.replace(/^\.\//, "").replaceAll("\\", "/");
}

function collectExportEntryPaths(value: unknown): string[] {
  if (typeof value === "string") {
    return [normalizeManifestPath(value)];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => collectExportEntryPaths(item));
  }

  if (value && typeof value === "object") {
    const objectValue = value as Record<string, unknown>;
    return Object.values(objectValue).flatMap((childValue) => collectExportEntryPaths(childValue));
  }

  return [];
}

function readPackageEntryPaths(packagePath: string): string[] {
  const manifestPath = resolve(packagePath, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as PackageManifest;
  const entryPaths = new Set<string>();

  if (typeof manifest.main === "string") {
    entryPaths.add(normalizeManifestPath(manifest.main));
  }

  if (typeof manifest.types === "string") {
    entryPaths.add(normalizeManifestPath(manifest.types));
  }

  for (const exportPath of collectExportEntryPaths(manifest.exports)) {
    entryPaths.add(exportPath);
  }

  return [...entryPaths].filter(
    (entryPath) => entryPath.endsWith(".js") || entryPath.endsWith(".mjs") || entryPath.endsWith(".d.ts"),
  );
}

function verifyEntryFilesExist(packageDir: string, packagePath: string): string[] {
  const entryPaths = readPackageEntryPaths(packagePath);

  if (entryPaths.length === 0) {
    throw new Error(`No package entrypoints were discovered for ${packageDir}`);
  }

  for (const entryPath of entryPaths) {
    const absoluteEntryPath = resolve(packagePath, entryPath);
    if (!existsSync(absoluteEntryPath)) {
      throw new Error(`Missing package entrypoint for ${packageDir}: ${entryPath}`);
    }
  }

  return entryPaths;
}

function listTarEntries(tarballPath: string): Set<string> {
  const result = spawnSync("tar", ["-tzf", tarballPath], {
    cwd: repoRoot,
    encoding: "utf8",
  });

  if (result.status !== 0) {
    throw new Error(`Failed to read tarball entries: ${tarballPath}`);
  }

  return new Set(
    result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  );
}

function verifyTarballEntries(packageDir: string, tarballPath: string, entryPaths: string[]): void {
  const tarEntries = listTarEntries(tarballPath);

  for (const entryPath of entryPaths) {
    const tarEntryPath = `package/${entryPath}`;
    if (!tarEntries.has(tarEntryPath)) {
      throw new Error(`Tarball for ${packageDir} is missing package entrypoint: ${tarEntryPath}`);
    }
  }
}

for (const packageDir of publicPackageDirs) {
  const packagePath = resolve(repoRoot, packageDir);
  const entryPaths = verifyEntryFilesExist(packageDir, packagePath);
  console.log(`Packing ${packageDir} for release verification`);
  const filesBefore = new Set(readdirSync(packagePath));

  const result = spawnSync("bun", ["pm", "pack", "--quiet"], {
    cwd: packagePath,
    stdio: "inherit",
  });

  if (result.status !== 0) {
    throw new Error(`Pack verification failed for ${packageDir}`);
  }

  const newTarballs = readdirSync(packagePath).filter(
    (fileName) => fileName.endsWith(".tgz") && !filesBefore.has(fileName),
  );

  if (newTarballs.length !== 1) {
    throw new Error(`Expected exactly one tarball for ${packageDir}, found ${newTarballs.length}`);
  }

  const tarballPath = resolve(packagePath, newTarballs[0]!);
  verifyTarballEntries(packageDir, tarballPath, entryPaths);

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
