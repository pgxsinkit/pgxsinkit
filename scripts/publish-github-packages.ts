#!/usr/bin/env bun
/**
 * Publish the public packages to the GitHub Packages npm registry (npm.pkg.github.com).
 *
 * This is the INTERNAL mirror: GitHub Packages requires authentication even to *install*, so it is
 * meant for authenticated consumers in the same org (e.g. the emergent app), not the general
 * public. npmjs.com stays the public-facing registry — that is published by `scripts/release.ts`.
 *
 * Mode is chosen from the git ref the workflow runs on:
 *   - tag push (bare semver, e.g. `0.2.1`)  -> "release parity": publish that exact version at the
 *     `latest` dist-tag.
 *   - branch push / manual dispatch          -> "dev channel": publish `<version>-dev.<shortSha>` at
 *     the `dev` dist-tag, so consumers can track the bleeding edge via `@dev` without a release.
 *
 * Each package's Agent Skills travel inside its tarball, so every SKILL.md under `skills/` gets its
 * `library_version` placeholder ("0.0.0", like package.json's `version`) stamped with the version being
 * published, alongside the package.json rewrite. Before anything is published, every staged skill pin is
 * asserted to equal its package's publish version; a mismatch fails the run, naming the file.
 *
 * The scoped `.npmrc` (registry + auth token) is written by the workflow, not here.
 *
 * Env (provided by GitHub Actions): GITHUB_REPOSITORY, GITHUB_REF_TYPE, GITHUB_REF_NAME, GITHUB_SHA.
 * Set DRY_RUN=1 to print the plan without mutating package.json / SKILL.md or publishing (the skill-pin
 * assertion still runs, over the stamped content in memory).
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

import { findSkillFiles, readLibraryVersion, stampLibraryVersion } from "./lib/skill-pins";

const ROOT = join(import.meta.dir, "..");
const REGISTRY = "https://npm.pkg.github.com";

const SEMVER_TAG_RE = /^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9._+-]+)?$/;

export interface Manifest {
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

// --- Dev-channel version ordering --------------------------------------------------------------
// A pre-release of the current package.json version (e.g. `0.2.0-dev.x`) sorts *below* the latest
// published release (`0.2.0`) under SemVer, so `@dev` would look older than `@latest`. To keep the
// dev channel strictly ahead, anchor its base to the greater of (package.json version, latest
// release tag + 1 patch). Reading tags requires the workflow to check out with `fetch-depth: 0`.
const RELEASE_TAG_RE = /^[0-9]+\.[0-9]+\.[0-9]+$/;

export function parseSemverCore(v: string): [number, number, number] {
  const parts = v.split(".");
  return [
    Number.parseInt(parts[0] ?? "0", 10) || 0,
    Number.parseInt(parts[1] ?? "0", 10) || 0,
    Number.parseInt(parts[2] ?? "0", 10) || 0,
  ];
}

export function compareSemverCore(a: string, b: string): number {
  const [aMaj, aMin, aPat] = parseSemverCore(a);
  const [bMaj, bMin, bPat] = parseSemverCore(b);
  if (aMaj !== bMaj) return aMaj - bMaj;
  if (aMin !== bMin) return aMin - bMin;
  return aPat - bPat;
}

export function nextPatch(v: string): string {
  const [maj, min, pat] = parseSemverCore(v);
  return `${maj}.${min}.${pat + 1}`;
}

export function maxCore(a: string, b: string): string {
  return compareSemverCore(a, b) >= 0 ? a : b;
}

// Highest bare-semver release tag in the repo, or null if none are reachable (e.g. shallow checkout).
function latestReleaseTag(): string | null {
  let out: string;
  try {
    out = execFileSync("git", ["tag", "--list"], { cwd: ROOT, encoding: "utf8" });
  } catch {
    return null;
  }
  const tags = out
    .split("\n")
    .map((t) => t.trim())
    .filter((t) => RELEASE_TAG_RE.test(t));
  if (tags.length === 0) return null;
  return tags.reduce((hi, t) => (compareSemverCore(t, hi) > 0 ? t : hi));
}

export interface VersionContext {
  /** Release-parity mode (a bare semver tag push); otherwise the dev channel. */
  isReleaseTag: boolean;
  /** The exact version to publish when in release-parity mode (the tag name). */
  refName: string;
  /** Lower bound for dev versions — nextPatch(latest release tag), or null if no tags are reachable. */
  devBaseFloor: string | null;
  /** Pre-release identifier shared by every sibling in one dev run (chronological + traceable). */
  devPreId: string;
}

