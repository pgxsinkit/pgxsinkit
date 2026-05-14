import type { ColumnBuilderBase, InferInsertModel, InferSelectModel } from "drizzle-orm";
import {
  bigint,
  getTableConfig,
  pgTable,
  pgView,
  type AnyPgTable,
  type PgBuildExtraConfigColumns,
  type PgPolicy,
  type PgTableExtraConfigValue,
  type PgView,
} from "drizzle-orm/pg-core";
import type { pgSchema } from "drizzle-orm/pg-core";
import { varchar } from "drizzle-orm/pg-core";
import type { ExtractTablesWithRelations } from "drizzle-orm/relations";
import { getColumns } from "drizzle-orm/utils";

import type {
  ClientProjectionSpec,
  DeferrableConstraintSpec,
  ManagedFieldApplyOn,
  ManagedFieldSpec,
  ManagedFieldStrategy,
  PrimaryKeySpec,
  ShapeSpec,
  ShapeSpecInput,
  TableGovernanceSpec as TableGovernanceSpecBase,
  TableMode,
} from "./config";

type PgSchemaType = ReturnType<typeof pgSchema>;

// PgView is generic; this alias covers any pg view instance.
// biome-ignore lint: intentional any
type AnyPgView = PgView<any, any, any>;

type TableColumnsShape<TTable extends AnyPgTable> = TTable extends {
  _: {
    columns: infer TColumns;
  };
}
  ? TColumns
  : never;

export type TableColumnKey<TTable extends AnyPgTable> = Extract<keyof TableColumnsShape<TTable>, string>;

export type DeferrableConstraintSpecForTable<TTable extends AnyPgTable> = Omit<DeferrableConstraintSpec, "columns"> & {
  columns: Array<TableColumnKey<TTable>>;
};

export type ManagedFieldSpecForTable<TTable extends AnyPgTable> = Omit<ManagedFieldSpec, "column"> & {
  column: TableColumnKey<TTable>;
};

export interface ResolvedManagedFieldSpecForTable<TTable extends AnyPgTable> {
  column: TableColumnKey<TTable>;
  applyOn: ManagedFieldApplyOn[];
  strategy: ManagedFieldStrategy;
}

export type ClientProjectionSpecForTable<TTable extends AnyPgTable> = Omit<ClientProjectionSpec, "omitColumns"> & {
  omitColumns?: Array<TableColumnKey<TTable>>;
};

export interface ProjectedTableColumn<TTable extends AnyPgTable = AnyPgTable> {
  propertyKey: TableColumnKey<TTable>;
  columnName: string;
  column: ReturnType<typeof getColumns<AnyPgTable>>[string];
}

export type TableGovernanceSpecForTable<TTable extends AnyPgTable> = Omit<
  TableGovernanceSpecBase,
  "deferrableConstraints" | "managedFields"
> & {
  deferrableConstraints?: Array<DeferrableConstraintSpecForTable<TTable>>;
  managedFields?: Array<ManagedFieldSpecForTable<TTable>>;
};

export interface SyncTableEntry<TTable extends AnyPgTable = AnyPgTable> {
  table: TTable;
  /**
   * Projected client-side table for PGlite use. Columns listed in
   * `clientProjection.omitColumns` (e.g. `created_by_id`) are absent at
   * runtime even though the TypeScript type mirrors `table` due to the
   * `viewColumnsForProjection` cast. Never access omitted columns on this
   * object.
   */
  localTable: TTable;
  view?: AnyPgView;
  mode: TableMode;
  primaryKey: PrimaryKeySpec;
  shape?: ShapeSpec;
  clientProjection?: ClientProjectionSpecForTable<TTable>;
  governance?: TableGovernanceSpecForTable<TTable>;
}

/** Column property key names from a `makeColumns` factory function. */
type ColumnKeys<TColumns extends Record<string, ColumnBuilderBase>> = keyof TColumns & string;

/** Governance spec for `defineSyncTable` — columns are typed from `makeColumns`. */
export type SyncTableInputGovernance<TColumns extends Record<string, ColumnBuilderBase>> = Omit<
  TableGovernanceSpecBase,
  "deferrableConstraints" | "managedFields"
