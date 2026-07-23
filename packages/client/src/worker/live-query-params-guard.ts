// A defensive guard against PGlite upstream bug https://github.com/electric-sql/pglite/issues/1055 on the
// live-query path. WHY this exists:
//
// PGlite 0.5.4's `live.query` / `live.incrementalQuery` inline bound params into a `CREATE TEMP VIEW`
// (via `formatQuery`) WHENEVER `params.length > 0`. That inlining rewrites every `$N` placeholder with
// `sql.replace(/\$([0-9]+)/g, (_, n) => "%" + n + "L")` — emitting `%NL`, which is Postgres `format()`'s
// "pad to width N, consume the NEXT argument sequentially" directive, NOT the positional `%N$L` it means to
// emit. Empirically confirmed consequences:
//   - out-of-order placeholders (`… $2 … $1 …`) silently bind params in TEXTUAL order → wrong rows;
//   - a repeated placeholder (`$1 … $1`) throws `too few arguments for format()`;
//   - a skipped placeholder silently mis-binds.
// The ONLY input shape under which PGlite's broken inlining is still correct: the placeholders, read in
// textual order, are exactly `$1, $2, …, $n` (n = params.length) — each appearing exactly once, strictly
// ascending. Drizzle-compiled SQL always satisfies this (its serializer numbers params in the same
// left-to-right pass that emits them); hand-written raw SQL may not.
//
// So this guard fails LOUDLY at the client boundary for any other shape, turning a silent wrong-rows /
// cryptic-`format()` failure into an actionable error naming the upstream bug. It can be DELETED once
// transcrobes/pgxsinkit pin a PGlite release whose `formatQuery` emits the positional `%N$L`.

/**
 * Throw if `sql` + `params` would hit PGlite bug #1055's broken param inlining (see the module header).
 *
 * `params.length === 0` returns immediately: PGlite skips `formatQuery` entirely in that case, so any `$N`
 * tokens are Postgres's own concern, not this guard's. Otherwise the SQL is scanned with the SAME regex
 * PGlite's rewrite uses (`/\$(\d+)/g`) — deliberately, so the guard sees EXACTLY the tokens PGlite would
 * touch. That includes a `$1` sitting inside a string literal: PGlite would corrupt that too, so a loud
 * false positive here is a feature, not a bug — it flags SQL PGlite cannot inline safely regardless.
 *
 * Safe iff the collected numbers (in textual order) are exactly `[1, 2, …, params.length]`. Anything else —
 * out-of-order, repeated, skipped, or a count mismatch in either direction — throws.
 */
export function assertLiveQueryParamsSafe(sql: string, params: readonly unknown[]): void {
  // No params → PGlite never calls formatQuery, so its broken inlining never runs. Placeholders without
  // params are Postgres's problem to report, not this guard's.
  if (params.length === 0) return;

  // The SAME regex PGlite's `formatQuery` applies — so we see exactly the tokens its rewrite would touch,
  // including any `$N` inside a string literal (which PGlite would corrupt too; flagging it is intentional).
  const numbers: number[] = [];
  for (const match of sql.matchAll(/\$(\d+)/g)) numbers.push(Number(match[1]));

  const expected = params.length;
  const safe = numbers.length === expected && numbers.every((n, i) => n === i + 1);
  if (safe) return;

  const found = numbers.length === 0 ? "(none)" : numbers.map((n) => `$${n}`).join(", ");
  throw new Error(
    `[pgxsinkit] live query hits PGlite bug #1055 ` +
      `(https://github.com/electric-sql/pglite/issues/1055): its live-query param inlining binds $N ` +
      `placeholders SEQUENTIALLY (in textual order), not positionally, so anything but a strictly ` +
      `ascending $1..$n each used once silently mis-binds or throws. Found placeholders [${found}] for ` +
      `${expected} param${expected === 1 ? "" : "s"}, expected exactly [$1..$${expected}]. Renumber the ` +
      `placeholders to a strictly sequential $1..$${expected}, each used once — or pass the query as a ` +
      `Drizzle builder, which always compiles to that shape.`,
  );
}
