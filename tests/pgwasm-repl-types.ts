// Type-level contract, checked by `bun run typecheck` (this file is in the root program): the REPL's `pg`
// prop takes a pgwasm database and a pgxsinkit client's `replAdapter(client)` as they are, with no cast.

import { replAdapter } from "@pgxsinkit/client";
import type { Pgwasm } from "@pgxsinkit/pgwasm";

import type { ReplDatabase } from "../packages/pgwasm-repl/src/types";

export function replDatabases(pg: Pgwasm, client: Parameters<typeof replAdapter>[0]): ReplDatabase[] {
  const fromPgwasm: ReplDatabase = pg;
  const fromClient: ReplDatabase = replAdapter(client);
  // @ts-expect-error a database needs `exec` as well as `query`
  const withoutExec: ReplDatabase = { query: (sql: string) => pg.query(sql) };
  return [fromPgwasm, fromClient, withoutExec];
}
