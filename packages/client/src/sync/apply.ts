// Started life as a copy of @electric-sql/pglite-sync (Apache-2.0, © ElectricSQL — see NOTICE).
// Fully internalized (ADR-0009); upstream compatibility is an explicit anti-goal (ADR-0028) — evolve freely.
import type { ChangeMessage, Row } from "@electric-sql/client";
import type { PGliteInterface, Transaction } from "@electric-sql/pglite";
import { and, eq, fillPlaceholders, type SQL, sql } from "drizzle-orm";
import { getTableConfig, type PgColumn } from "drizzle-orm/pg-core";

import { quoteIdentifier, type SyncColumnType } from "@pgxsinkit/contracts";

import type { ApplyTarget } from "../local-tables";
import { generateCopyData } from "./copy";
import { drizzleOverPg } from "./drizzle-executor";
import type { InsertChangeMessage } from "./types";

/**
 * Re-key an Electric change row (keyed by DB **column name**) to the Drizzle **property keys** the
 * query builder addresses columns by (ADR-0029 D1). A column absent from the local projected table is a
 * config error and surfaces, rather than silently binding to nothing.
 */
function toDriverRow(target: ApplyTarget, data: Row<unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const name of Object.keys(data)) {
    const propertyKey = target.propertyKeyByName[name];
    if (propertyKey === undefined) {
      throw new Error(`sync apply: column ${JSON.stringify(name)} is not present on the local synced table`);
    }
    out[propertyKey] = data[name];
  }
  return out;
}

/** The `PgColumn` for a DB column name on the target table (for `eq`/conflict-target/COPY clauses). */
function targetColumn(target: ApplyTarget, name: string): PgColumn {
  const column = target.columnByName[name];
  if (!column) {
    throw new Error(`sync apply: column ${JSON.stringify(name)} not found on the local synced table`);
  }
  return column;
}

/**
 * True when any of `colNames` is a GENERATED ALWAYS identity column on the target table. Drizzle-orm's
 * insert builder EXCLUDES a generated-always identity column from the rendered INSERT even when the value
 * is supplied (its type error points at `.overridingSystemValue()`), so a plain `.values()` would silently
 * drop such a column — fatal for a GENERATED ALWAYS identity PK (the synced row loses its key and dies on
 * NOT NULL). Detected from the Drizzle column metadata (`generatedIdentity.type === "always"`, mirroring
 * drizzle's own `shouldDisableInsert`). `byDefault` identity is deliberately NOT matched: drizzle already
 * renders those, so the OVERRIDING clause is neither needed nor wanted for them.
 */
function hasGeneratedIdentityColumn(target: ApplyTarget, colNames: readonly string[]): boolean {
  return colNames.some((name) => {
    const column = target.columnByName[name] as (PgColumn & { generatedIdentity?: { type?: string } }) | undefined;
    return column?.generatedIdentity !== undefined && column.generatedIdentity.type !== "byDefault";
  });
}

/**
 * `db.insert(target.table)`, upgraded to `INSERT … OVERRIDING SYSTEM VALUE` when the applied columns carry
 * a GENERATED ALWAYS identity column ({@link hasGeneratedIdentityColumn}). For a synced cache the SERVER's
 * identity values are authoritative — the local row must carry the server id verbatim, never a
 * locally-generated one — so OVERRIDING SYSTEM VALUE is the semantically correct clause (and it makes
 * drizzle re-include the column it would otherwise drop). Tables without a generated column get a plain
 * insert, so the clause is emitted only where it is required. (The local synced table renders the identity
 * PK as a PLAIN column — the generator emits `getSQLType()` with no identity clause — and PGlite accepts
 * OVERRIDING SYSTEM VALUE against a plain column as a no-op, so this is safe there too.)
 */
function insertInto(db: ReturnType<typeof drizzleOverPg>, target: ApplyTarget, colNames: readonly string[]) {
  const builder = db.insert(target.table);
  return hasGeneratedIdentityColumn(target, colNames) ? builder.overridingSystemValue() : builder;
}

