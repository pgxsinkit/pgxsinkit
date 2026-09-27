// The PGlite -> pgwasm rename codemod (pgwasm step 3, B4; step 4 runs it over emergent). Fixture-driven:
// each case is a source text before and after, so the closed lists' reach — and their limits — are pinned.

import { describe, expect, it } from "bun:test";

import {
  applyPropertyFixes,
  findManualSites,
  IDENTIFIER_RENAMES,
  parseTypecheckLog,
  rewriteSource,
} from "../../scripts/codemods/pgwasm-rename";

const BEFORE = `import type { PGliteWithLive } from "@electric-sql/pglite/live";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { createOpfsRepackedPGlite, type OpfsRepackedPGlite } from "@pgxsinkit/pglite-opfs-repacked";
import { type ClientPGlite, createClientPGlite } from "@pgxsinkit/client";

/** Hands {@link createClientPGlite}'s store to {@link CreateSyncClientOptions.precreatedPglite}. */
export async function boot(pglite: ClientPGlite, report: BootReport) {
  const store = createClientPGlite("app", {});
  const options = { precreatedPglite: store, pgliteInstance: undefined, createPglite: open };
  syncDebug("boot pglite.create phase", { phase: "pglite-ready" });
  console.log(report.phases.pgliteCreateMs, pglite.live);
  return import("@electric-sql/pglite-repl");
}
`;

const AFTER = `import type { PgwasmWithLive } from "@pgxsinkit/pgwasm/live";
import { drizzle, type PgwasmDatabase } from "@pgxsinkit/pgwasm/drizzle";
import { createOpfsPgwasm, type OpfsPgwasm } from "@pgxsinkit/pgwasm/opfs";
import { type PgwasmClient, createPgwasmClient } from "@pgxsinkit/client";

/** Hands {@link createPgwasmClient}'s store to {@link CreateSyncClientOptions.precreatedPgwasm}. */
export async function boot(pglite: PgwasmClient, report: BootReport) {
  const store = createPgwasmClient("app", {});
  const options = { precreatedPgwasm: store, pgwasmInstance: undefined, createStore: open };
  syncDebug("boot pgwasm.create phase", { phase: "pgwasm-ready" });
  console.log(report.phases.pgwasmCreateMs, pglite.live);
  return import("@pgxsinkit/pgwasm-repl");
}
`;

