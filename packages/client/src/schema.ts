import { getTableConfig, getViewConfig, type AnyPgTable } from "drizzle-orm/pg-core";

import {
  buildOverlayResolutionBarrier,
  buildSyncStateView,
  getLocalSyncPrimaryKeyColumns,
  getSyncRegistrySchema,
  getProjectedColumns,
  hashString,
  maybeQuoteIdentifier,
  quoteIdentifier,
  quoteSqlLiteral as quoteSqlStringLiteral,
  type SyncTableEntry,
  type SyncTableRegistry,
} from "@pgxsinkit/contracts";

import { buildClearShapeTagsSql, shapeTableId } from "./sync/tags";

/** Internal fully-qualified projection used within schema generation. */
interface ResolvedProjection {
  syncedTable: string;
  overlayTable?: string;
  journalTable?: string;
  readModel: string;
  /** The per-table `<table>_sync_state` convergence view (writable tables only — ADR-0011). */
  syncState: string;
  /**
   * The reconcile trigger's function — schema-qualified, because a function is a schema object.
   * Suffix-then-qualify (never `${qualifiedTable}_reconcile_on_sync`, which double-quotes a
   * non-public schema's qualified name into invalid SQL).
   */
  reconcileFunction: string;
  /**
   * The reconcile trigger itself — an UNqualified identifier. A trigger is not a schema object; it
   * is bound to its table via `ON <qualified table>`, so its name must not be schema-qualified.
   */
  reconcileTrigger: string;
}

/** Local key/value metadata table for current-store safety, boot state, and registry identity. */
export const LOCAL_META_TABLE = "pgxsinkit_local_meta";
export const REGISTRY_FINGERPRINT_KEY = "registry_fingerprint";
/**
 * The `pgxsinkit_local_meta` key holding the DURABLE-schema fingerprint the local store was last
 * provisioned under for the warm-store schema fast path. Its value is
 * `lsf1:<hash(durable SQL)>` (see {@link computeLocalSchemaFingerprint}); a boot compares it against the
 * freshly-generated durable SQL's hash to SKIP the durable replay when they match.
 */
export const LOCAL_SCHEMA_FINGERPRINT_KEY = "local_schema_fingerprint";
/** The fixed namespace for the exact supported local-schema fingerprint. */
export const LOCAL_SCHEMA_FINGERPRINT_PREFIX = "lsf1:";

/**
 * The registry-wide cross-journal mutation view used by the mutation-status API,
 * option 1). A `TEMP` view UNION-ALL-ing every writable table's journal down to the shared fixed columns
 * (plus a `table_key` literal per branch), so a consumer can render one global mutation summary/detail
 * subscription instead of one live query per writable journal. It MUST be `TEMP`: an ephemeral entry's
 * journal is a `pg_temp` relation (ADR-0021 §3), which a durable view cannot reference — and it is
 * recreated on every engine boot (a TEMP view dies with the old engine), so it lives in the always-applied
 * ephemeral schema portion, NOT the durable (fingerprint-gated) portion. See {@link getAllMutationsView}
 * for the query-authoring Drizzle object over it.
 */
export const ALL_MUTATIONS_VIEW = "pgxsinkit_all_mutations";

/**
 * The shared fixed journal columns the {@link ALL_MUTATIONS_VIEW} branches project (in journal-DDL order),
 * mirroring `buildJournalFixedColumns` (local-tables.ts) MINUS `payload_json` (detail rows stay
 * payload-free by default — entity identity comes from `entity_key_json`) and the per-table PRIMARY KEY
 * columns (they differ per branch, so they cannot appear in a UNION ALL). `mutation_seq` is retained: it is
 * a shared fixed column and {@link import("./mutation").MutationDetail} carries it — but it is per-journal,
 * NOT globally ordered, so the detail API orders by `enqueued_at_us`, never this.
 */
export const ALL_MUTATIONS_JOURNAL_COLUMNS = [
  "mutation_id",
  "entity_key_json",
  "mutation_seq",
  "mutation_kind",
  "status",
  "registry_version",
  "base_server_version",
  "write_unit",
  "write_mode",
  "attempt_count",
  "last_error",
  "last_http_status",
  "conflict_reason",
  "server_updated_at_us",
  "enqueued_at_us",
  "next_retry_at_us",
  "sent_at_us",
  "acked_at_us",
  "updated_at_us",
] as const;

type TableColumn = ReturnType<typeof getProjectedColumns<AnyPgTable>>[number]["column"];

/** Join a statement list into a single executable script, matching the historical generator's separator. */
function joinSchemaStatements(statements: string[]): string {
  return `${statements.join("\n\n")}\n`;
}

/**
 * The schema-create (non-public only) + `pgxsinkit_local_meta` CREATE-IF-NOT-EXISTS — the minimal durable
 * bootstrap every boot needs BEFORE it can read/write the local-schema fingerprint. Emitted standalone by
 * {@link buildLocalMetaBootstrapSql}, and first in the durable statement stream.
 */
