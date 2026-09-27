/**
 * Wire-level access to a pgwasm instance, for tools that speak the Postgres protocol themselves
 * (pg_dump, a REPL, a benchmark). Everyday code uses `query`, `exec` and `transaction` instead: the
 * `execProtocol*` calls bypass pgwasm's query locks. A tool whose exchanges must not interleave with
 * anything else runs them inside `runExclusiveSession`, which holds those locks.
 */

import { protocolAccessOf, type PgwasmProtocol } from "../core/internals";
import type { Pgwasm } from "../interface";

export type {
  ExecProtocolOptions,
  ExecProtocolResult,
  ExecProtocolStreamOptions,
  PgwasmProtocol,
} from "../core/internals";
export { Parser, serialize, messages, Modes } from "./wire";
export type { BindOpts, ExecOpts, LegalValue, MessageCallback, Mode, ParseOpts, PortalOpts } from "./wire";
export type { BackendMessage } from "./wire/messages";

/** The wire-level methods of a database created by `createPgwasm`. */
export function protocol(pg: Pgwasm): PgwasmProtocol {
  return protocolAccessOf(pg);
}
