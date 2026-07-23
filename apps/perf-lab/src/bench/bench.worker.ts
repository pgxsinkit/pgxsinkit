// Storage benchmark — the dedicated worker that owns every PGlite instance.
//
// WHY this is a dedicated MODULE worker (and not the page, and not a SharedWorker): OPFS
// `createSyncAccessHandle` is granted ONLY in a dedicated worker on Chromium/Firefox. Running `idb` here too
// keeps the comparison honest — same thread, same timer.
//
// The suite NEVER crashes on a backend that cannot run in this context: each battery/backend column (and
// each individual step) is guarded and reported as `unavailable: <reason>`.
//
// Structure: each battery is a self-contained runner that opens its own fresh store(s) per backend, times
// its steps, and cleans up. Batteries are independent so the checkbox UI can run any subset in any
// combination — mirroring wa-sqlite's per-battery Run.

import { PGlite } from "@electric-sql/pglite";

import { createOpfsRepackedPGlite } from "../../../../packages/pglite-opfs-repacked/src/pglite-factory";
import type { CreateOpfsRepackedPGliteOptions } from "../../../../packages/pglite-opfs-repacked/src/pglite-factory";
import {
  BATTERIES,
  BENCH_BACKENDS,
  BENCH_INSERT_COUNT,
  BENCH_PAYLOAD,
  BIG_ROWS,
  BULK_AUTOCOMMIT_ROWS,
  BULK_DELETE_ROWS,
  BULK_TXN_ROWS,
  parseEngine,
  type RepackedExtentSize,
  POINT_LOOKUPS,
  TOAST_BYTES,
  TOAST_ROWS,
  UPDATE_BATCH,
  WIDE_COLS,
  WIDE_ROWS,
  WIDE_UPDATE_ROWS,
  type BatteryBackendResult,
  type BatteryId,
  type BatteryResult,
  type BatteryStep,
  type BenchBackend,
  type WorkerBenchResults,
  type CellStats,
  type WorkerInbound,
  type WorkerOutbound,
} from "./protocol";

// `self` types as a Window under this app's DOM lib; narrow it to just the worker-messaging surface we
// use so we neither pull in a conflicting WebWorker lib nor reach for `any`.
interface WorkerScope {
  postMessage(message: WorkerOutbound): void;
  addEventListener(type: "message", listener: (event: MessageEvent<WorkerInbound>) => void): void;
}

// The suite is hostable in two contexts: the classic per-cell DEDICATED worker (global postMessage), and a
// per-cell SharedWorker for the `opfs-repacked-sw` column (bench.sharedworker.ts wires a connection port
// here). Each worker instance runs exactly ONE cell, so a single settable emitter is sufficient.
let emit: (message: WorkerOutbound) => void = (message) => (self as unknown as WorkerScope).postMessage(message);

/** Route this instance's outbound messages (progress/done) — used by the SharedWorker entry. */
export function setBenchEmitter(fn: (message: WorkerOutbound) => void): void {
  emit = fn;
}

function post(message: WorkerOutbound): void {
  emit(message);
}

function progress(line: string): void {
  post({ type: "progress", line });
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.name ? `${error.name}: ${error.message}` : error.message;
  }
  return String(error);
}

// Nearest-rank percentile over an ascending-sorted latency sample.
function percentile(sortedAsc: number[], fraction: number): number {
  if (sortedAsc.length === 0) return 0;
  const rank = Math.ceil(fraction * sortedAsc.length);
  const index = Math.min(sortedAsc.length - 1, Math.max(0, rank - 1));
  return sortedAsc[index]!;
}

function summarize(latencies: number[]): CellStats {
  const sorted = [...latencies].sort((a, b) => a - b);
  const totalMs = latencies.reduce((sum, ms) => sum + ms, 0);
  return {
    count: latencies.length,
    totalMs,
    meanMs: latencies.length === 0 ? 0 : totalMs / latencies.length,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    maxMs: sorted.length === 0 ? 0 : sorted[sorted.length - 1]!,
  };
}

