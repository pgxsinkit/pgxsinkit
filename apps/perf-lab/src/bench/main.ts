// Storage benchmark — the plain (no-framework) page that drives the benchmark worker and renders the results
// as a wa-sqlite-style grid: one table per battery, backends as columns.
//
// Kept dependency-free on purpose: this page is opened on an iPhone to gather the WebKit numbers, and it is
// published to the public docs site — so it must boot with nothing but the worker and inline CSS.
//
// Automation hooks the Playwright driver (scripts/run-bench.ts) relies on: `window.__benchResults` (the
// final JSON envelope), and query params — `?auto=1` runs everything; `?batteries=a,b`, `?backends=idb`,
// `?strict=1` narrow the run.

import { defaultBackendChecked, normalizePlatform, opfsAhpWarning, opfsRepackedSwWarning } from "./backend-defaults";
import { classifyOpfsEngineClass } from "./engine-class";
import {
  BATTERIES,
  BENCH_BACKENDS,
  type BatteryBackendResult,
  type BatteryId,
  type BatteryResult,
  type BatteryStep,
  type BenchBackend,
  type BenchResults,
  parseRepackedExtentSize,
  parseEngine,
  type SharedWorkerProof,
  type WorkerInbound,
  type WorkerOutbound,
} from "./protocol";
import { runSharedWorkerProof } from "./sharedworker-proof";

declare global {
  interface Window {
    /** The final results envelope, set once the suite completes. The automation contract. */
    __benchResults?: BenchResults | undefined;
  }
}

const runButton = document.getElementById("run") as HTMLButtonElement;
const progressEl = document.getElementById("progress") as HTMLPreElement;
const tablesEl = document.getElementById("results-tables") as HTMLDivElement;
const jsonEl = document.getElementById("results-json") as HTMLPreElement;
const batteryListEl = document.getElementById("battery-list") as HTMLDivElement;
const backendListEl = document.getElementById("backend-list") as HTMLDivElement;
const strictToggleEl = document.getElementById("strict-toggle") as HTMLInputElement;
const envelopeEl = document.getElementById("envelope") as HTMLDivElement;
const restoreNoticeEl = document.getElementById("restore-notice") as HTMLDivElement;
const swProofEl = document.getElementById("sw-proof") as HTMLDivElement;

// ---- controls: build the battery / backend checkbox lists from the manifests ----

function makeCheckbox(
  container: HTMLElement,
  id: string,
  value: string,
  label: string,
  checked: boolean,
): HTMLInputElement {
  const wrap = document.createElement("label");
  wrap.className = "opt";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.value = value;
  input.id = id;
  input.checked = checked;
  const text = document.createElement("span");
  text.textContent = label;
  wrap.append(input, text);
  container.append(wrap);
  return input;
}

// The engine class + OS platform drive the DEFAULT backend selection: native `opfs-ahp` is default-ticked
// where it actually runs — Firefox everywhere, and Chromium on Windows/macOS — and default-unticked where it
// wedges or is unsupported (Chromium/Linux's storage-service FD-limit wedge; WebKit's ~252 handle cap). See
// backend-defaults for the proven mechanism.
const engineClass = classifyOpfsEngineClass();
// Platform gates the Chromium opfs-ahp default (Windows/macOS run it; Linux wedges).
// `navigator.userAgentData.platform` is present exactly where chromium-like is (userAgentData is the
// Chromium-only signal `classifyOpfsEngineClass` keys on); it is absent on Firefox/WebKit, which normalize to
// "unknown" — harmless, as the engine class already decides those.
const rawPlatform = (navigator as { userAgentData?: { platform?: unknown } }).userAgentData?.platform;
const platform = normalizePlatform(typeof rawPlatform === "string" ? rawPlatform : undefined);

