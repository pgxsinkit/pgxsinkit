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
  isRetention,
  isSubscriptionTiming,
  isWriteMode,
  RETENTIONS,
  SUBSCRIPTION_TIMINGS,
  WRITE_MODES,
  type ClientProjectionSpec,
  type ConflictPolicy,
  type DeferrableConstraintSpec,
  type ManagedFieldApplyOn,
  type ManagedFieldSpec,
  type ManagedFieldStrategy,
  type PrimaryKeySpec,
  type Retention,
  type RowFilterSpec,
  type ServerProjectionSpec,
  type ShapeSpec,
  type ShapeSpecInput,
  type SubscriptionTiming,
  type TableGovernanceSpec as TableGovernanceSpecBase,
  type TableMode,
  type WriteMode,
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
  /**
   * Subscription timing (ADR-0021): `eager` (default) | `lazy`. A `lazy` table is excluded from the
   * boot subscription set and subscribed on first query-reference. A property of the **consistency
   * group** — every table sharing a `consistencyGroup` must agree (validated). See
   * {@link SubscriptionTiming}.
   */
  subscription?: SubscriptionTiming;
  /**
   * Retention (ADR-0021): `persistent` (default) | `ephemeral`. An `ephemeral` table's whole local
   * cluster is emitted as `TEMP` — no durable trace, no durable offline write queue. A property of the
   * consistency group — every table sharing a `consistencyGroup` must agree (validated). See
   * {@link Retention}.
   */
  retention?: Retention;
  /**
   * Write-mode (ADR-0022): `optimistic` (default) | `pessimistic`. A `pessimistic` consistency group is a
   * standing server-authoritative write-unit — its writes flush-route to the authoritative endpoint and
   * the UI shows success only after the server confirms. Write-mode is a property of the **write-unit**;
   * the static write-unit is the consistency group, so every table sharing a `consistencyGroup` must agree
   * (validated). See {@link WriteMode}.
   */
  writeMode?: WriteMode;
  /**
   * True when this entry is a read PROJECTION over a table OWNED by another entry (built by
   * {@link defineReadProjection}). Such an entry owns no physical table — its `table` is the owner's,
   * and only its `localTable` + `shape` are its own — so migration/apply/RLS generation skips it and a
   * consumer's schema barrel must never export a fresh table for it. Absent → the entry owns its table.
   */
  readProjection?: boolean;
  /**
   * The column-builder factory that produced this entry's table (set by {@link defineSyncTable}).
   * Retained so {@link defineReadProjection} can reuse the owner's column definitions to build a typed
   * column subset without restating them. Internal: not part of the read/identity contract, not
   * fingerprinted, and absent from hand-built entries (e.g. {@link asReadonly} results).
   */
  makeColumns?: () => Record<string, ColumnBuilderBase>;
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
  /**
   * Subscription timing (ADR-0021): `eager` (default) | `lazy`. See
   * {@link SyncTableEntry.subscription}.
   */
  subscription?: SubscriptionTiming;
  /**
   * Retention (ADR-0021): `persistent` (default) | `ephemeral`. See {@link SyncTableEntry.retention}.
   */
  retention?: Retention;
  /**
   * Write-mode (ADR-0022): `optimistic` (default) | `pessimistic`. See {@link SyncTableEntry.writeMode}.
   */
  writeMode?: WriteMode;
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
          // `electricTable` is never set from input (it is not in ShapeSpecInput) — an owner reads its
          // own table. It is filled by `attachSyncRegistrySchema` (schema qualification) or by
          // `defineReadProjection` (which points a projection at the owning physical table).
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
    // Retained so `defineReadProjection` can reuse these column definitions for a typed subset.
    makeColumns: makeColumns as () => Record<string, ColumnBuilderBase>,
  };
  validateSyncTableEntry(entry as unknown as SyncTableEntry<AnyPgTable>);
  return entry as typeof entry & SyncTableInputGovernanceMarker<TGovernance>;
}