/**
 * The SQL cast type for a synced column inside a `json_to_recordset` record definition (or a `::` cast).
 * A base/array type is used verbatim ({@link SyncColumnType} contracts `sqlType` to be cast-usable); an
 * ENUM column's `sqlType` is the enum TYPE NAME — a user identifier — so it must be identifier-quoted (an
 * unquoted mixed-case enum name folds to lowercase and fails to resolve) and schema-qualified into the
 * SAME schema the local-schema generator creates the enum in (the synced table's own schema), so the cast
 * resolves without depending on search_path. `[]` is appended for an array column, as for base types.
 */
function castTypeFor(column: SyncColumnType, tableSchema: string | undefined): string {
  const base = column.isEnum
    ? tableSchema
      ? `${quoteIdentifier(tableSchema)}.${quoteIdentifier(column.sqlType)}`
      : quoteIdentifier(column.sqlType)
    : column.sqlType;
  return `${base}${column.isArray ? "[]" : ""}`;
}

export interface ApplyMessageToTableOptions {
  pg: PGliteInterface | Transaction;
  target: ApplyTarget;
  message: ChangeMessage<Row<unknown>>;
  debug: boolean;
}

export async function applyMessageToTable({ pg, target, message, debug }: ApplyMessageToTableOptions) {
  const data = message.value;
  const db = drizzleOverPg(pg);

  switch (message.headers.operation) {
    case "insert": {
      if (debug) console.log("inserting", data);
      const columns = Object.keys(data);
      const insert = insertInto(db, target, columns).values(toDriverRow(target, data) as never);
      if (target.applyMode === "upsert") {
        // ADR-0045 declared exception: this table legitimately receives locally-derived provisional rows
        // (e.g. written by a local trigger), so the server's authoritative CDC insert is applied
        // idempotently — same semantics as `applyUpsertsToTable` — rather than colliding on the pk.
        const { conflictTarget, conflictSet, nonPkColumns } = upsertConflictSpec(target, columns);
        if (nonPkColumns.length > 0) {
          return await insert.onConflictDoUpdate({ target: conflictTarget, set: conflictSet as never });
        }
        // Target the pk explicitly so a pk-only conflict is a no-op ONLY on the primary key.
        return await insert.onConflictDoNothing({ target: conflictTarget });
      }
      // Default (`applyMode: "insert"`): apply exactly what Electric sent as a plain INSERT — an `insert`
      // is a new row (post-truncate or first send). A genuine primary-key collision must surface, never
      // be silently upserted (ADR-0014), UNLESS the table declared `applyMode: "upsert"` (handled above).
      // `insertInto` adds OVERRIDING SYSTEM VALUE when the row carries a GENERATED ALWAYS identity column,
      // so the server's authoritative id is preserved rather than silently dropped by the builder.
      return await insert;
    }

    case "update": {
      if (debug) console.log("updating", data);
      const setColumns = Object.keys(data).filter((column) => !target.primaryKey.includes(column));
      if (setColumns.length === 0) return;
      const setValues: Record<string, unknown> = {};
      for (const column of setColumns) setValues[target.propertyKeyByName[column]!] = data[column];
      return await db
        .update(target.table)
        .set(setValues as never)
        .where(and(...target.primaryKey.map((column) => eq(targetColumn(target, column), data[column]))));
    }

    case "delete": {
      if (debug) console.log("deleting", data);
      return await db
        .delete(target.table)
        .where(and(...target.primaryKey.map((column) => eq(targetColumn(target, column), data[column]))));
    }
  }
}

export interface BulkApplyMessagesToTableOptions {
  pg: PGliteInterface | Transaction;
  target: ApplyTarget;
  messages: InsertChangeMessage[];
  debug: boolean;
}

const MAX_INSERT_PARAMS = 32_000;
const MAX_INSERT_BYTES = 50 * 1024 * 1024;

/**
 * The rendered `{sqlText, params}` for a batched INSERT of `rowCount` rows over `colNames` (ADR-0029
 * D5's render-once remedy). Rendered ONCE per distinct (column-set, row-count) via a placeholder INSERT
 * over the real table, then reused for every batch of that shape — driving the per-row × per-column
 * builder-AST cost to zero. `sql.placeholder` cells make Drizzle emit `$n` markers without applying a
 * codec at render time; the codec is applied per value at execution (see {@link executeInsertBatch}).
 */
