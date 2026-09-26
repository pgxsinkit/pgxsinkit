// Began as a copy of `@electric-sql/pglite` (taken under its PostgreSQL License option, © ElectricSQL
// — see NOTICE). Owned outright (ADR-0062); compatibility with PGlite is an anti-goal — evolve freely.

import { randomId } from "../core/names";
import type { Extension, Pgwasm, Results, Row, Transaction } from "../interface";
import { debounceMutex } from "./debounce-mutex";
import { formatQuery } from "./format-query";
import type {
  Change,
  LiveChanges,
  LiveChangesOptions,
  LiveIncrementalQueryOptions,
  LiveNamespace,
  LiveQuery,
  LiveQueryOptions,
  LiveQueryResults,
} from "./interface";

export type {
  Change,
  ChangeDelete,
  ChangeInsert,
  ChangeReset,
  ChangeUpdate,
  LiveChanges,
  LiveChangesOptions,
  LiveIncrementalQueryOptions,
  LiveNamespace,
  LiveQuery,
  LiveQueryOptions,
  LiveQueryResults,
  PgwasmWithLive,
} from "./interface";

const MAX_RETRIES = 5;

interface ViewTable {
  table_name: string;
  schema_name: string;
  table_oid: number;
  schema_oid: number;
}

type Unlisten = (tx?: Transaction) => Promise<void>;

function runResultCallbacks<T>(callbacks: readonly ((results: Results<T>) => void)[], results: Results<T>): void {
  for (const callback of callbacks) callback(results);
}

function runChangeCallbacks<T>(callbacks: readonly ((changes: Change<T>[]) => void)[], changes: Change<T>[]): void {
  for (const callback of callbacks) callback(changes);
}

/**
 * Every table a view reads, following views it reads recursively.
 */
async function getTablesForView(tx: Transaction, viewName: string): Promise<ViewTable[]> {
  const result = await tx.query<ViewTable>(
    `
      WITH RECURSIVE view_dependencies AS (
        -- Base case: the view's own dependencies
        SELECT DISTINCT
          cl.relname AS dependent_name,
          n.nspname AS schema_name,
          cl.oid AS dependent_oid,
          n.oid AS schema_oid,
          cl.relkind = 'v' AS is_view
        FROM pg_rewrite r
        JOIN pg_depend d ON r.oid = d.objid
        JOIN pg_class cl ON d.refobjid = cl.oid
        JOIN pg_namespace n ON cl.relnamespace = n.oid
        WHERE
          r.ev_class = (
              SELECT oid FROM pg_class WHERE relname = $1 AND relkind = 'v'
          )
          AND d.deptype = 'n'

        UNION ALL

        -- Recursive case: the dependencies of the views found so far
        SELECT DISTINCT
          cl.relname AS dependent_name,
          n.nspname AS schema_name,
          cl.oid AS dependent_oid,
          n.oid AS schema_oid,
          cl.relkind = 'v' AS is_view
        FROM view_dependencies vd
        JOIN pg_rewrite r ON vd.dependent_name = (
          SELECT relname FROM pg_class WHERE oid = r.ev_class AND relkind = 'v'
        )
        JOIN pg_depend d ON r.oid = d.objid
        JOIN pg_class cl ON d.refobjid = cl.oid
        JOIN pg_namespace n ON cl.relnamespace = n.oid
        WHERE d.deptype = 'n'
      )
      SELECT DISTINCT
        dependent_name AS table_name,
        schema_name,
        dependent_oid AS table_oid,
        schema_oid
      FROM view_dependencies
      WHERE NOT is_view; -- only tables, not the views in between
    `,
    [viewName],
  );
  return result.rows.map((row) => ({
    table_name: row.table_name,
    schema_name: row.schema_name,
    table_oid: row.table_oid,
    schema_oid: row.schema_oid,
  }));
}

