import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

// Generate (or check) the ADR list on the docs "Design decisions" page from docs/adr/*.md, so the page
// can never silently fall behind the ADRs. `bun run docs:adr` regenerates the list between the markers;
// `bun run docs:adr:check` (run by `docs:build`) fails if any ADR is missing from — or stale on — the page.
//
// The check is deliberately *semantic* (the set of ADR files referenced), not a byte comparison, so it
// stays green after oxfmt reflows the generated block.

const root = process.cwd();
const adrDir = path.join(root, "docs/adr");
const pagePath = path.join(root, "apps/docs/src/content/docs/decisions/index.md");
const START = "<!-- adr:list:start -->";
const END = "<!-- adr:list:end -->";
const repoTree = "https://github.com/pgxsinkit/pgxsinkit/blob/main/docs/adr";
const check = process.argv.includes("--check");

const adrFiles = readdirSync(adrDir)
  .filter((file) => /^\d{4}-.+\.md$/.test(file))
  .sort();

if (adrFiles.length === 0) {
  console.error(`No ADRs found in ${path.relative(root, adrDir)}.`);
  process.exit(1);
}

const page = readFileSync(pagePath, "utf8");
const startIdx = page.indexOf(START);
const endIdx = page.indexOf(END);
if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
  console.error(`Markers ${START} / ${END} not found (in order) in ${path.relative(root, pagePath)}.`);
  process.exit(1);
}

if (check) {
  const referenced = new Set(
    [...page.matchAll(/docs\/adr\/(\d{4}-[\w-]+\.md)/g)].flatMap((match) => (match[1] ? [match[1]] : [])),
  );
  const missing = adrFiles.filter((file) => !referenced.has(file));
  const stale = [...referenced].filter((file) => !adrFiles.includes(file)).sort();
  if (missing.length > 0 || stale.length > 0) {
    if (missing.length > 0) console.error(`ADRs missing from the decisions page: ${missing.join(", ")}`);
    if (stale.length > 0) console.error(`Stale ADR links on the decisions page: ${stale.join(", ")}`);
    console.error("Run `bun run docs:adr` to regenerate.");
    process.exit(1);
  }
  console.log(`Decisions page lists all ${adrFiles.length} ADRs.`);
  process.exit(0);
}

const items = adrFiles.map((file) => {
  const num = file.slice(0, 4);
  const heading = readFileSync(path.join(adrDir, file), "utf8")
    .split("\n")
    .find((line) => line.startsWith("# "));
  if (!heading) throw new Error(`ADR ${file} has no '# ' title heading.`);
  return `- [ADR-${num} — ${heading.replace(/^#\s+/, "").trim()}](${repoTree}/${file})`;
});

const block = `${START}\n\n${items.join("\n")}\n\n${END}`;
const next = page.slice(0, startIdx) + block + page.slice(endIdx + END.length);
if (next === page) {
  console.log(`Decisions page already lists all ${adrFiles.length} ADRs.`);
} else {
  writeFileSync(pagePath, next);
  console.log(`Wrote ${adrFiles.length} ADRs to ${path.relative(root, pagePath)}.`);
}
