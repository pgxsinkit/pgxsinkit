import { describe, expect, it } from "bun:test";

import { sql, type SQL } from "drizzle-orm";
import { uuid, varchar } from "drizzle-orm/pg-core";
import { authenticatedRole } from "drizzle-orm/supabase";

import {
  assertRegistryInvariant,
  buildOwnerOrAdminShapeWhere,
  buildRowFilterShape,
  buildSupabaseOwnerOrAdminNativePolicies,
  c,
  defineSyncRegistry,
  defineSyncTable,
  DENY_ALL,
  type JwtClaims,
} from "@pgxsinkit/contracts";

// assertRegistryInvariant (ADR-0052): audit the RENDERED read filter + write policies of every entry a
// classification binds, against named claims personas. Aggregates every failing cell into one error.

// A private, owner-scoped table: RLS owner-or-admin policies, and the matching read-path mirror.
const papersSyncEntry = defineSyncTable({
  tableName: "papers",
  makeColumns: () => ({
    id: uuid("id").primaryKey(),
    ownerId: uuid("owner_id").notNull(),
    title: varchar("title", { length: 120 }).notNull(),
  }),
  extras: (t) => buildSupabaseOwnerOrAdminNativePolicies({ role: authenticatedRole, ownerColumn: t.ownerId }),
  rowClass: "private",
  shape: {
    rowFilter: (columns) => ({
      customWhere: (claims): SQL | null => buildOwnerOrAdminShapeWhere(columns.ownerId, claims),
    }),
  },
});

// A second private table, deliberately LEAKY for an anonymous caller (its filter denies nobody) — the
// fixture the aggregation test needs.
const draftsSyncEntry = defineSyncTable({
  tableName: "drafts",
  makeColumns: () => ({
    id: uuid("id").primaryKey(),
    ownerId: uuid("owner_id").notNull(),
    body: varchar("body", { length: 200 }).notNull(),
  }),
  rowClass: "private",
  shape: {
    rowFilter: (columns) => ({
      customWhere: (claims): SQL | null => (claims.sub ? sql`${c(columns.ownerId)} = ${claims.sub}` : null),
    }),
  },
});

// Reference data: visible to everyone, classified apart so no privacy invariant binds it.
const tagsSyncEntry = defineSyncTable({
  tableName: "tags",
  makeColumns: () => ({ id: uuid("id").primaryKey(), label: varchar("label", { length: 40 }).notNull() }),
  rowClass: "reference",
});

const registry = defineSyncRegistry({
  rowClasses: ["private", "reference"],
  tables: { papers: papersSyncEntry, tags: tagsSyncEntry },
});

const leakyRegistry = defineSyncRegistry({
  rowClasses: ["private", "reference"],
  tables: { papers: papersSyncEntry, drafts: draftsSyncEntry, tags: tagsSyncEntry },
});

const anonymous: JwtClaims = {};
const owner: JwtClaims = { sub: "11111111-1111-1111-1111-111111111111" };
const admin: JwtClaims = { sub: "22222222-2222-2222-2222-222222222222", app_metadata: { roles: ["admin"] } };

/** The invariant under test throughout: an anonymous caller sees no `private` row. */
const deniesAnonymousReads = (cell: { fixtureName: string; renderedWhere: { where: string } | null }) =>
  cell.fixtureName !== "anonymous" || cell.renderedWhere?.where === "false" || "anonymous read is not denied";

