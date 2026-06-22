/**
 * The opt-in convergence driver (ADR-0005 decision 3).
 *
 * The mechanism primitives (`flush` / `reconcile` / `retryFailed`) stay public and manual.
 * This driver is the *scheduling-policy seam*: the app decides WHEN to converge (online?
 * foregrounded? on power?) and how it learns those conditions, while the library owns the
 * convergence pass and the congestion policy (jittered backoff + attempt cap, already in the
 * mutation runtime). Pass nothing to `createSyncClient` → fully manual, today's behaviour.
 */

/** The mechanism primitives a convergence pass schedules. */
export interface ConvergenceClient {
  flush: () => Promise<void>;
  reconcile: () => Promise<void>;
  retryFailed: () => Promise<void>;
}

/**
 * The scheduling-policy seam. Browser (`online` / `visibilitychange`) and React Native
 * (`AppState` / `NetInfo`) are two genuine adapters — which is what earns this its place as a
 * seam rather than being inlined.
 */
export interface ConvergenceTrigger {
  /** Register a callback fired whenever the app wants a convergence attempt; returns an unsubscribe. */
  subscribe: (onSignal: () => void) => () => void;
  /** Whether a convergence pass should run right now (e.g. online and foregrounded). */
  shouldConverge: () => boolean;
}

export interface ConvergenceDriverOptions {
  client: ConvergenceClient;
  trigger: ConvergenceTrigger;
  /** Invoked after each convergence pass with the error it raised, or `null` on success. */
  onPass?: (error: unknown) => void;
}

export interface ConvergenceDriver {
  start: () => void;
  stop: () => void;
}

/**
 * Drive convergence from a {@link ConvergenceTrigger}. Each signal runs at most one pass at a
 * time (`retryFailed` → `flush` → `reconcile`); a signal arriving mid-pass coalesces into a
 * single follow-up pass, so a burst of triggers never stampedes the server (the per-mutation
 * backoff in the runtime handles the rest).
 */
export function createConvergenceDriver(options: ConvergenceDriverOptions): ConvergenceDriver {
  let unsubscribe: (() => void) | null = null;
  let running = false;
  let queued = false;

  const runPass = async () => {
    if (running) {
      queued = true;
      return;
    }

    if (!options.trigger.shouldConverge()) {
      return;
    }

    running = true;
    let error: unknown = null;

    try {
      await options.client.retryFailed();
      await options.client.flush();
      await options.client.reconcile();
    } catch (passError) {
      error = passError;
    } finally {
      running = false;
      options.onPass?.(error);

      if (queued) {
        queued = false;
        void runPass();
      }
    }
  };

  return {
    start: () => {
      if (unsubscribe) {
        return;
      }

      unsubscribe = options.trigger.subscribe(() => {
        void runPass();
      });
      void runPass();
    },
    stop: () => {
      unsubscribe?.();
      unsubscribe = null;
    },
  };
}

/** Minimal browser globals the trigger needs, read off `globalThis` so the library carries no DOM lib dependency. */
interface EventTargetLike {
  addEventListener: (type: string, handler: () => void) => void;
  removeEventListener: (type: string, handler: () => void) => void;
}
interface BrowserEnv {
  window?: EventTargetLike;
  document?: EventTargetLike & { visibilityState?: string };
  navigator?: { onLine?: boolean };
}

/**
 * Browser convergence trigger: fires on `online`, `visibilitychange`, and a fallback interval,
 * and converges only while online and not backgrounded. The adapter most apps use.
 */
export function createBrowserConvergenceTrigger(options: { intervalMs?: number } = {}): ConvergenceTrigger {
  const intervalMs = options.intervalMs ?? 1500;
  const env = globalThis as unknown as BrowserEnv;

  return {
    subscribe: (onSignal) => {
      const handler = () => {
        onSignal();
      };
      env.window?.addEventListener("online", handler);
      env.document?.addEventListener("visibilitychange", handler);
      const timer = setInterval(handler, intervalMs);

      return () => {
        env.window?.removeEventListener("online", handler);
        env.document?.removeEventListener("visibilitychange", handler);
        clearInterval(timer);
      };
    },
    shouldConverge: () => env.navigator?.onLine !== false && env.document?.visibilityState !== "hidden",
  };
}

/**
 * Interval convergence trigger: fires on a fixed cadence and always converges. The minimal
 * non-browser adapter — usable directly in tests/servers and the base a React Native
 * `AppState`/`NetInfo` adapter builds on — which is the second adapter that proves the seam.
 */
export function createIntervalConvergenceTrigger(intervalMs: number): ConvergenceTrigger {
  return {
    subscribe: (onSignal) => {
      const timer = setInterval(() => {
        onSignal();
      }, intervalMs);

      return () => {
        clearInterval(timer);
      };
    },
    shouldConverge: () => true,
  };
}
