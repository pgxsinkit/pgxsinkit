import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

// Validate every workspace package's Agent Skills (`skills/**/SKILL.md`) with the @tanstack/intent CLI.
//
// Invokes the CLI by its explicit resolved path on purpose: `@electric-sql/client` also ships an
// `intent` binary, so `bunx @tanstack/intent` / the `.bin/intent` shim can resolve to the wrong one from
// inside a package that has Electric installed. The explicit path is unambiguous. Each package is
// validated with its own directory as cwd so the CLI's packaging checks read that package's package.json.
//
// Beyond the CLI's structural checks, this script also holds each skill's `library_version` to the repo's
// GIT TAGS (the only version truth under the tag-derived standard, ADR-0001 — package.json versions are
// 0.0.0 placeholders, so the intent CLI cannot check this itself). A pin may EQUAL the latest tag (the
// released state) or sit AHEAD of it (the next release being prepared: pins are bumped BEFORE tagging via
// `bun run skills:pins:write [version]`, so the tagged commit — and the package tarballs built from it,
// skills included — carries pins that are true of itself). Only a pin BEHIND the latest tag fails: that is
// incoherent release metadata and must fail before the slower validation lanes start.

const root = process.cwd();
const cli = path.join(root, "node_modules/@tanstack/intent/dist/cli.mjs");
const packagesDir = path.join(root, "packages");
const packagesWithSkills = readdirSync(packagesDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(path.join(packagesDir, entry.name, "skills")))
  .map((entry) => entry.name)
  .sort();

if (packagesWithSkills.length === 0) {
  console.log("No packages ship a skills/ directory.");
  process.exit(0);
}

// The latest tag, straight from git. A shallow/tagless checkout (some CI fetch modes) cannot answer, so
// the check degrades to a loud warning there rather than failing a build on missing metadata — locally
// (where commits happen, and the pre-commit hook runs this) tags are always present.
function latestTag(): string | null {
  const result = spawnSync("git", ["describe", "--tags", "--abbrev=0"], { cwd: root, encoding: "utf8" });
  if (result.status !== 0) return null;
  const tag = result.stdout.trim();
  return tag.length > 0 ? tag : null;
}

/** Compare two plain `x.y.z` release versions (the only shape this repo tags). */
function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

const RELEASE_VERSION = /^\d+\.\d+\.\d+$/;

function checkVersionPins(writeVersion: string | null): boolean {
  const tag = latestTag();
  if (tag === null) {
    console.warn("\n⚠ library_version pin check skipped: no git tag visible (shallow/tagless checkout?).");
    return true;
  }
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const pkg of packagesWithSkills) {
    const skillsDir = path.join(packagesDir, pkg, "skills");
    for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const skillFile = path.join(skillsDir, entry.name, "SKILL.md");
      if (!existsSync(skillFile)) continue;
      const content = readFileSync(skillFile, "utf8");
      const match = content.match(/^(\s*library_version:\s*)"([^"]+)"/m);
      const pinned = match?.[2];
      if (writeVersion !== null && match && pinned !== writeVersion) {
        writeFileSync(skillFile, content.replace(match[0], `${match[1]}"${writeVersion}"`));
        console.log(`  pinned packages/${pkg}/skills/${entry.name}/SKILL.md: "${pinned}" → "${writeVersion}"`);
        seen.add(writeVersion);
        continue;
      }
      const where = `packages/${pkg}/skills/${entry.name}/SKILL.md`;
      if (pinned === undefined || !RELEASE_VERSION.test(pinned)) {
        problems.push(`${where}: library_version "${pinned ?? "<missing>"}" is not a release version`);
        continue;
      }
      seen.add(pinned);
      // BEHIND the latest tag = incoherent. EQUAL = the released state. AHEAD = the next
      // release being PREPARED — pins are bumped BEFORE tagging so the tagged commit (and the package
      // tarballs built from it, skills included) carries its own version; the tag then lands on a tree
      // whose pins are already true. Only "behind" fails.
      if (compareVersions(pinned, tag) < 0) {
        problems.push(`${where}: library_version "${pinned}" is behind the latest tag "${tag}"`);
      }
    }
  }
  // Mixed pins are drift-in-progress whichever way they lean — a half-done bump must not pass.
  if (seen.size > 1) {
    problems.push(`pins disagree across skills (${[...seen].sort().join(", ")}) — bump them together`);
  }
  if (problems.length > 0) {
    console.error(`\n❌ Skill version pins (latest tag is "${tag}"):\n  ${problems.join("\n  ")}`);
    console.error(
      "Before tagging a release: `bun run skills:pins:write [version]` (default: next patch after the latest " +
        "tag), review each skill's text against what that release ships, commit, THEN tag that exact version.",
    );
    return false;
  }
  const pinned = [...seen][0] ?? tag;
  const state = pinned === tag ? "match the latest tag" : `are prepared for the next release ("${pinned}")`;
  console.log(`\nlibrary_version pins ${state} (latest tag "${tag}") across ${packagesWithSkills.length} packages.`);
  return true;
}

// `--write-pins [version]` (via `bun run skills:pins:write [version]`) sets every pin to the given release
// version, defaulting to the next patch after the latest tag. Pins are checked before structural validation
// so an incoherent release fails immediately; `--pins-only` is the fast early lane used by `validate`.
const writeFlagIdx = process.argv.indexOf("--write-pins");
let writeVersion: string | null = null;
if (writeFlagIdx >= 0) {
  const explicit = process.argv[writeFlagIdx + 1];
  if (explicit !== undefined && !RELEASE_VERSION.test(explicit)) {
    console.error(`--write-pins expects a release version (x.y.z); received "${explicit}".`);
    process.exit(1);
  }
  if (explicit !== undefined) {
    writeVersion = explicit;
  } else {
    const tag = latestTag();
    if (tag === null || !RELEASE_VERSION.test(tag)) {
      console.error("--write-pins needs an explicit version when no release tag is visible.");
      process.exit(1);
    }
    const [major, minor, patch] = tag.split(".").map(Number);
    writeVersion = `${major}.${minor}.${(patch ?? 0) + 1}`;
  }
}

let anyFailed = false;
if (!checkVersionPins(writeVersion)) anyFailed = true;

if (process.argv.includes("--pins-only")) {
  process.exit(anyFailed ? 1 : 0);
}

if (!existsSync(cli)) {
  console.error("@tanstack/intent is not installed (expected at node_modules/@tanstack/intent). Run `bun install`.");
  process.exit(1);
}

for (const pkg of packagesWithSkills) {
  console.log(`\n=== packages/${pkg} ===`);
  const result = spawnSync("bun", [cli, "validate"], { cwd: path.join(packagesDir, pkg), stdio: "inherit" });
  if (result.status !== 0) anyFailed = true;
}

process.exit(anyFailed ? 1 : 0);
