#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

const publishOrder = [
  "packages/contracts",
  "packages/pglite-sync",
  "packages/sync-engine",
  "packages/client",
  "packages/server",
  "packages/react",
] as const;

interface PublishOptions {
  tag: string;
  otp?: string;
}

interface PackageManifest {
  main?: unknown;
  types?: unknown;
  exports?: unknown;
}

function printUsage(): void {
  console.log("Usage: bun scripts/publish-public-packages.ts [--tag <next|latest|custom>] [--otp <code>]");
}

function parseArgs(argv: string[]): PublishOptions {
  let tag = "next";
  let otp: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";

    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }

    if (arg === "--tag") {
      const nextArg = argv[index + 1];
      if (!nextArg) {
        throw new Error("Missing value for --tag");
      }

      tag = nextArg;
      index += 1;
      continue;
    }

    if (arg.startsWith("--tag=")) {
      tag = arg.slice("--tag=".length);
      continue;
    }

    if (arg === "--otp") {
      const nextArg = argv[index + 1];
      if (!nextArg) {
        throw new Error("Missing value for --otp");
      }

      otp = nextArg;
      index += 1;
      continue;
    }

    if (arg.startsWith("--otp=")) {
      otp = arg.slice("--otp=".length);
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!tag.trim()) {
    throw new Error("Publish tag cannot be blank");
  }

  const trimmedOtp = otp?.trim();
  if (trimmedOtp) {
    return { tag, otp: trimmedOtp };
  }

  return { tag };
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

function runPackPreflight(packageDir: string, packagePath: string, entryPaths: string[]): void {
  const filesBefore = new Set(readdirSync(packagePath));

  const result = spawnSync("bun", ["pm", "pack", "--quiet"], {
    cwd: packagePath,
    stdio: "inherit",
  });

  if (result.status !== 0) {
    throw new Error(`Pack preflight failed for ${packageDir}`);
  }

  const newTarballs = readdirSync(packagePath).filter(
    (fileName) => fileName.endsWith(".tgz") && !filesBefore.has(fileName),
  );

  if (newTarballs.length !== 1) {
    throw new Error(`Expected exactly one tarball for ${packageDir}, found ${newTarballs.length}`);
  }

  const tarballPath = resolve(packagePath, newTarballs[0]!);

  try {
    verifyTarballEntries(packageDir, tarballPath, entryPaths);
  } finally {
    rmSync(tarballPath, { force: true });
  }
}

function publishPackage(packageDir: string, options: PublishOptions): void {
  const packagePath = resolve(repoRoot, packageDir);
  const entryPaths = verifyEntryFilesExist(packageDir, packagePath);
  runPackPreflight(packageDir, packagePath, entryPaths);

  console.log(`Publishing ${packageDir} with dist-tag '${options.tag}'`);

  const publishArgs = ["publish", "--access", "public", "--tag", options.tag, "--tolerate-republish"];

  if (options.otp) {
    publishArgs.push("--otp", options.otp);
  }

  const result = spawnSync("bun", publishArgs, {
    cwd: packagePath,
    stdio: "inherit",
  });

  if (result.status !== 0) {
    throw new Error(`Publish failed for ${packageDir}`);
  }
}

const options = parseArgs(process.argv.slice(2));
for (const packageDir of publishOrder) {
  publishPackage(packageDir, options);
}

console.log(`Published public packages using dist-tag '${options.tag}'.`);