> & {
  deferrableConstraints?: Array<Omit<DeferrableConstraintSpec, "columns"> & { columns: Array<ColumnKeys<TColumns>> }>;
  managedFields?: Array<Omit<ManagedFieldSpec, "column"> & { column: ColumnKeys<TColumns> }>;
};

/** Projection spec for `defineSyncTable` — omitColumns typed from `makeColumns`. */
export type SyncTableInputProjection<TColumns extends Record<string, ColumnBuilderBase>> = Omit<
  ClientProjectionSpec,
  "omitColumns"
> & {
  omitColumns?: Array<ColumnKeys<TColumns>>;
};

/**
 * Input for `defineSyncTable`. Supply `tableName + makeColumns` — the Drizzle table
 * (and, for `readwrite` mode, the read-model view) are created internally.
 *
 * Access the built objects via `.table` and `.view` on the returned entry.
 */
export type SyncTableInput<TName extends string, TColumns extends Record<string, ColumnBuilderBase>> = {
  tableName: TName;
  makeColumns: () => TColumns;
  /** RLS policies (or other table extras) attached to the Postgres table. */
  policies?: PgPolicy[];
  /**
   * Extra constraints or indexes on the server-side Postgres table (unique, index, etc.).
   * Receives the built column map — same signature as `pgTable`'s third argument.
   * Not applied to `localTable`.
   */
  extras?: (self: PgBuildExtraConfigColumns<TColumns>) => PgTableExtraConfigValue[];
  /** Place the table in this schema (e.g. for perf-lab schemed tables). */
  schema?: PgSchemaType;
  /** @default "readonly" */
  mode?: TableMode;
  /**
   * Primary key column names. Defaults to `["id"]`.
   * Use an array with multiple entries for composite keys.
   */
  primaryKey?: string[];
  shape?: ShapeSpecInput;
  clientProjection?: SyncTableInputProjection<TColumns>;
  governance?: SyncTableInputGovernance<TColumns>;
};

export type SyncTableRegistry = Record<string, SyncTableEntry>;

export interface SyncRegistryDefinition<TRegistry extends SyncTableRegistry> {
  schema?: string;
  tables: TRegistry;
}

export const syncRegistrySchemaSymbol = Symbol.for("@pgxsinkit/contracts/syncRegistrySchema");

export type RegistryTables<TRegistry extends SyncTableRegistry> = {
  [TKey in keyof TRegistry]: TRegistry[TKey]["table"];
};

export type RegistryViews<TRegistry extends SyncTableRegistry> = {
  [TKey in keyof TRegistry as TRegistry[TKey] extends { view: AnyPgView } ? TKey : never]: NonNullable<
    TRegistry[TKey]["view"]
  >;
};

export type RegistryRelations<TRegistry extends SyncTableRegistry> = ExtractTablesWithRelations<
  {},
  RegistryTables<TRegistry>
>;

export type SyncTableName<TRegistry extends SyncTableRegistry> = keyof TRegistry & string;

export type SyncTableCreateInput<TRegistry extends SyncTableRegistry, TKey extends keyof TRegistry> =
  TRegistry[TKey] extends SyncTableEntry<infer TTable extends AnyPgTable> ? InferInsertModel<TTable> : never;

export type SyncTableUpdateInput<TRegistry extends SyncTableRegistry, TKey extends keyof TRegistry> = Partial<
  SyncTableCreateInput<TRegistry, TKey>
>;

export type SyncTableRecord<TRegistry extends SyncTableRegistry, TKey extends keyof TRegistry> =
  TRegistry[TKey] extends SyncTableEntry<infer TTable extends AnyPgTable> ? InferSelectModel<TTable> : never;

/**
 * Filters a columns object, omitting keys in `omitSet`, while preserving TypeScript column types.
 * When `omitSet` is empty the original object is returned unchanged (no copy, no type loss).
 */
function viewColumnsForProjection<TColumns extends Record<string, ColumnBuilderBase>>(
  columns: TColumns,
  omitSet: Set<string>,
): TColumns {
  if (omitSet.size === 0) return columns;
  return Object.fromEntries(Object.entries(columns).filter(([key]) => !omitSet.has(key))) as TColumns;
}