for (const battery of BATTERIES) {
  makeCheckbox(batteryListEl, `bat-${battery.id}`, battery.id, battery.title, true);
}
for (const backend of BENCH_BACKENDS) {
  const input = makeCheckbox(
    backendListEl,
    `bk-${backend}`,
    backend,
    backend,
    defaultBackendChecked(backend, engineClass, platform),
  );
  // Warn next to `opfs-ahp` on the engine class / platform combinations where opening its store wedges the
  // browser (Chromium/Linux) or is unsupported (WebKit); `undefined` on the combinations where it runs.
  // Same pattern for `opfs-repacked-sw`, which only WebKit's SharedWorker scope can host.
  const warning =
    backend === "opfs-ahp"
      ? opfsAhpWarning(engineClass, platform)
      : backend === "opfs-repacked-sw"
        ? opfsRepackedSwWarning(engineClass)
        : undefined;
  if (warning) {
    const warn = document.createElement("span");
    warn.className = "warn";
    warn.textContent = warning;
    input.closest("label")?.append(warn);
  }
}

function checkedValues(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]:checked')).map(
    (el) => el.value,
  );
}

// ---- progress + rendering ----

function appendProgress(line: string): void {
  progressEl.textContent += `${line}\n`;
  progressEl.scrollTop = progressEl.scrollHeight;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms.toFixed(2)} ms`;
}

// The union of step labels across a battery's backends, preserving first-seen order (all backends run the
// same steps in the same order, but a partially-unavailable column may be short).
function stepLabels(battery: BatteryResult): string[] {
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const backend of battery.backends) {
    for (const step of backend.steps) {
      if (!seen.has(step.label)) {
        seen.add(step.label);
        labels.push(step.label);
      }
    }
  }
  return labels;
}

function renderCell(step: BatteryStep | undefined, backendUnavailable: string | undefined): string {
  if (backendUnavailable) {
    return `<td class="unavailable" title="${escapeHtml(backendUnavailable)}">unavailable</td>`;
  }
  if (!step) return `<td class="muted">—</td>`;
  if (step.unavailable) {
    return `<td class="unavailable" title="${escapeHtml(step.unavailable)}">unavailable</td>`;
  }
  const lines: string[] = [`<strong>${fmtMs(step.totalMs)}</strong>`];
  if (step.opsPerSec !== undefined && step.opsPerSec > 0) {
    lines.push(`${step.opsPerSec.toLocaleString()} ops/s`);
  }
  if (step.stats) {
    lines.push(
      `<span class="detail">mean ${step.stats.meanMs.toFixed(2)} · p50 ${step.stats.p50Ms.toFixed(2)} · ` +
        `p95 ${step.stats.p95Ms.toFixed(2)} · max ${step.stats.maxMs.toFixed(2)} ms</span>`,
    );
  }
  if (step.rowsTouched !== undefined) {
    lines.push(`<span class="detail">${step.rowsTouched.toLocaleString()} rows</span>`);
  }
  return `<td>${lines.join("<br>")}</td>`;
}

function renderBatteryTable(battery: BatteryResult): string {
  const columns = battery.backends.map((b) => b.backend);
  const labels = stepLabels(battery);
  const head =
    `<tr><th>step</th>` +
    columns
      .map((backend) => {
        const col = battery.backends.find((b) => b.backend === backend)!;
        const build = col.buildMs !== undefined ? `<span class="detail">build ${fmtMs(col.buildMs)}</span>` : "";
        return `<th>${backend}${build ? `<br>${build}` : ""}</th>`;
      })
      .join("") +
    `</tr>`;
  const body = labels
    .map((label) => {
      const cells = columns
        .map((backend) => {
          const col = battery.backends.find((b) => b.backend === backend)!;
          const step = col.steps.find((s) => s.label === label);
          return renderCell(step, col.unavailable);
        })
        .join("");
      return `<tr><td class="rowlabel">${escapeHtml(label)}</td>${cells}</tr>`;
    })
    .join("");
  const durabilityNote = battery.crossesDurability
    ? "crosses relaxed + strict"
    : `${battery.relaxedDurability ? "relaxed" : "strict"} durability`;
  return (
    `<section class="battery">` +
    `<h3>${escapeHtml(battery.title)} <span class="tag">${durabilityNote}</span></h3>` +
    `<p class="desc">${escapeHtml(battery.description)}</p>` +
    `<div class="scroll"><table><thead>${head}</thead><tbody>${body}</tbody></table></div>` +
    `</section>`
  );
}

function renderEnvelope(results: BenchResults): void {
  // Restored pre-field envelopes (sessionStorage survives a deploy) may lack the proof section.
  const proofVerdict: string = results.sharedWorkerProof?.verdict ?? "(not recorded)";
  envelopeEl.innerHTML =
    `<dl>` +
    `<dt>engine</dt><dd>${escapeHtml(results.engine)}</dd>` +
    `<dt>user agent</dt><dd>${escapeHtml(results.userAgent)}</dd>` +
    `<dt>started</dt><dd>${escapeHtml(results.startedAt)}</dd>` +
    `<dt>finished</dt><dd>${escapeHtml(results.finishedAt)}</dd>` +
    `<dt>durability</dt><dd>${results.strict ? "strict" : "relaxed"} (non-matrix batteries)</dd>` +
    `<dt>backends</dt><dd>${results.backends.join(", ")}</dd>` +
    `<dt>sw-proof</dt><dd>${escapeHtml(proofVerdict)}</dd>` +
    `</dl>`;
}

// The one-line SharedWorker-direct verdict banner above the tables (phase 0; ADR-0048 open item).
function renderSwProof(proof: SharedWorkerProof | undefined): void {
  if (!proof) {
    swProofEl.hidden = true;
    swProofEl.textContent = "";
    swProofEl.className = "";
    return;
  }
  swProofEl.hidden = false;
  if (proof.verdict === "granted-and-persisted") {
    swProofEl.className = "sw-granted";
    swProofEl.textContent =
      "SharedWorker-direct OPFS: GRANTED — the full opfs-repacked engine booted, persisted, and reopened inside SharedWorker scope.";
    return;
  }
  if (proof.verdict === "denied") {
    swProofEl.className = "sw-denied";
    swProofEl.textContent =
      "SharedWorker-direct OPFS: denied — sync-access handles are dedicated-worker-only in this engine (expected on Chromium/Firefox).";
    return;
  }
  const failedStage = proof.stages.find((s) => !s.ok);
  swProofEl.className = "sw-failed";
  swProofEl.textContent =
    `SharedWorker-direct OPFS: ${proof.verdict}` + (failedStage?.error ? ` — ${failedStage.error}` : "");
}

function renderResults(results: BenchResults): void {
  renderEnvelope(results);
  renderSwProof(results.sharedWorkerProof);
  tablesEl.innerHTML =
    results.batteries.map(renderBatteryTable).join("") +
    (results.fatalError ? `<p class="unavailable">fatal: ${escapeHtml(results.fatalError)}</p>` : "");
  jsonEl.textContent = JSON.stringify(results, null, 2);
}

// ---- incremental persistence + restore (iOS Safari memory-pressure reload survival) ----
//
// iOS Safari hard-reloads this page under memory pressure once the suite has churned enough OPFS/IDB stores,
// wiping the DOM before the user reads the grid (field report). To survive that, the CURRENT envelope is
// mirrored to sessionStorage after every re-render; on the next load — if the page is NOT auto-running — the
// last envelope is restored into the grid behind a labelled notice. Persistence is best-effort (wrapped in
// try/catch for quota / private-mode) and NEVER breaks the run.

/** Single sessionStorage key holding the most recent envelope as JSON (envelopes are a few KB). */
const RESULTS_STORAGE_KEY = "bench:last-results";

function persistResults(results: BenchResults): void {
  try {
    sessionStorage.setItem(RESULTS_STORAGE_KEY, JSON.stringify(results));
  } catch {
    // Quota exceeded, private-mode, or storage disabled — persistence is best-effort; the run continues.
  }
}

function clearPersistedResults(): void {
  try {
    sessionStorage.removeItem(RESULTS_STORAGE_KEY);
  } catch {
    // Storage unavailable — nothing to clear.
  }
}

function readPersistedResults(): BenchResults | undefined {
  let raw: string | null;
  try {
    raw = sessionStorage.getItem(RESULTS_STORAGE_KEY);
  } catch {
    return undefined;
  }
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as BenchResults;
  } catch {
    return undefined;
  }
}

// Show the "restored from a previous run" banner above the grid, explaining the (likely) iOS memory reload.
function showRestoreNotice(results: BenchResults): void {
  restoreNoticeEl.innerHTML =
    `<strong>Restored from the previous run</strong> (the page reloaded — on iOS Safari this is typically ` +
    `memory pressure). Started ${escapeHtml(results.startedAt)}. Press <em>Run selected</em> to start fresh.`;
  restoreNoticeEl.hidden = false;
}

function hideRestoreNotice(): void {
  restoreNoticeEl.hidden = true;
  restoreNoticeEl.textContent = "";
}

// ---- run orchestration: per-cell worker isolation + inactivity watchdog ----
//
// Each CELL — one battery × one backend — runs in its OWN short-lived dedicated worker, spawned fresh and
// terminated once the cell finishes. The PAGE drives the loop (not one long-lived worker): a wedged cell (an
// opfs-ahp store-open that hits the Chromium/Linux storage-service FD-limit wedge) is now survivable, because
// an INACTIVITY watchdog terminates the frozen worker, records the cell as `hung`, and continues with the
// next cell instead of taking the whole suite down. All opfs-ahp cells are ALSO scheduled LAST (see
// runBenchmark's two passes): the FD wedge is PROFILE-WIDE and non-recoverable, so a wedged ahp cell would
// hang every cell scheduled after it — running ahp last means it can only ever take out other ahp cells,
// never the idb/opfs-repacked columns. The per-cell partials are merged into ONE final `window.__benchResults`
// envelope — the same shape the Playwright driver (scripts/run-bench.ts) consumes.

/** Inactivity deadline: this many seconds with NO progress from a cell worker means it wedged. */
// 90s, not 60: strict-durability idb legitimately exceeds 60s of silence between progress lines on slower
// machines (~100-160ms per insert × 200 with no per-insert progress), which false-flagged real runs as hung.
const WATCHDOG_INACTIVITY_SECONDS = 90;
const WATCHDOG_INACTIVITY_MS = WATCHDOG_INACTIVITY_SECONDS * 1000;
/** The reason string recorded for a cell the watchdog terminated (StoreOutcome-style, like unavailable cells). */
const HUNG_REASON = `hung — no progress for ${WATCHDOG_INACTIVITY_SECONDS}s, worker terminated`;

// Battery run order (matches the manifest / the worker).
const BATTERY_ORDER: readonly BatteryId[] = ["flush-matrix", "bulk-write", "big-read", "update-delete"];

let running = false;

/** Outcome of one cell: the single-column BatteryResult the worker produced, or a hung marker. */
interface CellOutcome {
  result?: BatteryResult | undefined;
  hung: boolean;
}

// Run ONE cell in its own worker. Resolves when the worker reports "done", or when the watchdog terminates a
// wedged worker. The Promise NEVER rejects — a hung/errored cell resolves to a recorded outcome so the loop
// always advances.
function runCell(
  batteryId: BatteryId,
  backend: BenchBackend,
  strict: boolean,
  debug: boolean,
  repackedExtentSize: 8192 | 65_536,
): Promise<CellOutcome> {
  return new Promise<CellOutcome>((resolve) => {
    let settled = false;
    let timer = 0;
    let post: (message: WorkerInbound) => void;
    let dispose: () => void;

    const finish = (outcome: CellOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Disposing releases this cell's OPFS sync access handles / IDB connections; per-run unique store
      // names (runId, worker-side) keep the next cell's fresh store from colliding with anything left behind.
      dispose();
      resolve(outcome);
    };

    const onHang = (): void => {
      appendProgress(`✗ ${batteryId} · ${backend}: ${HUNG_REASON}`);
      finish({ hung: true });
    };

    // INACTIVITY watchdog: every progress message re-arms it; silence for the deadline means the worker
    // wedged (the opfs-ahp store-open freeze is a SYNCHRONOUS hang — no error fires, only this timer catches it).
    const armWatchdog = (): void => {
      clearTimeout(timer);
      timer = setTimeout(onHang, WATCHDOG_INACTIVITY_MS) as unknown as number;
    };

    const onMessage = (event: MessageEvent<WorkerOutbound>): void => {
      const message = event.data;
      if (message.type === "progress") {
        appendProgress(message.line);
        armWatchdog();
        return;
      }
      // "done" — a run narrowed to one battery × one backend yields exactly one battery with one column.
      finish({ result: message.results.batteries[0], hung: false });
    };

    // A stray uncaught worker error (e.g. PGlite's non-fatal relaxed-durability idb close race, being fixed
    // upstream separately) must NOT kill the cell or the suite: log it scoped and let the watchdog arbitrate —
    // a truly dead worker stops emitting progress and trips the deadline, while the close race still posts "done".
    const onError = (event: ErrorEvent): void => {
      appendProgress(`⚠ ${batteryId} · ${backend}: worker error (non-fatal) — ${event.message}`);
    };

    // HARD-WON LESSON (mirrors apps/board/src/board/storage-preference.ts): the `new URL(...)` literal MUST
    // sit INLINE inside the constructor call — hoisting it to a variable makes Vite ship the raw .worker.ts
    // as an asset instead of bundling a worker chunk. Spawning in a loop is fine; keep it verbatim.
    if (backend === "opfs-repacked-sw") {
      // The SharedWorker-direct hosting comparison cell: same suite, SharedWorker scope. A UNIQUE name per
      // cell guarantees a fresh instance (same-name SharedWorkers dedupe to a live one with stale module
      // state). A SharedWorker cannot be terminated from the page AND closing its port does not reclaim it
      // (it lives until this document dies) — so the WORKER terminates itself (self.close()) once its suite
      // settles; dispose here is channel hygiene only. Residual leak: a cell the watchdog abandoned mid-hang
      // never reaches its self-close and stays resident until page reload (its store is harmless — per-cell
      // unique store names — but its memory is not reclaimed; an unavoidable SharedWorker limitation).
      const sharedWorker = new SharedWorker(new URL("./bench.sharedworker.ts", import.meta.url), {
        type: "module",
        name: `bench-sw-${crypto.randomUUID().slice(0, 8)}`,
        extendedLifetime: true,
      } as WorkerOptions & { name: string; extendedLifetime: boolean });
      sharedWorker.port.addEventListener("message", onMessage);
      sharedWorker.addEventListener("error", onError as (event: Event) => void);
      sharedWorker.port.start();
      post = (message) => sharedWorker.port.postMessage(message);
      dispose = () => sharedWorker.port.close();
    } else {
      const worker = new Worker(new URL("./bench.worker.ts", import.meta.url), { type: "module" });
      worker.addEventListener("message", onMessage);
      worker.addEventListener("error", onError);
      post = (message) => worker.postMessage(message);
      dispose = () => worker.terminate();
    }

    armWatchdog();
    post({
      type: "run",
      batteries: [batteryId],
      backends: [backend],
      strict,
      debug,
      repackedExtentSize,
    });
  });
}

// Mirrors the worker: flush-matrix always runs relaxed; the rest follow the strict toggle.
function relaxedForBattery(batteryId: BatteryId, strict: boolean): boolean {
  return batteryId === "flush-matrix" ? true : !strict;
}

// The empty battery shell a cell's columns are appended into (used when the FIRST cell of a battery is the one
// that hung, so there is no worker-produced BatteryResult to seed from).
function batteryShell(batteryId: BatteryId, strict: boolean): BatteryResult {
  const meta = BATTERIES.find((b) => b.id === batteryId)!;
  const shell: BatteryResult = {
    id: meta.id,
    title: meta.title,
    description: meta.description,
    perOp: meta.perOp,
    relaxedDurability: relaxedForBattery(batteryId, strict),
    backends: [],
  };
  if (meta.crossesDurability) shell.crossesDurability = true;
  return shell;
}

async function runBenchmark(
  batteries: BatteryId[],
  backends: BenchBackend[],
  strict: boolean,
  debug: boolean,
  repackedExtentSize: 8192 | 65_536,
): Promise<void> {
  if (running) return;
  running = true;
  runButton.disabled = true;
  progressEl.textContent = "";
  tablesEl.innerHTML = "";
  jsonEl.textContent = "";
  envelopeEl.innerHTML = "";
  renderSwProof(undefined);
  // A fresh run replaces any restored results: drop the notice and the stale key so old numbers can never
  // masquerade as current — the first persistResults below re-seeds the key with this run's envelope.
  hideRestoreNotice();
  clearPersistedResults();
  window.__benchResults = undefined;

  const selectedBatteries = batteries.length > 0 ? batteries : BATTERIES.map((b) => b.id);
  const selectedBackends = backends.length > 0 ? backends : [...BENCH_BACKENDS];
  const orderedBatteries = BATTERY_ORDER.filter((id) => selectedBatteries.includes(id));

  const startedAt = new Date().toISOString();
  const userAgent = navigator.userAgent;

  appendProgress(`Engine: ${userAgent}`);
  appendProgress(
    `Batteries: ${orderedBatteries.join(", ") || "(all)"} · backends: ${selectedBackends.join(", ")} · ${strict ? "strict" : "relaxed"}`,
  );
  appendProgress(
    `Per-cell isolation: each battery × backend runs in its own worker (inactivity watchdog ${WATCHDOG_INACTIVITY_SECONDS}s).`,
  );

  // Phase 0 — the SharedWorker-direct proof (ADR-0048 open item), unconditional on every engine: on
  // WebKit it answers the open question; on Chromium/Firefox it re-verifies the denial each run.
  appendProgress("── phase 0: SharedWorker-direct proof ──");
  const sharedWorkerProof = await runSharedWorkerProof(engineClass, appendProgress);
  appendProgress(`sw-proof verdict: ${sharedWorkerProof.verdict}`);

  const results: BenchResults = {
    userAgent,
    engine: parseEngine(userAgent),
    startedAt,
    finishedAt: startedAt,
    strict,
    repackedExtentSize,
    backends: selectedBackends,
    selectedBatteries: orderedBatteries,
    batteries: [],
    sharedWorkerProof,
  };
  renderSwProof(sharedWorkerProof);

  appendProgress("Starting…");

  // Merge per-cell partials into the shared envelope, one backend column at a time. Columns are kept in
  // BENCH_BACKENDS order INDEPENDENT of execution order: opfs-ahp runs last (pass 2 below) but must still
  // render in its BENCH_BACKENDS slot (the middle column), so each new column is INSERTED at its ranked
  // position rather than pushed in run order.
  const byBattery = new Map<BatteryId, BatteryResult>();
  const backendRank = (backend: BenchBackend): number => BENCH_BACKENDS.indexOf(backend);
  const appendColumn = (batteryId: BatteryId, column: BatteryBackendResult): void => {
    let battery = byBattery.get(batteryId);
    if (!battery) {
      battery = batteryShell(batteryId, strict);
      byBattery.set(batteryId, battery);
      results.batteries.push(battery);
    }
    const at = battery.backends.findIndex((c) => backendRank(c.backend) > backendRank(column.backend));
    if (at === -1) battery.backends.push(column);
    else battery.backends.splice(at, 0, column);
  };
  const mergeOutcome = (batteryId: BatteryId, backend: BenchBackend, outcome: CellOutcome): void => {
    if (outcome.hung) {
      appendColumn(batteryId, { backend, unavailable: HUNG_REASON, steps: [] });
      return;
    }
    const column = outcome.result?.backends[0];
    appendColumn(batteryId, column ?? { backend, unavailable: "no result returned", steps: [] });
  };

  // TWO PASSES so opfs-ahp always runs LAST: a wedged opfs-ahp cell poisons the PROFILE-WIDE Chrome storage
  // service (FD exhaustion queues createSyncAccessHandle forever, non-recoverably), so any cell scheduled after
  // it would also hang. Pass 1 = all selected batteries × every non-ahp backend; pass 2 = all selected
  // batteries × opfs-ahp only. Column ORDER in the envelope stays BENCH_BACKENDS order regardless (appendColumn
  // inserts by rank), independent of this order.
  const nonAhpBackends = selectedBackends.filter((backend) => backend !== "opfs-ahp");
  const ahpSelected = selectedBackends.includes("opfs-ahp");

  // Pass 1 — every selected battery × every NON-ahp backend.
  for (const batteryId of orderedBatteries) {
    appendProgress(`══ battery: ${batteryId} ══`);

    for (const backend of nonAhpBackends) {
      mergeOutcome(batteryId, backend, await runCell(batteryId, backend, strict, debug, repackedExtentSize));
      renderResults(results);
      persistResults(results);
    }
  }

  // Pass 2 — every selected battery × opfs-ahp, LAST. Skipped entirely when opfs-ahp is unselected.
  if (ahpSelected) {
    for (const batteryId of orderedBatteries) {
      appendProgress(`══ battery: ${batteryId} (opfs-ahp, last pass) ══`);
      mergeOutcome(batteryId, "opfs-ahp", await runCell(batteryId, "opfs-ahp", strict, debug, repackedExtentSize));
      renderResults(results);
      persistResults(results);
    }
  }

  results.finishedAt = new Date().toISOString();
  appendProgress("Suite complete.");
  renderResults(results);
  persistResults(results);
  window.__benchResults = results;
  running = false;
  runButton.disabled = false;
}

function runFromControls(): void {
  const batteries = checkedValues(batteryListEl) as BatteryId[];
  const backends = checkedValues(backendListEl) as BenchBackend[];
  void runBenchmark(batteries, backends, strictToggleEl.checked, debugEnabled, repackedExtentSize);
}

runButton.addEventListener("click", runFromControls);

// ---- automation / deep-link entry: query params ----

const params = new URLSearchParams(window.location.search);

function parseList<T extends string>(value: string | null, allowed: readonly T[]): T[] {
  if (!value) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is T => (allowed as readonly string[]).includes(s));
}

// Reflect deep-link params into the checkboxes so the UI matches what auto-run does.
const batteryParam = parseList<BatteryId>(
  params.get("batteries"),
  BATTERIES.map((b) => b.id),
);
const backendParam = parseList<BenchBackend>(params.get("backends"), BENCH_BACKENDS);
const strictParam = params.get("strict") === "1";
const repackedExtentSize = parseRepackedExtentSize(params.get("repackedExtentSize"));
// `?debug=1` — pass PGlite's numeric `debug: 1` to every cell worker's stores. With @pgxsinkit/pglite ≥
// 0.5.4-pgx.5 that reaches the opfs-ahp filesystem, which traces its init as `console.log('[opfs-ahp]', …)`;
// output lands in devtools / the Safari remote inspector (not the progress log). For the opfs-ahp hang probe.
const debugEnabled = params.get("debug") === "1";
const autoRun = params.get("auto") === "1";
if (batteryParam.length > 0) {
  for (const battery of BATTERIES) {
    (document.getElementById(`bat-${battery.id}`) as HTMLInputElement).checked = batteryParam.includes(battery.id);
  }
}
if (backendParam.length > 0) {
  for (const backend of BENCH_BACKENDS) {
    (document.getElementById(`bk-${backend}`) as HTMLInputElement).checked = backendParam.includes(backend);
  }
}
strictToggleEl.checked = strictParam;

// `?auto=1` — the automation hook: run immediately on load so the Playwright driver just navigates and
// waits for `window.__benchResults`. It runs whatever the checkboxes now reflect, which is the SINGLE source
// of truth: explicit `?batteries=`/`?backends=` params (reflected above) override the defaults exactly as
// before, and with no `?backends=` the engine+platform-aware defaults apply — so a bare `?auto=1` on the
// published page does NOT tick `opfs-ahp` where it wedges or is unsupported (Chromium/Linux's storage-service
// FD-limit wedge; WebKit's handle cap), keeping the page from freezing on load.
// Opting `opfs-ahp` in (via `?backends=` or the checkbox) is survivable — the watchdog plus the last-pass
// scheduling contain a wedge to the ahp cells alone.
if (autoRun) {
  runFromControls();
} else {
  // Not auto-running: if a previous run left an envelope in sessionStorage (the page reloaded — on iOS Safari
  // typically memory pressure), restore it into the grid behind a labelled notice so the numbers survive the
  // reload. A fresh Run overwrites the key at run start, so this can only ever show the most recent envelope.
  const restored = readPersistedResults();
  if (restored) {
    renderResults(restored);
    window.__benchResults = restored;
    showRestoreNotice(restored);
  }
}
