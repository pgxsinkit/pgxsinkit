import { getTableName, sql } from "drizzle-orm";
import type { PgAsyncDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import type { RegistryRelations, SyncTableRegistry } from "@pgxsinkit/contracts";

import { operationsLogTable } from "./schema";
import type { OperationsLogConfig } from "./types";

type OperationsLogPresenceRow = {
  tableName: string | null;
};

/**
 * The `to_regclass` presence-probe target, derived from the real pgTable so the probe (and the
 * warning below) track a rename of `operationsLogTable`. Exported for the integration suite that
 * asserts the degraded no-log path against the same identity.
 */
export function operationsLogRegclassTarget(): string {
  return `public.${getTableName(operationsLogTable)}`;
}

/**
 * Ensures the operations_log table exists in the database.
 *
 * Returns `true` if the table is present, `false` if missing.
 * Consumers should include `operationsLogTable` from `@pgxsinkit/server`
 * in their Drizzle schema so `drizzle-kit generate`/`push` creates it.
 */
export async function ensureOperationsLogSchema<TRegistry extends SyncTableRegistry>(
  db: PgAsyncDatabase<PgQueryResultHKT, RegistryRelations<TRegistry>>,
  config: OperationsLogConfig,
): Promise<boolean> {
  if (!config.enabled) {
    return false;
  }

  try {
    const result = await db.execute<OperationsLogPresenceRow>(sql`
    SELECT to_regclass(${operationsLogRegclassTarget()})::text AS "tableName"
  `);

    const row = Array.from(result as Iterable<unknown>, (entry) => entry as OperationsLogPresenceRow)[0];

    if (!row?.tableName) {
      console.warn(
        `${getTableName(operationsLogTable)} table is missing. Add operationsLogTable from @pgxsinkit/server ` +
          "to your Drizzle schema and run drizzle-kit generate/push to create it. " +
          "Operation logging will be disabled until the table exists.",
      );
      return false;
    }

    return true;
  } catch (error) {
    console.warn("Unable to verify operations_log table:", (error as Error)?.message ?? error);
    return false;
  }
}
