// Storage benchmark — the SharedWorker host for the `opfs-repacked-sw` column.
//
// Identical battery suite, different hosting context: this entry exists to answer, side-by-side on the
// same device, whether hosting the repacked engine DIRECTLY in a SharedWorker (the topology the erased
// stage-1 design used on WebKit, where `createSyncAccessHandle` is granted in SharedWorker scope) costs
// anything versus the per-cell dedicated worker. On Chromium/Firefox the store open fails inside
// withStore and the column reports `unavailable` — the suite structure is untouched.
//
// The page spawns one UNIQUELY NAMED SharedWorker per cell (same-name SharedWorkers dedupe to a live
// instance whose module state — debug level, extent size, emitter — would be stale), so exactly one
// connection arrives here and runs exactly one cell, mirroring the dedicated worker's lifecycle.
//
// LIFECYCLE (the memory-leak lesson): the page CANNOT terminate a SharedWorker, and closing its port does
// NOT reclaim it — the spec keeps a SharedWorkerGlobalScope alive until its owner DOCUMENT is destroyed.
// So this worker terminates ITSELF (`close()`) the moment the suite settles; the final "done" postMessage
// is already queued on the page's event loop by then, so it still delivers. Without this, every run leaked
// one full engine scope per sw cell until page unload — out-of-memory reloads after a few runs on iOS.
// Residual: a cell the page's watchdog abandoned mid-hang never reaches close() and stays leaked until
// reload — the accepted cost of an unterminatable hung instance.

import { runSuite, setBenchEmitter } from "./bench.worker";
import type { WorkerInbound, WorkerOutbound } from "./protocol";

interface BenchSharedPort {
  postMessage(message: WorkerOutbound): void;
  addEventListener(type: "message", listener: (event: MessageEvent<WorkerInbound>) => void): void;
  start(): void;
}

interface SharedWorkerScope {
  addEventListener(type: "connect", listener: (event: { ports: readonly BenchSharedPort[] }) => void): void;
  /** WorkerGlobalScope.close() — self-termination, the ONLY way a SharedWorker ever gets reclaimed here. */
  close(): void;
}

const scope = globalThis as unknown as SharedWorkerScope;

scope.addEventListener("connect", (event) => {
  const port = event.ports[0];
  if (!port) return;
  let started = false;
  port.addEventListener("message", (message) => {
    if (message.data.type !== "run" || started) return;
    started = true;
    setBenchEmitter((outbound) => port.postMessage(outbound));
    // runSuite never rejects (fatal errors are caught into the envelope), but finally keeps the
    // self-termination unconditional either way.
    void runSuite(message.data).finally(() => scope.close());
  });
  port.start();
});
