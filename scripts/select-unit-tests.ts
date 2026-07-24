import { readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

import { createHashContext, fingerprint, gitUniverse, readRegistry, writeRegistry } from "./lib/validate-cache";
import { runUnitTests } from "./run-unit-tests";

// Per-file import-graph unit-test selection (ADR-0051). Each tests/unit/*.test.ts is fingerprinted over
// its transitive import closure plus a global input set; a file whose fingerprint already passed is
// skipped, the rest feed scripts/run-unit-tests.ts. Selection is strictly fail-closed: any doubt about a
// file's graph (parse/resolve failure, computed dynamic import, non-literal mock.module target) or an
// off-graph filesystem read makes it always run.
//
// This module is the ONLY writer of the per-file registry, and only for a file that ran in full inside a
// shard that exited 0 (the priming invariant). Narrowing flags are refused — a subset run must never
// certify a file.

const REPO_ROOT = process.cwd();
const REGISTRY = "test-registry.json";

// Changing any GLOBAL re-runs every test (its content is folded into every file's fingerprint).
const GLOBALS = [
  "tests/support/**",
  "bun.lock",
  "bunfig.toml",
  "scripts/run-unit-tests.ts",
  "scripts/select-unit-tests.ts",
  "scripts/lib/validate-cache.ts",
  "tsconfig*.json",
  "mise.toml",
];

// The only tests that read repo files OFF-GRAPH (an fs read the import graph can't see). Each maps to the
// globs whose contents join its fingerprint. A new, undeclared reader is force-run with a warning.
const FS_INPUTS: Record<string, string[]> = {
  "public-package-set": ["packages/*/package.json"],
  "public-package-artifacts": ["packages/**", "scripts/build-public-packages.ts"],
};

// `bun test` narrowing flags — forwarding any would certify a partial run, so they are refused.
const NARROWING_FLAGS = ["-t", "--test-name-pattern", "--only", "--shard", "--changed"];

const MODULE_EXTS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const FS_READ_PREFIXES = ["readFile", "readdir", "exists", "stat"];
const CP_READ_NAMES = ["execFileSync", "spawnSync", "execSync", "spawn", "execFile"];

const globs = (patterns: string[]) => patterns.map((pattern) => new Bun.Glob(pattern));
const escapeRe = (name: string) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ── import-graph analysis ─────────────────────────────────────────────────────

type Edge =
  | { kind: "builtin" | "external" | "unresolvable" }
  | { kind: "internal-module" | "internal-asset"; rel: string };

function classifyResolved(real: string): Edge {
  const rel = path.relative(REPO_ROOT, real);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return { kind: "external" };
  if (rel.split(path.sep).includes("node_modules")) return { kind: "external" };
  const ext = path.extname(real);
  return MODULE_EXTS.has(ext) ? { kind: "internal-module", rel } : { kind: "internal-asset", rel };
}

function resolveEdge(spec: string, fromDir: string): Edge {
  if (spec.startsWith("node:") || spec.startsWith("bun:")) return { kind: "builtin" };
  const isBare = !spec.startsWith(".") && !spec.startsWith("/");
  let resolved: string;
  try {
    resolved = Bun.resolveSync(spec, fromDir);
  } catch {
    // A bare (package-style) specifier that can't be resolved is a node_modules dep whose content is
    // pinned by bun.lock (a GLOBAL) — e.g. an optional/peer module a test mocks but never installs; it
    // is external, not a graph hole. A relative/absolute specifier that can't resolve is a genuine hole.
    return isBare ? { kind: "external" } : { kind: "unresolvable" };
  }
  if (!resolved.startsWith("/")) return { kind: "builtin" }; // a scheme like node:/bun: resolved to itself
  try {
    return classifyResolved(realpathSync(resolved)); // collapse workspace symlinks back to real source
  } catch {
    return { kind: "unresolvable" };
  }
}

function loaderFor(ext: string): "ts" | "tsx" | "js" | "jsx" {
  if (ext === ".tsx") return "tsx";
  if (ext === ".jsx") return "jsx";
  if (ext === ".js" || ext === ".mjs" || ext === ".cjs") return "js";
  return "ts";
}

const globalGlobs = globs(GLOBALS);
const isGlobalFile = (rel: string) => globalGlobs.some((glob) => glob.match(rel));

/**
 * Does the file perform an OFF-GRAPH REPO fs read — one that binds an import-graph-invisible repo file
 * into the test's result? Two conditions must both hold:
 *   1. a read call (node:fs read binding / `Bun.file` / a `node:child_process` exec) is present, not a
 *      temp write (`mkdir`/`writeFile`/`rm`/…), and
 *   2. that read is anchored to the repo — the file references `import.meta.dir`/`url`/`path` or
 *      `__dirname`, or reads a string-literal path.
 * A read whose path is a parameter or a `mkdtemp` temp root (e.g. a script handed a fixture dir) creates
 * no repo dependency, so it is graphed normally — that is what keeps temp-writer suites out of the map.
 */
function detectReader(src: string): boolean {
  const readCallFragments: string[] = [];
  const note = (fragment: string) => readCallFragments.push(fragment);

  if (/\bBun\.file\s*\(/.test(src)) note("Bun\\.file");

  const importRe = /import\s+(?:type\s+)?([^;'"]+?)\s+from\s+["'](node:fs|node:fs\/promises|node:child_process)["']/g;
  for (const match of src.matchAll(importRe)) {
    const clause = match[1]!.trim();
    const isChildProcess = match[2] === "node:child_process";
    if (clause.startsWith("{")) {
      const body = clause.slice(1, clause.lastIndexOf("}"));
      for (const raw of body.split(",")) {
        const entry = raw.trim();
        if (entry.length === 0) continue;
        const [orig, local] = entry.split(/\s+as\s+/).map((part) => part.trim());
        const original = orig!;
        const localName = (local ?? orig)!;
        const isRead = isChildProcess
          ? CP_READ_NAMES.includes(original)
          : FS_READ_PREFIXES.some((prefix) => original.startsWith(prefix));
        if (isRead && new RegExp(`\\b${escapeRe(localName)}\\s*\\(`).test(src)) note(`\\b${escapeRe(localName)}`);
      }
    } else {
      const namespace = clause.replace(/^\*\s+as\s+/, "").trim();
      const alternation = isChildProcess ? CP_READ_NAMES.join("|") : "readFile\\w*|readdir\\w*|exists\\w*|stat\\w*";
      const fragment = `\\b${escapeRe(namespace)}\\.(?:${alternation})`;
      if (new RegExp(`${fragment}\\s*\\(`).test(src)) note(fragment);
    }
  }

  if (readCallFragments.length === 0) return false;
  if (/import\.meta\.(?:dir|url|path)\b|\b__dirname\b/.test(src)) return true;
  return readCallFragments.some((fragment) => new RegExp(`${fragment}\\s*\\(\\s*["'\`]`).test(src));
}

interface FileAnalysis {
  moduleDeps: string[];
  assetDeps: string[];
  ungraphable: boolean;
  reasons: string[];
  reader: boolean;
}

const analysisCache = new Map<string, FileAnalysis>();

function analyzeFile(rel: string): FileAnalysis {
  const cached = analysisCache.get(rel);
  if (cached) return cached;
  const analysis: FileAnalysis = { moduleDeps: [], assetDeps: [], ungraphable: false, reasons: [], reader: false };
  analysisCache.set(rel, analysis); // seed before recursing so import cycles terminate

  const abs = path.join(REPO_ROOT, rel);
  let src: string;
  try {
    src = readFileSync(abs, "utf8");
  } catch {
    analysis.ungraphable = true;
    analysis.reasons.push(`unreadable: ${rel}`);
    return analysis;
  }

  const fromDir = path.dirname(abs);
  const applyEdge = (edge: Edge) => {
    if (edge.kind === "unresolvable") {
      analysis.ungraphable = true;
      analysis.reasons.push(`unresolvable specifier in ${rel}`);
    } else if (edge.kind === "internal-module") {
      analysis.moduleDeps.push(edge.rel);
    } else if (edge.kind === "internal-asset") {
      analysis.assetDeps.push(edge.rel);
    }
  };

  const transpiler = new Bun.Transpiler({ loader: loaderFor(path.extname(abs)) });
  // A leading `#!` shebang (repo scripts have one) is invalid inside a module — strip it before transpiling.
  const source = src.startsWith("#!") ? src.slice(src.indexOf("\n") + 1) : src;
  let imports: { kind: string; path: string }[];
  let transformed: string;
  try {
    imports = transpiler.scanImports(source);
    transformed = transpiler.transformSync(source); // erases comments + type-only imports, keeps runtime imports
  } catch {
    analysis.ungraphable = true;
    analysis.reasons.push(`parse failure: ${rel}`);
    return analysis;
  }

  let dynamicEdges = 0;
  for (const imp of imports) {
    if (imp.kind === "dynamic-import") dynamicEdges++;
    applyEdge(resolveEdge(imp.path, fromDir));
  }

  // scanImports silently drops COMPUTED dynamic imports, so a surplus of runtime `import(` calls over the
  // literal edges it resolved means a computed one is present. Count on the transpiled output (not raw
  // source) so `import(` in comments/JSDoc and type-only `import("…")` positions can't false-trigger; a
  // stray `import(` inside a string literal survives and only over-forces (fail-closed, safe).
  const runtimeDynamicCalls = (transformed.match(/\bimport\s*\(/g) ?? []).length;
  if (runtimeDynamicCalls > dynamicEdges) {
    analysis.ungraphable = true;
    analysis.reasons.push(
      `computed dynamic import in ${rel} (${runtimeDynamicCalls} runtime > ${dynamicEdges} resolved)`,
    );
  }

  const totalMocks = (src.match(/\bmock\.module\s*\(/g) ?? []).length;
  if (totalMocks > 0) {
    const literalTargets = [...src.matchAll(/\bmock\.module\s*\(\s*["'`]([^"'`]+)["'`]/g)].map((m) => m[1]!);
    if (literalTargets.length < totalMocks) {
      analysis.ungraphable = true;
      analysis.reasons.push(`non-literal mock.module target in ${rel}`);
    }
    for (const target of literalTargets) applyEdge(resolveEdge(target, fromDir)); // literal mock → conservative edge
  }

  analysis.reader = detectReader(src);
  return analysis;
}

interface Closure {
  files: Set<string>;
  ungraphable: boolean;
  reasons: string[];
  reader: boolean;
}

function buildClosure(testRel: string): Closure {
  const files = new Set<string>();
  const reasons: string[] = [];
  let ungraphable = false;
  let reader = false;
  const queue = [testRel];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const rel = queue.shift()!;
    if (seen.has(rel)) continue;
    seen.add(rel);
    files.add(rel);
    const analysis = analyzeFile(rel);
    if (analysis.ungraphable) {
      ungraphable = true;
      reasons.push(...analysis.reasons);
    }
    if (analysis.reader && !isGlobalFile(rel)) reader = true;
    for (const dep of analysis.moduleDeps) if (!seen.has(dep)) queue.push(dep);
    for (const asset of analysis.assetDeps) files.add(asset); // hashed leaf, never walked
  }
  return { files, ungraphable, reasons, reader };
}

// ── selection ─────────────────────────────────────────────────────────────────

type Kind = "graphed" | "reader-declared" | "reader-undeclared" | "ungraphable";

interface Disposition {
  key: string;
  kind: Kind;
  fp: string | null; // null → always run, never recorded
  reasons: string[];
}

function main(): Promise<number> {
  const argv = process.argv.slice(2);
  for (const arg of argv) {
    if (NARROWING_FLAGS.some((flag) => arg === flag || arg.startsWith(`${flag}=`))) {
      console.error(`select-unit-tests: refusing narrowing flag "${arg}" — a partial run must never certify a file.`);
      process.exit(2);
    }
  }
  const report = argv.includes("--report");
  const unknown = argv.filter((arg) => arg !== "--report");
  if (unknown.length > 0) {
    console.error(`select-unit-tests: unexpected argument(s): ${unknown.join(" ")}`);
    process.exit(2);
  }

  const forced =
    Boolean(process.env["CI"]) || process.env["PGXSINKIT_FORCE"] === "1" || process.env["PGXSINKIT_NO_CACHE"] === "1";
  const runAll = forced || report;

  const universe = gitUniverse();
  const ctx = createHashContext();
  const universeGlobal = universe.filter((file) => isGlobalFile(file));

  const testFiles = readdirSync("tests/unit")
    .filter((file) => file.endsWith(".test.ts"))
    .sort()
    .map((file) => `tests/unit/${file}`);

  const dispositions: Disposition[] = [];
  for (const testRel of testFiles) {
    const key = path.basename(testRel).replace(/\.test\.ts$/, "");
    const closure = buildClosure(testRel);
    if (closure.ungraphable) {
      dispositions.push({ key, kind: "ungraphable", fp: null, reasons: closure.reasons });
      continue;
    }
    if (closure.reader) {
      const declared = FS_INPUTS[key];
      if (!declared) {
        console.warn(
          `select-unit-tests: ${key} reads repo files off-graph but is not declared in FS_INPUTS — forcing run.`,
        );
        dispositions.push({ key, kind: "reader-undeclared", fp: null, reasons: ["undeclared fs reader"] });
        continue;
      }
      const extraGlobs = globs(declared);
      const extraFiles = universe.filter((file) => extraGlobs.some((glob) => glob.match(file)));
      const fp = fingerprint([...closure.files, ...universeGlobal, ...extraFiles], ctx);
      dispositions.push({ key, kind: "reader-declared", fp, reasons: [`fsInputs: ${declared.join(", ")}`] });
      continue;
    }
    const fp = fingerprint([...closure.files, ...universeGlobal], ctx);
    dispositions.push({ key, kind: "graphed", fp, reasons: [] });
  }

  const registry = readRegistry(REGISTRY);
  const isSelected = (d: Disposition) => d.fp === null || registry[d.key] !== d.fp;
  const selected = dispositions.filter(isSelected);

  if (report) printReport(dispositions, registry);

  const filesToRun = (runAll ? dispositions : selected).map((d) => d.key);
  if (filesToRun.length === 0) {
    console.log("cached: 0 unit tests to run");
    return Promise.resolve(0);
  }

  const alwaysRun = selected.filter((d) => d.fp === null).length;
  const detail = runAll
    ? report
      ? " (--report audit: all)"
      : " (forced: all)"
    : ` (${selected.length - alwaysRun} changed, ${alwaysRun} always-run)`;
  console.log(`[select] ${filesToRun.length}/${dispositions.length} unit files to run${detail}`);

  return runUnitTests(filesToRun).then((outcomes) => {
    // Priming invariant: record a file green ONLY when it ran in full in a shard that exited 0. --report
    // is a non-trusting audit and records nothing.
    if (!report) {
      const fpByKey = new Map(dispositions.filter((d) => d.fp !== null).map((d) => [d.key, d.fp!]));
      for (const shard of outcomes) {
        if (shard.exitCode !== 0) continue;
        for (const key of shard.files) {
          const fp = fpByKey.get(key);
          if (fp !== undefined) registry[key] = fp;
        }
      }
      writeRegistry(REGISTRY, registry);
    }
    return outcomes.some((o) => o.exitCode !== 0) ? 1 : 0;
  });
}

function printReport(dispositions: Disposition[], registry: Record<string, string>): void {
  const byKind = (kind: Kind) => dispositions.filter((d) => d.kind === kind);
  const graphed = byKind("graphed");
  const readerDeclared = byKind("reader-declared");
  const readerUndeclared = byKind("reader-undeclared");
  const ungraphable = byKind("ungraphable");
  const isNew = (d: Disposition) => d.fp !== null && registry[d.key] === undefined;
  const isChanged = (d: Disposition) => d.fp !== null && registry[d.key] !== undefined && registry[d.key] !== d.fp;

  console.log(`\n[select --report] ${dispositions.length} unit files`);
  console.log(`  graphed:              ${graphed.length}`);
  console.log(`  reader (declared):    ${readerDeclared.length}  ${readerDeclared.map((d) => d.key).join(", ")}`);
  console.log(`  reader (undeclared):  ${readerUndeclared.length}  ${readerUndeclared.map((d) => d.key).join(", ")}`);
  console.log(`  ungraphable:          ${ungraphable.length}`);
  for (const d of ungraphable) console.log(`    - ${d.key}: ${[...new Set(d.reasons)].join("; ")}`);
  console.log(`  new (no cache entry): ${dispositions.filter(isNew).length}`);
  console.log(`  changed (fp≠cache):   ${dispositions.filter(isChanged).length}`);
  console.log("running ALL files (audit; registry not written)\n");
}

process.exit(await main());