/**
 * Define a **read projection**: a second client shape over a table an `owner` entry already owns. The
 * projection reads the SAME physical rows under a DISTINCT local identity (`as`) and its own narrower
 * shape — a typed column subset and/or an admin/role-scoped `rowFilter` — without owning, migrating, or
 * RLS-guarding any new table. The first use is a light admin view of a heavy authoring table (titles,
 * not the jsonb), while the learner keeps reading the full table through the owner's shape.
 *
 * It is the *obvious, DRY* way to express "another shape over this table", versus the bare
 * `shape.electricTable` string it replaces (a footgun — config that silently un-asserts table
 * ownership):
 *
 * - **Owns nothing.** The returned entry's `table` IS `owner.table` (the same object), so there is no
 *   new `pgTable` to migrate or to leak into a drizzle-kit schema barrel. Only `localTable` (named `as`)
 *   and `shape` are its own. `readProjection` is set so generators skip it.
 * - **DRY columns.** `columns` is a typed subset of the owner's column keys; the local table is built by
 *   filtering the owner's own column definitions (never restated), and the same subset becomes the
 *   Electric `columns` allow-list so an omitted (e.g. heavy jsonb) column never crosses the wire. The
 *   primary key is always kept. Omit `columns` to sync every column.
 * - **Source is derived, never named.** The physical Electric target is taken from the owner — there is
 *   no consumer-facing source field to get wrong (see {@link ShapeSpec.electricTable}).
 * - **Readonly.** A projection has no write path; the engine resolves an incoming shape request by its
 *   unique `shapeKey` (= `as`) and consults the derived physical target only on egress.
 *
 * The `rowFilter` callback receives the OWNER's full columns — `customWhere` runs in Electric against
 * the physical table, so it may reference a column the local subset omits. RLS for the projection's
 * reads lives on the OWNER's table (a projection adds no DDL to a table it does not own); its
 * `customWhere` must be a subset of what that RLS allows.
 */
export function defineReadProjection<const TOwnerTable extends AnyPgTable, const TAs extends string>(
  owner: SyncTableEntry<TOwnerTable>,
  opts: {
    /** The projection's distinct local identity — its PGlite table name AND its `shapeKey`. */
    as: TAs;
    /** Column keys (of the owner) to sync locally + fetch from Electric. The PK is always kept. Omit → all. */
    columns?: readonly TableColumnKey<TOwnerTable>[];
    /** Row filter for this shape; the callback form receives the owner's full (physical) columns. */
    rowFilter?: RowFilterSpec | ((columns: TableColumnsShape<TOwnerTable>) => RowFilterSpec);
    consistencyGroup?: string;
    subscription?: SubscriptionTiming;
    retention?: Retention;
  },
) {
  const ownerMakeColumns = owner.makeColumns;
  if (!ownerMakeColumns) {
    throw new Error(
      `defineReadProjection: owner "${getTableConfig(owner.table).name}" has no column factory — pass an ` +
        `entry built directly by defineSyncTable (not an asReadonly/derived projection).`,
    );
  }

  const physicalTable = getTableConfig(owner.table).name;
  const allKeys = Object.keys(ownerMakeColumns());
  const pkKeys = owner.primaryKey.columns;
  const keep = opts.columns ? new Set<string>([...opts.columns, ...pkKeys]) : new Set(allKeys);
  // The subset is expressed as `omitColumns` over the OWNER's full columns, so every column-derivation
  // helper (deriveSyncColumnTypes / classifyTableApplyStrategy / getProjectedColumnNames) — which read
  // `entry.table` minus `omitColumns` — yields the right subset for the client, with `entry.table`
  // staying the owner's physical table (nothing new to migrate). The primary key is always kept.
  const omittedKeys = allKeys.filter((key) => !keep.has(key));

  // The local table (subset) + base shape (tableName/shapeKey = `as`) + readonly validation come from the
  // normal constructor — reusing the OWNER's column definitions, never restating them. Below we override
  // only what a projection differs in (it owns no table; it reads the owner's physical table).
  const built = defineSyncTable({
    tableName: opts.as,
    makeColumns: ownerMakeColumns,
    mode: "readonly",
    primaryKey: [...pkKeys],
    ...(omittedKeys.length > 0
      ? { clientProjection: { omitColumns: omittedKeys as unknown as readonly never[] } }
      : {}),
    ...(opts.consistencyGroup != null ? { consistencyGroup: opts.consistencyGroup } : {}),
    ...(opts.subscription != null ? { subscription: opts.subscription } : {}),
    ...(opts.retention != null ? { retention: opts.retention } : {}),
  });

  // Resolve the row filter against the OWNER's full columns (the customWhere runs in Electric on the
  // physical table, so it may reference a column the subset omits).
  const resolvedRowFilter: RowFilterSpec | undefined =
    typeof opts.rowFilter === "function"
      ? opts.rowFilter(getColumns(owner.table) as unknown as TableColumnsShape<TOwnerTable>)
      : opts.rowFilter;

  // When a subset is requested, set the Electric `columns` allow-list to the KEPT physical column names
  // so an omitted (e.g. heavy jsonb) column is never fetched over the wire — not merely stripped after.
  const allowListColumns = omittedKeys.length > 0 ? getProjectedColumnNames(built) : undefined;

  const rowFilter: RowFilterSpec | undefined =
    resolvedRowFilter != null || allowListColumns != null
      ? {
          ...(resolvedRowFilter ?? {}),
          ...(allowListColumns != null ? { columns: allowListColumns } : {}),
        }
      : undefined;

  const shape: ShapeSpec = {
    tableName: opts.as,
    shapeKey: opts.as,
    electricTable: physicalTable,
    ...(rowFilter != null ? { rowFilter } : {}),
  };

  // A projection owns no table — drop the stashed column factory (omit, don't set undefined) so it can
  // never be mistaken for an owner, and point `table` at the owner's physical table. `built` was
  // validated by defineSyncTable and only its `table` is replaced (with the owner's, structurally
  // identical role), so the result is a sound SyncTableEntry — cast past the spread's exactOptional
  // friction to a clean entry type that keeps the projected local-table shape.
  const { makeColumns: _ownerOnly, ...rest } = built;
  const projection = {
    ...rest,
    table: owner.table,
    shape,
    readProjection: true as const,
  };
  return projection as unknown as SyncTableEntry<TOwnerTable, typeof built.localTable> & { readProjection: true };
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
    validateRegistryTableUniqueness(input.tables);
    validateRegistryLifecycleGroups(input.tables);

    return attachSyncRegistrySchema(input.tables, input.schema);
  }

  for (const entry of getRegistryEntries(input)) {
    validateSyncTableEntry(entry as SyncTableEntry<AnyPgTable>);
  }
  validateRegistryTableUniqueness(input);
  validateRegistryLifecycleGroups(input);

  return input;
}

