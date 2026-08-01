import { describe, expect, it } from "bun:test";

import type { SQL } from "drizzle-orm";
import { boolean, PgDialect, pgRole, pgTable, uuid, varchar, type AnyPgTable } from "drizzle-orm/pg-core";

import {
  buildMembershipShapeWhere,
  buildOwnerOrAdminShapeWhere,
  buildOwnershipShapeWhere,
  buildSupabaseMembershipNativePolicies,
  buildSupabaseOwnerOrAdminNativePolicies,
  buildSupabaseOwnerOrAdminPredicateSqlText,
  DENY_ALL,
  isClaimsDependentRowFilter,
  resolveOwnerOrAdminAccess,
  supabaseOwnerOrAdminDefaults,
  type JwtClaims,
  type SupabaseMembershipShapeColumns,
} from "@pgxsinkit/contracts";

type NativeSqlChunk = {
  value?: string[];
};

type NativeSqlExpression = {
  queryChunks: NativeSqlChunk[];
};

type NativePolicy = {
  name: string;
  as: string;
  for: string;
  to: string | { name: string } | Array<string | { name: string }>;
  using?: NativeSqlExpression;
  withCheck?: NativeSqlExpression;
};

function normalizeSqlText(sqlText: string): string {
  return sqlText.replace(/\s+/g, " ").trim();
}

// Render a composed Drizzle SQL fragment (operators + columns + nested sql) to its real DDL text.
// The hand-rolled nativeSqlToText only joins `sql.raw` string chunks; a fragment built from columns
// needs the dialect to qualify and serialize it.
const dialect = new PgDialect();
function renderSql(fragment: unknown): string | null {
  if (!fragment) {
    return null;
  }
  return normalizeSqlText(dialect.sqlToQuery(fragment as SQL).sql);
}

// Drizzle stashes the `extras` callback's result (our pgPolicy array) on the built table under an
// ExtraConfigBuilder symbol; invoke it with the table to recover the policies.
function readTablePolicies(table: AnyPgTable): NativePolicy[] {
  const symbol = Object.getOwnPropertySymbols(table).find((s) => s.description?.includes("ExtraConfigBuilder"));
  const builder = symbol ? (table as unknown as Record<symbol, (t: AnyPgTable) => unknown>)[symbol] : undefined;
  const extras = typeof builder === "function" ? builder(table) : undefined;
  const list = Array.isArray(extras) ? extras : Object.values(extras ?? {});
  return list.filter(
    (entry): entry is NativePolicy => typeof entry === "object" && entry !== null && "for" in entry && "name" in entry,
  );
}

function nativeRoleToName(role: NativePolicy["to"]): string {
  const normalized = Array.isArray(role) ? role[0] : role;
  if (!normalized) {
    return "";
  }

  if (typeof normalized === "string") {
    return normalized;
  }

  if (typeof normalized === "object" && "name" in normalized && typeof normalized.name === "string") {
    return normalized.name;
  }

  return "";
}

// The DEFAULT owner-or-admin predicate, byte-for-byte as it renders today. Committed migrations embed
// this text, so it is a compatibility surface and the pin exists to catch ACCIDENTAL drift of the
// rendered form. A change here is only ever deliberate, and comes with regenerated artifacts. The
// current form reflects two such deliberate changes: the admin-roles claim path is DERIVED from the
// shared `adminRolesClaimPath` constant rather than hard-coded, and the extracted roles claim goes
// through the `case jsonb_typeof(…) when 'array' …` guard so a present-but-non-array claim DENIES (as
// the JS mirror does) instead of raising "cannot extract elements from a scalar/object" — the guard's
// behaviour is executed against PGlite in `rls-malformed-claim-arrays.test.ts`.
const defaultOwnerOrAdminPredicateSql = `
  owner_id = coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
  OR EXISTS (
    SELECT 1
    FROM jsonb_array_elements_text(
      case jsonb_typeof((
          coalesce(
            nullif(current_setting('request.jwt.claim', true), ''),
            nullif(current_setting('request.jwt.claims', true), '')
          )::jsonb -> 'app_metadata' -> 'roles'
        )) when 'array' then (
          coalesce(
            nullif(current_setting('request.jwt.claim', true), ''),
            nullif(current_setting('request.jwt.claims', true), '')
          )::jsonb -> 'app_metadata' -> 'roles'
        ) else '[]'::jsonb end
    ) AS assigned_role(role_name_value)
    WHERE assigned_role.role_name_value = 'admin'
  )
`;

