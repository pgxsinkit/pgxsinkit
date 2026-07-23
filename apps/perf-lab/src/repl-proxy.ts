import { bigint, pgSchema, text } from "drizzle-orm/pg-core";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";

import type { PerfLabDb } from "./pglite";

// Tier ③ (justified): bootstrap DDL — CREATE SCHEMA / CREATE TABLE with an identity column. No
// drizzle-kit migration lane exists for the browser-local REPL store, and Drizzle objects cannot
// express DDL execution, so the bootstrap stays a raw string.
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

// The history table as a Drizzle query-authoring object, mirroring the bootstrap DDL above (which
// remains the source of truth for the physical shape). `seq` is GENERATED ALWAYS — never inserted.
const replHistory = pgSchema("debug").table("repl_history", {
  seq: bigint("seq", { mode: "bigint" }).generatedAlwaysAsIdentity().primaryKey(),
  sql: text("sql").notNull(),
  resultJson: text("result_json"),
  errorMessage: text("error_message"),
  executedAtUs: bigint("executed_at_us", { mode: "number" }).notNull(),
});

const MAX_RESULT_BYTES = 8192;

// Same shape-cast the toolkit's own `createDrizzleDatabase` uses: the live/electric-extended PGlite
// interface (`ClientPGlite`) is not type-assignable to drizzle's `client` param, though it is the same
// runtime object.
const createHistoryDatabase = drizzle as unknown as (config: { client: PerfLabDb }) => PgliteDatabase;

export function createReplProxy(db: PerfLabDb): PerfLabDb {
  const history = createHistoryDatabase({ client: db });
  let historyTableReady: Promise<void> | null = null;

  function ensureHistoryTable(): Promise<void> {
    if (!historyTableReady) {
      historyTableReady = db
        .exec(HISTORY_SCHEMA_SQL)
        .then(() => undefined)
        .catch((error: unknown) => {
          historyTableReady = null;
          throw error;
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

      return async (sql: string, options?: Parameters<PerfLabDb["exec"]>[1]) => {
        const executedAtUs = Date.now() * 1000;
        let resultJson: string | null = null;
        let errorMessage: string | null = null;

        try {
          const result = await target.exec(sql, options);
          const serialized = JSON.stringify(result);
          resultJson =
            serialized.length > MAX_RESULT_BYTES ? `${serialized.slice(0, MAX_RESULT_BYTES)}...` : serialized;
          return result;
        } catch (error) {
          errorMessage = error instanceof Error ? error.message : String(error);
          throw error;
        } finally {
          void ensureHistoryTable()
            .then(() => history.insert(replHistory).values({ sql, resultJson, errorMessage, executedAtUs }))
            .catch(() => {
              // REPL history persistence is best-effort only.
            });
        }
      };
    },
  }) as PerfLabDb;
}
