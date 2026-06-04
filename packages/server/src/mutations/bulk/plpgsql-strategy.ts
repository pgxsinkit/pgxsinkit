import { getTableName, sql } from "drizzle-orm";
import { getTableConfig, type AnyPgTable, type PgAsyncDatabase } from "drizzle-orm/pg-core";
import { getColumns } from "drizzle-orm/utils";

import {
  getProjectedColumns,
  type BatchMutationRequest,
  type RegistryRelations,
  type SyncTableEntry,
  type SyncTableRegistry,
} from "@pgxsinkit/contracts";

import type { TransactionClient } from "./types";

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function qualifyIdent(schemaName: string | undefined, name: string): string {
  if (!schemaName) {
    return quoteIdent(name);
  }

  return `${quoteIdent(schemaName)}.${quoteIdent(name)}`;
}

function toSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

function toSqlTextOrNull(value: string): string {
  return value.length > 0 ? `'${toSqlLiteral(value)}'` : "NULL";
}

function buildManagedFieldExpression(strategy: "authUid" | "nowMicroseconds"): string {
  if (strategy === "authUid") {
    return "auth.uid()";
  }

  return "CAST(FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000000) AS BIGINT)";
}

function getManagedFieldsForOperation(entry: SyncTableEntry, operation: "create" | "update") {
  const columns = getColumns(entry.table as AnyPgTable);
  const columnNameMap = new Map(Object.entries(columns).map(([propertyKey, column]) => [propertyKey, column.name]));

  return (entry.governance?.managedFields ?? []).flatMap((field) => {
    if (!field.applyOn.includes(operation)) {
      return [];
    }

    const columnName = columnNameMap.get(field.column);
    if (!columnName) {
      return [];
    }

    return [
      {
        propertyKey: field.column,
        columnName,
        strategy: field.strategy,
      },
    ];
  });
}

