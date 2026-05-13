#!/usr/bin/env bun

import { readFileSync, writeFileSync } from "node:fs";
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

type DependencySection = "dependencies" | "devDependencies" | "peerDependencies" | "optionalDependencies";

interface PackageManifest {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

interface PublicPackageManifest {
  packageDir: string;
  manifestPath: string;
  manifest: PackageManifest;
}

interface UpdateOptions {
  version: string;
}

const dependencySections: DependencySection[] = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];

const semverPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function printUsage(): void {
  console.log("Usage: bun scripts/update-public-package-versions.ts --version <semver>");
  console.log("Example: bun scripts/update-public-package-versions.ts --version 0.2.0");
}

function normalizeAndValidateVersion(input: string): string {
  const normalized = input.startsWith("v") ? input.slice(1) : input;

  if (!semverPattern.test(normalized)) {
    throw new Error(
      `Version '${input}' is not valid npm semver. Use <major>.<minor>.<patch> (optionally with prerelease/build metadata).`,
    );
  }

  return normalized;
}

function parseArgs(argv: string[]): UpdateOptions {
  let version: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";

    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }

    if (arg === "--version") {
      const nextArg = argv[index + 1];
      if (!nextArg) {
        throw new Error("Missing value for --version");
      }

      version = nextArg;
      index += 1;
      continue;
    }

    if (arg.startsWith("--version=")) {
      version = arg.slice("--version=".length);
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!version) {
    throw new Error("Missing required argument --version");
  }

  return { version: normalizeAndValidateVersion(version.trim()) };
}

function readPublicPackageManifests(): PublicPackageManifest[] {
  return publicPackageDirs.map((packageDir) => {
    const manifestPath = resolve(repoRoot, packageDir, "package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as PackageManifest;

    if (!manifest.name || !manifest.version) {
      throw new Error(`Invalid package manifest at ${manifestPath}`);
    }

    return {
      packageDir,
      manifestPath,
      manifest,
    };
  });
}

function updateDependencyVersion(spec: string, version: string): string {
  if (spec.startsWith("^")) {
    return `^${version}`;
  }

  if (spec.startsWith("~")) {
    return `~${version}`;
  }

  return version;
}

function updateManifestVersions(version: string): void {
  const packageManifests = readPublicPackageManifests();
  const publicPackageNames = new Set(packageManifests.map((entry) => entry.manifest.name));
  let updatedPackageCount = 0;

  for (const entry of packageManifests) {
    const { manifest, manifestPath } = entry;
    let changed = false;

    if (manifest.version !== version) {
      manifest.version = version;
      changed = true;
    }

    for (const sectionName of dependencySections) {
      const section = manifest[sectionName];
      if (!section) {
        continue;
      }

      for (const dependencyName of Object.keys(section)) {
        if (!publicPackageNames.has(dependencyName)) {
          continue;
        }

        const nextDependencyVersion = updateDependencyVersion(section[dependencyName] ?? "", version);
        if (section[dependencyName] !== nextDependencyVersion) {
          section[dependencyName] = nextDependencyVersion;
          changed = true;
        }
      }
    }

    if (!changed) {
      continue;
    }

    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    updatedPackageCount += 1;
    console.log(`Updated ${entry.packageDir}/package.json to version ${version}`);
  }

  if (updatedPackageCount === 0) {
    console.log(`Public package manifests already match version ${version}`);
    return;
  }

  console.log(`Updated ${updatedPackageCount} public package manifest(s) to version ${version}`);
}

const options = parseArgs(process.argv.slice(2));
updateManifestVersions(options.version);
