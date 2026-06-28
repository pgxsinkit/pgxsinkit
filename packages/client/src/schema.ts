import { getViewConfig, type AnyPgTable } from "drizzle-orm/pg-core";

import {
  buildOverlayResolutionBarrier,
  buildSyncStateView,
  getLocalSyncPrimaryKeyColumns,
  getSyncRegistrySchema,
  getProjectedColumns,
  maybeQuoteIdentifier,
  quoteIdentifier,
  quoteSqlLiteral as quoteSqlStringLiteral,
  type SyncTableEntry,
  type SyncTableRegistry,
} from "@pgxsinkit/contracts";

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

/**
 * Local key/value metadata table. Holds the registry fingerprint the local store was
 * provisioned under (ADR-0006), so a registry change is detected on boot and the read
 * cache is rebuilt — rather than relying on a hand-bumped `idb://…-vN` suffix.
 */
export const LOCAL_META_TABLE = "pgxsinkit_local_meta";
export const REGISTRY_FINGERPRINT_KEY = "registry_fingerprint";

type TableColumn = ReturnType<typeof getProjectedColumns<AnyPgTable>>[number]["column"];

export function generateLocalSchemaSql<TRegistry extends SyncTableRegistry>(registry: TRegistry) {
  const statements: string[] = [];
  const localSchema = getSyncRegistrySchema(registry);

  if (localSchema !== "public") {
    statements.push(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(localSchema)};`);
  }

  statements.push(
    `CREATE TABLE IF NOT EXISTS ${qualifyIdentifier(localSchema, LOCAL_META_TABLE)} (\n  ${[
      "key TEXT PRIMARY KEY",
      "value TEXT NOT NULL",
    ].join(",\n  ")}\n);`,
  );

  const enumDefinitions = collectEnumDefinitions(registry, localSchema);

  for (const enumDefinition of enumDefinitions) {
    statements.push(buildCreateEnumTypeSql(enumDefinition));
  }

  for (const [tableKey, entry] of Object.entries(registry)) {
    // ADR-0021 §3: an `ephemeral` table's whole cluster is emitted as `TEMP` — bare (unqualified) object
    // names that resolve via `pg_temp` / search_path, so read- and write-ephemerality fall out together
    // (no durable trace). Object NAMES go bare+TEMP; column *types* (enums) stay in the persistent schema.
    // For a persistent table `temp` is "" and `objectSchema` is the registry schema → byte-identical output.
    const ephemeral = entry.retention === "ephemeral";
    const objectSchema = ephemeral ? "public" : localSchema;
    const temp = ephemeral ? "TEMP " : "";

    const projection = getClientProjection(entry, tableKey, objectSchema);
    const columns = getProjectedColumns(entry).map(({ column }) => column);
    const syncedTablePrimaryKeyColumns = getLocalSyncPrimaryKeyColumns(entry);
    const baseColumnsSql = buildTableColumnSql(columns, syncedTablePrimaryKeyColumns, localSchema);

    statements.push(`CREATE ${temp}TABLE IF NOT EXISTS ${projection.syncedTable} (\n  ${baseColumnsSql}\n);`);

    if (entry.mode === "readonly") {
      continue;
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
        // The registry fingerprint (ADR-0004) this mutation was authored under, so a
        // version-boundary crossing is known before sending (ADR-0006 decision 4).
        "registry_version TEXT",
        // ADR-0011 reserved hook: the Server version the entity was observed at when this mutation
        // was authored. The slot lives on the journal (per-mutation, like registry_version above);
        // the stale-write conflict policy (ADR-0015) decides its exact semantics and stamps it.
        "base_server_version BIGINT",
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

    statements.push(
      `CREATE INDEX IF NOT EXISTS ${baseProjection(entry, tableKey).journalTable}_status_idx ON ${projection.journalTable} (status, enqueued_at_us);`,
    );
    statements.push(
      `CREATE INDEX IF NOT EXISTS ${baseProjection(entry, tableKey).journalTable}_status_retry_idx ON ${projection.journalTable} (status, next_retry_at_us, enqueued_at_us);`,
    );
    statements.push(
      `CREATE INDEX IF NOT EXISTS ${baseProjection(entry, tableKey).journalTable}_pk_seq_idx ON ${projection.journalTable} (${entry.primaryKey.columns.join(", ")}, mutation_seq);`,
    );
    statements.push(
      `CREATE INDEX IF NOT EXISTS ${baseProjection(entry, tableKey).journalTable}_entity_seq_idx ON ${projection.journalTable} (entity_key_json, mutation_seq);`,
    );
    statements.push(
      `CREATE INDEX IF NOT EXISTS ${baseProjection(entry, tableKey).journalTable}_entity_status_seq_idx ON ${projection.journalTable} (entity_key_json, status, mutation_seq);`,
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
  }

  return `${statements.join("\n\n")}\n`;
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
  const enumDefinitionsByName = new Map<string, EnumDefinition>();

  for (const entry of Object.values(registry)) {
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
