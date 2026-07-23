// Dev-only aggregated PGlite query profiler.
//
// PGlite's own logging is all-or-nothing — either nothing useful or a per-statement flood a human
// can't read. This instead wraps a PGlite instance's `query`/`exec` and AGGREGATES by a normalized
// SQL fingerprint (counts + timing), so you get signal, not noise: which statements run, how often,
// and how much WASM time they cost. Crucial because every PGlite query carries ~50ms of fixed WASM
// overhead, so idle cost is about query *frequency*, not weight.
//
// Wrapping is installed only while running (start) and removed on stop, so there is zero overhead when
// idle. Wired to `window.__boardProfiler` in dev (board-client-provider). Typical use from the console:
//
//   __boardProfiler.start(); // ...let it run a few seconds, or do some actions...
//   __boardProfiler.stop();  // → { queriesPerSec, busyMsPerSec, pctOfOneCore, byCost: [...] }

export interface QueryStat {
  /** Normalized SQL fingerprint (whitespace collapsed, live-query hashes + obvious literals masked). */
  sql: string;
  count: number;
  totalMs: number;
  avgMs: number;
  maxMs: number;
}

export interface ProfilerReport {
  windowSec: number;
  queriesPerSec: number;
  /** PGlite busy time per wall-second (ms). */
  busyMsPerSec: number;
  /** busyMsPerSec / 10 — a rough "% of one CPU core" the PGlite layer is spending. */
  pctOfOneCore: number;
  /** Per-fingerprint stats, sorted by total cost (the biggest offenders first). */
  byCost: QueryStat[];
}

export interface PgliteProfiler {
  /** Install the timing wrappers and start a fresh window. Idempotent. */
  start: () => void;
  /** Remove the wrappers and return the report for the window. */
  stop: () => ProfilerReport;
  /** Report for the window so far, without stopping. */
  report: () => ProfilerReport;
  /** Clear the accumulated stats and restart the window (keeps running). */
  reset: () => void;
  readonly running: boolean;
}

// The two methods we wrap. `(...args: never[])` is the lint-clean "any function" shape, so a real
// PGlite instance (whose `query`/`exec` take a `string` first) is assignable here.
type PgliteFn = (...args: never[]) => Promise<unknown>;
type PgliteLike = { query: PgliteFn; exec: PgliteFn };

interface Bucket {
  count: number;
  totalMs: number;
  maxMs: number;
}

function fingerprint(method: string, arg: unknown): string {
  let sql = typeof arg === "string" ? arg : ((arg as { query?: string; sql?: string })?.query ?? "");
  sql = sql
    .replace(/\s+/g, " ")
    .trim()
    // PGlite live queries are prepared as live_query_<hash>_get — collapse the hash so all live-query
    // executes bucket together rather than fragmenting into hundreds of one-off rows.
    .replace(/live_query_[0-9a-f]+/gi, "live_query_*")
    .slice(0, 100);
  return `${method} :: ${sql}`;
}

export function createPgliteProfiler(pglite: PgliteLike): PgliteProfiler {
  const buckets = new Map<string, Bucket>();
  let running = false;
  let windowStartMs = 0;
  const originals: Partial<Record<"query" | "exec", PgliteFn>> = {};

  const record = (key: string, durationMs: number) => {
    const bucket = buckets.get(key) ?? { count: 0, totalMs: 0, maxMs: 0 };
    bucket.count += 1;
    bucket.totalMs += durationMs;
    bucket.maxMs = Math.max(bucket.maxMs, durationMs);
    buckets.set(key, bucket);
  };

  const wrap = (method: "query" | "exec") => {
    originals[method] = pglite[method];
    const original = pglite[method].bind(pglite) as (...args: unknown[]) => Promise<unknown>;
    pglite[method] = (async (...args: unknown[]) => {
      const key = fingerprint(method, args[0]);
      const started = performance.now();
      try {
        return await original(...args);
      } finally {
        record(key, performance.now() - started);
      }
    }) as PgliteFn;
  };

  const unwrap = () => {
    for (const method of ["query", "exec"] as const) {
      const original = originals[method];
      if (original) pglite[method] = original;
      delete originals[method];
    }
  };

  const buildReport = (): ProfilerReport => {
    const windowSec = Math.max((performance.now() - windowStartMs) / 1000, 0.001);
    const byCost = [...buckets.entries()]
      .map(([sql, b]) => ({
        sql,
        count: b.count,
        totalMs: Math.round(b.totalMs),
        avgMs: +(b.totalMs / b.count).toFixed(1),
        maxMs: Math.round(b.maxMs),
      }))
      .sort((a, b) => b.totalMs - a.totalMs);
    const totalCount = byCost.reduce((sum, q) => sum + q.count, 0);
    const totalMs = byCost.reduce((sum, q) => sum + q.totalMs, 0);
    return {
      windowSec: +windowSec.toFixed(1),
      queriesPerSec: +(totalCount / windowSec).toFixed(1),
      busyMsPerSec: Math.round(totalMs / windowSec),
      pctOfOneCore: +(totalMs / windowSec / 10).toFixed(1),
      byCost,
    };
  };

  return {
    start: () => {
      if (running) return;
      buckets.clear();
      windowStartMs = performance.now();
      wrap("query");
      wrap("exec");
      running = true;
    },
    stop: () => {
      const report = buildReport();
      unwrap();
      running = false;
      return report;
    },
    report: buildReport,
    reset: () => {
      buckets.clear();
      windowStartMs = performance.now();
    },
    get running() {
      return running;
    },
  };
}
