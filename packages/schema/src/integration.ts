import { sql } from "drizzle-orm";
import { bigint, boolean, pgEnum, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { authenticatedRole } from "drizzle-orm/supabase";

import {
  buildSupabaseMembershipNativePolicies,
  buildSupabaseOwnerOrAdminNativePolicies,
  c,
  defineSyncRegistry,
  defineSyncTable,
  type JwtClaims,
  type SyncConfigInput,
  type TableSpecInput,
} from "@pgxsinkit/contracts";

const nowMicrosecondsSql = sql`CAST(FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000000) AS BIGINT)`;

const makeProjectsColumns = () => ({
  id: uuid("id").primaryKey(),
  name: varchar("name", { length: 120 }).notNull(),
  scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
  createdAtUs: bigint("created_at_us", { mode: "bigint" }).notNull().default(nowMicrosecondsSql),
  updatedAtUs: bigint("updated_at_us", { mode: "bigint" }).notNull().default(nowMicrosecondsSql),
});

const projectsSyncEntry = defineSyncTable({
  tableName: "projects",
  makeColumns: makeProjectsColumns,
  mode: "readwrite",
  // ADR-0015: reject-if-stale — the focused conflict-detection proof table (no RLS, single Server
  // version column), so an interleaving external write surfaces a conflict instead of clobbering.
  conflictPolicy: "reject-if-stale",
  governance: {
    // ADR-0010: updated_at_us is the Server version — server-stamped, strictly monotonic.
    managedFields: [{ column: "updatedAtUs", applyOn: ["create", "update"], strategy: "nowMicroseconds" }],
  },
});

export const projectsTable = projectsSyncEntry.table;
export const projectsView = projectsSyncEntry.view;

export type CreateProjectInput = typeof projectsTable.$inferInsert;

export const projectTableSpecInput = {
  mode: "readwrite",
  primaryKey: {
    columns: ["id"],
  },
  shape: {
    tableName: "projects",
    shapeKey: "projects",
  },
} satisfies TableSpecInput;

export const projectTableSpec = projectTableSpecInput;

export const projectsSyncRegistry = defineSyncRegistry({
  projects: projectsSyncEntry,
});

const fkParentsSyncEntry = defineSyncTable({
  tableName: "fk_parents",
  makeColumns: () => ({
    id: uuid("id").primaryKey(),
    name: varchar("name", { length: 120 }).notNull(),
    updatedAtUs: bigint("updated_at_us", { mode: "bigint" }).notNull().default(nowMicrosecondsSql),
  }),
  mode: "readwrite",
  conflictPolicy: "last-write-wins",
  governance: {
    managedFields: [{ column: "updatedAtUs", applyOn: ["create", "update"], strategy: "nowMicroseconds" }],
  },
});

export const fkParentsTable = fkParentsSyncEntry.table;

const fkChildrenSyncEntry = defineSyncTable({
  tableName: "fk_children",
  makeColumns: () => ({
    id: uuid("id").primaryKey(),
    name: varchar("name", { length: 120 }).notNull(),
    parentId: uuid("parent_id")
      .notNull()
      .references(() => fkParentsTable.id, { name: "fk_children_parent_fk" }),
    updatedAtUs: bigint("updated_at_us", { mode: "bigint" }).notNull().default(nowMicrosecondsSql),
  }),
  mode: "readwrite",
  conflictPolicy: "last-write-wins",
  governance: {
    managedFields: [{ column: "updatedAtUs", applyOn: ["create", "update"], strategy: "nowMicroseconds" }],
    deferrableConstraints: [
      {
        constraintName: "fk_children_parent_fk",
        columns: ["parentId"],
        initiallyDeferred: false,
      },
    ],
  },
});

export const fkChildrenTable = fkChildrenSyncEntry.table;

export const fkSyncRegistry = defineSyncRegistry({
  fk_parents: fkParentsSyncEntry,
  fk_children: fkChildrenSyncEntry,
});

const rlsTodosSyncEntry = defineSyncTable({
  tableName: "rls_todos",
  makeColumns: () => ({
    id: uuid("id").primaryKey(),
    title: varchar("title", { length: 120 }).notNull(),
    ownerId: uuid("owner_id").default(sql`auth.uid()`),
    updatedAtUs: bigint("updated_at_us", { mode: "bigint" }).notNull().default(nowMicrosecondsSql),
  }),
  policies: buildSupabaseOwnerOrAdminNativePolicies({
    tableName: "rls_todos",
    role: authenticatedRole,
    ownerSqlColumn: "owner_id",
  }),
  mode: "readwrite",
  conflictPolicy: "last-write-wins",
  governance: {
    managedFields: [{ column: "updatedAtUs", applyOn: ["create", "update"], strategy: "nowMicroseconds" }],
  },
});

export const rlsTodosTable = rlsTodosSyncEntry.table;

export const rlsSyncRegistry = defineSyncRegistry({
  rls_todos: rlsTodosSyncEntry,
});

// ---------------------------------------------------------------------------
// Scenario A — membership fan-out (readwrite). A domain-agnostic demonstration
// that a readwrite row in a *container* fans out to ALL members of that container
// (not just its owner), via a membership-subquery row-filter on the read path and
// membership-aware RLS on the write path. workspaces + workspace_members are plain
// reference tables (seeded server-side, read only by the filter/policies); work_items
// is the synced readwrite entry that members collaborate on.
// ---------------------------------------------------------------------------

export const workspaceMemberRoleEnum = pgEnum("workspace_member_role", ["member", "manager"]);
export const workItemStatusEnum = pgEnum("work_item_status", ["open", "resolved"]);

// Container + membership are READONLY sync entries: a member syncs the workspaces they belong to and
// their own membership rows (role + muted), so a client can render its membership context locally.
// Read filtering is the proxy customWhere (Electric bypasses RLS on reads); there is no write path,
// hence no RLS. The read filters are attached where the registry is assembled, like work_items.
const workspacesSyncEntry = defineSyncTable({
  tableName: "workspaces",
  makeColumns: () => ({
    id: uuid("id").primaryKey(),
    ownerId: uuid("owner_id"),
    // Display label for UIs; nullable so non-demo fixtures need not set it.
    name: varchar("name", { length: 120 }),
    // Scenario C (write-state gating): when locked, only a manager may write into this workspace.
    locked: boolean("locked").notNull().default(false),
  }),
  mode: "readonly",
});

export const workspacesTable = workspacesSyncEntry.table;

const workspaceMembersSyncEntry = defineSyncTable({
  tableName: "workspace_members",
  makeColumns: () => ({
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspacesTable.id),
    memberId: uuid("member_id").notNull(),
    role: workspaceMemberRoleEnum("role").notNull().default("member"),
    // Scenario C (write-state gating): a muted member may not write, even when the workspace is open.
    muted: boolean("muted").notNull().default(false),
  }),
  mode: "readonly",
});