/** A statement-level NOTIFY trigger on each table, created once per table per database. */
async function addNotifyTriggersToTables(
  tx: Transaction,
  tables: readonly ViewTable[],
  tableNotifyTriggersAdded: Set<string>,
): Promise<void> {
  const triggers = tables
    .filter((table) => !tableNotifyTriggersAdded.has(`${table.schema_oid}_${table.table_oid}`))
    .map(
      (table) => `
      CREATE OR REPLACE FUNCTION "_notify_${table.schema_oid}_${table.table_oid}"() RETURNS TRIGGER AS $$
      BEGIN
        PERFORM pg_notify('table_change__${table.schema_oid}__${table.table_oid}', '');
        RETURN NULL;
      END;
      $$ LANGUAGE plpgsql;
      CREATE OR REPLACE TRIGGER "_notify_trigger_${table.schema_oid}_${table.table_oid}"
      AFTER INSERT OR UPDATE OR DELETE ON "${table.schema_name}"."${table.table_name}"
      FOR EACH STATEMENT EXECUTE FUNCTION "_notify_${table.schema_oid}_${table.table_oid}"();
      `,
    )
    .join("\n");
  if (triggers.trim() !== "") {
    await tx.exec(triggers);
  }
  for (const table of tables) tableNotifyTriggersAdded.add(`${table.schema_oid}_${table.table_oid}`);
}

function listenToTables(tx: Transaction, tables: readonly ViewTable[], onChange: () => void): Promise<Unlisten[]> {
  return Promise.all(
    tables.map((table) =>
      tx.listen(`"table_change__${table.schema_oid}__${table.table_oid}"`, () => {
        onChange();
      }),
    ),
  );
}

function unsubscribeOnAbort(signal: AbortSignal | undefined, unsubscribe: () => Promise<void>): Promise<void> | void {
  if (signal?.aborted) return unsubscribe();
  signal?.addEventListener(
    "abort",
    () => {
      void unsubscribe();
    },
    { once: true },
  );
}

