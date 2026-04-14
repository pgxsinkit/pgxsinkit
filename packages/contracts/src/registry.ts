import { getTableConfig, type AnyPgTable } from "drizzle-orm/pg-core";

import type {
  ClientProjectionSpec,
  DeferrableConstraintSpec,
  ManagedFieldApplyOn,
  ManagedFieldSpec,
  ManagedFieldStrategy,
  PrimaryKeySpec,
  RlsPolicySpec,
  RowLevelSecuritySpec,
  ServerRouteSpec,
  ShapeSpec,
  TableGovernanceSpec as TableGovernanceSpecBase,
  TableAdapters,
  TableMode,
  TableSchemas,
} from "./config";

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

export type RlsPolicySpecForTable<TTable extends AnyPgTable> = Omit<
  RlsPolicySpec,
  "usingColumns" | "withCheckColumns"
> & {
  usingColumns?: Array<TableColumnKey<TTable>>;
  withCheckColumns?: Array<TableColumnKey<TTable>>;
};

export type RowLevelSecuritySpecForTable<TTable extends AnyPgTable> = Omit<RowLevelSecuritySpec, "policies"> & {
  policies?: Array<RlsPolicySpecForTable<TTable>>;
};

export type ManagedFieldSpecForTable<TTable extends AnyPgTable> = Omit<ManagedFieldSpec, "column"> & {
  column: TableColumnKey<TTable>;
};

export interface ResolvedManagedFieldSpecForTable<TTable extends AnyPgTable> {
  column: TableColumnKey<TTable>;
  applyOn: ManagedFieldApplyOn[];
  strategy: ManagedFieldStrategy;
}

export type TableGovernanceSpecForTable<TTable extends AnyPgTable> = Omit<
  TableGovernanceSpecBase,
  "deferrableConstraints" | "managedFields" | "rls"
> & {
  deferrableConstraints?: Array<DeferrableConstraintSpecForTable<TTable>>;
  managedFields?: Array<ManagedFieldSpecForTable<TTable>>;
  rls?: RowLevelSecuritySpecForTable<TTable>;
};

export interface SyncTableEntry<
  TTable extends AnyPgTable = AnyPgTable,
  TCreate = unknown,
  TUpdate = unknown,
  TRecord = unknown,
> {
  table: TTable;
  mode: TableMode;
  primaryKey: PrimaryKeySpec;
  shape?: ShapeSpec;
  routes?: ServerRouteSpec;
  clientProjection?: ClientProjectionSpec;
  governance?: TableGovernanceSpecForTable<TTable>;
  schemas?: TableSchemas<TCreate, TUpdate, TRecord>;
  adapters?: TableAdapters;
}

export type SyncTableRegistry = Record<string, SyncTableEntry>;

export interface SyncRegistryDefinition<TRegistry extends SyncTableRegistry> {
  schema?: string;
  tables: TRegistry;
}

export const syncRegistrySchemaSymbol = Symbol.for("@pgxsinkit/contracts/syncRegistrySchema");

export type RegistryTables<TRegistry extends SyncTableRegistry> = {
  [TKey in keyof TRegistry]: TRegistry[TKey]["table"];
};

export type SyncTableName<TRegistry extends SyncTableRegistry> = keyof TRegistry & string;

export type SyncTableCreateInput<TRegistry extends SyncTableRegistry, TKey extends keyof TRegistry> =
  TRegistry[TKey] extends SyncTableEntry<any, infer TCreate, any, any> ? TCreate : never;

export type SyncTableUpdateInput<TRegistry extends SyncTableRegistry, TKey extends keyof TRegistry> =
  TRegistry[TKey] extends SyncTableEntry<any, any, infer TUpdate, any> ? TUpdate : never;

export type SyncTableRecord<TRegistry extends SyncTableRegistry, TKey extends keyof TRegistry> =
  TRegistry[TKey] extends SyncTableEntry<any, any, any, infer TRecord> ? TRecord : never;

export function defineSyncTable<const TTable extends AnyPgTable, TCreate, TUpdate, TRecord>(
  entry: SyncTableEntry<TTable, TCreate, TUpdate, TRecord>,
) {
  return entry;
}

export function defineTableGovernance<const TTable extends AnyPgTable>(
  _table: TTable,
  governance: TableGovernanceSpecForTable<TTable>,
) {
  return governance;
}

export function defineSyncRegistry<
  const TRegistry extends { [TKey in keyof TRegistry]: SyncTableEntry<any, any, any, any> },
>(registry: TRegistry): TRegistry;
export function defineSyncRegistry<
  const TRegistry extends { [TKey in keyof TRegistry]: SyncTableEntry<any, any, any, any> },
>(definition: SyncRegistryDefinition<TRegistry>): TRegistry;
export function defineSyncRegistry<
  const TRegistry extends { [TKey in keyof TRegistry]: SyncTableEntry<any, any, any, any> },
>(input: TRegistry | SyncRegistryDefinition<TRegistry>) {
  if (isSyncRegistryDefinition(input)) {
    return attachSyncRegistrySchema(input.tables, input.schema);
  }

  return input;
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
