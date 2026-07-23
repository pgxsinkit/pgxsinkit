import { sql, type SQL } from "drizzle-orm";
import { bigint, pgEnum, uuid, varchar } from "drizzle-orm/pg-core";
import { authenticatedRole } from "drizzle-orm/supabase";

import {
  buildSupabaseOwnerOrAdminNativePolicies,
  c,
  clockMicrosecondsSql,
  defineSyncTable,
  DENY_ALL,
} from "@pgxsinkit/contracts";

export const todoStatusEnum = pgEnum("todo_status", ["todo", "in_progress", "done"]);
export const todoPriorityEnum = pgEnum("todo_priority", ["low", "medium", "high"]);

const makeAuthorsColumns = () => ({
  id: uuid("id").primaryKey(),
  name: varchar("name", { length: 120 }).notNull(),
  ownerId: uuid("owner_id"),
  modifiedBy: uuid("modified_by"),
  createdAtUs: bigint("created_at_us", { mode: "bigint" }).notNull().default(clockMicrosecondsSql),
  updatedAtUs: bigint("updated_at_us", { mode: "bigint" }).notNull().default(clockMicrosecondsSql),
});

const authorsSyncEntry = defineSyncTable({
  tableName: "authors",
  makeColumns: makeAuthorsColumns,
  extras: (t) => buildSupabaseOwnerOrAdminNativePolicies({ role: authenticatedRole, ownerColumn: t.ownerId }),
  mode: "readwrite",
  // ADR-0015: keep the demo author table's historical implicit behaviour, now a named choice.
  conflictPolicy: "last-write-wins",
  shape: {
    rowFilter: (columns) => ({
      customWhere: (claims): SQL | null => {
        if (claims.app_metadata?.roles?.includes("admin")) return null;
        return claims.sub ? sql`${c(columns.ownerId)} = ${claims.sub}` : DENY_ALL;
      },
    }),
  },
  governance: {
    managedFields: [
      { column: "ownerId", applyOn: ["create"], strategy: "authClaim", claimPath: ["sub"] },
      { column: "modifiedBy", applyOn: ["create", "update"], strategy: "authClaim", claimPath: ["sub"] },
      { column: "createdAtUs", applyOn: ["create"], strategy: "nowMicroseconds" },
      { column: "updatedAtUs", applyOn: ["create", "update"], strategy: "nowMicroseconds" },
    ],
  },
});

const makeTodosColumns = () => ({
  id: uuid("id").primaryKey(),
  title: varchar("title", { length: 120 }).notNull(),
  description: varchar("description", { length: 4000 }),
  authorId: uuid("author_id")
    .notNull()
    .references(() => authorsSyncEntry.table.id),
  ownerId: uuid("owner_id"),
  modifiedBy: uuid("modified_by"),
  status: todoStatusEnum("status").notNull().default("todo"),
  priority: todoPriorityEnum("priority").notNull().default("medium"),
  createdAtUs: bigint("created_at_us", { mode: "bigint" }).notNull().default(clockMicrosecondsSql),
  updatedAtUs: bigint("updated_at_us", { mode: "bigint" }).notNull().default(clockMicrosecondsSql),
});

const todosSyncEntry = defineSyncTable({
  tableName: "todos",
  makeColumns: makeTodosColumns,
  extras: (t) => buildSupabaseOwnerOrAdminNativePolicies({ role: authenticatedRole, ownerColumn: t.ownerId }),
  mode: "readwrite",
  // ADR-0015: exercise the safety policy in the demo — a stale todo edit is surfaced, not clobbered.
  conflictPolicy: "reject-if-stale",
  shape: {
    rowFilter: (columns) => ({
      customWhere: (claims): SQL | null => {
        if (claims.app_metadata?.roles?.includes("admin")) return null;
        return claims.sub ? sql`${c(columns.ownerId)} = ${claims.sub}` : DENY_ALL;
      },
    }),
  },
  governance: {
    deferrableConstraints: [
      {
        constraintName: "todos_author_id_authors_id_fkey",
        columns: ["authorId"],
        initiallyDeferred: false,
      },
    ],
    managedFields: [
      { column: "ownerId", applyOn: ["create"], strategy: "authClaim", claimPath: ["sub"] },
      { column: "modifiedBy", applyOn: ["create", "update"], strategy: "authClaim", claimPath: ["sub"] },
      { column: "createdAtUs", applyOn: ["create"], strategy: "nowMicroseconds" },
      { column: "updatedAtUs", applyOn: ["create", "update"], strategy: "nowMicroseconds" },
    ],
  },
});

export const authorsTable = authorsSyncEntry.table;
export const authorsView = authorsSyncEntry.view!;
export const todosTable = todosSyncEntry.table;
export const todosView = todosSyncEntry.view!;
export { authorsSyncEntry, todosSyncEntry };

export type AuthorRow = typeof authorsTable.$inferSelect;
export type NewAuthorRow = typeof authorsTable.$inferInsert;
export type AuthorRecord = typeof authorsTable.$inferSelect;
export type TodoRow = typeof todosTable.$inferSelect;
export type NewTodoRow = typeof todosTable.$inferInsert;
export type TodoRecord = typeof todosTable.$inferSelect;