describe("rewriteSource — the closed rename lists", () => {
  it("renames the listed identifiers, specifiers and rail phrases", () => {
    const result = rewriteSource(BEFORE);
    expect(result.text).toBe(AFTER);
    expect(result.changes).toBe(20);
  });

  it("rewrites a specifier in every module-specifier position, and only there", () => {
    const source = [
      'export * from "drizzle-orm/pglite";',
      "await import('@electric-sql/pglite/live');",
      'mock.module("@pgxsinkit/pglite-opfs-repacked", () => ({}));',
      'const repl = require("@electric-sql/pglite-repl");',
    ].join("\n");
    expect(rewriteSource(source).text).toBe(
      [
        'export * from "@pgxsinkit/pgwasm/drizzle";',
        "await import('@pgxsinkit/pgwasm/live');",
        'mock.module("@pgxsinkit/pgwasm/opfs", () => ({}));',
        'const repl = require("@pgxsinkit/pgwasm-repl");',
      ].join("\n"),
    );
  });

  it("is idempotent", () => {
    expect(rewriteSource(AFTER)).toEqual({ text: AFTER, changes: 0 });
  });

  it("leaves a local `pglite`, longer identifiers, other specifiers and the word PGlite alone", () => {
    const source = [
      "const pglite = await createPgliteFactory(myClientPGliteish);",
      "const db = PGlite;",
      'import "@electric-sql/pglite/live/extra";',
      "// Began as a copy of PGlite's tests.",
      "const key = 'pglite-opfs-repacked';",
      'const pin = { package: "@electric-sql/pglite-prepopulatedfs" };',
      "// Began as a copy of `@electric-sql/pglite-repl`.",
    ].join("\n");
    expect(rewriteSource(source)).toEqual({ text: source, changes: 0 });
  });

  it("renames a whole token even when it sits next to punctuation", () => {
    expect(rewriteSource("x.pgliteInstance?.y;(ClientPGlite)").text).toBe("x.pgwasmInstance?.y;(PgwasmClient)");
  });

  it("renames the prepopulated filesystem's `dataDir` with its import, at its uses only", () => {
    const source = [
      'import { dataDir } from "@electric-sql/pglite-prepopulatedfs";',
      "const blob = await dataDir();",
      'const options = { loadDataDir: await dataDir(), dataDir: "idb://app" };',
      "const fromConfig = config.dataDir ?? config?.dataDir;",
      "const load = { dataDir };",
      "const pick = ready ? dataDir : other;",
    ].join("\n");
    const result = rewriteSource(source);
    expect(result).toEqual({
      text: [
        'import { prepopulatedDataDir } from "@pgxsinkit/pgwasm-c/prepopulated";',
        "const blob = await prepopulatedDataDir();",
        'const options = { loadDataDir: await prepopulatedDataDir(), dataDir: "idb://app" };',
        "const fromConfig = config.dataDir ?? config?.dataDir;",
        "const load = { dataDir: prepopulatedDataDir };",
        "const pick = ready ? prepopulatedDataDir : other;",
      ].join("\n"),
      changes: 6,
    });
    expect(rewriteSource(result.text).changes).toBe(0);
  });

  it("renames only the imported name of an aliased `dataDir`, and no `dataDir` from elsewhere", () => {
    const aliased = [
      'import { dataDir as basePrepopulatedDataDir } from "@electric-sql/pglite-prepopulatedfs";',
      "const blob = await basePrepopulatedDataDir();",
      'const other = { dataDir: "idb://app" }; open(dataDir);',
    ].join("\n");
    expect(rewriteSource(aliased)).toEqual({
      text: aliased.replace(
        'dataDir as basePrepopulatedDataDir } from "@electric-sql/pglite-prepopulatedfs"',
        'prepopulatedDataDir as basePrepopulatedDataDir } from "@pgxsinkit/pgwasm-c/prepopulated"',
      ),
      changes: 2,
    });
    const elsewhere = ['import { dataDir } from "./paths";', "open(dataDir);"].join("\n");
    expect(rewriteSource(elsewhere)).toEqual({ text: elsewhere, changes: 0 });
  });

  it("renames `PGlite` where it is imported from @electric-sql/pglite, leaving its construction sites", () => {
    const source = [
      "import {",
      "  PGlite,",
      "  type Results,",
      '} from "@electric-sql/pglite";',
      "",
      "// Hands a PGlite to the store.",
      "export async function open(pg: PGlite): Promise<PGlite> {",
      "  const db = await PGlite.create({ dataDir: 'idb://app' });",
      "  const other = new PGlite();",
      "  return pg.PGlite ?? db ?? other;",
      "}",
    ].join("\n");
    const result = rewriteSource(source);
    expect(result).toEqual({
      text: [
        "import {",
        "  Pgwasm,",
        "  type Results,",
        '} from "@electric-sql/pglite";',
        "",
        "// Hands a Pgwasm to the store.",
        "export async function open(pg: Pgwasm): Promise<Pgwasm> {",
        "  const db = await PGlite.create({ dataDir: 'idb://app' });",
        "  const other = new PGlite();",
        "  return pg.PGlite ?? db ?? other;",
        "}",
      ].join("\n"),
      changes: 4,
    });
    expect(rewriteSource(result.text).changes).toBe(0);
    // The construction sites are reported for a hand edit to createPgwasm({ build: cBuild, ... }).
    expect(findManualSites(result.text).map(({ line, name }) => `${line}:${name}`)).toEqual([
      '4:"@electric-sql/pglite"',
      "8:PGlite.create",
      "9:new PGlite",
    ]);
  });

  it("renames only the imported name of an aliased `PGlite`", () => {
    const source = ['import type { PGlite as Db } from "@electric-sql/pglite";', "let db: Db | typeof PGlite;"].join(
      "\n",
    );
    expect(rewriteSource(source)).toEqual({ text: source.replace("{ PGlite as Db }", "{ Pgwasm as Db }"), changes: 1 });
  });

  it("only maps old names to new ones that are not themselves renamed", () => {
    for (const to of IDENTIFIER_RENAMES.values()) expect(IDENTIFIER_RENAMES.has(to)).toBe(false);
  });
});

describe("findManualSites — structural replacements are reported, never rewritten", () => {
  it("reports each phrase once per line, at identifier boundaries only", () => {
    const source = [
      "createSyncClient({ pgliteBootAssets: warm() });",
      "createClientPGlite(path, { bootAssets: warm() });",
      "const db = await PGlite.create();",
      "const other = new PGlite();",
      "const notIt = renewPGliteish;",
      "instance.strictSync();",
    ].join("\n");
    expect(findManualSites(source).map(({ line, name }) => `${line}:${name}`)).toEqual([
      "1:pgliteBootAssets",
      "2:bootAssets",
      "3:PGlite.create",
      "4:new PGlite",
      "6:.strictSync()",
    ]);
  });
});

