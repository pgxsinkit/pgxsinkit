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
// - IMPORTED_BINDING_RENAMES: a name imported from a listed old module (`dataDir` from the prepopulated
//   filesystem, `PGlite` from `@electric-sql/pglite`). Renamed in its import clause and, when imported under
//   its own name, at its uses in that file only (never at a member access or an object/type key; a shorthand
//   property keeps its key). `import { dataDir as x }` renames the imported name only.
// - MANUAL_SITES / MANUAL_PATTERNS: sites whose replacement is structural, not a rename (e.g.
//   `pgliteBootAssets` becomes `build: createCBuild({ assets })`, `new PGlite(` becomes `createPgwasm(...)`,
//   `drizzle({ connection })` needs a database passed in). They are reported with their guidance and never
//   rewritten. So is an old package name left outside an import position (a Vite `optimizeDeps` list).
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

/** A name imported from an old module whose import (and, unaliased, its uses) is renamed. */
export interface ImportedBindingRename {
  /** The old module the name is imported from. */
  readonly specifier: string;
  readonly from: string;
  readonly to: string;
  /** A use left alone (a structural site, reported instead), given the text around it. */
  readonly keep?: (before: string, after: string) => boolean;
}

export const IMPORTED_BINDING_RENAMES: readonly ImportedBindingRename[] = [
  { specifier: "@electric-sql/pglite-prepopulatedfs", from: "dataDir", to: "prepopulatedDataDir" },
  {
    specifier: "@electric-sql/pglite",
    from: "PGlite",
    to: "Pgwasm",
    // `new PGlite(` / `PGlite.create(` become `createPgwasm({ build: cBuild, ... })`: see MANUAL_SITES.
    keep: (before, after) => /\bnew\s*$/.test(before) || /^\s*\.\s*create\b/.test(after),
  },
];

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

const DRIZZLE_OWN_DATABASE =
  "@pgxsinkit/pgwasm/drizzle never opens its own database: create it with `createPgwasm({ build: cBuild, ... })` " +
  "and pass it, `drizzle(pg, config)` or `drizzle({ client: pg, ...config })`";