describe("contracts supabase RLS helpers", () => {
  it("renders the default predicate byte-identically (migration-embedded DDL text)", () => {
    expect(buildSupabaseOwnerOrAdminPredicateSqlText()).toBe(defaultOwnerOrAdminPredicateSql);
  });

  it("exposes stable defaults and builds default predicate SQL", () => {
    expect(supabaseOwnerOrAdminDefaults).toEqual({
      ownerSqlColumn: "owner_id",
      ownerPropertyKey: "ownerId",
      authenticatedRoleName: "authenticated",
      adminRoleName: "admin",
      subjectCastType: "uuid",
    });

    const predicate = normalizeSqlText(buildSupabaseOwnerOrAdminPredicateSqlText());

    expect(predicate).toContain("owner_id = coalesce(");
    expect(predicate).toContain("::uuid");
    expect(predicate).toContain("jsonb_array_elements_text(");
    expect(predicate).toContain("assigned_role.role_name_value = 'admin'");
    expect(predicate).toContain("current_setting('request.jwt.claim.sub', true)");
    expect(predicate).toContain("current_setting('request.jwt.claims', true)");
  });

  it("supports custom Supabase-compatible claim and role options", () => {
    const predicate = normalizeSqlText(
      buildSupabaseOwnerOrAdminPredicateSqlText({
        ownerSqlColumn: "tenant_owner_id",
        adminRoleName: "team'lead",
        subjectCastType: "text",
      }),
    );

    expect(predicate).toContain("tenant_owner_id = coalesce(");
    expect(predicate).toContain("::text");
    expect(predicate).toContain("assigned_role.role_name_value = 'team''lead'");
  });

  it("builds native Drizzle owner-or-admin policies from a column, deriving the table name", () => {
    const role = pgRole("member");

    // The builder takes the real owner column now; the governed table name (projects) is derived from
    // it, and the predicate serializes with the qualified column + inlined admin role, no bound params.
    const projects = pgTable(
      "projects",
      {
        id: uuid("id").primaryKey(),
        tenantId: uuid("tenant_id"),
      },
      (t) => buildSupabaseOwnerOrAdminNativePolicies({ role, ownerColumn: t.tenantId, adminRoleName: "maintainer" }),
    );

    const byCommand = Object.fromEntries(
      readTablePolicies(projects).map((policy) => [
        policy.for,
        {
          name: policy.name,
          mode: policy.as,
          role: nativeRoleToName(policy.to),
          using: renderSql(policy.using),
          withCheck: renderSql(policy.withCheck),
        },
      ]),
    );

    // The owner column is qualified (write path = Postgres RLS), the admin role is inlined.
    const ownerQualified = '"projects"."tenant_id" =';
    const adminInlined = "assigned_role.role_name_value = 'maintainer'";
    const assertPredicate = (text: string | null) => {
      expect(text).toContain(ownerQualified);
      expect(text).toContain(adminInlined);
      expect(text).not.toMatch(/\$\d/);
    };

    expect(byCommand["select"]).toMatchObject({
      name: "projects_select_owner_or_admin",
      mode: "permissive",
      role: "member",
      withCheck: null,
    });
    assertPredicate(byCommand["select"]?.using ?? null);

    // insert checks WITH CHECK only; delete USING only; update both — the command semantics.
    expect(byCommand["insert"]?.using).toBeNull();
    assertPredicate(byCommand["insert"]?.withCheck ?? null);
    assertPredicate(byCommand["update"]?.using ?? null);
    assertPredicate(byCommand["update"]?.withCheck ?? null);
    assertPredicate(byCommand["delete"]?.using ?? null);
    expect(byCommand["delete"]?.withCheck).toBeNull();
  });

  it("gates membership INSERT/UPDATE on write-state but leaves SELECT/DELETE open", () => {
    // The builder takes real Drizzle columns/tables now, so we build a fixture schema and pass its
    // columns. The governed table name (for policy identifiers) is derived from the container column,
    // and predicates serialize with qualified columns + inlined literals (valid CREATE POLICY DDL).
    const role = pgRole("authenticated");

    const workspaces = pgTable("workspaces", {
      id: uuid("id").primaryKey(),
      locked: boolean("locked").notNull().default(false),
    });
    const workspaceMembers = pgTable("workspace_members", {
      id: uuid("id").primaryKey(),
      workspaceId: uuid("workspace_id").notNull(),
      memberId: uuid("member_id").notNull(),
      role: varchar("role", { length: 32 }).notNull(),
      muted: boolean("muted").notNull().default(false),
    });
    const workItems = pgTable(
      "work_items",
      {
        id: uuid("id").primaryKey(),
        workspaceId: uuid("workspace_id").notNull(),
        ownerId: uuid("owner_id"),
      },
      (t) =>
        buildSupabaseMembershipNativePolicies({
          role,
          containerColumn: t.workspaceId,
          ownerColumn: t.ownerId,
          membershipTable: workspaceMembers,
          membershipContainerColumn: workspaceMembers.workspaceId,
          membershipSubjectColumn: workspaceMembers.memberId,
          managerRoleColumn: workspaceMembers.role,
          writeGate: {
            containerTable: workspaces,
            containerPkColumn: workspaces.id,
            containerLockColumn: workspaces.locked,
            membershipMutedColumn: workspaceMembers.muted,
          },
        }),
    );

    const policies = readTablePolicies(workItems);

    const byCommand = Object.fromEntries(
      policies.map((policy) => [
        policy.for,
        {
          name: policy.name,
          using: renderSql(policy.using),
          withCheck: renderSql(policy.withCheck),
        },
      ]),
    );

    // Governed table name is derived from the container column's table.
    expect(byCommand["select"]?.name).toBe("work_items_select_membership");

    // Containment is `= ANY(ARRAY(uncorrelated subquery))`, not `IN (subquery)` — the form that
    // index-scans instead of seq-scanning on a runtime-resolved set (the rls-read perf finding).
    expect(byCommand["select"]?.using).toContain('"work_items"."workspace_id" = any(array(select');
    expect(byCommand["select"]?.using).not.toContain('"workspace_id" in (select');

    // Columns serialize qualified (write path = Postgres RLS, unlike Electric's bare-column rule).
    expect(byCommand["insert"]?.withCheck).toContain('"work_items"."owner_id" =');
    expect(byCommand["insert"]?.withCheck).toContain('from "workspaces" where "workspaces"."locked" = false');
    expect(byCommand["insert"]?.withCheck).toContain('"workspace_members"."muted" = false');
    // Manager literal inlined, not a bound param.
    expect(byCommand["insert"]?.withCheck).toContain(`"workspace_members"."role" = 'manager'`);
    expect(byCommand["insert"]?.withCheck).not.toMatch(/\$\d/);

    // UPDATE gates both USING and WITH CHECK.
    expect(byCommand["update"]?.using).toContain('from "workspaces" where "workspaces"."locked" = false');
    expect(byCommand["update"]?.withCheck).toContain('"workspace_members"."muted" = false');

    // SELECT and DELETE are untouched by write-state.
    expect(byCommand["select"]?.using).not.toContain("locked");
    expect(byCommand["select"]?.using).not.toContain("muted");
    expect(byCommand["delete"]?.using).not.toContain("locked");
    expect(byCommand["delete"]?.using).not.toContain("muted");
  });
});

