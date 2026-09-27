// Began as a copy of `@electric-sql/pglite` (taken under its PostgreSQL License option, © ElectricSQL
// — see NOTICE). Owned outright (ADR-0062); compatibility with PGlite is an anti-goal — evolve freely.

import type {
  BuildCapabilities,
  BuildIdentity,
  DataDirEntry,
  DebugLevel,
  PostgresBuild,
  RunningPostgres,
  ServerExtension,
  StorageRequest,
  WireSession,
} from "../build/seam";
import {
  DataDirExistsError,
  makeQueryError,
  PgwasmClosedError,
  PgwasmError,
  PgwasmFailedError,
  UnsupportedFeatureError,
} from "../errors";
import type {
  DumpCompression,
  Extension,
  ParserOptions,
  Pgwasm,
  QueryOptions,
  Results,
  SerializerOptions,
  StorageDescription,
  Transaction,
} from "../interface";
import {
  DatabaseError,
  NoticeMessage,
  NotificationResponseMessage,
  type BackendMessage,
} from "../protocol/wire/messages";
import { Parser as WireParser } from "../protocol/wire/parser";
import { serialize } from "../protocol/wire/serializer";
import { query as queryTemplate } from "../templating";
import {
  arrayParser,
  arraySerializer,
  parsers as defaultParsers,
  serializers as defaultSerializers,
  toText,
  type Parser,
  type Serializer,
} from "../types";
import { writeDataDirArchive } from "./data-dir-archive";
import {
  type ExecProtocolOptions,
  type ExecProtocolResult,
  type ExecProtocolStreamOptions,
  registerProtocolAccess,
} from "./internals";
import { BUILD_MARKER_PATH, checkBuildMarker, encodeBuildMarker, PG_VERSION_PATH } from "./marker";
import { Mutex } from "./mutex";
import { quoteIdentifier, toPostgresName } from "./names";
import { parseDescribeStatementResults, parseResults } from "./parse";
import { backupBaseName, describeStorage } from "./storage";

/** Everything `createPgwasm` resolved and validated before booting. */
export interface BootPlan {
  readonly build: PostgresBuild;
  readonly storage: StorageRequest;
  readonly serverExtensions: readonly ServerExtension[];
  readonly clientExtensions: readonly (readonly [key: string, extension: Extension])[];
  /** A Store backup's entries to create the data directory from, marker included. */
  readonly restore: readonly DataDirEntry[] | undefined;
  readonly settings: Readonly<Record<string, string>>;
  readonly user: string;
  readonly database: string;
  readonly username: string | undefined;
  readonly debug: DebugLevel;
  readonly relaxedDurability: boolean;
  readonly parsers: ParserOptions | undefined;
  readonly serializers: SerializerOptions | undefined;
}

interface CurrentQuery {
  results: BackendMessage[];
  throwOnError: boolean;
  onNotice: ((notice: NoticeMessage) => void) | undefined;
  databaseError: DatabaseError | null;
}

function newQuery(throwOnError = false, onNotice?: (notice: NoticeMessage) => void): CurrentQuery {
  return { results: [], throwOnError, onNotice, databaseError: null };
}

function describeException(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error) {
    const { name, message } = error as { name?: unknown; message?: unknown };
    return `${typeof name === "string" ? name : "Error"}: ${String(message)}`;
  }
  return String(error);
}