function renderInsert(
  db: ReturnType<typeof drizzleOverPg>,
  target: ApplyTarget,
  colNames: string[],
  rowCount: number,
): { sqlText: string; params: unknown[] } {
  const key = JSON.stringify([rowCount, colNames]);
  const cached = target.insertRenderCache.get(key);
  if (cached) return cached;
  const placeholderRows = Array.from({ length: rowCount }, (_, r) =>
    Object.fromEntries(colNames.map((name, ci) => [target.propertyKeyByName[name]!, sql.placeholder(`${r}_${ci}`)])),
  );
  const rendered = insertInto(db, target, colNames)
    .values(placeholderRows as never)
    .toSQL();
  const value = { sqlText: rendered.sql, params: rendered.params as unknown[] };
  target.insertRenderCache.set(key, value);
  return value;
}

/**
 * Execute one rendered batch: fill the render-once placeholders with this batch's values, applying the
 * real per-column codec (`fillPlaceholders` runs each column's `mapToDriverValue`, with a null guard —
 * byte-identical to a plain `.values()` bind), then run the pre-rendered statement on the executor.
 */
async function executeInsertBatch(
  pg: PGliteInterface | Transaction,
  db: ReturnType<typeof drizzleOverPg>,
  target: ApplyTarget,
  colNames: string[],
  batch: Row<unknown>[],
): Promise<void> {
  const rendered = renderInsert(db, target, colNames, batch.length);
  const values: Record<string, unknown> = {};
  for (let r = 0; r < batch.length; r++) {
    const row = batch[r]!;
    for (let ci = 0; ci < colNames.length; ci++) {
      values[`${r}_${ci}`] = row[colNames[ci]!];
    }
  }
  const flat = fillPlaceholders(rendered.params, values);
  await pg.query(rendered.sqlText, flat as unknown[]);
}

function getValueSize(value: unknown): number {
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
}

function getRowSize(row: Row<unknown>, columns: readonly string[]): number {
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
}

export async function applyInsertsToTable({ pg, target, messages, debug }: BulkApplyMessagesToTableOptions) {
  const data: Row<unknown>[] = messages.map((message) => message.value);
  const firstRow = data[0];
  if (!firstRow) {
    return;
  }

  if (debug) console.log("inserting", data);
  const columns = Object.keys(firstRow);
  const db = drizzleOverPg(pg);

  let currentBatch: Row<unknown>[] = [];
  let currentBatchSize = 0;
  let currentBatchParams = 0;

  for (const row of data) {
    const rowSize = getRowSize(row, columns);
    const rowParams = columns.length;

    if (
      currentBatch.length > 0 &&
      (currentBatchSize + rowSize > MAX_INSERT_BYTES || currentBatchParams + rowParams > MAX_INSERT_PARAMS)
    ) {
      if (debug && currentBatchSize + rowSize > MAX_INSERT_BYTES) {
        console.log("batch size limit exceeded, executing batch");
      }
      if (debug && currentBatchParams + rowParams > MAX_INSERT_PARAMS) {
        console.log("batch params limit exceeded, executing batch");
      }
      await executeInsertBatch(pg, db, target, columns, currentBatch);
      currentBatch = [];
      currentBatchSize = 0;
      currentBatchParams = 0;
    }

    currentBatch.push(row);
    currentBatchSize += rowSize;
    currentBatchParams += rowParams;
  }

  if (currentBatch.length > 0) {
    await executeInsertBatch(pg, db, target, columns, currentBatch);
  }

  if (debug) console.log(`Inserted ${messages.length} rows using INSERT`);
}

/**
 * The `ON CONFLICT (pk)` upsert spec for a keyed apply — shared by {@link applyUpsertsToTable} (ADR-0024
 * move-ins / snapshot-acceptance) and the per-message `applyMode: "upsert"` CDC-insert path (ADR-0045),
 * so the two can never drift on conflict semantics. The conflict target is the primary-key columns; the
 * conflict SET refreshes every non-pk column to `excluded.<col>` (the standard conflict pseudo-relation,
 * authored via `sql.identifier` so the column stays a quoted BARE identifier, not table-qualified). A
 * pk-only table yields an empty `nonPkColumns` — the caller then uses `DO NOTHING` targeted at the pk
 * (never a bare `ON CONFLICT DO NOTHING`, which would swallow conflicts on any unique constraint).
 */