// Every quoted identifier a rendered predicate references (columns AND table names), de-duplicated —
// used by the agreement tests below to prove the two surfaces derive from the same declarations.
function quotedIdentifiers(text: string): string[] {
  return [...new Set(text.match(/"[a-z_]+"/g) ?? [])].sort();
}

describe("contracts owner-or-admin read-path mirror", () => {
  const projects = pgTable("projects", {
    id: uuid("id").primaryKey(),
    ownerId: uuid("owner_id"),
  });

  it("resolveOwnerOrAdminAccess reads the same claim path the policy's EXISTS reads", () => {
    expect(resolveOwnerOrAdminAccess({ sub: "user-1", app_metadata: { roles: ["admin"] } })).toEqual({
      admin: true,
      subject: "user-1",
    });

    // Role present but not the admin one; subject still resolves.
    expect(resolveOwnerOrAdminAccess({ sub: "user-1", app_metadata: { roles: ["editor"] } })).toEqual({
      admin: false,
      subject: "user-1",
    });

    // Admin standing does not require a subject — the policy's OR branch is unconditional too.
    expect(resolveOwnerOrAdminAccess({ app_metadata: { roles: ["admin"] } })).toEqual({
      admin: true,
      subject: null,
    });

    expect(resolveOwnerOrAdminAccess(null)).toEqual({ admin: false, subject: null });
    expect(resolveOwnerOrAdminAccess({})).toEqual({ admin: false, subject: null });
  });

  it("resolveOwnerOrAdminAccess honours a custom admin role name", () => {
    const claims: JwtClaims = { sub: "user-1", app_metadata: { roles: ["maintainer"] } };

    expect(resolveOwnerOrAdminAccess(claims, { adminRoleName: "maintainer" }).admin).toBe(true);
    // The default name must NOT match when the policy was built with a custom one.
    expect(resolveOwnerOrAdminAccess(claims).admin).toBe(false);
  });

  it("resolveOwnerOrAdminAccess never throws on malformed claims", () => {
    // Claims reach a customWhere unverified in shape, so every wrong shape must simply confer nothing.
    const malformed: unknown[] = [
      { app_metadata: "not-an-object" },
      { app_metadata: null },
      { app_metadata: ["admin"] },
      { app_metadata: { roles: "admin" } },
      { app_metadata: { roles: null } },
      { app_metadata: { roles: 7 } },
      { app_metadata: { roles: [42, null, { role: "admin" }] } },
    ];

    for (const claims of malformed) {
      expect(resolveOwnerOrAdminAccess(claims as JwtClaims)).toEqual({ admin: false, subject: null });
    }

    // A non-string member alongside a real one is ignored, not fatal.
    expect(resolveOwnerOrAdminAccess({ app_metadata: { roles: [42, "admin"] } } as unknown as JwtClaims).admin).toBe(
      true,
    );

    // Subject extraction: empty or non-string sub is no subject at all.
    expect(resolveOwnerOrAdminAccess({ sub: "" }).subject).toBeNull();
    expect(resolveOwnerOrAdminAccess({ sub: 42 } as unknown as JwtClaims).subject).toBeNull();
  });

  it("buildOwnerOrAdminShapeWhere: admin sees everything, owner sees their rows, nobody sees nothing", () => {
    // Admin → null: no filter at all, mirroring the policy's OR bypass branch.
    expect(buildOwnerOrAdminShapeWhere(projects.ownerId, { sub: "u", app_metadata: { roles: ["admin"] } })).toBeNull();

    // Owner → the ownership leaf, bare column + bound subject (Electric's grammar).
    const owned = buildOwnerOrAdminShapeWhere(projects.ownerId, { sub: "user-1" });
    const bound = dialect.sqlToQuery(owned as SQL);
    expect(normalizeSqlText(bound.sql)).toBe(`"owner_id" = $1`);
    expect(bound.params).toEqual(["user-1"]);
    // It IS the shared ownership leaf, not a re-implementation of it.
    expect(renderSql(owned)).toBe(renderSql(buildOwnershipShapeWhere(projects.ownerId, "user-1")));

    // No subject → the DENY_ALL sentinel BY REFERENCE, which is what isClaimsDependentRowFilter probes.
    expect(buildOwnerOrAdminShapeWhere(projects.ownerId, {})).toBe(DENY_ALL);
    expect(buildOwnerOrAdminShapeWhere(projects.ownerId, null)).toBe(DENY_ALL);
    expect(buildOwnerOrAdminShapeWhere(projects.ownerId, { sub: "" })).toBe(DENY_ALL);
  });

  it("a customWhere built on the mirror probes claims-dependent", () => {
    expect(
      isClaimsDependentRowFilter({ customWhere: (claims) => buildOwnerOrAdminShapeWhere(projects.ownerId, claims) }),
    ).toBe(true);
  });

  it("mirror and policy derive from the same owner column and admin role", () => {
    const role = pgRole("authenticated");
    const governed = pgTable("projects", { id: uuid("id").primaryKey(), ownerId: uuid("owner_id") }, (t) =>
      buildSupabaseOwnerOrAdminNativePolicies({ role, ownerColumn: t.ownerId, adminRoleName: "maintainer" }),
    );

    const select = readTablePolicies(governed).find((policy) => policy.for === "select");
    const policyText = renderSql(select?.using) ?? "";
    const mirrorText = renderSql(buildOwnerOrAdminShapeWhere(governed.ownerId, { sub: "user-1" })) ?? "";

    // Same column: qualified on the write surface (Postgres RLS), bare on the read surface (Electric).
    expect(policyText).toContain(`"projects"."${governed.ownerId.name}"`);
    expect(quotedIdentifiers(mirrorText)).toEqual([`"${governed.ownerId.name}"`]);

    // Same admin role value on both surfaces — the policy inlines it, the mirror compares it.
    expect(policyText).toContain(`assigned_role.role_name_value = 'maintainer'`);
    expect(
      resolveOwnerOrAdminAccess({ app_metadata: { roles: ["maintainer"] } }, { adminRoleName: "maintainer" }).admin,
    ).toBe(true);
    expect(
      buildOwnerOrAdminShapeWhere(
        governed.ownerId,
        { app_metadata: { roles: ["maintainer"] } },
        {
          adminRoleName: "maintainer",
        },
      ),
    ).toBeNull();
  });

  it("a custom adminRolesClaimPath moves BOTH surfaces to the same claim", () => {
    const adminRolesClaimPath = ["tenant", "acl", "roles"];
    const role = pgRole("authenticated");
    const governed = pgTable("projects", { id: uuid("id").primaryKey(), ownerId: uuid("owner_id") }, (t) =>
      buildSupabaseOwnerOrAdminNativePolicies({ role, ownerColumn: t.ownerId, adminRolesClaimPath }),
    );

    // Write surface: the EXISTS walks the custom chain and no longer mentions the default one.
    const policyText = renderSql(readTablePolicies(governed).find((policy) => policy.for === "select")?.using) ?? "";
    expect(policyText).toContain(`::jsonb -> 'tenant' -> 'acl' -> 'roles'`);
    expect(policyText).not.toContain("app_metadata");

    // Read surface: the mirror reads exactly that path — admin at the custom path, nothing at the default.
    const claims: JwtClaims = {
      sub: "user-1",
      app_metadata: { roles: ["admin"] },
      tenant: { acl: { roles: ["admin"] } },
    };
    expect(resolveOwnerOrAdminAccess(claims, { adminRolesClaimPath }).admin).toBe(true);
    expect(buildOwnerOrAdminShapeWhere(governed.ownerId, claims, { adminRolesClaimPath })).toBeNull();
    expect(resolveOwnerOrAdminAccess({ tenant: { acl: { roles: ["admin"] } } }, { adminRolesClaimPath }).admin).toBe(
      true,
    );
    // …and a caller holding the role only at the DEFAULT path is not an admin under the custom one.
    expect(resolveOwnerOrAdminAccess({ app_metadata: { roles: ["admin"] } }, { adminRolesClaimPath }).admin).toBe(
      false,
    );

    // The text builder threads the same option (the escape-hatch surface stays in step).
    expect(buildSupabaseOwnerOrAdminPredicateSqlText({ adminRolesClaimPath })).toContain(
      `::jsonb -> 'tenant' -> 'acl' -> 'roles'`,
    );
  });

  it("rejects a claim-path segment that is not a plain identifier (it is emitted into DDL)", () => {
    expect(() =>
      buildSupabaseOwnerOrAdminPredicateSqlText({ adminRolesClaimPath: ["app_metadata", "ro'les"] }),
    ).toThrow(/adminRolesClaimPath segment/);
    expect(() => resolveOwnerOrAdminAccess({}, { adminRolesClaimPath: ["ro'les"] })).toThrow(
      /adminRolesClaimPath segment/,
    );
  });
});