function opsPerSec(ops: number, totalMs: number): number {
  return totalMs <= 0 ? 0 : Math.round((ops / totalMs) * 1000);
}

// `?debug=1` on the page (threaded through the run message) turns on PGlite's numeric `debug` option for
// every store this cell opens. With @pgxsinkit/pglite ≥ 0.5.4-pgx.5 level 1 reaches the opfs-ahp filesystem,
// which traces its init phase-by-phase via `console.log('[opfs-ahp]', …)` — visible in devtools / the Safari
// remote inspector, for diagnosing the opfs-ahp store-open hang. Set once per run (each worker runs one cell).
let debugLevel: 0 | 1 = 0;
let repackedExtentSize: RepackedExtentSize = 65_536;
type RepackedDirectory = CreateOpfsRepackedPGliteOptions["directory"];

// The `idb`/`opfs-ahp` comparators go through PGlite's dataDir schemes. `opfs-repacked` always goes through
// its package factory so the host awaits every sync and the VFS construction mode is the sole durability
// authority. `debug` is PGlite's standard numeric option.
async function createPglite(backend: BenchBackend, name: string, relaxedDurability: boolean): Promise<PGlite> {
  if (backend === "idb") {
    return PGlite.create({ dataDir: `idb://${name}`, relaxedDurability, debug: debugLevel });
  }
  if (backend === "opfs-ahp") {
    return PGlite.create({ dataDir: `opfs-ahp://${name}`, relaxedDurability, debug: debugLevel });
  }
  const root = await navigator.storage.getDirectory();
  const directory = await root.getDirectoryHandle(name, { create: true });
  return createOpfsRepackedPGlite({
    directory: directory as unknown as RepackedDirectory,
    durability: relaxedDurability ? "relaxed" : "strict",
    extentSize: repackedExtentSize,
    pglite: { debug: debugLevel },
  });
}

