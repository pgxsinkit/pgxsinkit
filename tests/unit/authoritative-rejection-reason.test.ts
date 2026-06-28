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

  it("falls back to a generic reason for any other / unknown error", () => {
    expect(toPublicRejectionReason(pgError("42P01", 'relation "secret_table" does not exist'))).not.toContain(
      "secret_table",
    );
    expect(toPublicRejectionReason(new Error("kaboom with internals"))).not.toContain("kaboom");
    expect(toPublicRejectionReason(undefined)).toBe("The write was rejected by a server rule.");
  });
});
