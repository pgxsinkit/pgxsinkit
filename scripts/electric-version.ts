import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

// Single-source the pinned ElectricSQL image version. `infra/electric-version.json` is the ONLY
// source of truth; every MANAGED reference below is mechanically derived from it.
//
//   bun run electric:check          — assert every managed reference matches the pin file (exit 1 on drift)
//   bun run electric:bump <version> — set the pin file's `version`, rewrite every managed reference, print
//   bun run electric:bump --latest    a reminder checklist. `--latest` resolves the newest semver tag from
//                                     Docker Hub. Network failures error cleanly — never a partial write.
//
// The pin file's `floor` is the hard minimum (feature-driven — the subquery preview `where` needs Electric
// ≥ 1.7). It changes rarely, by hand. `version` is the pinned/tested release and is auto-bumped here.
//
// EXCLUDED — provenance, NEVER rewritten by this script (they record what was verified when, not a
// compatibility claim; the integration lanes re-verify the wire against each new image):
//   - docs/adr/0023-*.md, docs/adr/0024-*.md   ("captured wire messages, Electric 1.7.4")
//   - packages/client/src/sync/tags.ts (wire-capture comment)
//   - tests/unit/shape-tags.test.ts   (wire-capture fixture note)
// Do NOT add any of these to MANAGED.

export interface ElectricPin {
  image: string;
  version: string;
  floor: string;
}

interface ManagedPattern {
  /** Global regex; capture group 1 is the semver to assert/rewrite. */
  regex: RegExp;
  /** Human label for drift/rewrite reporting. */
  label: string;
}

/** `docker.io/electricsql/electric:1.7.4` — the compose image line and the copy-paste doc mention. */
const IMAGE_TAG: ManagedPattern = {
  regex: /electricsql\/electric:(\d+\.\d+\.\d+)/g,
  label: "electricsql/electric:<version>",
};

/** The docs compatibility row: `tested against **1.7.4**`. */
const DOC_TESTED: ManagedPattern = {
  regex: /tested against \*\*(\d+\.\d+\.\d+)\*\*/g,
  label: "tested against **<version>**",
};

interface ManagedRef {
  file: string;
  pattern: ManagedPattern;
}

export const MANAGED: ManagedRef[] = [
  { file: "infra/compose/docker-compose.yml", pattern: IMAGE_TAG },
  { file: "infra/compose/board-compose.yml", pattern: IMAGE_TAG },
  { file: "apps/docs/src/content/docs/project/index.md", pattern: DOC_TESTED },
  { file: "apps/docs/src/content/docs/concepts/electric-subqueries.md", pattern: IMAGE_TAG },
];

const PIN_FILE = "infra/electric-version.json";
const SEMVER = /^\d+\.\d+\.\d+$/;

export function readPin(rootDir: string): ElectricPin {
  const raw = readFileSync(path.join(rootDir, PIN_FILE), "utf8");
  const pin = JSON.parse(raw) as ElectricPin;
  if (typeof pin.version !== "string" || !SEMVER.test(pin.version)) {
    throw new Error(`${PIN_FILE}: \`version\` must be an X.Y.Z semver (found ${JSON.stringify(pin.version)}).`);
  }
  if (typeof pin.floor !== "string" || !/^\d+\.\d+$/.test(pin.floor)) {
    throw new Error(`${PIN_FILE}: \`floor\` must be an X.Y major.minor (found ${JSON.stringify(pin.floor)}).`);
  }
  return pin;
}

export interface Drift {
  file: string;
  label: string;
  expected: string;
  /** Distinct semvers actually found for this reference (empty = the reference is missing). */
  found: string[];
}

/** Pure check: returns the (possibly empty) list of managed references that disagree with the pin file. */
export function checkElectricVersion(rootDir: string): Drift[] {
  const { version } = readPin(rootDir);
  const drift: Drift[] = [];
  for (const ref of MANAGED) {
    const content = readFileSync(path.join(rootDir, ref.file), "utf8");
    const found = [...content.matchAll(ref.pattern.regex)].map((m) => m[1]!);
    const distinct = [...new Set(found)];
    if (found.length === 0 || distinct.some((v) => v !== version)) {
      drift.push({ file: ref.file, label: ref.pattern.label, expected: version, found: distinct });
    }
  }
  return drift;
}

/** Rewrite every managed reference to `version`. Returns the files actually changed. */
function rewriteManaged(rootDir: string, version: string): string[] {
  const changed: string[] = [];
  for (const ref of MANAGED) {
    const abs = path.join(rootDir, ref.file);
    const content = readFileSync(abs, "utf8");
    const next = content.replace(ref.pattern.regex, (match, ver: string) => match.replace(ver, version));
    if (next !== content) {
      writeFileSync(abs, next);
      changed.push(ref.file);
    }
  }
  return changed;
}