// Derive the run context from the GitHub Actions environment + git tags. Does git I/O, so it is only
// called from the executable entrypoint, never at import time.
function resolveVersionContext(): VersionContext {
  const refType = process.env["GITHUB_REF_TYPE"] ?? "branch";
  const refName = process.env["GITHUB_REF_NAME"] ?? "";
  const shortSha = (process.env["GITHUB_SHA"] ?? "").slice(0, 7);
  const isReleaseTag = refType === "tag" && SEMVER_TAG_RE.test(refName);
  // Computed once so every package in this run shares the same dev version (siblings must match for
  // cross-deps to resolve). The pre-release id leads with a unix-seconds stamp (a numeric SemVer
  // identifier => chronological ordering between dev builds) and keeps the short sha for traceability.
  const latestRelease = isReleaseTag ? null : latestReleaseTag();
  const devBaseFloor = latestRelease ? nextPatch(latestRelease) : null;
  const devStamp = Math.floor(Date.now() / 1000);
  const devPreId = shortSha ? `${devStamp}.${shortSha}` : String(devStamp);
  return { isReleaseTag, refName, devBaseFloor, devPreId };
}

// The published version for a package, given its package.json base version and the run context.
// Release-parity uses the tag verbatim; the dev channel anchors above the latest release (so `@dev`
// always sorts above `@latest`) and stamps the shared pre-release id.
export function targetVersion(baseVersion: string, ctx: VersionContext): string {
  if (ctx.isReleaseTag) return ctx.refName;
  const base = ctx.devBaseFloor ? maxCore(baseVersion, ctx.devBaseFloor) : baseVersion;
  return `${base}-dev.${ctx.devPreId}`;
}

// Pin every same-scope (sibling) dep to the exact version being published, so a `@dev` (or
// `@latest`) install resolves its siblings from the same channel. This MUST include
// `peerDependencies`: siblings are released in lockstep at one identical version, and a left-alone
// peer range (e.g. `>=0.2.0`) does NOT match a pre-release dev version under SemVer's prerelease
// rule — so a dev consumer would silently back-fill the latest *release* of that sibling, mixing a
// dev package with a release peer. Foreign-scope peers (react, zod, …) are a different scope and
// stay ranges; only same-scope siblings are pinned. Handles `workspace:*` and fixed ranges uniformly.
export function pinSiblingDeps(pkg: Manifest, scopePrefix: string, version: string): void {
  for (const key of ["dependencies", "optionalDependencies", "peerDependencies"] as const) {
    const deps = pkg[key];
    if (deps === undefined || typeof deps !== "object") continue;
    const record = deps as Record<string, string>;
    for (const name of Object.keys(record)) {
      if (name.startsWith(scopePrefix)) record[name] = version;
    }
  }
}

// --- Agent Skill version pins --------------------------------------------------------------------
// A skill's `library_version` is tag-derived exactly like package.json's `version`: the repo carries the
// "0.0.0" placeholder, and the publish stamps the version it publishes into the copy it packs (this is
// the CI checkout, rewritten in place like package.json — the working tree of a local DRY_RUN is never
// touched). The assertion is the safety property: a published package's skills carry exactly its version.

export interface StagedSkill {
  file: string;
  content: string;
}

