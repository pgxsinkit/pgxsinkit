import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { findSkillFiles, readLibraryVersion, SKILL_PIN_PLACEHOLDER } from "./lib/skill-pins";

// Validate every workspace package's Agent Skills (`skills/**/SKILL.md`) with the @tanstack/intent CLI.
//
// Invokes the CLI by its explicit resolved path on purpose: `@electric-sql/client` also ships an
// `intent` binary, so `bunx @tanstack/intent` / the `.bin/intent` shim can resolve to the wrong one from
// inside a package that has Electric installed. The explicit path is unambiguous. Each package is
// validated with its own directory as cwd so the CLI's packaging checks read that package's package.json.
//
// Beyond the CLI's structural checks, this script holds each skill's `library_version` to the tag-derived
// standard (ADR-0001), exactly like package.json's `version`: in the repo every pin is the placeholder
// "0.0.0" and is never hand-edited. The real version is stamped into the packed copy at publish time by
// `scripts/publish-github-packages.ts`, which also refuses to publish a package whose staged skills do not
// carry exactly the version being published. `--pins-only` (via `bun run skills:pins:check`) is the fast
// early lane `validate` / `validate:full` run first.

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

function checkVersionPins(): boolean {
  const problems: string[] = [];
  let count = 0;
  for (const pkg of packagesWithSkills) {
    for (const skillFile of findSkillFiles(path.join(packagesDir, pkg))) {
      count++;
      const pinned = readLibraryVersion(readFileSync(skillFile, "utf8"));
      if (pinned !== SKILL_PIN_PLACEHOLDER) {
        const where = path.relative(root, skillFile);
        problems.push(
          `${where}: library_version "${pinned ?? "<missing>"}" is not the placeholder "${SKILL_PIN_PLACEHOLDER}"`,
        );
      }
    }
  }
  if (problems.length > 0) {
    console.error(`\n❌ Skill version pins:\n  ${problems.join("\n  ")}`);
    console.error(
      `Every SKILL.md carries library_version: "${SKILL_PIN_PLACEHOLDER}" in the repo. The real version is stamped ` +
        "into the packed copy at publish (scripts/publish-github-packages.ts, tag-derived per ADR-0001) — never " +
        `edit the pin; set it back to "${SKILL_PIN_PLACEHOLDER}".`,
    );
    return false;
  }
  console.log(
    `\nlibrary_version pins are the "${SKILL_PIN_PLACEHOLDER}" placeholder across ${count} skills in ` +
      `${packagesWithSkills.length} packages (stamped at publish).`,
  );
  return true;
}

let anyFailed = false;
if (!checkVersionPins()) anyFailed = true;

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
