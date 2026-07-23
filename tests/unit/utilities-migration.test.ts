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
});
