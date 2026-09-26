// Began as a copy of `@electric-sql/pglite` (taken under its PostgreSQL License option, © ElectricSQL
// — see NOTICE). Owned outright (ADR-0062); compatibility with PGlite is an anti-goal — evolve freely.

import type { BuildIdentity, DebugLevel, FilesystemKind, PostgresBuild, ServerExtension } from "./build/seam";
import type { BaseFilesystem } from "./fs/base-filesystem";
import type { NoticeMessage } from "./protocol/wire/messages";

export type { DebugLevel } from "./build/seam";

/** `object` rows keyed by column name, or `array` rows in column order. */
export type RowMode = "array" | "object";

/** A result row when no row type is given. */
export type Row = Record<string, unknown>;

/** Per-query parsers, by type OID. */
export interface ParserOptions {
  [pgType: number]: (value: string, typeId?: number) => unknown;
}

/** Per-query serializers, by type OID. */
export interface SerializerOptions {
  [pgType: number]: (value: unknown) => string;
}

export interface QueryOptions {
  readonly rowMode?: RowMode;
  readonly parsers?: ParserOptions;
  readonly serializers?: SerializerOptions;
  /** What `COPY … FROM '/dev/blob'` reads during this query. */
  readonly blob?: Blob | File;
  readonly onNotice?: (notice: NoticeMessage) => void;
  /** Parameter type OIDs to declare, in order, instead of letting Postgres infer them. */
  readonly paramTypes?: readonly number[];
}

/** The result of one statement. */
export interface Results<T = Row> {
  rows: T[];
  /** Rows changed so far by INSERT/UPDATE/DELETE/COPY/MERGE, cumulative across a multi-statement exec. */
  affectedRows?: number;
  /** The statement's command, e.g. "SELECT", "INSERT", "CREATE". */
  command?: string;
  /** The row count in the command tag (rows returned or changed by this statement). */
  rowCount?: number;
  fields: { name: string; dataTypeID: number }[];
  /** What `COPY … TO '/dev/blob'` wrote, when it wrote anything. */
  blob?: Blob;
}

/** The handle a `transaction` callback receives. It stops working when the transaction ends. */
export interface Transaction {
  query<T = Row>(sql: string, params?: readonly unknown[], options?: QueryOptions): Promise<Results<T>>;
  sql<T = Row>(sqlStrings: TemplateStringsArray, ...params: unknown[]): Promise<Results<T>>;
  exec(sql: string, options?: QueryOptions): Promise<Results[]>;
  rollback(): Promise<void>;
  listen(channel: string, callback: (payload: string) => void): Promise<(tx?: Transaction) => Promise<void>>;
  readonly closed: boolean;
}

/** Where a data directory lives, as reported by {@link Pgwasm.storage}. */
export type StorageDescription =
  | { readonly kind: "memory" }
  | { readonly kind: "idb"; readonly name: string }
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "vfs" };

/** How {@link Pgwasm.dumpDataDir} compresses: `auto` and `gzip` gzip the tarball, `none` does not. */
export type DumpCompression = "none" | "gzip" | "auto";

/** What a client extension's `setup` returns. */
export interface ExtensionSetupResult<TNamespace = unknown> {
  /** Attached to the instance under the extension's key in `extensions`. */
  readonly namespace?: TNamespace;
  /** Run once the database is ready. */
  readonly init?: () => Promise<void>;
  /** Run when the database closes. */
  readonly close?: () => Promise<void>;
}

/** A client extension: code that runs beside the database, such as `live`. */
export interface Extension<TNamespace = unknown> {
  readonly name: string;
  setup(pg: Pgwasm): Promise<ExtensionSetupResult<TNamespace>>;
}

/** The `extensions` option: client extensions and a build's server extensions, by key. */
export type Extensions = Readonly<Record<string, Extension | ServerExtension>>;