// Delete an IndexedDB database by name. PGlite's `idb://<name>` maps to the database `/pglite/<name>`
// (its WASM_PREFIX `/pglite`). Best-effort so a repeated run never accumulates stores.
function deleteIdbDatabase(databaseName: string): Promise<void> {
  return new Promise((resolve) => {
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.deleteDatabase(databaseName);
    } catch {
      resolve();
      return;
    }
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
}

// Remove an OPFS store directory recursively. `opfs-ahp://<name>` resolves `<name>` (no slashes) to a single
// top-level directory under the OPFS root. Best-effort — the store must already be closed (handles released)
// first.
async function removeOpfsEntry(name: string): Promise<void> {
  try {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(name, { recursive: true });
  } catch {
    // Already gone, or OPFS is unavailable in this context — cleanup is best-effort by design.
  }
}

async function cleanup(backend: BenchBackend, name: string): Promise<void> {
  if (backend === "idb") {
    await deleteIdbDatabase(`/pglite/${name}`);
    return;
  }
  await removeOpfsEntry(name);
}

/** Discriminated outcome of a guarded store body — either the body's value, or a reason it couldn't run. */
type StoreOutcome<T> = { ok: true; value: T } | { ok: false; reason: string };

// Open a fresh store for `backend`, run `body`, and always clean up. Backend unavailability (e.g. OPFS in
// a non-granting context) is caught at construction and surfaced as `{ ok: false }`, never thrown.
async function withStore<T>(
  backend: BenchBackend,
  relaxedDurability: boolean,
  name: string,
  label: string,
  body: (pg: PGlite) => Promise<T>,
): Promise<StoreOutcome<T>> {
  let pg: PGlite;
  try {
    pg = await createPglite(backend, name, relaxedDurability);
  } catch (error) {
    const reason = describeError(error);
    progress(`⊘ ${label}: unavailable — ${reason}`);
    return { ok: false, reason };
  }
  try {
    return { ok: true, value: await body(pg) };
  } catch (error) {
    const reason = describeError(error);
    progress(`⊘ ${label}: failed mid-run — ${reason}`);
    return { ok: false, reason };
  } finally {
    try {
      await pg.close();
    } catch {
      // Ignore close races — the store is discarded next.
    }
    await cleanup(backend, name);
  }
}

// ---- fixtures shared by big-read and update-delete ----

const WIDE_COLUMNS = Array.from({ length: WIDE_COLS }, (_, i) => `c${i + 1}`);
// Every third wide column is text, the rest integer — a realistic 30-column mix.
const wideIsText = (index: number): boolean => index % 3 === 0;

function wideCreateSql(): string {
  const defs = WIDE_COLUMNS.map((col, i) => `${col} ${wideIsText(i) ? "text" : "integer"}`).join(", ");
  return `CREATE TABLE wide (id serial PRIMARY KEY, ${defs})`;
}

function wideInsertSql(): string {
  // generate_series(1,N) g — deterministic, engine-neutral fill.
  const exprs = WIDE_COLUMNS.map((_, i) => (wideIsText(i) ? `'w' || g` : `(g * ${i + 1}) % 1000`)).join(", ");
  return `INSERT INTO wide (${WIDE_COLUMNS.join(", ")}) SELECT ${exprs} FROM generate_series(1, ${WIDE_ROWS}) g`;
}

// Build the big-table fixtures once for a backend. `withToast` adds the ~100KB-text table (reads only).
async function buildFixtures(pg: PGlite, withToast: boolean): Promise<number> {
  const started = performance.now();
  // big: a ~6-column indexed table. k is the indexed lookup/range key, wkey joins to `wide`.
  await pg.exec(
    "CREATE TABLE big (id serial PRIMARY KEY, k integer NOT NULL, wkey integer NOT NULL, " +
      "category integer NOT NULL, amount double precision NOT NULL, label text NOT NULL)",
  );
  await pg.exec(
    `INSERT INTO big (k, wkey, category, amount, label) ` +
      `SELECT g, ((g - 1) % ${WIDE_ROWS}) + 1, g % 50, (g * 7 % 1000)::double precision, 'row-' || g ` +
      `FROM generate_series(1, ${BIG_ROWS}) g`,
  );
  await pg.exec("CREATE INDEX big_k_idx ON big (k)");
  await pg.exec(wideCreateSql());
  await pg.exec(wideInsertSql());
  if (withToast) {
    await pg.exec("CREATE TABLE toast_docs (id serial PRIMARY KEY, body text NOT NULL)");
    await pg.exec(
      `INSERT INTO toast_docs (body) SELECT repeat('t', ${TOAST_BYTES}) FROM generate_series(1, ${TOAST_ROWS}) g`,
    );
  }
  await pg.exec("ANALYZE");
  return performance.now() - started;
}

// ---- battery: flush-matrix (the original U5 6-cell matrix, now one battery) ----

async function runFlushMatrix(backends: BenchBackend[], runId: string): Promise<BatteryResult> {
  const backendResults: BatteryBackendResult[] = [];
  for (const backend of backends) {
    // Each durability setting is its own store (fresh, per U5), rendered as two steps in this backend's column.
    const steps: BatteryStep[] = [];
    for (const relaxed of [true, false]) {
      const label = `flush-matrix · ${backend} · ${relaxed ? "relaxed" : "strict"}`;
      const name = `bench-flush-${backend}-${relaxed ? "relaxed" : "strict"}-${runId}`;
      progress(`▶ ${label}: opening store…`);
      const outcome = await withStore(backend, relaxed, name, label, async (pg) => {
        await pg.exec("CREATE TABLE bench (id serial PRIMARY KEY, payload text NOT NULL)");
        const latencies: number[] = [];
        for (let i = 0; i < BENCH_INSERT_COUNT; i++) {
          const started = performance.now();
          await pg.query("INSERT INTO bench (payload) VALUES ($1)", [BENCH_PAYLOAD]);
          latencies.push(performance.now() - started);
        }
        const stats = summarize(latencies);
        progress(
          `✓ ${label}: mean ${stats.meanMs.toFixed(2)}ms · p50 ${stats.p50Ms.toFixed(2)}ms · ` +
            `p95 ${stats.p95Ms.toFixed(2)}ms · max ${stats.maxMs.toFixed(2)}ms`,
        );
        return stats;
      });
      const stepLabel = relaxed ? "relaxed" : "strict";
      if (!outcome.ok) {
        steps.push({ label: stepLabel, totalMs: 0, unavailable: outcome.reason });
        continue;
      }
      const stats = outcome.value;
      steps.push({
        label: stepLabel,
        totalMs: stats.totalMs,
        ops: stats.count,
        opsPerSec: opsPerSec(stats.count, stats.totalMs),
        stats,
      });
    }
    const unavailable = steps.length > 0 && steps.every((s) => s.unavailable) ? steps[0]!.unavailable : undefined;
    backendResults.push(unavailable ? { backend, unavailable, steps } : { backend, steps });
  }
  const meta = BATTERIES.find((b) => b.id === "flush-matrix")!;
  return {
    id: "flush-matrix",
    title: meta.title,
    description: meta.description,
    perOp: true,
    crossesDurability: true,
    relaxedDurability: true,
    backends: backendResults,
  };
}

// ---- battery: bulk-write (single transaction vs per-statement autocommit) ----

async function runBulkWrite(backends: BenchBackend[], relaxed: boolean, runId: string): Promise<BatteryResult> {
  const backendResults: BatteryBackendResult[] = [];
  for (const backend of backends) {
    const label = `bulk-write · ${backend}`;
    const name = `bench-bulk-${backend}-${runId}`;
    progress(`▶ ${label}: opening store…`);
    const result = await withStore(backend, relaxed, name, label, async (pg) => {
      const steps: BatteryStep[] = [];
      // A ~6-column table (matches the big-table shape without the index).
      await pg.exec(
        "CREATE TABLE bulk (id serial PRIMARY KEY, a integer, b integer, c double precision, d text, e boolean)",
      );

      // 1) N rows in ONE transaction — the fast path.
      progress(`  ${backend}: single-txn insert ${BULK_TXN_ROWS}…`);
      let started = performance.now();
      await pg.exec("BEGIN");
      await pg.exec(
        `INSERT INTO bulk (a, b, c, d, e) ` +
          `SELECT g, g % 100, (g * 3 % 1000)::double precision, 'bulk-' || g, (g % 2 = 0) ` +
          `FROM generate_series(1, ${BULK_TXN_ROWS}) g`,
      );
      await pg.exec("COMMIT");
      let ms = performance.now() - started;
      steps.push({
        label: `single transaction (${BULK_TXN_ROWS} rows)`,
        totalMs: ms,
        ops: BULK_TXN_ROWS,
        opsPerSec: opsPerSec(BULK_TXN_ROWS, ms),
        rowsTouched: BULK_TXN_ROWS,
      });
      progress(`  ${backend}: single-txn ${ms.toFixed(1)}ms (${opsPerSec(BULK_TXN_ROWS, ms)}/s)`);

      // 2) N rows one autocommit statement each — pays a commit per row.
      await pg.exec("TRUNCATE bulk");
      progress(`  ${backend}: per-statement autocommit ${BULK_AUTOCOMMIT_ROWS}…`);
      started = performance.now();
      for (let i = 0; i < BULK_AUTOCOMMIT_ROWS; i++) {
        await pg.query("INSERT INTO bulk (a, b, c, d, e) VALUES ($1, $2, $3, $4, $5)", [
          i,
          i % 100,
          (i * 3) % 1000,
          `bulk-${i}`,
          i % 2 === 0,
        ]);
      }
      ms = performance.now() - started;
      steps.push({
        label: `per-statement autocommit (${BULK_AUTOCOMMIT_ROWS} rows)`,
        totalMs: ms,
        ops: BULK_AUTOCOMMIT_ROWS,
        opsPerSec: opsPerSec(BULK_AUTOCOMMIT_ROWS, ms),
        rowsTouched: BULK_AUTOCOMMIT_ROWS,
      });
      progress(`  ${backend}: autocommit ${ms.toFixed(1)}ms (${opsPerSec(BULK_AUTOCOMMIT_ROWS, ms)}/s)`);
      return { backend, steps };
    });
    backendResults.push(result.ok ? result.value : { backend, unavailable: result.reason, steps: [] });
  }
  const meta = BATTERIES.find((b) => b.id === "bulk-write")!;
  return {
    id: "bulk-write",
    title: meta.title,
    description: meta.description,
    perOp: false,
    relaxedDurability: relaxed,
    backends: backendResults,
  };
}

// ---- battery: big-read (build fixtures once, then time the read families) ----

async function runBigRead(backends: BenchBackend[], relaxed: boolean, runId: string): Promise<BatteryResult> {
  const backendResults: BatteryBackendResult[] = [];
  for (const backend of backends) {
    const label = `big-read · ${backend}`;
    const name = `bench-read-${backend}-${runId}`;
    progress(`▶ ${label}: opening store…`);
    const result = await withStore(backend, relaxed, name, label, async (pg) => {
      progress(`  ${backend}: building fixtures (${BIG_ROWS} + ${WIDE_ROWS}×${WIDE_COLS} + ${TOAST_ROWS}×100KB)…`);
      const buildMs = await buildFixtures(pg, true);
      progress(`  ${backend}: fixtures built in ${buildMs.toFixed(0)}ms`);
      const steps: BatteryStep[] = [];

      // 1) Indexed point lookups — a batch of individually-timed queries (percentile envelope).
      const latencies: number[] = [];
      for (let i = 0; i < POINT_LOOKUPS; i++) {
        const k = 1 + Math.floor(Math.random() * BIG_ROWS);
        const started = performance.now();
        await pg.query("SELECT id, k, amount, label FROM big WHERE k = $1", [k]);
        latencies.push(performance.now() - started);
      }
      const stats = summarize(latencies);
      steps.push({
        label: `indexed point lookups (${POINT_LOOKUPS})`,
        totalMs: stats.totalMs,
        ops: POINT_LOOKUPS,
        opsPerSec: opsPerSec(POINT_LOOKUPS, stats.totalMs),
        rowsTouched: POINT_LOOKUPS,
        stats,
      });

      // 2) Index range scan — ~5k rows via the k index.
      steps.push(
        await timeQuery(
          pg,
          "index range scan (~5k rows)",
          "SELECT id, k, amount FROM big WHERE k BETWEEN 10000 AND 15000",
          "index",
        ),
      );

      // 3) Full-table aggregate — GROUP BY over all 50k rows.
      steps.push(
        await timeQuery(
          pg,
          "full-table aggregate (GROUP BY)",
          "SELECT category, count(*), avg(amount) FROM big GROUP BY category",
          "scans all rows",
          BIG_ROWS,
        ),
      );

      // 4) Unindexed predicate scan — seq scan over 50k on the non-indexed label column.
      steps.push(
        await timeQuery(
          pg,
          "unindexed predicate scan",
          "SELECT count(*) FROM big WHERE label = 'row-49999'",
          "seq scan",
          BIG_ROWS,
        ),
      );

      // 5) Join between big and wide.
      steps.push(
        await timeQuery(
          pg,
          "join big ⋈ wide",
          "SELECT count(*) FROM big JOIN wide ON big.wkey = wide.id WHERE wide.c2 < 500",
          "joins two tables",
          BIG_ROWS + WIDE_ROWS,
        ),
      );

      // 6) ORDER BY + LIMIT — top-100 by an unindexed column (sort of 50k).
      steps.push(
        await timeQuery(
          pg,
          "ORDER BY + LIMIT 100",
          "SELECT id, amount, label FROM big ORDER BY amount DESC LIMIT 100",
          "sorts all rows",
          BIG_ROWS,
        ),
      );

      return { backend, buildMs, steps };
    });
    backendResults.push(result.ok ? result.value : { backend, unavailable: result.reason, steps: [] });
  }
  const meta = BATTERIES.find((b) => b.id === "big-read")!;
  return {
    id: "big-read",
    title: meta.title,
    description: meta.description,
    perOp: false,
    relaxedDurability: relaxed,
    backends: backendResults,
  };
}

// Time a single query, capturing rows returned. `rowsTouched` overrides the returned-row count when the
// query aggregates/scans more than it returns (so the "rows touched" column is meaningful).
async function timeQuery(
  pg: PGlite,
  stepLabel: string,
  sql: string,
  note: string | undefined,
  rowsTouched?: number,
): Promise<BatteryStep> {
  const started = performance.now();
  const res = await pg.query(sql);
  const totalMs = performance.now() - started;
  const step: BatteryStep = {
    label: stepLabel,
    totalMs,
    rowsTouched: rowsTouched ?? (res as { rows?: unknown[] }).rows?.length ?? 0,
  };
  if (note !== undefined) step.note = note;
  return step;
}

// ---- battery: update-delete ----

async function runUpdateDelete(backends: BenchBackend[], relaxed: boolean, runId: string): Promise<BatteryResult> {
  const backendResults: BatteryBackendResult[] = [];
  for (const backend of backends) {
    const label = `update-delete · ${backend}`;
    const name = `bench-upd-${backend}-${runId}`;
    progress(`▶ ${label}: opening store…`);
    const result = await withStore(backend, relaxed, name, label, async (pg) => {
      progress(`  ${backend}: building fixtures (${BIG_ROWS} + ${WIDE_ROWS}×${WIDE_COLS})…`);
      const buildMs = await buildFixtures(pg, false);
      progress(`  ${backend}: fixtures built in ${buildMs.toFixed(0)}ms`);
      const steps: BatteryStep[] = [];

      // 1) Indexed batch update — UPDATE_BATCH single-row updates by the indexed key (percentile envelope).
      const latencies: number[] = [];
      for (let i = 0; i < UPDATE_BATCH; i++) {
        const k = 1 + Math.floor(Math.random() * BIG_ROWS);
        const started = performance.now();
        await pg.query("UPDATE big SET amount = amount + 1 WHERE k = $1", [k]);
        latencies.push(performance.now() - started);
      }
      const stats = summarize(latencies);
      steps.push({
        label: `indexed batch update (${UPDATE_BATCH})`,
        totalMs: stats.totalMs,
        ops: UPDATE_BATCH,
        opsPerSec: opsPerSec(UPDATE_BATCH, stats.totalMs),
        rowsTouched: UPDATE_BATCH,
        stats,
      });

      // 2) Wide-row update — one statement touching several of the 30 columns across WIDE_UPDATE_ROWS rows.
      // c1 is text (index 0); c2/c5/c8/c11 are integer columns (indices where i % 3 !== 0), so the `+ 1`
      // arithmetic is well-typed. (Every third wide column is text — see `wideIsText`.)
      let started = performance.now();
      const wideRes = await pg.query(
        `UPDATE wide SET c1 = 'u' || id, c2 = c2 + 1, c5 = c5 + 1, c8 = c8 + 1, c11 = c11 + 1 WHERE id <= ${WIDE_UPDATE_ROWS}`,
      );
      let ms = performance.now() - started;
      steps.push({
        label: `wide-row update (${WIDE_UPDATE_ROWS} rows × 5 cols)`,
        totalMs: ms,
        ops: WIDE_UPDATE_ROWS,
        opsPerSec: opsPerSec(WIDE_UPDATE_ROWS, ms),
        rowsTouched: (wideRes as { affectedRows?: number }).affectedRows ?? WIDE_UPDATE_ROWS,
      });

      // 3) Bulk delete then bulk reinsert.
      started = performance.now();
      await pg.exec(`DELETE FROM big WHERE k > ${BIG_ROWS - BULK_DELETE_ROWS}`);
      ms = performance.now() - started;
      steps.push({
        label: `bulk delete (${BULK_DELETE_ROWS} rows)`,
        totalMs: ms,
        ops: BULK_DELETE_ROWS,
        opsPerSec: opsPerSec(BULK_DELETE_ROWS, ms),
        rowsTouched: BULK_DELETE_ROWS,
      });

      started = performance.now();
      await pg.exec(
        `INSERT INTO big (k, wkey, category, amount, label) ` +
          `SELECT g, ((g - 1) % ${WIDE_ROWS}) + 1, g % 50, (g * 7 % 1000)::double precision, 'reins-' || g ` +
          `FROM generate_series(${BIG_ROWS - BULK_DELETE_ROWS + 1}, ${BIG_ROWS}) g`,
      );
      ms = performance.now() - started;
      steps.push({
        label: `bulk reinsert (${BULK_DELETE_ROWS} rows)`,
        totalMs: ms,
        ops: BULK_DELETE_ROWS,
        opsPerSec: opsPerSec(BULK_DELETE_ROWS, ms),
        rowsTouched: BULK_DELETE_ROWS,
      });
      return { backend, buildMs, steps };
    });
    backendResults.push(result.ok ? result.value : { backend, unavailable: result.reason, steps: [] });
  }
  const meta = BATTERIES.find((b) => b.id === "update-delete")!;
  return {
    id: "update-delete",
    title: meta.title,
    description: meta.description,
    perOp: false,
    relaxedDurability: relaxed,
    backends: backendResults,
  };
}

// ---- orchestration ----

export async function runSuite(message: WorkerInbound): Promise<void> {
  // `?debug=1` (threaded from the page) → PGlite `debug: 1` for every store this cell opens (all backends).
  debugLevel = message.debug ? 1 : 0;
  repackedExtentSize = message.repackedExtentSize;
  const startedAt = new Date().toISOString();
  const userAgent = navigator.userAgent;
  // A unique run id keeps every store fresh so a crashed prior run never collides.
  const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  const selectedBatteries = message.batteries.length > 0 ? message.batteries : BATTERIES.map((b) => b.id);
  const backends = message.backends.length > 0 ? message.backends : [...BENCH_BACKENDS];

  const results: WorkerBenchResults = {
    userAgent,
    engine: parseEngine(userAgent),
    startedAt,
    finishedAt: startedAt,
    strict: message.strict,
    repackedExtentSize,
    backends,
    selectedBatteries,
    batteries: [],
  };

  const relaxed = !message.strict;

  try {
    for (const id of BATTERY_ORDER) {
      if (!selectedBatteries.includes(id)) continue;
      progress(`══ battery: ${id} ══`);
      results.batteries.push(await dispatchBattery(id, backends, relaxed, runId));
    }
  } catch (error) {
    // A truly unexpected failure — still deliver whatever was gathered so the driver's wait never hangs.
    results.fatalError = describeError(error);
    progress(`✗ fatal: ${results.fatalError}`);
  }

  results.finishedAt = new Date().toISOString();
  post({ type: "done", results });
}

// Battery run order (matches the manifest).
const BATTERY_ORDER: readonly BatteryId[] = ["flush-matrix", "bulk-write", "big-read", "update-delete"];

function dispatchBattery(
  id: BatteryId,
  backends: BenchBackend[],
  relaxed: boolean,
  runId: string,
): Promise<BatteryResult> {
  switch (id) {
    case "flush-matrix":
      return runFlushMatrix(backends, runId);
    case "bulk-write":
      return runBulkWrite(backends, relaxed, runId);
    case "big-read":
      return runBigRead(backends, relaxed, runId);
    case "update-delete":
      return runUpdateDelete(backends, relaxed, runId);
  }
}

// Dedicated-worker bootstrap only: a SharedWorkerGlobalScope has `onconnect` and no global message
// stream — its bootstrap lives in bench.sharedworker.ts, which imports runSuite/setBenchEmitter.
if (!("onconnect" in self)) {
  (self as unknown as WorkerScope).addEventListener("message", (event) => {
    if (event.data.type === "run") {
      void runSuite(event.data);
    }
  });
}
