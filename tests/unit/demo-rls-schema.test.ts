import { getTableConfig } from "drizzle-orm/pg-core";

import { buildSupabaseOwnerOrAdminPredicateSqlText } from "@pgxsinkit/contracts";
import { authorsTable, todosTable } from "@pgxsinkit/schema";

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

type NormalizedPolicyShape = {
  name: string;
  mode: string;
  command: string;
  roles: string[];
  using: string | null;
  withCheck: string | null;
};

function normalizeSqlText(sqlText: string): string {
  return sqlText.replace(/\s+/g, " ").trim();
}

function nativeSqlToText(value: NativeSqlExpression | undefined): string | null {
  if (!value) {
    return null;
  }

  const raw = value.queryChunks
    .map((chunk) => ("value" in chunk && Array.isArray(chunk.value) ? chunk.value.join("") : ""))
    .join("");

  return normalizeSqlText(raw);
}

function nativeRolesToNames(policy: NativePolicy): string[] {
  const roles = Array.isArray(policy.to) ? policy.to : [policy.to];

  return roles
    .flatMap((role) => {
      if (typeof role === "string") {
        return [role];
      }

      if (role && typeof role === "object" && "name" in role && typeof role.name === "string") {
        return [role.name];
      }

      return [];
    })
    .sort((left, right) => left.localeCompare(right));
}

function normalizeNativePolicy(policy: NativePolicy): NormalizedPolicyShape {
  return {
    name: policy.name,
    mode: policy.as,
    command: policy.for,
    roles: nativeRolesToNames(policy),
    using: nativeSqlToText(policy.using),
    withCheck: nativeSqlToText(policy.withCheck),
  };
}

function sortByName<T extends { name: string }>(items: T[]): T[] {
  return [...items].sort((left, right) => left.name.localeCompare(right.name));
}

function getNativePolicyNames(table: typeof authorsTable | typeof todosTable): string[] {
  const config = getTableConfig(table);
  return config.policies.map((policy) => policy.name);
}

function getNormalizedNativePolicies(table: typeof authorsTable | typeof todosTable): NormalizedPolicyShape[] {
  return sortByName(getTableConfig(table).policies.map((policy) => normalizeNativePolicy(policy as NativePolicy)));
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

  it("native policies have correct command, mode, role, and predicates", () => {
    const expectedPredicate = normalizeSqlText(buildSupabaseOwnerOrAdminPredicateSqlText());
    const expectedByCommand: Record<string, { using: string | null; withCheck: string | null }> = {
      select: {
        using: expectedPredicate,
        withCheck: null,
      },
      insert: {
        using: null,
        withCheck: expectedPredicate,
      },
      update: {
        using: expectedPredicate,
        withCheck: expectedPredicate,
      },
      delete: {
        using: expectedPredicate,
        withCheck: null,
      },
    };

    const authorsNative = getNormalizedNativePolicies(authorsTable);
    const todosNative = getNormalizedNativePolicies(todosTable);

    for (const policy of [...authorsNative, ...todosNative]) {
      expect(policy).toEqual(
        expect.objectContaining(
          expectedByCommand[policy.command] ?? {
            using: null,
            withCheck: null,
          },
        ),
      );
    }
  });
});
