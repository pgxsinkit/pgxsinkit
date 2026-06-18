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

// ---------------------------------------------------------------------------
// Membership-scoped policies (generic). A row belongs to a *container* and is
// visible/writable through membership of that container — not just ownership.
// This is the readwrite counterpart to a membership row-filter: every member of
// the container may read the row (fan-out to non-owners); only the owner may
// create it (as themselves) and edit it, while a container *manager* may moderate
// any row. Domain-agnostic: the container, membership table, and manager role are
// all parameters.
// ---------------------------------------------------------------------------

type MembershipPolicyKind = "select" | "insert" | "update" | "delete";

export type SupabaseMembershipPredicateOptions = {
  /** Column on the governed row naming its container (e.g. "workspace_id"). */
  containerSqlColumn: string;
  /** Membership link table (e.g. "workspace_members"). */
  membershipTableName: string;
  /** Container column on the membership link table. */
  membershipContainerSqlColumn: string;
  /** Subject (member) column on the membership link table, compared to the JWT sub. */
  membershipSubjectSqlColumn: string;
  /** Owner column on the governed row (default "owner_id"). */
  ownerSqlColumn?: string;
  /** Optional role column on the membership link enabling manager moderation. */
  managerRoleSqlColumn?: string;
  /** Role value that grants moderation (default "manager"); only used with managerRoleSqlColumn. */
  managerRoleValue?: string;
  subjectCastType?: string;
};

export type SupabaseMembershipNativePoliciesOptions = SupabaseMembershipPredicateOptions & {
  tableName: string;
  role: PgRole;
};

const defaultManagerRoleValue = "manager";

const membershipPolicyShapes: { command: MembershipPolicyKind; using: boolean; withCheck: boolean }[] = [
  { command: "select", using: true, withCheck: false },
  { command: "insert", using: false, withCheck: true },
  { command: "update", using: true, withCheck: true },
  { command: "delete", using: true, withCheck: false },
];

function buildSubjectSqlText(subjectCastType: string): string {
  return `coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::${subjectCastType}`;
}

function normalizeMembershipOptions(options: SupabaseMembershipPredicateOptions) {
  const ownerSqlColumn = options.ownerSqlColumn ?? defaultOwnerSqlColumn;
  const subjectCastType = options.subjectCastType ?? defaultSubjectCastType;
  const managerRoleValue = options.managerRoleValue ?? defaultManagerRoleValue;

  assertIdentifier(options.containerSqlColumn, "containerSqlColumn");
  assertIdentifier(options.membershipTableName, "membershipTableName");
  assertIdentifier(options.membershipContainerSqlColumn, "membershipContainerSqlColumn");
  assertIdentifier(options.membershipSubjectSqlColumn, "membershipSubjectSqlColumn");
  assertIdentifier(ownerSqlColumn, "ownerSqlColumn");
  assertTypeName(subjectCastType, "subjectCastType");

  if (options.managerRoleSqlColumn !== undefined) {
    assertIdentifier(options.managerRoleSqlColumn, "managerRoleSqlColumn");
  }

  return { ...options, ownerSqlColumn, subjectCastType, managerRoleValue };
}

// Containment form (not a correlated EXISTS): the governed row's container column must be IN the
// set of containers the subject belongs to. The IN keeps the outer container reference in the
// policy table's scope — a correlated `EXISTS (… WHERE m.container = container …)` would let the
// membership table's same-named column shadow the outer one, collapsing the correlation.
function buildMembershipMatchSqlText(
  normalized: ReturnType<typeof normalizeMembershipOptions>,
  subjectSql: string,
  requireManager: boolean,
): string {
  const managerClause =
    requireManager && normalized.managerRoleSqlColumn
      ? ` AND ${normalized.managerRoleSqlColumn} = '${escapeSqlLiteral(normalized.managerRoleValue)}'`
      : "";

  return `${normalized.containerSqlColumn} IN (
    SELECT ${normalized.membershipContainerSqlColumn}
    FROM ${normalized.membershipTableName}
    WHERE ${normalized.membershipSubjectSqlColumn} = ${subjectSql}${managerClause}
  )`;
}

/** member-of-container predicate (read fan-out). */
export function buildSupabaseMembershipSelectPredicateSqlText(options: SupabaseMembershipPredicateOptions): string {
  const normalized = normalizeMembershipOptions(options);
  return buildMembershipMatchSqlText(normalized, buildSubjectSqlText(normalized.subjectCastType), false);
}

function buildOwnerPredicate(normalized: ReturnType<typeof normalizeMembershipOptions>, subjectSql: string): string {
  return `${normalized.ownerSqlColumn} = ${subjectSql}`;
}

/** owner-or-manager predicate (edit / moderate). */
function buildOwnerOrManagerPredicate(
  normalized: ReturnType<typeof normalizeMembershipOptions>,
  subjectSql: string,
): string {
  const owner = buildOwnerPredicate(normalized, subjectSql);

  if (!normalized.managerRoleSqlColumn) {
    return owner;
  }

  return `(${owner}) OR ${buildMembershipMatchSqlText(normalized, subjectSql, true)}`;
}

export function buildSupabaseMembershipNativePolicies(options: SupabaseMembershipNativePoliciesOptions) {
  const normalized = normalizeMembershipOptions(options);
  const subjectSql = buildSubjectSqlText(normalized.subjectCastType);

  const memberPredicate = buildMembershipMatchSqlText(normalized, subjectSql, false);
  const ownerAndMember = `(${buildOwnerPredicate(normalized, subjectSql)}) AND ${memberPredicate}`;
  const ownerOrManager = buildOwnerOrManagerPredicate(normalized, subjectSql);

  const predicateFor = (command: MembershipPolicyKind): string => {
    switch (command) {
      case "select":
        return memberPredicate;
      case "insert":
        return ownerAndMember;
      case "update":
      case "delete":
        return ownerOrManager;
    }
  };

  return membershipPolicyShapes.map((shape) => {
    const predicate = sql.raw(predicateFor(shape.command));

    return pgPolicy(`${options.tableName}_${shape.command}_membership`, {
      as: "permissive",
      for: shape.command,
      to: options.role,
      ...(shape.using ? { using: predicate } : {}),
      ...(shape.withCheck ? { withCheck: predicate } : {}),
    });
  });
}
