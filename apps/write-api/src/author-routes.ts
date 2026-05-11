import { eq, sql } from "drizzle-orm";
import type { output } from "zod";

import {
  authorIdSchema,
  authorTableSpec,
  authorsTable,
  mapCreateAuthorToInsert,
  mapUpdateAuthorToValues,
  type AuthorRecord,
} from "@pgxsinkit/schema";

import type { CrudRouteSpec } from "./crud-routes";
import type { createDatabase } from "./db";

type WriteDb = ReturnType<typeof createDatabase>["db"];

function serializeAuthor(row: Record<string, unknown>) {
  return authorTableSpec.schemas.recordSchema.parse({
    id: row.id,
    name: row.name,
    createdAtUs: String(row.createdAtUs),
    updatedAtUs: String(row.updatedAtUs),
  });
}

export function buildAuthorCrudRouteSpec(
  db: WriteDb,
): CrudRouteSpec<
  string,
  output<typeof authorTableSpec.schemas.createSchema>,
  output<typeof authorTableSpec.schemas.updateSchema>,
  AuthorRecord
> {
  return {
    table: authorTableSpec,
    idSchema: authorIdSchema,
    notFoundMessage: "Author not found",
    list: async () => {
      const result = await db.execute(sql<AuthorRecord>`
        SELECT
          id,
          name,
          created_at_us::text AS "createdAtUs",
          updated_at_us::text AS "updatedAtUs"
        FROM authors
        ORDER BY created_at_us ASC
      `);

      return Array.from(result, (row) => serializeAuthor(row as Record<string, unknown>));
    },
    create: async (payload) => {
      const inserted = await db.insert(authorsTable).values(mapCreateAuthorToInsert(payload)).returning();

      return serializeAuthor(inserted[0] as Record<string, unknown>);
    },
    update: async (id, payload) => {
      const updated = await db
        .update(authorsTable)
        .set({
          ...mapUpdateAuthorToValues(payload),
          updatedAtUs: sql`CAST(FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000000) AS BIGINT)`,
        })
        .where(eq(authorsTable.id, id))
        .returning();

      if (updated.length === 0) {
        return null;
      }

      return serializeAuthor(updated[0] as Record<string, unknown>);
    },
    remove: async (id) => {
      const deleted = await db.delete(authorsTable).where(eq(authorsTable.id, id)).returning();
      return deleted.length > 0;
    },
  };
}
