import { describe, expect, it } from "bun:test";

import type { SQL } from "drizzle-orm";
import { PgDialect, pgRole, pgTable, uuid, type AnyPgTable } from "drizzle-orm/pg-core";

import {
  buildGrantScopeAccessShapeWhere,
  buildGrantScopeShapeWhere,
  buildSupabaseGrantScopeNativePolicies,
  DENY_ALL,
  isClaimsDependentRowFilter,
  resolveGrantScopeAccess,
  resolveGrantScopeIds,
  type GrantScopeAccessOptions,
  type JwtClaims,
} from "@pgxsinkit/contracts";

type NativePolicy = {
  name: string;
  for: string;
  using?: unknown;
  withCheck?: unknown;
};

function normalizeSqlText(sqlText: string): string {
  return sqlText.replace(/\s+/g, " ").trim();
}

const dialect = new PgDialect();
function renderSql(fragment: unknown): string | null {
  return fragment ? normalizeSqlText(dialect.sqlToQuery(fragment as SQL).sql) : null;
}

// Drizzle stashes the `extras` callback's pgPolicy array under an ExtraConfigBuilder symbol.
function readTablePolicies(table: AnyPgTable): NativePolicy[] {
  const symbol = Object.getOwnPropertySymbols(table).find((s) => s.description?.includes("ExtraConfigBuilder"));
  const builder = symbol ? (table as unknown as Record<symbol, (t: AnyPgTable) => unknown>)[symbol] : undefined;
  const extras = typeof builder === "function" ? builder(table) : undefined;
  const list = Array.isArray(extras) ? extras : Object.values(extras ?? {});
  return list.filter(
    (entry): entry is NativePolicy => typeof entry === "object" && entry !== null && "for" in entry && "name" in entry,
  );
}

function byCommand(table: AnyPgTable) {
  return Object.fromEntries(
    readTablePolicies(table).map((policy) => [
      policy.for,
      { name: policy.name, using: renderSql(policy.using), withCheck: renderSql(policy.withCheck) },
    ]),
  );
}

const teacherRoles = ["teacher", "assistant", "observer", "mentor"];