/** Structural sites found by a pattern over the whole text (a call can span lines). */
export const MANUAL_PATTERNS: readonly {
  readonly name: string;
  readonly pattern: RegExp;
  readonly guidance: string;
}[] = [
  {
    name: "drizzle({ connection",
    pattern: /\bdrizzle\s*\(\s*\{[^()]*?\bconnection\s*[:,}]/g,
    guidance: DRIZZLE_OWN_DATABASE,
  },
  { name: 'drizzle("…")', pattern: /\bdrizzle\s*\(\s*['"`]/g, guidance: DRIZZLE_OWN_DATABASE },
  { name: "drizzle()", pattern: /\bdrizzle\s*\(\s*\)/g, guidance: DRIZZLE_OWN_DATABASE },
];

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

// An old package name in quotes, with the module-specifier lead when it has one (so those can be skipped).
const PACKAGE_NAME_PATTERN = new RegExp(
  `${SPECIFIER_LEAD}?(['"])(@electric-sql/[^'"\\s]+|${[...SPECIFIER_RENAMES.keys()].map(escapeRegExp).join("|")})\\2`,
  "g",
);

/** Rename `from` to `to` in each import clause from `specifier`; say whether it was imported unaliased. */
function renameImportClauses(
  text: string,
  { specifier, from, to }: ImportedBindingRename,
): { text: string; changes: number; unaliased: boolean } {
  let changes = 0;
  let unaliased = false;
  const clause = new RegExp(
    String.raw`\bimport\s+(?:type\s+)?\{([^}]*)\}\s*from\s*(['"])${escapeRegExp(specifier)}\2`,
    "g",
  );
  // The imported name: not an alias (`x as dataDir`), and not inside a longer identifier.
  const member = new RegExp(
    String.raw`(?<![\w$])(?<!\bas\s+)${escapeRegExp(from)}(?![\w$])(\s+as\s+[A-Za-z_$][\w$]*)?`,
    "g",
  );
  const rewritten = text.replace(clause, (whole: string, members: string) => {
    const renamed = members.replace(member, (_name: string, alias: string | undefined) => {
      changes += 1;
      if (alias === undefined) unaliased = true;
      return `${to}${alias ?? ""}`;
    });
    return whole.replace(`{${members}}`, `{${renamed}}`);
  });
  return { text: rewritten, changes, unaliased };
}

/** Rename a module-level binding at its uses: not a member access, not a key; a shorthand keeps its key. */
function renameUses(text: string, { from, to, keep }: ImportedBindingRename): { text: string; changes: number } {
  let changes = 0;
  const token = new RegExp(String.raw`(?<![\w$])${escapeRegExp(from)}(?![\w$])`, "g");
  const rewritten = text.replace(token, (name: string, offset: number) => {
    const before = text.slice(Math.max(0, offset - 200), offset);
    const after = text.slice(offset + name.length, offset + name.length + 200);
    if (/(?<!\.)\.\s*$/.test(before) || keep?.(before, after)) return name;
    const previous = before.trimEnd().at(-1);
    const keyPosition = previous === "{" || previous === "," || previous === ";";
    if (keyPosition && /^\s*\??:/.test(after)) return name;
    changes += 1;
    const shorthand =
      (previous === "{" || previous === ",") &&
      /^\s*[,}]/.test(after) &&
      !/\b(?:export|import)\s+(?:type\s+)?\{[^{}]*$/.test(before);
    return shorthand ? `${name}: ${to}` : to;
  });
  return { text: rewritten, changes };
}

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
  // Before the specifier rewrite: the clauses are found by their old module.
  for (const rename of IMPORTED_BINDING_RENAMES) {
    const clauses = renameImportClauses(text, rename);
    text = clauses.text;
    changes += clauses.changes;
    if (!clauses.unaliased) continue;
    const uses = renameUses(text, rename);
    text = uses.text;
    changes += uses.changes;
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

function strayPackageGuidance(name: string): string {
  const replacement =
    name === "@electric-sql/pglite" ? '"@pgxsinkit/pgwasm" (and "@pgxsinkit/pgwasm-c")' : SPECIFIER_RENAMES.get(name);
  return (
    "an old package name outside an import (e.g. a Vite `optimizeDeps` list): " +
    (replacement === undefined
      ? "replace or remove it by hand"
      : `use ${replacement.startsWith('"') ? replacement : `"${replacement}"`}`)
  );
}

const lineAt = (source: string, index: number): number => source.slice(0, index).split("\n").length;

/** The structural sites in a source text, one per (line, name), in line order. */
export function findManualSites(source: string): ManualSite[] {
  const found: ManualSite[] = [];
  for (const match of source.matchAll(PACKAGE_NAME_PATTERN)) {
    if (match[1] !== undefined) continue;
    const name = match[3] ?? "";
    // At the quote, not at the lead the pattern may have tried.
    found.push({ line: lineAt(source, match.index), name: `"${name}"`, guidance: strayPackageGuidance(name) });
  }
  for (const { name, pattern, guidance } of MANUAL_PATTERNS) {
    for (const match of source.matchAll(pattern)) found.push({ line: lineAt(source, match.index), name, guidance });
  }
  source.split("\n").forEach((line, index) => {
    for (const [phrase, guidance] of MANUAL_SITES) {
      let from = line.indexOf(phrase);
      while (from !== -1) {
        const bounded =
          !(isIdentifierChar(phrase[0]) && isIdentifierChar(line[from - 1])) &&
          !(isIdentifierChar(phrase.at(-1)) && isIdentifierChar(line[from + phrase.length]));
        if (bounded) {
          found.push({ line: index + 1, name: phrase, guidance });
          break;
        }
        from = line.indexOf(phrase, from + 1);
      }
    }
  });
  // One report per (line, name): an old package name outside an import keeps its own guidance.
  const seen = new Set<string>();
  const sites = found.filter(({ line, name }) => {
    const key = `${line}:${name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return sites.sort((a, b) => a.line - b.line);
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
