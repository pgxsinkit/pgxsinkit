import { sql } from "drizzle-orm";
import type { PgAsyncDatabase } from "drizzle-orm/pg-core";

import type { RegistryRelations, SyncTableRegistry } from "@pgxsinkit/contracts";

import type { OperationsLogConfig } from "./types";

type OperationsLogPresenceRow = {
  tableName: string | null;
};

/**
 * Ensures the operations_log table exists in the database.
 *
 * Returns `true` if the table is present, `false` if missing.
 * Consumers should include `operationsLogTable` from `@pgxsinkit/server`
 * in their Drizzle schema so `drizzle-kit generate`/`push` creates it.
 */
export async function ensureOperationsLogSchema<TRegistry extends SyncTableRegistry>(
  db: PgAsyncDatabase<any, RegistryRelations<TRegistry>>,
  config: OperationsLogConfig,
): Promise<boolean> {
  if (!config.enabled) {
    return false;
  }

  try {
    const result = await db.execute<OperationsLogPresenceRow>(sql`
    SELECT to_regclass('public.operations_log')::text AS "tableName"
  `);

    const row = Array.from(result, (entry) => entry as OperationsLogPresenceRow)[0];

    if (!row?.tableName) {
      console.warn(
        "operations_log table is missing. Add operationsLogTable from @pgxsinkit/server " +
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
