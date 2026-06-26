# Row filters as type-safe Drizzle fragments → parameterized Electric `where`

Status: accepted (2026-06-26)

A registry's read-path row filter (`customWhere`) returned a raw SQL **string** that the proxy inlined
verbatim into the Electric shape `where`. Every filter therefore hand-quoted identifiers (`"team_id"`)
and hand-escaped request-derived values (`escapeSqlLiteral(claims.sub)`). Two problems:

- **Injection surface.** Every filter is responsible for escaping its own leaves; the security of the
  read path rests on each author remembering `escapeSqlLiteral`. The `customWhere` doc literally warns
  that an unescaped value is "a SQL-injection vector."
- **Drift.** The column names in a filter are free-text strings unconnected to the Drizzle schema, so a
  column rename silently breaks the filter (no compile error), and the read filter can diverge from the
  table it filters and from the matching write-path RLS predicate.

`@pgxsinkit/contracts` already deals in Drizzle table objects (`defineSyncTable` wraps `pgTable`), so the
columns are right there — the filter just wasn't using them.

## What Electric's `where` grammar actually accepts (verified)

A spike fired Drizzle-generated clauses at a real Electric and isolated two hard constraints:

- **Parameterized `where` works.** `where = "x" = $1` + `params[1]=…` returns rows — Electric (≥1.5)
  binds positional params, and Drizzle's `$n`/params output maps onto them directly.
- **Columns must be _plain_ (unqualified).** Drizzle qualifies by default (`"work_items"."workspace_id"`),
  and Electric rejects that: `400 — "Expected a plain column reference"`. Bare (`"workspace_id"`) is
  required. Self-contained (non-correlated) subqueries keep bare names unambiguous; a **correlated**
  subquery would need qualification Electric rejects, so it remains out of scope.
- Enum columns still need an explicit `::text` cast (unchanged Electric requirement).

## Decision

1. **`customWhere` may return a Drizzle `SQL` fragment** (`string | SQL | null`). A returned `SQL` is
   serialized to a parameterized `where`; request-derived values become **bound `$n` params**, never
   hand-escaped literals.
2. **`c(column)`** (exported from `@pgxsinkit/contracts`) emits a **bare** quoted identifier from a
   Drizzle column — rename-safe and existence-checked at compile time, but plain on the wire as Electric
   demands. Authors reference columns through `c()` instead of the qualifying Drizzle column.
3. **`buildRowFilterShape(filter, claims, params) → { where, params }`** composes the filter: a SQL
   `customWhere` is serialized (via `PgDialect`) and its params returned; `ownership`/`shared` and a
   string `customWhere` stay inline (no params), composed exactly as `buildRowFilterWhere` does, then
   ANDed with the SQL part (the inline part has no `$n`, so the fragment's `$1…$n` index the returned
   params). The shape proxy forwards `where` + `params[N]` to Electric.
4. **All demo/board/integration filters migrated** to Drizzle fragments via `c()`. `buildRowFilterWhere`
   and the legacy string `customWhere` path are unchanged, so existing string filters and their tests
   keep working — this is additive.

## Consequences

- The Drizzle path has **zero hand-escaping**: identifiers and structure come from the schema, values
  are bound params. `escapeSqlLiteral` is no longer reached by the migrated filters (it stays for the
  raw-string escape hatch).
- Read filters now **track the schema**: a column rename is a compile error, and the filter is built
  from the same table objects as the write-side RLS, so they cannot silently drift.
- The **raw-string `customWhere` remains** as the escape hatch for predicates Electric needs in a shape
  Drizzle can't express; correlated subqueries are explicitly unsupported (qualification Electric rejects).
- `board-sync`'s cold-start import is marginally heavier (`PgDialect` enters its graph); the board smoke
  retries the documented cold-start transient (a local-compose artifact — a managed BaaS keeps functions
  warm). Verified end-to-end: board smoke 5/5 from a cold boot, all implementation integration suites
  green through real Electric.
