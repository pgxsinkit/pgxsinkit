import type { ColumnBuilderBase } from "drizzle-orm";
import { bigint, pgTable, pgView, varchar } from "drizzle-orm/pg-core";

/**
 * Creates a paired Drizzle pgTable + pgView for a pgxsinkit-synced table.
 *
 * `makeColumns` is called twice to produce fresh builder instances: once for
 * the table and once for the view. Column builders bind to their parent table
 * at build time and cannot be shared between a table and a view.
 *
 * The generated view is named `${tableName}_read_model` by default and
 * includes all data columns plus the overlay meta-columns `overlay_kind` and
 * `local_updated_at_us` that `generateLocalSchemaSql` always emits.
 *
 * The view is marked `.existing()` so drizzle-kit does not attempt to CREATE
 * it in Postgres migrations — it is a PGlite-only runtime artifact.
 */
export function createSyncObjects<TName extends string, TColumns extends Record<string, ColumnBuilderBase>>(
  tableName: TName,
  makeColumns: () => TColumns,
  tableExtras?: (table: any) => unknown[],
  options?: { readModelName?: string },
) {
  const table = pgTable(tableName, makeColumns(), tableExtras as any);

  const readModelName = options?.readModelName ?? `${tableName}_read_model`;

  const view = pgView(readModelName, {
    ...makeColumns(),
    overlay_kind: varchar("overlay_kind", { length: 24 }).notNull(),
    local_updated_at_us: bigint("local_updated_at_us", { mode: "bigint" }).notNull(),
  }).existing();

  return { table, view };
}
