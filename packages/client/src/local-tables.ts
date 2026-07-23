import type { ColumnBuilderBase } from "drizzle-orm";
import { getColumns } from "drizzle-orm";
import {
  bigint,
  boolean,
  customType,
  getTableConfig,
  integer,
  pgSchema,
  pgTable,
  pgView,
  text,
  uuid,
  varchar,
  type AnyPgTable,
  type PgColumn,
  type PgTableWithColumns,
  type PgViewWithSelection,
} from "drizzle-orm/pg-core";

import {
  deriveSyncColumnTypes,
  getLocalSyncedTablePrimaryKeyColumns,
  getSyncRegistrySchema,
  type SyncColumnType,
  type SyncTableEntry,
  type SyncTableRegistry,
} from "@pgxsinkit/contracts";

import { ALL_MUTATIONS_VIEW, LOCAL_META_TABLE } from "./schema";

/**
 * Runtime Drizzle objects for the GENERATED local-store relations (ADR-0004): the per-writable-table
 * overlay (`<t>_overlay`), journal (`<t>_mutations`), sync-state view (`<t>_sync_state`), the projected
 * synced read cache, and the `pgxsinkit_local_meta` key/value table. The schema generator
 * (`schema.ts`) remains the one authority for the DDL — these objects exist so the mutation runtime,
 * consumers, and tests can AUTHOR queries against those relations as tier-① Drizzle objects
 * (rename-safe, type-checked) instead of hand-written SQL strings.
 *
 * They are query-authoring objects only — never feed them to drizzle-kit generation; the generated
 * DDL in `schema.ts` is the source of truth for the physical shape, and `local-tables.test`-level
 * coverage (the existing overlay/journal suites run against generator-provisioned stores) is what
 * keeps the two aligned.
 *
 * Every object is schema-QUALIFIED with the registry's own local schema (via `getSyncRegistrySchema`).
 * `entry.table` / `entry.localTable` are already qualified the same way (`defineSyncTable` builds them
 * with the caller's schema, and `attachSyncRegistrySchema` throws unless they match the registry schema),
 * so for the synced read cache the factory just tracks a `clientProjection.syncedTable` rename. The
 * factories earn their keep where no equally-qualified entry handle exists: `entry.view` is built
 * schema-UNqualified (a bare `pgView`), so a store in a non-public schema must author the read model
 * through `getReadModelView`; and the overlay / journal / sync-state relations have NO entry handle at all
 * — these factories are the only Drizzle objects for them. Each factory MEMOIZES its result per
 * `(registry, tableKey)` (the `pgxsinkit_local_meta` table per local schema), so repeated calls hand back
 * the same object identity.
 *
 * Typing tracks the registry the caller holds: with a concretely-typed registry (built by
 * `defineSyncRegistry`) the synced/overlay/read-model objects carry the entry's real per-column types, so
 * `.select({ x: overlay.col })`, `$inferInsert`, and `.values()` all typecheck by property key; with a
 * bare `SyncTableRegistry` they degrade to an open index-signature shape reached by bracket access.
 * `JournalTable` / `SyncStateView` are ALWAYS conservatively indexed for their entity/PK columns (the PK
 * name set is not recoverable at the type level — see those types).
 */

/**
 * Microsecond/bigint columns the mutation runtime handles as **strings** (the JSON-safe form it has
 * always used): passthrough both ways, `bigint` in DDL position. Reads through the raw `MutationDb`
 * seam bypass drizzle result mapping anyway; this keeps `.values()`/`.set()` accepting the runtime's
 * string values without a lossy JS-number hop.
 */
const bigintText = customType<{ data: string; driverData: string }>({
  dataType() {
    return "bigint";
  },
});