/** The local/shape identity an entry resolves to: its `shape.tableName` (the unique shape key a client
 * requests and the local PGlite table), falling back to the Drizzle table name when an entry has no
 * shape (a write-only table). A read projection carries a distinct `shape.tableName` (`as`) even though
 * its `table` is the owner's, so it is identified here by `as`, never by the shared physical table. */
function localShapeIdentity(entry: SyncTableEntry<AnyPgTable>): string {
  return entry.shape?.tableName ?? getTableConfig(entry.table).name;
}

/**
 * A registry must not declare the same local table twice. Every entry resolves to one local identity
 * ({@link localShapeIdentity}) — the PGlite table a client reads and the `shapeKey` the proxy resolves a
 * request by — so two entries sharing it would collide locally (one shadows the other) and make the
 * shape unresolvable. A read PROJECTION over a shared physical table does NOT trip this: it carries a
 * DISTINCT local identity (`as`) and points at the owning table via the derived `shape.electricTable`,
 * so several shapes read one physical table while their local identities stay unique. Fails closed at
 * module-eval, for every consumer.
 */
function validateRegistryTableUniqueness(registry: SyncTableRegistry) {
  const declaredBy = new Map<string, string>();

  for (const [key, entry] of Object.entries(registry)) {
    const identity = localShapeIdentity(entry as SyncTableEntry<AnyPgTable>);
    const firstKey = declaredBy.get(identity);

    if (firstKey !== undefined) {
      throw new Error(
        `local table "${identity}" is declared by two registry entries ("${firstKey}" and "${key}"): ` +
          `each entry must map to a unique local table. A second shape over an existing physical table ` +
          `must use defineReadProjection (a distinct "as") rather than a second owning entry.`,
      );
    }

    declaredBy.set(identity, key);
  }
}

/**
 * ADR-0021 §4 / ADR-0022 §1–2: subscription timing, retention, and write-mode are properties of a
 * **consistency group**, not a single table — a group commits atomically on one `MultiShapeStream`
 * (so it cannot be partly lazy or partly ephemeral) and a consistency group *is* the static
 * write-unit (so it cannot be partly pessimistic). Reject a registry whose grouped tables disagree on
 * any of the three. Tables without a `consistencyGroup` are their own singleton group and are
 * unconstrained.
 */
