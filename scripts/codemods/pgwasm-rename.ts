// The PGlite -> pgwasm public rename (ADR-0062 d5: no aliases), as a codemod. It rewrites pgxsinkit's own
// sources (pgwasm step 3, B4) and is the codemod a consumer (emergent, step 4) runs over its tree.
//
//   bun scripts/codemods/pgwasm-rename.ts [--write] <file-or-dir>...
//   bun scripts/codemods/pgwasm-rename.ts [--write] --typecheck-log <tsc-output> <file-or-dir>...
//
// Without `--write` it reports what it would change. It is driven by CLOSED lists, never by patterns on
// common words:
//
// - IDENTIFIER_RENAMES: whole identifier tokens only (`[A-Za-z_$][\w$]*`), looked up in the map, so a name
//   inside a longer identifier (`createPgliteFactory`) is left alone. Applied in code, comments and strings,
//   so `{@link ...}` references follow the rename.
// - SPECIFIER_RENAMES: a listed module specifier, in a module-specifier position only.
// - PHRASE_RENAMES: listed multi-word diagnostics strings (the boot rail lines and phases), matched exactly.
// - MANUAL_SITES: names whose replacement is structural, not a rename (e.g. `pgliteBootAssets` becomes
//   `build: createCBuild({ assets })`). They are reported with their guidance and never rewritten.
//
// `pglite` itself is also a common local variable name, so the property renames (`client.pglite`, React's
// `{ pglite }`) are never matched textually. After the public types change, run the typecheck, and pass its
// output with `--typecheck-log`: each "property 'pglite' does not exist" diagnostic is fixed at its exact
// position (`.pglite` -> `.pgwasm`, `pglite:` -> `pgwasm:`, a shorthand `{ pglite }` -> `{ pgwasm: pglite }`).

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Old identifier -> new identifier. From the step-3 design's rename table (section 1). */
export const IDENTIFIER_RENAMES: ReadonlyMap<string, string> = new Map([
  // @pgxsinkit/client
  ["ClientPGlite", "PgwasmClient"],
  ["createClientPGlite", "createPgwasmClient"],
  ["CreateClientPGliteOptions", "CreatePgwasmClientOptions"],
  ["pgliteWasmModule", "postgresWasmModule"],
  ["pgliteInstance", "pgwasmInstance"],
  ["precreatedPglite", "precreatedPgwasm"],
  ["pgliteCreateMs", "pgwasmCreateMs"],
  ["pgliteFactories", "opfsFactories"],
  // defineSyncWorker options
  ["createPglite", "createStore"],
  // the store, now @pgxsinkit/pgwasm/opfs
  ["createOpfsRepackedPGlite", "createOpfsPgwasm"],
  ["createOpfsRepacked", "createOpfsPgwasm"],
  ["CreateOpfsRepackedPGliteOptions", "CreateOpfsPgwasmOptions"],
  ["OpfsRepackedPGlite", "OpfsPgwasm"],
  ["OpfsRepackedCreatePhase", "OpfsCreatePhase"],
  // imports whose names change with their module
  ["PGliteWithLive", "PgwasmWithLive"],
  ["PgliteDatabase", "PgwasmDatabase"],
]);

/** Old module specifier -> new module specifier (a string literal's whole content). */
export const SPECIFIER_RENAMES: ReadonlyMap<string, string> = new Map([
  ["@electric-sql/pglite/live", "@pgxsinkit/pgwasm/live"],
  ["drizzle-orm/pglite", "@pgxsinkit/pgwasm/drizzle"],
  ["@electric-sql/pglite-prepopulatedfs", "@pgxsinkit/pgwasm-c/prepopulated"],
  ["@electric-sql/pglite-repl", "@pgxsinkit/pgwasm-repl"],
  ["@electric-sql/pglite-tools/pg_dump", "@pgxsinkit/pgwasm-pg-dump"],
  ["@electric-sql/pglite/contrib/amcheck", "@pgxsinkit/pgwasm-c/contrib/amcheck"],
  ["@pgxsinkit/pglite-opfs-repacked", "@pgxsinkit/pgwasm/opfs"],
]);

/** Old diagnostics phrase -> new phrase, matched exactly (the boot rail's line names and phases). */
export const PHRASE_RENAMES: ReadonlyMap<string, string> = new Map([
  ["boot pglite.create", "boot pgwasm.create"],
  ["boot pglite assets warm", "boot pgwasm build warm"],
  ['"vfs-opened"', '"store-opened"'],
  ['"pglite-ready"', '"pgwasm-ready"'],
]);

/**
 * Phrases whose replacement is structural: reported with guidance, never rewritten. A phrase matches only
 * where it isn't part of a longer identifier (`bootAssets` does not match inside `pgliteBootAssets`).
 */