function concatChunks(chunks: readonly Uint8Array[]): Uint8Array {
  if (chunks.length === 1) return chunks[0] ?? new Uint8Array(0);
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * A running database over a Postgres build. Everything above the wire protocol lives here, once for
 * every build: queries and transactions, the persist scheduler and its latch, the failure latch,
 * notifications, array types, backups and the build marker.
 */
export class PgwasmInstance implements Pgwasm {
  readonly build: BuildIdentity;
  readonly storage: StorageDescription;
  readonly debug: DebugLevel;
  readonly waitReady: Promise<void>;

  readonly #capabilities: BuildCapabilities;
  readonly #relaxedDurability: boolean;
  #resolveReady: () => void = () => undefined;
  #rejectReady: (error: unknown) => void = () => undefined;

  #ready = false;
  #closing = false;
  #closed = false;
  // Set when the build failed underneath a statement: every later statement throws it (see #fail).
  #failure: { error: PgwasmFailedError } | undefined;
  // A background (relaxed) persist that failed: the next statement reports it.
  #persistFailure: { error: unknown } | undefined;
  #persistScheduled = false;

  readonly #queryMutex = new Mutex();
  readonly #transactionMutex = new Mutex();
  readonly #listenMutex = new Mutex();
  readonly #persistMutex = new Mutex();

  #running: RunningPostgres | undefined;
  #session: WireSession | undefined;
  readonly #extensionsClose: (() => Promise<void>)[] = [];

  #parser = new WireParser();
  readonly #unsolicitedParser = new WireParser();
  #currentQuery: CurrentQuery = newQuery();

  readonly #notifyListeners = new Map<string, Set<(payload: string) => void>>();
  readonly #globalNotifyListeners = new Set<(channel: string, payload: string) => void>();

  readonly #parsers: Record<number | string, Parser>;
  readonly #serializers: Record<number | string, Serializer>;
  #arrayTypesInitialized = false;
  #inTransaction = false;

  constructor(plan: BootPlan) {
    this.build = plan.build.identity;
    this.#capabilities = plan.build.capabilities;
    this.storage = describeStorage(plan.storage);
    this.debug = plan.debug;
    this.#relaxedDurability = plan.relaxedDurability;
    this.#parsers = { ...defaultParsers, ...plan.parsers };
    this.#serializers = { ...defaultSerializers, ...plan.serializers };
    this.waitReady = new Promise<void>((resolve, reject) => {
      this.#resolveReady = resolve;
      this.#rejectReady = reject;
    });
    // A failed boot is reported by createPgwasm; the rejection here must not also surface unhandled.
    this.waitReady.catch(() => undefined);
    registerProtocolAccess(this, {
      execProtocol: (message, options) => this.#execProtocol(message, options),
      execProtocolStream: (message, options) => this.#execProtocolStream(message, options),
      execProtocolRaw: (message, options) => this.#execProtocolRaw(message, options),
      execProtocolRawStream: (message, options) => this.#execProtocolRawStream(message, options),
      runExclusiveSession: (fn) => this.#runExclusiveSession(fn),
      capabilities: this.#capabilities,
    });
  }

  // ─── boot ────────────────────────────────────────────────────────────────────

  /** Boot the build, check the build marker, create or restore the data directory, and start. */
  async boot(plan: BootPlan): Promise<void> {
    try {
      await this.#boot(plan);
      this.#resolveReady();
    } catch (error) {
      this.#rejectReady(error);
      throw error;
    }
  }

  async #boot(plan: BootPlan): Promise<void> {
    const inits: (() => Promise<void>)[] = [];
    for (const [key, extension] of plan.clientExtensions) {
      const result = await extension.setup(this);
      if (result.namespace !== undefined) {
        if (key in this) {
          throw new PgwasmError(`The extension key "${key}" collides with a pgwasm member; use another key.`);
        }
        Object.defineProperty(this, key, { value: result.namespace, enumerable: true });
      }
      if (result.init) inits.push(result.init);
      if (result.close) this.#extensionsClose.push(result.close);
    }

    const identity = plan.build.identity;
    const mounted = await plan.build.boot({
      storage: plan.storage,
      extensions: plan.serverExtensions,
      user: plan.user,
      database: plan.database,
      debug: plan.debug,
    });
    let running: RunningPostgres;
    try {
      // Build permanence (ADR-0063): refuse another build's directory before anything is written.
      const marker = await mounted.readFile(BUILD_MARKER_PATH);
      const hasCluster = (await mounted.readFile(PG_VERSION_PATH)) !== undefined;
      checkBuildMarker(identity, marker, hasCluster, "data-directory");
      if (plan.restore !== undefined) {
        if (hasCluster) throw new DataDirExistsError();
        this.#log("pgwasm: creating the data directory from a Store backup");
        await mounted.writeEntries(plan.restore);
        await mounted.persist();
      } else if (!hasCluster) {
        this.#log("pgwasm: no database in the data directory, creating one");
        await mounted.createCluster();
        if (marker === undefined) await mounted.writeFile(BUILD_MARKER_PATH, encodeBuildMarker(identity));
        await mounted.persist();
      }
      running = await mounted.start({ settings: plan.settings });
    } catch (error) {
      try {
        await mounted.release();
      } catch {
        // The boot already failed; its first cause is what the caller needs.
      }
      throw error;
    }

    this.#running = running;
    try {
      const session = await running.openSession();
      session.onUnsolicited = (chunk) => this.#handleUnsolicited(chunk);
      this.#session = session;
      this.#ready = true;
      if (plan.username !== undefined) {
        await this.exec(`SET ROLE ${quoteIdentifier(plan.username)}`);
      }
      await this.#initArrayTypes();
      for (const init of inits) {
        await init();
      }
    } catch (error) {
      this.#ready = false;
      this.#closed = true;
      try {
        // A background persist a statement of the boot started (an extension's init) must settle first:
        // releasing tears its storage down under it.
        await this.#persistMutex.runExclusive(async () => {});
        await running.release({ afterFailedBoot: true });
      } catch {
        // Preserve the error that made the boot fail.
      }
      throw error;
    }
  }

  // ─── state ───────────────────────────────────────────────────────────────────

  get ready(): boolean {
    return this.#ready && !this.#closing && !this.#closed && this.#failure === undefined;
  }

  get closed(): boolean {
    return this.#closed;
  }

  async #checkReady(): Promise<void> {
    if (this.#closing) throw new PgwasmClosedError("closing");
    if (this.#closed) throw new PgwasmClosedError("closed");
    if (!this.#ready) await this.waitReady;
  }

  #checkOpenState(): void {
    if (this.#closing) throw new PgwasmClosedError("closing");
    if (this.#closed) throw new PgwasmClosedError("closed");
    if (this.#failure) throw this.#failure.error;
  }

  #checkPersistLatch(): void {
    if (this.#persistFailure) throw this.#persistFailure.error;
  }

  /**
   * Latch the instance as failed and return the error the failing statement and every later one
   * throw. It names the exception and, when Postgres reported an error first (a PANIC does, before it
   * aborts), that error.
   */
  #fail(cause: unknown): PgwasmFailedError {
    if (this.#failure) return this.#failure.error;
    const reported = this.#currentQuery.databaseError;
    const error = new PgwasmFailedError(
      "pgwasm failed and must be closed: " +
        (reported
          ? `Postgres reported ${reported.severity ?? "an error"}: ${reported.message}; the build then threw `
          : "the build threw ") +
        describeException(cause),
      { cause },
    );
    this.#failure = { error };
    return error;
  }

  #log(...args: unknown[]): void {
    if (this.debug > 0) console.log(...args);
  }

  // ─── the wire ────────────────────────────────────────────────────────────────

  #exchange(message: Uint8Array, onData: (chunk: Uint8Array) => void): void | Promise<void> {
    this.#checkOpenState();
    const session = this.#session;
    if (session === undefined) throw new PgwasmClosedError("closed");
    let pending: void | Promise<void>;
    try {
      pending = session.exchange(message, onData);
    } catch (error) {
      throw this.#fail(error);
    }
    if (pending === undefined) return;
    return pending.then(undefined, (error: unknown) => {
      throw this.#fail(error);
    });
  }

  #parseChunk(chunk: Uint8Array): void {
    this.#parser.parse(chunk, (message) => {
      const handled = this.#handleMessage(message);
      if (handled) this.#currentQuery.results.push(handled);
    });
  }

  #handleUnsolicited(chunk: Uint8Array): void {
    this.#unsolicitedParser.parse(chunk, (message) => {
      if (message instanceof NotificationResponseMessage) this.#dispatchNotification(message);
    });
  }

  #handleMessage(message: BackendMessage): BackendMessage | null {
    // Once a statement reported an error, the rest of its reply only needs acknowledging.
    if (this.#currentQuery.databaseError) return null;
    if (message instanceof DatabaseError) {
      if (this.#currentQuery.throwOnError) this.#currentQuery.databaseError = message;
    } else if (message instanceof NoticeMessage) {
      if (this.debug > 0) console.warn(message);
      this.#currentQuery.onNotice?.(message);
    } else if (message instanceof NotificationResponseMessage) {
      this.#dispatchNotification(message);
    }
    return message;
  }

  #dispatchNotification(message: NotificationResponseMessage): void {
    // Callbacks run after the synchronous code that received the notification.
    const listeners = this.#notifyListeners.get(message.channel);
    if (listeners) {
      for (const callback of listeners) queueMicrotask(() => callback(message.payload));
    }
    for (const callback of this.#globalNotifyListeners) {
      queueMicrotask(() => callback(message.channel, message.payload));
    }
  }

  async #execProtocolRaw(message: Uint8Array, { persist = true }: Pick<ExecProtocolOptions, "persist"> = {}) {
    // Checks only (no await) before the exchange, so a build that exchanges synchronously delivers the
    // reply inside this call's synchronous prefix.
    this.#checkPersistLatch();
    const chunks: Uint8Array[] = [];
    const pending = this.#exchange(message, (chunk) => {
      chunks.push(chunk.slice());
      this.#parseChunk(chunk);
    });
    if (pending !== undefined) await pending;
    if (persist) await this.#persistAfterStatement();
    return concatChunks(chunks);
  }

  async #execProtocolRawStream(
    message: Uint8Array,
    { persist = true, onRawData }: ExecProtocolStreamOptions,
  ): Promise<void> {
    // Same synchronous-prefix contract as #execProtocolRaw: pg_dump's write callback drives this from
    // inside a blocking wasm call and reads the reply back before it returns.
    this.#checkPersistLatch();
    const pending = this.#exchange(message, onRawData);
    if (pending !== undefined) await pending;
    if (persist) await this.#persistAfterStatement();
  }

  async #execProtocol(
    message: Uint8Array,
    { persist = true, throwOnError = true, onNotice }: ExecProtocolOptions = {},
  ): Promise<ExecProtocolResult> {
    this.#currentQuery = newQuery(throwOnError, onNotice);
    try {
      const data = await this.#execProtocolRaw(message, { persist });
      const databaseError = this.#currentQuery.databaseError;
      const result = { messages: this.#currentQuery.results, data };
      if (throwOnError && databaseError) {
        this.#parser = new WireParser();
        throw databaseError;
      }
      return result;
    } finally {
      this.#currentQuery = newQuery();
    }
  }

  async #execProtocolStream(
    message: Uint8Array,
    { persist = true, throwOnError = true, onNotice }: ExecProtocolOptions = {},
  ): Promise<BackendMessage[]> {
    this.#currentQuery = newQuery(throwOnError, onNotice);
    try {
      this.#checkPersistLatch();
      const pending = this.#exchange(message, (chunk) => this.#parseChunk(chunk));
      if (pending !== undefined) await pending;
      if (persist) await this.#persistAfterStatement();
      const databaseError = this.#currentQuery.databaseError;
      const results = this.#currentQuery.results;
      if (throwOnError && databaseError) {
        this.#parser = new WireParser();
        throw databaseError;
      }
      return results;
    } finally {
      this.#currentQuery = newQuery();
    }
  }

  // ─── durability ──────────────────────────────────────────────────────────────

  /**
   * Persist storage after a statement. Awaited by default; with `relaxedDurability` it runs in the
   * background and a failure is latched for the next statement. An awaited failure is not latched: the
   * caller already has it, and a filesystem with its own failure policy decides what later calls see.
   */
  async #persistAfterStatement(): Promise<void> {
    this.#checkOpenState();
    this.#checkPersistLatch();
    const running = this.#running;
    if (running === undefined || this.#persistScheduled) return;
    this.#persistScheduled = true;
    const run = () =>
      this.#persistMutex.runExclusive(async () => {
        this.#persistScheduled = false;
        await running.persist(this.#relaxedDurability);
      });
    if (this.#relaxedDurability) {
      run().catch((error: unknown) => {
        this.#persistFailure ??= { error };
      });
    } else {
      await run();
    }
  }

  // ─── queries ─────────────────────────────────────────────────────────────────

  #runExclusiveQuery<T>(fn: () => Promise<T>): Promise<T> {
    return this.#queryMutex.runExclusive(async () => {
      this.#checkPersistLatch();
      return await fn();
    });
  }

  async #execNoPersist(message: Uint8Array, options?: QueryOptions): Promise<BackendMessage[]> {
    return await this.#execProtocolStream(message, {
      persist: false,
      ...(options?.onNotice ? { onNotice: options.onNotice } : {}),
    });
  }

  async #handleBlob(blob: Blob | undefined): Promise<void> {
    const device = this.#running?.blob;
    if (blob === undefined) {
      device?.setReadSource(undefined);
      return;
    }
    if (device === undefined) {
      throw new UnsupportedFeatureError(
        `The "${this.build.name}" Postgres build has no /dev/blob device, so the \`blob\` query option is not available.`,
      );
    }
    device.setReadSource(new Uint8Array(await blob.arrayBuffer()));
  }

  #cleanupBlob(): void {
    this.#running?.blob?.setReadSource(undefined);
  }

  #takeWrittenBlob(): Blob | undefined {
    const chunks = this.#running?.blob?.takeWritten();
    return chunks === undefined ? undefined : new Blob(chunks);
  }

  #serializeParams(
    params: readonly unknown[],
    dataTypeIDs: readonly number[],
    options?: QueryOptions,
  ): (string | null)[] {
    return params.map((param, index) => {
      if (param === null || param === undefined) return null;
      const oid = dataTypeIDs[index] ?? 0;
      const serializer = options?.serializers?.[oid] ?? this.#serializers[oid];
      return serializer ? serializer(param) : toText(param);
    });
  }

  async #runQuery<T>(sql: string, params: readonly unknown[] = [], options?: QueryOptions): Promise<Results<T>> {
    return await this.#runExclusiveQuery(async () => {
      this.#log("runQuery", sql, params, options);
      await this.#handleBlob(options?.blob);
      let results: BackendMessage[] = [];
      try {
        const parsed = await this.#execNoPersist(
          serialize.parse({ text: sql, ...(options?.paramTypes ? { types: options.paramTypes } : {}) }),
          options,
        );
        const dataTypeIDs = parseDescribeStatementResults(
          await this.#execNoPersist(serialize.describe({ type: "S" }), options),
        );
        const values = this.#serializeParams(params, dataTypeIDs, options);
        results = [
          ...parsed,
          ...(await this.#execNoPersist(serialize.bind({ values }), options)),
          ...(await this.#execNoPersist(serialize.describe({ type: "P" }), options)),
          ...(await this.#execNoPersist(serialize.execute({}), options)),
        ];
      } catch (error) {
        if (error instanceof DatabaseError) {
          throw makeQueryError({ error, query: sql, params, options });
        }
        throw error;
      } finally {
        results.push(...(await this.#execNoPersist(serialize.sync(), options)));
      }
      this.#cleanupBlob();
      if (!this.#inTransaction) await this.#persistAfterStatement();
      const blob = this.#takeWrittenBlob();
      // The row type is the caller's assertion, as with any driver.
      return parseResults(results, this.#parsers, options, blob)[0] as Results<T>;
    });
  }

  async #runExec(sql: string, options?: QueryOptions): Promise<Results[]> {
    return await this.#runExclusiveQuery(async () => {
      this.#log("runExec", sql, options);
      await this.#handleBlob(options?.blob);
      let results: BackendMessage[] = [];
      try {
        results = await this.#execNoPersist(serialize.query(sql), options);
      } catch (error) {
        if (error instanceof DatabaseError) {
          throw makeQueryError({ error, query: sql, params: undefined, options });
        }
        throw error;
      } finally {
        results.push(...(await this.#execNoPersist(serialize.sync(), options)));
      }
      this.#cleanupBlob();
      if (!this.#inTransaction) await this.#persistAfterStatement();
      const blob = this.#takeWrittenBlob();
      return parseResults(results, this.#parsers, options, blob) as Results[];
    });
  }

  async query<T = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
    options?: QueryOptions,
  ): Promise<Results<T>> {
    await this.#checkReady();
    // One statement at a time, never inside another caller's transaction.
    return await this.#transactionMutex.runExclusive(() => this.#runQuery<T>(sql, params, options));
  }

  async sql<T = Record<string, unknown>>(sqlStrings: TemplateStringsArray, ...params: unknown[]): Promise<Results<T>> {
    const { query, params: actualParams } = queryTemplate(sqlStrings, ...params);
    return await this.query<T>(query, actualParams);
  }

  async exec(sql: string, options?: QueryOptions): Promise<Results[]> {
    await this.#checkReady();
    return await this.#transactionMutex.runExclusive(() => this.#runExec(sql, options));
  }

  async transaction<T>(callback: (tx: Transaction) => Promise<T>): Promise<T> {
    await this.#checkReady();
    return await this.#transactionMutex.runExclusive(async () => {
      await this.#runExec("BEGIN");
      this.#inTransaction = true;

      // A transaction handle throws once its transaction has ended.
      let closed = false;
      const checkClosed = () => {
        if (closed) throw new PgwasmError("Transaction is closed");
      };

      const tx: Transaction = {
        query: async <R>(sql: string, params?: readonly unknown[], options?: QueryOptions) => {
          checkClosed();
          return await this.#runQuery<R>(sql, params, options);
        },
        sql: async <R>(sqlStrings: TemplateStringsArray, ...params: unknown[]) => {
          checkClosed();
          const { query, params: actualParams } = queryTemplate(sqlStrings, ...params);
          return await this.#runQuery<R>(query, actualParams);
        },
        exec: async (sql: string, options?: QueryOptions) => {
          checkClosed();
          return await this.#runExec(sql, options);
        },
        rollback: async () => {
          checkClosed();
          await this.#runExec("ROLLBACK");
          closed = true;
        },
        listen: async (channel: string, callback: (payload: string) => void) => {
          checkClosed();
          return await this.listen(channel, callback, tx);
        },
        get closed() {
          return closed;
        },
      };

      try {
        const result = await callback(tx);
        // Leave the in-transaction state before the terminal statement, so COMMIT persists like any
        // top-level statement instead of waiting for some later query.
        this.#inTransaction = false;
        if (!closed) {
          closed = true;
          await this.#runExec("COMMIT");
        } else {
          // An explicit tx.rollback() ran inside the transaction; persist its outcome now.
          await this.#persistAfterStatement();
        }
        return result;
      } catch (error) {
        this.#inTransaction = false;
        if (!closed) {
          closed = true;
          await this.#runExec("ROLLBACK");
        } else {
          // The transaction ended without reaching a persist: an explicit rollback, or a COMMIT that
          // threw. End at a persist boundary anyway, but never mask the original error with a persist
          // failure; a failing storage reports again on the next statement.
          try {
            await this.#persistAfterStatement();
          } catch {
            // the original error takes precedence
          }
        }
        throw error;
      }
    });
  }

  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    return await this.#runExclusiveQuery(fn);
  }

  /** `/protocol`'s exclusive session: the transaction lock, then the query lock, for `fn`'s whole run. */
  async #runExclusiveSession<T>(fn: () => Promise<T>): Promise<T> {
    await this.#checkReady();
    return await this.#transactionMutex.runExclusive(() =>
      this.#queryMutex.runExclusive(async () => {
        this.#checkOpenState();
        this.#checkPersistLatch();
        return await fn();
      }),
    );
  }

  // ─── array types ─────────────────────────────────────────────────────────────

  async #initArrayTypes({ force = false } = {}): Promise<void> {
    if (this.#arrayTypesInitialized && !force) return;
    this.#arrayTypesInitialized = true;
    const types = await this.query<{ oid: number; typarray: number }>(`
      SELECT b.oid, b.typarray
      FROM pg_catalog.pg_type a
      LEFT JOIN pg_catalog.pg_type b ON b.oid = a.typelem
      WHERE a.typcategory = 'A'
      GROUP BY b.oid, b.typarray
      ORDER BY b.oid
    `);
    for (const type of types.rows) {
      this.#serializers[type.typarray] = (value) => arraySerializer(value, this.#serializers[type.oid], type.typarray);
      this.#parsers[type.typarray] = (value) => arrayParser(value, this.#parsers[type.oid], type.typarray);
    }
  }

  async refreshArrayTypes(): Promise<void> {
    await this.#initArrayTypes({ force: true });
  }

  // ─── notifications ───────────────────────────────────────────────────────────

  // Lock order: the transaction lock, then the listen lock, then the query lock. A transaction's
  // tx.listen() runs with the transaction lock already held, so a top-level listen must take the
  // transaction lock before the listen lock too, or each would hold the lock the other waits for.

  async listen(
    channel: string,
    callback: (payload: string) => void,
    tx?: Transaction,
  ): Promise<(tx?: Transaction) => Promise<void>> {
    return await this.#withListenLocks(tx, (exec) => this.#subscribe(channel, callback, exec));
  }

  async unlisten(channel: string, callback?: (payload: string) => void, tx?: Transaction): Promise<void> {
    await this.#withListenLocks(tx, (exec) => this.#unsubscribe(channel, callback, exec));
  }

  async #withListenLocks<T>(
    tx: Transaction | undefined,
    fn: (exec: (sql: string) => Promise<unknown>) => Promise<T>,
  ): Promise<T> {
    if (tx) return await this.#listenMutex.runExclusive(() => fn((sql) => tx.exec(sql)));
    await this.#checkReady();
    return await this.#transactionMutex.runExclusive(() =>
      this.#listenMutex.runExclusive(() => fn((sql) => this.#runExec(sql))),
    );
  }

  async #subscribe(
    channel: string,
    callback: (payload: string) => void,
    exec: (sql: string) => Promise<unknown>,
  ): Promise<(tx?: Transaction) => Promise<void>> {
    const pgChannel = toPostgresName(channel);
    let listeners = this.#notifyListeners.get(pgChannel);
    if (!listeners) {
      listeners = new Set();
      this.#notifyListeners.set(pgChannel, listeners);
    }
    listeners.add(callback);
    try {
      await exec(`LISTEN ${channel}`);
    } catch (error) {
      listeners.delete(callback);
      if (listeners.size === 0) this.#notifyListeners.delete(pgChannel);
      throw error;
    }
    // By the channel as the caller wrote it: unlisten() normalises it the same way listen() did.
    return async (unlistenTx?: Transaction) => {
      await this.unlisten(channel, callback, unlistenTx);
    };
  }

  async #unsubscribe(
    channel: string,
    callback: ((payload: string) => void) | undefined,
    exec: (sql: string) => Promise<unknown>,
  ): Promise<void> {
    const pgChannel = toPostgresName(channel);
    const cleanUp = async () => {
      await exec(`UNLISTEN ${channel}`);
      // Another caller may have subscribed while UNLISTEN ran.
      if (this.#notifyListeners.get(pgChannel)?.size === 0) this.#notifyListeners.delete(pgChannel);
    };
    if (callback) {
      this.#notifyListeners.get(pgChannel)?.delete(callback);
      if (this.#notifyListeners.get(pgChannel)?.size === 0) await cleanUp();
    } else {
      await cleanUp();
    }
  }

  onNotification(callback: (channel: string, payload: string) => void): () => void {
    this.#globalNotifyListeners.add(callback);
    return () => {
      this.#globalNotifyListeners.delete(callback);
    };
  }

  // ─── backups ─────────────────────────────────────────────────────────────────

  /**
   * A Store backup. It reads the data directory under the query lock, so no statement runs during the
   * read; do not call it from inside `runExclusive`.
   */
  async dumpDataDir(compression?: DumpCompression): Promise<File> {
    await this.#checkReady();
    const running = this.#running;
    if (running === undefined) throw new PgwasmClosedError("closed");
    const entries = await this.#queryMutex.runExclusive(async () => {
      this.#checkOpenState();
      return await running.readEntries();
    });
    return await writeDataDirArchive(entries, backupBaseName(this.storage), compression);
  }

  // ─── close ───────────────────────────────────────────────────────────────────

  async close(): Promise<void> {
    await this.#checkReady();
    this.#closing = true;
    // After a failure the build is in an unknown state: running its shutdown or persisting what it left
    // would build on it. Close then only releases resources, and reports the failure it closed on.
    const failure = this.#failure;
    const running = this.#running;
    const session = this.#session;
    let closeFailure: { error: unknown } | undefined;
    let finalPersistFailure: { error: unknown } | undefined;
    try {
      await this.#transactionMutex.runExclusive(() =>
        this.#queryMutex.runExclusive(async () => {
          for (const closeFn of this.#extensionsClose) {
            try {
              await closeFn();
            } catch (error) {
              closeFailure ??= { error };
            }
          }
          if (failure || running === undefined) return;
          try {
            await session?.close();
            await running.shutdown();
          } catch (error) {
            closeFailure ??= { error };
          }
          // Persist shutdown's writes strictly. A successful final persist also recovers a prior
          // background failure.
          try {
            await this.#persistMutex.runExclusive(() => running.persist(false));
            this.#persistFailure = undefined;
          } catch (error) {
            finalPersistFailure = { error };
            this.#persistFailure = { error };
          }
        }),
      );
    } finally {
      try {
        // A background persist may still be running: a close after a failure skips the final persist
        // that would otherwise queue behind it. Releasing tears its storage down under it, so wait first.
        await this.#persistMutex.runExclusive(async () => {});
        // Release even when shutdown or persisting failed, so exclusive storage ownership is released.
        await running?.release();
      } finally {
        this.#closed = true;
        this.#closing = false;
        this.#ready = false;
        this.#session = undefined;
        this.#running = undefined;
      }
    }
    if (failure) throw failure.error;
    if (finalPersistFailure) throw finalPersistFailure.error;
    if (closeFailure) throw closeFailure.error;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}