function localMetaBootstrapStatements(localSchema: string): string[] {
  const statements: string[] = [];

  if (localSchema !== "public") {
    statements.push(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(localSchema)};`);
  }

  statements.push(
    `CREATE TABLE IF NOT EXISTS ${qualifyIdentifier(localSchema, LOCAL_META_TABLE)} (\n  ${[
      "key TEXT PRIMARY KEY",
      "value TEXT NOT NULL",
    ].join(",\n  ")}\n);`,
  );

  return statements;
}

/**
 * The minimal durable bootstrap (schema + meta table) as an executable script (slice 3). Run as the first,
 * tiny crossing on every client-owned boot so the `local_schema_fingerprint` read/write has its table before
 * the fingerprint fast path decides whether to replay the rest of the durable schema. Depends on the
 * registry only for its local schema name, so it is a function rather than a bare constant.
 */
export function buildLocalMetaBootstrapSql<TRegistry extends SyncTableRegistry>(registry: TRegistry): string {
  return joinSchemaStatements(localMetaBootstrapStatements(getSyncRegistrySchema(registry)));
}

/**
 * Build the full DDL cluster for ONE registry entry — synced table, and (for a writable entry) overlay,
 * sequence, journal + its indexes, reconcile function + trigger, and the read-model/sync-state views. This
 * is the per-entry body {@link generateDurableLocalSchemaSql} and {@link generateEphemeralLocalSchemaSql}
 * share (partitioned by `retention === "ephemeral"`), so the two paths cannot drift.
 *
 * ADR-0021 §3: an `ephemeral` entry's whole cluster is emitted as `TEMP` — bare (unqualified) object names
 * that resolve via `pg_temp` / search_path, so read- and write-ephemerality fall out together (no durable
 * trace). Object NAMES go bare+TEMP; column *types* (enums) stay in the persistent schema. For a persistent
 * entry `temp` is "" and `objectSchema` is the registry schema.
 */
function buildEntryClusterStatements(entry: SyncTableEntry, tableKey: string, localSchema: string): string[] {
  const statements: string[] = [];
  const ephemeral = entry.retention === "ephemeral";
  const objectSchema = ephemeral ? "public" : localSchema;
  const temp = ephemeral ? "TEMP " : "";

  const projection = getClientProjection(entry, tableKey, objectSchema);
  const columns = getProjectedColumns(entry).map(({ column }) => column);
  const syncedTablePrimaryKeyColumns = getLocalSyncPrimaryKeyColumns(entry);
  const baseColumnsSql = buildTableColumnSql(columns, syncedTablePrimaryKeyColumns, localSchema);

  statements.push(`CREATE ${temp}TABLE IF NOT EXISTS ${projection.syncedTable} (\n  ${baseColumnsSql}\n);`);

  if (entry.mode === "readonly") {
    return statements;
  }

  if (!projection.overlayTable || !projection.journalTable) {
    throw new Error(`overlay and journal tables are required for writable table ${tableKey}`);
  }

  const journalTableName = entry.clientProjection?.journalTable;

  if (!journalTableName) {
    throw new Error(`journal table is required for writable table ${tableKey}`);
  }

  const primaryKeyColumns = entry.primaryKey.columns.map((columnName) => {
    const column = columns.find((candidate) => candidate.name === columnName);

    if (!column) {
      throw new Error(`Primary key column ${columnName} was not found on table ${tableKey}`);
    }

    return column;
  });
  const primaryKeyColumnNames = primaryKeyColumns.map((column) => column.name);
  const journalSequenceName = buildJournalSequenceName(journalTableName);
  const qualifiedJournalSequenceName = qualifyIdentifier(objectSchema, journalSequenceName);

  statements.push(
    `CREATE ${temp}TABLE IF NOT EXISTS ${projection.overlayTable} (\n  ${[
      ...columns.map((column) => buildColumnDefinition(column, primaryKeyColumnNames, localSchema)),
      "overlay_kind VARCHAR(24) NOT NULL",
      "local_updated_at_us BIGINT NOT NULL",
      ...buildCompositePrimaryKeyClauses(primaryKeyColumnNames),
    ].join(",\n  ")}\n);`,
  );

  statements.push(
    `CREATE ${temp}SEQUENCE IF NOT EXISTS ${qualifiedJournalSequenceName} AS integer START WITH 1 INCREMENT BY 1;`,
  );

  statements.push(
    `CREATE ${temp}TABLE IF NOT EXISTS ${projection.journalTable} (\n  ${[
      "mutation_id UUID PRIMARY KEY",
      ...primaryKeyColumns.map((column) => `${column.name} ${mapColumnType(column, localSchema)} NOT NULL`),
      "entity_key_json TEXT NOT NULL",
      `mutation_seq INTEGER NOT NULL UNIQUE DEFAULT nextval(${quoteSqlStringLiteral(qualifiedJournalSequenceName)})::integer`,
      "mutation_kind VARCHAR(24) NOT NULL",
      "status VARCHAR(24) NOT NULL",
      // Registry identity retained with each mutation so a future supported release can reason about
      // mutations authored before a registry transition.
      "registry_version TEXT NOT NULL",
      // ADR-0011 reserved hook: the Server version the entity was observed at when this mutation
      // was authored. The slot lives on the journal per mutation;
      // the stale-write conflict policy (ADR-0015) decides its exact semantics and stamps it.
      "base_server_version BIGINT",
      // ADR-0022: the dynamic write-unit tag stamped by a `transaction({ mode })` block — the shared
      // unit id grouping co-committed mutations, and the unit's write-mode. NULL for the default path
      // (an untagged mutation), where the flusher derives mode + unit from the table's static group.
      "write_unit TEXT",
      "write_mode VARCHAR(24)",
      "payload_json TEXT NOT NULL",
      "attempt_count INTEGER NOT NULL DEFAULT 0",
      "last_error TEXT",
      "last_http_status INTEGER",
      "conflict_reason TEXT",
      "server_updated_at_us BIGINT",
      "enqueued_at_us BIGINT NOT NULL",
      "next_retry_at_us BIGINT",
      "sent_at_us BIGINT",
      "acked_at_us BIGINT",
      "updated_at_us BIGINT NOT NULL",
    ].join(",\n  ")}\n);`,
  );

  // Journal indexes render through the SAME core the pgTable-driven renderer uses
  // ({@link renderCreateIndexStatement}), so the two index-emitting paths cannot drift in statement
  // shape. These names/columns are registry-derived bare identifiers, passed verbatim (the pgTable
  // path is the one that quotes), so both index-emitting paths render the same statement text.
  statements.push(
    renderCreateIndexStatement(projection.journalTable, `${journalTableName}_status_idx`, ["status", "enqueued_at_us"]),
  );
  statements.push(
    renderCreateIndexStatement(projection.journalTable, `${journalTableName}_status_retry_idx`, [
      "status",
      "next_retry_at_us",
      "enqueued_at_us",
    ]),
  );
  statements.push(
    renderCreateIndexStatement(projection.journalTable, `${journalTableName}_pk_seq_idx`, [
      ...entry.primaryKey.columns,
      "mutation_seq",
    ]),
  );
  statements.push(
    renderCreateIndexStatement(projection.journalTable, `${journalTableName}_entity_seq_idx`, [
      "entity_key_json",
      "mutation_seq",
    ]),
  );
  statements.push(
    renderCreateIndexStatement(projection.journalTable, `${journalTableName}_entity_status_seq_idx`, [
      "entity_key_json",
      "status",
      "mutation_seq",
    ]),
  );

  // Trigger: automatically clear overlay + journal entries when the sync
  // echo arrives. Fires on INSERT/UPDATE (new data from Electric) and DELETE
  // (row removed on server, synced back via Electric).
  const pkMatchSql = (alias: string) =>
    primaryKeyColumns
      .map((col) => `"${alias}"."${col.name}" = COALESCE(NEW."${col.name}", OLD."${col.name}")`)
      .join(" AND ");
  const pkOverlayMatchSql = primaryKeyColumns
    .map((col) => `"overlay"."${col.name}" = COALESCE(NEW."${col.name}", OLD."${col.name}")`)
    .join(" AND ");

  // ADR-0010: an acked create/update clears only once the synced echo's Server version reaches
  // the write's acked version — never on a bare key-match, which a stale or reordered echo could
  // satisfy and flip the read model to neither the optimistic nor the converged value. A delete
  // stays resolved by synced-row absence (NEW is NULL on the synced DELETE; the barrier reads
  // NULL there, so it never clears a create/update on a delete echo). One predicate, shared with
  // reconcileTable (mutation.ts), so the two sites cannot drift.
  const resolutionBarrier = buildOverlayResolutionBarrier(entry, { syncedAlias: "NEW" });

  // ADR-0021 §3: an ephemeral cluster's reconcile function lives in `pg_temp` alongside its temp table
  // (a permanent function cannot be a temp trigger's handler cleanly); a persistent one is unchanged.
  const reconcileFunctionRef = ephemeral ? `pg_temp.${projection.reconcileFunction}` : projection.reconcileFunction;

  statements.push(
    `CREATE OR REPLACE FUNCTION ${reconcileFunctionRef}() RETURNS TRIGGER AS $$\n` +
      `BEGIN\n` +
      `  -- ADR-0015: retire a terminal 'conflicted' row once a LATER write on the same entity has\n` +
      `  -- been acked — that later write IS the resolution. The acked resolver is cleared by the\n` +
      `  -- acked-delete below the moment its echo lands; if that echo wins the race against the\n` +
      `  -- post-flush reconcileTable pass, the resolver is gone before reconcileTable's supersede-\n` +
      `  -- retire can see it and the conflicted row orphans (its surfaced conflict_state never\n` +
      `  -- clears). Doing the retire here too — in the trigger that has the echo context, BEFORE the\n` +
      `  -- acked-clear — closes that race. Mirrors reconcileTable's retire (mutation.ts).\n` +
      `  DELETE FROM ${projection.journalTable} AS "conflicted"\n` +
      `  USING ${projection.journalTable} AS "resolver"\n` +
      `  WHERE "conflicted".status = 'conflicted' AND (${pkMatchSql("conflicted")})\n` +
      `    AND "resolver".entity_key_json = "conflicted".entity_key_json\n` +
      `    AND "resolver".mutation_seq > "conflicted".mutation_seq\n` +
      `    AND "resolver".status = 'acked';\n` +
      `  DELETE FROM ${projection.journalTable} AS "journal"\n` +
      `  WHERE status = 'acked' AND (${pkMatchSql("journal")})\n` +
      `    AND (\n` +
      `      (TG_OP <> 'DELETE' AND mutation_kind <> 'delete' AND ${resolutionBarrier})\n` +
      `      OR (TG_OP = 'DELETE' AND mutation_kind = 'delete')\n` +
      `    );\n` +
      `  DELETE FROM ${projection.overlayTable} AS "overlay"\n` +
      `  WHERE (${pkOverlayMatchSql})\n` +
      `    AND NOT EXISTS (\n` +
      `      SELECT 1 FROM ${projection.journalTable} AS j\n` +
      `      WHERE (${pkMatchSql("j")})\n` +
      `    );\n` +
      `  RETURN COALESCE(NEW, OLD);\n` +
      `END;\n` +
      `$$ LANGUAGE plpgsql;`,
  );

  statements.push(
    `CREATE OR REPLACE TRIGGER ${projection.reconcileTrigger}\n` +
      `AFTER INSERT OR UPDATE OR DELETE ON ${projection.syncedTable}\n` +
      `FOR EACH ROW EXECUTE FUNCTION ${reconcileFunctionRef}();`,
  );

  statements.push(
    `CREATE OR REPLACE ${temp}VIEW ${projection.readModel} AS\n${buildReadModelViewSql(
      entry,
      projection,
      columns.map((column) => column.name),
    )};`,
  );

  // ADR-0011: the per-table convergence view — a derived projection over synced + overlay +
  // journal, distinct from the (lean) read model, whose acked-unobserved status derives from the
  // same barrier predicate the reconcile trigger above uses (decision 4, anti-drift).
  statements.push(
    `CREATE OR REPLACE ${temp}VIEW ${projection.syncState} AS\n${buildSyncStateView(entry, {
      syncedTable: projection.syncedTable,
      overlayTable: projection.overlayTable,
      journalTable: projection.journalTable,
    })};`,
  );

  return statements;
}

