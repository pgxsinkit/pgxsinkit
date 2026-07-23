import { describe, expect, it } from "bun:test";

import type { SQL } from "drizzle-orm";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";

import { authorsTable, todosTable } from "@pgxsinkit/schema";

type NativePolicy = {
  name: string;
  as: string;
  for: string;
  to: string | { name: string } | Array<string | { name: string }>;
  using?: SQL;
  withCheck?: SQL;
};

const dialect = new PgDialect();

function normalizeSqlText(sqlText: string): string {
  return sqlText.replace(/\s+/g, " ").trim();
}

function renderSql(fragment: SQL | undefined): string | null {
  return fragment ? normalizeSqlText(dialect.sqlToQuery(fragment).sql) : null;
}

function getNativePolicyNames(table: typeof authorsTable | typeof todosTable): string[] {
  return getTableConfig(table).policies.map((policy) => policy.name);
}

function getPoliciesByCommand(table: typeof authorsTable | typeof todosTable) {
  return Object.fromEntries(
    getTableConfig(table).policies.map((raw) => {
      const policy = raw as NativePolicy;
      return [policy.for, { using: renderSql(policy.using), withCheck: renderSql(policy.withCheck) }];
    }),
  );
}

describe("demo schema native RLS policies", () => {
  it("defines native Drizzle policies on demo tables", () => {
    const authorsConfig = getTableConfig(authorsTable);
    const todosConfig = getTableConfig(todosTable);

    expect(authorsConfig.policies).toHaveLength(4);
    expect(todosConfig.policies).toHaveLength(4);

    expect(getNativePolicyNames(authorsTable)).toEqual([
      "authors_select_owner_or_admin",
      "authors_insert_owner_or_admin",
      "authors_update_owner_or_admin",
      "authors_delete_owner_or_admin",
    ]);

    expect(getNativePolicyNames(todosTable)).toEqual([
      "todos_select_owner_or_admin",
      "todos_insert_owner_or_admin",
      "todos_update_owner_or_admin",
      "todos_delete_owner_or_admin",
    ]);
  });

  it("native policies carry the owner-or-admin predicate (qualified column, inlined admin, no params)", () => {
    // The owner-or-admin builder takes the real Drizzle column now, so the demo tables' policy bodies
    // reference the qualified owner column ("authors"."owner_id"), inline the admin role, and carry no
    // bound params (CREATE POLICY DDL can't bind any). The command shape stays: SELECT/DELETE gate
    // USING, INSERT gates WITH CHECK, UPDATE gates both.
    for (const [table, tableName] of [
      [authorsTable, "authors"],
      [todosTable, "todos"],
    ] as const) {
      const byCommand = getPoliciesByCommand(table);
      const assertPredicate = (text: string | null) => {
        expect(text).toContain(`"${tableName}"."owner_id" =`);
        expect(text).toContain("assigned_role.role_name_value = 'admin'");
        expect(text).not.toMatch(/\$\d/);
      };

      assertPredicate(byCommand["select"]?.using ?? null);
      expect(byCommand["select"]?.withCheck).toBeNull();

      expect(byCommand["insert"]?.using).toBeNull();
      assertPredicate(byCommand["insert"]?.withCheck ?? null);

      assertPredicate(byCommand["update"]?.using ?? null);
      assertPredicate(byCommand["update"]?.withCheck ?? null);

      assertPredicate(byCommand["delete"]?.using ?? null);
      expect(byCommand["delete"]?.withCheck).toBeNull();
    }
  });
});
