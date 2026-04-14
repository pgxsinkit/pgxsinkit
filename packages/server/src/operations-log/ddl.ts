import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import type { RegistryTables, SyncTableRegistry } from "@pgxsinkit/contracts";

import type { OperationsLogConfig } from "./types";

type OperationsLogPresenceRow = {
  tableName: string | null;
};

export async function ensureOperationsLogSchema<TRegistry extends SyncTableRegistry>(
  db: PostgresJsDatabase<RegistryTables<TRegistry>>,
  config: OperationsLogConfig,
): Promise<void> {
  if (!config.enabled) {
    return;
  }

  const result = await db.execute<OperationsLogPresenceRow>(sql`
    SELECT to_regclass('public.operations_log')::text AS "tableName"
  `);

  const row = Array.from(result, (entry) => entry as OperationsLogPresenceRow)[0];

  if (!row?.tableName) {
    throw new Error("operations_log table is missing. Run bun run db:push before starting the write API.");
  }
}
