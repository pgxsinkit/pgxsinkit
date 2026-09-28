import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

// Agent Skill version pins (`metadata.library_version` in each `packages/*/skills/**/SKILL.md`) follow the
// tag-derived standard exactly like `package.json`'s `version` (ADR-0001): the repo carries the placeholder
// below and never edits it; `scripts/publish-github-packages.ts` stamps the version it publishes into the
// copy it packs, and refuses to publish a package whose staged skills disagree with that version.

/** The placeholder every committed SKILL.md carries — the `library_version` twin of package.json's `0.0.0`. */
export const SKILL_PIN_PLACEHOLDER = "0.0.0";

// The frontmatter pin line: group 1 is everything up to the opening quote, group 2 the quoted value.
const LIBRARY_VERSION_RE = /^(\s*library_version:\s*)"([^"]*)"/m;

/** Every `SKILL.md` under `<packageDir>/skills` (any depth), sorted; empty when the package ships no skills. */
export function findSkillFiles(packageDir: string): string[] {
  const skillsDir = path.join(packageDir, "skills");
  if (!existsSync(skillsDir)) return [];
  return readdirSync(skillsDir, { recursive: true, encoding: "utf8" })
    .filter((rel) => path.basename(rel) === "SKILL.md")
    .map((rel) => path.join(skillsDir, rel))
    .sort();
}

/** The quoted `library_version` value, or null when the file has no pin line. */
export function readLibraryVersion(content: string): string | null {
  return content.match(LIBRARY_VERSION_RE)?.[2] ?? null;
}

/** `content` with its `library_version` set to `version`; unchanged when there is no pin line to stamp. */
export function stampLibraryVersion(content: string, version: string): string {
  return content.replace(LIBRARY_VERSION_RE, (_match, prefix: string) => `${prefix}"${version}"`);
}
