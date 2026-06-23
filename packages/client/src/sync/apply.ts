import type { ChangeMessage, Row } from "@electric-sql/client";
import type { PGliteInterface, Transaction } from "@electric-sql/pglite";

import { quoteIdentifier, type SyncColumnType } from "@pgxsinkit/contracts";

import { generateCopyData } from "./copy";
import type { MapColumns, InsertChangeMessage } from "./types";

/** Schema-qualified, quoted table reference via the ADR-0004 shared identifier resolver. */
function qualifiedTable(schema: string, table: string): string {
  return `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
}

export interface ApplyMessageToTableOptions {
  pg: PGliteInterface | Transaction;
  table: string;
  schema?: string | undefined;
  message: ChangeMessage<Row<unknown>>;
  mapColumns?: MapColumns | undefined;
  primaryKey: string[];
  debug: boolean;
}

export async function applyMessageToTable({
  pg,
  table,
  schema = "public",
  message,
  mapColumns,
  primaryKey,
  debug,
}: ApplyMessageToTableOptions) {
  const data = mapColumns ? doMapColumns(mapColumns, message) : message.value;

  switch (message.headers.operation) {
    case "insert": {
      if (debug) console.log("inserting", data);
      const columns = Object.keys(data);
      // Apply exactly what Electric sent: an `insert` is a new row (post-truncate or first send), so
      // it is a plain INSERT. A genuine primary-key collision must surface, never be silently upserted.
      return await pg.query(
        `
            INSERT INTO ${qualifiedTable(schema, table)}
            (${columns.map((column) => quoteIdentifier(column)).join(", ")})
            VALUES
            (${columns.map((_v, i) => "$" + (i + 1)).join(", ")})
          `,
        columns.map((column) => data[column]),
      );
    }

    case "update": {
      if (debug) console.log("updating", data);
      const columns = Object.keys(data).filter((column) => !primaryKey.includes(column));
      if (columns.length === 0) return;
      return await pg.query(
        `
            UPDATE ${qualifiedTable(schema, table)}
            SET ${columns.map((column, i) => `${quoteIdentifier(column)} = $${i + 1}`).join(", ")}
            WHERE ${primaryKey.map((column, i) => `${quoteIdentifier(column)} = $${columns.length + i + 1}`).join(" AND ")}
          `,
        [...columns.map((column) => data[column]), ...primaryKey.map((column) => data[column])],
      );
    }

    case "delete": {
      if (debug) console.log("deleting", data);
      return await pg.query(
        `
            DELETE FROM ${qualifiedTable(schema, table)}
            WHERE ${primaryKey.map((column, i) => `${quoteIdentifier(column)} = $${i + 1}`).join(" AND ")}
          `,
        [...primaryKey.map((column) => data[column])],
      );
    }
  }
}

export interface BulkApplyMessagesToTableOptions {
  pg: PGliteInterface | Transaction;
  table: string;
  schema?: string | undefined;
  messages: InsertChangeMessage[];
  mapColumns?: MapColumns | undefined;
  primaryKey?: string[] | undefined;
  debug: boolean;
  /**
   * Statically-resolved column types (ADR-0009 decision 3). Consumed only by the `json` apply path,
   * which builds its `json_to_recordset` casts from them instead of querying `information_schema`.
   * Absent → the `json` path falls back to runtime introspection (the generic/legacy caller path).
   */
  columnTypes?: SyncColumnType[] | undefined;
}

export async function applyInsertsToTable({
  pg,
  table,
  schema = "public",
  messages,
  mapColumns,
  debug,
}: BulkApplyMessagesToTableOptions) {
  const data: Row<unknown>[] = messages.map((message) =>
    mapColumns ? doMapColumns(mapColumns, message) : message.value,
  );
  const firstRow = data[0];
  if (!firstRow) {
    return;
  }

  if (debug) console.log("inserting", data);
  const columns = Object.keys(firstRow);

  const getValueSize = (value: unknown): number => {
    if (value === null) return 0;
    if (value instanceof ArrayBuffer) return value.byteLength;
    if (value instanceof Blob) return value.size;
    if (value instanceof Uint8Array) return value.byteLength;
    if (value instanceof DataView) return value.byteLength;
    if (ArrayBuffer.isView(value)) return value.byteLength;

    switch (typeof value) {
      case "string":
        return value.length;
      case "number":
        return 8;
      case "boolean":
        return 1;
      case "bigint":
      case "symbol":
        return value.toString().length;
      case "function":
      case "undefined":
        return 0;
      default: {
        // Remaining typeof: object (null was handled above).
        if (value instanceof Date) return 8;
        try {
          return JSON.stringify(value)?.length ?? 0;
        } catch {
          // Non-serialisable nested value (e.g. bigint inside jsonb).
          return 16;
        }
      }
    }
  };

  const getRowSize = (row: Row<unknown>): number => {
    return columns.reduce((size, column) => {
      const value = row[column];
      if (value === null) return size;

      if (Array.isArray(value)) {
        if (value.length === 0) return size;
        const firstElement = value[0];

        switch (typeof firstElement) {
          case "number":
            return size + value.length * 8;
          case "string":
            return size + value.reduce((arrSize, str) => arrSize + str.length, 0);
          case "boolean":
            return size + value.length;
          default:
            if (firstElement instanceof Date) {
              return size + value.length * 8;
            }
            return size + value.reduce((arrSize, item) => arrSize + getValueSize(item), 0);
        }
      }

      return size + getValueSize(value);
    }, 0);
  };

  const maxParams = 32_000;
  const maxBytes = 50 * 1024 * 1024;

  const executeBatch = async (batch: Row<unknown>[]) => {
    const sql = `
      INSERT INTO ${qualifiedTable(schema, table)}
      (${columns.map((column) => quoteIdentifier(column)).join(", ")})
      VALUES
      ${batch.map((_, j) => `(${columns.map((_v, k) => "$" + (j * columns.length + k + 1)).join(", ")})`).join(", ")}
    `;
    const values = batch.flatMap((message) => columns.map((column) => message[column]));
    await pg.query(sql, values);
  };

  let currentBatch: Row<unknown>[] = [];
  let currentBatchSize = 0;
  let currentBatchParams = 0;

  for (const row of data) {
    const rowSize = getRowSize(row);
    const rowParams = columns.length;

    if (
      currentBatch.length > 0 &&
      (currentBatchSize + rowSize > maxBytes || currentBatchParams + rowParams > maxParams)
    ) {
      if (debug && currentBatchSize + rowSize > maxBytes) {
        console.log("batch size limit exceeded, executing batch");
      }
      if (debug && currentBatchParams + rowParams > maxParams) {
        console.log("batch params limit exceeded, executing batch");
      }
      await executeBatch(currentBatch);
      currentBatch = [];
      currentBatchSize = 0;
      currentBatchParams = 0;
    }

    currentBatch.push(row);
    currentBatchSize += rowSize;
    currentBatchParams += rowParams;
  }

  if (currentBatch.length > 0) {
    await executeBatch(currentBatch);
  }

  if (debug) console.log(`Inserted ${messages.length} rows using INSERT`);
}

/** A column's name plus the SQL type to cast it to inside a `json_to_recordset` record definition. */
interface JsonRecordsetColumn {
  name: string;
  castType: string;
}

/**
 * Resolves the `json_to_recordset` column casts for the rows being applied. Prefers the
 * statically-supplied {@link BulkApplyMessagesToTableOptions.columnTypes} (ADR-0009 decision 3 —
 * we own the types, no DB round-trip); falls back to an `information_schema` probe only when the
 * caller drove the engine without a registry. Either way it is narrowed to the columns actually
 * present in the synced row.
 */
async function resolveJsonRecordsetColumns(
  pg: PGliteInterface | Transaction,
  table: string,
  schema: string,
  firstRow: Row<unknown>,
  columnTypes: SyncColumnType[] | undefined,
): Promise<JsonRecordsetColumn[]> {
  const present = (name: string) => Object.prototype.hasOwnProperty.call(firstRow, name);

  if (columnTypes) {
    return columnTypes
      .filter((column) => present(column.name))
      .map((column) => ({ name: column.name, castType: `${column.sqlType}${column.isArray ? "[]" : ""}` }));
  }

  const rows = (
    await pg.query<{ column_name: string; udt_name: string; data_type: string }>(
      `
        SELECT column_name, udt_name, data_type
        FROM information_schema.columns
        WHERE table_name = $1 AND table_schema = $2
      `,
      [table, schema],
    )
  ).rows.filter((column) => present(column.column_name));

  return rows.map((column) => ({
    name: column.column_name,
    castType: `${column.udt_name.replace(/^_/, "")}${column.data_type === "ARRAY" ? "[]" : ""}`,
  }));
}

export async function applyMessagesToTableWithJson({
  pg,
  table,
  schema = "public",
  messages,
  mapColumns,
  columnTypes,
  debug,
}: BulkApplyMessagesToTableOptions) {
  if (debug) console.log("applying messages with json_to_recordset");

  const data: Row<unknown>[] = messages.map((message) =>
    mapColumns ? doMapColumns(mapColumns, message) : message.value,
  );
  const firstRow = data[0];
  if (!firstRow) {
    return;
  }
  const columns = await resolveJsonRecordsetColumns(pg, table, schema, firstRow, columnTypes);

  const max = 10_000;
  for (let i = 0; i < data.length; i += max) {
    const batch = data.slice(i, i + max);
    await pg.query(
      `
        INSERT INTO ${qualifiedTable(schema, table)}
        SELECT x.* from json_to_recordset($1) as x(${columns
          .map((column) => `${quoteIdentifier(column.name)} ${column.castType}`)
          .join(", ")})
      `,
      [batch],
    );
  }

  if (debug) {
    console.log(`Inserted ${messages.length} rows using json_to_recordset`);
  }
}

/**
 * Maps each column to its Postgres `udt_name` for the COPY serializer, which needs it only to
 * disambiguate `json`/`jsonb` (whose parsed values are indistinguishable from SQL arrays/objects by
 * runtime type alone). Prefers the registry-supplied {@link SyncColumnType}s (ADR-0009 decision 3 —
 * no DB round-trip); falls back to an `information_schema` probe for the registry-less generic caller.
 */
async function resolveCopyColumnUdts(
  pg: PGliteInterface | Transaction,
  table: string,
  schema: string,
  columnTypes: SyncColumnType[] | undefined,
): Promise<Record<string, string>> {
  if (columnTypes) {
    const map: Record<string, string> = {};
    for (const column of columnTypes) {
      const base = column.sqlType
        .replace(/\(.*\)/g, "")
        .trim()
        .toLowerCase();
      if (base === "json" || base === "jsonb") {
        map[column.name] = column.isArray ? `_${base}` : base;
      }
    }
    return map;
  }

  const rows = (
    await pg.query<{ column_name: string; udt_name: string }>(
      `
        SELECT column_name, udt_name
        FROM information_schema.columns
        WHERE table_name = $1 AND table_schema = $2
      `,
      [table, schema],
    )
  ).rows;
  return Object.fromEntries(rows.map((column) => [column.column_name, column.udt_name]));
}

export async function applyMessagesToTableWithCopy({
  pg,
  table,
  schema = "public",
  messages,
  mapColumns,
  columnTypes,
  debug,
}: BulkApplyMessagesToTableOptions) {
  if (debug) console.log("applying messages with COPY");

  const data: Row<unknown>[] = messages.map((message) =>
    mapColumns ? doMapColumns(mapColumns, message) : message.value,
  );
  const firstRow = data[0];
  if (!firstRow) {
    return;
  }
  const columns = Object.keys(firstRow);

  // Serialize rows using Postgres' own COPY TEXT format — a faithful port of the backend's
  // CopyAttributeOutText / array_out routines (see ./copy) — so arrays (incl. multi-dimensional),
  // json/jsonb, bytea, timestamps and strings with embedded delimiters/newlines all round-trip,
  // unlike the previous hand-rolled CSV encoder.
  const columnUdts = await resolveCopyColumnUdts(pg, table, schema, columnTypes);
  const copyData = generateCopyData(data, columns, columnUdts);
  const copyBlob = new Blob([copyData], { type: "text/plain" });

  // TEXT is the default COPY format; its default delimiter is a tab and NULL marker is `\N`, both of
  // which generateCopyData emits.
  await pg.query(
    `
      COPY ${qualifiedTable(schema, table)} (${columns.map((column) => quoteIdentifier(column)).join(", ")})
      FROM '/dev/blob'
      WITH (FORMAT text)
    `,
    [],
    {
      blob: copyBlob,
    },
  );

  if (debug) console.log(`Inserted ${messages.length} rows using COPY`);
}

export function doMapColumns(mapColumns: MapColumns, message: ChangeMessage<Row<unknown>>): Row<unknown> {
  if (typeof mapColumns === "function") {
    return mapColumns(message);
  }

  const mappedColumns: Row<unknown> = {};
  for (const [key, value] of Object.entries(mapColumns)) {
    mappedColumns[key] = message.value[value];
  }
  return mappedColumns;
}

const JSON_RECORDSET_BATCH = 10_000;

/**
 * Resolves the `json_to_recordset` casts for an **explicit, ordered** column list — the bulk
 * UPDATE/DELETE source relations need the PK columns (plus, for updates, the group's SET columns) in
 * a known order. Prefers the statically-supplied {@link SyncColumnType}s (ADR-0009 decision 3 — no DB
 * round-trip); falls back to an `information_schema` probe for the registry-less generic caller.
 */
async function recordsetColumnCasts(
  pg: PGliteInterface | Transaction,
  table: string,
  schema: string,
  columnNames: string[],
  columnTypes: SyncColumnType[] | undefined,
): Promise<JsonRecordsetColumn[]> {
  if (columnTypes) {
    const byName = new Map(columnTypes.map((column) => [column.name, column]));
    return columnNames.map((name) => {
      const column = byName.get(name);
      if (!column) {
        throw new Error(`recordsetColumnCasts: no registered type for column ${JSON.stringify(name)} on ${table}`);
      }
      return { name, castType: `${column.sqlType}${column.isArray ? "[]" : ""}` };
    });
  }

  const rows = (
    await pg.query<{ column_name: string; udt_name: string; data_type: string }>(
      `
        SELECT column_name, udt_name, data_type
        FROM information_schema.columns
        WHERE table_name = $1 AND table_schema = $2
      `,
      [table, schema],
    )
  ).rows;
  const byName = new Map(rows.map((column) => [column.column_name, column]));
  return columnNames.map((name) => {
    const column = byName.get(name);
    if (!column) {
      throw new Error(`recordsetColumnCasts: column ${JSON.stringify(name)} not found on ${schema}.${table}`);
    }
    return { name, castType: `${column.udt_name.replace(/^_/, "")}${column.data_type === "ARRAY" ? "[]" : ""}` };
  });
}

export interface BulkKeyedApplyOptions {
  pg: PGliteInterface | Transaction;
  table: string;
  schema?: string | undefined;
  /** Folded messages: for deletes the value carries the PK; for updates the PK plus merged columns. */
  messages: ChangeMessage<Row<unknown>>[];
  mapColumns?: MapColumns | undefined;
  primaryKey: string[];
  columnTypes?: SyncColumnType[] | undefined;
  debug: boolean;
}

/**
 * Bulk DELETE by primary key via `DELETE … USING json_to_recordset(…)` (ADR-0014 Phase 3). Safe
 * because the read-path fold already left **one row per PK** — no same-PK duplicate in the source.
 */
export async function applyBulkDeletesToTable({
  pg,
  table,
  schema = "public",
  messages,
  mapColumns,
  primaryKey,
  columnTypes,
  debug,
}: BulkKeyedApplyOptions) {
  if (primaryKey.length === 0) throw new Error("applyBulkDeletesToTable requires a primary key");
  if (messages.length === 0) return;

  const rows = messages.map((message) => {
    const data = mapColumns ? doMapColumns(mapColumns, message) : message.value;
    return Object.fromEntries(primaryKey.map((column) => [column, data[column]]));
  });

  const casts = await recordsetColumnCasts(pg, table, schema, primaryKey, columnTypes);
  const recordDef = casts.map((column) => `${quoteIdentifier(column.name)} ${column.castType}`).join(", ");
  const whereJoin = primaryKey
    .map((column) => `t.${quoteIdentifier(column)} = x.${quoteIdentifier(column)}`)
    .join(" AND ");

  for (let i = 0; i < rows.length; i += JSON_RECORDSET_BATCH) {
    const batch = rows.slice(i, i + JSON_RECORDSET_BATCH);
    await pg.query(
      `DELETE FROM ${qualifiedTable(schema, table)} AS t USING json_to_recordset($1) AS x(${recordDef}) WHERE ${whereJoin}`,
      [batch],
    );
  }

  if (debug) console.log(`Deleted ${messages.length} rows using json_to_recordset`);
}

/**
 * Bulk UPDATE via `UPDATE … FROM json_to_recordset(…)` (ADR-0014 Phase 3), **grouped by the set of
 * non-PK columns** each row carries. Electric's default replica sends only the changed columns, so
 * two rows in one batch can set different columns; one `UPDATE … FROM` per distinct column-set keeps
 * each statement uniform. Safe from the same-PK join hazard because the fold already left one row per
 * PK, so no PK appears twice within a group.
 */
export async function applyBulkUpdatesToTable({
  pg,
  table,
  schema = "public",
  messages,
  mapColumns,
  primaryKey,
  columnTypes,
  debug,
}: BulkKeyedApplyOptions) {
  if (primaryKey.length === 0) throw new Error("applyBulkUpdatesToTable requires a primary key");
  if (messages.length === 0) return;

  const pkSet = new Set(primaryKey);
  const groups = new Map<string, { setColumns: string[]; rows: Row<unknown>[] }>();
  for (const message of messages) {
    const data = mapColumns ? doMapColumns(mapColumns, message) : message.value;
    const setColumns = Object.keys(data)
      .filter((column) => !pkSet.has(column))
      .sort();
    // A PK-only update sets nothing — the per-row applyMessageToTable returns early on this too.
    if (setColumns.length === 0) continue;
    const groupKey = setColumns.join(" ");
    let group = groups.get(groupKey);
    if (!group) {
      group = { setColumns, rows: [] };
      groups.set(groupKey, group);
    }
    group.rows.push(Object.fromEntries([...primaryKey, ...setColumns].map((column) => [column, data[column]])));
  }

  for (const { setColumns, rows } of groups.values()) {
    const casts = await recordsetColumnCasts(pg, table, schema, [...primaryKey, ...setColumns], columnTypes);
    const recordDef = casts.map((column) => `${quoteIdentifier(column.name)} ${column.castType}`).join(", ");
    const setClause = setColumns
      .map((column) => `${quoteIdentifier(column)} = x.${quoteIdentifier(column)}`)
      .join(", ");
    const whereJoin = primaryKey
      .map((column) => `t.${quoteIdentifier(column)} = x.${quoteIdentifier(column)}`)
      .join(" AND ");

    for (let i = 0; i < rows.length; i += JSON_RECORDSET_BATCH) {
      const batch = rows.slice(i, i + JSON_RECORDSET_BATCH);
      await pg.query(
        `UPDATE ${qualifiedTable(schema, table)} AS t SET ${setClause} FROM json_to_recordset($1) AS x(${recordDef}) WHERE ${whereJoin}`,
        [batch],
      );
    }
  }

  if (debug) console.log(`Updated ${messages.length} rows using json_to_recordset`);
}