function buildJournalFixedColumns() {
  return {
    mutationId: uuid("mutation_id").primaryKey(),
    entityKeyJson: text("entity_key_json").notNull(),
    mutationSeq: integer("mutation_seq").notNull(),
    mutationKind: varchar("mutation_kind", { length: 24 }).notNull(),
    status: varchar("status", { length: 24 }).notNull(),
    registryVersion: text("registry_version").notNull(),
    baseServerVersion: bigintText("base_server_version"),
    writeUnit: text("write_unit"),
    writeMode: varchar("write_mode", { length: 24 }),
    payloadJson: text("payload_json").notNull(),
    attemptCount: integer("attempt_count").notNull().default(0),
    lastError: text("last_error"),
    lastHttpStatus: integer("last_http_status"),
    conflictReason: text("conflict_reason"),
    serverUpdatedAtUs: bigintText("server_updated_at_us"),
    enqueuedAtUs: bigintText("enqueued_at_us").notNull(),
    nextRetryAtUs: bigintText("next_retry_at_us"),
    sentAtUs: bigintText("sent_at_us"),
    ackedAtUs: bigintText("acked_at_us"),
    updatedAtUs: bigintText("updated_at_us").notNull(),
  };
}

function buildOverlayFixedColumns() {
  return {
    overlayKind: varchar("overlay_kind", { length: 24 }).notNull(),
    localUpdatedAtUs: bigintText("local_updated_at_us").notNull(),
  };
}

/**
 * The two overlay columns the `<t>_read_model` view carries on top of the projected synced columns.
 * Read through real drizzle result mapping (a live query, not the raw `MutationDb` seam), so
 * `local_updated_at_us` is a `mode: "bigint"` int8 (PGlite returns it as a string at runtime) rather than
 * the journal/overlay `bigintText` passthrough. Snake-case property keys so consumers reach them the same
 * way the generator names them (`view["overlay_kind"]`).
 */
function buildReadModelFixedColumns() {
  return {
    overlay_kind: varchar("overlay_kind", { length: 24 }).notNull(),
    local_updated_at_us: bigint("local_updated_at_us", { mode: "bigint" }).notNull(),
  };
}

function buildSyncStateFixedColumns() {
  return {
    observedServerVersion: bigint("observed_server_version", { mode: "bigint" }),
    ackedServerVersion: bigint("acked_server_version", { mode: "bigint" }),
    pendingCount: bigint("pending_count", { mode: "number" }).notNull(),
    hasAckedUnobservedWrite: boolean("has_acked_unobserved_write").notNull(),
    localDeletePending: boolean("local_delete_pending").notNull(),
    conflictState: text("conflict_state"),
    quarantinedCount: bigint("quarantined_count", { mode: "number" }).notNull(),
    quarantineState: text("quarantine_state"),
  };
}

