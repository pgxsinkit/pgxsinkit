export type SyncRuntimePhase = "booting" | "syncing" | "ready" | "degraded";

export interface SyncRuntimeStatus {
  phase: SyncRuntimePhase;
  isRunning: boolean;
  lastError?: string;
}

export interface SyncServerAddress {
  host: string;
  port: number;
}

export interface MutationDiagnostics {
  pendingCount: number;
  sendingCount: number;
  ackedCount: number;
  failedCount: number;
  lastFlushAtUs?: string;
  lastAckAtUs?: string;
}
