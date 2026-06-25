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
  const base = createBrowserConvergenceTrigger();
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
