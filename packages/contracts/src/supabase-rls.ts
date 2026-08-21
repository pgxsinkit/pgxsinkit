import { and, eq, getTableName, or, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { PgDialect, pgPolicy, type AnyPgTable, type PgRole } from "drizzle-orm/pg-core";

import { buildOwnershipShapePredicate, DENY_ALL_PREDICATE, type JwtClaims } from "./config";
import { p, type Predicate } from "./predicate";

// Render a typed fragment to inline-literal SQL text (CREATE POLICY DDL cannot carry `$n` binds).
// The tier-② discipline for the text builders below: values enter as typed `${value}` interpolations
// and drizzle owns the escaping; only the claim-extraction leaves stay raw text.
const textDialect = new PgDialect();
function renderInlineSql(fragment: SQL): string {
  return textDialect.sqlToQuery(fragment.inlineParams()).sql;
}

// Walk a dotted claim path defensively (unverified claims may be any shape): anything that is not a
// plain object on the way down yields `undefined` rather than throwing. Shared by every Electric
// read-path mirror below — each family's mirror sits beside its own policies and reads exactly the
// claim the policy's SQL reads.
function readClaimsPath(claims: JwtClaims | null, path: string[]): unknown {
  let current: unknown = claims;
  for (const segment of path) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

// The JWT subject as the read path sees it: a non-empty `sub` string, else null (no subject → the
// mirrors deny). The RLS counterpart is `buildSubjectSqlText`, which reads the same claim in Postgres.
function readSubjectClaim(claims: JwtClaims | null): string | null {
  const subject = readClaimsPath(claims, ["sub"]);
  return typeof subject === "string" && subject.length > 0 ? subject : null;
}

type SupabaseOwnerOrAdminPolicyKind = "select" | "insert" | "update" | "delete";

type SupabaseOwnerOrAdminPolicyShape = {
  command: SupabaseOwnerOrAdminPolicyKind;
  using: boolean;
  withCheck: boolean;
};

// Options for the raw predicate *text* builder (`buildSupabaseOwnerOrAdminPredicateSqlText`) — the
// documented escape hatch that returns the predicate as a SQL string (for a hand-written trigger or
// migration). It takes a column *name* because text has no column object. The native policy builder
// below takes a real Drizzle column instead.
export type SupabaseOwnerOrAdminPredicateOptions = {
  ownerSqlColumn?: string;
  adminRoleName?: string;
  subjectCastType?: string;
  /** Path to the roles array in the claims. Defaults to {@link adminRolesClaimPath}. */
  adminRolesClaimPath?: readonly string[];
};

export type SupabaseOwnerOrAdminNativePoliciesOptions = {
  /** Owner column on the governed row (e.g. `authors.ownerId`). The governed table name is derived from it. */
  ownerColumn: AnyColumn;
  role: PgRole;
  /** Role value (in `app_metadata.roles`) that bypasses ownership (default "admin"). */
  adminRoleName?: string;
  /** SQL type the JWT subject is cast to before comparison (default "uuid"). */
  subjectCastType?: string;
  /**
   * Path to the roles array in the claims. Defaults to {@link adminRolesClaimPath}; pass the SAME value to
   * {@link resolveOwnerOrAdminAccess} / {@link buildOwnerOrAdminShapePredicate} so both surfaces read one claim.
   */
  adminRolesClaimPath?: readonly string[];
};

const defaultOwnerSqlColumn = "owner_id";
const defaultOwnerPropertyKey = "ownerId";
const defaultAuthenticatedRoleName = "authenticated";
const defaultAdminRoleName = "admin";
const defaultSubjectCastType = "uuid";
// The DEFAULT claim path the admin check reads — the single source for BOTH surfaces: the SQL `EXISTS`
// in `buildAdminRoleExistsSqlText` renders its `-> 'seg'` chain from this array, and the read-path mirror
// (`resolveOwnerOrAdminAccess`) walks the same segments in JS. Overridable per call via
// `adminRolesClaimPath` on either surface — pass the same value to both or they drift.
const adminRolesClaimPath = ["app_metadata", "roles"] as const;

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

function buildOwnerOrAdminPolicyName(tableName: string, command: SupabaseOwnerOrAdminPolicyKind) {
  return `${tableName}_${command}_owner_or_admin`;
}

// ---------------------------------------------------------------------------
// Shared predicate leaves (used by both policy families). RLS is the *write* path
// (Postgres), so columns may serialize qualified — unlike the Electric read `where`,
// which needs bare columns. The only bits that stay raw `sql` are genuinely-Postgres
// expressions with no Drizzle operator: the JWT-subject `(select current_setting(...)::type)`
// and the admin-roles `EXISTS`. Literal values use `eq(col, value).inlineParams()` so the
// value is inlined into the DDL — a bare `$n` is something `CREATE POLICY` cannot carry.
// ---------------------------------------------------------------------------

// The governed table name (for policy identifiers) derived from a built Drizzle column, so renaming
// the table renames its policies. Columns built inside `defineSyncTable`'s `extras` callback carry
// their `.table` — which is where these builders are meant to be called (the table object does not
// yet exist when its own `policies:` array would be built).
function tableNameForColumn(column: AnyColumn, label: string): string {
  const table = (column as { table?: AnyPgTable }).table;
  if (!table) {
    throw new Error(
      `${label} must be a built Drizzle column carrying its table — call this builder inside defineSyncTable's \`extras\` callback`,
    );
  }
  return getTableName(table);
}

// The JWT subject as a Postgres expression (irreducibly raw: `current_setting` + cast). Used as the
// right-hand side of `eq(ownerColumn, subject)` — eq splices an SQL fragment verbatim (no bound
// param), so the DDL carries the literal expression, not a `$n` CREATE POLICY cannot bind. Wrapped in
// a scalar subquery — the Supabase RLS performance idiom: the stable `current_setting` expression is
// evaluated once per statement (InitPlan), not once per row.
function buildSubjectSql(subjectCastType: string): SQL {
  assertTypeName(subjectCastType, "subjectCastType");
  return sql.raw(`(select ${buildSubjectSqlText(subjectCastType)})`);
}

function buildSubjectSqlText(subjectCastType: string): string {
  return `coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::${subjectCastType}`;
}

// The claim path the admin check walks, validated as plain identifiers (they are emitted into policy
// DDL). Mirrors `resolveGrantsClaimPath` in the grant-scope family below.
function resolveAdminRolesClaimPath(path: readonly string[] | undefined): string[] {
  const segments = path && path.length > 0 ? [...path] : [...adminRolesClaimPath];
  for (const segment of segments) {
    assertIdentifier(segment, "adminRolesClaimPath segment");
  }
  return segments;
}

// The claim path as a jsonb `-> 'seg'` chain, one typed interpolation per segment (drizzle owns the
// quoting), so the SQL walks the SAME array the JS mirror walks — textual agreement is not enough.
function buildClaimPathChainSql(path: string[]): SQL {
  return sql.join(
    path.map((segment) => sql` -> ${segment}`),
    sql``,
  );
}

// An extracted claim as an ARRAY or nothing at all — the SQL twin of the mirrors' "an unverified claim
// of the wrong shape confers nothing". Absent/null already yields `[]`; the load-bearing case is a
// claim that is PRESENT but not an array (a token hook emitting `roles: "admin"` instead of
// `["admin"]`), which would otherwise reach `jsonb_array_elements(_text)` and raise "cannot extract
// elements from a scalar/object" — turning every governed write into an RLS execution ERROR instead of
// a clean deny. Wrapped here, a non-array claim behaves exactly like an absent one, so the policy
// reaches the same verdict as `resolveOwnerOrAdminAccess` / `resolveGrantScopeAccess`.
// The expression is repeated (Postgres has nowhere to bind it inside a policy predicate); it is a
// stable per-statement expression, so the planner evaluates it once, not per row.
function buildClaimArraySqlText(claimSqlText: string): string {
  return `case jsonb_typeof(${claimSqlText}) when 'array' then ${claimSqlText} else '[]'::jsonb end`;
}

// The admin-bypass test: the roles array at `adminRolesClaimPath` (from the JWT claims) contains
// `adminRoleName`. No column reference and no recursion risk, so it is inlined as text (shared by the
// text builder and the native builder). The role value and the claim-path segments enter as typed
// interpolations (drizzle owns the escaping); the claim-extraction body is the allowed raw leaf, and it
// goes through {@link buildClaimArraySqlText} so a malformed `roles` denies instead of erroring.
function buildAdminRoleExistsSqlText(adminRoleName: string, claimPath: string[]): string {
  const rolesClaim = renderInlineSql(sql`(
          coalesce(
            nullif(current_setting('request.jwt.claim', true), ''),
            nullif(current_setting('request.jwt.claims', true), '')
          )::jsonb${buildClaimPathChainSql(claimPath)}
        )`);

  return renderInlineSql(sql`EXISTS (
    SELECT 1
    FROM jsonb_array_elements_text(
      ${sql.raw(buildClaimArraySqlText(rolesClaim))}
    ) AS assigned_role(role_name_value)
    WHERE assigned_role.role_name_value = ${adminRoleName}
  )`);
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
    claimPath: resolveAdminRolesClaimPath(options.adminRolesClaimPath),
  };
}

/**
 * The owner-or-admin predicate as raw SQL **text** — the escape hatch for when you need the predicate
 * as a string (a hand-written trigger, a manual migration). For attaching RLS to a Drizzle table,
 * prefer `buildSupabaseOwnerOrAdminNativePolicies`, which takes the real column and is rename-tracked.
 */
export function buildSupabaseOwnerOrAdminPredicateSqlText(options: SupabaseOwnerOrAdminPredicateOptions = {}): string {
  const normalized = normalizePredicateOptions(options);

  return `
  ${normalized.ownerSqlColumn} = ${buildSubjectSqlText(normalized.subjectCastType)}
  OR ${buildAdminRoleExistsSqlText(normalized.adminRoleName, normalized.claimPath)}
`;
}

// owner-or-admin predicate built from the real Drizzle column: `eq(ownerColumn, subject)` (qualified,
// rename-tracked) OR the raw admin-roles EXISTS (no column, no Drizzle operator). The single boolean
// is `or(...)`.
export function buildSupabaseOwnerOrAdminNativePolicies(options: SupabaseOwnerOrAdminNativePoliciesOptions) {
  const adminRoleName = options.adminRoleName ?? defaultAdminRoleName;
  const subject = buildSubjectSql(options.subjectCastType ?? defaultSubjectCastType);
  const adminExists = sql.raw(
    buildAdminRoleExistsSqlText(adminRoleName, resolveAdminRolesClaimPath(options.adminRolesClaimPath)),
  );
  const predicate = or(eq(options.ownerColumn, subject), adminExists)!;
  const tableName = tableNameForColumn(options.ownerColumn, "ownerColumn");

  return ownerOrAdminPolicyShapes.map((shape) =>
    pgPolicy(buildOwnerOrAdminPolicyName(tableName, shape.command), {
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
// Electric read-path mirror of the owner-or-admin policies. Electric cannot read RLS, so the proxy has
// to reach the same verdict in JS, from the same claims: the policy's `OR` admin branch becomes "no
// filter at all" (every row streams), and its owner branch becomes the ownership shape `where`. One
// declaration — the owner column plus the admin role name — two enforcement surfaces, so a row can
// never be writable-but-unreadable (or the reverse).
//
// SELECT only, by construction: a shape `where` filters a read stream, so it mirrors the `select`
// policy. INSERT/UPDATE/DELETE remain the policies' business.
// ---------------------------------------------------------------------------

/**
 * Claim-reading options for the read mirror; every field must match the value the policies were built
 * with, or the two surfaces stop agreeing.
 */
export type OwnerOrAdminAccessOptions = {
  /** Role value (in `app_metadata.roles`) that bypasses ownership (default "admin"). */
  adminRoleName?: string;
  /** Path to the roles array in the claims. Defaults to {@link adminRolesClaimPath}. */
  adminRolesClaimPath?: readonly string[];
};

/** The caller's standing on an owner-or-admin table, as resolved from the claims. */
export type OwnerOrAdminAccess = {
  /** The caller holds the admin role — the policy's bypass branch; every row is visible. */
  admin: boolean;
  /** The JWT subject when it is a non-empty string, else null (no subject → nothing is visible). */
  subject: string | null;
};

/**
 * The caller's owner-or-admin standing, resolved from the JWT claims — the JS mirror of the policy's
 * admin `EXISTS` and its subject comparison. `admin` is true when the roles array at
 * `adminRolesClaimPath` (`app_metadata.roles` by default — the very array
 * {@link buildSupabaseOwnerOrAdminNativePolicies} renders its `-> 'seg'` chain from, so the two surfaces
 * read one declaration) contains `adminRoleName`; `subject` is the `sub` claim when it is a non-empty
 * string, else null.
 *
 * Claims arrive unverified in shape, so this never throws: a missing/non-object claims bag, a
 * non-array `roles`, or non-string members simply confer nothing.
 */
export function resolveOwnerOrAdminAccess(
  claims: JwtClaims | null,
  options: OwnerOrAdminAccessOptions = {},
): OwnerOrAdminAccess {
  const adminRoleName = options.adminRoleName ?? defaultAdminRoleName;
  const roles = readClaimsPath(claims, resolveAdminRolesClaimPath(options.adminRolesClaimPath));
  const admin = Array.isArray(roles) && roles.some((role) => typeof role === "string" && role === adminRoleName);

  return { admin, subject: readSubjectClaim(claims) };
}

/**
 * The owner-or-admin **predicate** — the native-path counterpart to
 * the owner-or-admin `select` policy, from the same declaration. An admin gets `null` (no filter,
 * every row — the policy's bypass branch); anyone else gets {@link buildOwnershipShapePredicate}.
 */
export function buildOwnerOrAdminShapePredicate(
  ownerColumn: AnyColumn,
  claims: JwtClaims | null,
  options: OwnerOrAdminAccessOptions = {},
): Predicate | null {
  const access = resolveOwnerOrAdminAccess(claims, options);
  return access.admin ? null : buildOwnershipShapePredicate(ownerColumn, access.subject);
}

// ---------------------------------------------------------------------------
// Membership-scoped policies (generic). A row belongs to a *container* and is
// visible/writable through membership of that container — not just ownership.
// This is the readwrite counterpart to a membership row-filter: every member of
// the container may read the row (fan-out to non-owners); only the owner may
// create it (as themselves) and edit it, while a container *manager* may moderate
// any row. Domain-agnostic: the container, membership table, and manager role are
// all parameters.
//
// The container, membership, and owner references are **real Drizzle columns/tables**
// (not name strings), so the policy tracks the schema — a column or table rename is a
// compile error, and the governed table name is *derived* from the container column
// (no redundant `tableName` to drift). Predicate structure is built with Drizzle
// operators (`and`/`or`/`eq`, with `.inlineParams()` on the `'manager'` / `false` literals so
// they inline instead of becoming a `$n` CREATE POLICY cannot carry); only the irreducibly-Postgres
// leaves stay `sql`: the `IN (subquery)` containment (Drizzle's `inArray` cannot wrap a raw subquery)
// and the `(select current_setting(...)::type)` JWT-subject expression (wrapped in a scalar subquery —
// the Supabase per-statement-eval RLS perf idiom). Columns serialize qualified
// (`"work_items"."workspace_id"`) — fine for Postgres RLS (the write path, unlike Electric's bare rule).
//
// The `select` half of this family is mirrored on the read path by
// {@link buildMembershipShapePredicate}, built from the same column declarations — the sync engine cannot
// read RLS, so the two surfaces are generated from one declaration and must agree.
// ---------------------------------------------------------------------------

type MembershipPolicyKind = "select" | "insert" | "update" | "delete";

export type SupabaseMembershipPredicateColumns = {
  /** Column on the governed row naming its container (e.g. `workItems.workspaceId`). */
  containerColumn: AnyColumn;
  /** Membership link table (e.g. the `workspace_members` table). */
  membershipTable: AnyPgTable;
  /** Container column on the membership link table (e.g. `workspaceMembers.workspaceId`). */
  membershipContainerColumn: AnyColumn;
  /** Subject (member) column on the membership link table, compared to the JWT sub. */
  membershipSubjectColumn: AnyColumn;
  /** Owner column on the governed row (e.g. `workItems.ownerId`). */
  ownerColumn: AnyColumn;
  /** Optional role column on the membership link enabling manager moderation. */
  managerRoleColumn?: AnyColumn;
  /** Role value that grants moderation (default "manager"); only used with managerRoleColumn. */
  managerRoleValue?: string;
  /** SQL type the JWT subject is cast to before comparison (default "uuid"). */
  subjectCastType?: string;
};

// Optional write-state gate (generic). When supplied, INSERT and UPDATE are additionally gated on
// mutable state: a *locked* container admits writes only from a manager (e.g. a frozen discussion
// thread), and a *muted* member may not write at all. SELECT and DELETE are unaffected — reads and
// moderation deletes still flow. Domain-agnostic: the container/lock and membership/mute columns are
// parameters. Requires managerRoleColumn (managers bypass the lock).
export type SupabaseMembershipWriteGateColumns = {
  /** Container table holding the lock flag (e.g. the `workspaces` table). */
  containerTable: AnyPgTable;
  /** PK column on the container table the governed row's container column references (e.g. `workspaces.id`). */
  containerPkColumn: AnyColumn;
  /** Boolean column on the container table; when true, only a manager may write (e.g. `workspaces.locked`). */
  containerLockColumn: AnyColumn;
  /** Boolean column on the membership table; when true, that member may not write (e.g. `workspaceMembers.muted`). */
  membershipMutedColumn: AnyColumn;
};

export type SupabaseMembershipNativePoliciesOptions = SupabaseMembershipPredicateColumns & {
  role: PgRole;
  /** Optional write-state gate applied to INSERT and UPDATE only. */
  writeGate?: SupabaseMembershipWriteGateColumns;
};

const defaultManagerRoleValue = "manager";

const membershipPolicyShapes: { command: MembershipPolicyKind; using: boolean; withCheck: boolean }[] = [
  { command: "select", using: true, withCheck: false },
  { command: "insert", using: false, withCheck: true },
  { command: "update", using: true, withCheck: true },
  { command: "delete", using: true, withCheck: false },
];

type NormalizedMembershipColumns = SupabaseMembershipPredicateColumns & {
  managerRoleValue: string;
  subjectCastType: string;
};

function normalizeMembershipColumns(options: SupabaseMembershipPredicateColumns): NormalizedMembershipColumns {
  return {
    ...options,
    managerRoleValue: options.managerRoleValue ?? defaultManagerRoleValue,
    subjectCastType: options.subjectCastType ?? defaultSubjectCastType,
  };
}

// Containment form (not a correlated EXISTS): the governed row's container column must be in the set
// of containers the subject belongs to. Two reasons it is `= ANY(ARRAY(subquery))` and not
// `IN (subquery)`, both load-bearing:
//   1. Correctness — the subquery stays uncorrelated (its `WHERE` references only the subject), so the
//      membership table's same-named column can't shadow the outer container column. A correlated
//      `EXISTS (… WHERE m.container = container …)` would collapse the correlation.
//   2. Performance — for a runtime-resolved set (the subject comes from `current_setting`, opaque to
//      the planner) `IN (subquery)` is costed as a hashed semi-join → **sequential scan** of the
//      governed table; `= ANY(ARRAY(subquery))` materializes the set once (InitPlan) and the
//      ScalarArrayOp drives a **bitmap index scan**. At scale that is ~25-45× faster (the rls-read
//      perf track proves it). `inArray` can't wrap a raw subquery, so this stays `sql`.
function membershipMatch(cols: NormalizedMembershipColumns, subject: SQL, requireManager: boolean): SQL {
  const subjectIsMember = eq(cols.membershipSubjectColumn, subject);
  const where =
    requireManager && cols.managerRoleColumn
      ? and(subjectIsMember, eq(cols.managerRoleColumn, cols.managerRoleValue).inlineParams())!
      : subjectIsMember;

  return sql`${cols.containerColumn} = any(array(select ${cols.membershipContainerColumn} from ${cols.membershipTable} where ${where}))`;
}

/** owner-or-manager predicate (edit / moderate). */
function ownerOrManager(cols: NormalizedMembershipColumns, subject: SQL): SQL {
  const owner = eq(cols.ownerColumn, subject);
  return cols.managerRoleColumn ? or(owner, membershipMatch(cols, subject, true))! : owner;
}

// write-state gate: ((container not locked) OR caller is a manager) AND caller's membership not muted.
// Same `= ANY(ARRAY(subquery))` containment discipline as membershipMatch (uncorrelated set, index-scan
// friendly), so the container/membership tables can reuse their own column names without shadowing the
// governed row's container column.
function membershipWriteGate(
  cols: NormalizedMembershipColumns,
  gate: SupabaseMembershipWriteGateColumns,
  subject: SQL,
): SQL {
  const unlocked = sql`${cols.containerColumn} = any(array(select ${gate.containerPkColumn} from ${gate.containerTable} where ${eq(gate.containerLockColumn, false).inlineParams()}))`;
  const notMuted = sql`${cols.containerColumn} = any(array(select ${cols.membershipContainerColumn} from ${cols.membershipTable} where ${and(eq(cols.membershipSubjectColumn, subject), eq(gate.membershipMutedColumn, false).inlineParams())}))`;
  return and(or(unlocked, membershipMatch(cols, subject, true))!, notMuted)!;
}

export function buildSupabaseMembershipNativePolicies(options: SupabaseMembershipNativePoliciesOptions) {
  const cols = normalizeMembershipColumns(options);
  const subject = buildSubjectSql(cols.subjectCastType);
  const tableName = tableNameForColumn(cols.containerColumn, "containerColumn");

  const memberPredicate = membershipMatch(cols, subject, false);
  const ownerAndMember = and(eq(cols.ownerColumn, subject), memberPredicate)!;
  const ownerOrManagerPredicate = ownerOrManager(cols, subject);

  let writeGateClause: SQL | null = null;
  if (options.writeGate) {
    if (!cols.managerRoleColumn) {
      throw new Error("writeGate requires managerRoleColumn so a manager can write into a locked container");
    }
    writeGateClause = membershipWriteGate(cols, options.writeGate, subject);
  }

  const gatedForWrite = (base: SQL): SQL => (writeGateClause ? and(base, writeGateClause)! : base);

  const predicateFor = (command: MembershipPolicyKind): SQL => {
    switch (command) {
      case "select":
        return memberPredicate;
      case "insert":
        return gatedForWrite(ownerAndMember);
      case "update":
        return gatedForWrite(ownerOrManagerPredicate);
      case "delete":
        return ownerOrManagerPredicate;
    }
  };

  return membershipPolicyShapes.map((shape) => {
    const predicate = predicateFor(shape.command);

    return pgPolicy(`${tableName}_${shape.command}_membership`, {
      as: "permissive",
      for: shape.command,
      to: options.role,
      ...(shape.using ? { using: predicate } : {}),
      ...(shape.withCheck ? { withCheck: predicate } : {}),
    });
  });
}

// ---------------------------------------------------------------------------
// Electric read-path mirror of the membership policies. Electric cannot read RLS, so the proxy must
// re-derive the same visible set in the shape `where`, from the SAME Drizzle columns the policies were
// built from — one declaration, two enforcement surfaces, so a row can never be readable-but-unwritable
// (or the reverse) through a rename or a typo.
//
// SELECT only, by construction: the mirror reproduces the family's `select` predicate — plain
// membership of the container. The owner/manager branches and the write-state gate are WRITE-side
// concerns (INSERT/UPDATE/DELETE) and are deliberately absent here; a shape `where` filters a read
// stream and has nothing to gate.
//
// The two surfaces render the SAME containment differently, on purpose:
//   - RLS (`membershipMatch`) renders `= ANY(ARRAY(select …))` — the InitPlan/bitmap-index-scan
//     discipline Postgres needs for a runtime-resolved set (see that function's comment).
//   - Electric renders a plain `IN (subquery)`, because that is what Electric's shape `where` grammar
//     accepts; there is no Postgres planner on this side to appease.
// Same columns, two dialects — that is exactly what the mirror is for.
// ---------------------------------------------------------------------------

/**
 * The columns {@link buildMembershipShapePredicate} needs: the SELECT-relevant subset of
 * {@link SupabaseMembershipPredicateColumns}. The write-only fields (owner, manager role, subject cast,
 * write gate, policy role) are accepted but ignored, so the **same declaration object** you hand to
 * {@link buildSupabaseMembershipNativePolicies} can be handed to the read mirror verbatim.
 */
export type SupabaseMembershipShapeColumns = Pick<
  SupabaseMembershipPredicateColumns,
  "containerColumn" | "membershipTable" | "membershipContainerColumn" | "membershipSubjectColumn"
> &
  Partial<SupabaseMembershipNativePoliciesOptions>;

/**
 * The membership **predicate** — the read-path mirror of the membership `select` policy, from the
 * same column declarations.
 *
 * The containment becomes a first-class {@link InSubqueryPredicate} rather than SQL text, which buys
 * something the text form could not: the engine maintains the inner set incrementally and **shares it
 * across every shape referencing the same subquery**, so an entitlement-shaped membership costs one
 * index rather than one per shape. The subquery is uncorrelated, as the engine requires — the inner
 * `where` reads the membership table's own columns only.
 */
export function buildMembershipShapePredicate(
  columns: SupabaseMembershipShapeColumns,
  claims: JwtClaims | null,
): Predicate {
  const subject = readSubjectClaim(claims);
  if (subject === null) {
    return DENY_ALL_PREDICATE;
  }

  return p.in(
    columns.containerColumn,
    p.subquery(columns.membershipContainerColumn, p.eq(columns.membershipSubjectColumn, subject)),
  );
}

// ---------------------------------------------------------------------------
// Grant-scope policies (generic). Authorization is carried IN THE JWT, not a DB
// table: `app_metadata.authorization.grants` is an array of
// `{ role, scope: { kind, <kind>Id } }` minted into the token. A row is visible
// when its scope column (e.g. `offering_id`) appears among the caller's grants for
// one of the accepting roles. Because the grant set lives in the token, the
// predicate needs NO join — it parses the claims jsonb and tests set membership.
//
// Two forms, deliberately:
//   - default (InitPlan-correct): an **uncorrelated** `scope_col IN (SELECT …
//     jsonb_array_elements(claims) …)`. The subquery never references the outer row,
//     so the planner hoists it to an InitPlan and the JWT is parsed **once per
//     statement**.
//   - `naive: true` (the cliff): a **correlated** `EXISTS (… WHERE (g->…->>id) =
//     scope_col)`. Referencing the outer row forces per-row re-evaluation — the JWT
//     is re-parsed for **every row scanned**. It exists only to demonstrate and
//     regression-guard the InitPlan discipline (see the `rls-read-load` perf track);
//     never ship it.
//
// The same grant set is mirrored on the read path by {@link resolveGrantScopeAccess} (or
// {@link resolveGrantScopeIds} for the id set alone) + {@link buildGrantScopeShapePredicate}: the control
// plane resolves the ids from the claims in JS and compiles them into the shape's predicate — the sync
// engine cannot read RLS, so the two surfaces are generated from one declaration and must agree.
// ---------------------------------------------------------------------------

type GrantScopePolicyKind = "select" | "insert" | "update" | "delete";

const defaultGrantsClaimPath = ["app_metadata", "authorization", "grants"] as const;
const defaultGrantScopeCastType = "uuid";
// Scope kind a bypass grant must carry, on BOTH surfaces: the policy's `buildBypassExistsSqlText`
// inlines it and the read mirror's `resolveGrantScopeAccess` compares against it.
const defaultBypassScopeKind = "platform";

/**
 * An unconditional bypass declaration: any grant whose `role` ∈ `roleValues` and whose `scope.kind` =
 * `scopeKind` (default `"platform"`) confers access to every row — e.g. a platform-scoped
 * `platform_admin`. Hand the SAME object to the policy builder and to
 * {@link resolveGrantScopeAccess} / {@link buildGrantScopeAccessShapePredicate}.
 */
export type GrantScopeBypassOptions = {
  roleValues: string[];
  scopeKind?: string;
};

export type GrantScopeClaimOptions = {
  /** Value matched against each grant's `scope.kind` (e.g. "offering"). */
  scopeKind: string;
  /** Grant `role` values that confer access (e.g. ["teacher", "assistant"]). */
  roleValues: string[];
  /** Field within `scope` holding the id (e.g. "offeringId"). Defaults to `${scopeKind}Id`. */
  scopeIdField?: string;
  /** Path to the grants array in the claims. Defaults to `app_metadata.authorization.grants`. */
  grantsClaimPath?: string[];
};

export type SupabaseGrantScopePredicateColumns = GrantScopeClaimOptions & {
  /** Column on the governed row naming its scope (e.g. `offerings.id` reference column). Table name is derived from it. */
  scopeColumn: AnyColumn;
  /** SQL type the extracted grant id is cast to before comparison (default "uuid"). */
  scopeCastType?: string;
  /**
   * Optional unconditional bypass ({@link GrantScopeBypassOptions}): any grant whose `role` ∈
   * `bypass.roleValues` and whose `scope.kind` = `bypass.scopeKind` (default "platform") grants all
   * rows — e.g. a platform-scoped `platform_admin`. The bypass is an **uncorrelated** EXISTS, so it
   * stays InitPlan-hoisted in both the correct and naive forms. Its read-path twin is
   * {@link buildGrantScopeAccessShapePredicate} (bypass → `null`, i.e. no shape filter at all).
   */
  bypass?: GrantScopeBypassOptions;
};

export type SupabaseGrantScopeNativePoliciesOptions = SupabaseGrantScopePredicateColumns & {
  role: PgRole;
  /** Emit the deliberately-naive per-row correlated form (cliff demo / regression guard only). */
  naive?: boolean;
};

const grantScopePolicyShapes: { command: GrantScopePolicyKind; using: boolean; withCheck: boolean }[] = [
  { command: "select", using: true, withCheck: false },
  { command: "insert", using: false, withCheck: true },
  { command: "update", using: true, withCheck: true },
  { command: "delete", using: true, withCheck: false },
];

function resolveGrantsClaimPath(path: readonly string[] | undefined): string[] {
  const segments = path && path.length > 0 ? [...path] : [...defaultGrantsClaimPath];
  for (const segment of segments) {
    assertIdentifier(segment, "grantsClaimPath segment");
  }
  return segments;
}

// The grants array as a Postgres jsonb expression, guarded by {@link buildClaimArraySqlText} so
// `jsonb_array_elements` never errors: an absent, null, OR non-array grants claim all yield `[]`, i.e.
// no grants — the same "confers nothing" verdict `resolveGrantScopeAccess` reaches in JS. Shared by the
// scope predicate (both forms) and the bypass EXISTS. `#>` takes a text[] path; the segments are
// validated identifiers, so the `'{…}'` path literal is injection-safe.
function buildGrantsArraySqlText(path: string[]): string {
  return buildClaimArraySqlText(`(
      coalesce(
        nullif(current_setting('request.jwt.claim', true), ''),
        nullif(current_setting('request.jwt.claims', true), '')
      )::jsonb #> '{${path.join(",")}}'
    )`);
}

function buildRoleInListSqlText(roleValues: string[]): string {
  if (roleValues.length === 0) {
    throw new Error("grant-scope policy requires at least one role value");
  }
  return renderInlineSql(
    sql.join(
      roleValues.map((role) => sql`${role}`),
      sql`, `,
    ),
  );
}

function resolveGrantScopeIdField(options: GrantScopeClaimOptions): string {
  const field = options.scopeIdField ?? `${options.scopeKind}Id`;
  assertIdentifier(field, "scopeIdField");
  return field;
}

// Uncorrelated bypass test (never references the governed row), so it is InitPlan-hoisted in both forms.
function buildBypassExistsSqlText(bypass: GrantScopeBypassOptions, grantsText: string): string {
  const scopeKind = bypass.scopeKind ?? defaultBypassScopeKind;
  return `exists (
    select 1
    from jsonb_array_elements(${grantsText}) as bypass_grant
    where bypass_grant -> 'scope' ->> 'kind' = ${renderInlineSql(sql`${scopeKind}`)}
      and bypass_grant ->> 'role' in (${buildRoleInListSqlText(bypass.roleValues)})
  )`;
}

function buildGrantScopePredicate(options: SupabaseGrantScopeNativePoliciesOptions): SQL {
  const scopeKind = options.scopeKind;
  assertIdentifier(scopeKind, "scopeKind");
  const scopeIdField = resolveGrantScopeIdField(options);
  const castType = options.scopeCastType ?? defaultGrantScopeCastType;
  assertTypeName(castType, "scopeCastType");
  const grantsText = buildGrantsArraySqlText(resolveGrantsClaimPath(options.grantsClaimPath));
  const roleIn = buildRoleInListSqlText(options.roleValues);
  const kindMatch = `grant_elem -> 'scope' ->> 'kind' = ${renderInlineSql(sql`${scopeKind}`)} and grant_elem ->> 'role' in (${roleIn})`;
  const idExpr = `(grant_elem -> 'scope' ->> ${renderInlineSql(sql`${scopeIdField}`)})::${castType}`;

  // Correct: uncorrelated `= ANY(ARRAY(select …))` → the grant set materializes once (InitPlan, JWT
  // parsed once) and the ScalarArrayOp drives a bitmap index scan on the scope column — ~25-45× faster
  // at scale than `IN (select …)`, which the planner costs as a hashed semi-join → sequential scan (the
  // rls-read perf track proves both). Naive: correlated `EXISTS` referencing the governed scope column →
  // re-evaluated per row (JWT parsed per row). The column object is spliced so it serializes qualified —
  // valid CREATE POLICY DDL on the write path.
  const base = options.naive
    ? sql`exists (select 1 from jsonb_array_elements(${sql.raw(grantsText)}) as grant_elem where ${sql.raw(kindMatch)} and ${sql.raw(idExpr)} = ${options.scopeColumn})`
    : sql`${options.scopeColumn} = any(array(select ${sql.raw(idExpr)} from jsonb_array_elements(${sql.raw(grantsText)}) as grant_elem where ${sql.raw(kindMatch)}))`;

  if (!options.bypass) {
    return base;
  }
  return or(base, sql.raw(buildBypassExistsSqlText(options.bypass, grantsText)))!;
}

/**
 * Native Drizzle RLS policies for a JWT-resident grant set (see the section comment). Pass the real
 * scope column; the governed table name is derived from it. By default the predicate is the
 * InitPlan-correct uncorrelated `IN (subquery)`; pass `naive: true` for the correlated cliff variant.
 */
export function buildSupabaseGrantScopeNativePolicies(options: SupabaseGrantScopeNativePoliciesOptions) {
  const predicate = buildGrantScopePredicate(options);
  const tableName = tableNameForColumn(options.scopeColumn, "scopeColumn");
  const suffix = options.naive ? "grant_scope_naive" : "grant_scope";

  return grantScopePolicyShapes.map((shape) =>
    pgPolicy(`${tableName}_${shape.command}_${suffix}`, {
      as: "permissive",
      for: shape.command,
      to: options.role,
      ...(shape.using ? { using: predicate } : {}),
      ...(shape.withCheck ? { withCheck: predicate } : {}),
    }),
  );
}

// ---------------------------------------------------------------------------
// Electric read-path mirror of the grant-scope policy. Electric cannot read RLS, so the proxy must
// resolve the same visible scope-id set from the claims in JS and inject a literal `IN (…)` shape
// `where`. These helpers are the read-path counterpart to the policy above — one declaration,
// two enforcement surfaces, derived from the same grant data so they cannot drift.
//
// The policy's OR bypass branch has a mirror too: {@link resolveGrantScopeAccess} reports it and
// {@link buildGrantScopeAccessShapePredicate} turns it into `null` — no shape filter at all, every row
// streams — exactly as the `exists (…)` OR-branch makes the scope test irrelevant on the write side.
// Without it a bypass grant would be enforced on writes yet invisible on reads.
// ---------------------------------------------------------------------------

/**
 * The set of scope ids the caller can see, resolved from the JWT grants — the JS mirror of the
 * grant-scope RLS subquery. Returns a de-duplicated list (empty → no rows visible).
 */
export function resolveGrantScopeIds(claims: JwtClaims | null, options: GrantScopeClaimOptions): string[] {
  const grants = readClaimsPath(claims, resolveGrantsClaimPath(options.grantsClaimPath));
  if (!Array.isArray(grants)) {
    return [];
  }

  const scopeIdField = resolveGrantScopeIdField(options);
  const roleValues = new Set(options.roleValues);
  const ids = new Set<string>();

  for (const grant of grants) {
    if (typeof grant !== "object" || grant === null) {
      continue;
    }
    const record = grant as Record<string, unknown>;
    if (!roleValues.has(String(record["role"]))) {
      continue;
    }
    const scope = record["scope"];
    if (typeof scope !== "object" || scope === null) {
      continue;
    }
    const scopeRecord = scope as Record<string, unknown>;
    if (scopeRecord["kind"] !== options.scopeKind) {
      continue;
    }
    const id = scopeRecord[scopeIdField];
    if (typeof id === "string" && id.length > 0) {
      ids.add(id);
    }
  }

  return [...ids];
}

/**
 * The grant-scope **predicate** — the read-path mirror of the grant-scope `select` policy.
 * An empty id set denies all rows ({@link DENY_ALL_PREDICATE}), mirroring the policy returning no rows.
 *
 * An `OR` of equalities, not an `IN`: the engine's `In` leaf takes a *subquery*, and a grant set lives
 * in the JWT rather than in a table, so there is nothing to select from. This is not a workaround —
 * `OR(=v…)` is exactly what the engine's own SQL parser desugars `IN (list)` to, so the two forms
 * compile to the same nodes.
 */
export function buildGrantScopeShapePredicate(scopeColumn: AnyColumn, ids: string[]): Predicate {
  if (ids.length === 0) {
    return DENY_ALL_PREDICATE;
  }
  const equalities = ids.map((id) => p.eq(scopeColumn, id));
  return equalities.length === 1 ? equalities[0]! : p.or(...equalities);
}

/** The full grant-scope declaration the read mirror needs: the claim options plus the optional bypass. */
export type GrantScopeAccessOptions = GrantScopeClaimOptions & {
  /** The same {@link GrantScopeBypassOptions} handed to {@link buildSupabaseGrantScopeNativePolicies}. */
  bypass?: GrantScopeBypassOptions;
};

/** The caller's standing on a grant-scope table, as resolved from the claims. */
export type GrantScopeAccess = {
  /** A bypass grant is present — the policy's OR branch; every row is visible. */
  bypass: boolean;
  /** The de-duplicated scope ids the caller can see (empty → no rows, absent a bypass). */
  ids: string[];
};

// The JS mirror of `buildBypassExistsSqlText`: a grant whose `role` is one of `bypass.roleValues` and
// whose `scope.kind` is `bypass.scopeKind` (defaulting to the same `defaultBypassScopeKind` the SQL
// inlines). Claims arrive unverified in shape, so nothing here throws — a non-array grants claim, a
// non-object grant, or a missing `scope` simply confers nothing.
function hasGrantScopeBypass(claims: JwtClaims | null, options: GrantScopeAccessOptions): boolean {
  const bypass = options.bypass;
  if (!bypass) {
    return false;
  }

  const grants = readClaimsPath(claims, resolveGrantsClaimPath(options.grantsClaimPath));
  if (!Array.isArray(grants)) {
    return false;
  }

  const scopeKind = bypass.scopeKind ?? defaultBypassScopeKind;
  const roleValues = new Set(bypass.roleValues);

  for (const grant of grants) {
    if (typeof grant !== "object" || grant === null) {
      continue;
    }
    const record = grant as Record<string, unknown>;
    if (!roleValues.has(String(record["role"]))) {
      continue;
    }
    const scope = record["scope"];
    if (typeof scope !== "object" || scope === null) {
      continue;
    }
    if ((scope as Record<string, unknown>)["kind"] === scopeKind) {
      return true;
    }
  }

  return false;
}

/**
 * The caller's grant-scope standing, resolved from the JWT grants — the JS mirror of the whole policy
 * predicate, both branches: `ids` is {@link resolveGrantScopeIds} (the scope-set subquery) and `bypass`
 * mirrors the policy's OR `exists (…)` branch. One declaration, two enforcement surfaces: pass the SAME
 * options object you gave {@link buildSupabaseGrantScopeNativePolicies} and a bypass grant cannot be
 * enforced on writes yet invisible on reads.
 *
 * Never throws on malformed claims (they reach a `customPredicate` unverified in shape) — a wrong shape
 * simply confers nothing. A malformed `grantsClaimPath`/`scopeIdField` **option** is still a loud error.
 */
export function resolveGrantScopeAccess(claims: JwtClaims | null, options: GrantScopeAccessOptions): GrantScopeAccess {
  return {
    bypass: hasGrantScopeBypass(claims, options),
    ids: resolveGrantScopeIds(claims, options),
  };
}

/**
 * The grant-scope **predicate**, bypass included — the native-path counterpart to
 * the grant-scope `select` policy, from the same declaration. A caller holding a bypass grant
 * gets `null` (no filter, every row); anyone else gets {@link buildGrantScopeShapePredicate} over
 * their resolved ids.
 */
export function buildGrantScopeAccessShapePredicate(
  scopeColumn: AnyColumn,
  claims: JwtClaims | null,
  options: GrantScopeAccessOptions,
): Predicate | null {
  const access = resolveGrantScopeAccess(claims, options);
  return access.bypass ? null : buildGrantScopeShapePredicate(scopeColumn, access.ids);
}