function buildTableBranch(entry: SyncTableEntry): string {
  const tableName = getTableName(entry.table as AnyPgTable);
  const { schema } = getTableConfig(entry.table as AnyPgTable);
  const qualifiedTableName = qualifyIdent(schema, tableName);
  const columns = getColumns(entry.table as AnyPgTable);
  const projectedColumns = getProjectedColumns(entry);
  const primaryKeyColumn = entry.primaryKey.columns[0]!;
  const primaryKeyColumnObject = Object.values(columns).find((column) => column.name === primaryKeyColumn);
  const primaryKeyType = primaryKeyColumnObject?.getSQLType() ?? "text";

  const createManagedFields = getManagedFieldsForOperation(entry, "create");
  const updateManagedFields = getManagedFieldsForOperation(entry, "update");
  const createManagedFieldNames = new Set(createManagedFields.map((field) => field.columnName));
  const updateManagedFieldNames = new Set(updateManagedFields.map((field) => field.columnName));

  const allColumnPairs = projectedColumns
    .map(({ column }) => column)
    .filter((column) => !createManagedFieldNames.has(column.name))
    .map((column) => `('${toSqlLiteral(column.name)}', '${toSqlLiteral(column.getSQLType())}')`)
    .join(",\n            ");

  const nonPrimaryKeyColumnPairs = projectedColumns
    .map(({ column }) => column)
    .filter((column) => column.name !== primaryKeyColumn && !updateManagedFieldNames.has(column.name))
    .map((column) => `('${toSqlLiteral(column.name)}', '${toSqlLiteral(column.getSQLType())}')`)
    .join(",\n            ");

  const createManagedColumnsSql = createManagedFields.map((field) => quoteIdent(field.columnName)).join(", ");
  const createManagedValuesSql = createManagedFields
    .map((field) => buildManagedFieldExpression(field.strategy))
    .join(", ");
  const updateManagedAssignmentsSql = updateManagedFields
    .map((field) => `${quoteIdent(field.columnName)} = ${buildManagedFieldExpression(field.strategy)}`)
    .join(", ");

  const createSqlTemplate = `INSERT INTO ${qualifiedTableName} (%s) VALUES (%s)`.replace(/'/g, "''");
  const updateSqlTemplate =
    `UPDATE ${qualifiedTableName} SET %s WHERE ${quoteIdent(primaryKeyColumn)} = ($2->>%L)::${primaryKeyType}`.replace(
      /'/g,
      "''",
    );

  const createBranch = `
        SELECT format(
          '${createSqlTemplate}',
          concat_ws(', ', nullif(string_agg(quote_ident(col_name), ', '), ''), ${toSqlTextOrNull(createManagedColumnsSql)}),
          concat_ws(', ', nullif(string_agg(format('($1->>%L)::%s', col_name, col_type), ', '), ''), ${toSqlTextOrNull(createManagedValuesSql)})
        )
        INTO dml_sql
        FROM (VALUES
            ${allColumnPairs}
        ) AS col_types(col_name, col_type)
        WHERE v_payload ? col_name;

        IF dml_sql IS NOT NULL THEN
          EXECUTE dml_sql USING v_payload;
        END IF;
      `.trim();

  const updateBranch = `
        SELECT format(
          '${updateSqlTemplate}',
          concat_ws(', ', nullif(string_agg(format('%I = ($1->>%L)::%s', col_name, col_name, col_type), ', '), ''), ${toSqlTextOrNull(updateManagedAssignmentsSql)}),
          '${toSqlLiteral(primaryKeyColumn)}'
        )
        INTO dml_sql
        FROM (VALUES
            ${nonPrimaryKeyColumnPairs}
        ) AS col_types(col_name, col_type)
        WHERE v_payload ? col_name;

        IF dml_sql IS NOT NULL THEN
          EXECUTE dml_sql USING v_payload, v_entity_key;
        END IF;
      `.trim();

  const deleteBranch = `
      DELETE FROM ${qualifiedTableName}
        WHERE ${quoteIdent(primaryKeyColumn)} = (v_entity_key->>'${toSqlLiteral(primaryKeyColumn)}')::${primaryKeyType};
      `.trim();

  return `
      ELSIF v_table = '${toSqlLiteral(tableName)}' THEN
        IF v_kind = 'create' THEN
          ${createBranch}
        ELSIF v_kind = 'update' THEN
          ${updateBranch}
        ELSIF v_kind = 'delete' THEN
          ${deleteBranch}
        ELSE
          RAISE EXCEPTION 'Unsupported mutation kind "%" for table "%"', v_kind, v_table;
        END IF;
    `.trim();
}

export function buildPlpgsqlBatchFunctionDdl(
  registry: SyncTableRegistry,
  options: {
    functionSchema?: string;
  } = {},
): string {
  const tableBranches = Object.values(registry)
    .map((entry) => buildTableBranch(entry as SyncTableEntry))
    .join("\n");
  const functionName = qualifyIdent(options.functionSchema, "pgxsinkit_apply_batch_mutations");

  return `
CREATE OR REPLACE FUNCTION ${functionName}(
  p_batch jsonb,
  p_request_path text,
  p_log_enabled boolean,
  p_rls_enabled boolean,
  p_user_claims jsonb
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  mutation jsonb;
  dml_sql text;
  v_table text;
  v_kind text;
  v_payload jsonb;
  v_entity_key jsonb;
  v_mutation_id text;
  v_mutation_seq integer;
  v_client_timestamp_us bigint;
  _claims jsonb;
  _target_role text;
BEGIN
  IF p_rls_enabled THEN
    _claims := COALESCE(p_user_claims, '{}'::jsonb);
    _target_role := COALESCE(NULLIF(_claims ->> 'role', ''), 'authenticated');
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = _target_role) THEN
        PERFORM set_config('role', _target_role, true);
      ELSIF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        PERFORM set_config('role', 'authenticated', true);
      END IF;
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    PERFORM set_config('request.jwt.claims', _claims::text, true);
    IF _claims ? 'sub' THEN
      PERFORM set_config('request.jwt.claim.sub', _claims ->> 'sub', true);
    END IF;
  END IF;

  IF jsonb_typeof(p_batch) <> 'object' THEN
    RAISE EXCEPTION 'Batch payload must be a JSON object';
  END IF;

  IF jsonb_typeof(p_batch->'mutations') <> 'array' THEN
    RAISE EXCEPTION 'Batch payload mutations must be a JSON array';
  END IF;

  FOR mutation IN SELECT value FROM jsonb_array_elements(p_batch->'mutations')
  LOOP
    dml_sql := NULL;
    v_table := mutation->>'tableName';
    v_kind := mutation->>'kind';
    v_payload := COALESCE(mutation->'payload', '{}'::jsonb);
    v_entity_key := COALESCE(mutation->'entityKey', '{}'::jsonb);
    v_mutation_id := mutation->>'mutationId';
    v_mutation_seq := (mutation->>'mutationSeq')::integer;
    v_client_timestamp_us := NULLIF(mutation->>'clientTimestampUs', '')::bigint;

    IF FALSE THEN
      NULL;
    ${tableBranches}
    ELSE
      RAISE EXCEPTION 'Unknown table "%" in batch mutation', v_table;
    END IF;

    IF p_log_enabled THEN
      INSERT INTO operations_log (
        source,
        backend,
        table_name,
        operation_kind,
        entity_key_json,
        payload_json,
        status,
        http_status,
        mutation_id,
        mutation_seq,
        client_timestamp_us,
        request_path,
        server_timestamp_us
      ) VALUES (
        'batch',
        'bulk-plpgsql',
        v_table,
        v_kind,
        v_entity_key,
        v_payload,
        'succeeded',
        200,
        v_mutation_id::uuid,
        v_mutation_seq,
        v_client_timestamp_us,
        p_request_path,
        CAST(FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000000) AS BIGINT)
      );
    END IF;
  END LOOP;
END;
$$;
`.trim();
}

export async function installPlpgsqlBatchFunction<TRegistry extends SyncTableRegistry>(
  db: PgAsyncDatabase<any, RegistryRelations<TRegistry>>,
  registry: TRegistry,
  options: {
    functionSchema?: string;
  } = {},
): Promise<void> {
  const ddl = buildPlpgsqlBatchFunctionDdl(registry, options);
  await db.execute(sql.raw(ddl));
}

type FunctionPresenceRow = {
  functionName: string | null;
};

export async function verifyPlpgsqlBatchFunction<TRegistry extends SyncTableRegistry>(
  db: PgAsyncDatabase<any, RegistryRelations<TRegistry>>,
  options: {
    functionSchema?: string;
  } = {},
): Promise<void> {
  const functionSignature = `${options.functionSchema ? `${options.functionSchema}.` : "public."}pgxsinkit_apply_batch_mutations(jsonb,text,boolean,boolean,jsonb)`;
  const result = await db.execute<FunctionPresenceRow>(sql`
    SELECT to_regprocedure(${functionSignature})::text AS "functionName"
  `);

  const row = Array.from(result, (entry) => entry as FunctionPresenceRow)[0];

  if (!row?.functionName) {
    throw new Error(
      "bulk-plpgsql-artifact backend requires preinstalled function pgxsinkit_apply_batch_mutations(jsonb,text,boolean,boolean,jsonb). Apply sync function migrations before starting the write API.",
    );
  }
}

type AuthHelperPresenceRow = {
  authUid: string | null;
};

export async function verifyArtifactRlsAuthHelpers<TRegistry extends SyncTableRegistry>(
  db: PgAsyncDatabase<any, RegistryRelations<TRegistry>>,
): Promise<void> {
  const result = await db.execute<AuthHelperPresenceRow>(sql`
    SELECT
      to_regprocedure('auth.uid()')::text AS "authUid"
  `);

  const row = Array.from(result, (entry) => entry as AuthHelperPresenceRow)[0];
  const missingHelpers = [row?.authUid ? null : "auth.uid()"].filter((value): value is string => value !== null);

  if (missingHelpers.length > 0) {
    throw new Error(
      `bulk-plpgsql-artifact backend requires Supabase auth helpers. Missing: ${missingHelpers.join(", ")}. ` +
        "Ensure auth.uid() is available (standard on Supabase-managed databases).",
    );
  }
}

export async function executePlpgsqlBatch(
  tx: TransactionClient,
  batch: BatchMutationRequest,
  requestPath: string,
  logEnabled: boolean,
  rlsEnabled: boolean,
  userClaims: Record<string, unknown>,
  options: {
    functionSchema?: string;
  } = {},
): Promise<void> {
  const normalizedClaims = userClaims ?? {};
  const functionName = qualifyIdent(options.functionSchema, "pgxsinkit_apply_batch_mutations");

  await tx.execute(
    sql`SELECT ${sql.raw(functionName)}(${JSON.stringify(batch)}::text::jsonb, ${requestPath}, ${logEnabled}, ${rlsEnabled}, ${JSON.stringify(normalizedClaims)}::text::jsonb)`,
  );
}
