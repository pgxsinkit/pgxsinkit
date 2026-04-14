import type { AppDb } from "./pglite";

const HISTORY_SCHEMA_SQL = `
  CREATE SCHEMA IF NOT EXISTS debug;
  CREATE TABLE IF NOT EXISTS debug.repl_history (
    seq BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    sql TEXT NOT NULL,
    result_json TEXT,
    error_message TEXT,
    executed_at_us BIGINT NOT NULL
  );
`;

const MAX_RESULT_BYTES = 8192;

export function createReplProxy(db: AppDb): AppDb {
  let historyTableReady: Promise<void> | null = null;

  function ensureHistoryTable(): Promise<void> {
    if (!historyTableReady) {
      historyTableReady = db
        .exec(HISTORY_SCHEMA_SQL)
        .then(() => undefined)
        .catch((err: unknown) => {
          historyTableReady = null;
          throw err;
        });
    }

    return historyTableReady;
  }

  return new Proxy(db, {
    get(target, prop, _receiver) {
      if (prop !== "exec") {
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? (value as Function).bind(target) : value;
      }

      return async (sql: string, options?: Parameters<AppDb["exec"]>[1]) => {
        const executedAtUs = Date.now() * 1000;
        let resultJson: string | null = null;
        let errorMessage: string | null = null;

        try {
          const result = await target.exec(sql, options);
          const serialized = JSON.stringify(result);
          resultJson =
            serialized.length > MAX_RESULT_BYTES ? `${serialized.slice(0, MAX_RESULT_BYTES)}\u2026` : serialized;
          return result;
        } catch (err) {
          errorMessage = err instanceof Error ? err.message : String(err);
          throw err;
        } finally {
          void ensureHistoryTable()
            .then(() =>
              target.query(
                `INSERT INTO debug.repl_history (sql, result_json, error_message, executed_at_us)
                 VALUES ($1, $2, $3, $4)`,
                [sql, resultJson, errorMessage, executedAtUs],
              ),
            )
            .catch(() => {
              // history write failure is non-fatal
            });
        }
      };
    },
  }) as AppDb;
}
