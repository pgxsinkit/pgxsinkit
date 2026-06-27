import type { ColumnBuilderBase, InferInsertModel, InferSelectModel } from "drizzle-orm";
import {
  bigint,
  getTableConfig,
  pgTable,
  pgView,
  type AnyPgTable,
  type PgBigInt64Builder,
  type PgBuildColumns,
  type PgBuildExtraConfigColumns,
  type PgPolicy,
  type PgTableExtraConfigValue,
  type PgTableWithColumns,
  type PgVarcharBuilder,
  type PgView,
  type PgViewWithSelection,
  type SetNotNull,
} from "drizzle-orm/pg-core";
import type { pgSchema } from "drizzle-orm/pg-core";
import { varchar } from "drizzle-orm/pg-core";
import type { ExtractTablesWithRelations } from "drizzle-orm/relations";
import { getColumns } from "drizzle-orm/utils";

import { type ApplyStrategy, classifyApplyStrategy, type SyncColumnType } from "./apply-strategy";
import {
  CONFLICT_POLICIES,
  isConflictPolicy,
  type ClientProjectionSpec,
  type ConflictPolicy,
  type DeferrableConstraintSpec,
  type ManagedFieldApplyOn,
  type ManagedFieldSpec,
  type ManagedFieldStrategy,
  type PrimaryKeySpec,
  type RowFilterSpec,
  type ServerProjectionSpec,
  type ShapeSpec,
  type ShapeSpecInput,
  type TableGovernanceSpec as TableGovernanceSpecBase,
  type TableMode,
} from "./config";

type PgSchemaType = ReturnType<typeof pgSchema>;

// PgView's parameters all default to their upper bounds, so the bare name
// covers any pg view instance.
type AnyPgView = PgView;

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
  omitColumns?: readonly TableColumnKey<TTable>[];
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

declare const syncTableInputGovernanceSymbol: unique symbol;

type SyncTableInputGovernanceMarker<TGovernance> = {
  [syncTableInputGovernanceSymbol]?: TGovernance;
};

export interface SyncTableEntry<TTable extends AnyPgTable = AnyPgTable, TLocalTable extends AnyPgTable = TTable> {
  table: TTable;
  /**
   * Projected client-side table for PGlite use. Columns listed in
   * `clientProjection.omitColumns` (e.g. `created_by_id`) are absent from
   * both the runtime table definition and the TypeScript shape of this table.
   */
  localTable: TLocalTable;
  view?: AnyPgView;
  mode: TableMode;
  primaryKey: PrimaryKeySpec;
  shape?: ShapeSpec;
  clientProjection?: ClientProjectionSpecForTable<TTable>;
  serverProjection?: ServerProjectionSpec;
  governance?: TableGovernanceSpecForTable<TTable>;
  /**
   * Conflict policy (ADR-0015): what happens to a stale write on this table. **Required for writable
   * tables** (registry validation rejects an undeclared one — the third hard-require); ignored for
   * `readonly` tables (they have no write path). See {@link ConflictPolicy}.
   */
  conflictPolicy?: ConflictPolicy;
  /**
   * Consistency group (ADR-0009 decision 2). Tables sharing a `consistencyGroup` are synced on one
   * `MultiShapeStream` and committed atomically at a shared LSN frontier, so a local reader never
   * sees one grouped table advanced past another for the same server transaction. Omitted → the
   * table is its own singleton group (independent frontier, today's behaviour). The latency cost (a
   * group advances only as fast as its slowest shape) is contained to the tables that opt in.
   */
  consistencyGroup?: string;
}

/** Column property key names from a `makeColumns` factory function. */
type ColumnKeys<TColumns extends Record<string, ColumnBuilderBase>> = keyof TColumns & string;

type ProjectedColumnsShape<
  TColumns extends Record<string, ColumnBuilderBase>,
  TOmittedColumns extends readonly ColumnKeys<TColumns>[],
> = ColumnKeys<TColumns> extends TOmittedColumns[number] ? TColumns : Omit<TColumns, TOmittedColumns[number]>;

