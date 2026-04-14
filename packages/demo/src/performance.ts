import { bigint, getTableConfig, pgSchema, pgTable, type AnyPgTable, uuid, varchar } from "drizzle-orm/pg-core";
import { getColumns } from "drizzle-orm/utils";
import { z } from "zod";

import { attachSyncRegistrySchema, type SyncTableEntry, type SyncTableRegistry } from "@pgxsinkit/contracts";

const statusSchema = z.enum(["todo", "in_progress", "done"]);
const prioritySchema = z.enum(["low", "medium", "high"]);

export interface SyntheticRegistryOptions {
  tableCount: number;
  extraColumnCount: number;
  schemaName?: string;
}

export interface SyntheticRegistryBundle {
  registry: SyncTableRegistry;
  tableNames: string[];
}

export interface SyntheticPerfLabScenario {
  tableCount: number;
  extraColumnCount: number;
  localRows: number;
  pendingMutations: number;
  mutationBatchSize: number;
  readSamples: number;
}

export interface SyntheticPerfLabPreset {
  key: string;
  label: string;
  description: string;
  scenario: SyntheticPerfLabScenario;
}

export const syntheticPerfLabPresets: readonly SyntheticPerfLabPreset[] = [
  {
    key: "local-100k",
    label: "Local 100k",
    description: "1 table, 100k local rows, 5k pending mutations, 500 read samples.",
    scenario: {
      tableCount: 1,
      extraColumnCount: 12,
      localRows: 100_000,
      pendingMutations: 5_000,
      mutationBatchSize: 1,
      readSamples: 500,
    },
  },
  {
    key: "wide-schema",
    label: "Wide schema",
    description: "4 tables, 48 extra columns, 10k rows per table, 3k pending mutations.",
    scenario: {
      tableCount: 4,
      extraColumnCount: 48,
      localRows: 10_000,
      pendingMutations: 3_000,
      mutationBatchSize: 1,
      readSamples: 300,
    },
  },
  {
    key: "mixed-pressure",
    label: "Mixed pressure",
    description: "8 tables, 16 extra columns, 10k rows per table, 8k pending mutations.",
    scenario: {
      tableCount: 8,
      extraColumnCount: 16,
      localRows: 10_000,
      pendingMutations: 8_000,
      mutationBatchSize: 1,
      readSamples: 400,
    },
  },
];

export const defaultSyntheticPerfLabScenario: SyntheticPerfLabScenario = {
  ...syntheticPerfLabPresets[0]!.scenario,
};

export interface SyntheticPerfLabScenarioDefinition extends SyntheticPerfLabPreset {
  schemaName: string;
}

export const syntheticPerfLabScenarioDefinitions: readonly SyntheticPerfLabScenarioDefinition[] =
  syntheticPerfLabPresets.map((preset) => ({
    ...preset,
    schemaName: buildSyntheticPerfLabSchemaName(preset.key),
  }));

