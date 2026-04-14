import { getTableName, sql } from "drizzle-orm";
import type { AnyPgTable } from "drizzle-orm/pg-core";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { getColumns } from "drizzle-orm/utils";

import type { MutationEnvelope, RegistryTables, SyncTableEntry, SyncTableRegistry } from "@pgxsinkit/contracts";

import type { TransactionClient } from "./types";

const PG_TYPE_MAP: Record<string, string> = {
  PgUUID: "uuid",
  PgText: "text",
  PgVarchar: "varchar",
  PgChar: "char",
  PgInteger: "integer",
  PgSerial: "integer",
  PgSmallInt: "smallint",
  PgSmallIntNumber: "smallint",
  PgBigInt53: "bigint",
  PgBigInt64: "bigint",
  PgBigIntString: "bigint",
  PgBigSerial: "bigint",
  PgBoolean: "boolean",
  PgNumeric: "numeric",
  PgReal: "real",
  PgDoublePrecision: "double precision",
  PgTimestamp: "timestamptz",
  PgTimestampString: "timestamptz",
  PgDate: "date",
  PgDateString: "date",
  PgTime: "time",
  PgTimeString: "time",
  PgJson: "json",
  PgJsonb: "jsonb",
  PgBytea: "bytea",
  PgVector: "vector",
};

function drizzleColumnTypeToPg(columnType: string): string {
  return PG_TYPE_MAP[columnType] ?? "text";
}

function safeFunctionName(tableName: string): string {
  return tableName.toLowerCase().replace(/[^a-z0-9_]/g, "_");
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function buildPregeneratedFunctionDdl(entry: SyncTableEntry): string {
  const tableName = getTableName(entry.table as AnyPgTable);
  const fnName = `pgxsinkit_apply_${safeFunctionName(tableName)}_mutation`;
  const columns = getColumns(entry.table as AnyPgTable);
  const pkCol = entry.primaryKey.columns[0]!;
  const pkColObj = Object.values(columns).find((col) => col.name === pkCol);
  const pkType = drizzleColumnTypeToPg(pkColObj?.columnType ?? "PgText");

  const sqlLit = (s: string) => s.replace(/'/g, "''");

  const allColPairs = Object.values(columns)
    .map((col) => `('${sqlLit(col.name)}', '${sqlLit(drizzleColumnTypeToPg(col.columnType))}')`)
    .join(",\n      ");

  const nonPkColPairs = Object.values(columns)
    .filter((col) => col.name !== pkCol)
    .map((col) => `('${sqlLit(col.name)}', '${sqlLit(drizzleColumnTypeToPg(col.columnType))}')`)
    .join(",\n      ");

  const createFormatTpl = `INSERT INTO ${quoteIdent(tableName)} (%s) VALUES (%s)`.replace(/'/g, "''");
  const updateFormatTpl =
    `UPDATE ${quoteIdent(tableName)} SET %s WHERE ${quoteIdent(pkCol)} = ($2->>%L)::${pkType}`.replace(/'/g, "''");

  return `
CREATE OR REPLACE FUNCTION ${fnName}(p_op text, p_payload jsonb, p_entity_key jsonb) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  dml_sql text;
BEGIN
  IF p_op = 'create' THEN
    -- Only insert columns present in the payload; DB handles defaults for the rest.
    SELECT format(
      '${createFormatTpl}',
      string_agg(quote_ident(col_name), ', '),
      string_agg(format('($1->>%L)::%s', col_name, col_type), ', ')
    )
    INTO dml_sql
    FROM (VALUES
      ${allColPairs}
    ) AS t(col_name, col_type)
    WHERE p_payload ? col_name;

    IF dml_sql IS NOT NULL THEN
      EXECUTE dml_sql USING p_payload;
    END IF;

  ELSIF p_op = 'update' THEN
    -- Only update non-pk columns present in the payload; use entityKey for the WHERE.
    SELECT format(
      '${updateFormatTpl}',
      string_agg(format('%I = ($1->>%L)::%s', col_name, col_name, col_type), ', '),
      '${sqlLit(pkCol)}'
    )
    INTO dml_sql
    FROM (VALUES
      ${nonPkColPairs}
    ) AS t(col_name, col_type)
    WHERE p_payload ? col_name;

    IF dml_sql IS NOT NULL THEN
      EXECUTE dml_sql USING p_payload, p_entity_key;
    END IF;

  ELSIF p_op = 'delete' THEN
    DELETE FROM ${quoteIdent(tableName)} WHERE ${quoteIdent(pkCol)} = (p_entity_key->>'${sqlLit(pkCol)}')::${pkType};
  END IF;
END;
$$;
`.trim();
}

export async function installPregeneratedMutationFunctions<TRegistry extends SyncTableRegistry>(
  db: PostgresJsDatabase<RegistryTables<TRegistry>>,
  registry: TRegistry,
): Promise<void> {
  for (const [, entry] of Object.entries(registry)) {
    const ddl = buildPregeneratedFunctionDdl(entry as SyncTableEntry);
    await db.execute(sql.raw(ddl));
  }
}

export async function executePregeneratedMutation(tx: TransactionClient, mutation: MutationEnvelope): Promise<void> {
  const fnName = `pgxsinkit_apply_${safeFunctionName(mutation.tableName)}_mutation`;
  await tx.execute(
    sql`SELECT ${sql.raw(fnName)}(${mutation.kind}, ${JSON.stringify(mutation.payload)}::jsonb, ${JSON.stringify(mutation.entityKey)}::jsonb)`,
  );
}