function upsertConflictSpec(
  target: ApplyTarget,
  columns: readonly string[],
): { conflictTarget: PgColumn[]; conflictSet: Record<string, unknown>; nonPkColumns: string[] } {
  const pkSet = new Set(target.primaryKey);
  const nonPkColumns = columns.filter((column) => !pkSet.has(column));
  const conflictTarget = target.primaryKey.map((column) => targetColumn(target, column));
  const conflictSet: Record<string, unknown> = {};
  for (const column of nonPkColumns) {
    conflictSet[target.propertyKeyByName[column]!] = sql`excluded.${sql.identifier(column)}`;
  }
  return { conflictTarget, conflictSet, nonPkColumns };
}

/**
 * Bulk **upsert** for tagged-subquery move-in rows (ADR-0024). A move-in is an existing row ENTERING the
 * shape — unlike a CDC `insert` (a brand-new row) it may already be present locally via an independent
 * grant, or be re-delivered on a resume from before the move-in's offset. So it is applied idempotently:
 * `INSERT … ON CONFLICT (pk) DO UPDATE` refreshes to the move-in's authoritative value (or `DO NOTHING`
 * for a pk-only table). The plain-`INSERT` invariant of the CDC path — a genuine PK collision must
 * surface ({@link applyInsertsToTable}) — is intentionally NOT used here, because for a move-in a present
 * row is expected, not a bug. Batched by parameter count (move-in volume is incremental, not a backfill).
 */
export async function applyUpsertsToTable({ pg, target, messages, debug }: BulkKeyedApplyOptions) {
  const primaryKey = target.primaryKey;
  if (primaryKey.length === 0) throw new Error("applyUpsertsToTable requires a primary key");

  const data: Row<unknown>[] = messages.map((message) => message.value);
  const firstRow = data[0];
  if (!firstRow) return;

  const columns = Object.keys(firstRow);
  const { conflictTarget, conflictSet, nonPkColumns } = upsertConflictSpec(target, columns);

  const perRow = columns.length;
  const rowsPerBatch = Math.max(1, Math.floor(MAX_INSERT_PARAMS / perRow));
  const db = drizzleOverPg(pg);

  for (let i = 0; i < data.length; i += rowsPerBatch) {
    const batch = data.slice(i, i + rowsPerBatch).map((row) => toDriverRow(target, row));
    // A move-in row carries the server's authoritative values incl. any GENERATED ALWAYS identity PK, so
    // `insertInto` adds OVERRIDING SYSTEM VALUE where needed (same hazard as the CDC/bulk insert paths).
    const insert = insertInto(db, target, columns).values(batch as never);
    if (nonPkColumns.length > 0) {
      await insert.onConflictDoUpdate({ target: conflictTarget, set: conflictSet as never });
    } else {
      // Target the PK explicitly so a pk-only conflict is a no-op ONLY on the primary key — a bare
      // `ON CONFLICT DO NOTHING` would swallow conflicts on any unique constraint.
      await insert.onConflictDoNothing({ target: conflictTarget });
    }
  }

  if (debug) console.log(`Upserted ${messages.length} move-in rows`);
}

/** A column's name plus the SQL type to cast it to inside a `json_to_recordset` record definition. */
interface JsonRecordsetColumn {
  name: string;
  castType: string;
}

/**
 * The `json_to_recordset` casts for the rows being applied, narrowed to the columns actually present in
 * the synced row, from the model-derived {@link ApplyTarget.columnTypes} (ADR-0029 D2 — never from a
 * catalog probe: the types are always present, derived from the same Drizzle definitions the local
 * store was rendered from).
 */
function jsonRecordsetColumns(target: ApplyTarget, firstRow: Row<unknown>): JsonRecordsetColumn[] {
  const present = (name: string) => Object.prototype.hasOwnProperty.call(firstRow, name);
  const { schema } = getTableConfig(target.table);
  return target.columnTypes
    .filter((column) => present(column.name))
    .map((column) => ({ name: column.name, castType: castTypeFor(column, schema) }));
}