export function buildSyntheticRegistry(options: SyntheticRegistryOptions): SyntheticRegistryBundle {
  const registry: SyncTableRegistry = {};
  const tableNames: string[] = [];
  const syntheticSchema = options.schemaName ? pgSchema(options.schemaName) : null;

  for (let tableIndex = 0; tableIndex < options.tableCount; tableIndex += 1) {
    const tableName = `perf_items_${tableIndex.toString().padStart(3, "0")}`;
    const table = buildSyntheticTable(syntheticSchema, tableName, options.extraColumnCount);
    const electricTable = options.schemaName ? `${options.schemaName}.${tableName}` : tableName;

    registry[tableName] = {
      table,
      mode: "readwrite",
      primaryKey: { columns: ["id"] },
      shape: {
        tableName,
        shapeKey: electricTable,
        ...(electricTable === tableName ? {} : { electricTable }),
      },
      routes: {
        basePath: `/api/${tableName}`,
        allowBatch: true,
      },
      clientProjection: {
        syncedTable: tableName,
        overlayTable: `${tableName}_overlay`,
        journalTable: `${tableName}_mutations`,
        readModel: `${tableName}_read_model`,
      },
      governance: {
        managedFields: [
          {
            column: "ownerId",
            applyOn: ["create"],
            strategy: "authUid",
          },
          {
            column: "modifiedBy",
            applyOn: ["create", "update"],
            strategy: "authUid",
          },
          {
            column: "createdAtUs",
            applyOn: ["create"],
            strategy: "nowMicroseconds",
          },
          {
            column: "updatedAtUs",
            applyOn: ["create", "update"],
            strategy: "nowMicroseconds",
          },
        ],
        rls: {
          enabled: true,
          force: false,
          policies: [
            {
              name: `${tableName}_select_owner_or_admin`,
              command: "select",
              as: "permissive",
              roles: ["authenticated"],
              using: "owner_id = auth.uid() OR auth.has_role('admin')",
              usingColumns: ["ownerId"],
            },
            {
              name: `${tableName}_insert_owner_or_admin`,
              command: "insert",
              as: "permissive",
              roles: ["authenticated"],
              withCheck: "owner_id = auth.uid() OR auth.has_role('admin')",
              withCheckColumns: ["ownerId"],
            },
            {
              name: `${tableName}_update_owner_or_admin`,
              command: "update",
              as: "permissive",
              roles: ["authenticated"],
              using: "owner_id = auth.uid() OR auth.has_role('admin')",
              withCheck: "owner_id = auth.uid() OR auth.has_role('admin')",
              usingColumns: ["ownerId"],
              withCheckColumns: ["ownerId"],
            },
            {
              name: `${tableName}_delete_owner_or_admin`,
              command: "delete",
              as: "permissive",
              roles: ["authenticated"],
              using: "owner_id = auth.uid() OR auth.has_role('admin')",
              usingColumns: ["ownerId"],
            },
          ],
        },
      },
      schemas: buildSchemas(options.extraColumnCount),
      adapters: {
        toEntityKey: (record) => ({ id: String(record.id) }),
      },
    };

    tableNames.push(tableName);
  }

  return {
    registry: attachSyncRegistrySchema(registry, options.schemaName),
    tableNames,
  };
}

export function buildSyntheticServerSchemaSql(registry: SyncTableRegistry): string {
  const schemaStatements = Array.from(collectSyntheticSchemas(registry)).map(
    (schemaName) => `CREATE SCHEMA IF NOT EXISTS ${quoteIdent(schemaName)};`,
  );
  const tableStatements = Object.values(registry).map((entry) => {
    const tableConfig = getTableConfig(entry.table as AnyPgTable);
    const columns = Object.values(getColumns(entry.table as AnyPgTable));
    const columnSql = columns
      .map((column) => buildServerColumnSql(column.name, column.columnType, column.notNull, entry))
      .join(",\n        ");

    return [
      "DO $$",
      "BEGIN",
      `  IF to_regclass('${toRegclassLiteral(tableConfig.schema, tableConfig.name)}') IS NULL THEN`,
      `    CREATE TABLE ${qualifyIdent(tableConfig.schema, tableConfig.name)} (`,
      `        ${columnSql}`,
      "    );",
      "  END IF;",
      "END $$;",
    ].join("\n");
  });

  return [...schemaStatements, ...tableStatements].join("\n\n");
}

