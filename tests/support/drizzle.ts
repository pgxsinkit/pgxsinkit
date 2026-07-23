import type { PGlite } from "@electric-sql/pglite";
import { getColumns } from "drizzle-orm";
import type { AnyPgTable, PgColumn } from "drizzle-orm/pg-core";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";

import { normalizeCastPositionType } from "@pgxsinkit/contracts";
import { renderPgxsinkitUtilitiesMigration } from "@pgxsinkit/server";

import type { ApplyTarget } from "../../packages/client/src/local-tables";

// One drizzle handle per PGlite instance, so every converted call site in a file shares a builder
// without re-wrapping. Wrapping is cheap, but a single identity also keeps `.toSQL()`-rendered
// statements comparable across helpers.
const handles = new WeakMap<PGlite, PgliteDatabase<never>>();

/** A (memoized) Drizzle handle over any test PGlite instance — the tier-① authoring surface. */
export function drizzleOver(pg: PGlite): PgliteDatabase<never> {
  let db = handles.get(pg);
  if (!db) {
    // MUST be the `{ client }` config form: drizzle's pglite driver destructures `{ connection, client }`
    // from a bare first argument, so `drizzle(pg)` misdetects the instance as a config and silently
    // constructs a NEW in-memory PGlite — every read would then target an empty database.
    db = drizzle({ client: pg as never }) as PgliteDatabase<never>;
    handles.set(pg, db);
  }
  return db;
}

/**
 * Build a read-path {@link ApplyTarget} directly from a fixture `pgTable` and its primary-key column
 * NAMES — the applier-focused unit tests' equivalent of the engine's `resolveApplyTarget(registry, key)`
 * (ADR-0029 D1/D2). Column types are derived from the same Drizzle definitions `deriveSyncColumnTypes`
 * reads (`getSQLType()` / `dimensions`) and put through the SAME `normalizeCastPositionType` (so the
 * serial family lands as its integer cast type, matching the production derivation), keeping the target
 * model-faithful without standing up a whole registry for a test that only exercises one applier.
 */
export function makeApplyTarget(
  table: AnyPgTable,
  primaryKey: string[],
  applyMode: ApplyTarget["applyMode"] = "insert",
): ApplyTarget {
  const columns = getColumns(table) as Record<string, PgColumn>;
  const columnByName: Record<string, PgColumn> = {};
  const propertyKeyByName: Record<string, string> = {};
  const columnTypes: ApplyTarget["columnTypes"] = [];
  for (const [propertyKey, column] of Object.entries(columns)) {
    columnByName[column.name] = column;
    propertyKeyByName[column.name] = propertyKey;
    const typed = column as unknown as {
      getSQLType?: () => string;
      dimensions?: number;
      columnType?: string;
    };
    columnTypes.push({
      name: column.name,
      sqlType: normalizeCastPositionType(typed.getSQLType?.() ?? ""),
      isArray: (typed.dimensions ?? 0) > 0,
      // `PgEnum` brand, NOT `enumValues` — text/varchar-with-enum expose `enumValues` with a BASE sqlType
      // (see deriveSyncColumnTypes); this mirror must match the real derivation.
      isEnum: typed.columnType?.startsWith("PgEnum") === true,
    });
  }
  return { table, columnByName, propertyKeyByName, primaryKey, applyMode, columnTypes, insertRenderCache: new Map() };
}

/**
 * Create the given Drizzle tables (and enums they reference) in a FRESH database by generating the
 * empty→schema migration statements offline (drizzle-kit's `generateDrizzleJson`/`generateMigration`)
 * and executing them. Deliberately NOT diff-based `pushSchema`: nothing is introspected, so this can
 * never emit statements about relations it was not given — safe for PGlite fixtures and for shared
 * integration databases alike. Only meaningful for fixture tables that do not already exist.
 */
export async function createTablesFromSchema(
  db: { execute: (query: string) => Promise<unknown> } | PGlite,
  schema: Record<string, unknown>,
): Promise<void> {
  const { generateDrizzleJson, generateMigration } = await import("drizzle-kit/api-postgres");
  const statements = await generateMigration(await generateDrizzleJson({}), await generateDrizzleJson(schema));
  // The audit/version column DEFAULTs call `public.pgxsinkit_clock_us()`, so the function must exist
  // before these CREATE TABLE statements validate their default expressions (and before the apply
  // function that also calls it runs). In production the utilities migration is the first folder in the
  // chain; here we install it inline, from the same single render.
  const withUtilities = [renderPgxsinkitUtilitiesMigration(), ...statements];
  for (const statement of withUtilities) {
    if ("execute" in db && typeof db.execute === "function") {
      await (db as { execute: (query: string) => Promise<unknown> }).execute(statement);
    } else {
      await (db as PGlite).exec(statement);
    }
  }
}