/**
 * Defines a sync table entry. Provide `tableName` and `makeColumns` — the Drizzle
 * `pgTable` (and, for `readwrite` mode, the `_read_model` view) are created here.
 *
 * Access the built objects via `.table` and `.view` on the returned entry.
 */
export function defineSyncTable<const TName extends string, const TColumns extends Record<string, ColumnBuilderBase>>(
  input: SyncTableInput<TName, TColumns>,
) {
  const {
    tableName,
    makeColumns,
    policies,
    extras,
    schema,
    mode,
    primaryKey,
    governance,
    clientProjection,
    shape,
    ...otherRest
  } = input;

  const resolvedMode: TableMode = mode ?? "readonly";
  const resolvedPrimaryKey: PrimaryKeySpec = { columns: primaryKey ?? ["id"] };

  const resolvedClientProjection =
    resolvedMode !== "writeonly" || clientProjection != null
      ? {
          ...(clientProjection ?? {}),
          syncedTable: clientProjection?.syncedTable ?? tableName,
          ...(resolvedMode === "readwrite"
            ? {
                overlayTable: clientProjection?.overlayTable ?? `${tableName}_overlay`,
                journalTable: clientProjection?.journalTable ?? `${tableName}_mutations`,
              }
            : {}),
        }
      : undefined;

  const resolvedShape: ShapeSpec | undefined =
    resolvedMode !== "writeonly" || shape != null
      ? {
          tableName: shape?.tableName ?? tableName,
          shapeKey: shape?.shapeKey ?? shape?.tableName ?? tableName,
          ...(shape?.electricTable != null ? { electricTable: shape.electricTable } : {}),
          ...(shape?.rowFilter != null ? { rowFilter: shape.rowFilter } : {}),
        }
      : undefined;

  // biome-ignore lint: intentional any for policy/extras passthrough
  const extrasFn =
    policies || extras
      ? (self: PgBuildExtraConfigColumns<ReturnType<typeof makeColumns>>) => [
          ...(policies ?? []),
          ...(extras ? extras(self) : []),
        ]
      : undefined;
  const table = schema
    ? schema.table(tableName, makeColumns(), extrasFn as any)
    : pgTable(tableName, makeColumns(), extrasFn as any);

  const omitSet = new Set<string>(clientProjection?.omitColumns ?? []);
  const projectedCols = viewColumnsForProjection(makeColumns(), omitSet);
  // biome-ignore lint: localTable shares the same TS type as table; omitted columns are absent at runtime only
  const localTable = (
    schema ? schema.table(tableName, projectedCols) : pgTable(tableName, projectedCols)
  ) as typeof table;

  const viewColumns = viewColumnsForProjection(makeColumns(), omitSet);
  const view =
    resolvedMode === "readwrite"
      ? pgView(`${tableName}_read_model`, {
          ...viewColumns,
          overlay_kind: varchar("overlay_kind", { length: 24 }).notNull(),
          local_updated_at_us: bigint("local_updated_at_us", { mode: "bigint" }).notNull(),
        }).existing()
      : undefined;

  // biome-ignore lint: governance and clientProjection use string column-keys at input time;
  // SyncTableEntry expects column objects — runtime correctness is ensured by validateSyncTableEntry
  const entry = {
    ...otherRest,
    mode: resolvedMode,
    primaryKey: resolvedPrimaryKey,
    ...(resolvedShape != null ? { shape: resolvedShape } : {}),
    ...(governance != null ? { governance: governance as any } : {}),
    ...(resolvedClientProjection != null ? { clientProjection: resolvedClientProjection as any } : {}),
    table,
    localTable,
    ...(view != null ? { view } : {}),
  };
  validateSyncTableEntry(entry as unknown as SyncTableEntry<AnyPgTable>);
  return entry;
}

