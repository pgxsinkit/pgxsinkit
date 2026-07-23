import { createBrowserConvergenceTrigger, type ConvergenceTrigger } from "@pgxsinkit/client";

export interface OfflineControl {
  /** The {@link ConvergenceTrigger} to hand the sync client as `autoSync`. */
  readonly trigger: ConvergenceTrigger;
  isOnline: () => boolean;
  /** Flip the simulated network. Going back online fires an immediate convergence pass to flush the queue. */
  setOnline: (online: boolean) => void;
  /** Subscribe to online/offline changes (for React to re-render the toggle). Returns an unsubscribe. */
  subscribe: (listener: () => void) => () => void;
}

/**
 * A pausable convergence trigger for the board's Offline toggle (board Phase 8). It wraps the standard
 * browser trigger ({@link createBrowserConvergenceTrigger}) but gates `shouldConverge` behind an
 * app-controlled `online` flag. Going "offline" pauses the **outbound** convergence driver
 * (flush/reconcile) without tearing anything down — writes still stage into the local mutation journal,
 * they just are not sent — so the journal visibly fills while offline. Going back online fires one
 * immediate pass to flush the queue and reconcile.
 *
 * Scope note: this pauses the outbound path only. The inbound Electric subscription has no client-side
 * pause/resume seam (`stop()` closes PGlite), so the toggle is honestly "your edits queue locally and
 * sync when you reconnect" rather than a full network cut. A first-class read-path pause is a toolkit
 * capability for later.
 */
export function createOfflineControl(): OfflineControl {
  // A slow fallback cadence. Convergence is now event-driven — a local write requests a pass on enqueue
  // (client requestPass), and the real-time <table>_reconcile_on_sync trigger clears overlays on the
  // Electric echo — so this interval only catches retries/recovery, not the happy path. Every PGlite
  // query costs ~50ms of WASM overhead regardless of complexity, so a frequent poll is the dominant
  // idle-CPU cost; at 15s a fully idle board is effectively quiet.
  const base = createBrowserConvergenceTrigger({ intervalMs: 15_000 });
  const listeners = new Set<() => void>();
  let online = true;
  let signal: (() => void) | null = null;

  return {
    trigger: {
      subscribe: (onSignal) => {
        signal = onSignal;
        const unsubscribe = base.subscribe(onSignal);
        return () => {
          signal = null;
          unsubscribe();
        };
      },
      shouldConverge: () => online && base.shouldConverge(),
    },
    isOnline: () => online,
    setOnline: (next) => {
      if (next === online) return;
      online = next;
      for (const listener of listeners) listener();
      // Reconnecting: fire one pass now so the queued writes flush immediately instead of waiting for
      // the next interval tick.
      if (online) signal?.();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/**
 * The worker-mode counterpart of {@link createOfflineControl} (ADR-0032 S3). In worker mode the sync
 * engine — and therefore the convergence driver — lives in the SharedWorker, so the tab cannot gate a
 * LOCAL `autoSync` trigger; instead the toggle forwards the flag over the bridge (`set-online`), which the
 * worker uses to suppress/resume its outbound flush passes. `trigger` is a never-consumed stub (the tab
 * has no local engine to hand it to); the UI reads `isOnline`/`subscribe` and drives `setOnline` exactly
 * as in-process. `sendOnline` is the attached client's `setOnline`.
 */
export function createWorkerOfflineControl(sendOnline: (online: boolean) => void): OfflineControl {
  const listeners = new Set<() => void>();
  let online = true;
  return {
    // Unused in worker mode: no local engine consumes it. Present only to satisfy OfflineControl.
    trigger: { subscribe: () => () => {}, shouldConverge: () => false },
    isOnline: () => online,
    setOnline: (next) => {
      if (next === online) return;
      online = next;
      sendOnline(next);
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
