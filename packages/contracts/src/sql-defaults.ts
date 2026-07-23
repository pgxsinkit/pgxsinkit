import { sql, type SQL } from "drizzle-orm";

/**
 * The BODY of the canonical microsecond clock — `clock_timestamp()` epoch microseconds as BIGINT.
 * This text is the SINGLE source for the `public.pgxsinkit_clock_us()` function body rendered by the
 * server's utilities migration ({@link renderPgxsinkitUtilitiesMigration}) and NOTHING else. No column
 * DEFAULT and no generated apply-function DDL may embed this expression — every surface CALLS the
 * function ({@link CLOCK_US_CALL_SQL_TEXT} / {@link clockMicrosecondsSql}), so the semantic choices
 * (`clock_timestamp()` over `now()`; `FLOOR` + `BIGINT`) live in exactly one reviewable body.
 */
export const NOW_MICROSECONDS_SQL_TEXT = "CAST(FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000000) AS BIGINT)";

/**
 * The CALL form of the canonical microsecond clock, for string-rendering contexts (the apply-function
 * generator's PL/pgSQL literals). Deliberately `clock_timestamp()` (via the function body), never
 * `now()`/`transaction_timestamp()`: `now()` freezes at transaction start, but LWW/audit ordering of a
 * multi-row apply within one transaction needs an ADVANCING clock. The DB function is the canonical
 * home — never inline the expression at a call site.
 */
export const CLOCK_US_CALL_SQL_TEXT = "public.pgxsinkit_clock_us()";

/**
 * The canonical microsecond clock as a Drizzle fragment, for `.default(...)` column positions — the
 * CALL form `public.pgxsinkit_clock_us()`, never the inline expression. Deliberately `clock_timestamp()`
 * (inside the function), never `now()`/`transaction_timestamp()`: `now()` freezes at transaction start,
 * whereas LWW/audit ordering of a multi-row apply within one transaction needs an advancing clock. The
 * DB function (installed by the utilities migration) is the canonical home; never inline the expression.
 */
export const clockMicrosecondsSql: SQL = sql.raw(CLOCK_US_CALL_SQL_TEXT);
