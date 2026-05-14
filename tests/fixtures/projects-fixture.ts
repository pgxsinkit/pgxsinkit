import { sql } from "drizzle-orm";
import { bigint, uuid, varchar } from "drizzle-orm/pg-core";

import { defineSyncRegistry, defineSyncTable, type TableSpecInput } from "@pgxsinkit/contracts";

const nowMicrosecondsSql = sql`CAST(FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000000) AS BIGINT)`;

const makeProjectsColumns = () => ({
  id: uuid("id").primaryKey(),
  name: varchar("name", { length: 120 }).notNull(),
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

export const ensureProjectsTableSql = sql.raw(`
  DO $$
  BEGIN
    IF to_regclass('public.projects') IS NULL THEN
      CREATE TABLE projects (
        id UUID PRIMARY KEY,
        name VARCHAR(120) NOT NULL,
        created_at_us BIGINT NOT NULL DEFAULT CAST(FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000000) AS BIGINT),
        updated_at_us BIGINT NOT NULL DEFAULT CAST(FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000000) AS BIGINT)
      );
    END IF;
  END $$;
`);
