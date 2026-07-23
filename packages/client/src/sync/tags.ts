import type { ChangeMessage, MovePattern, Row } from "@electric-sql/client";
import type { PGliteInterface, Transaction } from "@electric-sql/pglite";
import { and, eq, inArray, like, sql } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";

import { quoteIdentifier, quoteSqlLiteral } from "@pgxsinkit/contracts";

import type { ApplyTarget } from "../local-tables";
import { applyBulkDeletesToTable } from "./apply";
import { drizzleOverPg } from "./drizzle-executor";
import { getMetadataTables, getSessionMetadataTables, pickMetadataTables } from "./metadata-tables";

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

/**
 * The pgxsinkit-owned metadata schema (ADR-0009 decision 6) the tag store + subscription state live in.
 * The sync engine defaults its `metadataSchema` to this, and `createSyncClient` never overrides it — so
 * the desync path (which is outside the engine) can key the tag store by this same constant.
 */
export const DEFAULT_METADATA_SCHEMA = "pgxsinkit";

/**
 * A bare, lowercase, unqualified SQL identifier: begins with a lowercase letter or underscore, then
 * lowercase letters, digits, and underscores.
 */
const METADATA_SCHEMA_PATTERN = /^[a-z_][a-z0-9_]*$/;

/**
 * Validate the metadata schema name at engine construction. The name is interpolated RAW into two
 * positions a double-quoted identifier cannot cover:
 *  - GUC space — `SET LOCAL <schema>.syncing` (sync/index.ts) and `SET <schema>.syncing = false`
 *    (the metadata migration). GUC grammar takes a `namespace.name` of bare identifiers; it does not
 *    accept a quoted identifier the way a table/column position does, so the name cannot be safely
 *    quoted there.
 *  - the `CREATE SCHEMA <schema>` DDL identifier position.
 * Rather than trust arbitrary caller input in those raw positions, restrict the name to a bare
 * lowercase identifier and reject uppercase/exotic names outright. The default "pgxsinkit" passes.
 */
export function assertValidMetadataSchema(metadataSchema: string): void {
  if (!METADATA_SCHEMA_PATTERN.test(metadataSchema)) {
    throw new Error(
      `Invalid metadataSchema ${JSON.stringify(metadataSchema)}: it must be a bare lowercase SQL ` +
        `identifier matching ${String(METADATA_SCHEMA_PATTERN)}. The name is interpolated unquoted into ` +
        `GUC (\`SET <schema>.syncing\`) and \`CREATE SCHEMA\` identifier positions where a quoted ` +
        `identifier is not accepted, so uppercase and exotic names are rejected at construction.`,
    );
  }
}

/**
 * The tag store's schema-qualified identifier, derived from the `shape_row_tags` pgTable config
 * (ADR-0029 D3 — single source; no parallel name string). The store itself is provisioned by
 * `migrateSubscriptionMetadataTables`, which renders that same pgTable.
 */
export function shapeRowTagsTableName(metadataSchema: string): string {
  const config = getTableConfig(getMetadataTables(metadataSchema).shapeRowTags);
  return `${quoteIdentifier(config.schema ?? "public")}.${quoteIdentifier(config.name)}`;
}

/**
 * The SESSION (`pg_temp`) tag store's qualified identifier (ADR-0042), derived from the session
 * `shape_row_tags` pgTable config — the same relation name, in `pg_temp`. Used by the scope-blind
 * {@link buildClearShapeTagsSql} so a desync/discard clears an ephemeral shape's tags wherever they live.
 */