export function buildSyntheticGovernanceSql(
  registry: SyncTableRegistry,
  options: {
    includeAuthHelpers?: boolean;
  } = {},
): string {
  const statements = options.includeAuthHelpers === false ? [] : [buildAuthHelpersSql()];

  for (const schemaName of collectSyntheticSchemas(registry)) {
    statements.push(
      [
        "DO $$",
        "BEGIN",
        "  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN",
        `    EXECUTE 'GRANT USAGE ON SCHEMA ${escapeSqlString(quoteIdent(schemaName))} TO authenticated';`,
        "  END IF;",
        "END;",
        "$$;",
      ].join("\n"),
    );
  }

  for (const entry of Object.values(registry)) {
    const tableConfig = getTableConfig(entry.table as AnyPgTable);
    const qualifiedTableName = qualifyIdent(tableConfig.schema, tableConfig.name);

    statements.push(
      [
        `ALTER TABLE ${qualifiedTableName} ENABLE ROW LEVEL SECURITY;`,
        "DO $$",
        "BEGIN",
        "  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN",
        `    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ${escapeSqlString(qualifiedTableName)} TO authenticated';`,
        "  END IF;",
        "END;",
        "$$;",
      ].join("\n"),
    );

    for (const policy of entry.governance?.rls?.policies ?? []) {
      const commandSql = policy.command === "all" ? "ALL" : policy.command.toUpperCase();
      const rolesSql = policy.roles.map((role) => (role === "public" ? "PUBLIC" : `"${role}"`)).join(", ");
      const modeSql = policy.as.toUpperCase();
      const usingSql = policy.using ? ` USING (${policy.using})` : "";
      const withCheckSql = policy.withCheck ? ` WITH CHECK (${policy.withCheck})` : "";

      statements.push(
        [
          `DROP POLICY IF EXISTS "${policy.name}" ON ${qualifiedTableName};`,
          `CREATE POLICY "${policy.name}" ON ${qualifiedTableName}`,
          `AS ${modeSql}`,
          `FOR ${commandSql}`,
          `TO ${rolesSql}${usingSql}${withCheckSql};`,
        ].join("\n"),
      );
    }
  }

  return statements.join("\n\n");
}

export function buildSyntheticTruncateSql(registry: SyncTableRegistry): string {
  const qualifiedTables = Object.values(registry).map((entry) => {
    const tableConfig = getTableConfig(entry.table as AnyPgTable);
    return qualifyIdent(tableConfig.schema, tableConfig.name);
  });

  if (qualifiedTables.length === 0) {
    return "";
  }

  return `TRUNCATE TABLE ${qualifiedTables.join(", ")};`;
}

export function buildSyntheticPerfLabSchemaName(key: string): string {
  return `perf_lab_${key
    .replace(/[^a-z0-9]+/gi, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase()}`;
}

export function buildSyntheticRegistrySchemaName(
  options: Pick<SyntheticRegistryOptions, "tableCount" | "extraColumnCount">,
): string {
  return `perf_lab_t${options.tableCount}_c${options.extraColumnCount}`;
}

export function findSyntheticPerfLabScenarioDefinition(
  options: Pick<SyntheticRegistryOptions, "tableCount" | "extraColumnCount">,
): SyntheticPerfLabScenarioDefinition | null {
  return (
    syntheticPerfLabScenarioDefinitions.find(
      (definition) =>
        definition.scenario.tableCount === options.tableCount &&
        definition.scenario.extraColumnCount === options.extraColumnCount,
    ) ?? null
  );
}

export function buildSyntheticCreatePayload(tableIndex: number, rowIndex: number, extraColumnCount: number) {
  const payload: Record<string, unknown> = {
    id: buildSyntheticUuid(tableIndex, rowIndex),
    status: "todo",
    priority: "medium",
  };

  for (let columnIndex = 0; columnIndex < extraColumnCount; columnIndex += 1) {
    payload[`field${columnIndex.toString().padStart(2, "0")}`] = buildFieldValue(tableIndex, rowIndex, columnIndex);
  }

  return payload;
}

export function countSyntheticWorkloadRows(tableCount: number, rowsPerTable: number) {
  return Math.max(1, tableCount) * Math.max(1, rowsPerTable);
}

export function pickSyntheticWorkloadTarget(tableCount: number, workIndex: number, rowsPerTable: number) {
  const normalizedTableCount = Math.max(1, tableCount);
  const normalizedRowsPerTable = Math.max(1, rowsPerTable);

  return {
    tableIndex: workIndex % normalizedTableCount,
    rowIndex: Math.floor(workIndex / normalizedTableCount) % normalizedRowsPerTable,
  };
}

