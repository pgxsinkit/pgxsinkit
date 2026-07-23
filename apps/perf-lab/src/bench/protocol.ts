// Storage benchmark — the message/result protocol shared by the page (main.ts), the dedicated worker
// (bench.worker.ts) and the Playwright driver (scripts/run-bench.ts).
//
// This started life as a 6-cell flush-cost matrix. It has since grown into a wa-sqlite-style suite: a set
// of BATTERIES, each timing a family of SQL operations across the storage BACKENDS as columns (bulk writes,
// big-table reads, updates & deletes) so the shape is "battery rows × backend columns, times in each cell" —
// mirroring rhashimoto/wa-sqlite's benchmarks page.
//
// WHY a worker at all: OPFS `createSyncAccessHandle` is only granted in a dedicated worker on
// Chromium/Firefox. `idb` runs in the same worker too so every cell is apples-to-apples (same thread, same
// event-loop, same timer source).
//
// Everything measurable lives behind these shapes so the driver can consume `window.__benchResults` as a
// stable contract regardless of which engine ran it.

/**
 * The storage backends the suite compares: `idb` (the @pgxsinkit/pglite fork's IndexedDB VFS), `opfs-ahp`
 * (upstream PGlite's native OPFS VFS — known broken on WebKit and Linux Chrome, kept for the bench),
 * `opfs-repacked` (the constant-four-handle package factory, hosted in the cell's DEDICATED worker), and
 * `opfs-repacked-sw` (the identical factory hosted directly in a SharedWorker — runnable only where the
 * engine grants `createSyncAccessHandle` in SharedWorker scope, i.e. WebKit; the side-by-side answer to
 * "does SharedWorker-direct hosting cost anything vs the dedicated worker on Safari").
 */
export type BenchBackend = "idb" | "opfs-ahp" | "opfs-repacked" | "opfs-repacked-sw";

/** All backends, in the order the suite runs them (the default column set). */
export const BENCH_BACKENDS: readonly BenchBackend[] = ["idb", "opfs-ahp", "opfs-repacked", "opfs-repacked-sw"];

export type RepackedExtentSize = 8192 | 65_536;
export const REPACKED_EXTENT_SIZES: readonly RepackedExtentSize[] = [8192, 65_536];

export function parseRepackedExtentSize(value: string | null | undefined): RepackedExtentSize {
  const parsed = Number(value ?? 65_536);
  if (parsed !== 8192 && parsed !== 65_536) {
    throw new TypeError("repacked extent size must be 8192 or 65536 bytes");
  }
  return parsed;
}

/** The batteries, by id, in run order. */
export type BatteryId = "flush-matrix" | "bulk-write" | "big-read" | "update-delete";

/** Static description of one battery — shared by the worker (dispatch) and the page (checkbox list). */
export interface BatteryMeta {
  id: BatteryId;
  title: string;
  description: string;
  /**
   * `true` when the battery's steps are batches of individually-timed ops, so each step carries a
   * percentile envelope (`CellStats`). The page renders the extra mean/p50/p95/max lines for these.
   */
  perOp: boolean;
  /** `true` for the flush matrix, which crosses BOTH durability settings internally as its steps. */
  crossesDurability?: boolean;
}

/** The battery manifest — the single source of truth for the page's checkbox list and the worker. */
export const BATTERIES: readonly BatteryMeta[] = [
  {
    id: "flush-matrix",
    title: "Flush cost — per-op inserts × durability",
    description:
      "200 sequential single-row INSERTs, each timed individually, run once relaxed and once strict per " +
      "backend. The original U5 matrix: it isolates the fsync/flush cost that separates the two durability modes.",
    perOp: true,
    crossesDurability: true,
  },
  {
    id: "bulk-write",
    title: "Bulk writes — one transaction vs per-statement autocommit",
    description:
      "The classic wa-sqlite pair on a ~6-column table: N rows inserted inside ONE transaction vs N rows " +
      "each in its own autocommit statement. The gap is the per-commit overhead.",
    perOp: false,
  },
  {
    id: "big-read",
    title: "Big-table reads",
    description:
      "Builds a ~50k-row indexed table, a ~30-column wide table and a ~100KB-text TOAST table once per " +
      "backend, then times point lookups, a range scan, a full-table aggregate, an unindexed scan, a join and ORDER BY + LIMIT.",
    perOp: false,
  },
  {
    id: "update-delete",
    title: "Updates & deletes",
    description:
      "Against the same big/wide fixtures: an indexed batch update, a wide-row update, and a bulk " +
      "delete followed by a bulk reinsert.",
    perOp: false,
  },
];

// ---- sizing constants (kept in the protocol so the page can show them and the driver can reason about them) ----

/** Sequential single-row INSERTs per flush-matrix cell — the flush-cost sample size. */
export const BENCH_INSERT_COUNT = 200;
/** A ~200-byte text payload per flush-matrix INSERT. */
export const BENCH_PAYLOAD = "x".repeat(200);

