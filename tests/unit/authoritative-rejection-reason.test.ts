import { describe, expect, it } from "bun:test";

import { toPublicRejectionReason } from "../../packages/server/src/mutations/route";

// ADR-0022 §4 — a `rejected` ack's `rejectionReason` is success-path copy the app shows to users, so it
// must NOT echo raw DB internals (constraint names, the offending VALUES/PII, schema, hints). A deliberate
// app `RAISE` IS the friendly-message channel and passes through. This is the regression guard for the
// info-leak the review flagged: before the fix the reason was `formatBatchExecutionError` (raw).

/** A pg-style error carrying a SQLSTATE `code` (+ the fields a raw formatter would have leaked). */
function pgError(code: string, message: string, detail?: string): Error {
  return Object.assign(new Error(message), { code, ...(detail ? { detail } : {}) });
}

/**
 * A bun-sql-style error: the SQLSTATE is on `errno`, and `code` is bun's own generic tag — the exact
 * shape this project's runtime driver throws. Before wiring `readSqlState` in, `toPublicRejectionReason`
 * read `code` and so classified every one of these into the generic fallback.
 */
function bunError(errno: string, message: string, detail?: string): Error {
  return Object.assign(new Error(message), {
    errno,
    code: "ERR_POSTGRES_SERVER_ERROR",
    ...(detail ? { detail } : {}),
  });
}

describe("toPublicRejectionReason (ADR-0022 §4 — no raw DB leak)", () => {
  it("passes through an app-authored RAISE message (SQLSTATE P0001 / custom P0… class)", () => {
    expect(toPublicRejectionReason(pgError("P0001", "cohort is full"))).toBe("cohort is full");
    expect(toPublicRejectionReason(pgError("P0123", "no seats remaining"))).toBe("no seats remaining");
  });

  it("returns a generic, code-keyed message for built-in integrity violations — never the raw text", () => {
    const unique = toPublicRejectionReason(
      pgError(
        "23505",
        'duplicate key value violates unique constraint "seats_pkey"',
        "Key (id)=(00000000-0000-0000-0000-000000000001) already exists.",
      ),
    );
    // The leaky bits must NOT appear in the client-facing reason.
    expect(unique).not.toContain("constraint");
    expect(unique).not.toContain("seats_pkey");
    expect(unique).not.toContain("00000000-0000-0000-0000-000000000001");
    expect(unique).toMatch(/uniqueness/i);

    expect(toPublicRejectionReason(pgError("23514", 'violates check constraint "seats_capacity"'))).not.toContain(
      "seats_capacity",
    );
    // An unmapped class-23 code still returns a generic integrity message.
    expect(toPublicRejectionReason(pgError("23999", "violates something internal"))).not.toContain("internal");
  });

  it("maps SQLSTATE PXS01 (self-verifying apply-fn drift, ADR-0030) to the actionable operator message", () => {
    // The self-verifying apply function raises PXS01 when its installed fingerprint does not match the
    // server's registry/codegen — the drift the deleted startup verify used to catch. It must surface the
    // regenerate-and-apply guidance, not the generic rejection fallback. Covered on both driver shapes
    // (postgres.js `code`, bun-sql `errno`) since `readSqlState` resolves either.
    for (const drift of [
      pgError("PXS01", "pgxsinkit_apply_mutations is stale: the installed apply-function fingerprint ..."),
      bunError("PXS01", "pgxsinkit_apply_mutations is stale: the installed apply-function fingerprint ..."),
    ]) {
      const reason = toPublicRejectionReason(drift);
      expect(reason).toMatch(/out of date/i);
      expect(reason).toMatch(/pgxsinkit-generate/);
      // It must not echo the raw internal message verbatim.
      expect(reason).not.toContain("pgxsinkit_apply_mutations is stale");
    }
  });

  it("falls back to a generic reason for any other / unknown error", () => {
    expect(toPublicRejectionReason(pgError("42P01", 'relation "secret_table" does not exist'))).not.toContain(
      "secret_table",
    );
    expect(toPublicRejectionReason(new Error("kaboom with internals"))).not.toContain("kaboom");
    expect(toPublicRejectionReason(undefined)).toBe("The write was rejected by a server rule.");
  });

  // The runtime driver (bun-sql) puts the SQLSTATE on `errno`, not `code` — the reason `readSqlState` is
  // now wired in. Without it, every case below fell to the generic fallback.
  it("classifies a bun-sql app-authored RAISE (SQLSTATE on `errno`) and surfaces its message", () => {
    expect(toPublicRejectionReason(bunError("P0001", "cohort is full"))).toBe("cohort is full");
    expect(toPublicRejectionReason(bunError("P0123", "no seats remaining"))).toBe("no seats remaining");
  });

  it("classifies a bun-sql integrity violation (SQLSTATE on `errno`) — friendly, never the raw text", () => {
    const unique = toPublicRejectionReason(
      bunError(
        "23505",
        'duplicate key value violates unique constraint "seats_pkey"',
        "Key (id)=(00000000-0000-0000-0000-000000000001) already exists.",
      ),
    );
    expect(unique).not.toContain("seats_pkey");
    expect(unique).not.toContain("00000000-0000-0000-0000-000000000001");
    expect(unique).toMatch(/uniqueness/i);
  });

  it("classifies a bun-sql SQLSTATE carried on a nested `cause`", () => {
    const wrapped = Object.assign(new Error("apply batch failed"), {
      cause: bunError("23514", 'violates check constraint "seats_capacity"'),
    });
    const reason = toPublicRejectionReason(wrapped);
    expect(reason).not.toContain("seats_capacity");
    expect(reason).toMatch(/validation rule/i);
  });
});
