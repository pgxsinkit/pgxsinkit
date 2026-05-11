import { eq, sql } from "drizzle-orm";
import type { output } from "zod";

import {
  mapCreateTodoToInsert,
  mapUpdateTodoToValues,
  todoIdSchema,
  todoTableSpec,
  todosTable,
  type TodoRecord,
} from "@pgxsinkit/schema";

import type { CrudRouteSpec } from "./crud-routes";
import type { createDatabase } from "./db";

type WriteDb = ReturnType<typeof createDatabase>["db"];

function serializeTodo(row: Record<string, unknown>) {
  return todoTableSpec.schemas.recordSchema.parse({
    id: row.id,
    title: row.title,
    description: row.description ?? null,
    authorId: row.authorId,
    status: row.status,
    priority: row.priority,
    createdAtUs: String(row.createdAtUs),
    updatedAtUs: String(row.updatedAtUs),
  });
}

export function buildTodoCrudRouteSpec(
  db: WriteDb,
): CrudRouteSpec<
  string,
  output<typeof todoTableSpec.schemas.createSchema>,
  output<typeof todoTableSpec.schemas.updateSchema>,
  TodoRecord
> {
  return {
    table: todoTableSpec,
    idSchema: todoIdSchema,
    notFoundMessage: "Todo not found",
    list: async () => {
      const result = await db.execute(sql<TodoRecord>`
        SELECT
          id,
          title,
          description,
          author_id AS "authorId",
          status,
          priority,
          created_at_us::text AS "createdAtUs",
          updated_at_us::text AS "updatedAtUs"
        FROM todos
        ORDER BY created_at_us ASC
      `);

      return Array.from(result, (row) => serializeTodo(row as Record<string, unknown>));
    },
    create: async (payload) => {
      const inserted = await db.insert(todosTable).values(mapCreateTodoToInsert(payload)).returning();

      return serializeTodo(inserted[0] as Record<string, unknown>);
    },
    update: async (id, payload) => {
      const updated = await db
        .update(todosTable)
        .set({
          ...mapUpdateTodoToValues(payload),
          updatedAtUs: sql`CAST(FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000000) AS BIGINT)`,
        })
        .where(eq(todosTable.id, id))
        .returning();

      if (updated.length === 0) {
        return null;
      }

      return serializeTodo(updated[0] as Record<string, unknown>);
    },
    remove: async (id) => {
      const deleted = await db.delete(todosTable).where(eq(todosTable.id, id)).returning();
      return deleted.length > 0;
    },
  };
}