export function defineSyncRegistry<const TRegistry extends { [TKey in keyof TRegistry]: SyncTableEntry<any> }>(
  registry: TRegistry,
): TRegistry;
export function defineSyncRegistry<const TRegistry extends { [TKey in keyof TRegistry]: SyncTableEntry<any> }>(
  definition: SyncRegistryDefinition<TRegistry>,
): TRegistry;
export function defineSyncRegistry<const TRegistry extends { [TKey in keyof TRegistry]: SyncTableEntry<any> }>(
  input: TRegistry | SyncRegistryDefinition<TRegistry>,
) {
  if (isSyncRegistryDefinition(input)) {
    for (const entry of getRegistryEntries(input.tables)) {
      validateSyncTableEntry(entry as SyncTableEntry<AnyPgTable>);
    }

    return attachSyncRegistrySchema(input.tables, input.schema);
  }

  for (const entry of getRegistryEntries(input)) {
    validateSyncTableEntry(entry as SyncTableEntry<AnyPgTable>);
  }

  return input;
}

export function getProjectedColumns<TTable extends AnyPgTable>(entry: SyncTableEntry<TTable>) {
  const omittedColumns = new Set(entry.clientProjection?.omitColumns ?? []);

  return Object.entries(getColumns(entry.table)).flatMap(([propertyKey, column]) => {
    if (omittedColumns.has(propertyKey as TableColumnKey<TTable>)) {
      return [];
    }

    return [
      {
        propertyKey: propertyKey as TableColumnKey<TTable>,
        columnName: column.name,
        column,
      } satisfies ProjectedTableColumn<TTable>,
    ];
  });
}

export function getOmittedProjectedColumns<TTable extends AnyPgTable>(entry: SyncTableEntry<TTable>) {
  const omittedColumns = new Set(entry.clientProjection?.omitColumns ?? []);

  return Object.entries(getColumns(entry.table)).flatMap(([propertyKey, column]) => {
    if (!omittedColumns.has(propertyKey as TableColumnKey<TTable>)) {
      return [];
    }

    return [
      {
        propertyKey: propertyKey as TableColumnKey<TTable>,
        columnName: column.name,
        column,
      } satisfies ProjectedTableColumn<TTable>,
    ];
  });
}

export function getProjectedColumnNames<TTable extends AnyPgTable>(entry: SyncTableEntry<TTable>) {
  return getProjectedColumns(entry).map(({ columnName }) => columnName);
}

export function getOmittedProjectedColumnNames<TTable extends AnyPgTable>(entry: SyncTableEntry<TTable>) {
  return getOmittedProjectedColumns(entry).map(({ columnName }) => columnName);
}

export function getLocalSyncedTablePrimaryKeyColumns<TTable extends AnyPgTable>(entry: SyncTableEntry<TTable>) {
  return [...(entry.clientProjection?.localPrimaryKey?.columns ?? entry.primaryKey.columns)];
}

export function attachSyncRegistrySchema<TRegistry extends SyncTableRegistry>(registry: TRegistry, schema?: string) {
  const normalizedSchema = normalizeSchemaName(schema);

  if (!normalizedSchema) {
    return registry;
  }

  for (const entry of Object.values(registry)) {
    const tableSchema = getTableConfig(entry.table).schema ?? "public";

    if (tableSchema !== normalizedSchema) {
      throw new Error(
        `Registry schema ${normalizedSchema} does not match table schema ${tableSchema} for ${getTableConfig(entry.table).name}`,
      );
    }

    if (!entry.shape) {
      continue;
    }

    const qualifiedTableName = `${normalizedSchema}.${entry.shape.tableName}`;
    entry.shape = {
      ...entry.shape,
      ...(entry.shape.electricTable ? {} : { electricTable: qualifiedTableName }),
      ...(entry.shape.shapeKey === entry.shape.tableName ? { shapeKey: qualifiedTableName } : {}),
    };
  }

  Object.defineProperty(registry, syncRegistrySchemaSymbol, {
    value: normalizedSchema,
    enumerable: false,
    configurable: false,
    writable: false,
  });

  return registry;
}

export function getSyncRegistrySchema<TRegistry extends SyncTableRegistry>(registry: TRegistry) {
  const schema = Reflect.get(registry, syncRegistrySchemaSymbol) as unknown;
  return typeof schema === "string" && schema.length > 0 ? schema : "public";
}