export const workspaceMembersTable = workspaceMembersSyncEntry.table;

const workItemsSyncEntry = defineSyncTable({
  tableName: "work_items",
  makeColumns: () => ({
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspacesTable.id),
    ownerId: uuid("owner_id"),
    body: varchar("body", { length: 4000 }).notNull(),
    // Surfaced for Scenario B (role-asymmetric read): a manager sees hidden rows a plain member does
    // not. Defaults false, so it is inert for plain membership fan-out (Scenario A).
    hidden: boolean("hidden").notNull().default(false),
    status: workItemStatusEnum("status").notNull().default("open"),
    createdAtUs: bigint("created_at_us", { mode: "bigint" }).notNull().default(nowMicrosecondsSql),
    updatedAtUs: bigint("updated_at_us", { mode: "bigint" }).notNull().default(nowMicrosecondsSql),
  }),
  policies: buildSupabaseMembershipNativePolicies({
    tableName: "work_items",
    role: authenticatedRole,
    containerSqlColumn: "workspace_id",
    membershipTableName: "workspace_members",
    membershipContainerSqlColumn: "workspace_id",
    membershipSubjectSqlColumn: "member_id",
    managerRoleSqlColumn: "role",
    // Scenario C: gate INSERT/UPDATE on a locked workspace (manager-only) and a muted membership.
    writeGate: {
      containerTableName: "workspaces",
      containerPkSqlColumn: "id",
      containerLockSqlColumn: "locked",
      membershipMutedSqlColumn: "muted",
    },
  }),
  mode: "readwrite",
  conflictPolicy: "last-write-wins",
  governance: {
    managedFields: [
      { column: "ownerId", applyOn: ["create"], strategy: "authUid" },
      { column: "createdAtUs", applyOn: ["create"], strategy: "nowMicroseconds" },
      { column: "updatedAtUs", applyOn: ["create", "update"], strategy: "nowMicroseconds" },
    ],
  },
});

export const workItemsTable = workItemsSyncEntry.table;
export const workItemsView = workItemsSyncEntry.view!;

