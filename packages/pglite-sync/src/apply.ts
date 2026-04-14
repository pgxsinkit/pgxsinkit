import type { ChangeMessage } from "@electric-sql/client";
import type { PGliteInterface, Transaction } from "@electric-sql/pglite";

import type { MapColumns, InsertChangeMessage } from "./types";

export interface ApplyMessageToTableOptions {
  pg: PGliteInterface | Transaction;
  table: string;
  schema?: string | undefined;
  message: ChangeMessage<any>;
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
            INSERT INTO "${schema}"."${table}"
            (${columns.map((s) => '"' + s + '"').join(", ")})
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
            UPDATE "${schema}"."${table}"
            SET ${columns.map((column, i) => '"' + column + '" = $' + (i + 1)).join(", ")}
            WHERE ${primaryKey.map((column, i) => '"' + column + '" = $' + (columns.length + i + 1)).join(" AND ")}
          `,
        [...columns.map((column) => data[column]), ...primaryKey.map((column) => data[column])],
      );
    }

    case "delete": {
      if (debug) console.log("deleting", data);
      return await pg.query(
        `
            DELETE FROM "${schema}"."${table}"
            WHERE ${primaryKey.map((column, i) => '"' + column + '" = $' + (i + 1)).join(" AND ")}
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
  const data: Record<string, any>[] = messages.map((message) =>
    mapColumns ? doMapColumns(mapColumns, message) : message.value,
  );
  const firstRow = data[0];
  if (!firstRow) {
    return;
  }

  if (debug) console.log("inserting", data);
  const columns = Object.keys(firstRow);

  const getValueSize = (value: any): number => {
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
      default:
        if (value instanceof Date) return 8;
        return value?.toString()?.length || 0;
    }
  };

  const getRowSize = (row: Record<string, any>): number => {
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

  const executeBatch = async (batch: Record<string, any>[]) => {
    const upsertClause = buildUpsertClause(columns, primaryKey);
    const sql = `
      INSERT INTO "${schema}"."${table}"
      (${columns.map((s) => `"${s}"`).join(", ")})
      VALUES
      ${batch.map((_, j) => `(${columns.map((_v, k) => "$" + (j * columns.length + k + 1)).join(", ")})`).join(", ")}
      ${upsertClause}
    `;
    const values = batch.flatMap((message) => columns.map((column) => message[column]));
    await pg.query(sql, values);
  };

  let currentBatch: Record<string, any>[] = [];
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

export async function applyMessagesToTableWithJson({
  pg,
  table,
  schema = "public",
  messages,
  mapColumns,
  primaryKey,
  debug,
}: BulkApplyMessagesToTableOptions) {
  if (debug) console.log("applying messages with json_to_recordset");

  const data: Record<string, any>[] = messages.map((message) =>
    mapColumns ? doMapColumns(mapColumns, message) : message.value,
  );
  const firstRow = data[0];
  if (!firstRow) {
    return;
  }
  const columns = (
    await pg.query<{
      column_name: string;
      udt_name: string;
      data_type: string;
    }>(
      `
        SELECT column_name, udt_name, data_type
        FROM information_schema.columns
        WHERE table_name = $1 AND table_schema = $2
      `,
      [table, schema],
    )
  ).rows.filter((column) => Object.prototype.hasOwnProperty.call(firstRow, column.column_name));

  const max = 10_000;
  for (let i = 0; i < data.length; i += max) {
    const batch = data.slice(i, i + max);
    const upsertClause = buildUpsertClause(
      columns.map((column) => column.column_name),
      primaryKey,
    );
    await pg.query(
      `
        INSERT INTO "${schema}"."${table}"
        SELECT x.* from json_to_recordset($1) as x(${columns
          .map(
            (column) =>
              `${column.column_name} ${column.udt_name.replace(/^_/, "")}` + (column.data_type === "ARRAY" ? `[]` : ""),
          )
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

  const data: Record<string, any>[] = messages.map((message) =>
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
          if (typeof value === "string" && (value.includes(",") || value.includes('"') || value.includes("\n"))) {
            return `"${value.replace(/"/g, '""')}"`;
          }
          return value === null ? "\\N" : value;
        })
        .join(",");
    })
    .join("\n");

  const csvBlob = new Blob([csvData], { type: "text/csv" });

  await pg.query(
    `
      COPY "${schema}"."${table}" (${columns.map((column) => `"${column}"`).join(", ")})
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

function doMapColumns(mapColumns: MapColumns, message: ChangeMessage<any>): Record<string, any> {
  if (typeof mapColumns === "function") {
    return mapColumns(message);
  }

  const mappedColumns: Record<string, any> = {};
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
  const conflictTarget = primaryKey.map((column) => `"${column}"`).join(", ");

  if (nonPrimaryKeyColumns.length === 0) {
    return `ON CONFLICT (${conflictTarget}) DO NOTHING`;
  }

  return `ON CONFLICT (${conflictTarget}) DO UPDATE SET ${nonPrimaryKeyColumns
    .map((column) => `"${column}" = EXCLUDED."${column}"`)
    .join(", ")}`;
}