export const MANUAL_SITES: ReadonlyMap<string, string> = new Map([
  ["pgliteBootAssets", "replace with `build: createCBuild({ assets })` (`assets`: a Promise<CBuildAssets>)"],
  ["bootAssets", "createPgwasmClient's `bootAssets` becomes `build: createCBuild({ assets })`"],
  ["PgliteBootAssets", "use `CBuildAssets` from @pgxsinkit/pgwasm-c (`pgliteWasmModule` -> `postgresWasmModule`)"],
  ["PGlite.create", "becomes `createPgwasm({ build: cBuild, ... })` (async)"],
  ["new PGlite", "becomes `await createPgwasm({ build: cBuild, ... })`"],
  ['"@electric-sql/pglite"', "import `createPgwasm` from @pgxsinkit/pgwasm and `cBuild` from @pgxsinkit/pgwasm-c"],
  [".strictSync()", "`instance.strictSync()` becomes `strictSync(pg)` from @pgxsinkit/pgwasm/opfs"],
]);

/** Property renames applied only at typecheck-reported positions. */
export const TYPECHECK_PROPERTY_RENAMES: ReadonlyMap<string, string> = new Map([["pglite", "pgwasm"]]);

/** The source files the codemod reads. */
export const SOURCE_EXTENSIONS: ReadonlySet<string> = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs"]);