/**
 * The DURABLE half of the local schema (slice 3): the schema + `pgxsinkit_local_meta` bootstrap, ALL enum
 * types the registry references (enums are persistent DB objects — they live in the durable schema even for
 * ephemeral tables, ADR-0021 §3 — so they belong here and their change invalidates the fingerprint), and the
 * full cluster of every PERSISTENT entry, in registry order. This is the exact statement stream the
 * `local_schema_fingerprint` hashes and the boot fast path may SKIP on a warm store.
 */
function durableSchemaStatements<TRegistry extends SyncTableRegistry>(registry: TRegistry): string[] {
  const localSchema = getSyncRegistrySchema(registry);
  const statements: string[] = [...localMetaBootstrapStatements(localSchema)];

  for (const enumDefinition of collectEnumDefinitions(registry, localSchema)) {
    statements.push(buildCreateEnumTypeSql(enumDefinition));
  }

  for (const [tableKey, entry] of Object.entries(registry)) {
    if (entry.retention === "ephemeral") {
      continue;
    }

    statements.push(...buildEntryClusterStatements(entry, tableKey, localSchema));
  }

  return statements;
}

/**
 * The EPHEMERAL half of the local schema (slice 3): re-emitted idempotent enum guards for the enums the
 * ephemeral entries reference (a subset of the durable enum header — the `DO $$ IF NOT EXISTS` blocks are
 * cheap no-ops when the durable enums already exist, and re-emitting removes any ordering dependency on the
 * durable portion when this runs standalone on a fingerprint-skipped warm boot), followed by the full TEMP
 * cluster of every EPHEMERAL entry, and finally the registry-wide `pgxsinkit_all_mutations` TEMP VIEW
 * (slice 4) whenever the registry has ≥1 writable table. Always applied on boot (TEMP relations die with the
 * old engine), and empty (`[]`) only when the registry declares no ephemeral entry AND no writable table, so
 * the boot skips the crossing entirely.
 */