export function buildSyntheticUpdatePatch(rowIndex: number, extraColumnCount: number) {
  const patch: Record<string, unknown> = {
    status: rowIndex % 2 === 0 ? "done" : "in_progress",
  };

  for (let columnIndex = 0; columnIndex < Math.min(3, extraColumnCount); columnIndex += 1) {
    patch[`field${columnIndex.toString().padStart(2, "0")}`] = buildFieldValue(99, rowIndex, columnIndex);
  }

  return patch;
}

function buildSchemas(extraColumnCount: number) {
  const baseCreateShape: Record<string, z.ZodType> = {
    id: z.uuid(),
    status: statusSchema.default("todo"),
    priority: prioritySchema.default("medium"),
  };
  const baseUpdateShape: Record<string, z.ZodType> = {
    status: statusSchema,
    priority: prioritySchema,
  };
  const baseRecordShape: Record<string, z.ZodType> = {
    id: z.uuid(),
    ownerId: z.uuid().nullable().optional(),
    modifiedBy: z.uuid().nullable().optional(),
    status: statusSchema,
    priority: prioritySchema,
    createdAtUs: z.string(),
    updatedAtUs: z.string(),
    overlayKind: z.string(),
    localUpdatedAtUs: z.string(),
  };

  for (let columnIndex = 0; columnIndex < extraColumnCount; columnIndex += 1) {
    const key = `field${columnIndex.toString().padStart(2, "0")}`;
    const schema = z.string().trim().min(1).max(128);
    baseCreateShape[key] = schema;
    baseUpdateShape[key] = schema;
    baseRecordShape[key] = schema;
  }

  return {
    createSchema: z.object(baseCreateShape).strict(),
    updateSchema: z
      .object(baseUpdateShape)
      .partial()
      .refine((value) => Object.keys(value).length > 0, "At least one field must be provided"),
    recordSchema: z.object(baseRecordShape).strict(),
  };
}

function buildSyntheticTable(
  syntheticSchema: ReturnType<typeof pgSchema> | null,
  tableName: string,
  extraColumnCount: number,
) {
  const columns: Record<string, ReturnType<typeof varchar> | ReturnType<typeof uuid> | ReturnType<typeof bigint>> = {
    id: uuid("id").primaryKey(),
    ownerId: uuid("owner_id"),
    modifiedBy: uuid("modified_by"),
    status: varchar("status", { length: 24 }).notNull(),
    priority: varchar("priority", { length: 24 }).notNull(),
    createdAtUs: bigint("created_at_us", { mode: "bigint" }).notNull(),
    updatedAtUs: bigint("updated_at_us", { mode: "bigint" }).notNull(),
  };

  for (let columnIndex = 0; columnIndex < extraColumnCount; columnIndex += 1) {
    columns[`field${columnIndex.toString().padStart(2, "0")}`] = varchar(
      `field_${columnIndex.toString().padStart(2, "0")}`,
      {
        length: 128,
      },
    ).notNull();
  }

  return syntheticSchema ? syntheticSchema.table(tableName, columns) : pgTable(tableName, columns);
}

function buildServerColumnSql(columnName: string, columnType: string, notNull: boolean, entry: SyncTableEntry): string {
  const primaryKeySql = entry.primaryKey.columns.includes(columnName) ? " PRIMARY KEY" : "";
  const notNullSql = notNull ? " NOT NULL" : "";

  switch (columnType) {
    case "PgUUID":
      return `${columnName.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)} UUID${notNullSql}${primaryKeySql}`;
    case "PgVarchar":
      return `${columnName.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)} VARCHAR(128)${notNullSql}${primaryKeySql}`;
    case "PgBigInt64":
    case "PgBigInt53":
      return `${columnName.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)} BIGINT${notNullSql}${primaryKeySql}`;
    default:
      return `${columnName.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)} TEXT${notNullSql}${primaryKeySql}`;
  }
}

function collectSyntheticSchemas(registry: SyncTableRegistry): Set<string> {
  return new Set(
    Object.values(registry)
      .map((entry) => getTableConfig(entry.table as AnyPgTable).schema)
      .filter((schemaName): schemaName is string => typeof schemaName === "string" && schemaName.length > 0),
  );
}

