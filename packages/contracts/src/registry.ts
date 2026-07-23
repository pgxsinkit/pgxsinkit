import type { ColumnBuilderBase, InferInsertModel, InferSelectModel } from "drizzle-orm";
import {
  bigint,
  getTableConfig,
  pgTable,
  pgView,
  primaryKey as pgPrimaryKey,
  PrimaryKeyBuilder,
  type AnyPgColumn,
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
  isStorageBackend,
  isStorageDurability,
  isSubscriptionTiming,
  isWriteMode,
  RETENTIONS,
  STORAGE_BACKENDS,
  STORAGE_DURABILITIES,
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
  type SyncStorageDeclaration,
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
  // `| undefined` (with exactOptionalPropertyTypes) admits `defineSyncTable`'s ALWAYS-PRESENT `view`
  // key, whose value is undefined for entries without a read model — see the entry construction.
  view?: AnyPgView | undefined;
  mode: TableMode;
  primaryKey: PrimaryKeySpec;
  /**
   * CDC insert-apply policy (ADR-0045). Default `"insert"`: a server CDC `insert` is applied as a plain
   * INSERT, so a genuine primary-key collision surfaces (the ADR-0014 collision-surfacing invariant).
   * `"upsert"`: this table legitimately receives locally-derived provisional rows (e.g. written by a
   * local trigger from another synced table), so server CDC inserts are applied idempotently as
   * `INSERT … ON CONFLICT (pk) DO UPDATE` — the authoritative server row overwrites the provisional
   * local row instead of failing the commit. Resolved to `"insert"` when omitted.
   */
  applyMode: "insert" | "upsert";
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
   * table is its own singleton group (independent frontier, no cross-table atomicity — the resolution
   * for a table that declares no group). The latency cost (a group advances only as fast as its
   * slowest shape) is contained to the tables that opt in.
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
   * column subset without restating them, AND — since ADR-0029 P1 — so the client can derive every
   * synced-table object (the local synced read cache, overlay, journal) via
   * `getSyncedLocalTable` → `projectedColumnBuilders`. It is therefore read-derivation machinery, not a
   * write handle: it is carried through every projection ({@link asReadonly}, `withRetention`,
   * `defineReadProjection`), NOT fingerprinted (functions are invisible to the read-contract hash), and
   * required on every registered entry — `defineSyncRegistry`/`validateSyncTableEntry` reject a
   * hand-assembled entry that lacks it, since the client hard-requires it at boot.
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

/**
 * The local table TYPE for a {@link defineReadProjection} entry: the OWNER's already-built columns
 * (`TableColumnsShape<TOwnerTable>`) restricted to the kept keys (`TKeptKey`), under the projection's own
 * local name (`TAs`).
 *
 * Why this exists rather than reusing the inner `defineSyncTable`'s `localTable` type: a projection
 * rebuilds its columns from the owner's stashed `makeColumns`, but {@link SyncTableEntry.makeColumns} is
 * type-erased to `() => Record<string, ColumnBuilderBase>`, so a `localTable` inferred through it collapses
 * to an open index signature — forcing bracket-access + `!` in consumers. Picking directly off
 * `TOwnerTable`'s real column types restores rename-safe, per-column typing.
 *
 * Sound by construction — never an over-claim: the runtime keeps `columns ∪ primaryKey`, a SUPERSET of
 * `TKeptKey`, so every typed column exists at runtime. A primary-key column not listed in `columns` is
 * kept at runtime but omitted from the type (a safe under-claim; include it in `columns` to type it).
 */
type ProjectionLocalTable<
  TOwnerTable extends AnyPgTable,
  TAs extends string,
  TKeptKey extends string,
> = PgTableWithColumns<{
  name: TAs;
  schema: string | undefined;
  columns: Pick<TableColumnsShape<TOwnerTable>, TKeptKey & keyof TableColumnsShape<TOwnerTable>>;
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
 * A row filter for {@link defineSyncTable}'s `shape`, authored from the table's built, typed columns.
 * Reference columns through `c(columns.x)` exactly as `extras` does with its `self` argument, so
 * `customWhere` builds parameterized Electric `where`s from real, rename-safe column objects instead
 * of hand-written column-name strings.
 */
export type RowFilterInput<TColumns extends Record<string, ColumnBuilderBase>> = (
  columns: PgBuildExtraConfigColumns<TColumns>,
) => RowFilterSpec;

/** {@link ShapeSpecInput} whose `rowFilter` is authored from the built columns (typed by `TColumns`). */
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
   * THE primary key of the server table — the single source of truth for its physical
   * `PRIMARY KEY` constraint. `defineSyncTable` emits it as the constraint, named
   * `` `${tableName}_pkey` `` (matching Postgres's inline-PK default, so existing consumer
   * databases see no rename churn) unless the object form overrides `name`.
   *
   * Defaults to `["id"]`. Use an array with multiple entries for composite keys, or the object
   * form `{ name, columns }` to name the constraint.
   *
   * A single-column key MAY equivalently be declared via the column's own `.primaryKey()`
   * (idiomatic drizzle); it must match this spec, and emission is then skipped because the
   * column already carries the constraint. A table-level `primaryKey(...)` in `extras`/`policies`
   * is REJECTED — declare the key here instead.
   */
  primaryKey?: string[] | { name: string; columns: string[] };
  /**
   * CDC insert-apply policy (ADR-0045). **Default `"insert"`** — a CDC insert is a plain INSERT, so a
   * genuine PK collision must surface (the ADR-0014 collision-surfacing invariant; a synced cache table
   * is server-authoritative and a duplicate insert is a real bug). Set `"upsert"` **only** when this
   * table legitimately receives locally-DERIVED provisional rows — e.g. a local trigger on another
   * synced table inserts a provisional row here, and the server independently creates the same row so
   * its CDC insert would collide (23505). With `"upsert"`, server CDC inserts are applied idempotently
   * as `INSERT … ON CONFLICT (pk) DO UPDATE`; the authoritative server row overwrites the provisional
   * local row. Declare the exception here, where it lives — do not weaken the invariant repo-wide.
   */
  applyMode?: "insert" | "upsert";
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
  /**
   * The storage contract for every store this registry mints (ADR-0049 decision 1, ADR-0047). Part of the
   * DATA contract, not a per-open knob: `durability` binds every toolkit-minted open (relaxed default),
   * and `backend` scopes the BROWSER store only (`opfs` default; Node/`file` and `memory` clones
   * unaffected). Validated at {@link defineSyncRegistry} (fail-closed at module-eval); carried through on
   * the returned registry and read back with {@link getSyncRegistryStorage}. See {@link SyncStorageDeclaration}.
   */
  storage?: SyncStorageDeclaration;
}

export const syncRegistrySchemaSymbol = Symbol.for("@pgxsinkit/contracts/syncRegistrySchema");

export const syncRegistryStorageSymbol = Symbol.for("@pgxsinkit/contracts/syncRegistryStorage");

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
  // The mode LITERAL, so the entry's `view` type can be conditional on it: readwrite entries carry a
  // typed ReadModelView, everything else carries undefined — which is what lets `RegistryViews`
  // (and so `client.views`) keep exactly the read-model entries at the type level.
  const TMode extends TableMode = "readonly",
>(
  input: Omit<SyncTableInput<TName, TColumns, TOmittedColumns>, "governance" | "mode"> & {
    governance?: TGovernance;
    /** @default "readonly" */
    mode?: TMode;
  },
) {
  const {
    tableName,
    makeColumns,
    policies,
    extras,
    schema,
    mode,
    primaryKey,
    applyMode,
    governance,
    clientProjection,
    serverProjection,
    shape,
    ...otherRest
  } = input;

  const resolvedMode: TableMode = mode ?? "readonly";

  // The `primaryKey` spec is the SINGLE SOURCE OF TRUTH for the server table's physical PRIMARY KEY.
  // It was runtime-only metadata until a consumer (transcrobes) had drizzle-kit DROP a composite PK
  // from a live DB because nothing re-declared it in DDL — so `defineSyncTable` now emits the
  // constraint itself. The default constraint name `${tableName}_pkey` matches Postgres's inline-PK
  // naming, so existing consumer databases see no rename churn; the object form overrides it.
  const primaryKeyColumns = Array.isArray(primaryKey) ? primaryKey : (primaryKey?.columns ?? ["id"]);
  const resolvedPrimaryKey: PrimaryKeySpec = { columns: primaryKeyColumns };

  // ADR-0045: default to the strict `"insert"` policy (a CDC insert is a plain INSERT — a genuine PK
  // collision must surface). Only tables that legitimately receive locally-derived provisional rows opt
  // into idempotent `"upsert"` apply of server CDC inserts.
  const resolvedApplyMode: "insert" | "upsert" = applyMode ?? "insert";
  const customPrimaryKeyName = !Array.isArray(primaryKey) ? primaryKey?.name : undefined;
  const primaryKeyConstraintName = customPrimaryKeyName ?? `${tableName}_pkey`;

  // Probe the columns (no extras — cheap) to detect idiomatic column-level `.primaryKey()` flags and
  // to resolve each spec column to its PROPERTY KEY (spec entries may be given as the SQL column name
  // or the property key, matching the omitColumns precedent below).
  const probeColumns = getColumns(pgTable(tableName, makeColumns())) as Record<string, AnyPgColumn>;
  const columnLevelPkKeys = Object.entries(probeColumns)
    .filter(([, col]) => col.primary === true)
    .map(([key]) => key);
  const specPropertyKeys = primaryKeyColumns.map((key) => {
    if (probeColumns[key]) return key;
    const byColumnName = Object.entries(probeColumns).find(([, col]) => col.name === key);
    if (byColumnName) return byColumnName[0];
    throw new Error(`[pgxsinkit] ${tableName}: primaryKey column "${key}" not found among the table's columns`);
  });

  if (columnLevelPkKeys.length > 1) {
    throw new Error(
      `[pgxsinkit] ${tableName}: multiple columns declare .primaryKey() (${columnLevelPkKeys.join(", ")}) — declare a composite key via the primaryKey option ({ name?, columns }) and remove the column-level .primaryKey() flags; the spec is the single source of truth`,
    );
  }
  if (columnLevelPkKeys.length === 1) {
    const columnLevelPkKey = columnLevelPkKeys[0]!;
    if (specPropertyKeys.length !== 1 || specPropertyKeys[0] !== columnLevelPkKey) {
      throw new Error(
        `[pgxsinkit] ${tableName}: column "${columnLevelPkKey}" declares .primaryKey() but the primaryKey spec is [${resolvedPrimaryKey.columns.join(", ")}] — they must match; the spec is the single source of truth`,
      );
    }
    if (customPrimaryKeyName != null && customPrimaryKeyName !== `${tableName}_pkey`) {
      throw new Error(
        `[pgxsinkit] ${tableName}: a custom primary-key name ("${customPrimaryKeyName}") requires defineSyncTable to emit the constraint — remove .primaryKey() from column "${columnLevelPkKey}" so the named constraint can be emitted`,
      );
    }
  }
  const emitPrimaryKey = columnLevelPkKeys.length === 0;

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
    policies || extras || emitPrimaryKey
      ? (self: PgBuildExtraConfigColumns<ReturnType<typeof makeColumns>>) => {
          const consumerExtras = [...(policies ?? []), ...(extras ? extras(self) : [])];
          for (const extra of consumerExtras) {
            if (extra instanceof PrimaryKeyBuilder) {
              throw new Error(
                `[pgxsinkit] ${tableName}: declare the primary key via the primaryKey option (string[] or { name, columns }), not a primaryKey(...) extra — the spec is the single source of truth and defineSyncTable emits the constraint`,
              );
            }
          }
          if (!emitPrimaryKey) return consumerExtras;
          const selfCols = self as unknown as Record<string, AnyPgColumn>;
          const pkColumns = specPropertyKeys.map((k) => selfCols[k]!) as [AnyPgColumn, ...AnyPgColumn[]];
          return [...consumerExtras, pgPrimaryKey({ name: primaryKeyConstraintName, columns: pkColumns })];
        }
      : undefined;
  const table = schema ? schema.table(tableName, makeColumns(), extrasFn) : pgTable(tableName, makeColumns(), extrasFn);

  // Resolve `shape.rowFilter` against the built typed columns so all authoring uses rename-safe
  // Drizzle column objects rather than hand-written column-name strings.
  const resolvedRowFilter = shape?.rowFilter?.(
    getColumns(table) as unknown as PgBuildExtraConfigColumns<ReturnType<typeof makeColumns>>,
  );
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
    applyMode: resolvedApplyMode,
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
    // ALWAYS a present key, typed by the mode literal. A conditional spread here would infer `view`
    // as an OPTIONAL property, and RegistryViews' `extends { view: AnyPgView }` filter would then
    // reject every entry — `client.views` typed as `{}` for all consumers while runtime worked
    // (caught by the packed fixture's consumer typecheck, ADR-0037 §4). Runtime `entry.view != null`
    // checks are unaffected by a present-undefined key, and the registry fingerprint canonicalizes
    // named fields, never raw entry keys.
    view: view as TMode extends "readwrite" ? ReadModelView<TName, TColumns, TOmittedColumns> : undefined,
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
 *
 * The `owner` may be a `defineSyncTable` entry OR an `asReadonly` of one — an `asReadonly` projection
 * preserves the full read contract (physical table, columns, primary key) and only drops the write path,
 * so projecting off it is equivalent to projecting off its writable source. A CHAINED read projection
 * (an owner that is itself a `defineReadProjection`) is rejected, because it composes wrongly — see below.
 *
 * ### Server-side egress redaction (`serverProjection` + `serverOnlyColumns`)
 *
 * A projection may carry its own `serverProjection` (a {@link ServerProjectionSpec}, typically a
 * `rowTransform`) — resolved by the projection's `shapeKey` and run on the proxy egress path for this
 * shape only. The order on egress is **transform first, then omission**: the transform runs against the
 * fetched row, then column omission strips this projection's omitted columns (the client keep-set is
 * `columns ∪ primaryKey`) before the row reaches the client wire. This lets a "secure window" over a
 * keyed table stream the body while stripping the keys per row.
 *
 * `serverOnlyColumns` are owner column keys the transform must READ but that are NOT in the client shape
 * (e.g. a `keysWithheld` control flag). Such a key stays omitted from the client keep-set, yet is ADDED
 * to the Electric fetch allow-list — so it is fetched from Electric, visible to the transform, and then
 * stripped on egress by the same omission pass, never reaching the client. It requires a
 * `serverProjection.rowTransform` (a fetch no transform reads is dead weight) AND `columns` (with
 * `columns` omitted every column is already kept, so "server-only" is a contradiction), and must be
 * disjoint from `columns` and the primary key.
 *
 * **No inheritance — ENFORCED.** A projection does NOT inherit its owner's `serverProjection`. That is
 * deliberate: an inherited transform whose input column is absent from the projection's fetch list would
 * read `undefined` and silently fail OPEN (serving the un-redacted body) — half-protection worse than
 * none. Because a bare projection over a redacting owner would therefore egress RAW owner rows, the
 * registry no longer merely warns: when `owner.serverProjection?.rowTransform` exists, this function
 * THROWS at definition time unless the projection declares a posture. You must either declare your own
 * `serverProjection` on the projection (typically the same transform fn, plus `serverOnlyColumns` for its
 * control-flag inputs), or — only after confirming the projection's kept columns leak nothing — opt out
 * explicitly with the literal `serverProjection: "unredacted"`, which attaches no transform (egress raw)
 * but records that as a visible, reviewed decision at the definition site. The opt-out is meaningful only
 * where it applies: `"unredacted"` over an owner with NO egress `rowTransform` is itself rejected, so a
 * stale opt-out cannot silently pre-authorize a leak the day the owner grows one.
 */
export function defineReadProjection<
  const TOwnerTable extends AnyPgTable,
  const TOwnerLocal extends AnyPgTable,
  const TAs extends string,
  // Captures `opts.columns` as a literal tuple so the projection's local table can carry the OWNER's real
  // per-column types restricted to the kept keys. Defaults to "all owner keys" (its `[number]` is the full
  // key union), which is exactly the shape when `columns` is omitted — one uniform kept-key expression.
  const TColumns extends readonly TableColumnKey<TOwnerTable>[] = readonly TableColumnKey<TOwnerTable>[],
>(
  // Two table params so an owner that uses `omitColumns` (its `table` and `localTable` types differ) is
  // accepted — `TOwnerTable` (the physical table) is what `columns`/`rowFilter` are typed against.
  owner: SyncTableEntry<TOwnerTable, TOwnerLocal>,
  opts: {
    /** The projection's distinct local identity — its PGlite table name AND its `shapeKey`. */
    as: TAs;
    /** Column keys (of the owner) to sync locally + fetch from Electric. The PK is always kept. Omit → all. */
    columns?: TColumns;
    /** Row filter for this shape; the callback form receives the owner's full (physical) columns. */
    rowFilter?: (columns: TableColumnsShape<TOwnerTable>) => RowFilterSpec;
    /**
     * Server-side egress projection (ADR-0004) for THIS shape — typically a `rowTransform` that redacts a
     * sub-document of a kept column conditionally on row data. A projection does NOT inherit its owner's
     * `serverProjection` (see the docblock's no-inheritance caution): an inherited transform whose input
     * column is unfetched would fail OPEN, so inheritance is refused, not silent. When the OWNER declares
     * an egress `rowTransform`, this is therefore **required** — the registry throws at definition time
     * unless you either declare your own spec here (typically the same transform fn, plus
     * `serverOnlyColumns` for its control-flag inputs) OR opt out with the literal `"unredacted"`. Use
     * `"unredacted"` only after confirming this projection's kept columns leak nothing; it attaches NO
     * egress transform (the shape streams raw owner rows), but records that as a visible, reviewed
     * decision at the definition site. `"unredacted"` over a transform-less owner is itself rejected — a
     * stale opt-out would silently pre-authorize a leak the day the owner grows a transform.
     */
    serverProjection?: ServerProjectionSpec | "unredacted";
    /**
     * Owner column keys the `serverProjection.rowTransform` must READ but which are NOT part of the client
     * shape (e.g. a `keysWithheld` control flag). They are added to the Electric fetch allow-list so the
     * transform can see them, then stripped on egress before the client wire. Requires
     * `serverProjection.rowTransform` and `columns`; must be disjoint from `columns` and the primary key.
     */
    serverOnlyColumns?: readonly TableColumnKey<TOwnerTable>[];
    consistencyGroup?: string;
    subscription?: SubscriptionTiming;
    retention?: Retention;
  },
) {
  // A read projection composes off the OWNER's physical table + full columns. A chained projection (an
  // owner that is itself a read projection) would silently discard the intermediate's OWN column subset
  // and rowFilter — this derivation reads the intermediate's `table`/`makeColumns` (the physical table,
  // full columns), not its narrowed shape — so it cannot mean "project the projection". Reject it and
  // point at the owning defineSyncTable entry, which is the only sound base. (An `asReadonly` owner is
  // NOT a read projection and IS accepted — see the docblock.)
  if (owner.readProjection) {
    throw new Error(
      `defineReadProjection: owner "${opts.as}" is itself a read projection — chained projections compose ` +
        `wrongly (this derives off the owner's physical table + full columns, so the intermediate's own ` +
        `column subset and rowFilter would be silently discarded). Project off the owning defineSyncTable ` +
        `entry instead.`,
    );
  }

  // Defensive: every registrable entry (defineSyncTable + every transform — asReadonly / asEphemeral /
  // withRetention) now carries the column factory, so its absence means a hand-assembled owner, which
  // cannot be projected (there is nothing to derive columns from).
  const ownerMakeColumns = owner.makeColumns;
  if (!ownerMakeColumns) {
    throw new Error(
      `defineReadProjection: owner "${getTableConfig(owner.table).name}" has no column factory — pass an ` +
        `entry built by defineSyncTable (or an asReadonly of one), not a hand-assembled entry.`,
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

  // serverOnlyColumns — owner keys the egress rowTransform must READ but that are NOT in the client
  // keep-set. They stay omitted client-side (so local DDL/apply exclude them AND the proxy strips them on
  // egress), yet are added to the Electric fetch allow-list below so the transform can see them. Each
  // guard fails loud: a mis-declared server-only column would silently mis-fetch or fail open.
  // Fail-closed posture guard. A projection does NOT inherit its owner's egress `serverProjection`
  // (see the docblock's no-inheritance caution: an inherited transform whose input column is unfetched
  // reads `undefined` and fails OPEN — half-protection worse than none). So if the OWNER redacts on
  // egress via `serverProjection.rowTransform`, this projection would silently egress RAW owner rows
  // unless it declares a posture. We REFUSE that silence: the projection must either declare its own
  // `serverProjection` (an object spec) or opt out with the literal `serverProjection: "unredacted"`.
  const optServerProjection = opts.serverProjection;
  const ownerHasEgressTransform = owner.serverProjection?.rowTransform != null;
  if (optServerProjection === "unredacted" && !ownerHasEgressTransform) {
    // A stale "unredacted" over a transform-less owner would silently pre-authorize a leak if the owner
    // later grew a transform. Keep the opt-out meaningful exactly where it applies.
    throw new Error(
      `defineReadProjection: projection "${opts.as}" declares serverProjection: "unredacted", but owner ` +
        `"${physicalTable}" declares no egress rowTransform — the opt-out masks nothing here and would ` +
        `silently pre-authorize a leak if the owner later gains one. Remove the opt-out so it cannot mask ` +
        `a future one.`,
    );
  }
  if (ownerHasEgressTransform && optServerProjection == null) {
    throw new Error(
      `defineReadProjection: projection "${opts.as}" projects over owner "${physicalTable}", which declares ` +
        `an egress rowTransform — a projection does NOT inherit it, so this shape would egress RAW owner ` +
        `rows. Declare your own serverProjection (typically the same transform fn, plus serverOnlyColumns ` +
        `for its control-flag inputs) or — only after confirming the projection's kept columns leak nothing ` +
        `— opt out with serverProjection: "unredacted".`,
    );
  }
  // Only an object spec attaches to the entry; "unredacted" attaches NOTHING (egress raw, but now a
  // visible, reviewed decision at the definition site).
  const serverProjection = typeof optServerProjection === "object" ? optServerProjection : undefined;
  const serverOnlyColumns = opts.serverOnlyColumns ?? [];
  if (serverOnlyColumns.length > 0) {
    if (optServerProjection === "unredacted") {
      throw new Error(
        `defineReadProjection: projection "${opts.as}" declares serverProjection: "unredacted" together ` +
          `with serverOnlyColumns — the opt-out runs no transform, so there is nothing to read them. Drop ` +
          `serverOnlyColumns, or declare a serverProjection.rowTransform that reads them.`,
      );
    }
    if (!serverProjection?.rowTransform) {
      throw new Error(
        `defineReadProjection: projection "${opts.as}" declares serverOnlyColumns but no ` +
          `serverProjection.rowTransform — a server-only fetch that no transform reads is dead weight. ` +
          `Add the rowTransform that reads them, or drop serverOnlyColumns.`,
      );
    }
    if (!opts.columns) {
      throw new Error(
        `defineReadProjection: projection "${opts.as}" declares serverOnlyColumns without columns — with ` +
          `columns omitted every column is already kept client-side, so a "server-only" column is a ` +
          `contradiction. Declare columns (the client subset) so some columns can be genuinely server-only.`,
      );
    }
    const clientKept = new Set<string>([...opts.columns, ...pkKeys]);
    for (const key of serverOnlyColumns) {
      if (!allKeys.includes(key)) {
        throw new Error(
          `defineReadProjection: projection "${opts.as}" serverOnlyColumns names "${key}", which is not a ` +
            `column of owner "${physicalTable}". It feeds the Electric fetch allow-list, so a typo would ` +
            `silently mis-fetch — name an existing owner column key.`,
        );
      }
      if (clientKept.has(key)) {
        throw new Error(
          `defineReadProjection: projection "${opts.as}" lists "${key}" in BOTH serverOnlyColumns and the ` +
            `client shape (columns or primary key) — it is already fetched and kept client-side, so ` +
            `declaring it server-only is contradictory. Remove it from serverOnlyColumns.`,
        );
      }
    }
  }

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
  const resolvedRowFilter = opts.rowFilter?.(getColumns(owner.table) as unknown as TableColumnsShape<TOwnerTable>);

  // When a subset is requested, set the Electric `columns` allow-list to the KEPT physical column names
  // so an omitted (e.g. heavy jsonb) column is never fetched over the wire — not merely stripped after.
  // serverOnlyColumns are added ON TOP of the kept names: a server-only column must be FETCHED (so the
  // egress rowTransform can read it) even though it is omitted from the client keep-set — proxy omission
  // then strips it after the transform runs. Resolve key -> physical name the same way getProjectedColumns
  // does (the drizzle column's `.name`), never a hand-map. A full-width projection (no omitted keys, hence
  // no serverOnlyColumns — validated above) declares no allow-list at all.
  const ownerColumns = getColumns(owner.table) as Record<string, { name: string }>;
  const serverOnlyColumnNames = serverOnlyColumns.map((key) => ownerColumns[key]!.name);
  const allowListColumns =
    omittedKeys.length > 0 ? [...getProjectedColumnNames(built), ...serverOnlyColumnNames] : undefined;

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

  // Point `table` at the owner's physical table and flag `readProjection` — that flag (not the absence of
  // a column factory) is what generators/appliers key on to skip owning-table work (see plpgsql-apply's
  // `!entry.readProjection` filter). The owner's `makeColumns` is KEPT (it rode in via `built`): since
  // ADR-0029 P1 the client derives a projection's OWN local synced object from it too
  // (`getSyncedLocalTable` → `projectedColumnBuilders`, with this entry's `omitColumns` applied), so a
  // subscribed read projection that dropped it would fail to boot exactly as an `asReadonly` entry did.
  // `built` was validated by defineSyncTable and only its `table` is replaced (with the owner's,
  // structurally identical role), so the result is a sound SyncTableEntry — cast past the spread's
  // exactOptional friction to a clean entry type that keeps the projected local-table shape.
  // `serverProjection` is attached HERE on the outer object (mirroring `shape`), NOT threaded through the
  // inner `defineSyncTable` call — that alone makes the proxy's shapeKey resolution find and run the
  // projection's egress transform (getRowTransformForTable → resolveEntryByShapeKey(…)?.serverProjection).
  const projection = {
    ...built,
    table: owner.table,
    shape,
    readProjection: true as const,
    ...(serverProjection != null ? { serverProjection } : {}),
  };
  // The local table carries the OWNER's real column types restricted to the kept keys (`TColumns[number]`
  // — the full owner key union when `columns` was omitted), NOT the type-erased `built.localTable` (which
  // collapses to an open index signature because it is rebuilt through the stashed `makeColumns`).
  return projection as unknown as SyncTableEntry<
    TOwnerTable,
    ProjectionLocalTable<TOwnerTable, TAs, TColumns[number]>
  > & { readProjection: true };
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
    validateStorageDeclaration(input.storage);

    // Schema first (it may return the same tables object), then stamp the storage declaration on the
    // returned registry as a non-enumerable symbol — the same carrier pattern as the schema symbol — so
    // client code reads the data-contract storage back off the registry value (getSyncRegistrySchema's
    // twin, getSyncRegistryStorage). The bare-registry-map overload carries no storage and reads back
    // `undefined`, which resolves to the ADR-0047 defaults at the mint seam.
    return attachSyncRegistryStorage(attachSyncRegistrySchema(input.tables, input.schema), input.storage);
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
    const typedColumn = column as { getSQLType?: () => string; dimensions?: number; columnType?: string };
    const sqlType = normalizeCastPositionType(typedColumn.getSQLType?.() ?? "");
    return {
      name: columnName,
      sqlType,
      isArray: (typedColumn.dimensions ?? 0) > 0,
      // A real Postgres enum column brands as `PgEnumColumn`. `enumValues` is NOT the discriminator:
      // `text("c", { enum: […] })` / varchar variants expose `enumValues` too but their `getSQLType()` is
      // a BASE type (`text`, `varchar(255)`) — identifier-quoting that as a cast type would be wrong (and
      // broken for parameterised types). For a true enum, `getSQLType()` returns the enum TYPE NAME
      // (usable as a cast type once quoted) — the flag lets the ladder classify it as COPY/JSON-safe
      // instead of falling to the `insert` floor on the unrecognised type name.
      isEnum: typedColumn.columnType?.startsWith("PgEnum") === true,
    } satisfies SyncColumnType;
  });
}

/**
 * `serial`/`bigserial`/`smallserial` are DDL-position conveniences (an integer column plus a sequence
 * default), NOT real cast-position types: `json_to_recordset(… AS x(id serial))` and `value::serial`
 * are both invalid SQL. {@link SyncColumnType.sqlType} is contracted to be usable verbatim as a cast
 * type, so we normalise the serial family to its underlying integer type here — the single derivation
 * point — which also lets the column classify as COPY-safe rather than falling to the `insert` floor.
 *
 * Exported so any code deriving a {@link SyncColumnType} from a bare Drizzle column (e.g. test-support
 * `makeApplyTarget`, which cannot go through {@link deriveSyncColumnTypes} without a registry entry)
 * stays byte-faithful to this single normalisation rather than re-`getSQLType()`ing without it.
 */
export function normalizeCastPositionType(sqlType: string): string {
  switch (sqlType.trim().toLowerCase()) {
    case "serial":
      return "integer";
    case "bigserial":
      return "bigint";
    case "smallserial":
      return "smallint";
    default:
      return sqlType;
  }
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

  // `field.column` is the drizzle property key (registry validation rejects a column-name declaration —
  // ADR-0012); resolve it to the underlying SQL column name.
  const columns = getColumns(entry.table);
  return (columns as Record<string, { name: string } | undefined>)[field.column as string]?.name;
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

/**
 * Stamp the registry's storage declaration (ADR-0049 decision 1, ADR-0047) onto the registry value as a
 * non-enumerable symbol — the storage twin of {@link attachSyncRegistrySchema}. Carries the data-contract
 * storage through {@link defineSyncRegistry} so client code reads it back via {@link getSyncRegistryStorage}.
 * A `null`/`undefined` declaration attaches nothing (the bare-registry-map overload), leaving the reader to
 * resolve the ADR-0047 defaults at the mint seam.
 */
export function attachSyncRegistryStorage<TRegistry extends SyncTableRegistry>(
  registry: TRegistry,
  storage: SyncStorageDeclaration | undefined,
) {
  if (storage == null) {
    return registry;
  }
  // Idempotent for an EQUAL declaration (a registry value reused across constructions may be re-stamped with
  // the same contract) but fail-closed on a CONFLICT — two different storage contracts over one registry is a
  // definition error, never silently resolved. `backend`/`durability` are the only fields, so a shallow
  // compare is exhaustive.
  const existing = getSyncRegistryStorage(registry);
  if (existing != null) {
    if (existing.backend !== storage.backend || existing.durability !== storage.durability) {
      throw new Error(
        `conflicting storage declaration for registry: already ${JSON.stringify(existing)}, cannot re-declare ` +
          `${JSON.stringify(storage)}`,
      );
    }
    return registry;
  }
  Object.defineProperty(registry, syncRegistryStorageSymbol, {
    value: storage,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return registry;
}

/**
 * Read the storage declaration (ADR-0049 decision 1, ADR-0047) a registry was built with, or `undefined`
 * when none was declared (a bare registry map, or a definition with no `storage`). The client resolves the
 * effective mint durability as `getSyncRegistryStorage(registry)?.durability ?? "relaxed"` at its single
 * mint seam — the storage twin of {@link getSyncRegistrySchema}.
 */
export function getSyncRegistryStorage<TRegistry extends SyncTableRegistry>(
  registry: TRegistry,
): SyncStorageDeclaration | undefined {
  const storage = Reflect.get(registry, syncRegistryStorageSymbol) as unknown;
  return storage != null && typeof storage === "object" ? (storage as SyncStorageDeclaration) : undefined;
}

/**
 * Fail-closed at module-eval (ADR-0049 decision 1): a declared `storage.backend` / `storage.durability` must
 * be a known value, matching how the other registry axes reject bad input at `defineSyncRegistry`. An absent
 * declaration or absent field is fine — it resolves to the ADR-0047 defaults (`opfs` / `relaxed`).
 */
function validateStorageDeclaration(storage: SyncStorageDeclaration | undefined) {
  if (storage == null) {
    return;
  }
  if (storage.backend !== undefined && !isStorageBackend(storage.backend)) {
    throw new Error(
      `invalid storage.backend "${String(storage.backend)}": must be one of ${STORAGE_BACKENDS.join(", ")}`,
    );
  }
  if (storage.durability !== undefined && !isStorageDurability(storage.durability)) {
    throw new Error(
      `invalid storage.durability "${String(storage.durability)}": must be one of ${STORAGE_DURABILITIES.join(", ")}`,
    );
  }
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

  // ADR-0029 P1: the client derives every synced-table object (the local synced read cache, and — for a
  // writable table — the overlay/journal) from this column-builder factory (getSyncedLocalTable →
  // projectedColumnBuilders), so it is hard-required at client boot. Promote the check to registry-build
  // time (better DX than an opaque engine-boot throw): defineSyncTable always stashes it, and every
  // projection (asReadonly / withRetention / defineReadProjection) carries it through — only a
  // hand-assembled entry can lack it, and such an entry cannot be synced.
  if (typeof entry.makeColumns !== "function") {
    throw new Error(
      `sync table ${tableName} has no makeColumns factory: every registered entry must be built by ` +
        `defineSyncTable (or a projection of one — asReadonly / asEphemeral / defineReadProjection), which ` +
        `stashes the column-builder factory the client requires (ADR-0029 P1) to derive its local ` +
        `synced/overlay/journal objects. Hand-assembled entries are unsupported.`,
    );
  }

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

  // A managed field's `column` is the drizzle PROPERTY KEY of the target column, never its SQL column
  // name — ADR-0012 keeps the two distinct. Both consumers resolve by property key and canonicalise to
  // it (the client stamp in mutation.ts, the Server-version resolve in resolveServerVersionColumnName);
  // neither tolerates a column-name spelling. So a declaration that names the SQL column instead of the
  // property must fail HERE, at the boundary where declarations enter, rather than silently
  // half-resolving downstream.
  const managedFieldPropertyKeys = new Set(Object.keys(getColumns(entry.table)));

  // The single claim-stamping strategy (ADR-0026): an `authClaim` managed field reads a value from the
  // verified request claims at a JSON path, emitted into the apply-function DDL — so the path segments
  // must be plain identifiers and any cast a plain type name (never a value-injection surface). A
  // non-authClaim field carrying claimPath/cast is an authoring slip; reject it rather than ignore it.
  for (const field of entry.governance?.managedFields ?? []) {
    if (!managedFieldPropertyKeys.has(field.column as string)) {
      throw new Error(
        `managed field ${tableName}.${String(field.column)} names an unknown column: field.column must be the ` +
          `drizzle PROPERTY KEY of the target column, not its SQL column name (ADR-0012)`,
      );
    }
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