function ephemeralSchemaStatements<TRegistry extends SyncTableRegistry>(registry: TRegistry): string[] {
  const localSchema = getSyncRegistrySchema(registry);
  const ephemeralEntries = Object.entries(registry).filter(([, entry]) => entry.retention === "ephemeral");

  const statements: string[] = [];

  if (ephemeralEntries.length > 0) {
    for (const enumDefinition of collectEnumDefinitionsFromEntries(
      ephemeralEntries.map(([, entry]) => entry),
      localSchema,
    )) {
      statements.push(buildCreateEnumTypeSql(enumDefinition));
    }

    for (const [tableKey, entry] of ephemeralEntries) {
      statements.push(...buildEntryClusterStatements(entry, tableKey, localSchema));
    }
  }

  // The registry-wide cross-journal mutation view (slice 4). Always-applied and TEMP (correction 4): it may
  // reference `pg_temp` ephemeral journals AND persistent journals, so it lives here regardless of whether the
  // registry declares any ephemeral entry. Emitted only when the registry has ≥1 writable table (a journal to
  // union); a registry of only readonly tables emits nothing and this whole portion stays empty.
  statements.push(...allMutationsViewStatements(registry));

  return statements;
}

/**
 * The `CREATE OR REPLACE TEMP VIEW pgxsinkit_all_mutations` statement for the mutation-status API, or
 * `[]` when the registry has no writable table. Each branch selects a `table_key` literal plus the shared
 * fixed journal columns ({@link ALL_MUTATIONS_JOURNAL_COLUMNS}) from one writable journal, UNION-ALL-ed.
 * Generated DDL (existing generator style): the branch column list is a fixed identifier set and each
 * `table_key` is a bound string literal — every RUNTIME query authors over {@link getAllMutationsView}
 * (tier ①), never this text. The journal name resolves through the SAME `getClientProjection` the DDL
 * generator uses (ephemeral → bare `pg_temp` name; persistent → schema-qualified), so the two cannot drift.
 */
function allMutationsViewStatements<TRegistry extends SyncTableRegistry>(registry: TRegistry): string[] {
  const localSchema = getSyncRegistrySchema(registry);
  const branches: string[] = [];

  for (const [tableKey, entry] of Object.entries(registry)) {
    if (entry.mode === "readonly" || !entry.clientProjection?.journalTable) {
      continue;
    }

    const objectSchema = entry.retention === "ephemeral" ? "public" : localSchema;
    const projection = getClientProjection(entry, tableKey, objectSchema);

    if (!projection.journalTable) {
      continue;
    }

    branches.push(
      `SELECT ${quoteSqlStringLiteral(tableKey)} AS table_key,\n  ${ALL_MUTATIONS_JOURNAL_COLUMNS.join(",\n  ")}\nFROM ${projection.journalTable}`,
    );
  }

  if (branches.length === 0) {
    return [];
  }

  return [`CREATE OR REPLACE TEMP VIEW ${ALL_MUTATIONS_VIEW} AS\n${branches.join("\nUNION ALL\n")};`];
}

/** The DURABLE local schema as an executable script (slice 3) — the fingerprint's basis. See {@link durableSchemaStatements}. */
export function generateDurableLocalSchemaSql<TRegistry extends SyncTableRegistry>(registry: TRegistry): string {
  return joinSchemaStatements(durableSchemaStatements(registry));
}

/**
 * The EPHEMERAL (always-applied) local schema as an executable script (slice 3), or `""` when the registry
 * has no ephemeral entry (so the boot skips the crossing). See {@link ephemeralSchemaStatements}.
 */
export function generateEphemeralLocalSchemaSql<TRegistry extends SyncTableRegistry>(registry: TRegistry): string {
  const statements = ephemeralSchemaStatements(registry);
  return statements.length === 0 ? "" : joinSchemaStatements(statements);
}

/**
 * The complete local schema — durable statements then ephemeral statements — the single script the
 * wipe/rebuild paths and every external caller keep using. For an all-persistent registry the durable stream
 * is the registry-ordered stream, followed by the always-applied ephemeral portion — which for any registry
 * with a writable table carries the `pgxsinkit_all_mutations` TEMP VIEW as its trailing statement. For a
 * MIXED registry the script is idempotent-equivalent to (not a character-for-character match of) a
 * single-pass interleave: the persistent clusters precede the ephemeral ones and the ephemeral portion
 * re-emits idempotent enum guards — a reordering of independent `IF NOT EXISTS` DDL that executes to the
 * same schema. Equals `durable + ephemeral` by construction (test-covered).
 */
export function generateLocalSchemaSql<TRegistry extends SyncTableRegistry>(registry: TRegistry): string {
  return joinSchemaStatements([...durableSchemaStatements(registry), ...ephemeralSchemaStatements(registry)]);
}

/**
 * The durable-schema fingerprint value: `lsf1:<FNV-1a hash of the durable SQL>`. The
 * hash is over the generated durable DDL body itself (no composed inputs, no hand-maintained format-version
 * constant), so it auto-invalidates on ANY generator change, registry change, or projection rename — the
 * ADR-0018 apply-function-fingerprint precedent applied to the local schema. Stamped into
 * {@link LOCAL_SCHEMA_FINGERPRINT_KEY} only after a successful durable exec.
 */
export function computeLocalSchemaFingerprint<TRegistry extends SyncTableRegistry>(registry: TRegistry): string {
  return `${LOCAL_SCHEMA_FINGERPRINT_PREFIX}${hashString(generateDurableLocalSchemaSql(registry))}`;
}

function buildReadModelViewSql(
  entry: SyncTableEntry<AnyPgTable>,
  projection: ResolvedProjection,
  columnNames: string[],
) {
  if (!projection.overlayTable) {
    throw new Error(`overlay table is required for writable table ${projection.syncedTable}`);
  }

  const pkMatch = buildPrimaryKeyMatch(entry.primaryKey.columns);
  const syncedLocalUpdatedExpression = columnNames.includes("updated_at_us") ? "t.updated_at_us" : "CAST(0 AS BIGINT)";

  return [
    "SELECT",
    `  ${columnNames.join(",\n  ")},`,
    "  overlay_kind,",
    "  local_updated_at_us",
    `FROM ${projection.overlayTable}`,
    `WHERE overlay_kind <> 'pending_delete'`,
    "UNION ALL",
    "SELECT",
    `  ${columnNames.map((name) => `t.${name}`).join(",\n  ")},`,
    `  'synced' AS overlay_kind,`,
    `  ${syncedLocalUpdatedExpression} AS local_updated_at_us`,
    `FROM ${projection.syncedTable} AS t`,
    "WHERE NOT EXISTS (",
    "  SELECT 1",
    `  FROM ${projection.overlayTable} AS o`,
    `  WHERE ${pkMatch}`,
    ")",
  ].join("\n");
}