function validateRegistryLifecycleGroups(registry: SyncTableRegistry) {
  const groups = new Map<
    string,
    Array<{ tableName: string; subscription: SubscriptionTiming; retention: Retention; writeMode: WriteMode }>
  >();

  for (const entry of getRegistryEntries(registry)) {
    if (!entry.consistencyGroup) {
      continue;
    }

    const members = groups.get(entry.consistencyGroup) ?? [];
    members.push({
      tableName: getTableConfig(entry.table).name,
      subscription: entry.subscription ?? "eager",
      retention: entry.retention ?? "persistent",
      writeMode: entry.writeMode ?? "optimistic",
    });
    groups.set(entry.consistencyGroup, members);
  }

  for (const [group, members] of groups) {
    const subscriptions = new Set(members.map((member) => member.subscription));
    const retentions = new Set(members.map((member) => member.retention));
    const writeModes = new Set(members.map((member) => member.writeMode));

    if (subscriptions.size > 1 || retentions.size > 1 || writeModes.size > 1) {
      throw new Error(
        `consistency group "${group}" mixes lifecycle (ADR-0021 §4 / ADR-0022 §1): every table in a ` +
          `group must share one subscription, one retention, and one write-mode; got ` +
          members
            .map((member) => `${member.tableName}=${member.subscription}/${member.retention}/${member.writeMode}`)
            .join(", "),
      );
    }
  }
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

    const qualify = (name: string) => (name.includes(".") ? name : `${normalizedSchema}.${name}`);
    const qualifiedTableName = `${normalizedSchema}.${entry.shape.tableName}`;
    entry.shape = {
      ...entry.shape,
      // A read projection sets electricTable to the owner's (bare) physical name; qualify it the same
      // way the owner's own target is qualified, so both shapes hit one schema-qualified table on egress.
      // An owner (no electricTable) qualifies its own tableName. An already-qualified value is left as-is.
      electricTable: entry.shape.electricTable ? qualify(entry.shape.electricTable) : qualifiedTableName,
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

  // ADR-0021: the lifecycle axes are optional (default eager/persistent), but a declared value must be
  // valid. Group-level uniformity (every table in a consistency group agrees) is checked at the
  // registry level in defineSyncRegistry, where the whole table set is visible.
  if (entry.subscription !== undefined && !isSubscriptionTiming(entry.subscription)) {
    throw new Error(
      `table ${tableName} has an invalid subscription (ADR-0021): must be one of ` +
        `${SUBSCRIPTION_TIMINGS.join(", ")} (got ${String(entry.subscription)})`,
    );
  }
  if (entry.retention !== undefined && !isRetention(entry.retention)) {
    throw new Error(
      `table ${tableName} has an invalid retention (ADR-0021): must be one of ` +
        `${RETENTIONS.join(", ")} (got ${String(entry.retention)})`,
    );
  }

  // ADR-0022: write-mode is optional (default optimistic), but a declared value must be valid and
  // meaningful. `pessimistic` governs the write path, which a `readonly` table does not have, so reject
  // it there. Group-level uniformity is checked at the registry level alongside the lifecycle axes.
  if (entry.writeMode !== undefined && !isWriteMode(entry.writeMode)) {
    throw new Error(
      `table ${tableName} has an invalid writeMode (ADR-0022): must be one of ` +
        `${WRITE_MODES.join(", ")} (got ${String(entry.writeMode)})`,
    );
  }
  if (entry.writeMode === "pessimistic" && entry.mode === "readonly") {
    throw new Error(
      `readonly table ${tableName} cannot be pessimistic (ADR-0022): write-mode governs the write path, ` +
        `which a readonly table does not have. Declare writeMode only on a writable table.`,
    );
  }

  // The single claim-stamping strategy (ADR-0026): an `authClaim` managed field reads a value from the
  // verified request claims at a JSON path, emitted into the apply-function DDL — so the path segments
  // must be plain identifiers and any cast a plain type name (never a value-injection surface). A
  // non-authClaim field carrying claimPath/cast is an authoring slip; reject it rather than ignore it.
  for (const field of entry.governance?.managedFields ?? []) {
    if (field.strategy === "authClaim") {
      if (!Array.isArray(field.claimPath) || field.claimPath.length === 0) {
        throw new Error(
          `managed field ${tableName}.${String(field.column)} (strategy "authClaim") must declare a non-empty ` +
            `claimPath (e.g. ["sub"] or ["app_metadata","person_id"]) — ADR-0026`,
        );
      }
      for (const segment of field.claimPath) {
        if (typeof segment !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(segment)) {
          throw new Error(
            `managed field ${tableName}.${String(field.column)} has an invalid claimPath segment ` +
              `${JSON.stringify(segment)}: each segment must match [A-Za-z_][A-Za-z0-9_]* (it is emitted into ` +
              `the apply-function DDL)`,
          );
        }
      }
      if (field.cast !== undefined && !/^[A-Za-z_][A-Za-z0-9_ ]*$/.test(field.cast)) {
        throw new Error(
          `managed field ${tableName}.${String(field.column)} has an invalid cast ${JSON.stringify(field.cast)}: ` +
            `must be a plain SQL type name (e.g. "uuid", "text")`,
        );
      }
    } else if (field.claimPath !== undefined || field.cast !== undefined) {
      throw new Error(
        `managed field ${tableName}.${String(field.column)} declares claimPath/cast but its strategy is ` +
          `"${field.strategy}" — those apply only to "authClaim"`,
      );
    }
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
