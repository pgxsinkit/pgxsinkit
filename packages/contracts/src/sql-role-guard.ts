/**
 * The single role-existence guard used by every pgxsinkit-emitted GRANT/REVOKE.
 *
 * pgxsinkit artifacts are portable: the same migration runs on a Supabase-shaped cluster (where
 * `anon`/`authenticated`/`service_role` exist), on a plain Postgres, and on a PGlite test lane
 * (where none of them do). A bare `REVOKE … FROM anon` is a hard error where the role is absent, so
 * every role-scoped grant/revoke is wrapped in a `DO $$ … IF EXISTS (SELECT 1 FROM pg_roles …)`
 * block and simply does nothing there.
 *
 * Two callers share this one definition — `buildRegistryGovernanceSql` (@pgxsinkit/schema, table
 * grants) and the apply-function ACL (@pgxsinkit/server, ADR-0054) — so the guard idiom cannot
 * drift between the artifacts that carry a deployment's authorization posture.
 */

import { escapeSqlLiteral } from "./sql-identifier";

/**
 * Wrap one already-rendered SQL statement (no trailing semicolon) in the role-existence guard.
 *
 * `statementSql` is embedded as a PL/pgSQL string literal, so it is escaped as a whole — callers pass
 * ordinary SQL with real single quotes and real double-quoted identifiers.
 */
export function buildRoleGuardedStatement(roleName: string, statementSql: string): string {
  return [
    "DO $$",
    "BEGIN",
    `  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${escapeSqlLiteral(roleName)}') THEN`,
    `    EXECUTE '${escapeSqlLiteral(statementSql)}';`,
    "  END IF;",
    "END;",
    "$$;",
  ].join("\n");
}