function buildTableColumnSql(columns: TableColumn[], primaryKeyColumns: string[], localSchema: string) {
  return [
    ...columns.map((column) => buildColumnDefinition(column, primaryKeyColumns, localSchema)),
    ...buildCompositePrimaryKeyClauses(primaryKeyColumns),
  ].join(",\n  ");
}

/**
 * Render `CREATE TABLE IF NOT EXISTS` (plus a `CREATE INDEX IF NOT EXISTS` per declared index) for a
 * Drizzle `pgTable` / `pgSchema.table`, through the SAME column/PK/type machinery
 * ({@link buildTableColumnSql} → {@link buildColumnDefinition} → {@link mapColumnType}) that
 * {@link generateLocalSchemaSql} uses for every other local relation. The table is schema-qualified
 * when it declares a schema and bare otherwise (per the table object). Column types come from each
 * column's `getSQLType()`, NOT NULL and single-column PRIMARY KEY inline, composite PKs as a trailing
 * clause. Enum column types are qualified into the table's own schema — the metadata pgTables carry
 * none, but the path is shared with the local-store generator so it must stay honest.
 *
 * ADR-0029 D3: the metadata-store DDL renders from its `metadata-tables.ts` pgTables through this,
 * making the pgTable the single source. The OUTPUT is tier-③-by-nature runtime DDL (schema/table
 * identifiers assembled at construction), but it is GENERATED from the model, never hand-maintained.
 *
 * ADR-0042: `{ temp: true }` renders the SESSION variant — `CREATE TEMP TABLE IF NOT EXISTS <bare name>`
 * (+ each index `ON <bare name>`), IGNORING the pgTable's declared schema for the RELATION name. TEMP DDL
 * takes the UNqualified relation name (the TEMP keyword places it in `pg_temp`; a `CREATE TEMP TABLE
 * pg_temp.x` target is not portable). Same relation/index NAMES as the durable form: an index name lives
 * per schema, so the durable (metadata-schema) and session (`pg_temp`) indexes coexist without collision
 * (probed on real PGlite).
 *
 * CAVEAT — the `temp` flag only bares the RELATION name; `buildTableColumnSql` below still receives
 * `schemaName` and would qualify any ENUM column type into THAT schema. That is correct only because the
 * metadata pgTables (the sole callers of `{ temp: true }`) carry no enum columns. A future enum-bearing TEMP
 * render would emit `<metadataSchema>.<enum>` for the column type — which is exactly what we want (enums are
 * persistent DB objects living in the durable schema even for TEMP tables, ADR-0021 §3), NOT a `pg_temp`
 * qualification. If this path ever renders a TEMP relation with an enum, keep the enum durable-qualified;
 * do not fold the `temp` flag into the column-type schema.
 */
export function renderCreateTableSql(table: AnyPgTable, options: { temp?: boolean } = {}): string[] {
  const config = getTableConfig(table);
  const temp = options.temp === true;
  const schemaName = config.schema ?? "public";
  // The DML paths qualify the session tables into `pg_temp`; the DDL must NOT — see the doc comment.
  const tableRef = temp ? maybeQuoteIdentifier(config.name) : qualifyIdentifier(schemaName, config.name);
  const primaryKeyColumns = collectPgTablePrimaryKeyColumns(config);
  const columnSql = buildTableColumnSql(config.columns as unknown as TableColumn[], primaryKeyColumns, schemaName);

  const createKeyword = temp ? "CREATE TEMP TABLE" : "CREATE TABLE";
  const statements = [`${createKeyword} IF NOT EXISTS ${tableRef} (\n  ${columnSql}\n);`];

  for (const index of config.indexes) {
    statements.push(renderCreateIndexSql(tableRef, index));
  }

  return statements;
}

/** The PK column names of a `pgTable` — column-level `.primaryKey()` first, then composite `primaryKey({…})`. */
function collectPgTablePrimaryKeyColumns(config: ReturnType<typeof getTableConfig>): string[] {
  const columnLevel = config.columns.filter((column) => column.primary).map((column) => column.name);
  const composite = config.primaryKeys.flatMap((pk) => pk.columns.map((column) => column.name));
  return [...columnLevel, ...composite];
}

function renderCreateIndexSql(qualifiedTableName: string, index: ReturnType<typeof getTableConfig>["indexes"][number]) {
  const { name, unique, columns, where, method, with: withParams } = index.config;
  if (!name) {
    throw new Error("renderCreateIndexSql: anonymous indexes are not supported (declare a name)");
  }
  // This renderer emits only a plain ascending btree over bare columns. Any modifier it does not
  // render must fail loudly — silently dropping one would produce a local index that differs from the
  // pgTable declaration (the very DDL-vs-model divergence ADR-0029 D3 removes for the metadata store).
  if (where) {
    throw new Error(`renderCreateIndexSql: partial indexes (.where) are not supported (index ${name})`);
  }
  if (method && method.toLowerCase() !== "btree") {
    throw new Error(
      `renderCreateIndexSql: non-btree index methods (.using "${method}") are not supported (index ${name})`,
    );
  }
  if (withParams && Object.keys(withParams).length > 0) {
    throw new Error(`renderCreateIndexSql: index storage parameters (.with) are not supported (index ${name})`);
  }
  const columnExpressions = columns.map((column) => {
    const columnName = (column as { name?: unknown }).name;
    if (typeof columnName !== "string") {
      throw new Error(`renderCreateIndexSql: expression index columns are not supported (index ${name})`);
    }
    const indexConfig = (column as { indexConfig?: { order?: string; nulls?: string; opClass?: string } }).indexConfig;
    if (indexConfig?.order === "desc") {
      throw new Error(`renderCreateIndexSql: descending index columns (.desc()) are not supported (index ${name})`);
    }
    // Drizzle fills `nulls` with the ascending-btree default ("last") on every column; only an
    // explicit NULLS FIRST diverges from what we render (a plain ascending btree is NULLS LAST).
    if (indexConfig?.nulls === "first") {
      throw new Error(`renderCreateIndexSql: NULLS FIRST ordering (.nullsFirst()) is not supported (index ${name})`);
    }
    if (indexConfig?.opClass) {
      throw new Error(`renderCreateIndexSql: index operator classes (.op()) are not supported (index ${name})`);
    }
    return maybeQuoteIdentifier(columnName);
  });

  return renderCreateIndexStatement(qualifiedTableName, maybeQuoteIdentifier(name), columnExpressions, { unique });
}

