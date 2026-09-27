// Began as a copy of drizzle-orm's PGlite driver (`src/pglite/*.ts` at 1.0.0-rc.4; Apache-2.0, © Drizzle Team
// and contributors — see NOTICE). Changes: rebound from PGlite to pgwasm; the driver never constructs its
// own database; its own JIT capability probe; `$cache.invalidate` bound without changing the caller's
// cache object. Owned outright (ADR-0062).

import { entityKind } from "drizzle-orm/entity";
import { DefaultLogger, type Logger } from "drizzle-orm/logger";
import { PgAsyncDatabase } from "drizzle-orm/pg-core/async/db";
import { PgDialect } from "drizzle-orm/pg-core/dialect";
import type { DrizzlePgConfig } from "drizzle-orm/pg-core/utils";
import type { AnyRelations, EmptyRelations } from "drizzle-orm/relations";

import { PgwasmError } from "../errors";
import type { Pgwasm } from "../interface";
import { pgwasmCodecs } from "./codecs";
import { PgwasmSession, type PgwasmQueryResultHKT, type PgwasmSessionClient } from "./session";

export class PgwasmDatabase<TRelations extends AnyRelations = EmptyRelations> extends PgAsyncDatabase<
  PgwasmQueryResultHKT,
  TRelations
> {
  static override readonly [entityKind]: string = "PgwasmDatabase";
}

/**
 * Whether to use JIT row mappers: only when asked for (`jit: true`) and `new Function` works here. JIT
 * mappers are compiled with it, and a strict content security policy (an MV3 extension page's) makes it
 * throw; the driver then falls back to the premade mappers instead of failing every query.
 */
export function jitMappersUsable(requested: boolean | undefined): boolean {
  if (requested !== true) return false;
  try {
    // oxlint-disable-next-line typescript/no-implied-eval -- the probe: does this context allow it at all
    const identity = new Function("input", '"use strict"; return input;') as (input: unknown) => unknown;
    return identity(true) === true;
  } catch {
    return false;
  }
}

function construct<TRelations extends AnyRelations, TClient extends PgwasmSessionClient>(
  client: TClient,
  config: DrizzlePgConfig<TRelations> = {},
): PgwasmDatabase<TRelations> & { $client: TClient } {
  const dialect = new PgDialect({
    useJitMappers: jitMappersUsable(config.jit),
    codecs: config.codecs ?? pgwasmCodecs,
  });
  const logger: Logger | undefined =
    config.logger === true ? new DefaultLogger() : config.logger === false ? undefined : config.logger;
  const relations = (config.relations ?? {}) as TRelations;
  const session = new PgwasmSession<TRelations>(client, dialect, relations, {
    ...(logger ? { logger } : {}),
    ...(config.cache ? { cache: config.cache } : {}),
  });
  const db = new PgwasmDatabase<TRelations>(dialect, session, relations);
  // `db.$cache.invalidate` is the cache's own invalidation; with no cache it stays the no-op it starts as.
  const cache = config.cache;
  if (cache) db.$cache = { invalidate: (params) => cache.onMutate(params) };
  return Object.assign(db, { $client: client });
}

/** drizzle's object form: its config, with the pgwasm database as `client`. */
export type PgwasmDrizzleConfig<
  TRelations extends AnyRelations = EmptyRelations,
  TClient extends Pgwasm = Pgwasm,
> = DrizzlePgConfig<TRelations> & { client: TClient };

/** The form of a `drizzle()` call that would have the driver open its own database. */
export type UnsupportedDrizzleForm = "connection" | "connection string" | "no client";

/**
 * A `drizzle()` call without a pgwasm database: `drizzle({ connection })`, `drizzle("…")`, `drizzle()`, or a
 * `client` that is not a pgwasm database. The driver never opens its own database: create one with
 * `createPgwasm()` and pass it in.
 */
export class UnsupportedDrizzleConfigError extends PgwasmError {
  override name = "UnsupportedDrizzleConfigError";
  readonly form: UnsupportedDrizzleForm;

  constructor(form: UnsupportedDrizzleForm) {
    const given =
      form === "connection"
        ? "drizzle({ connection })"
        : form === "connection string"
          ? "drizzle(connectionString)"
          : "a drizzle() call without a pgwasm database";
    super(
      `@pgxsinkit/pgwasm/drizzle does not open its own database, so ${given} is not supported: create the ` +
        "database with createPgwasm() and pass it as drizzle(pg, config) or drizzle({ client: pg, ...config }).",
    );
    this.form = form;
  }
}

function isPgwasm(value: unknown): value is Pgwasm {
  return typeof value === "object" && value !== null && typeof (value as Partial<Pgwasm>).query === "function";
}

/**
 * A Drizzle database over a pgwasm database: `drizzle(pg, config)`, or drizzle's object form
 * `drizzle({ client: pg, ...config })`, which is the same thing. The driver never opens its own database, so
 * the forms that would (`{ connection }`, a connection string) are not accepted; at runtime they throw
 * {@link UnsupportedDrizzleConfigError}.
 */
export function drizzle<TRelations extends AnyRelations = EmptyRelations, TClient extends Pgwasm = Pgwasm>(
  client: TClient,
  config?: DrizzlePgConfig<TRelations>,
): PgwasmDatabase<TRelations> & { $client: TClient };
export function drizzle<TRelations extends AnyRelations = EmptyRelations, TClient extends Pgwasm = Pgwasm>(
  config: PgwasmDrizzleConfig<TRelations, TClient>,
): PgwasmDatabase<TRelations> & { $client: TClient };
export function drizzle<TRelations extends AnyRelations = EmptyRelations>(
  clientOrConfig: Pgwasm | PgwasmDrizzleConfig<TRelations>,
  config?: DrizzlePgConfig<TRelations>,
): PgwasmDatabase<TRelations> & { $client: Pgwasm } {
  const given: unknown = clientOrConfig;
  if (isPgwasm(given)) return construct(given, config);
  if (typeof given === "string") throw new UnsupportedDrizzleConfigError("connection string");
  if (typeof given === "object" && given !== null) {
    const { client, ...rest } = given as Partial<PgwasmDrizzleConfig<TRelations>> & { connection?: unknown };
    // A `connection` next to a pgwasm `client` is ignored, as drizzle's own drivers do.
    if (isPgwasm(client)) return construct(client, rest);
    if (client === undefined && "connection" in given) throw new UnsupportedDrizzleConfigError("connection");
  }
  throw new UnsupportedDrizzleConfigError("no client");
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
