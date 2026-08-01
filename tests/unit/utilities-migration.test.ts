import { describe, expect, it } from "bun:test";

import { NOW_MICROSECONDS_SQL_TEXT } from "@pgxsinkit/contracts";
import { renderPgxsinkitUtilitiesMigration } from "@pgxsinkit/server";

describe("pgxsinkit utilities migration render", () => {
  const sql = renderPgxsinkitUtilitiesMigration();

  it("declares the canonical pgxsinkit_clock_us() function signature", () => {
    expect(sql).toContain("CREATE OR REPLACE FUNCTION public.pgxsinkit_clock_us()");
    expect(sql).toContain("RETURNS bigint");
    // SQL + VOLATILE: VOLATILE so the planner never caches a single value across rows of one statement
    // (clock_timestamp() must be re-read per call), which is the whole point over now().
    expect(sql).toContain("LANGUAGE sql");
    expect(sql).toContain("VOLATILE");
  });

  it("composes the function body from the single contracts source, not a hand copy", () => {
    // The body IS the one canonical expression, interpolated — so the clock semantics can never drift
    // between the function and the contracts constant.
    expect(sql).toContain(`SELECT ${NOW_MICROSECONDS_SQL_TEXT}`);
    expect(sql).toContain("clock_timestamp()");
  });

  // ADR-0054 decision 5: no pgxsinkit-emitted function relies on default privileges. The clock is a
  // harmless monotonic read whose callers legitimately include RLS-context sessions (a column DEFAULT
  // is evaluated as whatever role writes the row), so the Supabase trio is granted back EXPLICITLY —
  // through the shared role-existence guard, so the migration still applies on PGlite/plain Postgres.
  it("revokes PUBLIC and grants the Supabase trio back through the role-existence guard", () => {
    expect(sql).toContain("REVOKE ALL ON FUNCTION public.pgxsinkit_clock_us() FROM PUBLIC;");

    for (const role of ["anon", "authenticated", "service_role"]) {
      expect(sql).toContain(`IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN`);
      expect(sql).toContain(`EXECUTE 'GRANT EXECUTE ON FUNCTION public.pgxsinkit_clock_us() TO "${role}"';`);
    }

    // Revoke first, grant after — the order that makes the posture converge on every install.
    expect(sql.indexOf("REVOKE ALL ON FUNCTION")).toBeLessThan(sql.indexOf("GRANT EXECUTE ON FUNCTION"));
  });
});
