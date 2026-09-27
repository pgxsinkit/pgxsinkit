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

  it("is idempotent", () => {
    expect(rewriteSource(AFTER)).toEqual({ text: AFTER, changes: 0 });
  });

  it("leaves a local `pglite`, longer identifiers, other specifiers and the word PGlite alone", () => {
    const source = [
      "const pglite = await createPgliteFactory(myClientPGliteish);",
      'import { PGlite } from "@electric-sql/pglite";',
      'import "@electric-sql/pglite/live/extra";',
      "// Began as a copy of PGlite's tests.",
      "const key = 'pglite-opfs-repacked';",
    ].join("\n");
    expect(rewriteSource(source)).toEqual({ text: source, changes: 0 });
  });

  it("renames a whole token even when it sits next to punctuation", () => {
    expect(rewriteSource("x.pgliteInstance?.y;(ClientPGlite)").text).toBe("x.pgwasmInstance?.y;(PgwasmClient)");
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

describe("typecheck-driven property fixes", () => {
  it("parses plain and pretty tsc diagnostics that name a renamed property", () => {
    const log = [
      "tests/a.test.ts(3,10): error TS2339: Property 'pglite' does not exist on type 'SyncClient'.",
      "\u001b[96mtests/b.tsx\u001b[0m:\u001b[93m7\u001b[0m:\u001b[93m5\u001b[0m - error TS2353: Object literal may only specify known properties, and 'pglite' does not exist in type 'Options'.",
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