/**
 * The shared `CREATE INDEX` core: assemble one
 * `CREATE [UNIQUE] INDEX IF NOT EXISTS <name> ON <table> (<cols>)` over a qualified table, an
 * already-rendered index name, and already-rendered plain ascending column expressions. BOTH the
 * pgTable-driven renderer ({@link renderCreateIndexSql}) and the journal-index emitter in
 * {@link generateLocalSchemaSql} go through here, so the two index-emitting paths cannot drift in
 * statement shape. Identifier quoting is the caller's responsibility — the pgTable path quotes via
 * `maybeQuoteIdentifier`; the journal path passes its registry-derived bare names/columns verbatim —
 * this core only fixes the surrounding statement text.
 */
function renderCreateIndexStatement(
  qualifiedTableName: string,
  indexName: string,
  columnExpressions: readonly string[],
  options: { unique?: boolean } = {},
): string {
  const uniqueSql = options.unique ? "UNIQUE " : "";
  return `CREATE ${uniqueSql}INDEX IF NOT EXISTS ${indexName} ON ${qualifiedTableName} (${columnExpressions.join(", ")});`;
}

function buildColumnDefinition(column: TableColumn, primaryKeyColumns: string[], localSchema: string) {
  const typeSql = mapColumnType(column, localSchema);
  const notNullSql = column.notNull ? " NOT NULL" : "";
  const primaryKeySql = primaryKeyColumns.length === 1 && primaryKeyColumns.includes(column.name) ? " PRIMARY KEY" : "";
  return `${column.name} ${typeSql}${notNullSql}${primaryKeySql}`;
}

function buildCompositePrimaryKeyClauses(primaryKeyColumns: string[]) {
  if (primaryKeyColumns.length <= 1) {
    return [];
  }

  return [`PRIMARY KEY (${primaryKeyColumns.join(", ")})`];
}

function mapColumnType(column: TableColumn, localSchema: string) {
  const baseTypeSql = readBaseColumnTypeSql(column, localSchema);
  const dimensions = readArrayDimensions(column);

  if (dimensions > 0) {
    return `${baseTypeSql}${"[]".repeat(dimensions)}`;
  }

  return baseTypeSql;
}

function readBaseColumnTypeSql(column: TableColumn, localSchema: string) {
  const enumDefinition = readEnumColumnDefinition(column, localSchema);

  if (enumDefinition) {
    return qualifyIdentifier(enumDefinition.schemaName, enumDefinition.enumName);
  }

  const sqlType = (column as { getSQLType(): string }).getSQLType();

  if (!sqlType) {
    throw new Error(`Unsupported column type for local schema generation: ${column.columnType}`);
  }

  return sqlType;
}

type EnumDefinition = {
  schemaName: string;
  enumName: string;
  enumValues: string[];
};

function collectEnumDefinitions(registry: SyncTableRegistry, localSchema: string) {
  return collectEnumDefinitionsFromEntries(Object.values(registry), localSchema);
}

/**
 * Collect the distinct enum types referenced by a GIVEN set of registry entries (deduped by name, values
 * cross-checked for conflicts, sorted for stable output). Factored out of {@link collectEnumDefinitions} so
 * the Data export (ADR-0035) can emit ONLY the enums its `-t` allowlist tables reference — the whole-registry
 * caller passes every entry, the data export passes just its owning persistent entries — through one honest
 * implementation, never a second enum-scanning path that could drift on the conflict/sort rules.
 */
function collectEnumDefinitionsFromEntries(entries: SyncTableEntry[], localSchema: string) {
  const enumDefinitionsByName = new Map<string, EnumDefinition>();

  for (const entry of entries) {
    const columns = getProjectedColumns(entry).map(({ column }) => column);

    for (const column of columns) {
      const enumDefinition = readEnumColumnDefinition(column, localSchema);

      if (!enumDefinition) {
        continue;
      }

      const existingDefinition = enumDefinitionsByName.get(enumDefinition.enumName);

      if (!existingDefinition) {
        enumDefinitionsByName.set(enumDefinition.enumName, enumDefinition);
        continue;
      }

      if (!areEnumValuesEqual(existingDefinition.enumValues, enumDefinition.enumValues)) {
        throw new Error(
          `Enum ${enumDefinition.enumName} has conflicting values in sync registry: ${existingDefinition.enumValues.join(", ")} vs ${enumDefinition.enumValues.join(", ")}`,
        );
      }
    }
  }

  return [...enumDefinitionsByName.values()].sort((left, right) => left.enumName.localeCompare(right.enumName));
}

/**
 * Does this entry OWN a physical, persistent synced table — i.e. is it a `-t` allowlist candidate for the
 * Data export (ADR-0035 decision 1)? Two entries are excluded:
 *
 * - a **read PROJECTION** (`readProjection`) owns no table (its `table` is another entry's), so it must
 *   never be listed — it would double-target the owner's physical table;
 * - an **ephemeral** entry's cluster is emitted as `pg_temp` TEMP objects (ADR-0021 §3), absent from the
 *   throwaway clone by construction — and a `pg_dump -t` pattern that matches NOTHING makes `pg_dump` fail,
 *   so an ephemeral table must not appear in the allowlist at all.
 *
 * Overlay/journal/meta tables, read-model/sync-state views, and reconcile functions are excluded by `-t`
 * semantics automatically (they are neither the synced table nor matched by its name), so they need no
 * filter here.
 */
function ownsPersistentSyncedTable(entry: SyncTableEntry): boolean {
  return !entry.readProjection && entry.retention !== "ephemeral";
}

/**
 * The `-t` allowlist for a Data export (ADR-0035 decision 1): the schema-qualified PHYSICAL synced table
 * name for every registry entry that owns one, resolved through the SAME `getClientProjection` the local
 * DDL generator uses — NOT re-derived by string convention. This is deliberately the physical `syncedTable`,
 * never the read-model view (whose name can carry the entry name while the table differs): `-t` must target
 * the tables that hold the rows. Read-projection and ephemeral entries are excluded (see
 * {@link ownsPersistentSyncedTable}).
 */
export function collectDataExportSyncedTableNames<TRegistry extends SyncTableRegistry>(registry: TRegistry): string[] {
  const localSchema = getSyncRegistrySchema(registry);
  const names: string[] = [];

  for (const [tableKey, entry] of Object.entries(registry)) {
    if (!ownsPersistentSyncedTable(entry)) {
      continue;
    }

    names.push(getClientProjection(entry, tableKey, localSchema).syncedTable);
  }

  return names;
}

