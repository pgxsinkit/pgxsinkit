import { readdir } from "node:fs/promises";
import path from "node:path";

const workspaceRoot = process.cwd();

const allowedRootEntries = new Set([
  ".claude",
  ".codex",
  ".env",
  ".env.example",
  ".git",
  ".githooks",
  ".github",
  ".gitignore",
  ".intent",
  ".oxfmtrc.jsonc",
  ".oxlintrc.jsonc",
  ".vscode",
  "AGENTS.md",
  "CLAUDE.md",
  "CONTEXT-MAP.md",
  "CONTEXT.md",
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
