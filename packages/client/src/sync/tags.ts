import type { ChangeMessage, MovePattern, Row } from "@electric-sql/client";
import type { PGliteInterface, Transaction } from "@electric-sql/pglite";

import { quoteSqlLiteral, type SyncColumnType } from "@pgxsinkit/contracts";

import { applyBulkDeletesToTable, doMapColumns } from "./apply";
import type { MapColumns } from "./types";

/**
 * Electric **tagged-subquery** reconciliation (ADR-0023). A shape whose `where` contains a subquery
 * (membership-style row filters: `container_id IN (SELECT … FROM memberships WHERE member = $sub)`)
 * streams two extra things the plain change path ignores:
 *
 * - every change message carries `headers.tags` — the **reasons** the row is in the shape (one tag per
 *   grant/membership), plus `removed_tags` on an update;
 * - a **`move-out` `EventMessage`** carries `patterns: { pos, value }[]` — "the tag whose component at
 *   index `pos` equals `value` is withdrawn", i.e. that grant was revoked.
 *
 * A row leaves the shape only when it has **no remaining tag**. The engine drops the `EventMessage`
 * today, so a removed member keeps the revoked rows. This module persists each row's tag-set in one
 * metadata table and evicts rows whose last tag is withdrawn — closing the move-out gap without an
 * Electric change.
 *
 * Tag storage is a single metadata table keyed by the synced table + a canonical primary-key JSON:
 * `shape_row_tags(shape_table, pk_json, tag)`. It is created in `migrateSubscriptionMetadataTables`.
 */

const SHAPE_ROW_TAGS_TABLE = "shape_row_tags";

/**
 * The pgxsinkit-owned metadata schema (ADR-0009 decision 6) the tag store + subscription state live in.
 * The sync engine defaults its `metadataSchema` to this, and `createSyncClient` never overrides it — so
 * the desync path (which is outside the engine) can key the tag store by this same constant.
 */
export const DEFAULT_METADATA_SCHEMA = "pgxsinkit";

export function shapeRowTagsTableName(metadataSchema: string): string {
  return `"${metadataSchema}"."${SHAPE_ROW_TAGS_TABLE}"`;
}

/** The DDL for the tag store (folded into the subscription-metadata migration). */
export function shapeRowTagsDdl(metadataSchema: string): string {
  const table = shapeRowTagsTableName(metadataSchema);
  return `
    CREATE TABLE IF NOT EXISTS ${table} (
      shape_table TEXT NOT NULL,
      pk_json TEXT NOT NULL,
      tag TEXT NOT NULL,
      PRIMARY KEY (shape_table, pk_json, tag)
    );
    CREATE INDEX IF NOT EXISTS "${SHAPE_ROW_TAGS_TABLE}_shape_tag_idx" ON ${table} (shape_table, tag);
  `;
}

/** The `shape_table` key for the tag store: the synced table, schema-qualified (defaults `public`). */
export function shapeTableId(schema: string | undefined, table: string): string {
  return `${schema ?? "public"}.${table}`;
}

/**
 * Static SQL to drop a shape's tag-set, **guarded** by `to_regclass` so it is a no-op when the tag store
 * does not exist. Used by `buildDesyncTableSql` (ADR-0023 Slice 2), which may be exec'd standalone (a
 * caller/test that builds the local schema without booting the sync engine that creates the store). The
 * engine's own `clearShapeTags` runs inside a commit where the store is guaranteed present, so it is not
 * guarded.
 */
export function buildClearShapeTagsSql(shapeTable: string, metadataSchema: string = DEFAULT_METADATA_SCHEMA): string {
  const table = shapeRowTagsTableName(metadataSchema);
  return `DO $$ BEGIN
  IF to_regclass(${quoteSqlLiteral(table)}) IS NOT NULL THEN
    DELETE FROM ${table} WHERE shape_table = ${quoteSqlLiteral(shapeTable)};
  END IF;
END $$;`;
}

/**
 * Canonical primary-key JSON for a synced row — the tag store's per-row key. Built from the **mapped**
 * value (synced-table column names), with pk columns sorted so the string is stable, and `bigint`
 * rendered as a string (JSON has no bigint). Reversible via `JSON.parse` for the eviction DELETE.
 */
