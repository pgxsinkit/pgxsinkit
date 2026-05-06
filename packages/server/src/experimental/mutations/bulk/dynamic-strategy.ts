import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import type { MutationEnvelope, RegistryRelations, SyncTableRegistry } from "@pgxsinkit/contracts";

import type { TransactionClient } from "./types";

const DYNAMIC_MUTATION_FUNCTION_DDL = `
CREATE OR REPLACE FUNCTION pgxsinkit_apply_mutation(
  p_table      text,
  p_op         text,
  p_payload    jsonb,
  p_entity_key jsonb,
  p_pk_col     text
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  dml_sql text;
  pk_udt  text;
BEGIN
  IF p_op = 'create' THEN
    -- Insert only the columns present in the payload; DB handles defaults for the rest.
    SELECT format(
      'INSERT INTO %I (%s) VALUES (%s)',
      p_table,
      string_agg(quote_ident(c.column_name), ', '),
      string_agg(format('($1->>%L)::%s', c.column_name, c.udt_name), ', ')
    )
    INTO dml_sql
    FROM information_schema.columns c
    WHERE c.table_schema = 'public'
      AND c.table_name   = p_table
      AND (p_payload ? c.column_name);

    IF dml_sql IS NOT NULL THEN
      EXECUTE dml_sql USING p_payload;
    END IF;

  ELSIF p_op = 'update' THEN
    SELECT udt_name INTO pk_udt
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = p_table
      AND column_name  = p_pk_col;

    -- Update only the non-pk columns present in the payload; use entityKey for the WHERE.
    SELECT format(
      'UPDATE %I SET %s WHERE %I = ($2->>%L)::%s',
      p_table,
      string_agg(format('%I = ($1->>%L)::%s', c.column_name, c.column_name, c.udt_name), ', '),
      p_pk_col, p_pk_col, pk_udt
    )
    INTO dml_sql
    FROM information_schema.columns c
    WHERE c.table_schema = 'public'
      AND c.table_name   = p_table
      AND c.column_name  <> p_pk_col
      AND (p_payload ? c.column_name);

    IF dml_sql IS NOT NULL THEN
      EXECUTE dml_sql USING p_payload, p_entity_key;
    END IF;

  ELSIF p_op = 'delete' THEN
    SELECT udt_name INTO pk_udt
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = p_table
      AND column_name  = p_pk_col;

    EXECUTE format('DELETE FROM %I WHERE %I = ($1->>%L)::%s', p_table, p_pk_col, p_pk_col, pk_udt)
      USING p_entity_key;
  END IF;
END;
$$;
`.trim();

export async function installDynamicMutationFunction<TRegistry extends SyncTableRegistry>(
  db: PostgresJsDatabase<RegistryRelations<TRegistry>>,
): Promise<void> {
  await db.execute(sql.raw(DYNAMIC_MUTATION_FUNCTION_DDL));
}

export async function executeDynamicMutation(
  tx: TransactionClient,
  mutation: MutationEnvelope,
  primaryKeyColumnName: string,
): Promise<void> {
  await tx.execute(
    sql`SELECT pgxsinkit_apply_mutation(${mutation.tableName}, ${mutation.kind}, ${JSON.stringify(mutation.payload)}::jsonb, ${JSON.stringify(mutation.entityKey)}::jsonb, ${primaryKeyColumnName})`,
  );
}