/** The namespaces client extensions attach, by their key in `extensions`. */
export type ExtensionNamespaces<E extends Extensions> = {
  readonly [
    K in keyof E as E[K] extends Extension<infer N> ? ([N] extends [undefined] ? never : K) : never
  ]: E[K] extends Extension<infer N> ? N : never;
};

export interface PgwasmOptions<E extends Extensions = Extensions> {
  /** The Postgres build to run, e.g. `cBuild` from `@pgxsinkit/pgwasm-c`. */
  readonly build: PostgresBuild;
  /**
   * Where the data directory lives: `memory://` (the default), `idb://<name>` (IndexedDB) or
   * `file://<path>` (a directory, on Bun). A scheme is required. Exclusive with `fs`.
   */
  readonly dataDir?: string;
  /** A filesystem to mount as the data directory instead of `dataDir`. */
  readonly fs?: BaseFilesystem;
  /** A Store backup (`dumpDataDir()` output) to create the data directory from. */
  readonly loadDataDir?: Blob | File;
  readonly extensions?: E;
  /**
   * Return from a statement before its storage persist completes. The persist runs in the
   * background, and a failure is reported by the next statement.
   */
  readonly relaxedDurability?: boolean;
  /** Run as this role (`SET ROLE`) once started. */
  readonly username?: string;
  /** The database to connect to. Defaults to `postgres`. */
  readonly database?: string;
  /** Server settings (GUCs), e.g. `{ application_name: "app" }`. */
  readonly settings?: Readonly<Record<string, string>>;
  readonly parsers?: ParserOptions;
  readonly serializers?: SerializerOptions;
  readonly debug?: DebugLevel;
}

/** A running database. */
export interface Pgwasm extends AsyncDisposable {
  /** Settled once the database is ready; `createPgwasm` resolves only then. */
  readonly waitReady: Promise<void>;
  readonly ready: boolean;
  readonly closed: boolean;
  readonly debug: DebugLevel;
  /** The build this database runs on. */
  readonly build: BuildIdentity;
  /** Where the data directory lives. */
  readonly storage: StorageDescription;

  /** One statement, through the extended protocol, with parameters. */
  query<T = Row>(sql: string, params?: readonly unknown[], options?: QueryOptions): Promise<Results<T>>;
  /** One statement from a template; interpolated values become parameters. */
  sql<T = Row>(sqlStrings: TemplateStringsArray, ...params: unknown[]): Promise<Results<T>>;
  /** Any number of statements, through the simple protocol, without parameters. */
  exec(sql: string, options?: QueryOptions): Promise<Results[]>;
  /** Run `callback` in a transaction: COMMIT when it resolves, ROLLBACK when it throws. */
  transaction<T>(callback: (tx: Transaction) => Promise<T>): Promise<T>;
  /** Run `fn` while no query or transaction runs. */
  runExclusive<T>(fn: () => Promise<T>): Promise<T>;
  /** LISTEN on a channel; resolves to the matching unlisten. */
  listen(
    channel: string,
    callback: (payload: string) => void,
    tx?: Transaction,
  ): Promise<(tx?: Transaction) => Promise<void>>;
  /** UNLISTEN one callback, or every callback when none is given. */
  unlisten(channel: string, callback?: (payload: string) => void, tx?: Transaction): Promise<void>;
  /** Every notification on every channel; returns the unsubscribe. */
  onNotification(callback: (channel: string, payload: string) => void): () => void;
  /** Re-read the array types, after creating a type whose arrays should parse. */
  refreshArrayTypes(): Promise<void>;
  /** A Store backup: the data directory as a tarball, restorable through `loadDataDir`. */
  dumpDataDir(compression?: DumpCompression): Promise<File>;
  close(): Promise<void>;
}

/** A database with its client extensions' namespaces attached. */
export type PgwasmWithExtensions<E extends Extensions> = Pgwasm & ExtensionNamespaces<E>;

export type { FilesystemKind };
