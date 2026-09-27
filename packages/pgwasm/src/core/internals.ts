/**
 * Wire-level access to a pgwasm instance, kept off its public type. `@pgxsinkit/pgwasm/protocol` and the
 * `live` extension reach it through this registry; pgwasm is bundled with code splitting, so every
 * entry point shares this one module and its map.
 */

import type { BuildCapabilities } from "../build/seam";
import type { BackendMessage, NoticeMessage } from "../protocol/wire/messages";

export interface ExecProtocolOptions {
  /** Persist storage after the message, as a statement does. Defaults to `true`. */
  readonly persist?: boolean;
  /** Throw the first ErrorResponse. Defaults to `true`. */
  readonly throwOnError?: boolean;
  readonly onNotice?: (notice: NoticeMessage) => void;
}

export interface ExecProtocolStreamOptions {
  /** Persist storage after the message. Defaults to `true`. */
  readonly persist?: boolean;
  /** Every backend byte, as it arrives. A chunk is only valid during the call: copy it to keep it. */
  readonly onRawData: (data: Uint8Array) => void;
}

export interface ExecProtocolResult {
  readonly messages: BackendMessage[];
  readonly data: Uint8Array;
}

/** What `protocol(pg)` returns. */
export interface PgwasmProtocol {
  /** Run frontend message bytes; the parsed backend messages and the raw reply. */
  execProtocol(message: Uint8Array, options?: ExecProtocolOptions): Promise<ExecProtocolResult>;
  /** Run frontend message bytes; the parsed backend messages only. */
  execProtocolStream(message: Uint8Array, options?: ExecProtocolOptions): Promise<BackendMessage[]>;
  /** Run frontend message bytes; the raw reply. Notifications and errors are still dispatched. */
  execProtocolRaw(message: Uint8Array, options?: Pick<ExecProtocolOptions, "persist">): Promise<Uint8Array>;
  /**
   * Run frontend message bytes and stream the raw reply. When nothing is pending and the build has
   * `synchronousExchange`, the whole reply is delivered before this call returns its promise — what a
   * tool driving it from inside a blocking wasm callback (pg_dump) needs.
   */
  execProtocolRawStream(message: Uint8Array, options: ExecProtocolStreamOptions): Promise<void>;
  /**
   * Run `fn` with the database's session to itself, for a tool whose exchanges must not interleave with
   * anything else (pg_dump). It waits for, then holds, the locks a `transaction()` holds, and the query
   * lock: no query, exec, transaction, listen, live-query refresh or Store backup of this database runs
   * until `fn` settles.
   *
   * What `fn` sends with the `execProtocol*` methods is its own responsibility: no transaction is begun
   * or ended around it, and a message is persisted only as its options say. Inside `fn`, use only these
   * wire methods: the database's query methods wait for the locks `fn` holds, so awaiting one deadlocks.
   */
  runExclusiveSession<T>(fn: () => Promise<T>): Promise<T>;
  /** The build's capabilities, e.g. to check `synchronousExchange` before relying on it. */
  readonly capabilities: BuildCapabilities;
}

const registry = new WeakMap<object, PgwasmProtocol>();

export function registerProtocolAccess(pg: object, access: PgwasmProtocol): void {
  registry.set(pg, access);
}

/** The wire-level access of a pgwasm instance. Throws for anything else. */
export function protocolAccessOf(pg: object): PgwasmProtocol {
  const access = registry.get(pg);
  if (access === undefined) {
    throw new TypeError("Not a pgwasm instance (created by createPgwasm).");
  }
  return access;
}

/**
 * The strict sync of a database whose data directory is an OPFS-repacked store, registered by
 * `createOpfsPgwasm` and run by `strictSync(pg)` from `@pgxsinkit/pgwasm/opfs`.
 */
const strictSyncs = new WeakMap<object, () => void>();

export function registerStrictSync(pg: object, strictSync: () => void): void {
  strictSyncs.set(pg, strictSync);
}

/** The registered strict sync of `pg`, or `undefined` when it has none (not an OPFS-repacked store). */
export function strictSyncOf(pg: object): (() => void) | undefined {
  return strictSyncs.get(pg);
}