// Explicit shapes for the projected local table and the read-model view.
// Their drizzle-inferred types cannot survive declaration emit: the printer
// reproduces pgTable/pgView internals as `PgBuildColumn<TTableName, ...>` with
// drizzle's own out-of-scope generic, breaking the published .d.ts. The
// constructed values are cast to these equivalent, printable types instead.
type ProjectedLocalTable<
  TName extends string,
  TColumns extends Record<string, ColumnBuilderBase>,
  TOmittedColumns extends readonly ColumnKeys<TColumns>[],
> = PgTableWithColumns<{
  name: TName;
  schema: string | undefined;
  columns: PgBuildColumns<TName, ProjectedColumnsShape<TColumns, TOmittedColumns>>;
  dialect: "pg";
}>;

type ReadModelView<
  TName extends string,
  TColumns extends Record<string, ColumnBuilderBase>,
  TOmittedColumns extends readonly ColumnKeys<TColumns>[],
> = PgViewWithSelection<
  `${TName}_read_model`,
  true,
  PgBuildColumns<
    `${TName}_read_model`,
    ProjectedColumnsShape<TColumns, TOmittedColumns> & {
      overlay_kind: SetNotNull<PgVarcharBuilder<[string, ...string[]]>>;
      local_updated_at_us: SetNotNull<PgBigInt64Builder>;
    }
  >
>;

/** Governance spec for `defineSyncTable` — columns are typed from `makeColumns`. */
export type SyncTableInputGovernance<TColumns extends Record<string, ColumnBuilderBase>> = Omit<
  TableGovernanceSpecBase,
  "deferrableConstraints" | "managedFields"
> & {
  deferrableConstraints?: Array<Omit<DeferrableConstraintSpec, "columns"> & { columns: Array<ColumnKeys<TColumns>> }>;
  managedFields?: Array<Omit<ManagedFieldSpec, "column"> & { column: ColumnKeys<TColumns> }>;
};

/** Projection spec for `defineSyncTable` — omitColumns typed from `makeColumns`. */
export type SyncTableInputProjection<
  TColumns extends Record<string, ColumnBuilderBase>,
  TOmittedColumns extends readonly ColumnKeys<TColumns>[] = [],
> = Omit<ClientProjectionSpec, "omitColumns"> & {
  omitColumns?: TOmittedColumns;
};

/**
 * A row filter for {@link defineSyncTable}'s `shape`: either a static {@link RowFilterSpec}, or a
 * function of the table's built (typed) columns. The function form is the all-in-one way to author a
 * typed-Drizzle row filter inline — reference columns through `c(columns.x)` exactly as `extras`
 * does with its `self` argument, so `customWhere` builds parameterized Electric `where`s from real,
 * rename-safe column objects instead of hand-written column-name strings.
 */
export type RowFilterInput<TColumns extends Record<string, ColumnBuilderBase>> =
  | RowFilterSpec
  | ((columns: PgBuildExtraConfigColumns<TColumns>) => RowFilterSpec);

/** {@link ShapeSpecInput} whose `rowFilter` may also be a function of the built columns (typed by `TColumns`). */
export type ShapeSpecInputFor<TColumns extends Record<string, ColumnBuilderBase>> = Omit<
  ShapeSpecInput,
  "rowFilter"
> & {
  rowFilter?: RowFilterInput<TColumns>;
};

/**
 * Input for `defineSyncTable`. Supply `tableName + makeColumns` — the Drizzle table
 * (and, for `readwrite` mode, the read-model view) are created internally.
 *
 * Access the built objects via `.table` and `.view` on the returned entry.
 */
export type SyncTableInput<
  TName extends string,
  TColumns extends Record<string, ColumnBuilderBase>,
  TOmittedColumns extends readonly ColumnKeys<TColumns>[] = [],
