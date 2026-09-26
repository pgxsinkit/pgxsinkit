// Began as a copy of drizzle-orm's PGlite driver (`src/pglite/*.ts` at 1.0.0-rc.4; Apache-2.0, © Drizzle Team
// and contributors — see NOTICE). Changes: rebound from PGlite to pgwasm; the driver never constructs its
// own database. Owned outright (ADR-0062).

import type { Cache } from "drizzle-orm/cache/core/cache";
import { NoopCache } from "drizzle-orm/cache/core/cache";
import type { WithCacheConfig } from "drizzle-orm/cache/core/types";
import { entityKind } from "drizzle-orm/entity";
import { NoopLogger, type Logger } from "drizzle-orm/logger";
import { PgAsyncPreparedQuery, PgAsyncSession, PgAsyncTransaction } from "drizzle-orm/pg-core/async/session";
import type { PgDialect } from "drizzle-orm/pg-core/dialect";
import type { PgQueryResultHKT, PgTransactionConfig, PreparedQueryConfig } from "drizzle-orm/pg-core/session";
import type { AnyRelations } from "drizzle-orm/relations";
import { sql, type Query } from "drizzle-orm/sql/sql";
import type { Assume } from "drizzle-orm/utils";

import type { Pgwasm, Results, Row, Transaction } from "../interface";
import { drizzleParsers } from "./codecs";

/** What a session runs statements on: a database, or a transaction's handle. */
export type PgwasmSessionClient = Pick<Pgwasm, "query"> & Partial<Pick<Pgwasm, "transaction">>;

export interface PgwasmSessionOptions {
  logger?: Logger;
  cache?: Cache;
}

export interface PgwasmQueryResultHKT extends PgQueryResultHKT {
  type: Results<Assume<this["row"], Row>>;
}

type QueryMetadata = { type: "select" | "update" | "delete" | "insert"; tables: string[] };

export class PgwasmSession<TRelations extends AnyRelations> extends PgAsyncSession<PgwasmQueryResultHKT, TRelations> {
  static override readonly [entityKind]: string = "PgwasmSession";
  readonly #client: PgwasmSessionClient;
  readonly #relations: TRelations;
  readonly #options: PgwasmSessionOptions;
  readonly #logger: Logger;
  readonly #cache: Cache;

  constructor(
    client: PgwasmSessionClient,
    dialect: PgDialect,
    relations: TRelations,
    options: PgwasmSessionOptions = {},
  ) {
    super(dialect);
    this.#client = client;
    this.#relations = relations;
    this.#options = options;
    this.#logger = options.logger ?? new NoopLogger();
    this.#cache = options.cache ?? new NoopCache();
  }

  prepareQuery<T extends PreparedQueryConfig = PreparedQueryConfig>(
    query: Query,
    mode: "arrays" | "objects" | "raw",
    _name: string | boolean,
    mapper: ((rows: unknown[]) => unknown) | undefined,
    queryMetadata?: QueryMetadata,
    cacheConfig?: WithCacheConfig,
  ): PgAsyncPreparedQuery<T> {
    const executor = async (params?: unknown[]) => {
      const result = await this.#client.query(query.sql, params, {
        rowMode: mode === "arrays" ? "array" : "object",
        parsers: drizzleParsers,
      });
      return mode === "raw" ? result : result.rows;
    };
    return new PgAsyncPreparedQuery<T>(
      executor,
      query,
      mapper,
      mode,
      this.#logger,
      this.#cache,
      queryMetadata,
      cacheConfig,
    );
  }

  async transaction<T>(
    transaction: (tx: PgwasmTransaction<TRelations>) => Promise<T>,
    config?: PgTransactionConfig,
  ): Promise<T> {
    const client = this.#client;
    if (client.transaction === undefined) {
      throw new Error("A transaction's session cannot begin another transaction; nest with tx.transaction().");
    }
    return await client.transaction(async (handle: Transaction) => {
      const session = new PgwasmSession(handle, this.dialect, this.#relations, this.#options);
      const tx = new PgwasmTransaction(this.dialect, session, this.#relations, undefined, false);
      if (config) await tx.setTransaction(config);
      return await transaction(tx);
    });
  }
}

export class PgwasmTransaction<TRelations extends AnyRelations> extends PgAsyncTransaction<
  PgwasmQueryResultHKT,
  TRelations
> {
  static override readonly [entityKind]: string = "PgwasmTransaction";
  readonly #dialect: PgDialect;
  readonly #session: PgwasmSession<TRelations>;

  constructor(
    dialect: PgDialect,
    session: PgwasmSession<TRelations>,
    relations: TRelations,
    nestedIndex: number | undefined,
    parseRqbJson: boolean | undefined,
  ) {
    super(dialect, session, relations, nestedIndex, parseRqbJson);
    this.#dialect = dialect;
    this.#session = session;
  }

  async transaction<T>(transaction: (tx: PgwasmTransaction<TRelations>) => Promise<T>): Promise<T> {
    const savepointName = `sp${this.nestedIndex + 1}`;
    const tx = new PgwasmTransaction(this.#dialect, this.#session, this._.relations, this.nestedIndex + 1, false);
    await tx.execute(sql.raw(`savepoint ${savepointName}`));
    try {
      const result = await transaction(tx);
      await tx.execute(sql.raw(`release savepoint ${savepointName}`));
      return result;
    } catch (error) {
      await tx.execute(sql.raw(`rollback to savepoint ${savepointName}`));
      throw error;
    }
  }
}