const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", ".git", ".buildcache"]);
const IDENTIFIER = /[A-Za-z_$][\w$]*/g;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Only in a module-specifier position (`from`, `import`, `import()`, `require()`, `mock.module()`, `vi.mock()`,
// `declare module`), so a package name held as data (an artefact pin) or quoted in a comment is left alone.
const SPECIFIER_LEAD = String.raw`(\bfrom\s+|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*|\bmock\.module\s*\(\s*|\bvi\.mock\s*\(\s*|\bdeclare\s+module\s+)`;
const SPECIFIER_PATTERN = new RegExp(
  `${SPECIFIER_LEAD}(['"])(${[...SPECIFIER_RENAMES.keys()].map(escapeRegExp).join("|")})\\2`,
  "g",
);

export interface RewriteResult {
  readonly text: string;
  readonly changes: number;
}

/** Apply the closed rename lists to one source text. */
export function rewriteSource(source: string): RewriteResult {
  let changes = 0;
  let text = source;
  for (const [from, to] of PHRASE_RENAMES) {
    const parts = text.split(from);
    changes += parts.length - 1;
    text = parts.join(to);
  }
  text = text.replace(SPECIFIER_PATTERN, (_match, lead: string, quote: string, specifier: string) => {
    changes += 1;
    return `${lead}${quote}${SPECIFIER_RENAMES.get(specifier)}${quote}`;
  });
  text = text.replace(IDENTIFIER, (token) => {
    const renamed = IDENTIFIER_RENAMES.get(token);
    if (renamed === undefined) return token;
    changes += 1;
    return renamed;
  });
  return { text, changes };
}

export interface ManualSite {
  readonly line: number;
  readonly name: string;
  readonly guidance: string;
}

const isIdentifierChar = (char: string | undefined): boolean => char !== undefined && /[\w$]/.test(char);

/** The structural sites in a source text, one per (line, phrase). */
export function findManualSites(source: string): ManualSite[] {
  const sites: ManualSite[] = [];
  source.split("\n").forEach((line, index) => {
    for (const [phrase, guidance] of MANUAL_SITES) {
      let from = line.indexOf(phrase);
      while (from !== -1) {
        const bounded =
          !(isIdentifierChar(phrase[0]) && isIdentifierChar(line[from - 1])) &&
          !(isIdentifierChar(phrase.at(-1)) && isIdentifierChar(line[from + phrase.length]));
        if (bounded) {
          sites.push({ line: index + 1, name: phrase, guidance });
          break;
        }
        from = line.indexOf(phrase, from + 1);
      }
    }
  });
  return sites;
}

export interface PropertyDiagnostic {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly property: string;
}

// `file(line,col): error TS2339: Property 'pglite' ...` (plain) or `file:line:col - error TS2339: ...` (pretty).
const DIAGNOSTIC =
  /^(.+?)(?:\((\d+),(\d+)\)|:(\d+):(\d+)) ?[:-] ?error TS(?:2339|2551|2353|2561): (?:Property|Object literal may only specify known properties, and) '([\w$]+)'/;

/** The "unknown property" diagnostics of a typecheck log that name a {@link TYPECHECK_PROPERTY_RENAMES} key. */
export function parseTypecheckLog(log: string): PropertyDiagnostic[] {
  const diagnostics: PropertyDiagnostic[] = [];
  // A file shared by several projects is reported once per project; keep each position once.
  const seen = new Set<string>();
  for (const raw of log.split("\n")) {
    // oxlint-disable-next-line no-control-regex -- strips ANSI colour codes from a pretty tsc log
    const match = DIAGNOSTIC.exec(raw.replace(/\u001b\[[0-9;]*m/g, "").trim());
    if (!match) continue;
    const property = match[6] ?? "";
    if (!TYPECHECK_PROPERTY_RENAMES.has(property)) continue;
    const diagnostic = {
      file: match[1] ?? "",
      line: Number(match[2] ?? match[4]),
      column: Number(match[3] ?? match[5]),
      property,
    };
    const key = `${diagnostic.file}:${diagnostic.line}:${diagnostic.column}`;
    if (seen.has(key)) continue;
    seen.add(key);
    diagnostics.push(diagnostic);
  }
  return diagnostics;
}

/**
 * Rename the property at each diagnostic's position in one source text. A member access or key is renamed
 * in place; a shorthand property keeps its local binding (`{ pglite }` -> `{ pgwasm: pglite }`). A position
 * that doesn't hold the property name is left alone and counted as skipped.
 */
export function applyPropertyFixes(
  source: string,
  diagnostics: readonly Pick<PropertyDiagnostic, "line" | "column" | "property">[],
): RewriteResult & { readonly skipped: number } {
  const lines = source.split("\n");
  let changes = 0;
  let skipped = 0;
  // Right to left within a line, so earlier columns stay valid.
  const ordered = [...diagnostics].sort((a, b) => a.line - b.line || b.column - a.column);
  for (const { line, column, property } of ordered) {
    const text = lines[line - 1];
    const renamed = TYPECHECK_PROPERTY_RENAMES.get(property);
    const at = column - 1;
    if (text === undefined || renamed === undefined || text.slice(at, at + property.length) !== property) {
      skipped += 1;
      continue;
    }
    const before = text.slice(0, at);
    const after = text.slice(at + property.length);
    if (/[\w$]$/.test(before) || /^[\w$]/.test(after)) {
      skipped += 1;
      continue;
    }
    const isMember = /\??\.\s*$/.test(before);
    const isKey = /^\s*[:?]/.test(after) || /^\s*\(/.test(after);
    const replacement = isMember || isKey ? renamed : `${renamed}: ${property}`;
    lines[line - 1] = `${before}${replacement}${after}`;
    changes += 1;
  }
  return { text: lines.join("\n"), changes, skipped };
}

function collectFiles(target: string, into: string[]): void {
  const stats = statSync(target);
  if (stats.isFile()) {
    if (SOURCE_EXTENSIONS.has(path.extname(target))) into.push(target);
    return;
  }
  for (const entry of readdirSync(target)) {
    if (SKIPPED_DIRECTORIES.has(entry)) continue;
    collectFiles(path.join(target, entry), into);
  }
}

function main(argv: readonly string[]): void {
  const write = argv.includes("--write");
  const logIndex = argv.indexOf("--typecheck-log");
  const logPath = logIndex === -1 ? undefined : argv[logIndex + 1];
  const targets = argv.filter((arg, index) => !arg.startsWith("--") && (logIndex === -1 || index !== logIndex + 1));
  if (targets.length === 0) {
    console.error("usage: bun scripts/codemods/pgwasm-rename.ts [--write] [--typecheck-log <log>] <path>...");
    process.exit(2);
  }
  const files: string[] = [];
  for (const target of targets) collectFiles(path.resolve(target), files);
  const inScope = new Set(files);

  let changedFiles = 0;
  let totalChanges = 0;
  if (logPath !== undefined) {
    const byFile = new Map<string, PropertyDiagnostic[]>();
    for (const diagnostic of parseTypecheckLog(readFileSync(logPath, "utf8"))) {
      const file = path.resolve(diagnostic.file);
      if (!inScope.has(file)) continue;
      byFile.set(file, [...(byFile.get(file) ?? []), diagnostic]);
    }
    for (const [file, diagnostics] of byFile) {
      const result = applyPropertyFixes(readFileSync(file, "utf8"), diagnostics);
      if (result.skipped > 0) console.warn(`${file}: ${result.skipped} diagnostic position(s) skipped`);
      if (result.changes === 0) continue;
      changedFiles += 1;
      totalChanges += result.changes;
      if (write) writeFileSync(file, result.text);
      console.log(`${file}: ${result.changes} propert${result.changes === 1 ? "y" : "ies"}`);
    }
  } else {
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      const result = rewriteSource(source);
      for (const site of findManualSites(result.text)) {
        console.log(`${file}:${site.line}: manual: ${site.name} — ${site.guidance}`);
      }
      if (result.changes === 0) continue;
      changedFiles += 1;
      totalChanges += result.changes;
      if (write) writeFileSync(file, result.text);
    }
  }
  console.log(`${write ? "rewrote" : "would rewrite"} ${totalChanges} site(s) in ${changedFiles} file(s)`);
}

if (import.meta.main) main(process.argv.slice(2));