/**
 * The clone-cleanup SQL a Data export runs on its THROWAWAY clone before `pg_dump -t` (ADR-0035). The
 * reconcile trigger sits ON the synced table (`AFTER INSERT/UPDATE/DELETE ON <syncedTable>`), so
 * `pg_dump -t <syncedTable>` pulls the trigger into the dump — but its function is pgxsinkit machinery the
 * data export deliberately EXCLUDES, so the artefact would carry a trigger referencing a missing function
 * and fail to load into a vanilla Postgres. Because the clone is a memory-backed throwaway we fully own, we
 * drop each reconcile trigger (and its now-unreferenced function) on it first, so `-t` yields clean,
 * portable tables. Overlay/journal/views/metadata are NOT captured by `-t <syncedTable>` at all (a probe
 * confirmed only the table, its PK, its data, and this trigger appear), so nothing else needs dropping.
 * Returns `""` when the registry declares no writable owning table.
 */
export function buildDataExportCloneCleanupSql<TRegistry extends SyncTableRegistry>(registry: TRegistry): string {
  const localSchema = getSyncRegistrySchema(registry);
  const statements: string[] = [];

  for (const [tableKey, entry] of Object.entries(registry)) {
    if (!ownsPersistentSyncedTable(entry) || entry.mode === "readonly") {
      continue;
    }

    const projection = getClientProjection(entry, tableKey, localSchema);
    // Drop the trigger first, then its now-unreferenced function (drop order avoids a dependency error).
    statements.push(`DROP TRIGGER IF EXISTS ${projection.reconcileTrigger} ON ${projection.syncedTable};`);
    statements.push(`DROP FUNCTION IF EXISTS ${projection.reconcileFunction}();`);
  }

  return statements.join("\n");
}

/**
 * The enum DDL header for a Data export artefact (ADR-0035 decision 1). `pg_dump -t <table>` emits the
 * tables but NOT the enum types their columns reference, so the portable artefact is this generated header
 * concatenated ahead of the `pg_dump` output. It reuses the SAME `CREATE TYPE` generation the local-schema
 * generator emits ({@link buildCreateEnumTypeSql}) — every enum wrapped in an idempotent `IF NOT EXISTS`
 * guard — restricted to the enums actually referenced by the exported (owning, persistent) tables, so a
 * dropped/ephemeral-only enum never bloats the artefact. When the registry uses a non-`public` schema, a
 * `CREATE SCHEMA IF NOT EXISTS` precedes the types (they live in that schema, and the header runs before
 * `pg_dump`'s own schema creation), so the header is self-contained against a bare Postgres. Returns `""`
 * when no exported table references an enum.
 */