describe("contracts grant-scope RLS helpers", () => {
  it("builds the InitPlan-correct uncorrelated IN(subquery) policy from a real column", () => {
    const role = pgRole("authenticated");
    const enrolments = pgTable(
      "enrolments",
      {
        id: uuid("id").primaryKey(),
        offeringId: uuid("offering_id").notNull(),
      },
      (t) =>
        buildSupabaseGrantScopeNativePolicies({
          role,
          scopeColumn: t.offeringId,
          scopeKind: "offering",
          roleValues: teacherRoles,
        }),
    );

    const policies = byCommand(enrolments);
    const select = policies["select"];

    expect(select?.name).toBe("enrolments_select_grant_scope");
    // Governed scope column is qualified; the set is `= ANY(ARRAY(uncorrelated subquery))` so it
    // materializes once (InitPlan) and ScalarArrayOp drives a bitmap index scan (the rls-read perf
    // finding), NOT a hashed `IN (subquery)` semi-join that seq-scans.
    expect(select?.using).toContain('"enrolments"."offering_id" = any(array(select');
    expect(select?.using).toContain("jsonb_array_elements(");
    expect(select?.using).toContain("#> '{app_metadata,authorization,grants}'");
    expect(select?.using).toContain("grant_elem -> 'scope' ->> 'kind' = 'offering'");
    expect(select?.using).toContain("grant_elem ->> 'role' in ('teacher', 'assistant', 'observer', 'mentor')");
    expect(select?.using).toContain("'scope' ->> 'offeringId')::uuid");
    // Not correlated: the inner query never references the outer governed column.
    expect(select?.using).not.toContain('= "enrolments"."offering_id"');
    // Inlined literals, no bound params (CREATE POLICY cannot carry `$n`).
    expect(select?.using).not.toMatch(/\$\d/);

    // insert checks WITH CHECK only, delete USING only, update both — same command semantics as siblings.
    expect(policies["insert"]?.using).toBeNull();
    expect(policies["insert"]?.withCheck).toContain('"enrolments"."offering_id" = any(array(select');
    expect(policies["delete"]?.withCheck).toBeNull();
  });

  it("builds the naive correlated EXISTS variant for the cliff demo", () => {
    const role = pgRole("authenticated");
    const enrolments = pgTable(
      "enrolments",
      {
        id: uuid("id").primaryKey(),
        offeringId: uuid("offering_id").notNull(),
      },
      (t) =>
        buildSupabaseGrantScopeNativePolicies({
          role,
          scopeColumn: t.offeringId,
          scopeKind: "offering",
          roleValues: teacherRoles,
          naive: true,
        }),
    );

    const select = byCommand(enrolments)["select"];

    expect(select?.name).toBe("enrolments_select_grant_scope_naive");
    // Correlated: the EXISTS subquery references the outer governed column → per-row re-evaluation.
    expect(select?.using).toContain("exists (select 1 from jsonb_array_elements(");
    expect(select?.using).toContain('::uuid = "enrolments"."offering_id"');
    expect(select?.using).not.toMatch(/\$\d/);
  });

  it("ORs an uncorrelated platform bypass when requested", () => {
    const role = pgRole("authenticated");
    const enrolments = pgTable(
      "enrolments",
      {
        id: uuid("id").primaryKey(),
        offeringId: uuid("offering_id").notNull(),
      },
      (t) =>
        buildSupabaseGrantScopeNativePolicies({
          role,
          scopeColumn: t.offeringId,
          scopeKind: "offering",
          roleValues: teacherRoles,
          bypass: { roleValues: ["platform_admin"] },
        }),
    );

    const select = byCommand(enrolments)["select"];
    // Drizzle's or() renders as `(<base>) or (exists (…))`.
    expect(select?.using).toContain("or (exists (");
    expect(select?.using).toContain("bypass_grant -> 'scope' ->> 'kind' = 'platform'");
    expect(select?.using).toContain("bypass_grant ->> 'role' in ('platform_admin')");
  });

  it("resolveGrantScopeIds mirrors the policy: filters by kind + role, dedups, denies on empty", () => {
    const claims = {
      sub: "user-1",
      app_metadata: {
        authorization: {
          grants: [
            { role: "teacher", scope: { kind: "offering", offeringId: "off-a" } },
            { role: "assistant", scope: { kind: "offering", offeringId: "off-b" } },
            { role: "teacher", scope: { kind: "offering", offeringId: "off-a" } }, // duplicate
            { role: "teacher", scope: { kind: "organization", organizationId: "org-x" } }, // wrong kind
            { role: "learner", scope: { kind: "offering", offeringId: "off-c" } }, // wrong role
          ],
        },
      },
    };

    const ids = resolveGrantScopeIds(claims, { scopeKind: "offering", roleValues: teacherRoles }).sort();
    expect(ids).toEqual(["off-a", "off-b"]);

    expect(resolveGrantScopeIds(null, { scopeKind: "offering", roleValues: teacherRoles })).toEqual([]);
    expect(resolveGrantScopeIds({ sub: "x" }, { scopeKind: "offering", roleValues: teacherRoles })).toEqual([]);
  });

  it("buildGrantScopeShapeWhere emits a bare-column IN over bound ids (deny on empty)", () => {
    const enrolments = pgTable("enrolments", { offeringId: uuid("offering_id").notNull() });

    // The fragment parameterizes ids ($n bound params via buildRowFilterShape) and references the
    // column bare (Electric's grammar), rename-safe through the real column object.
    const bound = dialect.sqlToQuery(buildGrantScopeShapeWhere(enrolments.offeringId, ["off-a", "off-b"]));
    expect(normalizeSqlText(bound.sql)).toBe(`"offering_id" in ($1, $2)`);
    expect(bound.params).toEqual(["off-a", "off-b"]);

    // Rendered inline (a proxy composing a shape URL), drizzle owns the escaping — no injection.
    const inline = dialect.sqlToQuery(buildGrantScopeShapeWhere(enrolments.offeringId, ["a'b"]).inlineParams());
    expect(normalizeSqlText(inline.sql)).toBe(`"offering_id" in ('a''b')`);

    expect(dialect.sqlToQuery(buildGrantScopeShapeWhere(enrolments.offeringId, [])).sql).toBe("false");
  });
});

