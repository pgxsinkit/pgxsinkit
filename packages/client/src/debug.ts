// Opt-in runtime instrumentation for diagnosing convergence / sync latency in a live app (e.g. the
// board demo). It is OFF by default and adds nothing to a normal run: every call early-returns unless
// `globalThis.__pgxsinkitDebug` is truthy, so it is safe to leave the call sites in shipping code.
//
// Enable it from the browser console (`globalThis.__pgxsinkitDebug = true`) — or set it before the
// client boots; the board's dev build turns it on automatically. Each line is stamped with a monotonic
// millisecond clock so the gaps between phases (enqueue → flush → server ack → stream echo →
// overlay clear → live-query render) can be read straight off the console.

interface DebugGlobal {
  __pgxsinkitDebug?: boolean;
}

const isEnabled = (): boolean => (globalThis as DebugGlobal).__pgxsinkitDebug === true;

const now = (): number => (typeof performance !== "undefined" ? performance.now() : Date.now());

/**
 * A sink that receives every `syncDebug` line (event, the worker's monotonic stamp, optional data),
 * INDEPENDENT of the local `__pgxsinkitDebug` console gate. This is the seam `defineSyncWorker` installs
 * to forward the debug rail to tabs (ADR-0032 decision 7): a SharedWorker's own console is invisible
 * (`chrome://inspect`), so lines must cross the bridge and each tab re-prints them gated on ITS OWN flag.
 * Unset by default → no forwarding and zero cost on the in-process path.
 */
type SyncDebugSink = (event: string, stamp: number, data?: Record<string, unknown>) => void;
let syncDebugSink: SyncDebugSink | undefined;

/** Install (or clear, with `undefined`) the debug-rail sink. Idempotent; `defineSyncWorker` owns it. */
export function setSyncDebugSink(sink: SyncDebugSink | undefined): void {
  syncDebugSink = sink;
}

/**
 * Log one timestamped event. Prints to the console only when `globalThis.__pgxsinkitDebug` is on, but ALSO
 * feeds any installed {@link setSyncDebugSink} sink (so the worker can forward the rail to tabs even when the
 * worker's own console gate is off). No sink AND not enabled → an early return, so the off-path pays nothing.
 */
export function syncDebug(event: string, data?: Record<string, unknown>): void {
  const enabled = isEnabled();
  if (!enabled && syncDebugSink === undefined) return;
  const stamp = now();
  if (enabled) {
    const prefix = `[pgxsinkit ${stamp.toFixed(0)}ms]`;
    if (data) {
      console.debug(`${prefix} ${event}`, data);
    } else {
      console.debug(`${prefix} ${event}`);
    }
  }
  syncDebugSink?.(event, stamp, data);
}

/**
 * Run `fn`, logging `<event> done` with its wall-clock duration (and any extra `data`). When
 * instrumentation is off this is a thin pass-through with no logging and no timing overhead beyond the
 * call itself. Returns whatever `fn` returns.
 */
export async function timeAsync<T>(event: string, fn: () => Promise<T>, data?: Record<string, unknown>): Promise<T> {
  if (!isEnabled()) return fn();
  const startedAt = now();
  syncDebug(`${event} start`, data);
  try {
    return await fn();
  } finally {
    syncDebug(`${event} done`, { ms: Math.round(now() - startedAt) });
  }
}
