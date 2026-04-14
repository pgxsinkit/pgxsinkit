import { sql } from "drizzle-orm";

import type { OpsLogEntry, OperationsLogConfig, SqlExecutor } from "./types";

function toJson(value: unknown): string | null {
  if (value === undefined) {
    return null;
  }

  return JSON.stringify(value);
}

export async function logOperation(
  executor: SqlExecutor,
  config: OperationsLogConfig,
  entry: OpsLogEntry,
): Promise<void> {
  if (!config.enabled) {
    return;
  }

  const entityKeyJson = toJson(entry.entityKey ?? null);
  const payloadJson = toJson(entry.payload);

  await executor.execute(sql`
    INSERT INTO operations_log (
      source,
      backend,
      table_name,
      operation_kind,
      user_id,
      entity_key_json,
      payload_json,
      status,
      error_message,
      http_status,
      mutation_id,
      mutation_seq,
      client_timestamp_us,
      request_path,
      server_timestamp_us
    ) VALUES (
      ${entry.source},
      ${entry.backend},
      ${entry.tableName ?? null},
      ${entry.operationKind ?? null},
      ${entry.userId ?? null},
      ${entityKeyJson}::jsonb,
      ${payloadJson}::jsonb,
      ${entry.status},
      ${entry.errorMessage ?? null},
      ${entry.httpStatus ?? null},
      ${entry.mutationId ?? null},
      ${entry.mutationSeq ?? null},
      ${entry.clientTimestampUs ?? null},
      ${entry.requestPath ?? null},
      CAST(FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000000) AS BIGINT)
    )
  `);
}

export async function logOperationSafely(
  executor: SqlExecutor,
  config: OperationsLogConfig,
  entry: OpsLogEntry,
): Promise<void> {
  try {
    await logOperation(executor, config, entry);
  } catch {
    // Failure-path logging must not hide the original route response/error.
  }
}
