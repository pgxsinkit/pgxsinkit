import type { LiveQuery, LiveQueryResults } from "@electric-sql/pglite/live";
import { createContext, type DependencyList, type ReactNode, useContext, useEffect, useMemo, useState } from "react";

import type { ClientPGlite, SyncClient } from "@pgxsinkit/client";
import type { SyncTableRegistry } from "@pgxsinkit/contracts";

/**
 * Minimal interface satisfied by every Drizzle select/query builder.
 * Calling `.toSQL()` extracts the SQL string and positional params without
 * executing the query, so they can be fed into PGlite's live query API.
 */
interface DrizzleSqlBuilder<TRows extends readonly unknown[]> extends PromiseLike<TRows> {
  toSQL(): { sql: string; params: unknown[] };
}

/**
 * Creates a set of React hooks and a context provider bound to a specific
 * `SyncTableRegistry` type. Call this once at the module level in your app:
 *
 * ```ts
 * export const { SyncClientProvider, useSyncClient, useLiveRows, useLiveDrizzleRows } =
 *   createSyncClientHooks<typeof mySyncRegistry>();
 * ```
 */
export function createSyncClientHooks<TRegistry extends SyncTableRegistry>() {
  const SyncClientContext = createContext<SyncClient<TRegistry> | null>(null);

  // ─── Provider ────────────────────────────────────────────────────────────

  function SyncClientProvider({ client, children }: { client: SyncClient<TRegistry>; children: ReactNode }) {
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
  ): { rows: TRow[]; loading: boolean; error: Error | null } {
    const contextClient = useContext(SyncClientContext);
    const pglite = options?.pglite ?? contextClient?.pglite;
    const ready = options?.ready ?? true;

    const paramsKey = JSON.stringify(options?.params ?? []);
    const stableParams = useMemo<unknown[]>(() => JSON.parse(paramsKey) as unknown[], [paramsKey]);

    const [state, setState] = useState<{ rows: TRow[]; loading: boolean; error: Error | null }>({
      rows: [],
      loading: ready,
      error: null,
    });

    useEffect(() => {
      if (!ready || pglite == null) {
        setState({ rows: [], loading: ready, error: null });
        return;
      }

      let active = true;
      let liveQuery: LiveQuery<TRow> | undefined;
      let listener: ((results: LiveQueryResults<TRow>) => void) | undefined;

      setState((prev) => ({ rows: prev.rows, loading: true, error: null }));

      void pglite.live
        .query<TRow>(query, stableParams)
        .then((registered: LiveQuery<TRow>) => {
          if (!active) return registered.unsubscribe();
          liveQuery = registered;
          setState({ rows: registered.initialResults.rows, loading: false, error: null });
          listener = (results) => {
            if (active) setState({ rows: results.rows, loading: false, error: null });
          };
          registered.subscribe(listener);
          return undefined;
        })
        .catch((error: unknown) => {
          if (active) {
            setState({
              rows: [],
              loading: false,
              error: error instanceof Error ? error : new Error(String(error)),
            });
          }
        });

      return () => {
        active = false;
        if (liveQuery) void liveQuery.unsubscribe(listener);
      };
    }, [pglite, query, ready, stableParams]);

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
   * Reactive query using a Drizzle select builder. The builder is re-created
   * whenever `deps` changes (same contract as `useEffect`).
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
  ): { rows: TRows; loading: boolean; error: Error | null } {
    const contextClient = useContext(SyncClientContext);
    const ready = options?.ready ?? true;

    const sqlObj = useMemo(
      () => (contextClient != null ? buildQuery(contextClient).toSQL() : null),
      // buildQuery intentionally excluded; callers control reactivity via deps. Spread is valid and intentional.
      // oxlint-disable-next-line react-hooks/exhaustive-deps -- intentional: callers own deps, spread is by design
      [contextClient, ...deps],
    );

    const sqlKey = sqlObj != null ? JSON.stringify(sqlObj) : null;

    const [state, setState] = useState<{ rows: TRows; loading: boolean; error: Error | null }>({
      rows: [] as unknown as TRows,
      loading: ready,
      error: null,
    });

    useEffect(() => {
      if (!ready || contextClient == null || sqlObj == null) {
        setState({ rows: [] as unknown as TRows, loading: ready, error: null });
        return;
      }

      let active = true;
      let liveQuery: LiveQuery<TRows[number]> | undefined;
      let listener: ((results: LiveQueryResults<TRows[number]>) => void) | undefined;

      setState((prev) => ({ rows: prev.rows, loading: true, error: null }));

      void contextClient.pglite.live
        .query<TRows[number]>(sqlObj.sql, sqlObj.params)
        .then((registered: LiveQuery<TRows[number]>) => {
          if (!active) return registered.unsubscribe();
          liveQuery = registered;
          setState({ rows: registered.initialResults.rows as unknown as TRows, loading: false, error: null });
          listener = (results) => {
            if (active) setState({ rows: results.rows as unknown as TRows, loading: false, error: null });
          };
          registered.subscribe(listener);
          return undefined;
        })
        .catch((error: unknown) => {
          if (active) {
            setState({
              rows: [] as unknown as TRows,
              loading: false,
              error: error instanceof Error ? error : new Error(String(error)),
            });
          }
        });

      return () => {
        active = false;
        if (liveQuery) void liveQuery.unsubscribe(listener);
      };
      // sqlKey is a stable JSON snapshot of sql+params; sqlObj is captured inside the effect from sqlKey
      // oxlint-disable-next-line react-hooks/exhaustive-deps -- sqlKey is the stable proxy for sqlObj
    }, [contextClient, sqlKey, ready]);

    return state;
  }

  function useLiveDrizzleRow<TRows extends readonly unknown[]>(
    buildQuery: (client: SyncClient<TRegistry>) => DrizzleSqlBuilder<TRows>,
    deps: DependencyList,
    options?: { ready?: boolean },
  ): { row: TRows[number] | null; loading: boolean; error: Error | null } {
    const { rows, loading, error } = useLiveDrizzleRows(buildQuery, deps, options);
    return { row: rows[0] ?? null, loading, error };
  }

  return {
    SyncClientProvider,
    useSyncClient,
    useLiveRows,
    useLiveRow,
    useLiveDrizzleRows,
    useLiveDrizzleRow,
  };
}
