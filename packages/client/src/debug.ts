// Opt-in runtime instrumentation for diagnosing convergence / sync latency in a live app (e.g. the
// board demo). It is OFF by default and adds nothing to a normal run: every call early-returns unless
// `globalThis.__pgxsinkitDebug` is truthy, so it is safe to leave the call sites in shipping code.
//
// Enable it from the browser console (`globalThis.__pgxsinkitDebug = true`) — or set it before the
// client boots; the board's dev build turns it on automatically. Each line is stamped with a monotonic
// millisecond clock so the gaps between phases (enqueue → flush → server ack → Electric echo →
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

/** The request URL of a `fetch` first argument, in any of its accepted forms; undefined if unreadable. */
function fetchInputUrl(input: Parameters<typeof fetch>[0]): string | undefined {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  if (typeof input === "object" && input !== null && "url" in input) {
    return (input as { url: string }).url;
  }
  return undefined;
}

/**
 * Wrap a `fetch` so every ShapeStream request (the Electric read-path long-poll/catch-up) emits a start
 * line (shape/table, offset, live — derived from the request URL params) and a completion line (status,
 * ms, and whether the response is up-to-date). Passthrough when instrumentation is off: the early return
 * runs before any URL parsing, so the off-path pays nothing per request beyond this closure itself.
 *
 * Inject it as a ShapeStream `fetchClient`; pass the stream's existing `fetchClient` (if any) as the base
 * so the instrumentation composes rather than replaces.
 */
export function instrumentShapeFetch(baseFetch: typeof fetch = fetch): typeof fetch {
  const wrapped = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
    if (!isEnabled()) return baseFetch(input, init);
    const url = fetchInputUrl(input);
    const params = url ? new URL(url).searchParams : undefined;
    // Derive the shape identity ONCE and name it on BOTH the start and done lines, so a start/done pair
    // is readable without cross-referencing timing (multiple shapes' requests interleave on the rail).
    const shape = params?.get("table") ?? undefined;
    const live = params?.get("live") === "true";
    const offset = params?.get("offset") ?? undefined;
    // The handle chain is the backlog-0001 forensic: WHICH handle each request carried, which one the
    // response minted, and whether the stale-cache ladder's params were on the wire — so a
    // dead-handle-served-N-times storm reads straight off the rail (same responseHandle across busted
    // attempts) instead of needing a network-tab capture at the moment of recurrence.
    const requestHandle = params?.get("handle") ?? undefined;
    const cacheBuster = params?.has("cache-buster") ?? false;
    const expiredHandle = params?.get("expired_handle") ?? undefined;
    // The whole request identity rides in ONE compact string field: Chrome's console preview truncates
    // object previews at ~5 properties, and a captured log (the only artifact of a live recurrence) keeps
    // just the preview — separate fields silently vanish exactly when they matter (backlog 0001).
    const cursor = params?.get("cursor") ?? undefined;
    const req = [
      `${shape ?? "?"}@${offset ?? "?"}`,
      live ? "live" : "catchup",
      requestHandle ? `h=${requestHandle}` : "no-handle",
      // The live-cycle cursor is Electric's CDN-collapse defense — its absence or non-advancement on
      // live polls is itself a finding (backlog 0001).
      cursor ? `c=${cursor}` : live ? "NO-CURSOR" : "",
      cacheBuster ? "BUSTED" : "",
      expiredHandle ? `expired=${expiredHandle}` : "",
    ]
      .filter(Boolean)
      .join(" ");
    syncDebug("shape request start", { req });
    const startedAt = now();
    return baseFetch(input, init).then((response) => {
      // Same single-string discipline for the response half: status/ms stay first-class (they are what
      // rail readers scan), the forensic chain (up-to-date, minted handle, end offset) folds into `resp`.
      const responseHandle = response.headers.get("electric-handle");
      const responseOffset = response.headers.get("electric-offset");
      const responseCursor = response.headers.get("electric-cursor");
      const age = response.headers.get("age");
      const resp = [
        response.headers.has("electric-up-to-date") ? "up-to-date" : "",
        responseHandle && responseHandle !== requestHandle ? `minted h=${responseHandle}` : "",
        responseOffset ? `end=${responseOffset}` : "",
        responseCursor ? `c=${responseCursor}` : "",
        age ? `age=${age}` : "",
      ]
        .filter(Boolean)
        .join(" ");
      syncDebug("shape request done", {
        req,
        status: response.status,
        ms: Math.round(now() - startedAt),
        ...(resp ? { resp } : {}),
      });
      return response;
    });
  };
  // `typeof fetch` (Bun's global) carries a `preconnect` member the wrapper neither has nor needs — the
  // ShapeStream only ever invokes fetchClient as a plain fetch — so the shape-compatible cast is safe.
  return wrapped as typeof fetch;
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
