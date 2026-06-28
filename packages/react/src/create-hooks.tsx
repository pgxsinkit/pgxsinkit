import type { LiveQuery, LiveQueryResults } from "@electric-sql/pglite/live";
import { createContext, type DependencyList, type ReactNode, useContext, useEffect, useMemo, useState } from "react";

import { type ClientPGlite, createRecordingClient, type SyncClient, syncDebug } from "@pgxsinkit/client";
import type { SyncTableName, SyncTableRegistry } from "@pgxsinkit/contracts";

import { remapLiveRow, type SelectedFields } from "./remap-live-row";

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

/** Reactive read result. `hydrating` is true while a lazy relation the query reads is being activated. */
interface LiveRowsState<TRows> {
  rows: TRows;
  loading: boolean;
  hydrating: boolean;
  error: Error | null;
}

/**
 * Creates a set of React hooks and a context provider bound to a specific
 * `SyncTableRegistry` type. Call this once at the module level in your app:
 *
 * ```ts
 * export const { SyncClientProvider, useSyncClient, useLiveRows, useLiveDrizzleRows, useLiveQuery } =
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

  function useLiveRows<TRow extends Record<string, unknown> = Record<string, unknown>>(
    query: string,
    options?: {
      params?: readonly unknown[];
      ready?: boolean;
      /** Explicit PGlite instance — overrides the context client. Useful in tests or multi-db scenarios. */
      pglite?: ClientPGlite;
    },
  ): { rows: TRow[]; loading: boolean; hydrating: boolean; error: Error | null } {
    const contextClient = useContext(SyncClientContext);
    const pglite = options?.pglite ?? contextClient?.pglite;
    const ready = options?.ready ?? true;
    // Guard raw SQL with the lazy-relation tripwire (ADR-0021) when we have the full client — a raw query
    // cannot drive auto-activation, so a lazy reference it makes must be pre-activated or it throws. When
    // only a bare `pglite` is supplied (no client), there is no seam, so it runs unguarded.
    const guard = options?.pglite == null ? contextClient : null;

    const paramsKey = JSON.stringify(options?.params ?? []);
    const stableParams = useMemo<unknown[]>(() => JSON.parse(paramsKey) as unknown[], [paramsKey]);

    const [state, setState] = useState<LiveRowsState<TRow[]>>({
      rows: [],
      loading: ready,
      hydrating: ready,
      error: null,
    });

    useEffect(() => {
      if (!ready || pglite == null) {
        setState({ rows: [], loading: ready, hydrating: false, error: null });
        return;
      }

      let active = true;
      let liveQuery: LiveQuery<TRow> | undefined;
      let listener: ((results: LiveQueryResults<TRow>) => void) | undefined;

      setState((prev) => ({ rows: prev.rows, loading: true, hydrating: guard != null, error: null }));

      // Tripwire first (no-op when there is no guarding client), then register the live query.
      void (guard ? guard.prepareQuery({ sql: query }) : Promise.resolve())
        .then(() => {
          if (!active) return undefined;
          setState((prev) => ({ rows: prev.rows, loading: true, hydrating: false, error: null }));
          return pglite.live.query<TRow>(query, stableParams).then((registered: LiveQuery<TRow>) => {
            if (!active) return registered.unsubscribe();
            liveQuery = registered;
            setState({ rows: registered.initialResults.rows, loading: false, hydrating: false, error: null });
            listener = (results) => {
              if (active) {
                syncDebug("live query updated → re-render", { rows: results.rows.length });
                setState({ rows: results.rows, loading: false, hydrating: false, error: null });
              }
            };
            registered.subscribe(listener);
            return undefined;
          });
        })
        .catch((error: unknown) => {
          if (active) {
            setState({
              rows: [],
              loading: false,
              hydrating: false,
              error: error instanceof Error ? error : new Error(String(error)),
            });
          }
        });

      return () => {
        active = false;
        if (liveQuery) void liveQuery.unsubscribe(listener);
      };
    }, [pglite, guard, query, ready, stableParams]);

    return state;
  }

  function useLiveRow<TRow extends Record<string, unknown> = Record<string, unknown>>(
    query: string,
    options?: { params?: readonly unknown[]; ready?: boolean; pglite?: ClientPGlite },
  ): { row: TRow | null; loading: boolean; hydrating: boolean; error: Error | null } {
    const { rows, loading, hydrating, error } = useLiveRows<TRow>(query, options);
    return { row: rows[0] ?? null, loading, hydrating, error };
  }

  // ─── Drizzle typed live hooks ─────────────────────────────────────────────

  /**
   * Shared implementation behind {@link useLiveDrizzleRows} (auto-detect) and {@link useLiveQuery}
   * (declared-safe). Builds the query through a recording client so (A) accessor references are
   * captured, retains the builder for (C) structural detection, then `client.prepareQuery` activates
   * every lazy relation the query reads — the union of `use`, (A), and (C) — and runs the tripwire
   * before the live query subscribes (ADR-0021).
   */
  function useGuardedDrizzleLive<TRows extends readonly unknown[]>(
    buildQuery: (client: SyncClient<TRegistry>) => DrizzleSqlBuilder<TRows>,
    deps: DependencyList,
    options?: { ready?: boolean; use?: readonly SyncTableName<TRegistry>[] },
  ): LiveRowsState<TRows> {
    const contextClient = useContext(SyncClientContext);
    const ready = options?.ready ?? true;
    const useList = options?.use;
    const useKey = useList != null ? JSON.stringify(useList) : "";

    const queryInfo = useMemo(
      () => {
        if (contextClient == null) return null;
        // (A) record relations reached through the client during build; keep the builder for (C).
        const recording = createRecordingClient(contextClient);
        const query = buildQuery(recording.client);
        return {
          sql: query.toSQL(),
          selectedFields: query._?.selectedFields,
          builder: query,
          accessed: [...recording.accessed],
        };
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

      const { sql, selectedFields, builder, accessed } = queryInfo;
      // PGlite's live query returns rows keyed by the underlying (snake_case) column names; remap them
      // back to the Drizzle select's field keys so the rows match the builder's inferred (camelCase) type.
      const mapRows = (rows: readonly unknown[]): TRows =>
        rows.map((row) => remapLiveRow(selectedFields, row as Record<string, unknown>)) as unknown as TRows;

      let active = true;
      let liveQuery: LiveQuery<TRows[number]> | undefined;
      let listener: ((results: LiveQueryResults<TRows[number]>) => void) | undefined;

      setState((prev) => ({ rows: prev.rows, loading: true, hydrating: true, error: null }));

      // Activate the lazy relations the query reads (use ∪ (A) ∪ (C)) and run the tripwire, THEN subscribe
      // — so a query is never registered against an un-hydrated lazy relation (ADR-0021).
      void contextClient
        .prepareQuery({ sql: sql.sql, builder, accessed, ...(useList ? { use: useList } : {}) })
        .then(() => {
          if (!active) return undefined;
          setState((prev) => ({ rows: prev.rows, loading: true, hydrating: false, error: null }));
          return contextClient.pglite.live.query<TRows[number]>(sql.sql, sql.params).then((registered) => {
            if (!active) return registered.unsubscribe();
            liveQuery = registered;
            setState({ rows: mapRows(registered.initialResults.rows), loading: false, hydrating: false, error: null });
            listener = (results) => {
              if (active) {
                syncDebug("live query updated → re-render", { rows: results.rows.length });
                setState({ rows: mapRows(results.rows), loading: false, hydrating: false, error: null });
              }
            };
            registered.subscribe(listener);
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
        if (liveQuery) void liveQuery.unsubscribe(listener);
      };
      // sqlKey/useKey are stable JSON snapshots; queryInfo is captured inside the effect.
      // oxlint-disable-next-line react-hooks/exhaustive-deps -- sqlKey/useKey are the stable proxies for queryInfo
    }, [contextClient, sqlKey, useKey, ready]);

    return state;
  }

  /**
   * Reactive query using a Drizzle select builder. The builder is re-created
   * whenever `deps` changes (same contract as `useEffect`). pgxsinkit auto-detects the relations the
   * query reads and activates any `lazy` ones before subscribing; a lazy relation it cannot detect
   * (e.g. referenced only in a subquery, or via raw SQL) throws rather than reading stale data — use
   * {@link useLiveQuery} with an explicit `use` for those (ADR-0021).
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
    options?: { ready?: boolean },
  ): LiveRowsState<TRows> {
    return useGuardedDrizzleLive(buildQuery, deps, options);
  }

  function useLiveDrizzleRow<TRows extends readonly unknown[]>(
    buildQuery: (client: SyncClient<TRegistry>) => DrizzleSqlBuilder<TRows>,
    deps: DependencyList,
    options?: { ready?: boolean },
  ): { row: TRows[number] | null; loading: boolean; hydrating: boolean; error: Error | null } {
    const { rows, loading, hydrating, error } = useGuardedDrizzleLive(buildQuery, deps, options);
    return { row: rows[0] ?? null, loading, hydrating, error };
  }

  /**
   * The declared-safe reactive query (ADR-0021): `use` names the `lazy` relations the query reads, so
   * they are guaranteed activated before it subscribes regardless of how they are referenced (subquery,
   * WHERE, directly-imported table). The non-live counterpart of `client.query({ use, build })`.
   *
   * ```ts
   * const { rows, hydrating } = useLiveQuery({
   *   use: ["archive"],
   *   build: (c) => c.drizzle.select().from(archiveTable).where(inArray(archiveTable.id, recentIds)),
   *   deps: [recentIds],
   * });
   * ```
   */
  function useLiveQuery<TRows extends readonly unknown[]>(args: {
    use?: readonly SyncTableName<TRegistry>[];
    build: (client: SyncClient<TRegistry>) => DrizzleSqlBuilder<TRows>;
    deps?: DependencyList;
    ready?: boolean;
  }): LiveRowsState<TRows> {
    return useGuardedDrizzleLive(args.build, args.deps ?? [], {
      ...(args.ready != null ? { ready: args.ready } : {}),
      ...(args.use ? { use: args.use } : {}),
    });
  }

  function useLiveQueryRow<TRows extends readonly unknown[]>(args: {
    use?: readonly SyncTableName<TRegistry>[];
    build: (client: SyncClient<TRegistry>) => DrizzleSqlBuilder<TRows>;
    deps?: DependencyList;
    ready?: boolean;
  }): { row: TRows[number] | null; loading: boolean; hydrating: boolean; error: Error | null } {
    const { rows, loading, hydrating, error } = useLiveQuery(args);
    return { row: rows[0] ?? null, loading, hydrating, error };
  }

  return {
    SyncClientProvider,
    useSyncClient,
    useLiveRows,
    useLiveRow,
    useLiveDrizzleRows,
    useLiveDrizzleRow,
    useLiveQuery,
    useLiveQueryRow,
  };
}