/** Stamp every SKILL.md under the package's `skills/` with `version`; `write: false` keeps it in memory. */
export function stampSkillPins(packageDir: string, version: string, write: boolean): StagedSkill[] {
  return findSkillFiles(packageDir).map((file) => {
    const content = stampLibraryVersion(readFileSync(file, "utf8"), version);
    if (write) writeFileSync(file, content, "utf8");
    return { file, content };
  });
}

/** The package's SKILL.md files as they are on disk now — what `bun publish` will pack. */
export function readStagedSkills(packageDir: string): StagedSkill[] {
  return findSkillFiles(packageDir).map((file) => ({ file, content: readFileSync(file, "utf8") }));
}

/**
 * One message per staged skill whose `library_version` is not exactly `version` (missing pins included),
 * naming the file — relative to `displayRoot` when given.
 */
export function skillPinViolations(skills: StagedSkill[], version: string, displayRoot?: string): string[] {
  const violations: string[] = [];
  for (const { file, content } of skills) {
    const pinned = readLibraryVersion(content);
    if (pinned !== version) {
      const where = displayRoot === undefined ? file : relative(displayRoot, file);
      violations.push(`${where}: library_version "${pinned ?? "<missing>"}" is not the publish version "${version}"`);
    }
  }
  return violations;
}

function scopePrefixOf(name: string | undefined): string {
  if (typeof name !== "string" || !name.startsWith("@")) return "";
  const scope = name.split("/")[0] ?? "";
  return scope ? `${scope}/` : "";
}

function main(): void {
  const DRY_RUN = process.env["DRY_RUN"] === "1";
  const repository = process.env["GITHUB_REPOSITORY"] ?? "";
  const ctx = resolveVersionContext();
  const distTag = ctx.isReleaseTag ? "latest" : "dev";

  const publishable = findPublishablePackages();
  if (publishable.length === 0) {
    console.error("No publishable packages found.");
    process.exit(1);
  }

  const repoUrl = `git+https://github.com/${repository}.git`;
  const scopePrefix = scopePrefixOf(publishable[0]?.pkg.name);

  console.log(`GitHub Packages publish — mode: ${ctx.isReleaseTag ? "release parity" : "dev channel"}`);
  console.log(`  registry: ${REGISTRY}`);
  console.log(`  dist-tag: ${distTag}${DRY_RUN ? "  (DRY RUN)" : ""}\n`);

  // Stage every package first (package.json + skill pins), and assert every staged skill pin before
  // anything is published, so a bad pin can never leave a partial release behind.
  const staged: { dir: string; label: string }[] = [];
  const pinViolations: string[] = [];
  for (const { dir, pkgPath, pkg } of publishable) {
    const version = targetVersion(pkg.version as string, ctx);
    const label = `${String(pkg.name)}@${version}`;

    pkg.version = version;
    // GitHub Packages links a package to its source repo via the `repository` field.
    pkg.repository = { type: "git", url: repoUrl };
    if (scopePrefix) pinSiblingDeps(pkg, scopePrefix, version);

    const stamped = stampSkillPins(dir, version, !DRY_RUN);
    if (!DRY_RUN) writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf8");
    // Re-read from disk when publishing: the assertion must hold for what `bun publish` actually packs.
    const skills = DRY_RUN ? stamped : readStagedSkills(dir);
    pinViolations.push(...skillPinViolations(skills, version, ROOT));
    if (skills.length > 0) console.log(`  ${label}: ${skills.length} skill pin(s) stamped "${version}"`);
    staged.push({ dir, label });
  }

  if (pinViolations.length > 0) {
    console.error("\nRefusing to publish — staged Agent Skill pins disagree with the publish version:");
    for (const v of pinViolations) console.error(`  ${v}`);
    process.exit(1);
  }

  const failures: string[] = [];

  for (const { dir, label } of staged) {
    if (DRY_RUN) {
      console.log(`[dry-run] would publish ${label} (tag ${distTag}) from ${dir}`);
      continue;
    }

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
}

if (import.meta.main) main();
