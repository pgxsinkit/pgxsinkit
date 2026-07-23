import { describe, expect, it } from "bun:test";

import { readSqlState } from "../../packages/server/src/sql-state";

// The SQLSTATE extraction pgxsinkit consumers need against bun-sql — where the server's five-char
// SQLSTATE lands on `errno`, NOT `code` (bun's `code` is its own generic "ERR_POSTGRES_SERVER_ERROR").
describe("readSqlState", () => {
  it("reads the SQLSTATE off a bun-sql error's `errno`", () => {
    // A bun-sql server error: SQLSTATE on errno, bun's generic tag on code.
    expect(readSqlState({ errno: "23505", code: "ERR_POSTGRES_SERVER_ERROR" })).toBe("23505");
  });

  it("falls back to `code` for a postgres.js / pg-style error", () => {
    expect(readSqlState({ code: "23503" })).toBe("23503");
  });

  it("prefers `errno` over `code` when both are well-formed", () => {
    expect(readSqlState({ errno: "P0001", code: "23505" })).toBe("P0001");
  });

  it("accepts a raised-application SQLSTATE (P0001)", () => {
    expect(readSqlState({ errno: "P0001" })).toBe("P0001");
  });

  it("walks the `cause` chain to find a nested SQLSTATE", () => {
    const wrapped = new Error("apply failed");
    (wrapped as { cause?: unknown }).cause = { errno: "40001" };
    expect(readSqlState(wrapped)).toBe("40001");
  });

  it("walks multiple `cause` links", () => {
    const inner = { code: "23514" };
    const middle = { message: "middle", cause: inner };
    const outer = { message: "outer", cause: middle };
    expect(readSqlState(outer)).toBe("23514");
  });

  it("ignores bun's generic `code` when there is no real SQLSTATE anywhere", () => {
    expect(readSqlState({ code: "ERR_POSTGRES_SERVER_ERROR" })).toBeUndefined();
  });

  it("ignores a numeric OS errno (not a five-char SQLSTATE)", () => {
    expect(readSqlState({ errno: -111, code: "ECONNREFUSED" })).toBeUndefined();
  });

  it("rejects malformed SQLSTATE-like values", () => {
    expect(readSqlState({ errno: "2350" })).toBeUndefined(); // too short
    expect(readSqlState({ errno: "235055" })).toBeUndefined(); // too long
    expect(readSqlState({ errno: "23-05" })).toBeUndefined(); // wrong charset
  });

  it("returns undefined for non-object errors", () => {
    expect(readSqlState(undefined)).toBeUndefined();
    expect(readSqlState(null)).toBeUndefined();
    expect(readSqlState("23505")).toBeUndefined();
    expect(readSqlState(23505)).toBeUndefined();
  });

  it("terminates on a self-referential cause chain", () => {
    const cyclic: { errno?: unknown; cause?: unknown } = { message: "no sqlstate" } as never;
    cyclic.cause = cyclic;
    expect(readSqlState(cyclic)).toBeUndefined();
  });
});