describe("assertRegistryInvariant (ADR-0052)", () => {
  it("passes when every bound entry × fixture holds", () => {
    expect(() =>
      assertRegistryInvariant(registry, {
        name: "private rows are invisible to an anonymous caller",
        appliesTo: ["private"],
        claimsFixtures: { anonymous, owner, admin },
        holds: deniesAnonymousReads,
      }),
    ).not.toThrow();
  });

  it("aggregates EVERY failing cell into one error, naming entry and fixture", () => {
    let message = "";
    try {
      assertRegistryInvariant(leakyRegistry, {
        name: "private rows are never unfiltered",
        appliesTo: ["private"],
        claimsFixtures: { anonymous, owner, admin },
        // Fails for `papers` under admin (the mirror's bypass branch returns no filter) AND for `drafts`
        // under anonymous (its filter denies nobody) — two entries, two different fixtures, one error.
        holds: ({ renderedWhere }) => renderedWhere != null || "no row filter — every row streams",
      });
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain('registry invariant "private rows are never unfiltered" is violated');
    expect(message).toContain("papers (admin): no row filter — every row streams");
    expect(message).toContain("drafts (anonymous): no row filter — every row streams");
    // Not first-failure-only: both failing cells out of the six checked are reported.
    expect(message).toContain("2 of 6 checked cells");
  });

  it("reports a bare false verdict without a reason string", () => {
    expect(() =>
      assertRegistryInvariant(registry, {
        name: "never holds",
        appliesTo: ["reference"],
        claimsFixtures: { anonymous },
        holds: () => false,
      }),
    ).toThrow(/tags \(anonymous\): invariant does not hold/);
  });

  it("accepts a predicate form of appliesTo", () => {
    const seen: string[] = [];
    assertRegistryInvariant(registry, {
      name: "predicate binding",
      appliesTo: (entry) => entry.mode === "readonly",
      claimsFixtures: { anonymous },
      holds: ({ key }) => {
        seen.push(key);
        return true;
      },
    });

    expect(seen.sort()).toEqual(["papers", "tags"]);
  });

  it("throws on a class the registry's declared vocabulary does not contain", () => {
    expect(() =>
      assertRegistryInvariant(registry, {
        name: "typo",
        appliesTo: ["privat"],
        claimsFixtures: { anonymous },
        holds: () => true,
      }),
    ).toThrow(/applies to unknown row class\(es\): privat/);
  });

  it("throws when the invariant binds zero entries", () => {
    // Same typo against a registry that declares NO vocabulary: nothing to typo-check against, so the
    // zero-binding guard is what catches it.
    const undeclared = defineSyncRegistry({ tables: { papers: papersSyncEntry, tags: tagsSyncEntry } });
    expect(() =>
      assertRegistryInvariant(undeclared, {
        name: "binds nothing",
        appliesTo: ["privat"],
        claimsFixtures: { anonymous },
        holds: () => true,
      }),
    ).toThrow(/binds no entries \(row class\(es\) privat\)/);
  });

  it("renders the read filter through the real pipeline, per fixture", () => {
    const rendered = new Map<string, { where: string; params: string[] } | null>();
    assertRegistryInvariant(registry, {
      name: "capture rendered where",
      appliesTo: ["private"],
      claimsFixtures: { anonymous, owner, admin },
      holds: ({ fixtureName, renderedWhere }) => {
        rendered.set(fixtureName, renderedWhere);
        return true;
      },
    });

    const rowFilter = papersSyncEntry.shape!.rowFilter!;
    expect(rendered.get("owner")).toEqual(buildRowFilterShape(rowFilter, owner));
    expect(rendered.get("owner")).toEqual({ where: '"owner_id" = $1', params: [owner.sub!] });
    // The mirror's deny sentinel and its admin bypass, as the client would receive them.
    expect(rendered.get("anonymous")).toEqual(buildRowFilterShape(rowFilter, anonymous));
    expect(rendered.get("anonymous")?.where).toBe("false");
    expect(rendered.get("admin")).toBeNull();
    // An entry with no rowFilter at all also renders null (unfiltered).
    expect(buildRowFilterShape({ customWhere: () => DENY_ALL }, anonymous)?.where).toBe("false");
  });

  it("exposes the table's RLS policies, rendered to inline SQL", () => {
    let policies: Array<{ name: string; command: string; using: string | null; withCheck: string | null }> = [];
    assertRegistryInvariant(registry, {
      name: "capture rendered policies",
      appliesTo: ["private"],
      claimsFixtures: { anonymous },
      holds: ({ renderedPolicies }) => {
        policies = renderedPolicies;
        return true;
      },
    });

    expect(policies.map((policy) => `${policy.name}:${policy.command}`)).toEqual([
      "papers_select_owner_or_admin:select",
      "papers_insert_owner_or_admin:insert",
      "papers_update_owner_or_admin:update",
      "papers_delete_owner_or_admin:delete",
    ]);

    const select = policies[0]!;
    expect(select.withCheck).toBeNull();
    expect(select.using).toContain('"papers"."owner_id" =');
    // Values are INLINED (a `$n` bind is something CREATE POLICY cannot carry).
    expect(select.using).toContain("'admin'");
    expect(select.using).not.toContain("$1");

    const insert = policies[1]!;
    expect(insert.using).toBeNull();
    expect(insert.withCheck).toContain('"papers"."owner_id" =');
  });

  it("checks a table with no policies as an empty policy list", () => {
    assertRegistryInvariant(registry, {
      name: "unpoliced reference data",
      appliesTo: ["reference"],
      claimsFixtures: { anonymous },
      holds: ({ renderedPolicies, renderedWhere }) => renderedPolicies.length === 0 && renderedWhere === null,
    });
  });
});
