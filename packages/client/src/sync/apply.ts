import type { ChangeMessage, Row } from "@electric-sql/client";
import type { PGliteInterface, Transaction } from "@electric-sql/pglite";

import { quoteIdentifier, type SyncColumnType } from "@pgxsinkit/contracts";

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
      const upsertClause = buildUpsertClause(columns, primaryKey);
      return await pg.query(
        `
            INSERT INTO ${qualifiedTable(schema, table)}
            (${columns.map((column) => quoteIdentifier(column)).join(", ")})
            VALUES
            (${columns.map((_v, i) => "$" + (i + 1)).join(", ")})
            ${upsertClause}
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
  primaryKey,
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
    const upsertClause = buildUpsertClause(columns, primaryKey);
    const sql = `
      INSERT INTO ${qualifiedTable(schema, table)}
      (${columns.map((column) => quoteIdentifier(column)).join(", ")})
      VALUES
      ${batch.map((_, j) => `(${columns.map((_v, k) => "$" + (j * columns.length + k + 1)).join(", ")})`).join(", ")}
      ${upsertClause}
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
  primaryKey,
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
    const upsertClause = buildUpsertClause(
      columns.map((column) => column.name),
      primaryKey,
    );
    await pg.query(
      `
        INSERT INTO ${qualifiedTable(schema, table)}
        SELECT x.* from json_to_recordset($1) as x(${columns
          .map((column) => `${quoteIdentifier(column.name)} ${column.castType}`)
          .join(", ")})
        ${upsertClause}
      `,
      [batch],
    );
  }

  if (debug) {
    console.log(`Inserted ${messages.length} rows using json_to_recordset`);
  }
}

export async function applyMessagesToTableWithCopy({
  pg,
  table,
  schema = "public",
  messages,
  mapColumns,
  primaryKey,
  debug,
}: BulkApplyMessagesToTableOptions) {
  if (debug) console.log("applying messages with COPY");

  if (primaryKey && primaryKey.length > 0) {
    await applyInsertsToTable({
      pg,
      table,
      schema,
      messages,
      mapColumns,
      primaryKey,
      debug,
    });
    return;
  }

  const data: Row<unknown>[] = messages.map((message) =>
    mapColumns ? doMapColumns(mapColumns, message) : message.value,
  );
  const firstRow = data[0];
  if (!firstRow) {
    return;
  }
  const columns = Object.keys(firstRow);

  const csvData = data
    .map((message) => {
      return columns
        .map((column) => {
          const value = message[column];
          if (value === null) {
            return "\\N";
          }
          // jsonb values arrive as parsed objects; COPY expects their json text.
          const text =
            typeof value === "string"
              ? value
              : typeof value === "number" || typeof value === "boolean" || typeof value === "bigint"
                ? value.toString()
                : (JSON.stringify(value) ?? "\\N");
          if (text.includes(",") || text.includes('"') || text.includes("\n")) {
            return `"${text.replace(/"/g, '""')}"`;
          }
          return text;
        })
        .join(",");
    })
    .join("\n");

  const csvBlob = new Blob([csvData], { type: "text/csv" });

  await pg.query(
    `
      COPY ${qualifiedTable(schema, table)} (${columns.map((column) => quoteIdentifier(column)).join(", ")})
      FROM '/dev/blob'
      WITH (FORMAT csv, NULL '\\N')
    `,
    [],
    {
      blob: csvBlob,
    },
  );

  if (debug) console.log(`Inserted ${messages.length} rows using COPY`);
}

function doMapColumns(mapColumns: MapColumns, message: ChangeMessage<Row<unknown>>): Row<unknown> {
  if (typeof mapColumns === "function") {
    return mapColumns(message);
  }

  const mappedColumns: Row<unknown> = {};
  for (const [key, value] of Object.entries(mapColumns)) {
    mappedColumns[key] = message.value[value];
  }
  return mappedColumns;
}

function buildUpsertClause(columns: string[], primaryKey: string[] | undefined): string {
  if (!primaryKey || primaryKey.length === 0) {
    return "";
  }

  const nonPrimaryKeyColumns = columns.filter((column) => !primaryKey.includes(column));
  const conflictTarget = primaryKey.map((column) => quoteIdentifier(column)).join(", ");

  if (nonPrimaryKeyColumns.length === 0) {
    return `ON CONFLICT (${conflictTarget}) DO NOTHING`;
  }

  return `ON CONFLICT (${conflictTarget}) DO UPDATE SET ${nonPrimaryKeyColumns
    .map((column) => `${quoteIdentifier(column)} = EXCLUDED.${quoteIdentifier(column)}`)
    .join(", ")}`;
}
