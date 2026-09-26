// Began as a copy of `@electric-sql/pglite` (taken under its PostgreSQL License option, © ElectricSQL
// — see NOTICE). Owned outright (ADR-0062); compatibility with PGlite is an anti-goal — evolve freely.

import type { Pgwasm, Results, Row } from "../interface";

export interface LiveQueryOptions<T = Row> {
  query: string;
  params?: readonly unknown[] | null;
  offset?: number;
  limit?: number;
  callback?: (results: Results<T>) => void;
  signal?: AbortSignal;
}

export interface LiveChangesOptions<T = Row> {
  query: string;
  params?: readonly unknown[] | null;
  key: string;
  callback?: (changes: Change<T>[]) => void;
  signal?: AbortSignal;
}

export interface LiveIncrementalQueryOptions<T = Row> {
  query: string;
  params?: readonly unknown[] | null;
  key: string;
  callback?: (results: Results<T>) => void;
  signal?: AbortSignal;
}

/** The `live` namespace the extension attaches. */
export interface LiveNamespace {
  /**
   * A query whose results are re-run and delivered whenever a table it reads changes. Resolves to the
   * initial results plus `subscribe` / `unsubscribe` / `refresh`.
   */
  query<T = Row>(
    query: string,
    params?: readonly unknown[] | null,
    callback?: (results: Results<T>) => void,
  ): Promise<LiveQuery<T>>;
  query<T = Row>(options: LiveQueryOptions<T>): Promise<LiveQuery<T>>;

  /** The changes to a query's results, keyed by a column (`key`) that identifies a row. */
  changes<T = Row>(
    query: string,
    params: readonly unknown[] | undefined | null,
    key: string,
    callback?: (changes: Change<T>[]) => void,
  ): Promise<LiveChanges<T>>;
  changes<T = Row>(options: LiveChangesOptions<T>): Promise<LiveChanges<T>>;

  /** Like {@link query}, but maintained from `changes`, keyed by `key`: cheaper for large results. */
  incrementalQuery<T = Row>(
    query: string,
    params: readonly unknown[] | undefined | null,
    key: string,
    callback?: (results: Results<T>) => void,
  ): Promise<LiveQuery<T>>;
  incrementalQuery<T = Row>(options: LiveIncrementalQueryOptions<T>): Promise<LiveQuery<T>>;
}

export interface LiveQueryResults<T> extends Results<T> {
  totalCount?: number;
  offset?: number;
  limit?: number;
}

export interface LiveQuery<T> {
  initialResults: LiveQueryResults<T>;
  subscribe: (callback: (results: LiveQueryResults<T>) => void) => void;
  unsubscribe: (callback?: (results: LiveQueryResults<T>) => void) => Promise<void>;
  refresh: (options?: { offset?: number; limit?: number }) => Promise<void>;
}

export interface LiveChanges<T = Row> {
  fields: { name: string; dataTypeID: number }[];
  initialChanges: Change<T>[];
  subscribe: (callback: (changes: Change<T>[]) => void) => void;
  unsubscribe: (callback?: (changes: Change<T>[]) => void) => Promise<void>;
  refresh: () => Promise<void>;
}

export type ChangeInsert<T> = {
  __changed_columns__: string[];
  __op__: "INSERT";
  __after__: number;
} & T;

export type ChangeDelete<T> = {
  __changed_columns__: string[];
  __op__: "DELETE";
  __after__: undefined;
} & T;

export type ChangeUpdate<T> = {
  __changed_columns__: string[];
  __op__: "UPDATE";
  __after__: number;
} & T;

export type ChangeReset<T> = {
  __op__: "RESET";
} & T;

export type Change<T> = ChangeInsert<T> | ChangeDelete<T> | ChangeUpdate<T> | ChangeReset<T>;

/** A database with the `live` extension attached under the key `live`. */
export type PgwasmWithLive = Pgwasm & { readonly live: LiveNamespace };
