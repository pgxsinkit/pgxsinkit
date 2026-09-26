// Began as a copy of drizzle-orm's PGlite driver (`src/pglite/*.ts` at 1.0.0-rc.4; Apache-2.0, © Drizzle Team
// and contributors — see NOTICE). Changes: rebound from PGlite to pgwasm; the driver never constructs its
// own database. Owned outright (ADR-0062).

import { entityKind } from "drizzle-orm/entity";
import { DefaultLogger, type Logger } from "drizzle-orm/logger";
import { PgAsyncDatabase } from "drizzle-orm/pg-core/async/db";
import { PgDialect } from "drizzle-orm/pg-core/dialect";
import type { DrizzlePgConfig } from "drizzle-orm/pg-core/utils";
import type { AnyRelations, EmptyRelations } from "drizzle-orm/relations";

import type { Pgwasm } from "../interface";
import { pgwasmCodecs } from "./codecs";
import { PgwasmSession, type PgwasmQueryResultHKT, type PgwasmSessionClient } from "./session";

export class PgwasmDatabase<TRelations extends AnyRelations = EmptyRelations> extends PgAsyncDatabase<
  PgwasmQueryResultHKT,
  TRelations
> {
  static override readonly [entityKind]: string = "PgwasmDatabase";
}

function construct<TRelations extends AnyRelations, TClient extends PgwasmSessionClient>(
  client: TClient,
  config: DrizzlePgConfig<TRelations> = {},
): PgwasmDatabase<TRelations> & { $client: TClient } {
  // JIT row mappers compile with `new Function`; they are used only when asked for, since some contexts
  // (an extension page's CSP) forbid it.
  const dialect = new PgDialect({ useJitMappers: config.jit === true, codecs: config.codecs ?? pgwasmCodecs });
  const logger: Logger | undefined =
    config.logger === true ? new DefaultLogger() : config.logger === false ? undefined : config.logger;
  const relations = (config.relations ?? {}) as TRelations;
  const session = new PgwasmSession<TRelations>(client, dialect, relations, {
    ...(logger ? { logger } : {}),
    ...(config.cache ? { cache: config.cache } : {}),
  });
  const db = new PgwasmDatabase<TRelations>(dialect, session, relations);
  return Object.assign(db, { $client: client, $cache: config.cache });
}

/** A Drizzle database over a pgwasm database. */
export function drizzle<TRelations extends AnyRelations = EmptyRelations, TClient extends Pgwasm = Pgwasm>(
  client: TClient,
  config?: DrizzlePgConfig<TRelations>,
): PgwasmDatabase<TRelations> & { $client: TClient } {
  return construct(client, config);
}

const unavailable: PgwasmSessionClient = {
  query: () => {
    throw new Error("drizzle.mock() has no database: build queries with it, run them elsewhere.");
  },
};

/** A Drizzle database with no database behind it, for building SQL (`.toSQL()`). */
drizzle.mock = function mock<TRelations extends AnyRelations = EmptyRelations>(
  config?: DrizzlePgConfig<TRelations>,
): PgwasmDatabase<TRelations> & { $client: "$client is not available on drizzle.mock()" } {
  const db = construct(unavailable, config);
  return Object.assign(db, { $client: "$client is not available on drizzle.mock()" as const });
};
