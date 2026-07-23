import { NOW_MICROSECONDS_SQL_TEXT } from "@pgxsinkit/contracts";

/**
 * The canonical microsecond-clock DB function `public.pgxsinkit_clock_us()` — the ONE home for the
 * `clock_timestamp()`-epoch-microseconds semantics. Every surface (column DEFAULTs, the generated
 * apply function's managed `nowMicroseconds` fields, the operations-log server stamp) CALLS this
 * function; nothing inlines the expression. This migration installs it, and — because the generated
 * apply function calls it — it MUST be the FIRST folder in any consumer's migration chain (before the
 * schema and the sync-artifact folder).
 *
 * The body is composed from the single source {@link NOW_MICROSECONDS_SQL_TEXT} in @pgxsinkit/contracts
 * (CREATE FUNCTION is the sanctioned raw-SQL case — Drizzle cannot express a PL/pgSQL/SQL function body).
 */
export function renderPgxsinkitUtilitiesMigration(): string {
  return `-- The pgxsinkit canonical microsecond clock. Deliberately clock_timestamp() (advances WITHIN a
-- transaction — LWW/audit ordering of multi-row applies depends on it), never now()/transaction_timestamp()
-- (frozen at tx start). FLOOR + BIGINT: whole microseconds since epoch.
CREATE OR REPLACE FUNCTION public.pgxsinkit_clock_us()
  RETURNS bigint
  LANGUAGE sql
  VOLATILE
AS $$
  SELECT ${NOW_MICROSECONDS_SQL_TEXT}
$$;`;
}
