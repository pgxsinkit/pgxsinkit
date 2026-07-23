/**
 * Static, type-driven read-path apply ladder (ADR-0009 decision 3).
 *
 * We own the registry's column types ahead of time and only ever target the latest PGlite, so the
 * bulk-insert strategy for a synced table is chosen **once, statically** from its column types —
 * never by probing `information_schema` at runtime. This module is the pure, dependency-free core
 * (no registry, no Drizzle import) so it stays in the fast unit lane; {@link deriveSyncColumnTypes}
 * in `registry.ts` bridges a `SyncTableEntry`'s Drizzle columns into {@link SyncColumnType}s.
 */

/** The bulk-insert path the engine uses for a fresh subscription's initial backfill. */
export type ApplyStrategy = "copy" | "json" | "insert";

/** Resolved column type descriptor for the apply ladder — derived from the registry, not the DB. */
export interface SyncColumnType {
  /** SQL column name (not the Drizzle property key). */
  name: string;
  /**
   * The column's base SQL type from Drizzle's `getSQLType()` (e.g. `"uuid"`, `"text"`, `"jsonb"`,
   * `"bigint"`, `"timestamp with time zone"`). Array-ness is carried separately in {@link isArray};
   * this string is the element/base type and is usable verbatim as a `json_to_recordset` cast type
   * (with `[]` appended when `isArray`).
   */
  sqlType: string;
  /** True when the column is an array of any dimension. */
  isArray: boolean;
  /**
   * True when the column is a Drizzle `pgEnum` column. An enum's {@link sqlType} is its custom type NAME
   * (not a base type), so it is not in {@link COPY_SAFE_BASE_TYPES} — but enum labels round-trip
   * losslessly through both the COPY text format and a `json_to_recordset` cast (whose cast type is the
   * enum type name), so an enum column is COPY-safe / JSON-safe. This flag carries that positively rather
   * than trying to whitelist every enum type name. When true, {@link sqlType} is the enum type name,
   * usable as a cast type once the applier identifier-quotes (and schema-qualifies) it.
   */
  isEnum: boolean;
}

/**
 * Postgres scalar types whose JS→CSV-text rendering is unambiguous, so PGlite `COPY ... FROM`
 * round-trips them losslessly. Deliberately **conservative** (ADR-0009 decision 3): never add a
 * type here unless `COPY` truly handles it. Notably EXCLUDES timestamps/dates (format nuances),
 * `numeric` (precision/format), `bytea`, `interval`, `json`/`jsonb`, and arrays — those route to the
 * `json` tier (if json-representable) or the always-correct `insert` floor. Enums are NOT listed by
 * type name (each is a distinct custom type) but ARE COPY-safe — carried via {@link SyncColumnType.isEnum}
 * rather than this base-type set, since their labels round-trip through COPY text losslessly.
 */
const COPY_SAFE_BASE_TYPES = new Set<string>([
  "text",
  "varchar",
  "character varying",
  "char",
  "character",
  "bpchar",
  "uuid",
  "boolean",
  "bool",
  "smallint",
  "int2",
  "integer",
  "int",
  "int4",
  "bigint",
  "int8",
  "real",
  "float4",
  "double precision",
  "float8",
]);

/**
 * Normalises a Drizzle `getSQLType()` string to a bare base type for whitelist comparison: strips
 * array markers and type arguments (`varchar(255)` → `varchar`, `numeric(10, 2)` → `numeric`),
 * collapses whitespace, and lowercases.
 */
function normalizeBaseType(sqlType: string): string {
  return sqlType
    .replace(/\[\]/g, "")
    .replace(/\(.*\)/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function isCopySafe(column: SyncColumnType): boolean {
  if (column.isArray) {
    return false;
  }
  // Enum labels are plain text on the COPY wire; PGlite's COPY input casts them into the enum type
  // losslessly, so an enum column is COPY-safe even though its `sqlType` (the enum name) is not a base type.
  if (column.isEnum) {
    return true;
  }
  return COPY_SAFE_BASE_TYPES.has(normalizeBaseType(column.sqlType));
}

/**
 * `json_to_recordset` extends the COPY-safe set with arrays, `json`, and `jsonb` — viable now that
 * the latest PGlite round-trips bigint and bigint[] correctly (ADR-0009 decision 3).
 */
function isJsonSafe(column: SyncColumnType): boolean {
  if (isCopySafe(column)) {
    return true;
  }
  if (column.isArray) {
    return true;
  }
  const base = normalizeBaseType(column.sqlType);
  return base === "json" || base === "jsonb";
}

/**
 * Chooses the bulk-insert strategy for a table from its column types (ADR-0009 decision 3):
 * - every column COPY-safe → `copy`;
 * - else every column COPY-safe ∪ array/json/jsonb → `json`;
 * - else → `insert` (the always-correct floor for anything not positively whitelisted).
 *
 * Pure and total: an empty column list falls to `insert`.
 */
export function classifyApplyStrategy(columns: readonly SyncColumnType[]): ApplyStrategy {
  if (columns.length === 0) {
    return "insert";
  }

  let allCopySafe = true;
  let allJsonSafe = true;

  for (const column of columns) {
    if (!isCopySafe(column)) {
      allCopySafe = false;
    }
    if (!isJsonSafe(column)) {
      allJsonSafe = false;
    }
  }

  if (allCopySafe) {
    return "copy";
  }
  if (allJsonSafe) {
    return "json";
  }
  return "insert";
}
