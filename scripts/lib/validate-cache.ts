import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

// Shared content-addressed cache primitives for the validate pipeline (ADR-0051).
//
// Used by both `run-if-changed.ts` (per-stage input fingerprints) and `select-unit-tests.ts`
// (per-file import-graph fingerprints). A file's contribution to a fingerprint is its **git blob
// object id** — deterministic per content and identical whether the file is clean-tracked,
// dirty-tracked, or untracked. That canonical hash is what keeps the cache stable across `git add`
// and commit: identical bytes always hash identically, so a green `validate` stays green through the
// commit hook (staging a file never flips its fingerprint).

export const CACHE_DIR = ".buildcache/validate";

function git(args: string[]): string {
  const result = spawnSync("git", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr ?? ""}`);
  }
  return result.stdout;
}

/** Tracked + untracked-not-ignored files (gitignored files excluded). */
export function gitUniverse(): string[] {
  return git(["ls-files", "-co", "--exclude-standard", "-z"])
    .split("\0")
    .filter((f) => f.length > 0);
}

export interface HashContext {
  /** repo-relative path -> git blob object id in the index. */
  trackedBlob: Map<string, string>;
  /** tracked files whose working-tree content differs from the index. */
  modified: Set<string>;
}

export function createHashContext(): HashContext {
  const trackedBlob = new Map<string, string>();
  // `git ls-files -s -z` records: "<mode> <blobsha> <stage>\t<path>\0".
  for (const record of git(["ls-files", "-s", "-z"]).split("\0")) {
    if (record.length === 0) continue;
    const tab = record.indexOf("\t");
    if (tab === -1) continue;
    const sha = record.slice(0, tab).split(" ")[1];
    const filePath = record.slice(tab + 1);
    if (sha) trackedBlob.set(filePath, sha);
  }
  const modified = new Set(
    git(["ls-files", "-m", "-z"])
      .split("\0")
      .filter((f) => f.length > 0),
  );
  return { trackedBlob, modified };
}

/** git's blob object id: sha1("blob <byteLength>\0" + bytes). */
function gitBlobId(bytes: Uint8Array): string {
  const hash = createHash("sha1");
  hash.update(`blob ${bytes.length}\0`);
  hash.update(bytes);
  return hash.digest("hex");
}

/**
 * Working-tree-accurate content hash. A clean tracked file reuses git's index blob id (no read); a
 * dirty tracked file or an untracked file is hashed from disk with the same git-blob algorithm, so
 * identical content is indistinguishable regardless of how the file is tracked.
 */
export function contentHash(relpath: string, ctx: HashContext): string {
  const tracked = ctx.trackedBlob.get(relpath);
  if (tracked !== undefined && !ctx.modified.has(relpath)) {
    return tracked;
  }
  try {
    return gitBlobId(readFileSync(relpath));
  } catch {
    // Listed in an input set but absent on disk (e.g. a pending deletion): a deterministic sentinel
    // that still changes the fingerprint relative to the file existing.
    return "absent";
  }
}

/** sha256 over the sorted (path, contentHash) pairs of `files`, plus any non-file `extra` tokens. */
export function fingerprint(files: Iterable<string>, ctx: HashContext, extra: string[] = []): string {
  const pairs = [...new Set(files)].sort().map((file) => `${file}\0${contentHash(file, ctx)}`);
  const hash = createHash("sha256");
  for (const pair of pairs) hash.update(`${pair}\n`);
  for (const token of extra) hash.update(`\0extra\0${token}\n`);
  return hash.digest("hex");
}

export function readRegistry(name: string): Record<string, string> {
  const file = path.join(CACHE_DIR, name);
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export function writeRegistry(name: string, data: Record<string, string>): void {
  mkdirSync(CACHE_DIR, { recursive: true });
  const sorted = Object.fromEntries(Object.entries(data).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(path.join(CACHE_DIR, name), `${JSON.stringify(sorted, null, 2)}\n`);
}

/** The latest annotated/lightweight tag, or "none" when the repo has no tags. */
export function latestGitTag(): string {
  const result = spawnSync("git", ["describe", "--tags", "--abbrev=0"], { encoding: "utf8" });
  const tag = result.status === 0 ? result.stdout.trim() : "";
  return tag.length > 0 ? tag : "none";
}
