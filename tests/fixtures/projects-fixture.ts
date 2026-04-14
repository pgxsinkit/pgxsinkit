import { sql } from "drizzle-orm";
import { bigint, pgTable, uuid, varchar } from "drizzle-orm/pg-core";
import { z } from "zod";

import {
  defineSyncRegistry,
  defineSyncTable,
  type TableSpec,
  type TableSpecInput,
  unixMicrosecondsSchema,
} from "@pgxsinkit/contracts";

const nowMicrosecondsSql = sql`CAST(FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000000) AS BIGINT)`;

export const projectsTable = pgTable("projects", {
  id: uuid("id").primaryKey(),
  name: varchar("name", { length: 120 }).notNull(),
  createdAtUs: bigint("created_at_us", { mode: "bigint" }).notNull().default(nowMicrosecondsSql),
  updatedAtUs: bigint("updated_at_us", { mode: "bigint" }).notNull().default(nowMicrosecondsSql),
});

export const createProjectInputSchema = z.object({
  id: z.uuid(),
  name: z.string().trim().min(1).max(120),
});

export const updateProjectInputSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (Object.keys(value).length === 0) {
      context.addIssue({
        code: "custom",
        message: "At least one field must be provided",
      });
    }
  });

export const projectRecordSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  createdAtUs: unixMicrosecondsSchema,
  updatedAtUs: unixMicrosecondsSchema,
});

export type CreateProjectInput = z.infer<typeof createProjectInputSchema>;
export type UpdateProjectInput = z.infer<typeof updateProjectInputSchema>;
export type ProjectRecord = z.infer<typeof projectRecordSchema>;

export const projectTableSpecInput = {
  name: "projects",
  mode: "readwrite",
  primaryKey: {
    columns: ["id"],
  },
  shape: {
    tableName: "projects",
    shapeKey: "projects",
  },
  routes: {
    basePath: "/api/projects",
    allowBatch: false,
  },
  clientProjection: {
    syncedTable: "projects",
    overlayTable: "projects_overlay",
    journalTable: "projects_mutations",
    readModel: "projects_read_model",
  },
} satisfies TableSpecInput;

export const projectTableSpec = {
  ...projectTableSpecInput,
  schemas: {
    createSchema: createProjectInputSchema,
    updateSchema: updateProjectInputSchema,
    recordSchema: projectRecordSchema,
  },
} satisfies TableSpec<CreateProjectInput, UpdateProjectInput, ProjectRecord>;

export const projectsSyncRegistry = defineSyncRegistry({
  projects: defineSyncTable({
    table: projectsTable,
    mode: projectTableSpec.mode,
    primaryKey: projectTableSpec.primaryKey,
    shape: projectTableSpec.shape,
    routes: projectTableSpec.routes,
    clientProjection: projectTableSpec.clientProjection,
    schemas: projectTableSpec.schemas,
  }),
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
