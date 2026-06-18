#!/usr/bin/env bun
/**
 * Publish the public packages to the GitHub Packages npm registry (npm.pkg.github.com).
 *
 * This is the INTERNAL mirror: GitHub Packages requires authentication even to *install*, so it is
 * meant for authenticated consumers in the same org (e.g. the emergent app), not the general
 * public. npmjs.com stays the public-facing registry — that is published by `scripts/release.ts`.
 *
 * Mode is chosen from the git ref the workflow runs on:
 *   - tag push (bare semver, e.g. `0.1.0`)  -> "release parity": publish that exact version at the
 *     `latest` dist-tag.
 *   - branch push / manual dispatch          -> "dev channel": publish `<version>-dev.<shortSha>` at
 *     the `dev` dist-tag, so consumers can track the bleeding edge via `@dev` without a release.
 *
 * The scoped `.npmrc` (registry + auth token) is written by the workflow, not here.
 *
 * Env (provided by GitHub Actions): GITHUB_REPOSITORY, GITHUB_REF_TYPE, GITHUB_REF_NAME, GITHUB_SHA.
 * Set DRY_RUN=1 to print the plan without mutating package.json or publishing.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const DRY_RUN = process.env.DRY_RUN === "1";
const REGISTRY = "https://npm.pkg.github.com";

const repository = process.env.GITHUB_REPOSITORY ?? "";
const refType = process.env.GITHUB_REF_TYPE ?? "branch";
const refName = process.env.GITHUB_REF_NAME ?? "";
const shortSha = (process.env.GITHUB_SHA ?? "").slice(0, 7);

const SEMVER_TAG_RE = /^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9._+-]+)?$/;

interface Manifest {
  name?: string;
  version?: string;
  private?: boolean;
  repository?: unknown;
  [key: string]: unknown;
}

function readManifest(path: string): Manifest {
  return JSON.parse(readFileSync(path, "utf8")) as Manifest;
}

function findPublishablePackages(): { dir: string; pkgPath: string; pkg: Manifest }[] {
  const results: { dir: string; pkgPath: string; pkg: Manifest }[] = [];
  for (const workspace of ["packages", "apps"]) {
    let entries: string[];
    try {
      entries = readdirSync(join(ROOT, workspace));
    } catch {
      continue;
    }
    for (const entry of entries) {
      const pkgPath = join(ROOT, workspace, entry, "package.json");
      let pkg: Manifest;
      try {
        pkg = readManifest(pkgPath);
      } catch {
        continue;
      }
      if (!pkg.private && typeof pkg.name === "string" && typeof pkg.version === "string") {
        results.push({ dir: join(ROOT, workspace, entry), pkgPath, pkg });
      }
    }
  }
  return results;
}

const isReleaseTag = refType === "tag" && SEMVER_TAG_RE.test(refName);
const distTag = isReleaseTag ? "latest" : "dev";

function targetVersion(baseVersion: string): string {
  if (isReleaseTag) return refName;
  const suffix = shortSha || Date.now().toString(36);
  return `${baseVersion}-dev.${suffix}`;
}

// Pin sibling (same-scope) runtime deps to the exact version being published, so a `@dev` (or
// `@latest`) install resolves its siblings from the same channel. Handles both `workspace:*`
// (conform-ed) and fixed-range (e.g. `^0.1.31`) declarations uniformly. Peer/dev deps are left
// alone — peer ranges must stay ranges.
function pinSiblingDeps(pkg: Manifest, scopePrefix: string, version: string): void {
  for (const key of ["dependencies", "optionalDependencies"] as const) {
    const deps = pkg[key];
    if (deps === undefined || typeof deps !== "object") continue;
    const record = deps as Record<string, string>;
    for (const name of Object.keys(record)) {
      if (name.startsWith(scopePrefix)) record[name] = version;
    }
  }
}

const publishable = findPublishablePackages();
if (publishable.length === 0) {
  console.error("No publishable packages found.");
  process.exit(1);
}

function scopePrefixOf(name: string | undefined): string {
  if (typeof name !== "string" || !name.startsWith("@")) return "";
  const scope = name.split("/")[0] ?? "";
  return scope ? `${scope}/` : "";
}

const repoUrl = `git+https://github.com/${repository}.git`;
const scopePrefix = scopePrefixOf(publishable[0]?.pkg.name);

console.log(`GitHub Packages publish — mode: ${isReleaseTag ? "release parity" : "dev channel"}`);
console.log(`  registry: ${REGISTRY}`);
console.log(`  dist-tag: ${distTag}${DRY_RUN ? "  (DRY RUN)" : ""}\n`);

const failures: string[] = [];

for (const { dir, pkgPath, pkg } of publishable) {
  const version = targetVersion(pkg.version as string);
  const label = `${String(pkg.name)}@${version}`;

  pkg.version = version;
  // GitHub Packages links a package to its source repo via the `repository` field.
  pkg.repository = { type: "git", url: repoUrl };
  if (scopePrefix) pinSiblingDeps(pkg, scopePrefix, version);

  if (DRY_RUN) {
    console.log(`[dry-run] would publish ${label} (tag ${distTag}) from ${dir}`);
    continue;
  }

  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf8");

  const proc = Bun.spawnSync(["bun", "publish", "--tag", distTag], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode === 0) {
    console.log(`  published ${label}`);
  } else {
    const err = new TextDecoder().decode(proc.stderr) + new TextDecoder().decode(proc.stdout);
    console.error(`  FAILED ${label}\n${err}`);
    failures.push(label);
  }
}

if (failures.length > 0) {
  console.error(`\n${failures.length} package(s) failed to publish to GitHub Packages.`);
  process.exit(1);
}

console.log(`\nDone. Published ${publishable.length} package(s) to GitHub Packages at @${distTag}.`);