// Phantom shape tables: never created, never queried — they exist only so the derived relation types
// carry strong typing on the FIXED column keys. The per-entry ENTITY columns are layered on top from
// the concrete registry entry (see the `*<TEntry>` types below), so a caller whose registry is
// concretely typed reaches real, projected `PgColumn`s by property key; only a caller holding a bare
// `SyncTableRegistry` falls back to the open index-signature form these shapes' generic default gives.
const journalShape = pgTable("_pgxsinkit_journal_shape", buildJournalFixedColumns());
const overlayShape = pgTable("_pgxsinkit_overlay_shape", buildOverlayFixedColumns());
const syncStateShape = pgView("_pgxsinkit_sync_state_shape", buildSyncStateFixedColumns()).existing();
const readModelShape = pgView("_pgxsinkit_read_model_shape", buildReadModelFixedColumns()).existing();
const localMetaShape = pgTable(LOCAL_META_TABLE, {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

/**
 * The entry's PROJECTED local table type — its server columns minus `clientProjection.omitColumns`,
 * exactly the shape `defineSyncTable` stamped onto `entry.localTable`. When `TEntry` is a concrete
 * entry (a registry built by `defineSyncRegistry`) this carries the real, typed columns; when it is a
 * bare `SyncTableEntry` (a generic `SyncTableRegistry`) it degrades to `AnyPgTable`, which pushes every
 * derived type below onto the open `Record<string, PgColumn>` index-signature fallback.
 */
type EntryLocalTable<TEntry> =
  TEntry extends SyncTableEntry<AnyPgTable, infer TLocal extends AnyPgTable> ? TLocal : AnyPgTable;

/** The entry's projected columns keyed by drizzle property key (or the open `PgColumns` fallback). */
type EntryColumns<TEntry> = EntryLocalTable<TEntry>["_"]["columns"];
type OverlayFixedColumns = (typeof overlayShape)["_"]["columns"];
type ReadModelFixedColumns = (typeof readModelShape)["_"]["selectedFields"];

/**
 * The `<t>_overlay` optimistic-intent table: the entry's PROJECTED columns (same builders the generator
 * and `entry.localTable` carry) merged with the two fixed overlay columns. The entity columns read
 * back through real drizzle result mapping, so their types mirror the projected table exactly (a
 * `mode: "bigint"` column is `bigint`, etc.). The two overlay columns are `bigintText` passthrough
 * (`local_updated_at_us` reads as a string). `TEntry` defaults to a bare entry, giving the open
 * index-signature form the mutation runtime (generic over any registry) needs.
 */
export type OverlayTable<TEntry = SyncTableEntry> = PgTableWithColumns<{
  name: string;
  schema: string | undefined;
  columns: EntryColumns<TEntry> & OverlayFixedColumns;
  dialect: "pg";
}>;

/**
 * The `<t>_read_model` overlay-merged read view (ADR-0004): the entry's PROJECTED columns under their
 * property keys plus the two fixed overlay columns (`overlay_kind`, `local_updated_at_us`). Read
 * through a live query, so `local_updated_at_us` is an int8 `mode: "bigint"` column.
 */
export type ReadModelView<TEntry = SyncTableEntry> = PgViewWithSelection<
  string,
  true,
  EntryColumns<TEntry> & ReadModelFixedColumns
>;

/**
 * The projected SYNCED read-cache table — the entry's projected local table (or `AnyPgTable` fallback).
 * Type-level note: the phantom relation name here is the original `tableName` (inherited from
 * `ProjectedLocalTable`), but the runtime object `getSyncedLocalTable` returns honours a
 * `clientProjection.syncedTable` rename — so the rendered SQL uses the runtime name, not this type's name.
 */
export type SyncedLocalTable<TEntry = SyncTableEntry> = EntryLocalTable<TEntry>;

/**
 * The `<t>_mutations` journal: fixed runtime columns + the entry's PK columns (index-signature access).
 * Kept conservatively indexed: the journal carries ONLY the PK columns, keyed by DB COLUMN NAME and
 * type-erased to `text`, but neither the PK column-name set nor the "PK only" subset is recoverable at
 * the type level from `SyncTableEntry` (its `primaryKey.columns` is an un-narrowed `string[]`), so an
 * honest per-entry type is not representable without a footgun (claiming non-PK columns that do not
 * exist on the journal at runtime). PK/entity columns therefore ride the index signature.
 */
export type JournalTable = typeof journalShape & { [columnName: string]: PgColumn };
/**
 * The `<t>_sync_state` convergence view (ADR-0011): fixed state columns + the entry's PK columns.
 * Conservatively indexed for the same reason as {@link JournalTable} — it projects only the PK columns
 * (a subset not recoverable at the type level), so the PK columns ride the index signature.
 */
export type SyncStateView = typeof syncStateShape & { [columnName: string]: PgColumn };
/** The `pgxsinkit_local_meta` key/value table (ADR-0006). */
export type LocalMetaTable = typeof localMetaShape;

/**
 * Build a runtime `pgTable` for a local-store relation. An `ephemeral`-lifecycle entry (ADR-0021 §3)
 * renders **bare** regardless of the registry's local schema: its whole cluster is emitted as `TEMP`
 * with unqualified object names that resolve via `pg_temp`/search_path, exactly as
 * `generateLocalSchemaSql` renders it (a `pgSchema(localSchema).table(...)` reference would target a
 * durable schema the temp table does not live in — the latent qualification bug ADR-0029 records).
 */
function makeTable(
  localSchema: string,
  name: string,
  columns: Record<string, ColumnBuilderBase>,
  ephemeral = false,
): AnyPgTable {
  return localSchema === "public" || ephemeral ? pgTable(name, columns) : pgSchema(localSchema).table(name, columns);
}

function isEphemeral(entry: SyncTableEntry<AnyPgTable>): boolean {
  return entry.retention === "ephemeral";
}

function resolveSyncedTableName(entry: SyncTableEntry<AnyPgTable>): string {
  return entry.clientProjection?.syncedTable ?? getTableConfig(entry.table).name;
}

/**
 * The entry's projected column BUILDERS keyed by property key, re-created from the retained
 * `makeColumns` factory (registry.ts keeps it for exactly this kind of reuse) with
 * `clientProjection.omitColumns` applied — the same projection the generator's synced/overlay DDL
 * carries.
 */
function projectedColumnBuilders(entry: SyncTableEntry<AnyPgTable>, tableKey: string) {
  const makeColumns = entry.makeColumns;
  if (!makeColumns) {
    throw new Error(
      `local table objects for ${tableKey} need the entry's makeColumns factory (built by defineSyncTable); ` +
        `hand-assembled entries cannot derive overlay/journal objects`,
    );
  }
  const omitted = new Set(entry.clientProjection?.omitColumns ?? []);
  return Object.fromEntries(Object.entries(makeColumns()).filter(([key]) => !omitted.has(key))) as Record<
    string,
    ColumnBuilderBase
  >;
}

/** Property-key ↔ column-name pairs for the entry's PK, resolved via the built local table. */
function pkColumnPairs(entry: SyncTableEntry<AnyPgTable>, tableKey: string) {
  const localColumns = getColumns(entry.localTable) as Record<string, PgColumn>;
  return entry.primaryKey.columns.map((columnName) => {
    const pair = Object.entries(localColumns).find(([, column]) => column.name === columnName);
    if (!pair) {
      throw new Error(`Primary key column ${columnName} was not found on table ${tableKey}`);
    }
    return { propertyKey: pair[0], columnName };
  });
}

interface EntryLocalTables {
  synced?: AnyPgTable;
  overlay?: OverlayTable;
  journal?: JournalTable;
  syncState?: SyncStateView;
  readModel?: ReadModelView;
}

const localTablesCache = new WeakMap<SyncTableRegistry, Map<string, EntryLocalTables>>();
const localMetaCache = new Map<string, LocalMetaTable>();

function cacheFor(registry: SyncTableRegistry, tableKey: string): EntryLocalTables {
  let byKey = localTablesCache.get(registry);
  if (!byKey) {
    byKey = new Map();
    localTablesCache.set(registry, byKey);
  }
  let slot = byKey.get(tableKey);
  if (!slot) {
    slot = {};
    byKey.set(tableKey, slot);
  }
  return slot;
}

function requireEntry(registry: SyncTableRegistry, tableKey: string): SyncTableEntry<AnyPgTable> {
  const entry = registry[tableKey];
  if (!entry) {
    throw new Error(`Unknown sync table: ${tableKey}`);
  }
  return entry;
}

function requireWritable(entry: SyncTableEntry<AnyPgTable>, tableKey: string, relation: string) {
  if (!entry.clientProjection?.overlayTable || !entry.clientProjection.journalTable) {
    throw new Error(`${relation} exists only for a writable table; ${tableKey} has no overlay/journal projection`);
  }
  return entry.clientProjection as { overlayTable: string; journalTable: string; syncedTable?: string };
}

/**
 * The projected SYNCED read-cache table as a runtime Drizzle object, under the resolved local name
 * (`clientProjection.syncedTable` override honoured) and the registry's local schema — the exact
 * relation the generator's `CREATE TABLE` provisions. Prefer `entry.localTable` where its name
 * already matches; this object exists for the runtime/tests that must track the projection rename.
 * Carries the entry's real projected columns under a concretely-typed registry, `AnyPgTable` under a
 * bare `SyncTableRegistry` (see {@link SyncedLocalTable}).
 */
export function getSyncedLocalTable<TRegistry extends SyncTableRegistry, TKey extends string & keyof TRegistry>(
  registry: TRegistry,
  tableKey: TKey,
): SyncedLocalTable<TRegistry[TKey]> {
  const slot = cacheFor(registry, tableKey);
  if (slot.synced) {
    return slot.synced as SyncedLocalTable<TRegistry[TKey]>;
  }
  const entry = requireEntry(registry, tableKey);
  const localSchema = getSyncRegistrySchema(registry);
  const table = makeTable(
    localSchema,
    resolveSyncedTableName(entry),
    projectedColumnBuilders(entry, tableKey) as Record<string, ColumnBuilderBase>,
    isEphemeral(entry),
  );
  slot.synced = table;
  return table as SyncedLocalTable<TRegistry[TKey]>;
}

/**
 * The `<t>_overlay` optimistic-intent table as a runtime Drizzle object (writable tables only — throws
 * for a readonly entry, which has no overlay/journal projection). Its entity columns are typed exactly
 * as {@link OverlayTable} describes — real per-column types under a concretely-typed registry, the open
 * index-signature fallback under a bare `SyncTableRegistry` — plus the two fixed overlay columns.
 */
export function getOverlayTable<TRegistry extends SyncTableRegistry, TKey extends string & keyof TRegistry>(
  registry: TRegistry,
  tableKey: TKey,
): OverlayTable<TRegistry[TKey]> {
  const slot = cacheFor(registry, tableKey);
  if (slot.overlay) {
    return slot.overlay as OverlayTable<TRegistry[TKey]>;
  }
  const entry = requireEntry(registry, tableKey);
  const projection = requireWritable(entry, tableKey, "the overlay table");
  const localSchema = getSyncRegistrySchema(registry);
  const table = makeTable(
    localSchema,
    projection.overlayTable,
    {
      ...(projectedColumnBuilders(entry, tableKey) as Record<string, ColumnBuilderBase>),
      ...buildOverlayFixedColumns(),
    },
    isEphemeral(entry),
  ) as OverlayTable;
  slot.overlay = table;
  return table as OverlayTable<TRegistry[TKey]>;
}

/**
 * The `<t>_mutations` journal table as a runtime Drizzle object (writable tables only). The fixed runtime
 * columns are typed; the PK/entity columns ride the index signature and are reached by DB column NAME
 * (`journal["id"]`), because per-entry typing is not representable — see {@link JournalTable}.
 */
export function getJournalTable<TRegistry extends SyncTableRegistry>(
  registry: TRegistry,
  tableKey: string & keyof TRegistry,
): JournalTable {
  const slot = cacheFor(registry, tableKey);
  if (slot.journal) {
    return slot.journal;
  }
  const entry = requireEntry(registry, tableKey);
  const projection = requireWritable(entry, tableKey, "the journal table");
  const localSchema = getSyncRegistrySchema(registry);
  const pkBuilders = Object.fromEntries(
    pkColumnPairs(entry, tableKey).map(({ columnName }) => [columnName, text(columnName).notNull()]),
  );
  const table = makeTable(
    localSchema,
    projection.journalTable,
    {
      ...pkBuilders,
      ...buildJournalFixedColumns(),
    },
    isEphemeral(entry),
  ) as JournalTable;
  slot.journal = table;
  return table;
}

/**
 * The `<t>_sync_state` convergence view (ADR-0011) as a runtime Drizzle object (writable tables only) —
 * PK columns under the entry's own property keys plus the fixed state columns, mirroring
 * `buildSyncStateView`'s projection. The fixed state columns are typed; the PK columns ride the index
 * signature (not recoverable at the type level — see {@link SyncStateView}) and are reached by their
 * drizzle PROPERTY key (`view["authorId"]`), unlike the journal, which keys its PK columns by DB column
 * name.
 */
export function getSyncStateView<TRegistry extends SyncTableRegistry>(
  registry: TRegistry,
  tableKey: string & keyof TRegistry,
): SyncStateView {
  const slot = cacheFor(registry, tableKey);
  if (slot.syncState) {
    return slot.syncState;
  }
  const entry = requireEntry(registry, tableKey);
  requireWritable(entry, tableKey, "the sync-state view");
  const localSchema = getSyncRegistrySchema(registry);
  const viewName = `${resolveSyncedTableName(entry)}_sync_state`;
  const builders = projectedColumnBuilders(entry, tableKey);
  const pkBuilders = Object.fromEntries(
    pkColumnPairs(entry, tableKey).map(({ propertyKey }) => {
      const builder = builders[propertyKey];
      if (!builder) {
        throw new Error(`Primary key property ${propertyKey} was not found on table ${tableKey}`);
      }
      return [propertyKey, builder];
    }),
  ) as Record<string, ColumnBuilderBase>;
  const columns = {
    ...(pkBuilders as Record<string, ColumnBuilderBase>),
    ...buildSyncStateFixedColumns(),
  };
  const view = (
    localSchema === "public" || isEphemeral(entry)
      ? pgView(viewName, columns).existing()
      : pgSchema(localSchema).view(viewName, columns).existing()
  ) as SyncStateView;
  slot.syncState = view;
  return view;
}

/**
 * The `<t>_read_model` overlay-merged read view (ADR-0004) as a runtime Drizzle object: every projected
 * synced column under the entry's own property key plus the two overlay columns (`overlay_kind`,
 * `local_updated_at_us`), mirroring the generator's `CREATE VIEW`. The entry's own `entry.view` is
 * schema-UNQUALIFIED (`defineSyncTable` builds it with a bare `pgView`), so a consumer whose local store
 * lives in a non-public schema must author against this qualified object instead of `entry.view`.
 */
export function getReadModelView<TRegistry extends SyncTableRegistry, TKey extends string & keyof TRegistry>(
  registry: TRegistry,
  tableKey: TKey,
): ReadModelView<TRegistry[TKey]> {
  const slot = cacheFor(registry, tableKey);
  if (slot.readModel) {
    return slot.readModel as ReadModelView<TRegistry[TKey]>;
  }
  const entry = requireEntry(registry, tableKey);
  requireWritable(entry, tableKey, "the read-model view");
  const localSchema = getSyncRegistrySchema(registry);
  const viewName = `${resolveSyncedTableName(entry)}_read_model`;
  const columns = {
    ...(projectedColumnBuilders(entry, tableKey) as Record<string, ColumnBuilderBase>),
    ...buildReadModelFixedColumns(),
  };
  const view = (
    localSchema === "public" || isEphemeral(entry)
      ? pgView(viewName, columns).existing()
      : pgSchema(localSchema).view(viewName, columns).existing()
  ) as ReadModelView;
  slot.readModel = view;
  return view as ReadModelView<TRegistry[TKey]>;
}

/**
 * The read-path applier's resolved per-shape target (ADR-0029 D1/D2). Every table-scoped fact the
 * appliers need is derived once from the registry entry — the real projected synced table object, its
 * columns indexed by DB column name, the primary-key column names, and the model-derived column types —
 * so the appliers author over Drizzle objects (no name/schema strings, no `information_schema` probe).
 * Resolved once per shape at subscribe time; reused for every message. Electric change rows are keyed
 * by DB **column name**, while Drizzle DML keys by **property key**, so both indexes are carried.
 */
export interface ApplyTarget {
  /** The real projected synced local table (`getSyncedLocalTable`) — bare for ephemeral lifecycles. */
  table: AnyPgTable;
  /** DB column name → its Drizzle `PgColumn` (for `eq`/conflict-target/COPY clauses). */
  columnByName: Record<string, PgColumn>;
  /** DB column name → its Drizzle property key (to key `.values()`/`.set()` from a name-keyed row). */
  propertyKeyByName: Record<string, string>;
  /** Primary-key column NAMES, in order (from the entry, local-projection override honoured). */
  primaryKey: string[];
  /**
   * CDC insert-apply policy (ADR-0045), from the entry. `"insert"` (default) applies a CDC insert as a
   * plain INSERT so a genuine PK collision surfaces; `"upsert"` applies it idempotently (ON CONFLICT DO
   * UPDATE) because this table legitimately receives locally-derived provisional rows.
   */
  applyMode: "insert" | "upsert";
  /** Model-derived column types (`deriveSyncColumnTypes`), keyed by DB column name via `.name`. */
  columnTypes: SyncColumnType[];
  /**
   * Per-shape render-once cache for the batched-INSERT family (ADR-0029 D5): a rendered `{sqlText,
   * params}` per distinct (column-set, row-count), reused across batches with per-value codecs applied
   * at execution. Empty at resolution; populated lazily by the applier.
   */
  insertRenderCache: Map<string, { sqlText: string; params: unknown[] }>;
}

/**
 * Resolve a shape's {@link ApplyTarget} from its registry entry (ADR-0029 D1/D2). Called once per shape
 * at subscribe time — never per message. The single source is the registry item: identity via
 * `getSyncedLocalTable`, PKs via `getLocalSyncedTablePrimaryKeyColumns`, types via `deriveSyncColumnTypes`.
 */
export function resolveApplyTarget<TRegistry extends SyncTableRegistry, TKey extends string & keyof TRegistry>(
  registry: TRegistry,
  tableKey: TKey,
): ApplyTarget {
  const entry = requireEntry(registry, tableKey);
  const table = getSyncedLocalTable(registry, tableKey);
  const columns = getColumns(table as AnyPgTable) as Record<string, PgColumn>;
  const columnByName: Record<string, PgColumn> = {};
  const propertyKeyByName: Record<string, string> = {};
  for (const [propertyKey, column] of Object.entries(columns)) {
    columnByName[column.name] = column;
    propertyKeyByName[column.name] = propertyKey;
  }
  return {
    table: table as AnyPgTable,
    columnByName,
    propertyKeyByName,
    primaryKey: getLocalSyncedTablePrimaryKeyColumns(entry),
    applyMode: entry.applyMode,
    columnTypes: deriveSyncColumnTypes(entry),
    insertRenderCache: new Map(),
  };
}

/**
 * The fixed columns of the registry-wide `pgxsinkit_all_mutations` view (ADR-0021/slice 4): a `table_key`
 * literal per branch plus the shared fixed journal columns ({@link ALL_MUTATIONS_JOURNAL_COLUMNS} in
 * schema.ts) — MINUS `payload_json` and the per-table PK columns. The `_us` bigints are the same
 * `bigintText` passthrough the journal object uses (read back through the raw seam / the live-rows seam,
 * which return rows UNMAPPED — no drizzle result mapping), so the runtime reads them as strings.
 */
function buildAllMutationsViewColumns() {
  return {
    tableKey: text("table_key").notNull(),
    mutationId: uuid("mutation_id").notNull(),
    entityKeyJson: text("entity_key_json").notNull(),
    mutationSeq: integer("mutation_seq").notNull(),
    mutationKind: varchar("mutation_kind", { length: 24 }).notNull(),
    status: varchar("status", { length: 24 }).notNull(),
    registryVersion: text("registry_version").notNull(),
    baseServerVersion: bigintText("base_server_version"),
    writeUnit: text("write_unit"),
    writeMode: varchar("write_mode", { length: 24 }),
    attemptCount: integer("attempt_count").notNull(),
    lastError: text("last_error"),
    lastHttpStatus: integer("last_http_status"),
    conflictReason: text("conflict_reason"),
    serverUpdatedAtUs: bigintText("server_updated_at_us"),
    enqueuedAtUs: bigintText("enqueued_at_us").notNull(),
    nextRetryAtUs: bigintText("next_retry_at_us"),
    sentAtUs: bigintText("sent_at_us"),
    ackedAtUs: bigintText("acked_at_us"),
    updatedAtUs: bigintText("updated_at_us").notNull(),
  };
}

const allMutationsShape = pgView(ALL_MUTATIONS_VIEW, buildAllMutationsViewColumns()).existing();

/**
 * The registry-wide `pgxsinkit_all_mutations` cross-journal view (slice 4) as a runtime Drizzle object. Its
 * columns are the fixed journal columns (typed) plus the `table_key` registry-key literal — no per-table PK
 * columns, no payload. Unlike the other view factories this is schema-INDEPENDENT: the view is always emitted
 * `TEMP` (it may reference `pg_temp` ephemeral journals), so it resolves bare via `pg_temp`/search_path
 * regardless of the registry's local schema — hence one memoized instance for every registry. The
 * `client.mutations.*` API authors its summary/detail queries over THIS object (tier ①).
 */
export type AllMutationsView = typeof allMutationsShape;

export function getAllMutationsView(_registry: SyncTableRegistry): AllMutationsView {
  return allMutationsShape;
}

/** The `pgxsinkit_local_meta` key/value table (ADR-0006) under the registry's local schema. */
export function getLocalMetaTable(registry: SyncTableRegistry): LocalMetaTable {
  const localSchema = getSyncRegistrySchema(registry);
  const cached = localMetaCache.get(localSchema);
  if (cached) {
    return cached;
  }
  const table = makeTable(localSchema, LOCAL_META_TABLE, {
    key: text("key").primaryKey(),
    value: text("value").notNull(),
  }) as LocalMetaTable;
  localMetaCache.set(localSchema, table);
  return table;
}
