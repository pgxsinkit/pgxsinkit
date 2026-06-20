import { operationsLogTable } from "./schema";
import type { OpsLogEntry, OperationsLogConfig, SqlExecutor } from "./types";

function toJsonValue(value: unknown): unknown {
  if (value === undefined) {
    return null;
  }

  return value;
}

function toBigIntValue(value: string | null | undefined): bigint | null {
  if (value === undefined || value === null) {
    return null;
  }

  return BigInt(value);
}

export async function logOperation(
  executor: SqlExecutor,
  config: OperationsLogConfig,
  entry: OpsLogEntry,
): Promise<void> {
  if (!config.enabled) {
    return;
  }

  await executor.insert(operationsLogTable).values({
    tableName: entry.tableName ?? null,
    operationKind: entry.operationKind ?? null,
    userId: entry.userId ?? null,
    entityKeyJson: toJsonValue(entry.entityKey ?? null),
    payloadJson: toJsonValue(entry.payload),
    status: entry.status,
    errorMessage: entry.errorMessage ?? null,
    httpStatus: entry.httpStatus ?? null,
    mutationId: entry.mutationId ?? null,
    mutationSeq: entry.mutationSeq ?? null,
    clientTimestampUs: toBigIntValue(entry.clientTimestampUs),
    requestPath: entry.requestPath ?? null,
  });
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
