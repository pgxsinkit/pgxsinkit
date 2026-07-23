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

    const [state, setState] = useState<{ rows: TRow[]; loading: boolean; error: Error | null }>({
      rows: [],
      loading: ready,
      error: null,
    });

    useEffect(() => {
      const canRun = ready && (overridePglite != null || contextClient != null);
      if (!canRun) {
        setState({ rows: [], loading: ready, error: null });
        return;
      }

      let active = true;
      let subscription: LiveRowsSubscription<TRow> | undefined;

      setState((prev) => ({ rows: prev.rows, loading: true, error: null }));

      const onRows = (rows: TRow[]) => {
        if (active) {
          syncDebug("live query updated → re-render", { rows: rows.length });
          setState({ rows, loading: false, error: null });
        }
      };

      // The raw-PGlite override subscribes directly (unchanged); the seam path is the SAME `pglite.live`
      // wrapper the in-process client exposes, so behaviour is identical when no override is given.
      const subscribe = overridePglite
        ? subscribeRawPglite<TRow>(overridePglite, query, stableParams, onRows)
        : contextClient!.subscribeLiveRows<Record<string, unknown>>({ sql: query, params: stableParams }, (rows) =>
            onRows(rows as TRow[]),
          );

      void subscribe
        .then((registered) => {
          if (!active) {
            registered.unsubscribe();
            return;
          }
          subscription = registered as LiveRowsSubscription<TRow>;
          setState({ rows: registered.initialRows as TRow[], loading: false, error: null });
        })
        .catch((error: unknown) => {
          if (active) {
            setState({ rows: [], loading: false, error: error instanceof Error ? error : new Error(String(error)) });
          }
        });

      return () => {
        active = false;
        subscription?.unsubscribe();
      };
    }, [contextClient, overridePglite, query, ready, stableParams]);

    return state;
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

    const [state, setState] = useState<LiveRowsState<TRows>>({
      rows: [] as unknown as TRows,
      loading: ready,
      hydrating: ready,
      error: null,
    });

    useEffect(() => {
      if (!ready || contextClient == null || queryInfo == null) {
        setState({ rows: [] as unknown as TRows, loading: ready, hydrating: false, error: null });
        return;
      }

      const { sql, selectedFields } = queryInfo;
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

      setState((prev) => ({ rows: prev.rows, loading: true, hydrating: true, error: null }));

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
      void contextClient
        .prepareQuery({ sql: sql.sql, ...(useList ? { use: useList } : {}) })
        .then(() => {
          if (!active) return undefined;
          return contextClient
            .subscribeLiveRows<Record<string, unknown>>(
              {
                sql: sql.sql,
                params: sql.params,
                ...(fields ? { fields } : {}),
                ...(useList ? { use: useList } : {}),
                ...(keepAliveMs != null ? { keepAliveMs } : {}),
              },
              (rows) => {
                if (active) {
                  syncDebug("live query updated → re-render", { rows: rows.length });
                  setState((prev) => ({ rows: mapRows(rows), loading: false, hydrating: prev.hydrating, error: null }));
                }
              },
            )
            .then((registered) => {
              if (!active) {
                registered.unsubscribe();
                return undefined;
              }
              subscription = registered;
              setState((prev) => ({
                rows: mapRows(registered.initialRows),
                loading: false,
                hydrating: registered.hydrated != null ? prev.hydrating : false,
                error: null,
              }));
              if (registered.hydrated) {
                void registered.hydrated.then(() => {
                  if (active) setState((prev) => ({ ...prev, hydrating: false }));
                });
              }
              return undefined;
            });
        })
        .catch((error: unknown) => {
          if (active) {
            setState({
              rows: [] as unknown as TRows,
              loading: false,
              hydrating: false,
              error: error instanceof Error ? error : new Error(String(error)),
            });
          }
        });

      return () => {
        active = false;
        subscription?.unsubscribe();
      };
      // sqlKey/useKey are stable JSON snapshots; queryInfo is captured inside the effect.
      // oxlint-disable-next-line react-hooks/exhaustive-deps -- sqlKey/useKey are the stable proxies for queryInfo
    }, [contextClient, sqlKey, useKey, ready]);

    return state;
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
   */
  function useMutationSummary(options?: { ready?: boolean }): {
    summary: MutationSummary;
    loading: boolean;
    error: Error | null;
  } {
    const client = useContext(SyncClientContext);
    const ready = options?.ready ?? true;

    const [state, setState] = useState<{ summary: MutationSummary; loading: boolean; error: Error | null }>({
      summary: EMPTY_MUTATION_SUMMARY,
      loading: ready,
      error: null,
    });

    useEffect(() => {
      if (!ready || client == null) {
        setState({ summary: EMPTY_MUTATION_SUMMARY, loading: ready, error: null });
        return;
      }

      let active = true;
      let subscription: MutationSummarySubscription | undefined;
      setState((prev) => ({ summary: prev.summary, loading: true, error: null }));

      void client.mutations
        .subscribeSummary((summary) => {
          if (active) setState({ summary, loading: false, error: null });
        })
        .then((registered) => {
          if (!active) {
            registered.unsubscribe();
            return;
          }
          subscription = registered;
          setState({ summary: registered.initial, loading: false, error: null });
        })
        .catch((error: unknown) => {
          if (active) {
            setState({
              summary: EMPTY_MUTATION_SUMMARY,
              loading: false,
              error: error instanceof Error ? error : new Error(String(error)),
            });
          }
        });

      return () => {
        active = false;
        subscription?.unsubscribe();
      };
    }, [client, ready]);

    return state;
  }

  /**
   * Reactive filtered mutation detail list (`client.mutations.subscribe`): normalized journal rows across
   * every writable table, filtered by `table` / `entityKey` / `statuses` / `limit`, ordered newest-first.
   * Route/feature-scoped — mount it where a diagnostics view is open, not app-wide (prefer
   * {@link useMutationSummary} for a global indicator). No `hydrating` flag (journals are local).
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

    const [state, setState] = useState<{ rows: MutationSummaryDetail[]; loading: boolean; error: Error | null }>({
      rows: [],
      loading: ready,
      error: null,
    });

    useEffect(() => {
      if (!ready || client == null) {
        setState({ rows: [], loading: ready, error: null });
        return;
      }

      let active = true;
      let subscription: { unsubscribe: () => void } | undefined;
      setState((prev) => ({ rows: prev.rows, loading: true, error: null }));

      void client.mutations
        .subscribe(stableFilters, (rows) => {
          if (active) setState({ rows, loading: false, error: null });
        })
        .then((registered) => {
          if (!active) {
            registered.unsubscribe();
            return;
          }
          subscription = registered;
          setState({ rows: registered.initial, loading: false, error: null });
        })
        .catch((error: unknown) => {
          if (active) {
            setState({ rows: [], loading: false, error: error instanceof Error ? error : new Error(String(error)) });
          }
        });

      return () => {
        active = false;
        subscription?.unsubscribe();
      };
      // stableFilters is the JSON-stable proxy for the filter inputs.
      // oxlint-disable-next-line react-hooks/exhaustive-deps -- filtersKey is the stable proxy for stableFilters
    }, [client, ready, filtersKey]);

    return state;
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
