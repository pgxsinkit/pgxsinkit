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
   string `customWhere` stays inline (no params), then is ANDed with the SQL part (the inline part has
   no `$n`, so the fragment's `$1…$n` index the returned params). The shape proxy forwards `where` +
   `params[N]` to Electric.
4. **All demo/board/integration filters use the column callback** and Drizzle fragments via `c()`.
   A string `customWhere` remains as an explicit raw escape hatch for predicates that cannot be
   represented by the typed fragment path; the typed path is the default.

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
- **The write-path RLS policies got the same treatment** (the read/write mirror). The board `pgPolicy`
  predicates are now built from the real Drizzle columns (passed in via each table's `extras` callback)
  with operators (`or`/`eq`/`isNotNull`); only the irreducibly-Postgres bits stay `sql` — `auth.uid()`,
  the SECURITY DEFINER membership helper `board_member_team_ids()`, and the admin claims check (no
  Drizzle operator exists for those, and a literal in `eq(col, 'x')` would parameterize, which CREATE
  POLICY DDL cannot carry — so constants use `sql`). drizzle-kit emits the same DDL it did before
  (literals inlined, qualified columns — both fine for Postgres RLS, unlike Electric's bare-column
  rule), so the change is a no-op at the database and the columns are now rename-tracked alongside the
  read filters. Verified: board smoke 5/5 (RLS write tests) after regenerating the board policy migration.
- **The generic `buildSupabaseMembershipNativePolicies` builder in `@pgxsinkit/contracts` followed.**
  Its public API now takes Drizzle **columns and tables** (`containerColumn`, `membershipTable`,
  `membershipSubjectColumn`, `writeGate.containerTable`, …) instead of column/table-name strings, and
  the governed table name (for policy identifiers) is **derived from the container column's table** — so
  the last hand-written string (`tableName`) is gone too. Predicate structure is `and`/`or`/`eq`; `sql`
  remains only for the `IN (subquery)` containment (`inArray` can't wrap a raw subquery), the
  `current_setting(...)::type` JWT-subject expression, and the inlined `'manager'`/`false` literals.
  Call it inside `defineSyncTable`'s `extras` callback (where the governed columns carry their table),
  not the `policies:` array. Verified: membership-fanout + write-state-gating integration suites green
  against real Electric/Postgres after regenerating the integration policy migration (an `ALTER POLICY`
  no-op — same predicate, now qualified). The `buildSupabaseOwnerOrAdminNativePolicies` sibling and its
  raw `…PredicateSqlText` text layer remain string-based by design (the text builder is the lowest
  layer, returning predicate *text* several tables share — not a column reference).
