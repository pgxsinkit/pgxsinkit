import { getTableName, sql } from "drizzle-orm";
import { getTableConfig, type AnyPgTable, type PgAsyncDatabase, type PgQueryResultHKT } from "drizzle-orm/pg-core";
import { getColumns } from "drizzle-orm/utils";

import {
  CLOCK_US_CALL_SQL_TEXT,
  escapeSqlLiteral as toSqlLiteral,
  getProjectedColumns,
  hashString,
  quoteIdentifier as quoteIdent,
  resolveServerVersionColumnName,
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

interface ResolvedManagedField {
  propertyKey: string;
  columnName: string;
  strategy: "nowMicroseconds" | "authClaim";
  claimPath?: string[];
  cast?: string;
  columnSqlType: string;
}

// The single claim-stamping strategy (ADR-0026): `authClaim` reads the verified request claim at its JSON
// path — `auth.uid()` is just `{ claimPath: ["sub"], cast: "uuid" }`, so there is one mechanism. The path
// segments are validated plain identifiers at registry build, so the `'{a,b}'` text-array literal is
// injection-safe; `current_setting('request.jwt.claims', …)` is set by this function before the apply DML
// (it is what RLS reads), NULLIF guards an unset GUC (an absent claim stamps NULL, never errors), and the
// cast defaults to the target column's own SQL type so a `uuid` column needs no explicit cast.
function buildManagedFieldExpression(field: ResolvedManagedField): string {
  if (field.strategy === "authClaim") {
    const path = (field.claimPath ?? []).join(",");
    const castType = field.cast ?? field.columnSqlType;
    return `(NULLIF(current_setting('request.jwt.claims', true), '')::jsonb #>> '{${path}}')::${castType}`;
  }

  // Call the canonical microsecond-clock DB function, never inline the expression. The rendered
  // artifact therefore DEPENDS on the utilities function (public.pgxsinkit_clock_us()): the utilities
  // migration (renderPgxsinkitUtilitiesMigration) must precede this artifact in any consumer's chain.
  // The ADR-0030 fingerprint recomputes from this rendered text, so a change to the call form is
  // coordinated through the normal regenerate-and-commit flow.
  return CLOCK_US_CALL_SQL_TEXT;
}

function getManagedFieldsForOperation(entry: SyncTableEntry, operation: "create" | "update"): ResolvedManagedField[] {
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

    const column =
      (columns as Record<string, { getSQLType: () => string } | undefined>)[field.column] ??
      Object.values(columns).find((candidate) => candidate.name === field.column);

    return [
      {
        propertyKey: field.column,
        columnName,
        strategy: field.strategy,
        ...(field.claimPath ? { claimPath: field.claimPath } : {}),
        ...(field.cast ? { cast: field.cast } : {}),
        columnSqlType: column?.getSQLType() ?? "text",
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
    if (!columnObject) {
      // Hard error, not a silent `text` fallback: an unmatched PK column means the primaryKey spec
      // has drifted from the table (e.g. a rename) — a generated applier keyed on a mistyped tuple
      // would mis-match rows at apply time.
      throw new Error(
        `plpgsql apply generator: primary key column ${columnName} not found on table ${tableName}; ` +
          `the entry's primaryKey spec has drifted from its Drizzle table`,
      );
    }
    return { name: columnName, type: columnObject.getSQLType() };
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
  const createManagedValuesSql = createManagedFields.map((field) => buildManagedFieldExpression(field)).join(", ");
  // ADR-0010: the Server version (the nowMicroseconds-on-update managed field) must be strictly
  // monotonic per row, so its on-update stamp is floored at the previous value + 1 — it can never
  // repeat or step backwards under wall-clock (NTP) skew, which would let a stale echo clear an
  // optimistic write early. The bare column on the RHS of an UPDATE SET is the pre-update value.
  const serverVersionColumn = resolveServerVersionColumnName(entry);
  const updateManagedAssignmentsSql = updateManagedFields
    .map((field) => {
      const expression =
        field.strategy === "nowMicroseconds" && field.columnName === serverVersionColumn
          ? `GREATEST(${buildManagedFieldExpression(field)}, ${quoteIdent(field.columnName)} + 1)`
          : buildManagedFieldExpression(field);
      return `${quoteIdent(field.columnName)} = ${expression}`;
    })
    .join(", ");

  // Set-based apply (ADR-0014 Phase 4): one statement per (table, kind, payload column-set) group,
  // over the group's rows materialised by jsonb_to_recordset. The PK match spans the full tuple
  // (ADR-0012): DELETE matches the recordset's typed PK columns directly; UPDATE matches each row's
  // entity key carried as `x.k` jsonb. Safe from the same-PK `UPDATE … FROM` join hazard because the
  // Per-entity flush serialization invariant leaves at most one mutation per entity in a batch.
  const pkRecordDef = primaryKeyColumns.map((pk) => `${quoteIdent(pk.name)} ${pk.type}`).join(", ");
  const pkDeleteJoin = primaryKeyColumns
    .map((pk) => `t.${quoteIdent(pk.name)} = x.${quoteIdent(pk.name)}`)
    .join(" AND ");
  const pkUpdateJoin = primaryKeyColumns
    .map((pk) => `t.${quoteIdent(pk.name)} = (x.k->>'${toSqlLiteral(pk.name)}')::${pk.type}`)
    .join(" AND ");

  // Templates the runtime format() fills with the per-group column list. Single quotes are doubled
  // because these are embedded as PL/pgSQL string literals.
  const insertTemplate =
    `INSERT INTO ${qualifiedTableName} (%s) SELECT %s FROM jsonb_to_recordset($1) AS x(p jsonb)`.replace(/'/g, "''");
  const updateTemplate =
    `UPDATE ${qualifiedTableName} AS t SET %s FROM jsonb_to_recordset($1) AS x(p jsonb, k jsonb) WHERE ${pkUpdateJoin}`.replace(
      /'/g,
      "''",
    );
  const deleteSql =
    `DELETE FROM ${qualifiedTableName} AS t USING jsonb_to_recordset($1) AS x(${pkRecordDef}) WHERE ${pkDeleteJoin}`.replace(
      /'/g,
      "''",
    );

  // The create/update column fragments come from the group signature (∩ writable columns) plus the
  // static managed fields. An empty intersection ⇒ NULL fragment ⇒ a managed-only statement (the
  // Server version still bumps on a PK-only update, exactly as the per-mutation path did).
  const createColumnSelect = allColumnPairs.length
    ? `SELECT
          string_agg(quote_ident(col_name), ', ' ORDER BY col_name),
          string_agg(format('(x.p->>%L)::%s', col_name, col_type), ', ' ORDER BY col_name)
        INTO v_cols, v_vals
        FROM (VALUES
            ${allColumnPairs}
        ) AS col_types(col_name, col_type)
        WHERE col_name = ANY(string_to_array(v_sig, ','));`
    : `v_cols := NULL; v_vals := NULL;`;

  const updateSetSelect = nonPrimaryKeyColumnPairs.length
    ? `SELECT string_agg(format('%I = (x.p->>%L)::%s', col_name, col_name, col_type), ', ' ORDER BY col_name)
        INTO v_set
        FROM (VALUES
            ${nonPrimaryKeyColumnPairs}
        ) AS col_types(col_name, col_type)
        WHERE col_name = ANY(string_to_array(v_sig, ','));`
    : `v_set := NULL;`;

  const createBranch = `
        ${createColumnSelect}

        dml_sql := format(
          '${insertTemplate}',
          concat_ws(', ', nullif(v_cols, ''), ${toSqlTextOrNull(createManagedColumnsSql)}),
          concat_ws(', ', nullif(v_vals, ''), ${toSqlTextOrNull(createManagedValuesSql)})
        );
        EXECUTE dml_sql USING (
          SELECT COALESCE(jsonb_agg(jsonb_build_object('p', COALESCE(elem->'payload', '{}'::jsonb))), '[]'::jsonb)
          FROM jsonb_array_elements(v_rows) AS elem
        );
      `.trim();

  // ADR-0015: a `reject-if-stale` table compares each targeted row's current Server version to the
  // mutation's Base server version (`x.b`). `current > base` ⇒ stale (an external write interleaved):
  // the row is NOT applied, and the conflict (mutation id + the row's current Server version) is
  // collected for the handler to turn into a `conflicted` ack. `last-write-wins` keeps today's apply
  // (now a named choice). The policy is known here at DDL-generation time, so each table emits the SQL
  // its policy needs; a create has no base (its conflict is a PK collision), so it is unchanged.
  // #6: an UPDATE whose target row is MISSING (deleted by another writer after authoring) is also a
  // conflict ('target row no longer exists', `currentServerVersion` NULL) — otherwise the edit would
  // silently no-op and ack as success. A DELETE of a missing row stays idempotent success (the user
  // wanted it gone), so the delete branch keeps its inner join and does not report missing targets.
  const serverVersionRef = serverVersionColumn ? quoteIdent(serverVersionColumn) : null;
  const rejectIfStale = entry.conflictPolicy === "reject-if-stale" && serverVersionRef != null;
  // For the missing-target conflict (ADR-0015 #6): a LEFT JOIN whose right side is absent leaves the
  // first PK column NULL. The Server version is NOT NULL on any existing writable row, so a NULL
  // `currentServerVersion` in a returned conflict means exactly "the target row no longer exists".
  const firstPkRef = quoteIdent(primaryKeyColumns[0]!.name);

  // The conflict-collect SELECT and the staleness guard need the base + mutation id alongside each
  // row, so reject-if-stale carries them in the recordset (`b bigint, m text`). The mutation id is
  // `text` (not `uuid`): a derived child envelope's id is a composite non-UUID string, and a `m uuid`
  // recordset column would raise 22P02 the moment such a write is stale.
  const conflictObjectSql = (alias: string) =>
    `jsonb_build_object('mutationId', ${alias}.m, 'tableName', '${toSqlLiteral(tableName)}', 'currentServerVersion', t.${serverVersionRef})`;

  const updateBranch = rejectIfStale
    ? `
        ${updateSetSelect}

        EXECUTE '${`SELECT COALESCE(jsonb_agg(${conflictObjectSql("x")}), '[]'::jsonb) FROM jsonb_to_recordset($1) AS x(p jsonb, k jsonb, b bigint, m text) LEFT JOIN ${qualifiedTableName} AS t ON ${pkUpdateJoin} WHERE t.${firstPkRef} IS NULL OR (x.b IS NOT NULL AND t.${serverVersionRef} > x.b)`.replace(/'/g, "''")}'
          INTO v_group_conflicts
          USING (
            SELECT COALESCE(jsonb_agg(jsonb_build_object('p', COALESCE(elem->'payload', '{}'::jsonb), 'k', COALESCE(elem->'entityKey', '{}'::jsonb), 'b', (elem->>'baseServerVersion')::bigint, 'm', elem->>'mutationId')), '[]'::jsonb)
            FROM jsonb_array_elements(v_rows) AS elem
          );
        v_conflicts := v_conflicts || v_group_conflicts;

        dml_sql := format(
          '${`UPDATE ${qualifiedTableName} AS t SET %s FROM jsonb_to_recordset($1) AS x(p jsonb, k jsonb, b bigint, m text) WHERE ${pkUpdateJoin} AND (x.b IS NULL OR t.${serverVersionRef} <= x.b)`.replace(/'/g, "''")}',
          concat_ws(', ', nullif(v_set, ''), ${toSqlTextOrNull(updateManagedAssignmentsSql)})
        );
        EXECUTE dml_sql USING (
          SELECT COALESCE(jsonb_agg(jsonb_build_object('p', COALESCE(elem->'payload', '{}'::jsonb), 'k', COALESCE(elem->'entityKey', '{}'::jsonb), 'b', (elem->>'baseServerVersion')::bigint, 'm', elem->>'mutationId')), '[]'::jsonb)
          FROM jsonb_array_elements(v_rows) AS elem
        );
      `.trim()
    : `
        ${updateSetSelect}

        dml_sql := format(
          '${updateTemplate}',
          concat_ws(', ', nullif(v_set, ''), ${toSqlTextOrNull(updateManagedAssignmentsSql)})
        );
        EXECUTE dml_sql USING (
          SELECT COALESCE(jsonb_agg(jsonb_build_object('p', COALESCE(elem->'payload', '{}'::jsonb), 'k', COALESCE(elem->'entityKey', '{}'::jsonb))), '[]'::jsonb)
          FROM jsonb_array_elements(v_rows) AS elem
        );
      `.trim();

  const deleteBranch = rejectIfStale
    ? `
        EXECUTE '${`SELECT COALESCE(jsonb_agg(${conflictObjectSql("x")}), '[]'::jsonb) FROM jsonb_to_recordset($1) AS x(${pkRecordDef}, b bigint, m text) JOIN ${qualifiedTableName} AS t ON ${pkDeleteJoin} WHERE x.b IS NOT NULL AND t.${serverVersionRef} > x.b`.replace(/'/g, "''")}'
          INTO v_group_conflicts
          USING (
            SELECT COALESCE(jsonb_agg(COALESCE(elem->'entityKey', '{}'::jsonb) || jsonb_build_object('b', (elem->>'baseServerVersion')::bigint, 'm', elem->>'mutationId')), '[]'::jsonb)
            FROM jsonb_array_elements(v_rows) AS elem
          );
        v_conflicts := v_conflicts || v_group_conflicts;

        EXECUTE '${`DELETE FROM ${qualifiedTableName} AS t USING jsonb_to_recordset($1) AS x(${pkRecordDef}, b bigint, m text) WHERE ${pkDeleteJoin} AND (x.b IS NULL OR t.${serverVersionRef} <= x.b)`.replace(/'/g, "''")}' USING (
          SELECT COALESCE(jsonb_agg(COALESCE(elem->'entityKey', '{}'::jsonb) || jsonb_build_object('b', (elem->>'baseServerVersion')::bigint, 'm', elem->>'mutationId')), '[]'::jsonb)
          FROM jsonb_array_elements(v_rows) AS elem
        );
      `.trim()
    : `
        EXECUTE '${deleteSql}' USING (
          SELECT COALESCE(jsonb_agg(elem->'entityKey'), '[]'::jsonb)
          FROM jsonb_array_elements(v_rows) AS elem
        );
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

const APPLY_FUNCTION_NAME = "pgxsinkit_apply_mutations";
// ADR-0030: the trailing `text` is `p_expected_fingerprint` — the running server passes the fingerprint
// it expects for its registry + codegen, and the function verifies itself against its stamped comment
// before touching any table.
const APPLY_FUNCTION_ARG_TYPES = "jsonb, text, boolean, boolean, jsonb, text";
// ADR-0018: the prefix namespaces the strict fingerprint format. Any absent or different prefix is
// an identity mismatch and the apply function refuses the write.
const APPLY_FINGERPRINT_PREFIX = "pgxsinkit:fp1:";

function buildApplyFunctionBody(
  registry: SyncTableRegistry,
  options: {
    functionSchema?: string;
  } = {},
): string {
  const tableBranches = Object.values(registry)
    // A read projection (ADR-0027) owns no writable table — its `table` IS the owner's, so the owner's
    // branch already handles that physical table. Emitting a branch for the projection too would
    // DUPLICATE the owner's table branch (same table name). Read projections are readonly and never
    // reach the write path, so exclude them from the apply function entirely.
    .filter((entry) => !(entry as SyncTableEntry).readProjection)
    .map((entry) => buildTableBranch(entry as SyncTableEntry))
    .join("\n");
  const functionName = qualifyIdent(options.functionSchema, APPLY_FUNCTION_NAME);

  return `
-- Install idempotently by dropping the current signature first. PostgreSQL cannot change a function's
-- return type through CREATE OR REPLACE, while a generated artifact must install its complete definition.
--
-- TWO-TIER MUTATION-ID INVARIANT. \`mutation_id\` is TEXT here (RETURNS TABLE + operations_log), not
-- uuid, so this apply function can serve a DIRECT server-side caller that derives child envelopes with
-- composite non-UUID ids (\`\${parentId}:<tag>:<n>\`). That is the ONLY non-UUID path. pgxsinkit's public
-- surface — the HTTP route's request/ack schemas and the client's \`mutation_id UUID\` journal — stays
-- UUID-only (see packages/contracts/src/mutation.ts): the route validates every request id as a UUID and
-- builds every ack from that request id, never from the TEXT conflict rows this returns. A non-UUID id
-- therefore never crosses into the UUID-typed surface.
--
DROP FUNCTION IF EXISTS ${functionName}(${APPLY_FUNCTION_ARG_TYPES});

CREATE OR REPLACE FUNCTION ${functionName}(
  p_batch jsonb,
  p_request_path text,
  p_log_enabled boolean,
  p_rls_enabled boolean,
  p_user_claims jsonb,
  p_expected_fingerprint text
) RETURNS TABLE(mutation_id text, table_name text, current_server_version bigint) LANGUAGE plpgsql AS $$
DECLARE
  dml_sql text;
  v_table text;
  v_kind text;
  v_sig text;
  v_rows jsonb;
  v_cols text;
  v_vals text;
  v_set text;
  -- ADR-0015: stale-write conflicts collected across the batch (mutationId + the row's current
  -- Server version), returned to the handler which turns them into 'conflicted' acks.
  v_conflicts jsonb := '[]'::jsonb;
  v_group_conflicts jsonb;
  -- ADR-0030: the fingerprint this installed function was stamped with (its own ADR-0018 comment),
  -- read back once for the self-verification gate below.
  _installed_fingerprint text;
  _claims jsonb;
  _target_role text;
  _previous_role text;
  _previous_claims text;
  _previous_claim_sub text;
BEGIN
  -- ADR-0030: the apply function verifies ITSELF against its ADR-0018 fingerprint comment before it
  -- touches any table. p_expected_fingerprint is what the running server expects for its registry +
  -- codegen; obj_description(...) is the fingerprint this installed function was stamped with, atomically,
  -- by the same migration. A mismatch — INCLUDING an absent comment (an unstamped hand-installed
  -- function ⇒ NULL, refused per ADR-0030) — means the installed function is stale relative to the caller,
  -- so raise SQLSTATE 'PXS01' and apply nothing. The check IS the call (no read-then-call TOCTOU) and
  -- costs no extra round trip (the argument rides the existing invocation; the comparison is one text
  -- equality). The signature literal is embedded, never the fingerprint hash itself — baking the hash
  -- into the body would be circular with the hash-of-body the fingerprint is.
  _installed_fingerprint := obj_description('${functionName}(${APPLY_FUNCTION_ARG_TYPES})'::regprocedure, 'pg_proc');
  IF p_expected_fingerprint IS DISTINCT FROM _installed_fingerprint THEN
    RAISE EXCEPTION 'pgxsinkit_apply_mutations is stale: the installed apply-function fingerprint (%) does not match the fingerprint this server expects (%). Regenerate the sync-function migration (pgxsinkit-generate) and apply it before serving writes.', COALESCE(_installed_fingerprint, '(none)'), p_expected_fingerprint
      USING ERRCODE = 'PXS01';
  END IF;

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

  -- Group the batch by (table, kind, payload column-set) and apply each group with one statement
  -- (ADR-0014 Phase 4). mutationSeq is table-local, so it cannot order groups across tables: parent
  -- and child journals can both start at 1. WITH ORDINALITY preserves the submitted JSON array order
  -- across tables (FK-safe; the batch transaction also runs SET CONSTRAINTS ALL DEFERRED).
  FOR v_table, v_kind, v_sig, v_rows IN
    SELECT
      grouped.table_name,
      grouped.kind,
      grouped.sig,
      jsonb_agg(grouped.mutation ORDER BY grouped.batch_position)
    FROM (
      SELECT
        entries.m->>'tableName' AS table_name,
        entries.m->>'kind' AS kind,
        COALESCE((
          SELECT string_agg(payload_key, ',' ORDER BY payload_key)
          FROM jsonb_object_keys(COALESCE(entries.m->'payload', '{}'::jsonb)) AS payload_key
        ), '') AS sig,
        entries.m AS mutation,
        entries.batch_position
      FROM jsonb_array_elements(p_batch->'mutations') WITH ORDINALITY AS entries(m, batch_position)
    ) AS grouped
    GROUP BY grouped.table_name, grouped.kind, grouped.sig
    ORDER BY MIN(grouped.batch_position)
  LOOP
    dml_sql := NULL;
    v_cols := NULL;
    v_vals := NULL;
    v_set := NULL;

    IF FALSE THEN
      NULL;
    ${tableBranches}
    ELSE
      RAISE EXCEPTION 'Unknown table "%" in batch mutation', v_table;
    END IF;
  END LOOP;

  IF p_log_enabled THEN
    -- One batched log insert (the whole batch is a single transaction, so a per-mutation loop
    -- bought nothing): a runtime apply failure above rolls the whole transaction back, log rows
    -- included, preserving the existing whole-batch-failure semantics.
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
    )
    SELECT
      m->>'tableName',
      m->>'kind',
      COALESCE(m->'entityKey', '{}'::jsonb),
      COALESCE(m->'payload', '{}'::jsonb),
      'succeeded',
      200,
      -- mutation_id is text: a derived child envelope carries a composite non-UUID id
      -- (parent-id + tag + index), so no ::uuid cast (it would raise 22P02 on such an id).
      m->>'mutationId',
      (m->>'mutationSeq')::integer,
      NULLIF(m->>'clientTimestampUs', '')::bigint,
      p_request_path,
      -- The canonical microsecond clock (utilities migration); never the inline expression.
      ${CLOCK_US_CALL_SQL_TEXT}
    FROM jsonb_array_elements(p_batch->'mutations') AS m;
  END IF;

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

  -- ADR-0015: return the collected stale-write conflicts. Empty under last-write-wins (or when no
  -- write was stale), so the handler simply acks everything as today.
  RETURN QUERY
  SELECT
    -- mutation_id is text (see RETURNS TABLE): a stale derived child envelope's id is a composite
    -- non-UUID string, so return it verbatim — a ::uuid cast here would raise 22P02 and abort the batch.
    c->>'mutationId',
    c->>'tableName',
    (c->>'currentServerVersion')::bigint
  FROM jsonb_array_elements(v_conflicts) AS c;
END;
$$;
`.trim();
}

/**
 * The fingerprint the installed apply function should carry for this registry + applier codegen
 * (ADR-0018). It is a hash of the exact generated DDL body, so it shifts on any registry-shape
 * change AND on any change to how the applier emits SQL (e.g. a @pgxsinkit/server upgrade) — the
 * two drift classes a bare signature check cannot see. It does NOT depend on TS-side row-filter /
 * customWhere logic, which never enters the apply function (that shapes the read proxy, not writes).
 */
export function expectedApplyFingerprint(
  registry: SyncTableRegistry,
  options: {
    functionSchema?: string;
  } = {},
): string {
  return APPLY_FINGERPRINT_PREFIX + hashString(buildApplyFunctionBody(registry, options));
}

export function buildPlpgsqlBatchFunctionDdl(
  registry: SyncTableRegistry,
  options: {
    functionSchema?: string;
  } = {},
): string {
  const body = buildApplyFunctionBody(registry, options);
  const functionName = qualifyIdent(options.functionSchema, APPLY_FUNCTION_NAME);
  const fingerprint = APPLY_FINGERPRINT_PREFIX + hashString(body);

  // ADR-0018: stamp the function with the fingerprint of this exact DDL body. Stored as a COMMENT
  // because it is function-scoped, replaced atomically with the function, and read back in one line
  // via obj_description — so the server (startup) and CI (pre-deploy) can both detect a function
  // that is stale relative to the registry + codegen it is meant to serve.
  return `${body}\n\nCOMMENT ON FUNCTION ${functionName}(${APPLY_FUNCTION_ARG_TYPES}) IS '${fingerprint}';`;
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

/**
 * A conflict the applier rejected under `reject-if-stale` (ADR-0015): either a **stale** write (the
 * Base server version the row has since advanced past — `currentServerVersion` is the row's current
 * version) or an UPDATE whose **target row is missing** (deleted by another writer —
 * `currentServerVersion` is `null`, the #6 discriminator). The handler surfaces it on the
 * `conflicted` ack.
 */
export interface MutationConflict {
  mutationId: string;
  tableName: string;
  currentServerVersion: string | null;
}

interface MutationConflictRow {
  mutationId: string | null;
  tableName: string | null;
  currentServerVersion: string | null;
}

export async function executePlpgsqlBatch(
  tx: TransactionClient,
  batch: BatchMutationRequest,
  requestPath: string,
  logEnabled: boolean,
  rlsEnabled: boolean,
  userClaims: Record<string, unknown>,
  // ADR-0030: the fingerprint the running server expects for its registry + codegen
  // (`expectedApplyFingerprint(registry)`, computed once per server instance). The installed apply
  // function compares it against its own stamped comment and raises SQLSTATE 'PXS01' on a mismatch —
  // in-body, atomic with the call, before it touches any table.
  expectedFingerprint: string,
  options: {
    functionSchema?: string;
  } = {},
): Promise<MutationConflict[]> {
  const normalizedClaims = userClaims ?? {};
  // Typed identifier interpolation (never `sql.raw` of a hand-quoted name); the OUT-column aliases
  // are the generated function's fixed names.
  const functionRef = options.functionSchema
    ? sql`${sql.identifier(options.functionSchema)}.${sql.identifier("pgxsinkit_apply_mutations")}`
    : sql`${sql.identifier("pgxsinkit_apply_mutations")}`;

  // The applier RETURNS the stale-write conflicts (ADR-0015). Read them from the function's result
  // set; an empty set (the last-write-wins case, or nothing stale) means every mutation applied.
  const result = await tx.execute(
    sql`SELECT "mutation_id"::text AS "mutationId", "table_name" AS "tableName", "current_server_version"::text AS "currentServerVersion" FROM ${functionRef}(${JSON.stringify(batch)}::text::jsonb, ${requestPath}, ${logEnabled}, ${rlsEnabled}, ${JSON.stringify(normalizedClaims)}::text::jsonb, ${expectedFingerprint})`,
  );

  const rows = Array.from(result as Iterable<unknown>, (row) => row as MutationConflictRow);
  return rows.flatMap((row) =>
    row.mutationId != null
      ? [
          {
            mutationId: row.mutationId,
            tableName: row.tableName ?? "",
            currentServerVersion: row.currentServerVersion,
          } satisfies MutationConflict,
        ]
      : [],
  );
}
