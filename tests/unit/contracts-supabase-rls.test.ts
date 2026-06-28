import { describe, expect, it } from "bun:test";

import type { SQL } from "drizzle-orm";
import { boolean, PgDialect, pgRole, pgTable, uuid, varchar, type AnyPgTable } from "drizzle-orm/pg-core";

import {
  buildSupabaseMembershipNativePolicies,
  buildSupabaseOwnerOrAdminNativePolicies,
  buildSupabaseOwnerOrAdminPredicateSqlText,
  supabaseOwnerOrAdminDefaults,
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

describe("contracts supabase RLS helpers", () => {
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