export function shapeRowTagsSessionTableName(): string {
  const config = getTableConfig(getSessionMetadataTables().shapeRowTags);
  return `${quoteIdentifier(config.schema ?? "public")}.${quoteIdentifier(config.name)}`;
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
  // ADR-0042: SCOPE-BLIND — clear the shape's tags from BOTH the durable and the session (`pg_temp`) tag
  // store, each guarded independently by `to_regclass` (a desync/discard may run on a persistent table whose
  // session store never existed, or standalone before any engine boot). `to_regclass('pg_temp.shape_row_tags')`
  // resolves the session table via the per-session `pg_temp` alias (probed on real PGlite).
  const clearOne = (table: string) => `  IF to_regclass(${quoteSqlLiteral(table)}) IS NOT NULL THEN
    DELETE FROM ${table} WHERE shape_table = ${quoteSqlLiteral(shapeTable)};
  END IF;`;
  return `DO $$ BEGIN
${clearOne(shapeRowTagsTableName(metadataSchema))}
${clearOne(shapeRowTagsSessionTableName())}
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
  primaryKey: string[];
  /** ADR-0042: route the tag DML to the SESSION (`pg_temp`) store for an ephemeral group. */
  sessionScoped?: boolean;
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
  primaryKey,
  sessionScoped = false,
}: TagSyncOptions): Promise<void> {
  const { shapeRowTags } = pickMetadataTables(metadataSchema, sessionScoped);
  const db = drizzleOverPg(pg);

  for (const message of messages) {
    const data = message.value;
    const pkJson = serializeRowPk(data, primaryKey);

    if (message.headers.operation === "delete") {
      await db
        .delete(shapeRowTags)
        .where(and(eq(shapeRowTags.shape_table, shapeTable), eq(shapeRowTags.pk_json, pkJson)));
      continue;
    }

    const tags = message.headers.tags;
    if (tags !== undefined) {
      // `tags` is the authoritative current reason-set → replace.
      await db
        .delete(shapeRowTags)
        .where(and(eq(shapeRowTags.shape_table, shapeTable), eq(shapeRowTags.pk_json, pkJson)));
      if (tags.length > 0) {
        await db
          .insert(shapeRowTags)
          .values(tags.map((tag) => ({ shape_table: shapeTable, pk_json: pkJson, tag })))
          .onConflictDoNothing();
      }
      continue;
    }

    const removedTags = message.headers.removed_tags;
    if (removedTags && removedTags.length > 0) {
      await db
        .delete(shapeRowTags)
        .where(
          and(
            eq(shapeRowTags.shape_table, shapeTable),
            eq(shapeRowTags.pk_json, pkJson),
            inArray(shapeRowTags.tag, removedTags),
          ),
        );
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
  primaryKey,
  sessionScoped = false,
}: TagSyncOptions): Promise<void> {
  const { shapeRowTags } = pickMetadataTables(metadataSchema, sessionScoped);
  const db = drizzleOverPg(pg);

  for (const message of messages) {
    const tags = message.headers.tags;
    if (!tags || tags.length === 0) continue;

    const data = message.value;
    const pkJson = serializeRowPk(data, primaryKey);
    await db
      .insert(shapeRowTags)
      .values(tags.map((tag) => ({ shape_table: shapeTable, pk_json: pkJson, tag })))
      .onConflictDoNothing();
  }
}

interface MoveOutOptions {
  pg: PGliteInterface | Transaction;
  metadataSchema: string;
  shapeTable: string;
  /** The resolved apply target for the synced table the evicted rows are deleted from (ADR-0029 D1). */
  target: ApplyTarget;
  /** One entry per buffered `move-out` event, each its own pattern set. */
  patternSets: MovePattern[][];
  debug: boolean;
  /** ADR-0042: route the tag reads/evictions to the SESSION (`pg_temp`) store for an ephemeral group. */
  sessionScoped?: boolean;
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
  target,
  patternSets,
  debug,
  sessionScoped = false,
}: MoveOutOptions): Promise<number> {
  const { shapeRowTags } = pickMetadataTables(metadataSchema, sessionScoped);
  const db = drizzleOverPg(pg);
  const evictedPkJsons = new Set<string>();

  for (const patterns of patternSets) {
    if (patterns.length === 0) continue;

    // Candidate tags: those containing every pattern value as a substring — a cheap superset of a real
    // positional match, confirmed in JS so composite/positional tags are handled correctly. Each
    // `like(tag, "%value%")` reproduces the former `tag LIKE '%' || $n || '%'` exactly: a param bound to
    // the concatenated pattern string, so any LIKE metacharacters in the value keep the same semantics.
    const candidateRows = await db
      .select({ pk_json: shapeRowTags.pk_json, tag: shapeRowTags.tag })
      .from(shapeRowTags)
      .where(
        and(
          eq(shapeRowTags.shape_table, shapeTable),
          ...patterns.map((pattern) => like(shapeRowTags.tag, `%${pattern.value}%`)),
        ),
      );
    const matched = candidateRows.filter((row) => tagMatchesPatterns(row.tag, patterns));
    if (matched.length === 0) continue;

    // Withdraw the moved-out tag from each matching row (one set-based delete of the (pk, tag) pairs).
    // Tier ② (ADR-0028): a set-based delete joined against a JSON recordset has no tier-① builder form —
    // the shape-tag table object is interpolated and the pair list is a bound `::json` param; the
    // alias-qualified `t.*` / `x.*` identifiers are raw only because the `USING`/recordset-join grammar
    // requires them.
    const pairs = matched.map((row) => ({ pk_json: row.pk_json, tag: row.tag }));
    await db.execute(
      sql`DELETE FROM ${shapeRowTags} AS t USING json_to_recordset(${JSON.stringify(pairs)}::json) AS x(pk_json text, tag text)
       WHERE t.shape_table = ${shapeTable} AND t.pk_json = x.pk_json AND t.tag = x.tag`,
    );

    // A row is evicted only if it has no tag left.
    const affected = [...new Set(matched.map((row) => row.pk_json))];
    // Tier ② (ADR-0028): bind the affected pk_json list as ONE array param via `= ANY(${param}::text[])`
    // — drizzle has no ANY(array-param) builder, and `sql.param` binds the whole array as a single
    // placeholder (removing the per-element bound-param ceiling `inArray` emits: one placeholder per PK,
    // a ~65k-param wire cap on a huge move-out). The explicit `::text[]` cast pins the param type for the
    // driver's extended-protocol type resolution. The `eq(shape_table)` conjunct and `selectDistinct`
    // shape are preserved.
    const remaining = await db
      .selectDistinct({ pk_json: shapeRowTags.pk_json })
      .from(shapeRowTags)
      .where(
        and(
          eq(shapeRowTags.shape_table, shapeTable),
          sql`${shapeRowTags.pk_json} = ANY(${sql.param(affected)}::text[])`,
        ),
      );
    const stillTagged = new Set(remaining.map((row) => row.pk_json));
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
    target,
    messages,
    debug,
  });

  return evictedPkJsons.size;
}

/** Drop a shape's entire tag-set — for a `must-refetch`/read-cache rebuild, before the re-snapshot (ADR-0023 Slice 2). */
export async function clearShapeTags({
  pg,
  metadataSchema,
  shapeTable,
  sessionScoped = false,
}: {
  pg: PGliteInterface | Transaction;
  metadataSchema: string;
  shapeTable: string;
  /** ADR-0042: clear the SESSION (`pg_temp`) tag store for an ephemeral group's must-refetch rebuild. */
  sessionScoped?: boolean;
}): Promise<void> {
  const { shapeRowTags } = pickMetadataTables(metadataSchema, sessionScoped);
  await drizzleOverPg(pg).delete(shapeRowTags).where(eq(shapeRowTags.shape_table, shapeTable));
}
