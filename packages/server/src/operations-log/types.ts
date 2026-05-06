import type { SQLWrapper } from "drizzle-orm";

export type OpsLogSource = "crud" | "batch";

export type OpsLogBackend = "bulk-plpgsql-artifact";

export type OpsLogStatus = "succeeded" | "validation_failed" | "not_found" | "execution_failed";

export interface OperationsLogConfig {
  enabled: boolean;
}

export interface OpsLogEntry {
  source: OpsLogSource;
  backend: OpsLogBackend;
  tableName?: string | null;
  operationKind?: "create" | "update" | "delete" | null;
  userId?: string | null;
  entityKey?: Record<string, string> | null;
  payload?: unknown;
  status: OpsLogStatus;
  errorMessage?: string | null;
  httpStatus?: number | null;
  mutationId?: string | null;
  mutationSeq?: number | null;
  clientTimestampUs?: string | null;
  requestPath?: string | null;
}

export interface SqlExecutor {
  execute: (query: string | SQLWrapper<unknown>) => Promise<unknown>;
}
