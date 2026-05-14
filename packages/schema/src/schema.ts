import { sql } from "drizzle-orm";
import { bigint, pgEnum, uuid, varchar } from "drizzle-orm/pg-core";
import { authenticatedRole } from "drizzle-orm/supabase";

import { buildSupabaseOwnerOrAdminNativePolicies, defineSyncTable } from "@pgxsinkit/contracts";

export const todoStatusEnum = pgEnum("todo_status", ["todo", "in_progress", "done"]);
export const todoPriorityEnum = pgEnum("todo_priority", ["low", "medium", "high"]);

const nowMicrosecondsSql = sql`(floor((EXTRACT(epoch FROM clock_timestamp()) * (1000000)::numeric)))`;

const makeAuthorsColumns = () => ({
  id: uuid("id").primaryKey(),
  name: varchar("name", { length: 120 }).notNull(),
  ownerId: uuid("owner_id"),
  modifiedBy: uuid("modified_by"),
  createdAtUs: bigint("created_at_us", { mode: "bigint" }).notNull().default(nowMicrosecondsSql),
  updatedAtUs: bigint("updated_at_us", { mode: "bigint" }).notNull().default(nowMicrosecondsSql),
});

const authorsSyncEntry = defineSyncTable({
  tableName: "authors",
  makeColumns: makeAuthorsColumns,
  policies: buildSupabaseOwnerOrAdminNativePolicies({
    tableName: "authors",
    role: authenticatedRole,
  }),
  mode: "readwrite",
  governance: {
    managedFields: [
      { column: "ownerId", applyOn: ["create"], strategy: "authUid" },
      { column: "modifiedBy", applyOn: ["create", "update"], strategy: "authUid" },
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
  createdAtUs: bigint("created_at_us", { mode: "bigint" }).notNull().default(nowMicrosecondsSql),
  updatedAtUs: bigint("updated_at_us", { mode: "bigint" }).notNull().default(nowMicrosecondsSql),
});

const todosSyncEntry = defineSyncTable({
  tableName: "todos",
  makeColumns: makeTodosColumns,
  policies: buildSupabaseOwnerOrAdminNativePolicies({
    tableName: "todos",
    role: authenticatedRole,
  }),
  mode: "readwrite",
  governance: {
    deferrableConstraints: [
      {
        constraintName: "todos_author_id_authors_id_fkey",
        columns: ["authorId"],
        initiallyDeferred: false,
      },
    ],
    managedFields: [
      { column: "ownerId", applyOn: ["create"], strategy: "authUid" },
      { column: "modifiedBy", applyOn: ["create", "update"], strategy: "authUid" },
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