export function buildDataExportEnumHeaderSql<TRegistry extends SyncTableRegistry>(registry: TRegistry): string {
  const localSchema = getSyncRegistrySchema(registry);
  const exportedEntries = Object.values(registry).filter(ownsPersistentSyncedTable);
  const enumDefinitions = collectEnumDefinitionsFromEntries(exportedEntries, localSchema);

  if (enumDefinitions.length === 0) {
    return "";
  }

  const statements: string[] = [
    "-- Enum types referenced by the exported tables. `pg_dump -t` does not emit the enum types",
    "-- its tables depend on, so pgxsinkit generates them here from the sync registry (ADR-0035).",
  ];

  // A non-public schema must exist before its `CREATE TYPE` runs — this header precedes pg_dump's own
  // schema creation, so create it ourselves (idempotent), mirroring `generateLocalSchemaSql`.
  if (localSchema !== "public") {
    statements.push(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(localSchema)};`);
  }

  for (const enumDefinition of enumDefinitions) {
    statements.push(buildCreateEnumTypeSql(enumDefinition));
  }

  return `${statements.join("\n")}\n`;
}

function buildCreateEnumTypeSql(enumDefinition: EnumDefinition) {
  const typeIdentifier = qualifyIdentifier(enumDefinition.schemaName, enumDefinition.enumName);
  const enumValuesSql = enumDefinition.enumValues.map((value) => quoteSqlStringLiteral(value)).join(", ");

  return [
    "DO $$",
    "BEGIN",
    "  IF NOT EXISTS (",
    "    SELECT 1",
    "    FROM pg_type AS t",
    "    INNER JOIN pg_namespace AS n ON n.oid = t.typnamespace",
    `    WHERE t.typname = ${quoteSqlStringLiteral(enumDefinition.enumName)}`,
    `      AND n.nspname = ${quoteSqlStringLiteral(enumDefinition.schemaName)}`,
    "  ) THEN",
    `    CREATE TYPE ${typeIdentifier} AS ENUM (${enumValuesSql});`,
    "  END IF;",
    "END",
    "$$;",
  ].join("\n");
}

function areEnumValuesEqual(left: string[], right: string[]) {
  if (left.length !== right.length) {
    return false;
  }

  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }

  return true;
}

function readEnumColumnDefinition(column: TableColumn, localSchema: string): EnumDefinition | undefined {
  const candidate = column as TableColumn & {
    enum?: {
      enumName?: unknown;
      enumValues?: unknown;
    };
  };

  if (!candidate.enum || typeof candidate.enum.enumName !== "string" || !Array.isArray(candidate.enum.enumValues)) {
    return undefined;
  }

  const enumValues = candidate.enum.enumValues.filter((value): value is string => typeof value === "string");

  if (enumValues.length !== candidate.enum.enumValues.length) {
    throw new Error(
      `Enum ${candidate.enum.enumName} includes non-string values and cannot be emitted in local schema SQL`,
    );
  }

  return {
    schemaName: localSchema,
    enumName: candidate.enum.enumName,
    enumValues,
  };
}

function readArrayDimensions(column: TableColumn) {
  const arrayColumn = column as TableColumn & { dimensions?: number };
  return arrayColumn.dimensions ?? 0;
}

function buildPrimaryKeyMatch(primaryKeyColumns: string[]) {
  return primaryKeyColumns.map((column) => `o.${column} = t.${column}`).join(" AND ");
}

function getClientProjection(entry: SyncTableEntry, tableKey: string, localSchema: string): ResolvedProjection {
  const projection = baseProjection(entry, tableKey);
  const syncedTableName = projection.syncedTable ?? tableKey;
  const readModelName = entry.view != null ? getViewConfig(entry.view).name : syncedTableName;

  return {
    syncedTable: qualifyIdentifier(localSchema, syncedTableName),
    ...(projection.overlayTable ? { overlayTable: qualifyIdentifier(localSchema, projection.overlayTable) } : {}),
    ...(projection.journalTable ? { journalTable: qualifyIdentifier(localSchema, projection.journalTable) } : {}),
    readModel: qualifyIdentifier(localSchema, readModelName),
    syncState: qualifyIdentifier(localSchema, `${syncedTableName}_sync_state`),
    reconcileFunction: qualifyIdentifier(localSchema, `${syncedTableName}_reconcile_on_sync`),
    reconcileTrigger: maybeQuoteIdentifier(`${syncedTableName}_reconcile_on_sync`),
  };
}

function baseProjection(entry: SyncTableEntry, tableKey: string) {
  if (!entry.clientProjection) {
    throw new Error(`clientProjection is required for local client table ${tableKey}`);
  }

  return entry.clientProjection;
}

function qualifyIdentifier(schemaName: string, objectName: string) {
  if (schemaName === "public") {
    // Quote only when required so existing generated SQL stays stable, but a table/view named
    // after a reserved word (e.g. `group`) is a valid Postgres identifier and MUST be quoted or
    // the generated DDL and read queries fail to parse. The row-applier (src/sync) always quotes.
    return maybeQuoteIdentifier(objectName);
  }

  return `${quoteIdentifier(schemaName)}.${quoteIdentifier(objectName)}`;
}

function buildJournalSequenceName(journalTable: string) {
  return `${journalTable}_mutation_seq`;
}

/**
 * Drop the reconstructible **read cache** — the synced tables and their read-model views
 * and reconcile triggers/functions — while preserving the authority tables (overlay,
 * journal, the local-meta table). Re-running {@link generateLocalSchemaSql} then rebuilds
 * the synced tables at the current shape, and a re-sync refills them (ADR-0006). This is
 * the named drop primitive a returning-online upgrade uses after a clean drain.
 */
export function buildDropReadCacheSql<TRegistry extends SyncTableRegistry>(registry: TRegistry): string {
  const localSchema = getSyncRegistrySchema(registry);
  const statements: string[] = [];

  for (const [tableKey, entry] of Object.entries(registry)) {
    const projection = getClientProjection(entry, tableKey, localSchema);

    if (entry.mode !== "readonly") {
      statements.push(`DROP VIEW IF EXISTS ${projection.syncState};`);
      statements.push(`DROP VIEW IF EXISTS ${projection.readModel};`);
      statements.push(`DROP TRIGGER IF EXISTS ${projection.reconcileTrigger} ON ${projection.syncedTable};`);
      statements.push(`DROP FUNCTION IF EXISTS ${projection.reconcileFunction}();`);
    }

    statements.push(`DROP TABLE IF EXISTS ${projection.syncedTable} CASCADE;`);
  }

  return `${statements.join("\n")}\n`;
}

/**
 * Wipe the **entire** local store provisioned from the registry — the read cache plus the
 * authority tables (overlay, journal, sequences), the enum types, and the local-meta row.
 * This is the full teardown reused by `destroy()` (ADR-0005 decision 5) and by the
 * drain-then-drop upgrade once a clean drain has confirmed nothing is owed (ADR-0006).
 */
export function buildWipeLocalStoreSql<TRegistry extends SyncTableRegistry>(registry: TRegistry): string {
  const localSchema = getSyncRegistrySchema(registry);
  const statements: string[] = [buildDropReadCacheSql(registry).trimEnd()];

  for (const [tableKey, entry] of Object.entries(registry)) {
    if (entry.mode === "readonly") {
      continue;
    }

    const projection = getClientProjection(entry, tableKey, localSchema);

    if (projection.overlayTable) {
      statements.push(`DROP TABLE IF EXISTS ${projection.overlayTable} CASCADE;`);
    }

    if (projection.journalTable && entry.clientProjection?.journalTable) {
      statements.push(`DROP TABLE IF EXISTS ${projection.journalTable} CASCADE;`);
      statements.push(
        `DROP SEQUENCE IF EXISTS ${qualifyIdentifier(localSchema, buildJournalSequenceName(entry.clientProjection.journalTable))};`,
      );
    }
  }

  for (const enumDefinition of collectEnumDefinitions(registry, localSchema)) {
    statements.push(`DROP TYPE IF EXISTS ${qualifyIdentifier(enumDefinition.schemaName, enumDefinition.enumName)};`);
  }

  statements.push(`DROP TABLE IF EXISTS ${qualifyIdentifier(localSchema, LOCAL_META_TABLE)} CASCADE;`);

  return `${statements.join("\n")}\n`;
}

/**
 * Clean-truncate a single table's local read cache so a desynced `lazy` relation (ADR-0021 §2) returns
 * to an empty, dormant state: the synced table and — for a writable table — its optimistic overlay and
 * the journal, plus a sequence restart. It does NOT drop the cluster (the table/views/trigger persist),
 * so a later re-reference re-streams into it without a schema rebuild. Ephemeral-aware: bare/`pg_temp`
 * names for an ephemeral cluster, schema-qualified for a persistent one — mirroring
 * {@link generateLocalSchemaSql}. The caller (`desync`) first stops the group's stream (so nothing
 * re-populates mid-truncate) and refuses when the journal owes unsettled writes (so this never drops
 * un-acked local intent).
 */
export function buildDesyncTableSql<TRegistry extends SyncTableRegistry>(
  registry: TRegistry,
  tableKey: string,
): string {
  const entry = registry[tableKey];

  if (!entry) {
    throw new Error(`buildDesyncTableSql: unknown table ${tableKey}`);
  }

  const localSchema = getSyncRegistrySchema(registry);
  const ephemeral = entry.retention === "ephemeral";
  const objectSchema = ephemeral ? "public" : localSchema;
  const projection = getClientProjection(entry, tableKey, objectSchema);
  const statements: string[] = [`TRUNCATE TABLE ${projection.syncedTable};`];

  if (entry.mode !== "readonly") {
    if (projection.overlayTable) {
      statements.push(`TRUNCATE TABLE ${projection.overlayTable};`);
    }

    if (projection.journalTable && entry.clientProjection?.journalTable) {
      statements.push(`TRUNCATE TABLE ${projection.journalTable};`);
      statements.push(
        `ALTER SEQUENCE ${qualifyIdentifier(objectSchema, buildJournalSequenceName(entry.clientProjection.journalTable))} RESTART WITH 1;`,
      );
    }
  }

  // ADR-0023 Slice 2: a desync reverts the relation to dormant and deletes its subscription, so the next
  // activation re-streams from scratch — drop this shape's tag-set too, or it would orphan tags for rows
  // that never come back. The key matches what the engine writes (`shapeTableId(shape.schema, table)`):
  // for ephemeral the engine passes no schema (→ `public`), exactly this `objectSchema`.
  const syncedTableNameRaw = baseProjection(entry, tableKey).syncedTable ?? tableKey;
  statements.push(buildClearShapeTagsSql(shapeTableId(objectSchema, syncedTableNameRaw)));

  return `${statements.join("\n")}\n`;
}