// Read-path fan-out + role-asymmetric visibility (Scenario A + B). A member syncs every *visible*
// work_item in the workspaces they belong to (including items owned by other members); a workspace
// *manager* additionally syncs *hidden* items in the workspaces they manage. So two members of the
// same workspace receive different row sets purely by their per-workspace role — the generic
// mechanism behind "a moderator sees hidden content a regular member does not". The whole predicate
// (two correlated subqueries + a boolean branch) is forwarded verbatim as the Electric shape `where`.
// `role` is a pg enum, so it is cast to text (`"role"::text`) — Electric's where-grammar accepts an
// enum only when the column is cast to text, never a bare enum literal. Returns no rows for an
// unauthenticated subject.
function workspaceVisibilityRowFilter(claims: JwtClaims) {
  if (!claims.sub) {
    return "1 = 0";
  }

  // SPIKE (Option C): the same predicate as before, but built from the actual Drizzle tables — so
  // column names + structure are type-safe and the leaf value (`claims.sub`) is a *bound param*
  // (`$1`/`$2`), never a hand-escaped literal. The proxy serializes this to Electric's `where` +
  // `params[N]`. Two Electric where-grammar constraints shape this: (1) columns must be **plain**
  // references — `"workspace_id"`, never `"work_items"."workspace_id"` — so we emit each column as a
  // bare identifier via `c()` rather than the Drizzle column (which qualifies); the subqueries are
  // self-contained (not correlated), so bare names resolve to each FROM unambiguously. (2) `role` is a
  // pg enum → cast to text.
  const wm = workspaceMembersSyncEntry.table;
  const wi = workItemsSyncEntry.table;
  const sub = claims.sub;
  const c = (column: { name: string }) => sql.identifier(column.name);

  const memberOf = sql`select ${c(wm.workspaceId)} from ${wm} where ${c(wm.memberId)} = ${sub}`;
  const managerOf = sql`select ${c(wm.workspaceId)} from ${wm} where ${c(wm.memberId)} = ${sub} and ${c(wm.role)}::text = 'manager'`;

  return sql`${c(wi.workspaceId)} in (${memberOf}) and (${c(wi.hidden)} = false or ${c(wi.workspaceId)} in (${managerOf}))`;
}

// Read filters for the readonly container/membership tables: a member syncs the workspaces they
// belong to (cross-table membership subquery) and only their own membership rows (simple equality).
// Built from the real Drizzle columns (bare via `c()`) with the subject as a bound param.
function workspacesRowFilter(claims: JwtClaims) {
  if (!claims.sub) {
    return "1 = 0";
  }

  const ws = workspacesSyncEntry.table;
  const wm = workspaceMembersSyncEntry.table;
  return sql`${c(ws.id)} in (select ${c(wm.workspaceId)} from ${wm} where ${c(wm.memberId)} = ${claims.sub})`;
}

function workspaceMembersRowFilter(claims: JwtClaims) {
  if (!claims.sub) {
    return "1 = 0";
  }

  return sql`${c(workspaceMembersSyncEntry.table.memberId)} = ${claims.sub}`;
}

// Server registry: each entry carries its read-filter (applied by the proxy). workspaces +
// workspace_members are readonly; work_items is readwrite with the role-asymmetric visibility filter.
export const membershipFanoutSyncRegistry = defineSyncRegistry({
  workspaces: {
    ...workspacesSyncEntry,
    shape: { ...workspacesSyncEntry.shape!, rowFilter: { customWhere: workspacesRowFilter } },
  },
  workspace_members: {
    ...workspaceMembersSyncEntry,
    shape: { ...workspaceMembersSyncEntry.shape!, rowFilter: { customWhere: workspaceMembersRowFilter } },
  },
  work_items: {
    ...workItemsSyncEntry,
    shape: { ...workItemsSyncEntry.shape!, rowFilter: { customWhere: workspaceVisibilityRowFilter } },
  },
});

// Client config: raw entry (the proxy owns filtering, like the demo split).
export function buildMembershipFanoutSyncConfig(electricUrl: string): SyncConfigInput<{ work_items: TableSpecInput }> {
  return {
    electricUrl,
    tables: {
      work_items: workItemsSyncEntry,
    },
  };
}

// Client config that also syncs the readonly container + membership tables (the demo's full path).
export function buildDemoMembershipSyncConfig(
  electricUrl: string,
): SyncConfigInput<{ workspaces: TableSpecInput; workspace_members: TableSpecInput; work_items: TableSpecInput }> {
  return {
    electricUrl,
    tables: {
      workspaces: workspacesSyncEntry,
      workspace_members: workspaceMembersSyncEntry,
      work_items: workItemsSyncEntry,
    },
  };
}
