import type { LiveQuery, LiveQueryResults } from "@electric-sql/pglite/live";
import { createContext, type DependencyList, type ReactNode, useContext, useEffect, useMemo, useState } from "react";

import {
  type ClientPGlite,
  type LiveRowsSubscription,
  type MutationListOptions,
  type MutationSummaryDetail,
  type MutationSummarySubscription,
  type SyncClient,
  syncDebug,
} from "@pgxsinkit/client";
import type { MutationSummary, SyncTableName, SyncTableRegistry } from "@pgxsinkit/contracts";

import { liveFieldAliases, remapAliasedLiveRow, remapLiveRow, type SelectedFields } from "./remap-live-row";

/**
 * Minimal interface satisfied by every Drizzle select/query builder.
 * Calling `.toSQL()` extracts the SQL string and positional params without
 * executing the query, so they can be fed into PGlite's live query API. `_.selectedFields` is the
 * select's field metadata, used to remap PGlite's snake_case rows back to the builder's field keys
 * ({@link remapLiveRow}) — without it the typed rows would carry the underlying column names.
 */
interface DrizzleSqlBuilder<TRows extends readonly unknown[]> extends PromiseLike<TRows> {
  toSQL(): { sql: string; params: unknown[] };
  readonly _?: { readonly selectedFields?: SelectedFields };
}

/**
 * Reactive read result. `hydrating` is true from mount until every consistency group the query reads —
 * eager OR lazy — has completed its initial catch-up (`client.groupReady`) and the caught-up rows have
 * been delivered to this subscription, not merely started its stream. Rows flow while it is true
 * (local/cached rows paint immediately; catch-up rows stream in), so render an empty state only when
 * `!loading && !hydrating` — zero rows before that means "not loaded yet", not "empty". A subscription
 * whose groups are all already caught up at mount (the steady-state fast path) clears `hydrating` at the
 * first snapshot with no extra work.
 */
interface LiveRowsState<TRows> {
  rows: TRows;
  loading: boolean;
  hydrating: boolean;
  error: Error | null;
}

/**
 * The raw direct-PGlite subscription used only by `useLiveRows`'s explicit-`pglite` override (tests/multi-db).
 * Wraps `pglite.live.query` into the client's {@link LiveRowsSubscription} shape so the hook body treats the
 * override and the seam identically. The normal path goes through `client.subscribeLiveRows`.
 */
function subscribeRawPglite<TRow extends Record<string, unknown>>(
  pglite: ClientPGlite,
  query: string,
  params: unknown[],
  onRows: (rows: TRow[]) => void,
): Promise<LiveRowsSubscription<TRow>> {
  return pglite.live.query<TRow>(query, params).then((registered: LiveQuery<TRow>) => {
    const listener = (results: LiveQueryResults<TRow>) => onRows(results.rows);
    registered.subscribe(listener);
    return {
      initialRows: registered.initialResults.rows,
      unsubscribe: () => void registered.unsubscribe(listener),
    };
  });
}

/**
 * Shared "no subscription yet" rows. The hooks DERIVE their return value during render, so this has to be
 * one stable identity — a fresh `[]` per render would defeat the memoised return object and re-fire every
 * consumer effect that depends on `rows`.
 */
const EMPTY_ROWS: never[] = [];

const EMPTY_MUTATION_SUMMARY: MutationSummary = {
  pendingCount: 0,
  sendingCount: 0,
  ackedCount: 0,
  failedCount: 0,
  rejectedCount: 0,
  conflictedCount: 0,
  quarantinedCount: 0,
  unsettledCount: 0,
  settledCount: 0,
};

/**
 * Creates a set of React hooks and a context provider bound to a specific
 * `SyncTableRegistry` type. Call this once at the module level in your app:
 *
 * ```ts
 * export const { SyncClientProvider, useSyncClient, useLiveRows, useLiveDrizzleRows, useLiveQueryRaw } =
 *   createSyncClientHooks<typeof mySyncRegistry>();
 * ```
 */
