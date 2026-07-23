import { Column, is, SQL } from "drizzle-orm";

/** The `{ fieldKey: Column | SQL | nested }` map carried on a Drizzle select at `query._.selectedFields`. */
export type SelectedFields = Record<string, unknown>;

/**
 * Map a raw PGlite live-query row onto a Drizzle select's field keys.
 *
 * `useLiveDrizzleRows` feeds the builder's `.toSQL()` straight into PGlite's `live.query`, which
 * returns rows keyed by the **underlying column names** (snake_case) — `select({ assigneeId })`
 * produces SQL `select "assignee_id"`, so the raw row is `{ assignee_id }`, not `{ assigneeId }`.
 * Drizzle's own execution would remap these by position; the live query bypasses that, so this does it
 * by name using the select's field metadata:
 *
 * - a {@link Column} carries its DB `name`, so the value is read from `row[column.name]`;
 * - an {@link SQL} / aliased expression is aliased to its key in the generated SQL, so read `row[key]`;
 * - a nested selection object recurses;
 * - with no field map (a raw query) the row is returned unchanged.
 */
export function remapLiveRow(
  selectedFields: SelectedFields | undefined,
  row: Record<string, unknown>,
): Record<string, unknown> {
  if (selectedFields == null) return row;
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(selectedFields)) {
    if (is(field, Column)) {
      out[key] = row[field.name];
    } else if (is(field, SQL) || is(field, SQL.Aliased)) {
      out[key] = row[key];
    } else if (field != null && typeof field === "object") {
      out[key] = remapLiveRow(field as SelectedFields, row);
    } else {
      out[key] = row[key];
    }
  }
  return out;
}

// ─── Materialization-safe live reads (JOINs with same-named columns) ─────────────────────────────────
//
// Reading by the underlying column NAME (as `remapLiveRow` does) is unsound when a JOIN's tables share a
// column name — `select({ courseTitle: course.title, moduleTitle: module.title })` compiles to a SELECT
// with two `title` output columns. PGlite's `live` extension MATERIALISES the query and fails hard
// (`column "title" specified more than once`); even a plain query would silently collapse both `title`s
// into one value. The seam (`client.subscribeLiveRows`) fixes this by wrapping the query with a POSITIONAL
// column-alias-list when it is handed `fields` — the unique aliases below — so every output column is
// renamed to a distinct name. Rows then come back keyed by THOSE aliases, and `remapAliasedLiveRow` maps
// them onto the select's field keys positionally.

/** The prefix for the positional output aliases the live-rows seam renames a materialised query's columns to. */
const LIVE_FIELD_ALIAS_PREFIX = "__pgx_c";

/** Assign a positional alias to the `index`-th output column: `__pgx_c0`, `__pgx_c1`, … (unique by index). */
function liveFieldAliasAt(index: number): string {
  return `${LIVE_FIELD_ALIAS_PREFIX}${index}`;
}

/**
 * Flatten a Drizzle select's `selectedFields` into the ordered list of UNIQUE output aliases needed to
 * make its live query safe to materialise. The walk order (depth-first over the field keys, recursing
 * into nested selection objects) matches Drizzle's column-emission order in the compiled SQL, so the
 * `index`-th leaf here is the `index`-th output column there — the invariant the positional
 * column-alias-list depends on. Returns `undefined` for a raw query (no field map): the seam then leaves
 * the SQL unwrapped and rows stay keyed by the underlying column names ({@link remapLiveRow}).
 */
export function liveFieldAliases(selectedFields: SelectedFields | undefined): string[] | undefined {
  if (selectedFields == null) return undefined;
  const aliases: string[] = [];
  const walk = (fields: SelectedFields): void => {
    for (const field of Object.values(fields)) {
      if (is(field, Column) || is(field, SQL) || is(field, SQL.Aliased)) {
        aliases.push(liveFieldAliasAt(aliases.length));
      } else if (field != null && typeof field === "object") {
        walk(field as SelectedFields);
      } else {
        aliases.push(liveFieldAliasAt(aliases.length));
      }
    }
  };
  walk(selectedFields);
  return aliases.length > 0 ? aliases : undefined;
}

/**
 * Map a live row that came back from the ALIAS-WRAPPED query (keyed by the positional `__pgx_cN` aliases
 * {@link liveFieldAliases} produced) onto the Drizzle select's field keys. Walks `selectedFields` in the
 * same order, so the Nth leaf reads `row[__pgx_cN]`; nested selections recurse. The alias-space
 * counterpart to {@link remapLiveRow} — which keys by the underlying column name and cannot survive a
 * same-named-column collision. Returns the row unchanged when there is no field map (a raw query).
 */
export function remapAliasedLiveRow(
  selectedFields: SelectedFields | undefined,
  row: Record<string, unknown>,
): Record<string, unknown> {
  if (selectedFields == null) return row;
  const cursor = { index: 0 };
  const walk = (fields: SelectedFields): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(fields)) {
      if (is(field, Column) || is(field, SQL) || is(field, SQL.Aliased)) {
        out[key] = row[liveFieldAliasAt(cursor.index)];
        cursor.index += 1;
      } else if (field != null && typeof field === "object") {
        out[key] = walk(field as SelectedFields);
      } else {
        out[key] = row[liveFieldAliasAt(cursor.index)];
        cursor.index += 1;
      }
    }
    return out;
  };
  return walk(selectedFields);
}