function qualifyIdent(schemaName: string | undefined, tableName: string): string {
  if (!schemaName) {
    return quoteIdent(tableName);
  }

  return `${quoteIdent(schemaName)}.${quoteIdent(tableName)}`;
}

function toRegclassLiteral(schemaName: string | undefined, tableName: string): string {
  if (!schemaName) {
    return quoteIdent(tableName);
  }

  return `${quoteIdent(schemaName)}.${quoteIdent(tableName)}`;
}

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function escapeSqlString(value: string): string {
  return value.replace(/'/g, "''");
}

function buildAuthHelpersSql(): string {
  return [
    "CREATE SCHEMA IF NOT EXISTS auth;",
    "DO $$",
    "BEGIN",
    "  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN",
    "    BEGIN",
    "      CREATE ROLE authenticated NOLOGIN;",
    "    EXCEPTION",
    "      WHEN insufficient_privilege THEN",
    "        NULL;",
    "    END;",
    "  END IF;",
    "END;",
    "$$;",
    "CREATE OR REPLACE FUNCTION auth.set_auth_context(claims jsonb)",
    "RETURNS void",
    "LANGUAGE plpgsql",
    "AS $$",
    "DECLARE",
    "  normalized_claims jsonb := COALESCE(claims, '{}'::jsonb);",
    "  target_role text := COALESCE(NULLIF(normalized_claims ->> 'role', ''), 'authenticated');",
    "BEGIN",
    "  BEGIN",
    "    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = target_role) THEN",
    "      PERFORM set_config('role', target_role, true);",
    "    ELSIF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN",
    "      PERFORM set_config('role', 'authenticated', true);",
    "    END IF;",
    "  EXCEPTION",
    "    WHEN insufficient_privilege THEN",
    "      NULL;",
    "  END;",
    "  PERFORM set_config('request.jwt.claims', normalized_claims::text, true);",
    "  IF normalized_claims ? 'sub' THEN",
    "    PERFORM set_config('request.jwt.claim.sub', normalized_claims ->> 'sub', true);",
    "  END IF;",
    "END;",
    "$$;",
    "CREATE OR REPLACE FUNCTION auth.uid()",
    "RETURNS uuid",
    "LANGUAGE sql",
    "STABLE",
    "AS $$",
    "  SELECT coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid",
    "$$;",
    "CREATE OR REPLACE FUNCTION auth.jwt()",
    "RETURNS jsonb",
    "LANGUAGE sql",
    "STABLE",
    "AS $$",
    "  SELECT coalesce(nullif(current_setting('request.jwt.claim', true), ''), nullif(current_setting('request.jwt.claims', true), ''))::jsonb",
    "$$;",
    "CREATE OR REPLACE FUNCTION auth.has_role(role_name text)",
    "RETURNS boolean",
    "LANGUAGE sql",
    "STABLE",
    "AS $$",
    "  SELECT EXISTS (",
    "    SELECT 1",
    "    FROM jsonb_array_elements_text(COALESCE(auth.jwt() -> 'app_metadata' -> 'roles', '[]'::jsonb)) AS assigned_role(role_name_value)",
    "    WHERE assigned_role.role_name_value = role_name",
    "  )",
    "$$;",
    "DO $$",
    "BEGIN",
    "  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN",
    "    EXECUTE 'GRANT USAGE ON SCHEMA auth TO authenticated';",
    "    EXECUTE 'GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO authenticated';",
    "  END IF;",
    "END;",
    "$$;",
  ].join("\n");
}

function buildFieldValue(tableIndex: number, rowIndex: number, columnIndex: number): string {
  return `table-${tableIndex}-row-${rowIndex}-field-${columnIndex}`;
}

function buildSyntheticUuid(tableIndex: number, rowIndex: number): string {
  const prefix = tableIndex.toString(16).padStart(8, "0");
  const middle = rowIndex.toString(16).padStart(12, "0").slice(-12);
  return `${prefix}-0000-4000-8000-${middle}`;
}
