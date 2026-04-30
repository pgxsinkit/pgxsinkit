#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
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
] as const;

interface PublishOptions {
  tag: string;
  otp?: string;
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

function publishPackage(packageDir: string, options: PublishOptions): void {
  const packagePath = resolve(repoRoot, packageDir);
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
