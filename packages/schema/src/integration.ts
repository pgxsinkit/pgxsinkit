import { sql } from "drizzle-orm";
import { bigint, boolean, pgEnum, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { authenticatedRole } from "drizzle-orm/supabase";

import {
  buildOwnershipShapePredicate,
  buildSupabaseMembershipNativePolicies,
  buildSupabaseOwnerOrAdminNativePolicies,
  defineSyncRegistry,
  defineSyncTable,
  DENY_ALL_PREDICATE,
  clockMicrosecondsSql,
  p,
  type Predicate,
  type TableSpecInput,
} from "@pgxsinkit/contracts";

const makeProjectsColumns = () => ({
  id: uuid("id").primaryKey(),
  name: varchar("name", { length: 120 }).notNull(),
  scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
  createdAtUs: bigint("created_at_us", { mode: "bigint" }).notNull().default(clockMicrosecondsSql),
  updatedAtUs: bigint("updated_at_us", { mode: "bigint" }).notNull().default(clockMicrosecondsSql),
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
    updatedAtUs: bigint("updated_at_us", { mode: "bigint" }).notNull().default(clockMicrosecondsSql),
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
    updatedAtUs: bigint("updated_at_us", { mode: "bigint" }).notNull().default(clockMicrosecondsSql),
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
    updatedAtUs: bigint("updated_at_us", { mode: "bigint" }).notNull().default(clockMicrosecondsSql),
  }),
  extras: (t) => buildSupabaseOwnerOrAdminNativePolicies({ role: authenticatedRole, ownerColumn: t.ownerId }),
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
// Read filtering is the shape's `customPredicate` (the read path does not run RLS); there is no write
// path, hence no RLS. The read filters are attached where the registry is assembled, like work_items.
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
  shape: {
    rowFilter: (columns) => ({
      customPredicate: (claims): Predicate => {
        if (!claims.sub) return DENY_ALL_PREDICATE;
        const members = workspaceMembersSyncEntry.table;
        return p.in(columns.id, p.subquery(members.workspaceId, p.eq(members.memberId, claims.sub)));
      },
    }),
  },
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
  shape: {
    rowFilter: (columns) => ({
      customPredicate: (claims): Predicate => buildOwnershipShapePredicate(columns.memberId, claims.sub),
    }),
  },
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
    createdAtUs: bigint("created_at_us", { mode: "bigint" }).notNull().default(clockMicrosecondsSql),
    updatedAtUs: bigint("updated_at_us", { mode: "bigint" }).notNull().default(clockMicrosecondsSql),
  }),
  // RLS from the real Drizzle columns (governed columns via the `extras` callback `t`; the
  // membership + container tables are the sibling sync entries above). The governed table name is
  // derived from `t.workspaceId.table`, so no string is hand-written here.
  extras: (t) =>
    buildSupabaseMembershipNativePolicies({
      role: authenticatedRole,
      containerColumn: t.workspaceId,
      ownerColumn: t.ownerId,
      membershipTable: workspaceMembersSyncEntry.table,
      membershipContainerColumn: workspaceMembersSyncEntry.table.workspaceId,
      membershipSubjectColumn: workspaceMembersSyncEntry.table.memberId,
      managerRoleColumn: workspaceMembersSyncEntry.table.role,
      // Scenario C: gate INSERT/UPDATE on a locked workspace (manager-only) and a muted membership.
      writeGate: {
        containerTable: workspacesSyncEntry.table,
        containerPkColumn: workspacesSyncEntry.table.id,
        containerLockColumn: workspacesSyncEntry.table.locked,
        membershipMutedColumn: workspaceMembersSyncEntry.table.muted,
      },
    }),
  mode: "readwrite",
  conflictPolicy: "last-write-wins",
  shape: {
    rowFilter: (columns) => ({
      customPredicate: (claims): Predicate => {
        if (!claims.sub) return DENY_ALL_PREDICATE;
        const members = workspaceMembersSyncEntry.table;
        const sub = claims.sub;
        const memberOf = p.subquery(members.workspaceId, p.eq(members.memberId, sub));
        // The role enum compares without a `::text` cast — the native path carries a typed value.
        const managerOf = p.subquery(
          members.workspaceId,
          p.and(p.eq(members.memberId, sub), p.eq(members.role, "manager")),
        );
        return p.and(
          p.in(columns.workspaceId, memberOf),
          p.or(p.eq(columns.hidden, false), p.in(columns.workspaceId, managerOf)),
        );
      },
    }),
  },
  governance: {
    managedFields: [
      { column: "ownerId", applyOn: ["create"], strategy: "authClaim", claimPath: ["sub"] },
      { column: "createdAtUs", applyOn: ["create"], strategy: "nowMicroseconds" },
      { column: "updatedAtUs", applyOn: ["create", "update"], strategy: "nowMicroseconds" },
    ],
  },
});

export const workItemsTable = workItemsSyncEntry.table;
export const workItemsView = workItemsSyncEntry.view!;

// Server registry: each entry carries its read-filter (applied by the proxy). workspaces +
// workspace_members are readonly; work_items is readwrite with the role-asymmetric visibility filter.
export const membershipFanoutSyncRegistry = defineSyncRegistry({
  workspaces: workspacesSyncEntry,
  workspace_members: workspaceMembersSyncEntry,
  work_items: workItemsSyncEntry,
});

// Client config: raw entry (the proxy owns filtering, like the demo split).
