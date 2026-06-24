export type SyncRuntimePhase = "booting" | "syncing" | "ready" | "degraded" | "auth-needed";

export interface SyncRuntimeStatus {
  /**
   * `auth-needed` (ADR-0013): the read path is hitting auth errors (401/403) and is retrying
   * forever with backoff — distinct from `degraded` (a sync commit exhausted its retries). The app
   * should prompt re-login; sync auto-resumes (phase returns to `ready`/`syncing`) the instant
   * re-authentication makes the token valid again. It never silently wedges or permanently stops.
   */
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
  /** Mutations the server permanently rejected (terminal); surfaced, never retried (ADR-0006). */
  quarantinedCount: number;
  /**
   * Stale writes the server declined under the `reject-if-stale` Conflict policy (terminal,
   * ADR-0015). The optimistic Overlay is kept; the user resolves each as a new write or discards it.
   */
  conflictedCount: number;
  lastFlushAtUs?: string;
  lastAckAtUs?: string;
}