describe("contracts grant-scope bypass read-path mirror", () => {
  const enrolments = pgTable("enrolments", {
    id: uuid("id").primaryKey(),
    offeringId: uuid("offering_id").notNull(),
  });

  // ONE declaration, handed to both surfaces: the policy builder takes it plus the column/role, the read
  // mirror takes it verbatim. A bypass enforced on writes must be visible on reads or the surfaces drift.
  const declaration = {
    scopeKind: "offering",
    roleValues: teacherRoles,
    bypass: { roleValues: ["platform_admin"] },
  } satisfies GrantScopeAccessOptions;

  function grantClaims(grants: unknown[]): JwtClaims {
    return { sub: "user-1", app_metadata: { authorization: { grants } } } as JwtClaims;
  }

  const teacherGrant = { role: "teacher", scope: { kind: "offering", offeringId: "off-a" } };
  const bypassGrant = { role: "platform_admin", scope: { kind: "platform" } };

  it("resolveGrantScopeAccess reports the bypass branch alongside the id set", () => {
    expect(resolveGrantScopeAccess(grantClaims([teacherGrant, bypassGrant]), declaration)).toEqual({
      bypass: true,
      ids: ["off-a"],
    });

    // No bypass grant → the id set alone, exactly as resolveGrantScopeIds reports it.
    expect(resolveGrantScopeAccess(grantClaims([teacherGrant]), declaration)).toEqual({
      bypass: false,
      ids: ["off-a"],
    });

    // A bypass grant with the right role but the WRONG scope kind confers nothing (the SQL's
    // `scope ->> 'kind' = 'platform'` test), and neither does the right kind under the wrong role.
    expect(
      resolveGrantScopeAccess(grantClaims([{ role: "platform_admin", scope: { kind: "offering" } }]), declaration)
        .bypass,
    ).toBe(false);
    expect(
      resolveGrantScopeAccess(grantClaims([{ role: "teacher", scope: { kind: "platform" } }]), declaration).bypass,
    ).toBe(false);

    // Declaring no bypass can never confer one, whatever the token carries.
    expect(
      resolveGrantScopeAccess(grantClaims([bypassGrant]), { scopeKind: "offering", roleValues: teacherRoles }).bypass,
    ).toBe(false);
  });

  it("honours a custom bypass scopeKind and roleValues", () => {
    const custom = {
      scopeKind: "offering",
      roleValues: teacherRoles,
      bypass: { roleValues: ["tenant_admin", "auditor"], scopeKind: "tenant" },
    } satisfies GrantScopeAccessOptions;

    expect(resolveGrantScopeAccess(grantClaims([{ role: "auditor", scope: { kind: "tenant" } }]), custom).bypass).toBe(
      true,
    );
    // The DEFAULT platform bypass must not leak in once a custom kind is declared.
    expect(resolveGrantScopeAccess(grantClaims([bypassGrant]), custom).bypass).toBe(false);
  });

  it("never throws on malformed claims — a wrong shape simply confers nothing", () => {
    const malformed: unknown[] = [
      null,
      {},
      { app_metadata: "not-an-object" },
      { app_metadata: { authorization: { grants: "not-an-array" } } },
      grantClaims([null, 42, "grant"]),
      grantClaims([{ role: "platform_admin" }]), // no scope at all
      grantClaims([{ role: "platform_admin", scope: null }]),
      grantClaims([{ role: "platform_admin", scope: ["platform"] }]),
      grantClaims([{ role: 7, scope: { kind: "platform" } }]),
    ];

    for (const claims of malformed) {
      expect(resolveGrantScopeAccess(claims as JwtClaims, declaration)).toEqual({ bypass: false, ids: [] });
    }
  });

  it("buildGrantScopeAccessShapeWhere: bypass → null, otherwise the ids path, DENY_ALL on empty", () => {
    // Bypass → no filter at all, mirroring the policy's OR branch (every row streams).
    expect(buildGrantScopeAccessShapeWhere(enrolments.offeringId, grantClaims([bypassGrant]), declaration)).toBeNull();

    // No bypass → the unchanged ids fragment, bare column + bound ids.
    const scoped = buildGrantScopeAccessShapeWhere(enrolments.offeringId, grantClaims([teacherGrant]), declaration);
    const bound = dialect.sqlToQuery(scoped as SQL);
    expect(normalizeSqlText(bound.sql)).toBe(`"offering_id" in ($1)`);
    expect(bound.params).toEqual(["off-a"]);
    expect(renderSql(scoped)).toBe(renderSql(buildGrantScopeShapeWhere(enrolments.offeringId, ["off-a"])));

    // Neither bypass nor grants → the DENY_ALL sentinel BY REFERENCE, so a customWhere built on this
    // probes claims-dependent.
    expect(buildGrantScopeAccessShapeWhere(enrolments.offeringId, grantClaims([]), declaration)).toBe(DENY_ALL);
    expect(buildGrantScopeAccessShapeWhere(enrolments.offeringId, null, declaration)).toBe(DENY_ALL);
    expect(
      isClaimsDependentRowFilter({
        customWhere: (claims) => buildGrantScopeAccessShapeWhere(enrolments.offeringId, claims, declaration),
      }),
    ).toBe(true);
  });

  it("mirror and policy agree on the bypass: same kind and roles on both surfaces", () => {
    const role = pgRole("authenticated");
    const governed = pgTable(
      "enrolments",
      { id: uuid("id").primaryKey(), offeringId: uuid("offering_id").notNull() },
      (t) => buildSupabaseGrantScopeNativePolicies({ role, scopeColumn: t.offeringId, ...declaration }),
    );

    const policyText = byCommand(governed)["select"]?.using ?? "";
    expect(policyText).toContain(`bypass_grant -> 'scope' ->> 'kind' = 'platform'`);
    expect(policyText).toContain(`bypass_grant ->> 'role' in ('platform_admin')`);

    // The very grant the policy's EXISTS would match is the one the mirror bypasses on.
    expect(resolveGrantScopeAccess(grantClaims([bypassGrant]), declaration).bypass).toBe(true);
    expect(buildGrantScopeAccessShapeWhere(governed.offeringId, grantClaims([bypassGrant]), declaration)).toBeNull();
  });
});
