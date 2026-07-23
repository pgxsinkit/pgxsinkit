import { getTableConfig, type AnyPgTable } from "drizzle-orm/pg-core";

import { escapeSqlLiteral, quoteIdentifier as quoteIdent } from "@pgxsinkit/contracts";
import type { SyncTableEntry, SyncTableRegistry } from "@pgxsinkit/contracts";

const grantPrivilegeOrder = ["SELECT", "INSERT", "UPDATE", "DELETE"] as const;

type GrantPrivilege = (typeof grantPrivilegeOrder)[number];

type TableGrant = {
  roleName: string;
  privileges: GrantPrivilege[];
};

export function buildRegistryGovernanceSql(registry: SyncTableRegistry): string {
  const statements: string[] = [];

  for (const entry of Object.values(registry)) {
    const table = entry.table as AnyPgTable;
    const tableConfig = getTableConfig(table);
    const qualifiedTableName = qualifyIdent(tableConfig.schema, tableConfig.name);

    for (const constraint of entry.governance?.deferrableConstraints ?? []) {
      // `constraintName` must stay hand-carried (it names the constraint the MIGRATION created —
      // drizzle-kit's SQL suffix `_fkey` differs from the ORM's `getName()` `_fk`), but the spec's
      // `columns` can be validated structurally: an FK over exactly those columns must still exist
      // on the table, so a column rename/drop fails loudly here instead of silently emitting an
      // ALTER for a constraint that no longer matches anything.
      assertForeignKeyForColumns(entry, tableConfig, constraint.columns, constraint.constraintName);
      statements.push(
        `ALTER TABLE ${qualifiedTableName} ALTER CONSTRAINT ${quoteIdent(constraint.constraintName)} DEFERRABLE INITIALLY ${constraint.initiallyDeferred ? "DEFERRED" : "IMMEDIATE"};`,
      );
    }

    for (const grant of collectTableGrants(entry)) {
      statements.push(buildGrantSql(qualifiedTableName, grant));
    }
  }

  return statements.join("\n\n");
}

function assertForeignKeyForColumns(
  entry: SyncTableEntry,
  tableConfig: ReturnType<typeof getTableConfig>,
  specColumns: readonly string[],
  constraintName: string,
): void {
  // Spec columns are Drizzle property keys; resolve each to its DB column name through the table
  // object itself (falling back to the raw string for a spec already written as a column name).
  const wanted = new Set(
    specColumns.map((propertyKey) => {
      const viaTable = (entry.table as unknown as Record<string, { name?: string } | undefined>)[propertyKey];
      return viaTable?.name ?? propertyKey;
    }),
  );

  const matched = tableConfig.foreignKeys.some((foreignKey) => {
    const localColumns = foreignKey.reference().columns.map((column) => column.name);
    return localColumns.length === wanted.size && localColumns.every((name) => wanted.has(name));
  });

  if (!matched) {
    const available = tableConfig.foreignKeys
      .map((foreignKey) =>
        foreignKey
          .reference()
          .columns.map((column) => column.name)
          .join("+"),
      )
      .join(", ");
    throw new Error(
      `governance: deferrable constraint ${constraintName} declares columns [${specColumns.join(", ")}] ` +
        `but ${tableConfig.name} has no foreign key over them (FK column sets: ${available || "none"}); ` +
        `the spec has drifted from the Drizzle table`,
    );
  }
}

function collectTableGrants(entry: SyncTableEntry): TableGrant[] {
  const grantsByRole = new Map<string, Set<GrantPrivilege>>();
  const policies = getTableConfig(entry.table as AnyPgTable).policies;

  for (const policy of policies) {
    const privileges = grantPrivilegesForPolicyCommand(policy.for);

    for (const roleName of resolvePolicyRoleNames(policy.to)) {
      const existingPrivileges = grantsByRole.get(roleName) ?? new Set<GrantPrivilege>();

      for (const privilege of privileges) {
        existingPrivileges.add(privilege);
      }

      grantsByRole.set(roleName, existingPrivileges);
    }
  }

  if (grantsByRole.size === 0 && hasClaimManagedFields(entry)) {
    grantsByRole.set("authenticated", new Set(grantPrivilegeOrder));
  }

  return Array.from(grantsByRole.entries())
    .map(([roleName, privileges]) => ({
      roleName,
      privileges: grantPrivilegeOrder.filter((privilege) => privileges.has(privilege)),
    }))
    .filter((grant) => grant.privileges.length > 0);
}

function grantPrivilegesForPolicyCommand(command: unknown): GrantPrivilege[] {
  switch (command) {
    case undefined:
    case "all":
      return [...grantPrivilegeOrder];
    case "select":
      return ["SELECT"];
    case "insert":
      return ["INSERT"];
    case "update":
      return ["UPDATE"];
    case "delete":
      return ["DELETE"];
    default:
      throw new Error(`Unsupported policy command: ${describeUnknownValue(command)}`);
  }
}

function resolvePolicyRoleNames(role: unknown): string[] {
  if (role === undefined) {
    return ["public"];
  }

  if (Array.isArray(role)) {
    return role.flatMap((value) => resolvePolicyRoleNames(value));
  }

  if (typeof role === "string") {
    return [role];
  }

  if (typeof role === "object" && role !== null && "name" in role && typeof role.name === "string") {
    return [role.name];
  }

  throw new Error(`Unsupported policy role: ${describeUnknownValue(role)}`);
}

function hasClaimManagedFields(entry: SyncTableEntry): boolean {
  return (entry.governance?.managedFields ?? []).some((field) => field.strategy === "authClaim");
}

function buildGrantSql(qualifiedTableName: string, grant: TableGrant): string {
  const privilegeList = grant.privileges.join(", ");

  if (grant.roleName === "public") {
    return `GRANT ${privilegeList} ON TABLE ${qualifiedTableName} TO PUBLIC;`;
  }

  return [
    "DO $$",
    "BEGIN",
    `  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${escapeSqlLiteral(grant.roleName)}') THEN`,
    `    EXECUTE 'GRANT ${privilegeList} ON TABLE ${escapeSqlLiteral(qualifiedTableName)} TO ${escapeSqlLiteral(quoteIdent(grant.roleName))}';`,
    "  END IF;",
    "END;",
    "$$;",
  ].join("\n");
}

function qualifyIdent(schemaName: string | undefined, tableName: string): string {
  if (!schemaName || schemaName === "public") {
    return quoteIdent(tableName);
  }

  return `${quoteIdent(schemaName)}.${quoteIdent(tableName)}`;
}

function describeUnknownValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint" ||
    value === null ||
    value === undefined
  ) {
    return `${value}`;
  }

  if (typeof value === "symbol") {
    return value.toString();
  }

  if (typeof value === "function") {
    return value.name.length > 0 ? `[function ${value.name}]` : "[function anonymous]";
  }

  return Object.prototype.toString.call(value);
}