/** Bulk-write battery: rows inserted inside a single transaction. */
export const BULK_TXN_ROWS = 10_000;
/** Bulk-write battery: rows inserted one autocommit statement each (smaller — strict idb is ~87ms/row). */
export const BULK_AUTOCOMMIT_ROWS = 2_000;

/** Big-table fixtures. */
export const BIG_ROWS = 50_000;
export const WIDE_ROWS = 5_000;
export const WIDE_COLS = 30;
export const TOAST_ROWS = 300;
export const TOAST_BYTES = 100 * 1024;

/** Big-read battery: number of indexed point lookups timed individually. */
export const POINT_LOOKUPS = 200;
/** Update-delete battery: number of indexed single-row updates timed individually. */
export const UPDATE_BATCH = 200;
/** Update-delete battery: rows in the wide-row update statement. */
export const WIDE_UPDATE_ROWS = 1_000;
/** Update-delete battery: rows deleted then reinserted in bulk. */
export const BULK_DELETE_ROWS = 10_000;

/** Latency summary for a batch of individually-timed ops (all values in milliseconds unless noted). */
export interface CellStats {
  /** Number of ops actually timed. */
  count: number;
  /** Wall time across all timed ops. */
  totalMs: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}

/**
 * One row of a battery's results table — a single timed operation for a single backend.
 * `stats` is present only for `perOp` batteries (the percentile envelope U5 established).
 */
export interface BatteryStep {
  /** Row label, e.g. "indexed point lookups (200)" or, in the flush matrix, "relaxed" / "strict". */
  label: string;
  /** Total wall time for this step. */
  totalMs: number;
  /** Logical operations performed (rows inserted, queries issued, …) — drives `opsPerSec`. */
  ops?: number;
  /** Convenience: `ops / (totalMs/1000)`, rounded, when `ops` is set and meaningful. */
  opsPerSec?: number;
  /** Rows the step read or wrote (for the big-read/update batteries the owner asked to see). */
  rowsTouched?: number;
  /** Per-op percentile envelope — present for `perOp` batteries only. */
  stats?: CellStats;
  /** Free-text clarifier (e.g. "seq scan"). */
  note?: string;
  /** Present when this individual step could not run (the rest of the battery still reports). */
  unavailable?: string;
}

/** One backend column of one battery. Either it produced `steps`, or it was `unavailable` with a reason. */
export interface BatteryBackendResult {
  backend: BenchBackend;
  /** Present when the backend could not run this battery at all (e.g. OPFS in a non-granting context). */
  unavailable?: string;
  /** Fixture build time (big-read / update-delete), so cell times exclude setup. */
  buildMs?: number;
  steps: BatteryStep[];
}

/** One battery's full result — a table of `steps` (rows) × `backends` (columns). */
export interface BatteryResult {
  id: BatteryId;
  title: string;
  description: string;
  perOp: boolean;
  crossesDurability?: boolean;
  /** Durability the battery ran under (the flush matrix crosses both and ignores this). */
  relaxedDurability: boolean;
  backends: BatteryBackendResult[];
}

/** The whole suite output, stamped with engine info and set on `window.__benchResults`. */
export interface BenchResults {
  /** `navigator.userAgent` of the engine that ran the suite (per-engine numbers). */
  userAgent: string;
  /** Best-effort engine label parsed from the UA (Chromium / Firefox / WebKit·Safari / …). */
  engine: string;
  startedAt: string;
  finishedAt: string;
  /** Whether the strict-durability toggle was on for the non-matrix batteries. */
  strict: boolean;
  /** Extent profile used by opfs-repacked columns; other backends ignore it. */
  repackedExtentSize: RepackedExtentSize;
  /** The backend columns this run covered. */
  backends: BenchBackend[];
  /** The battery ids this run covered. */
  selectedBatteries: BatteryId[];
  batteries: BatteryResult[];
  /**
   * Phase-0 SharedWorker-direct proof (ADR-0048 open item): can this engine run the full repacked
   * engine inside SharedWorker scope? Every run records either the staged success or the exact
   * refusing stage — on Chromium/Firefox that is the expected denial, re-verified per run.
   */
  sharedWorkerProof: SharedWorkerProof;
  /** Set only when the worker itself failed before completing; the batteries are best-effort. */
  fatalError?: string;
}

/**
 * The per-cell envelope the DEDICATED worker produces. The SharedWorker-direct proof is a page-level
 * concern (only a Window can construct a `SharedWorker`), so the worker's envelope never carries it;
 * the page merges cells into the full {@link BenchResults}.
 */
export type WorkerBenchResults = Omit<BenchResults, "sharedWorkerProof">;

// ---- SharedWorker-direct proof (bench phase 0) ----

/** The proof's stages, in execution order. `cleanup` always runs, even after a failure. */
export const SHARED_WORKER_PROOF_STAGES = ["probe", "boot", "write", "close", "reopen", "verify", "cleanup"] as const;

