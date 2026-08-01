import { buildRoleGuardedStatement, NOW_MICROSECONDS_SQL_TEXT, quoteIdentifier } from "@pgxsinkit/contracts";

/**
 * ADR-0054 decision 5: `pgxsinkit_clock_us()` is hardened in the same pass as the apply function — no
 * pgxsinkit-emitted function relies on default privileges. Unlike the apply function it is a harmless
 * monotonic-clock read whose legitimate callers INCLUDE RLS-context sessions (a column DEFAULT
 * evaluates as whatever role is writing the row), so PUBLIC is revoked and the Supabase trio is
 * granted back explicitly, through the shared role-existence guard so the migration stays portable.
 */
const CLOCK_US_SIGNATURE = "public.pgxsinkit_clock_us()";
const CLOCK_US_GRANTEES = ["anon", "authenticated", "service_role"] as const;

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
$$;

-- Deny by default, then grant back deliberately (ADR-0054 decision 5). Stated on every install: a
-- first install on a Supabase-shaped cluster otherwise picks up ALTER DEFAULT PRIVILEGES ... GRANT ALL
-- ON FUNCTIONS TO anon, authenticated, service_role, so the posture is declared here, never inherited.
-- The grants are real: a column DEFAULT calling this clock is evaluated as whatever role writes the row.
REVOKE ALL ON FUNCTION ${CLOCK_US_SIGNATURE} FROM PUBLIC;

${CLOCK_US_GRANTEES.map((role) =>
  buildRoleGuardedStatement(role, `GRANT EXECUTE ON FUNCTION ${CLOCK_US_SIGNATURE} TO ${quoteIdentifier(role)}`),
).join("\n\n")}`;
}