function createNamespace(pg: Pgwasm): LiveNamespace {
  // The notify triggers are only ever added, never removed: remember which tables have one.
  const tableNotifyTriggersAdded = new Set<string>();

  async function query<T>(
    queryOrOptions: string | LiveQueryOptions<T>,
    paramsArg?: readonly unknown[] | null,
    callbackArg?: (results: Results<T>) => void,
  ): Promise<LiveQuery<T>> {
    let signal: AbortSignal | undefined;
    let offset: number | undefined;
    let limit: number | undefined;
    let query: string;
    let params: readonly unknown[] | null | undefined = paramsArg;
    let callback = callbackArg;
    if (typeof queryOrOptions === "string") {
      query = queryOrOptions;
    } else {
      signal = queryOrOptions.signal;
      params = queryOrOptions.params;
      callback = queryOrOptions.callback;
      offset = queryOrOptions.offset;
      limit = queryOrOptions.limit;
      query = queryOrOptions.query;
    }

    if ((offset === undefined) !== (limit === undefined)) {
      throw new Error("offset and limit must be provided together");
    }
    const isWindowed = offset !== undefined && limit !== undefined;
    if (
      isWindowed &&
      (typeof offset !== "number" || Number.isNaN(offset) || typeof limit !== "number" || Number.isNaN(limit))
    ) {
      throw new Error("offset and limit must be numbers");
    }

    let callbacks: ((results: Results<T>) => void)[] = callback ? [callback] : [];
    const id = randomId();
    let dead = false;
    let totalCount: number | undefined;
    let results: LiveQueryResults<T> = { rows: [], fields: [] };
    let unsubList: Unlisten[] = [];

    // `refresh` is created after `init()` completes, but init registers the listeners that call it: a
    // notification during init is recorded and replayed once `refresh` exists.
    let refreshReady = false;
    let refreshPending = false;
    const notifyRefresh = () => {
      if (!refreshReady) {
        refreshPending = true;
        return;
      }
      void refresh();
    };

    const init = async () => {
      await pg.transaction(async (tx) => {
        const formattedQuery = params && params.length > 0 ? await formatQuery(pg, query, params, tx) : query;
        await tx.exec(`CREATE OR REPLACE TEMP VIEW live_query_${id}_view AS ${formattedQuery}`);

        const tables = await getTablesForView(tx, `live_query_${id}_view`);
        await addNotifyTriggersToTables(tx, tables, tableNotifyTriggersAdded);

        if (isWindowed) {
          await tx.exec(`
            PREPARE live_query_${id}_get(int, int) AS
            SELECT * FROM live_query_${id}_view
            LIMIT $1 OFFSET $2;
          `);
          await tx.exec(`
            PREPARE live_query_${id}_get_total_count AS
            SELECT COUNT(*) FROM live_query_${id}_view;
          `);
          totalCount = (await tx.query<{ count: number }>(`EXECUTE live_query_${id}_get_total_count;`)).rows[0]?.count;
          results = {
            ...(await tx.query<T>(`EXECUTE live_query_${id}_get(${limit}, ${offset});`)),
            ...(offset === undefined ? {} : { offset }),
            ...(limit === undefined ? {} : { limit }),
            ...(totalCount === undefined ? {} : { totalCount }),
          };
        } else {
          await tx.exec(`
            PREPARE live_query_${id}_get AS
            SELECT * FROM live_query_${id}_view;
          `);
          results = await tx.query<T>(`EXECUTE live_query_${id}_get;`);
        }
        unsubList = await listenToTables(tx, tables, notifyRefresh);
      });
    };
    await init();

    const refresh = debounceMutex(
      async ({ offset: newOffset, limit: newLimit }: { offset?: number; limit?: number } = {}) => {
        // A windowed query can be refreshed onto another window.
        if (!isWindowed && (newOffset !== undefined || newLimit !== undefined)) {
          throw new Error("offset and limit cannot be provided for non-windowed queries");
        }
        if (
          (newOffset && (typeof newOffset !== "number" || Number.isNaN(newOffset))) ||
          (newLimit && (typeof newLimit !== "number" || Number.isNaN(newLimit)))
        ) {
          throw new Error("offset and limit must be numbers");
        }
        offset = newOffset ?? offset;
        limit = newLimit ?? limit;

        const run = async (count = 0): Promise<void> => {
          if (callbacks.length === 0) return;
          try {
            if (isWindowed) {
              // The rows first, with the old total count: count(*) is slow, and the rows on screen should
              // update as quickly as possible. The count follows below.
              results = {
                ...(await pg.query<T>(`EXECUTE live_query_${id}_get(${limit}, ${offset});`)),
                ...(offset === undefined ? {} : { offset }),
                ...(limit === undefined ? {} : { limit }),
                ...(totalCount === undefined ? {} : { totalCount }),
              };
            } else {
              results = await pg.query<T>(`EXECUTE live_query_${id}_get;`);
            }
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            if (msg.startsWith(`prepared statement "live_query_${id}`) && msg.endsWith("does not exist")) {
              // The prepared statement is gone (the session was reset): set up again and retry.
              if (count > MAX_RETRIES) throw error;
              await init();
              await run(count + 1);
              return;
            }
            throw error;
          }

          runResultCallbacks(callbacks, results);

          if (isWindowed) {
            const newTotalCount = (await pg.query<{ count: number }>(`EXECUTE live_query_${id}_get_total_count;`))
              .rows[0]?.count;
            if (newTotalCount !== totalCount) {
              totalCount = newTotalCount;
              void refresh();
            }
          }
        };
        await run();
      },
    );

    refreshReady = true;
    if (refreshPending) {
      refreshPending = false;
      void refresh();
    }

    const subscribe = (subscriber: (results: Results<T>) => void) => {
      if (dead) {
        throw new Error("Live query is no longer active and cannot be subscribed to");
      }
      callbacks.push(subscriber);
    };

    // Unsubscribe one callback, or all when none is given; with none left, drop the view and listeners.
    const unsubscribe = async (subscriber?: (results: Results<T>) => void) => {
      callbacks = subscriber ? callbacks.filter((cb) => cb !== subscriber) : [];
      if (callbacks.length === 0 && !dead) {
        dead = true;
        await pg.transaction(async (tx) => {
          await Promise.all(unsubList.map((unsub) => unsub(tx)));
          await tx.exec(`
            DROP VIEW IF EXISTS live_query_${id}_view;
            DEALLOCATE live_query_${id}_get;
          `);
        });
      }
    };

    await unsubscribeOnAbort(signal, unsubscribe);

    runResultCallbacks(callbacks, results);

    return {
      initialResults: results,
      subscribe,
      unsubscribe,
      refresh: async (options) => {
        await refresh(options);
      },
    };
  }

  async function changes<T>(
    queryOrOptions: string | LiveChangesOptions<T>,
    paramsArg?: readonly unknown[] | null,
    keyArg?: string,
    callbackArg?: (changes: Change<T>[]) => void,
  ): Promise<LiveChanges<T>> {
    let signal: AbortSignal | undefined;
    let query: string;
    let params: readonly unknown[] | null | undefined = paramsArg;
    let key = keyArg;
    let callback = callbackArg;
    if (typeof queryOrOptions === "string") {
      query = queryOrOptions;
    } else {
      signal = queryOrOptions.signal;
      params = queryOrOptions.params;
      key = queryOrOptions.key;
      callback = queryOrOptions.callback;
      query = queryOrOptions.query;
    }
    if (!key) {
      throw new Error("key is required for changes queries");
    }
    const keyColumn = key;
    let callbacks: ((changes: Change<T>[]) => void)[] = callback ? [callback] : [];
    const id = randomId();
    let dead = false;
    let stateSwitch: 1 | 2 = 1;
    let changesResult: Results<Change<T>> | undefined;
    let unsubList: Unlisten[] = [];

    let refreshReady = false;
    let refreshPending = false;
    const notifyRefresh = () => {
      if (!refreshReady) {
        refreshPending = true;
        return;
      }
      void refresh();
    };

    const init = async () => {
      await pg.transaction(async (tx) => {
        const formattedQuery = await formatQuery(pg, query, params, tx);
        await tx.query(`CREATE OR REPLACE TEMP VIEW live_query_${id}_view AS ${formattedQuery}`);

        const tables = await getTablesForView(tx, `live_query_${id}_view`);
        await addNotifyTriggersToTables(tx, tables, tableNotifyTriggersAdded);

        const columns: { column_name: string; data_type: string; udt_name?: string }[] = [
          ...(
            await tx.query<{ column_name: string; data_type: string; udt_name: string }>(`
              SELECT column_name, data_type, udt_name
              FROM information_schema.columns
              WHERE table_name = 'live_query_${id}_view'
            `)
          ).rows,
          { column_name: "__after__", data_type: "integer" },
        ];

        // Two state tables, alternately holding the previous and the current result.
        await tx.exec(`
          CREATE TEMP TABLE live_query_${id}_state1 (LIKE live_query_${id}_view INCLUDING ALL);
          CREATE TEMP TABLE live_query_${id}_state2 (LIKE live_query_${id}_view INCLUDING ALL);
        `);

        const nullOf = (column: { data_type: string; udt_name?: string }) =>
          `NULL${column.data_type === "USER-DEFINED" ? `::${column.udt_name ?? ""}` : ""}`;

        // A diff statement per direction: INSERTs carry every column, DELETEs only the key, UPDATEs only
        // the changed columns (and their names).
        for (const curr of [1, 2] as const) {
          const prev = curr === 1 ? 2 : 1;
          await tx.exec(`
            PREPARE live_query_${id}_diff${curr} AS
            WITH
              prev AS (SELECT LAG("${keyColumn}") OVER () as __after__, * FROM live_query_${id}_state${prev}),
              curr AS (SELECT LAG("${keyColumn}") OVER () as __after__, * FROM live_query_${id}_state${curr}),
              data_diff AS (
                SELECT
                  'INSERT' AS __op__,
                  ${columns.map(({ column_name }) => `curr."${column_name}" AS "${column_name}"`).join(",\n")},
                  ARRAY[]::text[] AS __changed_columns__
                FROM curr
                LEFT JOIN prev ON curr."${keyColumn}" = prev."${keyColumn}"
                WHERE prev."${keyColumn}" IS NULL
              UNION ALL
                SELECT
                  'DELETE' AS __op__,
                  ${columns
                    .map((column) =>
                      column.column_name === keyColumn
                        ? `prev."${column.column_name}" AS "${column.column_name}"`
                        : `${nullOf(column)} AS "${column.column_name}"`,
                    )
                    .join(",\n")},
                    ARRAY[]::text[] AS __changed_columns__
                FROM prev
                LEFT JOIN curr ON prev."${keyColumn}" = curr."${keyColumn}"
                WHERE curr."${keyColumn}" IS NULL
              UNION ALL
                SELECT
                  'UPDATE' AS __op__,
                  ${columns
                    .map((column) =>
                      column.column_name === keyColumn
                        ? `curr."${column.column_name}" AS "${column.column_name}"`
                        : `CASE
                            WHEN curr."${column.column_name}" IS DISTINCT FROM prev."${column.column_name}"
                            THEN curr."${column.column_name}"
                            ELSE ${nullOf(column)}
                            END AS "${column.column_name}"`,
                    )
                    .join(",\n")},
                    ARRAY(SELECT unnest FROM unnest(ARRAY[${columns
                      .filter(({ column_name }) => column_name !== keyColumn)
                      .map(
                        ({ column_name }) =>
                          `CASE
                            WHEN curr."${column_name}" IS DISTINCT FROM prev."${column_name}"
                            THEN '${column_name}'
                            ELSE NULL
                            END`,
                      )
                      .join(", ")}]) WHERE unnest IS NOT NULL) AS __changed_columns__
                FROM curr
                INNER JOIN prev ON curr."${keyColumn}" = prev."${keyColumn}"
                WHERE NOT (curr IS NOT DISTINCT FROM prev)
              )
            SELECT * FROM data_diff;
          `);
        }

        unsubList = await listenToTables(tx, tables, notifyRefresh);
      });
    };

    await init();

    const refresh = debounceMutex(async () => {
      if (callbacks.length === 0 && changesResult) return;
      let reset = false;
      for (let i = 0; i < 5; i++) {
        try {
          await pg.transaction(async (tx) => {
            await tx.exec(`
              INSERT INTO live_query_${id}_state${stateSwitch}
                SELECT * FROM live_query_${id}_view;
            `);
            changesResult = await tx.query<Change<T>>(`EXECUTE live_query_${id}_diff${stateSwitch};`);
            stateSwitch = stateSwitch === 1 ? 2 : 1;
            await tx.exec(`
              TRUNCATE live_query_${id}_state${stateSwitch};
            `);
          });
          break;
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          if (msg === `relation "live_query_${id}_state${stateSwitch}" does not exist`) {
            // The state table is gone (the session was reset): set up again and retry.
            reset = true;
            await init();
            continue;
          }
          throw error;
        }
      }
      const resetChange = { __op__: "RESET" } as Change<T>;
      runChangeCallbacks(callbacks, [...(reset ? [resetChange] : []), ...(changesResult?.rows ?? [])]);
    });

    refreshReady = true;

    const subscribe = (subscriber: (changes: Change<T>[]) => void) => {
      if (dead) {
        throw new Error("Live query is no longer active and cannot be subscribed to");
      }
      callbacks.push(subscriber);
    };

    const unsubscribe = async (subscriber?: (changes: Change<T>[]) => void) => {
      callbacks = subscriber ? callbacks.filter((cb) => cb !== subscriber) : [];
      if (callbacks.length === 0 && !dead) {
        dead = true;
        await pg.transaction(async (tx) => {
          await Promise.all(unsubList.map((unsub) => unsub(tx)));
          await tx.exec(`
            DROP VIEW IF EXISTS live_query_${id}_view;
            DROP TABLE IF EXISTS live_query_${id}_state1;
            DROP TABLE IF EXISTS live_query_${id}_state2;
            DEALLOCATE live_query_${id}_diff1;
            DEALLOCATE live_query_${id}_diff2;
          `);
        });
      }
    };

    await unsubscribeOnAbort(signal, unsubscribe);

    // The initial changes.
    await refresh();

    if (refreshPending) {
      // A notification arrived during init. It is replayed after the initial refresh, which would
      // otherwise consume the initial changes.
      refreshPending = false;
      void refresh();
    }

    const fields = (changesResult?.fields ?? []).filter(
      (field) => !["__after__", "__op__", "__changed_columns__"].includes(field.name),
    );

    return {
      fields,
      initialChanges: changesResult?.rows ?? [],
      subscribe,
      unsubscribe,
      refresh: async () => {
        await refresh();
      },
    };
  }

  async function incrementalQuery<T>(
    queryOrOptions: string | LiveIncrementalQueryOptions<T>,
    paramsArg?: readonly unknown[] | null,
    keyArg?: string,
    callbackArg?: (results: Results<T>) => void,
  ): Promise<LiveQuery<T>> {
    let signal: AbortSignal | undefined;
    let query: string;
    let params: readonly unknown[] | null | undefined = paramsArg;
    let key = keyArg;
    let callback = callbackArg;
    if (typeof queryOrOptions === "string") {
      query = queryOrOptions;
    } else {
      signal = queryOrOptions.signal;
      params = queryOrOptions.params;
      key = queryOrOptions.key;
      callback = queryOrOptions.callback;
      query = queryOrOptions.query;
    }
    if (!key) {
      throw new Error("key is required for incremental queries");
    }
    const keyColumn = key;
    let callbacks: ((results: Results<T>) => void)[] = callback ? [callback] : [];
    const rowsMap = new Map<unknown, Row>();
    const afterMap = new Map<unknown, unknown>();
    let lastRows: T[] = [];
    let firstRun = true;

    const {
      fields,
      unsubscribe: unsubscribeChanges,
      refresh,
    } = await changes<Row>(query, params, keyColumn, (changeList) => {
      for (const change of changeList) {
        const {
          __op__: op,
          __changed_columns__: changedColumns,
          ...obj
        } = change as Row & {
          __op__: Change<Row>["__op__"];
          __changed_columns__?: string[];
        };
        switch (op) {
          case "RESET":
            rowsMap.clear();
            afterMap.clear();
            break;
          case "INSERT":
            rowsMap.set(obj[keyColumn], obj);
            afterMap.set(obj["__after__"], obj[keyColumn]);
            break;
          case "DELETE": {
            const oldObj = rowsMap.get(obj[keyColumn]);
            rowsMap.delete(obj[keyColumn]);
            // null is the starting point: another insert may already have taken its place.
            if (oldObj && oldObj["__after__"] !== null) {
              afterMap.delete(oldObj["__after__"]);
            }
            break;
          }
          case "UPDATE": {
            const newObj: Row = { ...rowsMap.get(obj[keyColumn]) };
            for (const columnName of changedColumns ?? []) {
              newObj[columnName] = obj[columnName];
              if (columnName === "__after__") {
                afterMap.set(obj["__after__"], obj[keyColumn]);
              }
            }
            rowsMap.set(obj[keyColumn], newObj);
            break;
          }
        }
      }

      // The rows in order, following each row's predecessor link.
      const rows: T[] = [];
      let lastKey: unknown = null;
      for (let i = 0; i < rowsMap.size; i++) {
        const nextKey = afterMap.get(lastKey);
        const obj = rowsMap.get(nextKey);
        if (!obj) break;
        const { __after__: _after, ...cleanObj } = obj;
        rows.push(cleanObj as T);
        lastKey = nextKey;
      }
      lastRows = rows;

      if (!firstRun) {
        runResultCallbacks(callbacks, { rows, fields });
      }
    });

    firstRun = false;
    runResultCallbacks(callbacks, { rows: lastRows, fields });

    const subscribe = (subscriber: (results: Results<T>) => void) => {
      callbacks.push(subscriber);
    };

    const unsubscribe = async (subscriber?: (results: Results<T>) => void) => {
      callbacks = subscriber ? callbacks.filter((cb) => cb !== subscriber) : [];
      if (callbacks.length === 0) {
        await unsubscribeChanges();
      }
    };

    await unsubscribeOnAbort(signal, unsubscribe);

    return {
      initialResults: { rows: lastRows, fields },
      subscribe,
      unsubscribe,
      refresh,
    };
  }

  return { query, changes, incrementalQuery } as LiveNamespace;
}

/**
 * Live queries: `live.query`, `live.changes` and `live.incrementalQuery`, re-run when a table they read
 * changes (statement-level NOTIFY triggers, created once per table).
 */
export const live: Extension<LiveNamespace> = {
  name: "Live Queries",
  setup: async (pg: Pgwasm) => ({ namespace: createNamespace(pg) }),
};