export function serializeRowPk(value: Row<unknown>, primaryKey: readonly string[]): string {
  const obj: Record<string, unknown> = {};
  for (const column of [...primaryKey].sort()) {
    obj[column] = value[column];
  }
  return JSON.stringify(obj, (_key, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
}

/**
 * Split a composite `MoveTag` into its positional columns. A tag for a shape with N subquery conditions
 * is the per-condition grant values joined by `/` (an absent condition is an empty column) — e.g. a
 * two-condition shape yields `"<grantHash>/1//"` and `"//<grantHash>/<grantHash>"`. `\/` is a literal
 * `/`, `\\` a literal `\`. A single-condition shape's tag has no separator → `[tag]`.
 *
 * (The `MovePattern.pos` indexes into THIS split — confirmed against Electric 1.7.4 wire messages,
 * ADR-0023. The upstream type doc mentions `|`; the actual column separator on the wire is `/`.)
 */
export function splitTagComponents(tag: string): string[] {
  const parts: string[] = [];
  let current = "";
  for (let i = 0; i < tag.length; i++) {
    const char = tag[i]!;
    if (char === "\\" && i + 1 < tag.length) {
      current += tag[i + 1];
      i += 1;
      continue;
    }
    if (char === "/") {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts;
}

/**
 * Whether a tag is withdrawn by a `move-out` event. A revoked grant can appear at more than one column
 * of the shape's tag structure (one position per subquery condition that references it), so the event
 * enumerates those positions and a tag is withdrawn if it carries the value at **any** of them. A row
 * is then evicted only once **every** tag keeping it in the shape has been withdrawn (the caller's
 * empty-tag-set check) — so a row held by an independent second grant survives. Empty pattern set
 * matches nothing.
 */
export function tagMatchesPatterns(tag: string, patterns: readonly MovePattern[]): boolean {
  if (patterns.length === 0) return false;
  const parts = splitTagComponents(tag);
  return patterns.some((pattern) => parts[pattern.pos] === pattern.value);
}

interface TagSyncOptions {
  pg: PGliteInterface | Transaction;
  metadataSchema: string;
  shapeTable: string;
  messages: ChangeMessage<Row<unknown>>[];
  mapColumns?: MapColumns | undefined;
  primaryKey: string[];
}

/**
 * Maintain the tag-set for a shape from its drained change batch (ADR-0023). For a subquery shape every
 * change carries `headers.tags` (the row's current full reason-set), so insert/update **replace** the
 * row's tags; a delete drops them. `removed_tags` (without `tags`) deletes just those. A non-subquery
 * shape carries no `tags`, so this is a no-op for it. Runs before the data apply and the move-out
 * eviction in the same commit, so an add-then-remove within one batch resolves correctly.
 */
export async function applyShapeTagSync({
  pg,
  metadataSchema,
  shapeTable,
  messages,
  mapColumns,
  primaryKey,
}: TagSyncOptions): Promise<void> {
  const tagsTable = shapeRowTagsTableName(metadataSchema);

  for (const message of messages) {
    const data = mapColumns ? doMapColumns(mapColumns, message) : message.value;
    const pkJson = serializeRowPk(data, primaryKey);

    if (message.headers.operation === "delete") {
      await pg.query(`DELETE FROM ${tagsTable} WHERE shape_table = $1 AND pk_json = $2`, [shapeTable, pkJson]);
      continue;
    }

    const tags = message.headers.tags;
    if (tags !== undefined) {
      // `tags` is the authoritative current reason-set → replace.
      await pg.query(`DELETE FROM ${tagsTable} WHERE shape_table = $1 AND pk_json = $2`, [shapeTable, pkJson]);
      if (tags.length > 0) {
        const valuesSql = tags.map((_tag, index) => `($1, $2, $${index + 3})`).join(", ");
        await pg.query(
          `INSERT INTO ${tagsTable} (shape_table, pk_json, tag) VALUES ${valuesSql} ON CONFLICT DO NOTHING`,
          [shapeTable, pkJson, ...tags],
        );
      }
      continue;
    }

    const removedTags = message.headers.removed_tags;
    if (removedTags && removedTags.length > 0) {
      const placeholders = removedTags.map((_tag, index) => `$${index + 3}`).join(", ");
      await pg.query(`DELETE FROM ${tagsTable} WHERE shape_table = $1 AND pk_json = $2 AND tag IN (${placeholders})`, [
        shapeTable,
        pkJson,
        ...removedTags,
      ]);
    }
  }
}

/**
 * Record (union) a **move-in** row's tags without clearing the tags the row already carries (ADR-0024).
 * A move-in ADDS a reason a row is in the shape, so — unlike a regular change, whose `tags` is the
 * authoritative full reason-set and therefore REPLACES (see {@link applyShapeTagSync}) — a move-in must
 * not drop tags from an independent grant. Inserting with `ON CONFLICT DO NOTHING` is correct whether
 * Electric sends the row's full reason-set or only the newly-added grant on a move-in, so move-out
 * eviction afterwards stays correct under multi-grant without depending on the move-in's tag cardinality.
 * A row with no `tags` (a non-subquery shape) is a no-op.
 */
export async function addShapeRowTags({
  pg,
  metadataSchema,
  shapeTable,
  messages,
  mapColumns,
  primaryKey,
}: TagSyncOptions): Promise<void> {
  const tagsTable = shapeRowTagsTableName(metadataSchema);

  for (const message of messages) {
    const tags = message.headers.tags;
    if (!tags || tags.length === 0) continue;

    const data = mapColumns ? doMapColumns(mapColumns, message) : message.value;
    const pkJson = serializeRowPk(data, primaryKey);
    const valuesSql = tags.map((_tag, index) => `($1, $2, $${index + 3})`).join(", ");
    await pg.query(`INSERT INTO ${tagsTable} (shape_table, pk_json, tag) VALUES ${valuesSql} ON CONFLICT DO NOTHING`, [
      shapeTable,
      pkJson,
      ...tags,
    ]);
  }
}

interface MoveOutOptions {
  pg: PGliteInterface | Transaction;
  metadataSchema: string;
  shapeTable: string;
  table: string;
  schema?: string | undefined;
  primaryKey: string[];
  columnTypes?: SyncColumnType[] | undefined;
  /** One entry per buffered `move-out` event, each its own pattern set. */
  patternSets: MovePattern[][];
  debug: boolean;
}

/**
 * Apply buffered `move-out` events for a shape (ADR-0023): withdraw the matched tag from every row that
 * carries it, then evict the synced rows left with **no** remaining tag — so a row held by two grants
 * survives losing one. Eviction goes through the tested bulk-delete path, so it fires the reconcile
 * trigger and the read-model/overlay stays consistent. Returns the number of rows evicted.
 */
export async function applyShapeMoveOut({
  pg,
  metadataSchema,
  shapeTable,
  table,
  schema,
  primaryKey,
  columnTypes,
  patternSets,
  debug,
}: MoveOutOptions): Promise<number> {
  const tagsTable = shapeRowTagsTableName(metadataSchema);
  const evictedPkJsons = new Set<string>();

  for (const patterns of patternSets) {
    if (patterns.length === 0) continue;

    // Candidate tags: those containing every pattern value as a substring — a cheap superset of a real
    // positional match, confirmed in JS so composite/positional tags are handled correctly.
    const likeClauses = patterns.map((_pattern, index) => `tag LIKE '%' || $${index + 2} || '%'`).join(" AND ");
    const candidates = await pg.query<{ pk_json: string; tag: string }>(
      `SELECT pk_json, tag FROM ${tagsTable} WHERE shape_table = $1 AND ${likeClauses}`,
      [shapeTable, ...patterns.map((pattern) => pattern.value)],
    );
    const matched = candidates.rows.filter((row) => tagMatchesPatterns(row.tag, patterns));
    if (matched.length === 0) continue;

    // Withdraw the moved-out tag from each matching row (one set-based delete of the (pk, tag) pairs).
    await pg.query(
      `DELETE FROM ${tagsTable} AS t USING json_to_recordset($2) AS x(pk_json text, tag text)
       WHERE t.shape_table = $1 AND t.pk_json = x.pk_json AND t.tag = x.tag`,
      [shapeTable, matched.map((row) => ({ pk_json: row.pk_json, tag: row.tag }))],
    );

    // A row is evicted only if it has no tag left.
    const affected = [...new Set(matched.map((row) => row.pk_json))];
    const remaining = await pg.query<{ pk_json: string }>(
      `SELECT DISTINCT pk_json FROM ${tagsTable} WHERE shape_table = $1 AND pk_json = ANY($2)`,
      [shapeTable, affected],
    );
    const stillTagged = new Set(remaining.rows.map((row) => row.pk_json));
    for (const pkJson of affected) {
      if (!stillTagged.has(pkJson)) evictedPkJsons.add(pkJson);
    }
  }

  if (evictedPkJsons.size === 0) return 0;

  // Evict via the bulk-delete path so the reconcile trigger fires and the read model converges.
  const messages = [...evictedPkJsons].map((pkJson) => ({
    key: pkJson,
    value: JSON.parse(pkJson) as Row<unknown>,
    headers: { operation: "delete" as const },
  }));
  await applyBulkDeletesToTable({
    pg,
    table,
    schema,
    messages,
    primaryKey,
    columnTypes,
    debug,
  });

  return evictedPkJsons.size;
}

/** Drop a shape's entire tag-set — for a `must-refetch`/read-cache rebuild, before the re-snapshot (ADR-0023 Slice 2). */
export async function clearShapeTags({
  pg,
  metadataSchema,
  shapeTable,
}: {
  pg: PGliteInterface | Transaction;
  metadataSchema: string;
  shapeTable: string;
}): Promise<void> {
  await pg.query(`DELETE FROM ${shapeRowTagsTableName(metadataSchema)} WHERE shape_table = $1`, [shapeTable]);
}
