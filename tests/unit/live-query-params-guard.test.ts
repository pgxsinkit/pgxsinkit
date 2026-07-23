// Unit coverage for the live-query params guard — the defensive boundary against PGlite upstream bug
// electric-sql/pglite#1055 (see live-query-params-guard.ts for the full mechanics). The guard only ever
// throws for the input shapes PGlite's broken `%NL` inlining silently corrupts (out-of-order / repeated /
// skipped placeholders, or a placeholder-count vs params-length mismatch); the ONE still-correct shape —
// strictly ascending `$1..$n`, each used once, n = params.length — must pass untouched, as must any query
// with zero params (PGlite skips `formatQuery` entirely there).

import { describe, expect, it } from "bun:test";

import { assertLiveQueryParamsSafe } from "../../packages/client/src/worker/live-query-params-guard";

describe("assertLiveQueryParamsSafe", () => {
  it("accepts empty params with arbitrary SQL, even weird $ tokens (PGlite skips formatQuery there)", () => {
    // params.length === 0 → PGlite never calls formatQuery, so placeholders are Postgres's problem, not ours.
    expect(() => assertLiveQueryParamsSafe("select * from t where c = $1", [])).not.toThrow();
    expect(() => assertLiveQueryParamsSafe("select '$5 literal $2' as note", [])).not.toThrow();
    expect(() => assertLiveQueryParamsSafe("select 1", [])).not.toThrow();
  });

  it("accepts a strictly sequential $1..$n matching params length", () => {
    expect(() => assertLiveQueryParamsSafe("select * from t where a = $1 and b = $2", ["x", "y"])).not.toThrow();
    expect(() => assertLiveQueryParamsSafe("select $1", [42])).not.toThrow();
  });

  it("accepts two-digit placeholders ($10+) — the regex must not split $10 into $1", () => {
    const params = Array.from({ length: 12 }, (_, i) => i);
    const sql = params.map((_, i) => `c${i} = $${i + 1}`).join(" and ");
    expect(() => assertLiveQueryParamsSafe(`select * from t where ${sql}`, params)).not.toThrow();
  });

  it("throws for out-of-order placeholders ($2 before $1)", () => {
    expect(() => assertLiveQueryParamsSafe("select * from t where a = $2 and b = $1", ["x", "y"])).toThrow(/1055/);
  });

  it("throws for a repeated placeholder ($1 used twice with 1 param)", () => {
    expect(() => assertLiveQueryParamsSafe("select * from t where a = $1 or b = $1", ["x"])).toThrow(/1055/);
  });

  it("throws for a skipped placeholder ($2 only, 2 params)", () => {
    expect(() => assertLiveQueryParamsSafe("select * from t where a = $2", ["x", "y"])).toThrow(/1055/);
  });

  it("throws when placeholder count exceeds params length", () => {
    expect(() => assertLiveQueryParamsSafe("select * from t where a = $1 and b = $2", ["x"])).toThrow(/1055/);
  });

  it("throws when params length exceeds placeholder count", () => {
    expect(() => assertLiveQueryParamsSafe("select * from t where a = $1", ["x", "y"])).toThrow(/1055/);
  });

  it("produces a [pgxsinkit]-prefixed error naming issue 1055 and the URL", () => {
    let message = "";
    try {
      assertLiveQueryParamsSafe("select * from t where a = $2 and b = $1", ["x", "y"]);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toStartWith("[pgxsinkit]");
    expect(message).toContain("1055");
    expect(message).toContain("github.com/electric-sql/pglite/issues/1055");
  });
});