/**
 * The `ON CONFLICT (pk)` clause for the json-recordset upsert path (ADR-0045 initial-load tier) — the
 * tier-② mirror of {@link upsertConflictSpec}, authored entirely as interpolated `sql.identifier`
 * fragments (no raw identifier text): the conflict target is `target.primaryKey`, and the SET list
 * refreshes every non-pk recordset column to `excluded.<col>`. A pk-only table has nothing to refresh →
 * `DO NOTHING` targeted at the pk (never a bare `ON CONFLICT DO NOTHING`, which would swallow conflicts on
 * any unique constraint — same rule as `upsertConflictSpec`).
 */
function jsonConflictClause(target: ApplyTarget, columns: JsonRecordsetColumn[]): SQL {
  const pkSet = new Set(target.primaryKey);
  const nonPkColumns = columns.map((column) => column.name).filter((name) => !pkSet.has(name));
  const conflictTarget = sql.join(
    target.primaryKey.map((name) => sql`${sql.identifier(name)}`),
    sql`, `,
  );
  if (nonPkColumns.length === 0) {
    return sql`ON CONFLICT (${conflictTarget}) DO NOTHING`;
  }
  const setList = sql.join(
    nonPkColumns.map((name) => sql`${sql.identifier(name)} = excluded.${sql.identifier(name)}`),
    sql`, `,
  );
  return sql`ON CONFLICT (${conflictTarget}) DO UPDATE SET ${setList}`;
}

/**
 * Shared `json_to_recordset` bulk-apply engine for the initial-load tier — one statement, ONE bound param
 * per 10k-row batch (the ADR-0014 remedy for the batched-INSERT param bound). `conflict` is `undefined`
 * for the strict CDC insert ({@link applyMessagesToTableWithJson}) and the `ON CONFLICT (pk)` clause for
 * the ADR-0045 upsert form ({@link applyUpsertsToTableWithJson}); both share the recordDef and batching so
 * the two can never drift.
 */
async function applyMessagesToTableWithJsonImpl(
  { pg, target, messages, debug }: BulkApplyMessagesToTableOptions,
  conflict: SQL | undefined,
) {
  if (debug) console.log(`applying messages with json_to_recordset${conflict ? " (upsert)" : ""}`);

  const data: Row<unknown>[] = messages.map((message) => message.value);
  const firstRow = data[0];
  if (!firstRow) {
    return;
  }
  const columns = jsonRecordsetColumns(target, firstRow);
  const targetTable = target.table;
  // Tier ② (ADR-0028): the target table is an interpolated table object and the batch is a single bound
  // param (`sql.param` binds the raw JS array unchanged, exactly as the old `[batch]` did — critically,
  // NOT `JSON.stringify`, which would throw on the bigints this path carries). The `x(col type, …)`
  // record definition is raw text: `json_to_recordset`'s grammar requires bare column identifiers and
  // type names there, which no tier-①/② builder expresses. The optional ON CONFLICT clause, in contrast,
  // is a fully tier-② `sql.identifier` fragment (see {@link jsonConflictClause}).
  const recordDef = columns.map((column) => `${quoteIdentifier(column.name)} ${column.castType}`).join(", ");
  const conflictClause = conflict ? sql` ${conflict}` : sql``;
  const db = drizzleOverPg(pg);

  const max = 10_000;
  for (let i = 0; i < data.length; i += max) {
    const batch = data.slice(i, i + max);
    await db.execute(
      sql`INSERT INTO ${targetTable} SELECT x.* from json_to_recordset(${sql.param(batch)}) as x(${sql.raw(recordDef)})${conflictClause}`,
    );
  }

  if (debug) {
    console.log(`${conflict ? "Upserted" : "Inserted"} ${messages.length} rows using json_to_recordset`);
  }
}

export async function applyMessagesToTableWithJson(options: BulkApplyMessagesToTableOptions) {
  return applyMessagesToTableWithJsonImpl(options, undefined);
}

/**
 * The `json_to_recordset` **upsert** applier — the ADR-0045 initial-load tier for an `applyMode: "upsert"`
 * table. Identical bulk shape to {@link applyMessagesToTableWithJson} (one statement, one bound param per
 * batch) but with the `ON CONFLICT (pk) DO UPDATE`/`DO NOTHING` clause appended, so a snapshot for a table
 * that already holds locally-derived provisional rows applies idempotently without the 23505 collision the
 * strict path would raise. This is the bulk CEILING for upsert-mode tables: COPY (the faster tier) has no
 * conflict clause, so the initial path downgrades a COPY-eligible upsert table to json rather than
 * param-bound `applyUpsertsToTable` (~31k bound params/statement for a wide table — the very cost this
 * path avoids).
 */
