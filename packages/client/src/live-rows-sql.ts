import { quoteIdentifier } from "@pgxsinkit/contracts";

// ─── Live-read materialization safety (ADR-0032 S2 §4) ───────────────────────────────────────────────
//
// The live-rows seam feeds the compiled SQL of a Drizzle-built select into PGlite's `live` extension,
// which MATERIALISES the query (a temp view + state table it diffs against). Drizzle emits no output
// aliases — it maps result columns positionally — so a JOIN whose tables share a column name (two
// `title`) compiles to a SELECT with duplicate OUTPUT column names. That is legal as a plain one-shot
// query, but the live materialisation fails hard:
//
//     column "title" specified more than once
//
// and even the plain query silently COLLAPSES the same-named columns into one value (the last one wins),
// because rows are keyed by column name. The compiled SQL cannot dedupe itself, so the seam must render
// it into a form that is safe to materialise.

/** The derived-table alias the live-rows seam wraps a materialised query under. Kept unlikely to collide. */
const LIVE_QUERY_TABLE_ALIAS = "__pgx_live";

/**
 * Make a live-read SQL statement SAFE TO MATERIALISE by giving every output column a UNIQUE explicit name.
 *
 * `fields` is the ordered list of unique output aliases — one per output column, in the compiled SQL's
 * column order (Drizzle emits columns depth-first over the select's field keys, which are unique by
 * construction). The statement is wrapped in a derived table with a POSITIONAL column-alias-list:
 *
 *     SELECT * FROM (<sql>) "__pgx_live" ("<a0>", "<a1>", …)
 *
 * A plain `SELECT * FROM (<sql>)` does NOT dedupe — the inner duplicate names survive — so the
 * column-alias-list is what renames every output column POSITIONALLY to a distinct name. The wrapped
 * query materialises cleanly, and its rows come back keyed by the aliases (so same-named source columns
 * keep DISTINCT values). `SELECT *` from the aliased derived table is safe precisely because the alias
 * list has already made the names unique.
 *
 * Returns the SQL UNCHANGED when `fields` is absent or empty — the default path for
 * callers (raw SQL strings, or non-colliding queries that pass no `fields`): they keep name-keyed rows
 * exactly as before. Only a caller that supplies `fields` opts into alias-keyed rows.
 */
export function wrapLiveQueryForMaterialization(sql: string, fields: readonly string[] | undefined): string {
  if (fields == null || fields.length === 0) {
    return sql;
  }
  const aliasList = fields.map((field) => quoteIdentifier(field)).join(", ");
  return `SELECT * FROM (${sql}) ${quoteIdentifier(LIVE_QUERY_TABLE_ALIAS)} (${aliasList})`;
}
