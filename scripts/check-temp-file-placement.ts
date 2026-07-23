import { readdir } from "node:fs/promises";
import path from "node:path";

const workspaceRoot = process.cwd();

const allowedRootEntries = new Set([
  ".buildcache",
  ".claude",
  ".codex",
  ".env",
  ".env.example",
  // Cloud board demo credentials (board ADR-0008): the committed template + the gitignored real env.
  "board.cloud.env.example",
  "board.cloud.env",
  ".git",
  ".githooks",
  ".github",
  ".gitignore",
  ".intent",
  // Committed bunfig.toml — bun's native config (the shared `bun test` preload).
  "bunfig.toml",
  // CI-written GitHub Packages auth for the publish job (gitignored); also written locally when
  // previewing the CI publish path.
  ".npmrc",
  ".oxfmtrc.jsonc",
  ".oxlintrc.jsonc",
  ".vscode",
  "AGENTS.md",
  "CLAUDE.md",
  "CONTEXT-MAP.md",
  "CONTEXT.md",
  "LICENSE",
  "NOTICE",
  "README.md",
  "RELEASING.md",
  "apps",
  "brand",
  "bun.lock",
  "docs",
  "drizzle",
  "drizzle.config.ts",
  "infra",
  "mise.toml",
  "node_modules",
  "package.json",
  "packages",
  // Playwright browser lane (ADR-0032 S3): the config is a permanent root file; its run outputs
  // (test-results/, playwright-report/) are gitignored but land at root, so they are allowed as
  // entries while remaining ignored by git — the lane's teardown removes them best-effort.
  "playwright.config.ts",
  "playwright.warm-boot.config.ts",
  "playwright-report",
  "test-results",
  "scripts",
  "supabase",
  "tests",
  "tmp",
  "tools",
  "tsconfig.base.json",
  "tsconfig.json",
  "vitest.config.ts",
]);

const ignoredWalkDirectories = new Set([".git", ".vscode", "node_modules", "tmp"]);

const disallowedFileSuffixPatterns = [/\.(log|tmp|temp|bak|orig|rej|pid)$/i];

const disallowedRootScratchNamePatterns = [/^(tmp|temp|scratch|debug|check)[-_.]/i, /^test[-_.].+/i, /^test_output\./i];

const unexpectedRootEntries = await findUnexpectedRootEntries();
const misplacedScratchFiles = await findMisplacedScratchFiles();

if (unexpectedRootEntries.length === 0 && misplacedScratchFiles.length === 0) {
  console.log("Temp file placement check passed.");
  process.exit(0);
}

if (unexpectedRootEntries.length > 0) {
  console.error(
    "Unexpected root-level entries detected. Put temporary artifacts under tmp/ or explicitly add permanent root files to the allowlist:",
  );
  for (const entry of unexpectedRootEntries) {
    console.error(`  - ${entry}`);
  }
}

if (misplacedScratchFiles.length > 0) {
  console.error("Scratch-like files detected outside tmp/:");
  for (const filePath of misplacedScratchFiles) {
    console.error(`  - ${filePath}`);
  }
}

process.exit(1);

async function findUnexpectedRootEntries() {
  const entries = await readdir(workspaceRoot, { withFileTypes: true });
  return entries
    .map((entry) => entry.name)
    .filter((entryName) => !allowedRootEntries.has(entryName))
    .sort((left, right) => left.localeCompare(right));
}

async function findMisplacedScratchFiles() {
  const matches: string[] = [];
  await walkDirectory(workspaceRoot, matches);
  return matches.sort((left, right) => left.localeCompare(right));
}

async function walkDirectory(currentDirectory: string, matches: string[]) {
  const entries = await readdir(currentDirectory, { withFileTypes: true });

  for (const entry of entries) {
    const absolutePath = path.join(currentDirectory, entry.name);
    const relativePath = path.relative(workspaceRoot, absolutePath);

    if (relativePath.length === 0) {
      continue;
    }

    const topLevelEntry = relativePath.split(path.sep)[0] ?? "";

    if (entry.isDirectory()) {
      if (ignoredWalkDirectories.has(topLevelEntry)) {
        continue;
      }

      await walkDirectory(absolutePath, matches);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    if (matchesScratchPattern(relativePath, entry.name)) {
      matches.push(relativePath);
    }
  }
}

function matchesScratchPattern(relativePath: string, fileName: string) {
  if (disallowedFileSuffixPatterns.some((pattern) => pattern.test(fileName))) {
    return true;
  }

  if (!relativePath.includes(path.sep)) {
    return disallowedRootScratchNamePatterns.some((pattern) => pattern.test(fileName));
  }

  return false;
}