export async function applyUpsertsToTableWithJson(options: BulkApplyMessagesToTableOptions) {
  const firstRow = options.messages[0]?.value;
  if (!firstRow) return;
  const columns = jsonRecordsetColumns(options.target, firstRow);
  return applyMessagesToTableWithJsonImpl(options, jsonConflictClause(options.target, columns));
}

/**
 * Each column mapped to its Postgres `udt_name` for the COPY serializer, which needs it only to
 * disambiguate `json`/`jsonb` (whose parsed values are indistinguishable from SQL arrays/objects by
 * runtime type alone). Derived from the model ({@link ApplyTarget.columnTypes}), never introspected
 * (ADR-0029 D2).
 */
function copyColumnUdts(target: ApplyTarget): Record<string, string> {
  const map: Record<string, string> = {};
  for (const column of target.columnTypes) {
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

export async function applyMessagesToTableWithCopy({ pg, target, messages, debug }: BulkApplyMessagesToTableOptions) {
  if (debug) console.log("applying messages with COPY");

  const data: Row<unknown>[] = messages.map((message) => message.value);
  const firstRow = data[0];
  if (!firstRow) {
    return;
  }
  const columns = Object.keys(firstRow);

  // Serialize rows using Postgres' own COPY TEXT format — a faithful port of the backend's
  // CopyAttributeOutText / array_out routines (see ./copy) — so arrays (incl. multi-dimensional),
  // json/jsonb, bytea, timestamps and strings with embedded delimiters/newlines all round-trip,
  // unlike the previous hand-rolled CSV encoder.
  const columnUdts = copyColumnUdts(target);
  const copyData = generateCopyData(data, columns, columnUdts);
  const copyBlob = new Blob([copyData], { type: "text/plain" });

  // TEXT is the default COPY format; its default delimiter is a tab and NULL marker is `\N`, both of
  // which generateCopyData emits.
  //
  // Tier ③ (ADR-0028 allow-list): `COPY … FROM '/dev/blob'` is PGlite's blob-ingest grammar — it has no
  // Drizzle builder form, so the statement stays a raw string. The table reference is taken from the real
  // synced table object: a bare name (ephemeral → `pg_temp` via search_path) or a schema-qualified one.
  const { name: tableName, schema } = getTableConfig(target.table);
  const copyTarget = schema ? `${quoteIdentifier(schema)}.${quoteIdentifier(tableName)}` : quoteIdentifier(tableName);
  await pg.query(
    `
      COPY ${copyTarget} (${columns.map((column) => quoteIdentifier(column)).join(", ")})
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

const JSON_RECORDSET_BATCH = 10_000;

/**
 * The `json_to_recordset` casts for an **explicit, ordered** column list — the bulk UPDATE/DELETE source
 * relations need the PK columns (plus, for updates, the group's SET columns) in a known order. Derived
 * from the model ({@link ApplyTarget.columnTypes}), never introspected (ADR-0029 D2).
 */
function recordsetColumnCasts(target: ApplyTarget, columnNames: string[]): JsonRecordsetColumn[] {
  const byName = new Map(target.columnTypes.map((column) => [column.name, column]));
  const { schema } = getTableConfig(target.table);
  return columnNames.map((name) => {
    const column = byName.get(name);
    if (!column) {
      throw new Error(`recordsetColumnCasts: no registered type for column ${JSON.stringify(name)}`);
    }
    return { name, castType: castTypeFor(column, schema) };
  });
}

export interface BulkKeyedApplyOptions {
  pg: PGliteInterface | Transaction;
  target: ApplyTarget;
  /** Folded messages: for deletes the value carries the PK; for updates the PK plus merged columns. */
  messages: ChangeMessage<Row<unknown>>[];
  debug: boolean;
}

/**
 * Bulk DELETE by primary key via `DELETE … USING json_to_recordset(…)` (ADR-0014 Phase 3). Safe
 * because the read-path fold already left **one row per PK** — no same-PK duplicate in the source.
 */
export async function applyBulkDeletesToTable({ pg, target, messages, debug }: BulkKeyedApplyOptions) {
  const primaryKey = target.primaryKey;
  if (primaryKey.length === 0) throw new Error("applyBulkDeletesToTable requires a primary key");
  if (messages.length === 0) return;

  const rows = messages.map((message) => {
    const data = message.value;
    return Object.fromEntries(primaryKey.map((column) => [column, data[column]]));
  });

  const casts = recordsetColumnCasts(target, primaryKey);
  const recordDef = casts.map((column) => `${quoteIdentifier(column.name)} ${column.castType}`).join(", ");
  const whereJoin = primaryKey
    .map((column) => `t.${quoteIdentifier(column)} = x.${quoteIdentifier(column)}`)
    .join(" AND ");
  const targetTable = target.table;
  const db = drizzleOverPg(pg);

  for (let i = 0; i < rows.length; i += JSON_RECORDSET_BATCH) {
    const batch = rows.slice(i, i + JSON_RECORDSET_BATCH);
    // Tier ② (ADR-0028): the target table is an interpolated table object; the pk-projection batch is a
    // single bound param (`sql.param` binds the raw JS array unchanged — as the old `[batch]` did, and
    // NOT `JSON.stringify`, which would throw on bigint pks). No cast is needed — `json_to_recordset`
    // has a single json-typed signature. The `x(col type, …)` record definition and the alias-qualified
    // `t.*`/`x.*` join are raw text: the `USING`/recordset-join grammar requires those bare identifiers.
    await db.execute(
      sql`DELETE FROM ${targetTable} AS t USING json_to_recordset(${sql.param(batch)}) AS x(${sql.raw(recordDef)}) WHERE ${sql.raw(whereJoin)}`,
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
export async function applyBulkUpdatesToTable({ pg, target, messages, debug }: BulkKeyedApplyOptions) {
  const primaryKey = target.primaryKey;
  if (primaryKey.length === 0) throw new Error("applyBulkUpdatesToTable requires a primary key");
  if (messages.length === 0) return;

  const pkSet = new Set(primaryKey);
  const groups = new Map<string, { setColumns: string[]; rows: Row<unknown>[] }>();
  for (const message of messages) {
    const data = message.value;
    const setColumns = Object.keys(data)
      .filter((column) => !pkSet.has(column))
      .sort();
    // A PK-only update sets nothing — the per-row applyMessageToTable returns early on this too.
    if (setColumns.length === 0) continue;
    const groupKey = setColumns.join(" ");
    let group = groups.get(groupKey);
    if (!group) {
      group = { setColumns, rows: [] };
      groups.set(groupKey, group);
    }
    group.rows.push(Object.fromEntries([...primaryKey, ...setColumns].map((column) => [column, data[column]])));
  }

  const targetTable = target.table;
  const db = drizzleOverPg(pg);

  for (const { setColumns, rows } of groups.values()) {
    const casts = recordsetColumnCasts(target, [...primaryKey, ...setColumns]);
    const recordDef = casts.map((column) => `${quoteIdentifier(column.name)} ${column.castType}`).join(", ");
    const setClause = setColumns
      .map((column) => `${quoteIdentifier(column)} = x.${quoteIdentifier(column)}`)
      .join(", ");
    const whereJoin = primaryKey
      .map((column) => `t.${quoteIdentifier(column)} = x.${quoteIdentifier(column)}`)
      .join(" AND ");

    for (let i = 0; i < rows.length; i += JSON_RECORDSET_BATCH) {
      const batch = rows.slice(i, i + JSON_RECORDSET_BATCH);
      // Tier ② (ADR-0028), as applyBulkDeletesToTable above: interpolated target table + single bound
      // `sql.param` batch (raw array, not `JSON.stringify` — bigint-safe), no cast needed; the `SET` /
      // `x(col type, …)` record def and the alias-qualified `t.*`/`x.*` join stay raw text (grammar).
      await db.execute(
        sql`UPDATE ${targetTable} AS t SET ${sql.raw(setClause)} FROM json_to_recordset(${sql.param(batch)}) AS x(${sql.raw(recordDef)}) WHERE ${sql.raw(whereJoin)}`,
      );
    }
  }

  if (debug) console.log(`Updated ${messages.length} rows using json_to_recordset`);
}