export function createSyncClientHooks<TRegistry extends SyncTableRegistry>() {
  const SyncClientContext = createContext<SyncClient<TRegistry> | null>(null);

  // ─── Provider ────────────────────────────────────────────────────────────

  function SyncClientProvider({ client, children }: { client: SyncClient<TRegistry> | null; children: ReactNode }) {
    return <SyncClientContext.Provider value={client}>{children}</SyncClientContext.Provider>;
  }

  function useSyncClient(): SyncClient<TRegistry> {
    const client = useContext(SyncClientContext);
    if (client == null) {
      throw new Error("[pgxsinkit] useSyncClient must be called inside <SyncClientProvider>");
    }
    return client;
  }

  // ─── Raw SQL live hooks ───────────────────────────────────────────────────

  /**
   * Reactive raw-SQL query. This is the **unguarded** escape hatch: it does not participate in the
   * lazy-relation safety net (ADR-0021) — a raw string is not parameterised/quoted predictably, so a
   * `lazy` relation referenced here will read empty/stale unless you `client.ensureSynced([...])` first.
   * Prefer {@link useLiveDrizzleRows} / {@link useLiveQueryRaw} for anything touching lazy relations.
   *
   * `loading` and `rows` are derived from which subscription the latest snapshot belongs to, so a
   * `ready: false → true` interlude with unchanged inputs keeps the previous rows while it re-subscribes
   * (`loading: true`) instead of briefly reporting zero rows — the same "keep the previous rows while
   * loading" policy already applied across a query change.
   */
  function useLiveRows<TRow extends Record<string, unknown> = Record<string, unknown>>(
    query: string,
    options?: {
      params?: readonly unknown[];
      ready?: boolean;
      /** Explicit PGlite instance — overrides the context client. Useful in tests or multi-db scenarios. */
      pglite?: ClientPGlite;
    },
  ): { rows: TRow[]; loading: boolean; error: Error | null } {
    const contextClient = useContext(SyncClientContext);
    // An explicit `pglite` override keeps the raw direct-PGlite path (tests/multi-db); otherwise the query
    // runs through the client's live-rows seam, so this hook works against the worker-attached client too
    // (which has no local `pglite`) exactly as against the in-process client (ADR-0032 S2 §4).
    const overridePglite = options?.pglite;
    const ready = options?.ready ?? true;

    const paramsKey = JSON.stringify(options?.params ?? []);
    const stableParams = useMemo<unknown[]>(() => JSON.parse(paramsKey) as unknown[], [paramsKey]);

    const canRun = ready && (overridePglite != null || contextClient != null);
    // The run token: ONE object whose identity changes exactly when the subscription inputs change, and
    // `null` when the hook cannot subscribe. It is the effect's only dependency AND the tag on every
    // snapshot the effect writes, so `loading` is derived during render ("does the snapshot belong to the
    // current run?") instead of being written synchronously from the effect.
    const run = useMemo(
      () => (canRun ? { query, params: stableParams, client: contextClient, pglite: overridePglite } : null),
      [canRun, query, stableParams, contextClient, overridePglite],
    );

    const [snapshot, setSnapshot] = useState<{ run: typeof run; rows: TRow[]; error: Error | null }>({
      run: null,
      rows: EMPTY_ROWS,
      error: null,
    });

    useEffect(() => {
      if (run == null) return;

      let active = true;
      let subscription: LiveRowsSubscription<TRow> | undefined;

      const onRows = (rows: TRow[]) => {
        if (active) {
          syncDebug("live query updated → re-render", { rows: rows.length });
          setSnapshot({ run, rows, error: null });
        }
      };

      // The raw-PGlite override subscribes directly (unchanged); the seam path is the SAME `pglite.live`
      // wrapper the in-process client exposes, so behaviour is identical when no override is given.
      const subscribe = run.pglite
        ? subscribeRawPglite<TRow>(run.pglite, run.query, run.params, onRows)
        : run.client!.subscribeLiveRows<Record<string, unknown>>({ sql: run.query, params: run.params }, (rows) =>
            onRows(rows as TRow[]),
          );

      void subscribe
        .then((registered) => {
          if (!active) {
            registered.unsubscribe();
            return;
          }
          subscription = registered as LiveRowsSubscription<TRow>;
          setSnapshot({ run, rows: registered.initialRows as TRow[], error: null });
        })
        .catch((error: unknown) => {
          if (active) {
            setSnapshot({ run, rows: EMPTY_ROWS, error: error instanceof Error ? error : new Error(String(error)) });
          }
        });

      return () => {
        active = false;
        subscription?.unsubscribe();
      };
    }, [run]);

    // Derived, never stored: a snapshot is authoritative only for the run it was tagged with. Holding the
    // previous run's rows until the new one settles is exactly what the old synchronous
    // `setState({ rows: prev.rows, loading: true })` did; no client (or `ready: false`) reads as no rows.
    const settled = run != null && snapshot.run === run;
    const rows = run == null ? EMPTY_ROWS : snapshot.rows;
    const loading = ready && !settled;
    const error = settled ? snapshot.error : null;

    return useMemo(() => ({ rows, loading, error }), [rows, loading, error]);
  }

  function useLiveRow<TRow extends Record<string, unknown> = Record<string, unknown>>(
    query: string,
    options?: { params?: readonly unknown[]; ready?: boolean; pglite?: ClientPGlite },
  ): { row: TRow | null; loading: boolean; error: Error | null } {
    const { rows, loading, error } = useLiveRows<TRow>(query, options);
    return { row: rows[0] ?? null, loading, error };
  }

  // ─── Drizzle typed live hooks ─────────────────────────────────────────────

  /**
   * Shared implementation behind {@link useLiveDrizzleRows} and {@link useLiveQueryRaw}. Builds the query,
   * then `client.prepareQuery` scans the compiled SQL for the lazy relations it reads (∪ the optional
   * `use`), activates + hydrates them, and only then subscribes the live query — so it is never
   * registered against an un-hydrated lazy relation (ADR-0021).
   *
   * `loading`/`hydrating`/`rows` are derived from which subscription the latest snapshot belongs to, so a
   * `ready: false → true` interlude with unchanged inputs keeps the previous rows while it re-subscribes
   * (`loading: true`) instead of briefly reporting zero rows — the same "keep the previous rows while
   * loading" policy already applied across a query change.
   */
  function useGuardedDrizzleLive<TRows extends readonly unknown[]>(
    buildQuery: (client: SyncClient<TRegistry>) => DrizzleSqlBuilder<TRows>,
    deps: DependencyList,
    options?: { ready?: boolean; use?: readonly SyncTableName<TRegistry>[]; keepAliveMs?: number },
  ): LiveRowsState<TRows> {
    const contextClient = useContext(SyncClientContext);
    const ready = options?.ready ?? true;
    const useList = options?.use;
    // Per-subscription keep-alive hint (ADR-0040 decision 4). Read at subscribe time and forwarded to the
    // seam; changing it does not resubscribe (it is not a query input — only a retention preference at unmount,
    // honoured in worker mode). See `SubscribeLiveRowsInput.keepAliveMs`.
    const keepAliveMs = options?.keepAliveMs;
    const useKey = useList != null ? JSON.stringify(useList) : "";

    const queryInfo = useMemo(
      () => {
        if (contextClient == null) return null;
        const query = buildQuery(contextClient);
        return { sql: query.toSQL(), selectedFields: query._?.selectedFields };
      },
      // buildQuery intentionally excluded; callers control reactivity via deps. Spread is valid and intentional.
      // oxlint-disable-next-line react-hooks/exhaustive-deps -- intentional: callers own deps, spread is by design
      [contextClient, ...deps],
    );

    const sqlKey = queryInfo != null ? JSON.stringify(queryInfo.sql) : null;

    // The run token: ONE object whose identity changes exactly when the subscription must be rebuilt, and
    // `null` when the hook cannot subscribe. It is the effect's only dependency AND the tag on every
    // snapshot the effect writes, so `loading`/`hydrating` are derived during render instead of being
    // written synchronously from the effect. `keepAliveMs` rides along inside the token precisely because
    // it is NOT a dep: it is read at subscribe time and never resubscribes (ADR-0040 decision 4, above).
    const run = useMemo(
      () =>
        ready && contextClient != null && queryInfo != null
          ? { client: contextClient, queryInfo, useList, keepAliveMs }
          : null,
      // sqlKey/useKey are stable JSON snapshots; queryInfo/useList/keepAliveMs are captured in the token.
      // oxlint-disable-next-line react-hooks/exhaustive-deps -- sqlKey/useKey are the stable proxies for queryInfo
      [contextClient, sqlKey, useKey, ready],
    );

    const [snapshot, setSnapshot] = useState<{
      run: typeof run;
      rows: TRows;
      hydrated: boolean;
      error: Error | null;
    }>({
      run: null,
      rows: EMPTY_ROWS as unknown as TRows,
      hydrated: false,
      error: null,
    });

    useEffect(() => {
      if (run == null) return;

      const { sql, selectedFields } = run.queryInfo;
      // Render the query safe to MATERIALISE: hand the seam the select's unique field aliases so it wraps a
      // JOIN with same-named columns (two `title`) under a positional column-alias-list — otherwise PGlite's
      // live query refuses it (`column "title" specified more than once`) and same-named columns collapse.
      // With `fields` the rows come back keyed by those aliases, so map by alias; without a field map (a raw
      // query) the seam leaves the SQL unwrapped and rows stay name-keyed (`remapLiveRow`).
      const fields = liveFieldAliases(selectedFields);
      const mapRows = (rows: readonly unknown[]): TRows =>
        rows.map((row) =>
          fields
            ? remapAliasedLiveRow(selectedFields, row as Record<string, unknown>)
            : remapLiveRow(selectedFields, row as Record<string, unknown>),
        ) as unknown as TRows;

      let active = true;
      let subscription: LiveRowsSubscription<Record<string, unknown>> | undefined;

      // Scan the compiled SQL for the lazy relations the query reads (∪ `use`), ACTIVATE them (streams
      // started, tripwire satisfied), THEN subscribe via the client's live-rows seam — so a query is never
      // registered against a dormant lazy relation (ADR-0021), and the same hook drives both the in-process
      // client (seam over `pglite.live`) and the worker-attached client (seam over the bridge, ADR-0032 S2 §4).
      // Activation is NOT catch-up: the subscription registers immediately (local/cached rows paint, and an
      // offline client is never blocked behind the network), while `hydrating` stays true until the
      // subscription's `hydrated` promise resolves. That promise now spans EVERY referenced consistency
      // group (eager AND lazy) still catching up — not just the lazy ones — so a cold boot's eager catch-up
      // is covered too; when every referenced group is already ready at subscribe time the seam builds no
      // promise and `hydrating` clears at the first snapshot. The seam guarantees rows-before-signal (it
      // refreshes the live query against the caught-up store before resolving), so clearing `hydrating`
      // here can never present zero rows as "empty" while the catch-up rows are still in flight.
      void run.client
        .prepareQuery({ sql: sql.sql, ...(run.useList ? { use: run.useList } : {}) })
        .then(() => {
          if (!active) return undefined;
          return run.client
            .subscribeLiveRows<Record<string, unknown>>(
              {
                sql: sql.sql,
                params: sql.params,
                ...(fields ? { fields } : {}),
                ...(run.useList ? { use: run.useList } : {}),
                ...(run.keepAliveMs != null ? { keepAliveMs: run.keepAliveMs } : {}),
              },
              (rows) => {
                if (active) {
                  syncDebug("live query updated → re-render", { rows: rows.length });
                  // A diff can land before the initial snapshot, so carry `hydrated` over only when the
                  // previous snapshot belongs to THIS run — otherwise it is the previous run's flag.
                  setSnapshot((prev) => ({
                    run,
                    rows: mapRows(rows),
                    hydrated: prev.run === run ? prev.hydrated : false,
                    error: null,
                  }));
                }
              },
            )
            .then((registered) => {
              if (!active) {
                registered.unsubscribe();
                return undefined;
              }
              subscription = registered;
              // The initial render on the rail: "updated → re-render" covers only later diffs, so without
              // this line a first snapshot — including an honest zero-row one — is invisible in a debug log.
              syncDebug("live query initial → render", {
                rows: registered.initialRows.length,
                hydrating: registered.hydrated != null,
              });
              // No `hydrated` promise ⇒ every referenced group was already caught up at subscribe time, so
              // this first snapshot IS the hydrated one (the steady-state fast path).
              setSnapshot({
                run,
                rows: mapRows(registered.initialRows),
                hydrated: registered.hydrated == null,
                error: null,
              });
              if (registered.hydrated) {
                void registered.hydrated.then(() => {
                  if (active) setSnapshot((prev) => (prev.run === run ? { ...prev, hydrated: true } : prev));
                });
              }
              return undefined;
            });
        })
        .catch((error: unknown) => {
          if (active) {
            setSnapshot({
              run,
              rows: EMPTY_ROWS as unknown as TRows,
              hydrated: true,
              error: error instanceof Error ? error : new Error(String(error)),
            });
          }
        });

      return () => {
        active = false;
        subscription?.unsubscribe();
      };
    }, [run]);

    // Derived, never stored: a snapshot is authoritative only for the run it was tagged with, and it is
    // "hydrated" only once the subscription's `hydrated` promise resolved (or there was none to await).
    // A failed run settles hydrated so an error is not reported as a permanent catch-up, and with no run
    // there is nothing catching up, so `hydrating` is false (`loading` alone reports the missing client).
    const settled = run != null && snapshot.run === run;
    const rows = run == null ? (EMPTY_ROWS as unknown as TRows) : snapshot.rows;
    const loading = ready && !settled;
    const hydrating = run != null && !(settled && snapshot.hydrated);
    const error = settled ? snapshot.error : null;

    return useMemo(() => ({ rows, loading, hydrating, error }), [rows, loading, hydrating, error]);
  }

  /**
   * Reactive query using a Drizzle select builder. The builder is re-created
   * whenever `deps` changes (same contract as `useEffect`). pgxsinkit scans the compiled SQL and
   * auto-activates any `lazy` relation the query reads — anywhere it appears (FROM, JOIN, subquery,
   * WHERE) — before subscribing. `use` (see {@link useLiveQueryRaw}) is an optional pre-activation hint,
   * not a requirement (ADR-0021).
   *
   * ```ts
   * const { rows } = useLiveDrizzleRows(
   *   (c) => c.drizzle.select().from(c.views.todos).orderBy(c.views.todos.createdAtUs),
   *   [],
   * );
   * // rows is fully typed from the view definition — no casts needed
   * ```
   */
  function useLiveDrizzleRows<TRows extends readonly unknown[]>(
    buildQuery: (client: SyncClient<TRegistry>) => DrizzleSqlBuilder<TRows>,
    deps: DependencyList,
    options?: { ready?: boolean; keepAliveMs?: number },
  ): LiveRowsState<TRows> {
    return useGuardedDrizzleLive(buildQuery, deps, options);
  }

  function useLiveDrizzleRow<TRows extends readonly unknown[]>(
    buildQuery: (client: SyncClient<TRegistry>) => DrizzleSqlBuilder<TRows>,
    deps: DependencyList,
    options?: { ready?: boolean; keepAliveMs?: number },
  ): { row: TRows[number] | null; loading: boolean; hydrating: boolean; error: Error | null } {
    const { rows, loading, hydrating, error } = useGuardedDrizzleLive(buildQuery, deps, options);
    return { row: rows[0] ?? null, loading, hydrating, error };
  }

  /**
   * The reactive query for a builder that embeds a raw `sql` fragment (ADR-0021): `use` names the `lazy`
   * relations it reads that the compiled-SQL scan can't see (a bare identifier inside raw SQL), so they
   * are guaranteed activated before it subscribes. The non-live counterpart of
   * `client.queryRaw({ use, build })`. Pure-Drizzle reads use `useLiveDrizzleRows` / `client.query((c) => …)`,
   * which auto-detect every relation and need no `use`.
   *
   * ```ts
   * const { rows, hydrating } = useLiveQueryRaw({
   *   use: ["archive"],
   *   build: (c) => c.drizzle.select().from(archiveTable).where(inArray(archiveTable.id, recentIds)),
   *   deps: [recentIds],
   * });
   * ```
   */
  function useLiveQueryRaw<TRows extends readonly unknown[]>(args: {
    use?: readonly SyncTableName<TRegistry>[];
    build: (client: SyncClient<TRegistry>) => DrizzleSqlBuilder<TRows>;
    deps?: DependencyList;
    ready?: boolean;
    keepAliveMs?: number;
  }): LiveRowsState<TRows> {
    return useGuardedDrizzleLive(args.build, args.deps ?? [], {
      ...(args.ready != null ? { ready: args.ready } : {}),
      ...(args.use ? { use: args.use } : {}),
      ...(args.keepAliveMs != null ? { keepAliveMs: args.keepAliveMs } : {}),
    });
  }

  function useLiveQueryRawRow<TRows extends readonly unknown[]>(args: {
    use?: readonly SyncTableName<TRegistry>[];
    build: (client: SyncClient<TRegistry>) => DrizzleSqlBuilder<TRows>;
    deps?: DependencyList;
    ready?: boolean;
    keepAliveMs?: number;
  }): { row: TRows[number] | null; loading: boolean; hydrating: boolean; error: Error | null } {
    const { rows, loading, hydrating, error } = useLiveQueryRaw(args);
    return { row: rows[0] ?? null, loading, hydrating, error };
  }

  // ─── Mutation-status hooks (slice 4) ─────────────────────────────────────

  /**
   * Reactive registry-wide mutation summary (`client.mutations.subscribeSummary`): per-status counts across
   * EVERY writable journal, folded to one {@link MutationSummary}. ONE subscription drives a global sync
   * indicator — no `hydrating` flag, because journals are local and never network-hydrated. Cheap enough to
   * mount permanently (ADR-0040 dedup: one registration regardless of subscriber count).
   *
   * `loading` and `summary` are derived from which subscription the latest snapshot belongs to, so a
   * `ready: false → true` interlude keeps the previous summary while it re-subscribes (`loading: true`)
   * instead of briefly reporting the zero summary.
   */
  function useMutationSummary(options?: { ready?: boolean }): {
    summary: MutationSummary;
    loading: boolean;
    error: Error | null;
  } {
    const client = useContext(SyncClientContext);
    const ready = options?.ready ?? true;

    // The run token (see `useLiveRows`): the client is the only subscription input, wrapped so that a
    // `ready` flip yields a fresh identity — otherwise the pre-flip snapshot would read as settled.
    const run = useMemo(() => (ready && client != null ? { client } : null), [ready, client]);

    const [snapshot, setSnapshot] = useState<{ run: typeof run; summary: MutationSummary; error: Error | null }>({
      run: null,
      summary: EMPTY_MUTATION_SUMMARY,
      error: null,
    });

    useEffect(() => {
      if (run == null) return;

      let active = true;
      let subscription: MutationSummarySubscription | undefined;

      void run.client.mutations
        .subscribeSummary((summary) => {
          if (active) setSnapshot({ run, summary, error: null });
        })
        .then((registered) => {
          if (!active) {
            registered.unsubscribe();
            return;
          }
          subscription = registered;
          setSnapshot({ run, summary: registered.initial, error: null });
        })
        .catch((error: unknown) => {
          if (active) {
            setSnapshot({
              run,
              summary: EMPTY_MUTATION_SUMMARY,
              error: error instanceof Error ? error : new Error(String(error)),
            });
          }
        });

      return () => {
        active = false;
        subscription?.unsubscribe();
      };
    }, [run]);

    // Derived, never stored — see `useLiveRows`.
    const settled = run != null && snapshot.run === run;
    const summary = run == null ? EMPTY_MUTATION_SUMMARY : snapshot.summary;
    const loading = ready && !settled;
    const error = settled ? snapshot.error : null;

    return useMemo(() => ({ summary, loading, error }), [summary, loading, error]);
  }

  /**
   * Reactive filtered mutation detail list (`client.mutations.subscribe`): normalized journal rows across
   * every writable table, filtered by `table` / `entityKey` / `statuses` / `limit`, ordered newest-first.
   * Route/feature-scoped — mount it where a diagnostics view is open, not app-wide (prefer
   * {@link useMutationSummary} for a global indicator). No `hydrating` flag (journals are local).
   *
   * `loading` and `rows` are derived from which subscription the latest snapshot belongs to, so a
   * `ready: false → true` interlude with unchanged filters keeps the previous rows while it re-subscribes
   * (`loading: true`) instead of briefly reporting zero rows — the same "keep the previous rows while
   * loading" policy already applied across a filter change.
   */
  function useMutationList(options?: MutationListOptions<TRegistry> & { ready?: boolean }): {
    rows: MutationSummaryDetail[];
    loading: boolean;
    error: Error | null;
  } {
    const client = useContext(SyncClientContext);
    const ready = options?.ready ?? true;
    // Split the `ready` UI flag off the query filters so it never becomes a filter.
    const { ready: _ready, ...filters } = options ?? {};
    void _ready;
    const filtersKey = JSON.stringify(filters);
    const stableFilters = useMemo<MutationListOptions<TRegistry>>(
      () => JSON.parse(filtersKey) as MutationListOptions<TRegistry>,
      [filtersKey],
    );

    // The run token (see `useLiveRows`): the client and the JSON-stable filters are the only subscription
    // inputs, so its identity changes exactly when the subscription must be rebuilt — which lets `loading`
    // be derived during render instead of written synchronously from the effect.
    const run = useMemo(
      () => (ready && client != null ? { client, filters: stableFilters } : null),
      [ready, client, stableFilters],
    );

    const [snapshot, setSnapshot] = useState<{ run: typeof run; rows: MutationSummaryDetail[]; error: Error | null }>({
      run: null,
      rows: EMPTY_ROWS,
      error: null,
    });

    useEffect(() => {
      if (run == null) return;

      let active = true;
      let subscription: { unsubscribe: () => void } | undefined;

      void run.client.mutations
        .subscribe(run.filters, (rows) => {
          if (active) setSnapshot({ run, rows, error: null });
        })
        .then((registered) => {
          if (!active) {
            registered.unsubscribe();
            return;
          }
          subscription = registered;
          setSnapshot({ run, rows: registered.initial, error: null });
        })
        .catch((error: unknown) => {
          if (active) {
            setSnapshot({ run, rows: EMPTY_ROWS, error: error instanceof Error ? error : new Error(String(error)) });
          }
        });

      return () => {
        active = false;
        subscription?.unsubscribe();
      };
    }, [run]);

    // Derived, never stored — see `useLiveRows`.
    const settled = run != null && snapshot.run === run;
    const rows = run == null ? EMPTY_ROWS : snapshot.rows;
    const loading = ready && !settled;
    const error = settled ? snapshot.error : null;

    return useMemo(() => ({ rows, loading, error }), [rows, loading, error]);
  }

  return {
    SyncClientProvider,
    useSyncClient,
    useLiveRows,
    useLiveRow,
    useLiveDrizzleRows,
    useLiveDrizzleRow,
    useLiveQueryRaw,
    useLiveQueryRawRow,
    useMutationSummary,
    useMutationList,
  };
}