describe("contracts membership read-path mirror", () => {
  const workspaceMembers = pgTable("workspace_members", {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id").notNull(),
    memberId: uuid("member_id").notNull(),
    role: varchar("role", { length: 32 }).notNull(),
    muted: boolean("muted").notNull().default(false),
  });
  const workItems = pgTable("work_items", {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id").notNull(),
    ownerId: uuid("owner_id"),
  });

  // ONE declaration, handed to both surfaces below (the write-only fields are ignored by the mirror).
  const declaration = {
    role: pgRole("authenticated"),
    containerColumn: workItems.workspaceId,
    ownerColumn: workItems.ownerId,
    membershipTable: workspaceMembers,
    membershipContainerColumn: workspaceMembers.workspaceId,
    membershipSubjectColumn: workspaceMembers.memberId,
    managerRoleColumn: workspaceMembers.role,
  } satisfies SupabaseMembershipShapeColumns;

  it("renders the self-contained IN (subquery) form with the subject as a bound param", () => {
    const where = buildMembershipShapeWhere(declaration, { sub: "member-1" });
    const bound = dialect.sqlToQuery(where);

    // Bare columns (Electric rejects qualified refs), real DB column names, uncorrelated subquery.
    expect(normalizeSqlText(bound.sql)).toBe(
      `"workspace_id" in (select "workspace_id" from "workspace_members" where "member_id" = $1)`,
    );
    expect(bound.params).toEqual(["member-1"]);

    // Electric renders plain IN (subquery); the RLS side renders = ANY(ARRAY(...)) — deliberate.
    expect(normalizeSqlText(bound.sql)).not.toContain("any(array(");

    // Rendered inline (a proxy composing a shape URL), drizzle owns the escaping — no injection.
    const inline = dialect.sqlToQuery(buildMembershipShapeWhere(declaration, { sub: "a'b" }).inlineParams());
    expect(normalizeSqlText(inline.sql)).toContain(`where "member_id" = 'a''b'`);
  });

  it("denies without a subject, by DENY_ALL reference, so the filter probes claims-dependent", () => {
    expect(buildMembershipShapeWhere(declaration, {})).toBe(DENY_ALL);
    expect(buildMembershipShapeWhere(declaration, null)).toBe(DENY_ALL);
    expect(buildMembershipShapeWhere(declaration, { sub: "" })).toBe(DENY_ALL);
    expect(
      isClaimsDependentRowFilter({ customWhere: (claims) => buildMembershipShapeWhere(declaration, claims) }),
    ).toBe(true);
  });

  it("mirror and policy reference the same columns from the same declaration", () => {
    const select = buildSupabaseMembershipNativePolicies(declaration).find(
      (policy) => (policy as unknown as NativePolicy).for === "select",
    ) as unknown as NativePolicy | undefined;

    const policyIdentifiers = quotedIdentifiers(renderSql(select?.using) ?? "");
    const mirrorIdentifiers = quotedIdentifiers(renderSql(buildMembershipShapeWhere(declaration, { sub: "m" })) ?? "");

    // The mirror names exactly what the policy predicate names, minus the governed table's own
    // qualifier (Electric refs are bare) — a rename on either side would break this.
    expect(mirrorIdentifiers).toEqual(['"member_id"', '"workspace_id"', '"workspace_members"']);
    expect(policyIdentifiers).toEqual([...mirrorIdentifiers, '"work_items"'].sort());

    // The write-only branches are absent from the read mirror by construction.
    const mirrorText = renderSql(buildMembershipShapeWhere(declaration, { sub: "m" })) ?? "";
    expect(mirrorText).not.toContain("owner_id");
    expect(mirrorText).not.toContain("role");
  });
});
