import { index, jsonb, pgSchema, primaryKey, text } from "drizzle-orm/pg-core";

import type { ShapeSubscriptionState } from "./subscription-state";

/**
 * The two metadata-store relations the sync engine provisions at boot (ADR-0028 decision 4). The
 * metadata schema name is dynamic (per-client config) but fixed at engine construction, so the tables
 * are built per schema string and memoized.
 *
 * ADR-0029 D3: these pgTables are the SINGLE SOURCE for the relations. `migrateSubscriptionMetadataTables`
 * (subscription-state.ts) renders their `CREATE TABLE`/`CREATE INDEX` DDL FROM these definitions via the
 * in-house `renderCreateTableSql` (schema.ts), and the DML paths query them directly — so the DDL and the
 * pgTable can no longer diverge, and the former drift guard in `tests/unit/sync-drizzle-executor.test.ts`
 * is now a plain provisioning round-trip.
 *
 * Property keys are deliberately snake_case to mirror the row shapes the callers already consume
 * (`shape_metadata`, `last_lsn`, `pk_json`, …), so a `select()` returns rows in the existing shape with
 * no alias mapping.
 */

export interface MetadataTables {
  /** `<schema>.subscriptions_metadata` — one row per subscription key. */
  readonly subscriptionsMetadata: ReturnType<typeof buildSubscriptionsMetadata>;
  /** `<schema>.shape_row_tags` — the tagged-subquery reason-set store (ADR-0023). */
  readonly shapeRowTags: ReturnType<typeof buildShapeRowTags>;
}

/**
 * The `pg_temp` schema name the SESSION metadata variants are built under (ADR-0042). An ephemeral
 * group's sync bookkeeping (cursor + tags) is scoped to the engine session by placing it in `pg_temp`
 * relations that die with the engine — the cursor's lifetime is mechanically tied to the TEMP cluster
 * whose rows it indexes. `pg_temp` is a per-session alias Postgres accepts in DML qualification (probed
 * on real PGlite), so the DML paths select these objects unchanged. Same relation NAMES as the durable
 * variants, distinguished by schema alone (maintainer ruling).
 */
const SESSION_METADATA_SCHEMA = "pg_temp";

function buildSubscriptionsMetadata(schema: ReturnType<typeof pgSchema>) {
  return schema.table("subscriptions_metadata", {
    key: text("key").primaryKey(),
    // JSONB NOT NULL — round-trips as a parsed object (drizzle's jsonb codec), matching the raw path.
    shape_metadata: jsonb("shape_metadata").$type<Record<string, ShapeSubscriptionState>>().notNull(),
    // The LSN is persisted as TEXT (a bigint has no JSON/portable-column form); callers `BigInt(...)` it.
    last_lsn: text("last_lsn").notNull(),
  });
}

function buildShapeRowTags(schema: ReturnType<typeof pgSchema>) {
  return schema.table(
    "shape_row_tags",
    {
      shape_table: text("shape_table").notNull(),
      pk_json: text("pk_json").notNull(),
      tag: text("tag").notNull(),
    },
    (t) => [
      primaryKey({ columns: [t.shape_table, t.pk_json, t.tag] }),
      index("shape_row_tags_shape_tag_idx").on(t.shape_table, t.tag),
    ],
  );
}

const cache = new Map<string, MetadataTables>();

/** The (memoized) metadata-store `pgTable`s for a given metadata schema name. */
export function getMetadataTables(metadataSchema: string): MetadataTables {
  let tables = cache.get(metadataSchema);
  if (!tables) {
    const schema = pgSchema(metadataSchema);
    tables = {
      subscriptionsMetadata: buildSubscriptionsMetadata(schema),
      shapeRowTags: buildShapeRowTags(schema),
    };
    cache.set(metadataSchema, tables);
  }
  return tables;
}

let sessionCache: MetadataTables | undefined;

/**
 * The (memoized) SESSION metadata-store `pgTable`s (ADR-0042) — the same relation names as the durable
 * variants, built from the SAME column builders (ADR-0029 D3 single-source), but schema-qualified into
 * `pg_temp` so the DML lands in the engine's session-scoped TEMP relations. No schema parameter: `pg_temp`
 * is per-engine by construction, so a single memoized singleton serves every engine. The DDL that
 * PROVISIONS these tables uses the unqualified `CREATE TEMP TABLE` form (the TEMP keyword places the
 * relation in the session schema; a `pg_temp.x` DDL target is not portable), rendered from these SAME
 * definitions via `renderCreateTableSql({ temp: true })`.
 */
export function getSessionMetadataTables(): MetadataTables {
  if (!sessionCache) {
    const schema = pgSchema(SESSION_METADATA_SCHEMA);
    sessionCache = {
      subscriptionsMetadata: buildSubscriptionsMetadata(schema),
      shapeRowTags: buildShapeRowTags(schema),
    };
  }
  return sessionCache;
}

/**
 * Select the durable or SESSION metadata tables (ADR-0042). `sessionScoped` groups (ephemeral retention)
 * route their cursor + tag DML to the `pg_temp` variants; every other group keeps the durable tables. The
 * engine learns one storage-scope bit, not the retention model.
 */
export function pickMetadataTables(metadataSchema: string, sessionScoped: boolean): MetadataTables {
  return sessionScoped ? getSessionMetadataTables() : getMetadataTables(metadataSchema);
}
