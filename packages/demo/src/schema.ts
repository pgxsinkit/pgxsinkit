import { sql } from "drizzle-orm";
import { bigint, pgTable, text, uuid, varchar } from "drizzle-orm/pg-core";

const nowMicrosecondsSql = sql`(floor((EXTRACT(epoch FROM clock_timestamp()) * (1000000)::numeric)))`;

export const authorsTable = pgTable("authors", {
  id: uuid("id").primaryKey(),
  name: varchar("name", { length: 120 }).notNull(),
  ownerId: uuid("owner_id"),
  modifiedBy: uuid("modified_by"),
  createdAtUs: bigint("created_at_us", { mode: "bigint" }).notNull().default(nowMicrosecondsSql),
  updatedAtUs: bigint("updated_at_us", { mode: "bigint" }).notNull().default(nowMicrosecondsSql),
});

export const todosTable = pgTable("todos", {
  id: uuid("id").primaryKey(),
  title: varchar("title", { length: 120 }).notNull(),
  description: text("description"),
  authorId: uuid("author_id")
    .notNull()
    .references(() => authorsTable.id),
  ownerId: uuid("owner_id"),
  modifiedBy: uuid("modified_by"),
  status: varchar("status", { length: 24 }).notNull().default("todo"),
  priority: varchar("priority", { length: 24 }).notNull().default("medium"),
  createdAtUs: bigint("created_at_us", { mode: "bigint" }).notNull().default(nowMicrosecondsSql),
  updatedAtUs: bigint("updated_at_us", { mode: "bigint" }).notNull().default(nowMicrosecondsSql),
});

export type AuthorRow = typeof authorsTable.$inferSelect;
export type NewAuthorRow = typeof authorsTable.$inferInsert;
export type TodoRow = typeof todosTable.$inferSelect;
export type NewTodoRow = typeof todosTable.$inferInsert;