> = {
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
  shape?: ShapeSpecInputFor<TColumns>;
  clientProjection?: SyncTableInputProjection<TColumns, TOmittedColumns>;
  /** Server-side response-path projection (e.g. `rowTransform`). Server authority, not client shape. */
  serverProjection?: ServerProjectionSpec;
  governance?: SyncTableInputGovernance<TColumns>;
  /**
   * Conflict policy (ADR-0015): what happens to a stale write on this table. **Required for writable
   * tables** — `defineSyncTable`/`defineSyncRegistry` reject a writable table without one. See
   * {@link ConflictPolicy}.
   */
  conflictPolicy?: ConflictPolicy;
  /**
   * Bind this table into a consistency group (ADR-0009 decision 2): grouped tables sync on one
   * `MultiShapeStream` and commit atomically. Omit for the default singleton group. See
   * {@link SyncTableEntry.consistencyGroup}.
   */
  consistencyGroup?: string;
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

type GovernanceShapeForEntry<TEntry> =
  TEntry extends SyncTableInputGovernanceMarker<infer TGovernance>
    ? TGovernance
    : TEntry extends { governance?: infer TGovernance }
      ? TGovernance
      : never;

type ManagedFieldColumnKeysForOperation<TEntry, TOperation extends ManagedFieldApplyOn> =
  GovernanceShapeForEntry<TEntry> extends {
    managedFields?: ReadonlyArray<infer TField>;
  }
    ? TField extends {
        column: infer TColumn extends string;
        applyOn: ReadonlyArray<ManagedFieldApplyOn>;
      }
      ? TOperation extends TField["applyOn"][number]
        ? TColumn
        : never
      : never
    : never;

export type SyncTableCreateInput<TRegistry extends SyncTableRegistry, TKey extends keyof TRegistry> =
  TRegistry[TKey] extends SyncTableEntry<AnyPgTable, infer TLocalTable extends AnyPgTable>
    ? Omit<InferInsertModel<TLocalTable>, ManagedFieldColumnKeysForOperation<TRegistry[TKey], "create">>
    : never;

export type SyncTableUpdateInput<TRegistry extends SyncTableRegistry, TKey extends keyof TRegistry> =
  TRegistry[TKey] extends SyncTableEntry<AnyPgTable, infer TLocalTable extends AnyPgTable>
    ? Partial<Omit<InferInsertModel<TLocalTable>, ManagedFieldColumnKeysForOperation<TRegistry[TKey], "update">>>
    : never;

export type SyncTableRecord<TRegistry extends SyncTableRegistry, TKey extends keyof TRegistry> =
  TRegistry[TKey] extends SyncTableEntry<infer TTable extends AnyPgTable, AnyPgTable>
    ? InferSelectModel<TTable>
    : never;

/**
 * Filters a columns object, omitting keys in `omitSet`, while preserving TypeScript column types.
 * When `omitSet` is empty the original object is returned unchanged (no copy, no type loss).
 */
function viewColumnsForProjection<
  TColumns extends Record<string, ColumnBuilderBase>,
  const TOmittedColumns extends readonly ColumnKeys<TColumns>[],
>(columns: TColumns, omittedColumns: TOmittedColumns): ProjectedColumnsShape<TColumns, TOmittedColumns> {
  if (omittedColumns.length === 0) {
    return columns as ProjectedColumnsShape<TColumns, TOmittedColumns>;
  }

  const omitSet = new Set<string>(omittedColumns);
  return Object.fromEntries(Object.entries(columns).filter(([key]) => !omitSet.has(key))) as ProjectedColumnsShape<
    TColumns,
    TOmittedColumns
  >;
}

/**
 * Defines a sync table entry. Provide `tableName` and `makeColumns` — the Drizzle
 * `pgTable` (and, for `readwrite` mode, the `_read_model` view) are created here.
 *
 * Access the built objects via `.table` and `.view` on the returned entry.
 */
export function defineSyncTable<
  const TName extends string,
  const TColumns extends Record<string, ColumnBuilderBase>,
  const TOmittedColumns extends readonly ColumnKeys<TColumns>[] = [],
  const TGovernance extends SyncTableInputGovernance<TColumns> | undefined = undefined,
>(input: Omit<SyncTableInput<TName, TColumns, TOmittedColumns>, "governance"> & { governance?: TGovernance }) {
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
    serverProjection,
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

  const extrasFn =
    policies || extras
      ? (self: PgBuildExtraConfigColumns<ReturnType<typeof makeColumns>>) => [
          ...(policies ?? []),
          ...(extras ? extras(self) : []),
        ]
      : undefined;
  const table = schema ? schema.table(tableName, makeColumns(), extrasFn) : pgTable(tableName, makeColumns(), extrasFn);

  // A function-form `shape.rowFilter` is resolved here against the built (typed) columns, so an
  // all-in-one `defineSyncTable` can author a row filter with `c(columns.x)` Drizzle fragments — the
  // same typed columns `extras` receives — instead of hand-written column-name strings. A static
  // `RowFilterSpec` passes through unchanged.
  const resolvedRowFilter: RowFilterSpec | undefined =
    typeof shape?.rowFilter === "function"
      ? shape.rowFilter(getColumns(table) as unknown as PgBuildExtraConfigColumns<ReturnType<typeof makeColumns>>)
      : (shape?.rowFilter ?? undefined);
  const resolvedShape: ShapeSpec | undefined =
    resolvedMode !== "writeonly" || shape != null
      ? {
          tableName: shape?.tableName ?? tableName,
          shapeKey: shape?.shapeKey ?? shape?.tableName ?? tableName,
          ...(shape?.electricTable != null ? { electricTable: shape.electricTable } : {}),
          ...(resolvedRowFilter != null ? { rowFilter: resolvedRowFilter } : {}),
        }
      : undefined;

  const omittedColumns = (clientProjection?.omitColumns ?? []) as TOmittedColumns;
  const projectedCols = viewColumnsForProjection(makeColumns(), omittedColumns);
  const localTable = (
    schema ? schema.table(tableName, projectedCols) : pgTable(tableName, projectedCols)
  ) as ProjectedLocalTable<TName, TColumns, TOmittedColumns>;

  const viewColumns = viewColumnsForProjection(makeColumns(), omittedColumns);
  const view =
    resolvedMode === "readwrite"
      ? (pgView(`${tableName}_read_model`, {
          ...viewColumns,
          overlay_kind: varchar("overlay_kind", { length: 24 }).notNull(),
          local_updated_at_us: bigint("local_updated_at_us", { mode: "bigint" }).notNull(),
        }).existing() as ReadModelView<TName, TColumns, TOmittedColumns>)
      : undefined;

  const entry = {
    ...otherRest,
    mode: resolvedMode,
    primaryKey: resolvedPrimaryKey,
    ...(resolvedShape != null ? { shape: resolvedShape } : {}),
    // The input specs are typed over the builder columns map (keys of
    // TColumns); the entry fields demand specs typed over the built table.
    // The key sets are equal by construction (BuildColumns preserves keys),
    // but that equality is unprovable while TColumns is an open generic.
    ...(governance != null ? { governance: governance as TableGovernanceSpecForTable<typeof table> } : {}),
    ...(resolvedClientProjection != null
      ? { clientProjection: resolvedClientProjection as unknown as ClientProjectionSpecForTable<typeof table> }
      : {}),
    ...(serverProjection != null ? { serverProjection } : {}),
    table,
    localTable,
    ...(view != null ? { view } : {}),
  };
  validateSyncTableEntry(entry as unknown as SyncTableEntry<AnyPgTable>);
  return entry as typeof entry & SyncTableInputGovernanceMarker<TGovernance>;
}

export function defineSyncRegistry<const TRegistry extends { [TKey in keyof TRegistry]: SyncTableEntry }>(
  registry: TRegistry,
): TRegistry;
export function defineSyncRegistry<const TRegistry extends { [TKey in keyof TRegistry]: SyncTableEntry }>(
  definition: SyncRegistryDefinition<TRegistry>,
): TRegistry;
export function defineSyncRegistry<const TRegistry extends { [TKey in keyof TRegistry]: SyncTableEntry }>(
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

/**
 * Resolves the {@link SyncColumnType}s of a synced table's client-projected columns from its Drizzle
 * definition (ADR-0009 decision 3) — the same `getSQLType()`/`dimensions` introspection the local
 * schema generator uses, so the apply ladder and the generated DDL can never disagree about a
 * column's type. Drives both {@link classifyTableApplyStrategy} and the engine's `json` apply cast,
 * removing the runtime `information_schema` round-trip.
 */
export function deriveSyncColumnTypes<TTable extends AnyPgTable>(entry: SyncTableEntry<TTable>): SyncColumnType[] {
  return getProjectedColumns(entry).map(({ column, columnName }) => {
    const typedColumn = column as { getSQLType?: () => string; dimensions?: number };
    const sqlType = typedColumn.getSQLType?.() ?? "";
    return {
      name: columnName,
      sqlType,
      isArray: (typedColumn.dimensions ?? 0) > 0,
    } satisfies SyncColumnType;
  });
}

/** The statically-chosen bulk-insert strategy for a synced table (ADR-0009 decision 3). */
export function classifyTableApplyStrategy<TTable extends AnyPgTable>(entry: SyncTableEntry<TTable>): ApplyStrategy {
  return classifyApplyStrategy(deriveSyncColumnTypes(entry));
}

export function getOmittedProjectedColumnNames<TTable extends AnyPgTable>(entry: SyncTableEntry<TTable>) {
  return getOmittedProjectedColumns(entry).map(({ columnName }) => columnName);
}

export function getLocalSyncedTablePrimaryKeyColumns<TTable extends AnyPgTable>(entry: SyncTableEntry<TTable>) {
  return [...(entry.clientProjection?.localPrimaryKey?.columns ?? entry.primaryKey.columns)];
}

/**
 * The Server version column (ADR-0010): the `nowMicroseconds`-on-update managed field a writable
 * table stamps on every write (conventionally `updated_at_us`), made strictly monotonic by the
 * applier. Returns its **column name**, resolving the managed field's drizzle property key. Returns
 * `undefined` when none is declared — registry validation rejects that for writable tables, so the
 * convergence barrier never has to degrade.
 */
export function resolveServerVersionColumnName<TTable extends AnyPgTable>(
  entry: SyncTableEntry<TTable>,
): string | undefined {
  const field = (entry.governance?.managedFields ?? []).find(
    (managed) => managed.strategy === "nowMicroseconds" && managed.applyOn.includes("update"),
  );

  if (!field) {
    return undefined;
  }

  const columns = getColumns(entry.table);
  // `field.column` is the drizzle property key; resolve it to the underlying column name.
  const byProperty = (columns as Record<string, { name: string } | undefined>)[field.column as string];
  if (byProperty) {
    return byProperty.name;
  }

  // Defensive: a managed field declared by column name rather than property key.
  return Object.values(columns).find((column) => column.name === field.column)?.name;
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

  // ADR-0010: a writable synced table must declare a Server version — a nowMicroseconds-on-update
  // managed field (conventionally updated_at_us) the applier stamps and keeps strictly monotonic.
  // Optimistic convergence is unsound without a per-row version (the barrier would degenerate to a
  // flicker-prone key-match), so this is a hard requirement, not a silent degraded fallback.
  if (entry.mode !== "readonly" && resolveServerVersionColumnName(entry) === undefined) {
    throw new Error(
      `writable table ${tableName} must declare a Server version: a managed field with strategy ` +
        `"nowMicroseconds" and applyOn including "update" (conventionally updated_at_us) — ADR-0010`,
    );
  }

  // ADR-0015: every writable table must declare a Conflict policy — what happens to a stale write.
  // There is no silent default: silent last-write-wins is exactly the data loss the policy exists to
  // turn into a conscious per-table decision. This is the third hard-require (after the Server version
  // above and the server-PK-in-projection rule below), accepted as consistent with the footgun-averse
  // stance.
  if (entry.mode !== "readonly" && !isConflictPolicy(entry.conflictPolicy)) {
    throw new Error(
      `writable table ${tableName} must declare a Conflict policy (ADR-0015): conflictPolicy must be ` +
        `one of ${CONFLICT_POLICIES.join(", ")}` +
        (entry.conflictPolicy === undefined ? " (none was declared)" : ` (got ${String(entry.conflictPolicy)})`),
    );
  }

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
