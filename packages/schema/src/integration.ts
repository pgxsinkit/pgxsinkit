import { sql } from "drizzle-orm";
import { bigint, boolean, pgEnum, pgTable, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { authenticatedRole } from "drizzle-orm/supabase";

import {
  buildSupabaseMembershipNativePolicies,
  buildSupabaseOwnerOrAdminNativePolicies,
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
  }),
  mode: "readwrite",
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
  }),
  mode: "readwrite",
  governance: {
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
  }),
  policies: buildSupabaseOwnerOrAdminNativePolicies({
    tableName: "rls_todos",
    role: authenticatedRole,
    ownerSqlColumn: "owner_id",
  }),
  mode: "readwrite",
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

function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

export const workspaceMemberRoleEnum = pgEnum("workspace_member_role", ["member", "manager"]);
export const workItemStatusEnum = pgEnum("work_item_status", ["open", "resolved"]);

export const workspacesTable = pgTable("workspaces", {
  id: uuid("id").primaryKey(),
  ownerId: uuid("owner_id"),
});

export const workspaceMembersTable = pgTable("workspace_members", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspacesTable.id),
  memberId: uuid("member_id").notNull(),
  role: workspaceMemberRoleEnum("role").notNull().default("member"),
});

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
  }),
  mode: "readwrite",
  governance: {
    managedFields: [
      { column: "ownerId", applyOn: ["create"], strategy: "authUid" },
      { column: "createdAtUs", applyOn: ["create"], strategy: "nowMicroseconds" },
      { column: "updatedAtUs", applyOn: ["create", "update"], strategy: "nowMicroseconds" },
    ],
  },
});

export const workItemsTable = workItemsSyncEntry.table;

// Read-path fan-out (Scenario A): a member syncs every work_item in the workspaces they belong to —
// including items owned by other members. Returns no rows for an unauthenticated subject.
function workspaceMembershipRowFilter(claims: JwtClaims): string | null {
  if (!claims.sub) {
    return "1 = 0";
  }

  return `"workspace_id" IN (SELECT "workspace_id" FROM "workspace_members" WHERE "member_id" = '${escapeSqlLiteral(claims.sub)}')`;
}

// Server registry: work_items carries the membership read-filter (applied by the proxy).
export const membershipFanoutSyncRegistry = defineSyncRegistry({
  work_items: {
    ...workItemsSyncEntry,
    shape: { ...workItemsSyncEntry.shape!, rowFilter: { customWhere: workspaceMembershipRowFilter } },
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