function isSyncRegistryDefinition<TRegistry extends SyncTableRegistry>(
  input: TRegistry | SyncRegistryDefinition<TRegistry>,
): input is SyncRegistryDefinition<TRegistry> {
  return (
    typeof input === "object" &&
    input !== null &&
    "tables" in input &&
    typeof input.tables === "object" &&
    input.tables !== null
  );
}

function normalizeSchemaName(schema: string | undefined) {
  const trimmed = schema?.trim();
  return trimmed && trimmed !== "public" ? trimmed : undefined;
}

function getRegistryEntries<TRegistry extends SyncTableRegistry>(registry: TRegistry) {
  return Object.values(registry) as Array<SyncTableEntry<AnyPgTable>>;
}

function validateSyncTableEntry(entry: SyncTableEntry<AnyPgTable>) {
  const tableName = getTableConfig(entry.table).name;

  const columns = Object.entries(getColumns(entry.table)).map(([propertyKey, column]) => ({
    propertyKey,
    columnName: column.name,
    column,
  }));
  const columnsByPropertyKey = new Map(columns.map((column) => [column.propertyKey, column]));
  const columnsByColumnName = new Map(columns.map((column) => [column.columnName, column]));
  const omitColumns = entry.clientProjection?.omitColumns ?? [];
  const localPrimaryKeyColumns = entry.clientProjection?.localPrimaryKey?.columns ?? [];

  if (omitColumns.length === 0 && localPrimaryKeyColumns.length === 0) {
    return;
  }

  const unknownColumns = omitColumns.filter((propertyKey) => !columnsByPropertyKey.has(propertyKey));

  if (unknownColumns.length > 0) {
    throw new Error(
      `clientProjection.omitColumns contains unknown columns for ${tableName}: ${unknownColumns.join(", ")}`,
    );
  }

  const unknownLocalPrimaryKeyColumns = localPrimaryKeyColumns.filter(
    (columnName) => !columnsByColumnName.has(columnName),
  );

  if (unknownLocalPrimaryKeyColumns.length > 0) {
    throw new Error(
      `clientProjection.localPrimaryKey contains unknown columns for ${tableName}: ${unknownLocalPrimaryKeyColumns.join(", ")}`,
    );
  }

  if (entry.mode !== "readonly" && localPrimaryKeyColumns.length > 0) {
    throw new Error(`clientProjection.localPrimaryKey is only supported for readonly table ${tableName}`);
  }

  const omittedColumnsSet = new Set(omitColumns);
  const omittedLocalPrimaryKeyColumns = localPrimaryKeyColumns.filter((columnName) =>
    omittedColumnsSet.has(columnName),
  );

  if (omittedLocalPrimaryKeyColumns.length > 0) {
    throw new Error(
      `clientProjection.localPrimaryKey must not include omitted columns for ${tableName}: ${omittedLocalPrimaryKeyColumns.join(", ")}`,
    );
  }

  const primaryKeyOmissions = omitColumns.filter((propertyKey) => {
    const column = columnsByPropertyKey.get(propertyKey);
    return column
      ? entry.primaryKey.columns.includes(column.columnName) || entry.primaryKey.columns.includes(propertyKey)
      : false;
  });

  if (primaryKeyOmissions.length > 0) {
    if (entry.mode === "readonly" && localPrimaryKeyColumns.length > 0) {
      return;
    }

    throw new Error(
      `clientProjection.omitColumns must not omit primary-key columns for ${tableName}: ${primaryKeyOmissions.join(", ")}`,
    );
  }

  if (entry.mode === "readonly") {
    return;
  }

  const createManagedColumns = new Set(
    (entry.governance?.managedFields ?? [])
      .filter((field) => field.applyOn.includes("create"))
      .map((field) => field.column),
  );

  const createRequiredOmissions = omitColumns.filter((propertyKey) => {
    const column = columnsByPropertyKey.get(propertyKey);

    if (!column) {
      return false;
    }

    return column.column.notNull && !column.column.hasDefault && !createManagedColumns.has(propertyKey);
  });

  if (createRequiredOmissions.length > 0) {
    throw new Error(
      `clientProjection.omitColumns must only omit create-safe columns for writable table ${tableName}: ${createRequiredOmissions.join(", ")}`,
    );
  }
}
