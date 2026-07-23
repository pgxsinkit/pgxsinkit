/**
 * Read the Postgres `SQLSTATE` (the five-character error class, e.g. `"23505"` unique_violation) off a
 * thrown database error.
 *
 * **Why this helper exists — the bun-sql gotcha.** Bun's built-in `SQL`/`sql` driver (what pgxsinkit and
 * its consumers run against Postgres) surfaces the server's SQLSTATE on the error's **`errno`** property.
 * Its **`code`** property is bun's own generic string (`"ERR_POSTGRES_SERVER_ERROR"`), NOT the SQLSTATE —
 * so the intuitive `error.code` read (which worked under `postgres.js` / `pg`, where `code` carried the
 * SQLSTATE) silently returns the wrong thing under bun-sql. Consumers reaching for a stable, driver-agnostic
 * SQLSTATE (to map `23505`→"already exists", `P0001`→a raised app rule, etc.) kept re-deriving this by hand;
 * this is the one canonical extraction.
 *
 * Resolution order, returning the first well-formed SQLSTATE found:
 *  1. `errno` on the error (bun-sql),
 *  2. `code` on the error (postgres.js / node-postgres, and any driver that follows that convention),
 *  3. the same two properties walked down the `cause` chain (a wrapped/re-thrown error).
 *
 * A "well-formed" SQLSTATE is exactly five characters of `[0-9A-Z]` — this is what rejects bun's generic
 * `code` string, an `errno` that is a numeric OS errno, and any other non-SQLSTATE noise. A non-object
 * error (string, number, `null`, `undefined`) yields `undefined`.
 */
export function readSqlState(error: unknown): string | undefined {
  // Guard against a self-referential (or pathologically deep) `cause` chain — walk a bounded number of
  // links, never a `while (true)`.
  const MAX_CAUSE_DEPTH = 16;

  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
    if (!current || typeof current !== "object") {
      return undefined;
    }

    const candidate = current as { errno?: unknown; code?: unknown; cause?: unknown };

    // bun-sql: SQLSTATE on `errno`. postgres.js / pg: SQLSTATE on `code`. Prefer `errno`, fall back to
    // `code`, and accept only a value that is actually shaped like a SQLSTATE.
    const fromErrno = asSqlState(candidate.errno);
    if (fromErrno !== undefined) {
      return fromErrno;
    }
    const fromCode = asSqlState(candidate.code);
    if (fromCode !== undefined) {
      return fromCode;
    }

    // Not on this error — descend into a wrapped cause (Error.cause / a driver's nested original error).
    if (candidate.cause === current) {
      return undefined;
    }
    current = candidate.cause;
  }

  return undefined;
}

/** A value is a SQLSTATE only if it is a string of exactly five `[0-9A-Z]` characters. */
function asSqlState(value: unknown): string | undefined {
  return typeof value === "string" && /^[0-9A-Z]{5}$/u.test(value) ? value : undefined;
}