export type SharedWorkerProofStageId = (typeof SHARED_WORKER_PROOF_STAGES)[number];

/** One completed (or refused) stage of the SharedWorker-direct proof. */
export interface SharedWorkerProofStage {
  stage: SharedWorkerProofStageId;
  ok: boolean;
  /** Wall-clock for the stage (`performance.now()`, SharedWorker thread; page thread if synthesized). */
  ms: number;
  /** Verbatim `name: message` of the refusing error. */
  error?: string;
}

export type SharedWorkerProofVerdict = "granted-and-persisted" | "denied" | `failed:${SharedWorkerProofStageId}`;

/** The envelope's SharedWorker-direct proof section. */
export interface SharedWorkerProof {
  /** The bench's engine-class detection at proof time (drives nothing here — recorded for the reader). */
  engineClass: "chromium-like" | "firefox" | "webkit-like";
  /** Whether `createSyncAccessHandle` exists on `FileSystemFileHandle.prototype` in SharedWorker scope. */
  methodPresent: boolean;
  /** Stages in execution order, stopping at the first failure (plus the always-attempted cleanup). */
  stages: SharedWorkerProofStage[];
  verdict: SharedWorkerProofVerdict;
}

/**
 * Total stages → verdict derivation. `denied` means the probe stage itself refused (the engine does
 * not grant sync-access handles in SharedWorker scope — the expected Chromium/Firefox outcome); any
 * later failure names its stage; a cleanup failure never demotes a proven verdict; and a truncated
 * stage list (the worker went silent) fails at the first stage that never reported.
 */
export function deriveSharedWorkerProofVerdict(stages: readonly SharedWorkerProofStage[]): SharedWorkerProofVerdict {
  const probe = stages.find((s) => s.stage === "probe");
  if (probe && !probe.ok) return "denied";
  for (const s of stages) {
    if (!s.ok && s.stage !== "cleanup") return `failed:${s.stage}`;
  }
  for (const id of SHARED_WORKER_PROOF_STAGES) {
    if (id === "cleanup") continue;
    if (!stages.some((s) => s.stage === id)) return `failed:${id}`;
  }
  return "granted-and-persisted";
}

/** Parse a coarse engine label from a user-agent string (best-effort, for the results envelope). */
export function parseEngine(userAgent: string): string {
  if (/\bFirefox\//.test(userAgent)) return "Firefox";
  if (/\bEdg\//.test(userAgent)) return "Edge";
  if (/\bChrome\//.test(userAgent) || /\bChromium\//.test(userAgent)) return "Chromium";
  if (/\b(iPhone|iPad|iPod)\b/.test(userAgent)) return "WebKit (iOS Safari)";
  if (/\bVersion\/[\d.]+ Safari/.test(userAgent)) return "WebKit (Safari)";
  return "unknown";
}

/** Page → worker: start a run with the selected batteries, backends and durability toggle. */
export interface RunMessage {
  type: "run";
  batteries: BatteryId[];
  backends: BenchBackend[];
  /** `true` runs the non-matrix batteries under strict durability; default `false` (relaxed). */
  strict: boolean;
  /** Extent profile used when this cell constructs opfs-repacked. */
  repackedExtentSize: RepackedExtentSize;
  /**
   * `true` (the page's `?debug=1`) passes PGlite's numeric `debug: 1` option to every store this cell opens.
   * With `@pgxsinkit/pglite` ≥ 0.5.4-pgx.5 that level also reaches the opfs-ahp filesystem, which then traces
   * its init phase-by-phase as `console.log('[opfs-ahp]', …)` — the delivery channel is the devtools / Safari
   * remote-inspector console (not the progress lines), for diagnosing the opfs-ahp store-open hang.
   */
  debug?: boolean;
}

/** Worker → page: a human-readable progress line. */
export interface ProgressMessage {
  type: "progress";
  line: string;
}

/** Worker → page: the suite finished (possibly with `fatalError` set on the envelope). */
export interface DoneMessage {
  type: "done";
  results: WorkerBenchResults;
}

/** Page → proof SharedWorker: run the staged proof against a throwaway store. */
export interface SwProofStartMessage {
  type: "start";
  /** Unique per-run OPFS directory name for the throwaway store. */
  storeName: string;
}

/** Proof SharedWorker → page: the probe ran; whether the method exists on the prototype at all. */
export interface SwProofBeginMessage {
  type: "begin";
  methodPresent: boolean;
}

/** Proof SharedWorker → page: one stage completed (or refused). */
export interface SwProofStageMessage {
  type: "stage";
  stage: SharedWorkerProofStage;
}

/** Proof SharedWorker → page: no further stages will be sent. */
export interface SwProofDoneMessage {
  type: "done";
}

export type SwProofInbound = SwProofStartMessage;
export type SwProofOutbound = SwProofBeginMessage | SwProofStageMessage | SwProofDoneMessage;

export type WorkerInbound = RunMessage;
export type WorkerOutbound = ProgressMessage | DoneMessage;
