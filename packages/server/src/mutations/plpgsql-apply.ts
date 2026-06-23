import { getTableName, sql } from "drizzle-orm";
import { getTableConfig, type AnyPgTable, type PgAsyncDatabase, type PgQueryResultHKT } from "drizzle-orm/pg-core";
import { getColumns } from "drizzle-orm/utils";

import {
  escapeSqlLiteral as toSqlLiteral,
  getProjectedColumns,
  quoteIdentifier as quoteIdent,
  type BatchMutationRequest,
  type RegistryRelations,
  type SyncTableEntry,
  type SyncTableRegistry,
} from "@pgxsinkit/contracts";

import type { TransactionClient } from "./types";

function qualifyIdent(schemaName: string | undefined, name: string): string {
  if (!schemaName) {
    return quoteIdent(name);
  }

  return `${quoteIdent(schemaName)}.${quoteIdent(name)}`;
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
  // The canonical Entity identity is the full server primary-key tuple, by column name with
  // typed values (ADR-0012): the applier matches update/delete over EVERY pk column. Keying on
  // only the first column (the old `columns[0]`) matched too many rows on a composite-PK table.
  const primaryKeyColumns = entry.primaryKey.columns.map((columnName) => {
    const columnObject = Object.values(columns).find((column) => column.name === columnName);
    return { name: columnName, type: columnObject?.getSQLType() ?? "text" };
  });
  const primaryKeyColumnNames = new Set(primaryKeyColumns.map((pk) => pk.name));

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
    .filter((column) => !primaryKeyColumnNames.has(column.name) && !updateManagedFieldNames.has(column.name))
    .map((column) => `('${toSqlLiteral(column.name)}', '${toSqlLiteral(column.getSQLType())}')`)
    .join(",\n            ");

  const createManagedColumnsSql = createManagedFields.map((field) => quoteIdent(field.columnName)).join(", ");
  const createManagedValuesSql = createManagedFields
    .map((field) => buildManagedFieldExpression(field.strategy))
    .join(", ");
  const updateManagedAssignmentsSql = updateManagedFields
    .map((field) => `${quoteIdent(field.columnName)} = ${buildManagedFieldExpression(field.strategy)}`)
    .join(", ");

  // WHERE over the full pk tuple. v_entity_key (EXECUTE arg $2) is column-keyed (ADR-0012), so
  // each pk column reads `$2->>'<columnName>'` with its own registry-derived cast. The pk names
  // and types are static, so the predicate is inlined (its single quotes are doubled by the
  // template's `.replace` below); only the per-column value extraction is runtime.
  const updateWhereClause = primaryKeyColumns
    .map((pk) => `${quoteIdent(pk.name)} = ($2->>'${toSqlLiteral(pk.name)}')::${pk.type}`)
    .join(" AND ");
  const deleteWhereClause = primaryKeyColumns
    .map((pk) => `${quoteIdent(pk.name)} = (v_entity_key->>'${toSqlLiteral(pk.name)}')::${pk.type}`)
    .join(" AND ");

  const createSqlTemplate = `INSERT INTO ${qualifiedTableName} (%s) VALUES (%s)`.replace(/'/g, "''");
  const updateSqlTemplate = `UPDATE ${qualifiedTableName} SET %s WHERE ${updateWhereClause}`.replace(/'/g, "''");

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
          concat_ws(', ', nullif(string_agg(format('%I = ($1->>%L)::%s', col_name, col_name, col_type), ', '), ''), ${toSqlTextOrNull(updateManagedAssignmentsSql)})
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
        WHERE ${deleteWhereClause};
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
  const functionName = qualifyIdent(options.functionSchema, "pgxsinkit_apply_mutations");

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
  _previous_role text;
  _previous_claims text;
  _previous_claim_sub text;
BEGIN
  IF p_rls_enabled THEN
    -- Capture the caller's role/claims before switching into the RLS actor context, so the
    -- batch does not leak that context into the rest of the caller's transaction. The HTTP
    -- route RESET ROLEs after calling this function, but in-transaction callers cannot —
    -- restoring here leaves every caller exactly as it was found.
    _previous_role := current_setting('role', true);
    _previous_claims := current_setting('request.jwt.claims', true);
    _previous_claim_sub := current_setting('request.jwt.claim.sub', true);
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

  IF p_rls_enabled THEN
    -- Restore the caller's prior role/claims captured above, so the RLS context applied for
    -- the batch does not persist into subsequent statements of the caller's transaction.
    BEGIN
      PERFORM set_config('role', COALESCE(NULLIF(_previous_role, ''), 'none'), true);
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    PERFORM set_config('request.jwt.claims', COALESCE(_previous_claims, ''), true);
    PERFORM set_config('request.jwt.claim.sub', COALESCE(_previous_claim_sub, ''), true);
  END IF;
END;
$$;
`.trim();
}

export async function installPlpgsqlBatchFunction<TRegistry extends SyncTableRegistry>(
  db: PgAsyncDatabase<PgQueryResultHKT, RegistryRelations<TRegistry>>,
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
  db: PgAsyncDatabase<PgQueryResultHKT, RegistryRelations<TRegistry>>,
  options: {
    functionSchema?: string;
  } = {},
): Promise<void> {
  const functionSignature = `${options.functionSchema ? `${options.functionSchema}.` : "public."}pgxsinkit_apply_mutations(jsonb,text,boolean,boolean,jsonb)`;
  const result = await db.execute<FunctionPresenceRow>(sql`
    SELECT to_regprocedure(${functionSignature})::text AS "functionName"
  `);

  const row = Array.from(result as Iterable<unknown>, (entry) => entry as FunctionPresenceRow)[0];

  if (!row?.functionName) {
    throw new Error(
      "The write path requires the preinstalled function pgxsinkit_apply_mutations(jsonb,text,boolean,boolean,jsonb). Apply sync function migrations before starting the write API.",
    );
  }
}

type AuthHelperPresenceRow = {
  authUid: string | null;
};

export async function verifyRlsAuthHelpers<TRegistry extends SyncTableRegistry>(
  db: PgAsyncDatabase<PgQueryResultHKT, RegistryRelations<TRegistry>>,
): Promise<void> {
  const result = await db.execute<AuthHelperPresenceRow>(sql`
    SELECT
      to_regprocedure('auth.uid()')::text AS "authUid"
  `);

  const row = Array.from(result as Iterable<unknown>, (entry) => entry as AuthHelperPresenceRow)[0];
  const missingHelpers = [row?.authUid ? null : "auth.uid()"].filter((value): value is string => value !== null);

  if (missingHelpers.length > 0) {
    throw new Error(
      `The write path requires Supabase auth helpers. Missing: ${missingHelpers.join(", ")}. ` +
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
  const functionName = qualifyIdent(options.functionSchema, "pgxsinkit_apply_mutations");

  await tx.execute(
    sql`SELECT ${sql.raw(functionName)}(${JSON.stringify(batch)}::text::jsonb, ${requestPath}, ${logEnabled}, ${rlsEnabled}, ${JSON.stringify(normalizedClaims)}::text::jsonb)`,
  );
}
