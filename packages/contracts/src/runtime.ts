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
  /**
   * Per-consistency-group readiness (ADR-0032 decision 6): `groupKey → isReady`, updated as each group
   * catches up. Exposed on both the in-process and worker-attached clients so an app can drive
   * progressive per-group paint without waiting on the all-eager-groups `ready` gate. Absent until the
   * sync runtime has started (e.g. while `syncEnabled` is false there are no groups to report).
   */
  groups?: Record<string, boolean>;
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
  /**
   * Whole write-**units** the authoritative endpoint declined for a business reason (terminal, ADR-0022):
   * the optimistic Overlay is auto-discarded for every member and the typed reason is surfaced via
   * `onReject`. Never retried (the server's answer is authoritative).
   */
  rejectedCount: number;
  lastFlushAtUs?: string;
  lastAckAtUs?: string;
}

/**
 * A registry-wide mutation-journal summary for warm-store observability: the
 * per-status counts across EVERY writable table's journal, folded from one aggregate query/subscription over
 * the `pgxsinkit_all_mutations` view — so a consumer renders a global sync indicator with ONE subscription
 * instead of one live query per writable journal. Cheap enough to mount permanently.
 *
 * `unsettledCount` and `settledCount` PARTITION the total — the user-facing "is any local edit still owed?"
 * split, NOT the automatic state machine's terminal/non-terminal split:
 *
 * - `unsettledCount` = `pending` + `sending` + `failed` + `conflicted` + `quarantined` — every write still
 *   needing work or user action. `conflicted` and `quarantined` are journal-TERMINAL in the state machine (no
 *   auto-transition — see `MUTATION_TRANSITIONS`) yet BOTH count as unsettled: their optimistic Overlay is
 *   KEPT, later writes for the entity stay blocked, `destroy()` refuses them without `force`, and local-store
 *   reconciliation counts them owed. The user must act (`discardConflict` / `discardQuarantined`, then
 *   re-author) — so from the consumer's data-safety standpoint they are NOT done. This is exactly the
 *   restore case, where pgxsinkit deliberately quarantines recovered writes for the user to resolve, so a
 *   global "unsynced changes" indicator MUST include them.
 * - `settledCount` = `acked` + `rejected` — the writes that are truly done from the user's standpoint (acked
 *   awaits only its synced echo to be reconciled away; rejected's Overlay was auto-discarded, nothing owed).
 *
 * The field is `settledCount` (not `terminalCount`): "terminal" is the state-machine word, and quarantine is
 * legitimately terminal there while being unsettled here — the old name invited exactly that confusion.
 */
export interface MutationSummary {
  pendingCount: number;
  sendingCount: number;
  ackedCount: number;
  failedCount: number;
  rejectedCount: number;
  conflictedCount: number;
  quarantinedCount: number;
  /**
   * `pending` + `sending` + `failed` + `conflicted` + `quarantined` — every write still needing work or user
   * action (see the interface JSDoc; quarantined + conflicted are owed local edits, not settled).
   */
  unsettledCount: number;
  /** `acked` + `rejected` — settled writes; the complement of {@link unsettledCount}. */
  settledCount: number;
}
