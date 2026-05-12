import { sql } from "drizzle-orm";
import { pgPolicy, type PgRole } from "drizzle-orm/pg-core";

type SupabaseOwnerOrAdminPolicyKind = "select" | "insert" | "update" | "delete";

type SupabaseOwnerOrAdminPolicyShape = {
  command: SupabaseOwnerOrAdminPolicyKind;
  using: boolean;
  withCheck: boolean;
};

export type SupabaseOwnerOrAdminPredicateOptions = {
  ownerSqlColumn?: string;
  adminRoleName?: string;
  subjectCastType?: string;
};

export type SupabaseOwnerOrAdminNativePoliciesOptions = SupabaseOwnerOrAdminPredicateOptions & {
  tableName: string;
  role: PgRole;
};

const defaultOwnerSqlColumn = "owner_id";
const defaultOwnerPropertyKey = "ownerId";
const defaultAuthenticatedRoleName = "authenticated";
const defaultAdminRoleName = "admin";
const defaultSubjectCastType = "uuid";

const ownerOrAdminPolicyShapes: SupabaseOwnerOrAdminPolicyShape[] = [
  {
    command: "select",
    using: true,
    withCheck: false,
  },
  {
    command: "insert",
    using: false,
    withCheck: true,
  },
  {
    command: "update",
    using: true,
    withCheck: true,
  },
  {
    command: "delete",
    using: true,
    withCheck: false,
  },
];

function assertIdentifier(value: string, label: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`${label} must be a valid SQL identifier: ${value}`);
  }
}

function assertTypeName(value: string, label: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*(?:\s+[A-Za-z_][A-Za-z0-9_]*)*$/.test(value)) {
    throw new Error(`${label} must be a valid SQL type name: ${value}`);
  }
}

function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

function buildOwnerOrAdminPolicyName(tableName: string, command: SupabaseOwnerOrAdminPolicyKind) {
  return `${tableName}_${command}_owner_or_admin`;
}

function normalizePredicateOptions(options: SupabaseOwnerOrAdminPredicateOptions = {}) {
  const ownerSqlColumn = options.ownerSqlColumn ?? defaultOwnerSqlColumn;
  const adminRoleName = options.adminRoleName ?? defaultAdminRoleName;
  const subjectCastType = options.subjectCastType ?? defaultSubjectCastType;

  assertIdentifier(ownerSqlColumn, "ownerSqlColumn");
  assertTypeName(subjectCastType, "subjectCastType");

  return {
    ownerSqlColumn,
    adminRoleName,
    subjectCastType,
  };
}

function toPredicateOptions(options: SupabaseOwnerOrAdminPredicateOptions): SupabaseOwnerOrAdminPredicateOptions {
  return {
    ...(options.ownerSqlColumn !== undefined ? { ownerSqlColumn: options.ownerSqlColumn } : {}),
    ...(options.adminRoleName !== undefined ? { adminRoleName: options.adminRoleName } : {}),
    ...(options.subjectCastType !== undefined ? { subjectCastType: options.subjectCastType } : {}),
  };
}

export function buildSupabaseOwnerOrAdminPredicateSqlText(options: SupabaseOwnerOrAdminPredicateOptions = {}): string {
  const normalized = normalizePredicateOptions(options);

  return `
  ${normalized.ownerSqlColumn} = coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::${normalized.subjectCastType}
  OR EXISTS (
    SELECT 1
    FROM jsonb_array_elements_text(
      COALESCE(
        (
          coalesce(
            nullif(current_setting('request.jwt.claim', true), ''),
            nullif(current_setting('request.jwt.claims', true), '')
          )::jsonb -> 'app_metadata' -> 'roles'
        ),
        '[]'::jsonb
      )
    ) AS assigned_role(role_name_value)
    WHERE assigned_role.role_name_value = '${escapeSqlLiteral(normalized.adminRoleName)}'
  )
`;
}

export function buildSupabaseOwnerOrAdminNativePolicies(options: SupabaseOwnerOrAdminNativePoliciesOptions) {
  const predicate = sql.raw(buildSupabaseOwnerOrAdminPredicateSqlText(toPredicateOptions(options)));

  return ownerOrAdminPolicyShapes.map((shape) =>
    pgPolicy(buildOwnerOrAdminPolicyName(options.tableName, shape.command), {
      as: "permissive",
      for: shape.command,
      to: options.role,
      ...(shape.using ? { using: predicate } : {}),
      ...(shape.withCheck ? { withCheck: predicate } : {}),
    }),
  );
}

export const supabaseOwnerOrAdminDefaults = {
  ownerSqlColumn: defaultOwnerSqlColumn,
  ownerPropertyKey: defaultOwnerPropertyKey,
  authenticatedRoleName: defaultAuthenticatedRoleName,
  adminRoleName: defaultAdminRoleName,
  subjectCastType: defaultSubjectCastType,
} as const;