function writePinVersion(rootDir: string, version: string): void {
  const abs = path.join(rootDir, PIN_FILE);
  const pin = readPin(rootDir);
  const next = { ...pin, version };
  writeFileSync(abs, `${JSON.stringify(next, null, 2)}\n`);
}

function satisfiesFloor(version: string, floor: string): boolean {
  const [vMajor, vMinor] = version.split(".").map(Number) as [number, number, number];
  const [fMajor, fMinor] = floor.split(".").map(Number) as [number, number];
  return vMajor > fMajor || (vMajor === fMajor && vMinor >= fMinor);
}

function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (pa[i]! !== pb[i]!) return pa[i]! - pb[i]!;
  }
  return 0;
}

interface DockerTagPage {
  results: { name: string }[];
  next: string | null;
}

/** Resolve the newest `X.Y.Z` tag from the Docker Hub API. Throws on any network/parse failure. */
async function resolveLatest(): Promise<string> {
  let url: string | null = "https://hub.docker.com/v2/repositories/electricsql/electric/tags?page_size=100";
  const versions: string[] = [];
  // Paginate defensively: the newest release is usually on page 1, but page ordering is push-time, not
  // semver, so walk enough pages to be sure we saw the max. Cap to avoid an unbounded loop.
  for (let page = 0; url && page < 5; page += 1) {
    const res: Response = await fetch(url);
    if (!res.ok) {
      throw new Error(`Docker Hub tags request failed: ${res.status} ${res.statusText}`);
    }
    const body = (await res.json()) as DockerTagPage;
    for (const tag of body.results) {
      if (SEMVER.test(tag.name)) versions.push(tag.name);
    }
    url = body.next;
  }
  if (versions.length === 0) {
    throw new Error("Docker Hub returned no X.Y.Z tags for electricsql/electric.");
  }
  return versions.sort(compareSemver).at(-1)!;
}

function reportDrift(drift: Drift[]): void {
  console.error(`ElectricSQL version drift — ${drift.length} managed reference(s) disagree with ${PIN_FILE}:`);
  for (const d of drift) {
    const found = d.found.length > 0 ? d.found.join(", ") : "(no reference found)";
    console.error(`  ${d.file} [${d.label}]: expected ${d.expected}, found ${found}`);
  }
  console.error("Run `bun run electric:bump <version>` (or fix the reference) to reconcile.");
}

function printBumpChecklist(version: string, changed: string[]): void {
  console.log(`Bumped ElectricSQL pin to ${version}.`);
  console.log(
    changed.length > 0
      ? `Rewrote ${changed.length} reference(s): ${changed.join(", ")}`
      : "No managed references needed rewriting (already at target).",
  );
  console.log("");
  console.log("Next steps (do NOT skip):");
  console.log("  1. bun update @electric-sql/client   — the wire-protocol client lib versions separately;");
  console.log("     review it in the same motion.");
  console.log("  2. bun run test:integration          — the sync-e2e lane is the real wire-compat proof;");
  console.log("     it pulls the new image in the podman lanes.");
  console.log("  3. commit the pin file, rewritten references, and any lockfile change together.");
}

async function main(): Promise<void> {
  const rootDir = process.cwd();
  const argv = process.argv.slice(2);

  if (argv.includes("--check")) {
    const drift = checkElectricVersion(rootDir);
    if (drift.length > 0) {
      reportDrift(drift);
      process.exit(1);
    }
    const { version } = readPin(rootDir);
    console.log(`ElectricSQL pin ${version}: all ${MANAGED.length} managed references match.`);
    process.exit(0);
  }

  const bumpIdx = argv.indexOf("--bump");
  if (bumpIdx !== -1) {
    const rest = argv.slice(bumpIdx + 1).filter((a) => !a.startsWith("--") || a === "--latest");
    const useLatest = argv.includes("--latest");
    let version: string;
    if (useLatest) {
      version = await resolveLatest();
      console.log(`--latest resolved to ${version}.`);
    } else {
      const arg = rest.find((a) => a !== "--latest");
      if (!arg) {
        console.error("Usage: bun scripts/electric-version.ts --bump <X.Y.Z> | --latest");
        process.exit(1);
      }
      version = arg;
    }

    if (!SEMVER.test(version)) {
      console.error(`Refusing to bump: ${JSON.stringify(version)} is not an X.Y.Z semver.`);
      process.exit(1);
    }
    const { floor } = readPin(rootDir);
    if (!satisfiesFloor(version, floor)) {
      console.error(`Refusing to bump: ${version} is below the hard floor ${floor}.`);
      process.exit(1);
    }

    writePinVersion(rootDir, version);
    const changed = rewriteManaged(rootDir, version);
    printBumpChecklist(version, changed);
    process.exit(0);
  }

  console.error("Usage: bun scripts/electric-version.ts --check | --bump <X.Y.Z> | --bump --latest");
  process.exit(1);
}

if (import.meta.main) {
  await main();
}
