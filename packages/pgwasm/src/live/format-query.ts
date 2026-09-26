// Began as a copy of `@electric-sql/pglite` (taken under its PostgreSQL License option, © ElectricSQL
// — see NOTICE). Owned outright (ADR-0062); compatibility with PGlite is an anti-goal — evolve freely.

import { protocolAccessOf } from "../core/internals";
import { parseDescribeStatementResults } from "../core/parse";
import type { Pgwasm, Transaction } from "../interface";
import type { BackendMessage } from "../protocol/wire/messages";
import { serialize } from "../protocol/wire/serializer";
import { TEXT } from "../types";

/**
 * Inline a query's parameters as SQL literals (Postgres' own `format(%L)`), for statements that cannot
 * take parameters (a `CREATE VIEW`). The tables the query references must exist, since the parameter
 * types come from describing it. `tx` runs the final `format()` inside a transaction.
 */
export async function formatQuery(
  pg: Pgwasm,
  query: string,
  params?: readonly unknown[] | null,
  tx?: Transaction | Pgwasm,
): Promise<string> {
  if (!params || params.length === 0) {
    return query;
  }
  const wire = protocolAccessOf(pg);
  const messages: BackendMessage[] = [];
  try {
    await wire.execProtocol(serialize.parse({ text: query }), { persist: false });
    messages.push(...(await wire.execProtocol(serialize.describe({ type: "S" }), { persist: false })).messages);
  } finally {
    messages.push(...(await wire.execProtocol(serialize.sync(), { persist: false })).messages);
  }
  const dataTypeIDs = parseDescribeStatementResults(messages);

  // $1, $2… become %1$L, %2$L…: the `$` makes format() positional; a bare `%1L` would mean "width 1"
  // and consume arguments in order, binding the wrong value to a repeated or reordered placeholder.
  const subbedQuery = query.replace(/\$([0-9]+)/g, (_, num: string) => `%${num}$L`);
  const runner = tx ?? pg;
  const result = await runner.query<{ query: string }>(
    `SELECT format($1, ${params.map((_, i) => `$${i + 2}`).join(", ")}) as query`,
    [subbedQuery, ...params],
    { paramTypes: [TEXT, ...dataTypeIDs] },
  );
  const formatted = result.rows[0]?.query;
  if (formatted === undefined) throw new Error("format() returned no row");
  return formatted;
}
