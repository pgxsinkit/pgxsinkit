import { spawnSync } from "node:child_process";

import {
  createHashContext,
  fingerprint,
  gitUniverse,
  latestGitTag,
  readRegistry,
  writeRegistry,
} from "./lib/validate-cache";

// Per-stage content-addressed cache wrapper (ADR-0051). Skips a validation stage when the working-tree
// content of its declared input set is unchanged since the stage last passed.
//
//   run-if-changed <stage> --inputs <CODE|glob…> [--git-tag] -- <command…>
//
// The `CODE` preset is `git ls-files -co --exclude-standard` minus a small denylist; explicit globs are
// matched against that same universe (so untracked-not-ignored files count, gitignored files never do).
// `--git-tag` folds `git describe --tags --abbrev=0` (or "none") into the fingerprint — for the skills
// stage, whose pin check compares against the tag, a non-file input no content hash would capture.
//
// CI / PGXSINKIT_FORCE=1 always run and refresh on pass; PGXSINKIT_NO_CACHE=1 always runs (never skips)
// but still records on pass. Otherwise the stage is skipped iff its fingerprint already passed.

const REGISTRY = "registry.json";

// Paths a code stage (typecheck/lint/electric/sync) can never be affected by. Each entry must be
// provably incapable of changing a code stage's result; an under-invalidation could only hide here.
const CODE_DENYLIST = ["docs/**", "apps/docs/**", "**/*.md", "brand/**", "LICENSE", "NOTICE"];

interface ParsedArgs {
  stage: string;
  inputs: string[];
  gitTag: boolean;
  command: string[];
}

function usage(message: string): never {
  console.error(`run-if-changed: ${message}`);
  console.error("usage: run-if-changed <stage> --inputs <CODE|glob…> [--git-tag] -- <command…>");
  process.exit(2);
}

function parseArgs(argv: string[]): ParsedArgs {
  const stage = argv[0];
  if (!stage || stage.startsWith("--")) usage("missing <stage>");
  if (argv[1] !== "--inputs") usage("expected --inputs after <stage>");

  const inputs: string[] = [];
  let gitTag = false;
  let cursor = 2;
  for (; cursor < argv.length; cursor++) {
    const token = argv[cursor]!;
    if (token === "--git-tag") {
      gitTag = true;
      continue;
    }
    if (token === "--") {
      cursor++;
      break;
    }
    inputs.push(token);
  }
  const command = argv.slice(cursor);
  if (inputs.length === 0) usage("--inputs requires at least one entry");
  if (command.length === 0) usage("missing -- <command…>");
  return { stage: stage!, inputs, gitTag, command };
}

function resolveInputSet(inputs: string[], universe: string[]): string[] {
  const selected = new Set<string>();
  if (inputs.includes("CODE")) {
    const deny = CODE_DENYLIST.map((pattern) => new Bun.Glob(pattern));
    for (const file of universe) {
      if (!deny.some((glob) => glob.match(file))) selected.add(file);
    }
  }
  const explicitGlobs = inputs.filter((token) => token !== "CODE").map((pattern) => new Bun.Glob(pattern));
  if (explicitGlobs.length > 0) {
    for (const file of universe) {
      if (explicitGlobs.some((glob) => glob.match(file))) selected.add(file);
    }
  }
  return [...selected];
}

const { stage, inputs, gitTag, command } = parseArgs(process.argv.slice(2));

const universe = gitUniverse();
const ctx = createHashContext();
const files = resolveInputSet(inputs, universe);
const extra = gitTag ? [`git-tag:${latestGitTag()}`] : [];
const fp = fingerprint(files, ctx, extra);

const forced = Boolean(process.env["CI"]) || process.env["PGXSINKIT_FORCE"] === "1";
const noCache = process.env["PGXSINKIT_NO_CACHE"] === "1";
const registry = readRegistry(REGISTRY);

if (!forced && !noCache && registry[stage] === fp) {
  console.log(`cached ${stage}`);
  process.exit(0);
}

const result = spawnSync(command[0]!, command.slice(1), { stdio: "inherit", env: process.env });
const code = result.status ?? 1;
if (code === 0) {
  registry[stage] = fp;
  writeRegistry(REGISTRY, registry);
}
process.exit(code);