describe("findManualSites — old package names and drizzle's own-database forms", () => {
  it("reports an old package name outside an import position, and leaves imports to the rewrite", () => {
    const source = [
      'import { PGlite } from "@electric-sql/pglite";',
      "export default defineConfig({",
      '  optimizeDeps: { exclude: ["@electric-sql/pglite", "@electric-sql/pglite-repl"] },',
      "});",
      'for (const pkg of ["@electric-sql/pglite-prepopulatedfs", "drizzle-kit"]) check(pkg);',
      "const worker = '@electric-sql/pglite/worker';",
      'import "@electric-sql/pglite/live";',
      'const repl = await import("@electric-sql/pglite-repl");',
    ].join("\n");
    const sites = findManualSites(source);
    expect(sites.map(({ line, name }) => `${line}:${name}`)).toEqual([
      '1:"@electric-sql/pglite"',
      '3:"@electric-sql/pglite"',
      '3:"@electric-sql/pglite-repl"',
      '5:"@electric-sql/pglite-prepopulatedfs"',
      '6:"@electric-sql/pglite/worker"',
    ]);
    const guidance = sites.map((site) => site.guidance);
    expect(guidance[0]).toContain("import `createPgwasm`");
    expect(guidance[1]).toContain('optimizeDeps` list): use "@pgxsinkit/pgwasm" (and "@pgxsinkit/pgwasm-c")');
    expect(guidance[2]).toContain('use "@pgxsinkit/pgwasm-repl"');
    expect(guidance[3]).toContain('use "@pgxsinkit/pgwasm-c/prepopulated"');
    expect(guidance[4]).toContain("replace or remove it by hand");
    // Rewriting leaves the non-import names in place, so they are still reported afterwards.
    expect(rewriteSource(source).text.split("\n").slice(2, 6)).toEqual(source.split("\n").slice(2, 6));
  });

  it('reports drizzle({ connection }), drizzle("…") and drizzle(), never the forms with a client', () => {
    const source = [
      'const a = drizzle({ connection: "idb://app" });',
      "const b = drizzle({",
      "  logger: true,",
      "  connection: { dataDir: 'idb://app' },",
      "});",
      "const c = drizzle('postgres://localhost/app');",
      "const d = drizzle();",
      "const e = drizzle({ client: pg, logger: true });",
      "const f = drizzle(pg, { relations });",
      "const g = drizzle.mock();",
    ].join("\n");
    const sites = findManualSites(source);
    expect(sites.map(({ line, name }) => `${line}:${name}`)).toEqual([
      "1:drizzle({ connection",
      "2:drizzle({ connection",
      '6:drizzle("…")',
      "7:drizzle()",
    ]);
    for (const site of sites) expect(site.guidance).toContain("drizzle({ client: pg, ...config })");
  });
});

describe("typecheck-driven property fixes", () => {
  it("parses plain and pretty tsc diagnostics that name a renamed property, each position once", () => {
    const log = [
      "tests/a.test.ts(3,10): error TS2339: Property 'pglite' does not exist on type 'SyncClient'.",
      "\u001b[96mtests/b.tsx\u001b[0m:\u001b[93m7\u001b[0m:\u001b[93m5\u001b[0m - error TS2353: Object literal may only specify known properties, and 'pglite' does not exist in type 'Options'.",
      "tests/a.test.ts(3,10): error TS2339: Property 'pglite' does not exist on type 'SyncClient'.",
      "tests/c.ts(1,1): error TS2339: Property 'other' does not exist on type 'X'.",
      "tests/d.ts(2,2): error TS2322: Type 'string' is not assignable to type 'number'.",
    ].join("\n");
    expect(parseTypecheckLog(log)).toEqual([
      { file: "tests/a.test.ts", line: 3, column: 10, property: "pglite" },
      { file: "tests/b.tsx", line: 7, column: 5, property: "pglite" },
    ]);
  });

  it("renames a member access and a key in place, and keeps a shorthand's local binding", () => {
    const source = [
      "const rows = await client.pglite.query(sql);",
      "useLiveRows(q, [], { pglite });",
      "const { pglite, ready } = client;",
      "const options = { pglite: store, other: 1 };",
      "client?.pglite; client.pglite;",
    ].join("\n");
    const diagnostics = [
      { line: 1, column: 27, property: "pglite" },
      { line: 2, column: 22, property: "pglite" },
      { line: 3, column: 9, property: "pglite" },
      { line: 4, column: 19, property: "pglite" },
      { line: 5, column: 9, property: "pglite" },
      { line: 5, column: 24, property: "pglite" },
    ];
    const result = applyPropertyFixes(source, diagnostics);
    expect(result.text).toBe(
      [
        "const rows = await client.pgwasm.query(sql);",
        "useLiveRows(q, [], { pgwasm: pglite });",
        "const { pgwasm: pglite, ready } = client;",
        "const options = { pgwasm: store, other: 1 };",
        "client?.pgwasm; client.pgwasm;",
      ].join("\n"),
    );
    expect(result).toMatchObject({ changes: 6, skipped: 0 });
  });

  it("skips a position that does not hold the property name", () => {
    const result = applyPropertyFixes("const x = pgliteStore;", [{ line: 1, column: 11, property: "pglite" }]);
    expect(result).toEqual({ text: "const x = pgliteStore;", changes: 0, skipped: 1 });
  });
});
