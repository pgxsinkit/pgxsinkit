// SharedWorker-direct proof — the page-side runner (bench phase 0, ADR-0048 open item).
//
// Spawns the proof SharedWorker (a fresh, uniquely NAMED instance per run — same-name SharedWorkers
// dedupe to a live instance whose module state would be stale), drives the staged protocol, and
// assembles the envelope's `sharedWorkerProof` section. The runner never rejects: an engine with no
// `SharedWorker` at all, a worker script that fails to load, or a worker that goes silent all resolve
// to a proof whose stages say exactly what happened, so the JSON always carries an answer.

import type { OpfsEngineClass } from "./engine-class";
import {
  SHARED_WORKER_PROOF_STAGES,
  type SharedWorkerProof,
  type SharedWorkerProofStage,
  type SharedWorkerProofStageId,
  type SwProofOutbound,
  deriveSharedWorkerProofVerdict,
} from "./protocol";

/** Silence deadline: the SharedWorker not reporting for this long fails the stage it went quiet in. */
const PROOF_INACTIVITY_MS = 20_000;

function formatStageLine(stage: SharedWorkerProofStage): string {
  return stage.ok
    ? `sw-proof: ✓ ${stage.stage} ${stage.ms}ms`
    : `sw-proof: ✗ ${stage.stage} — ${stage.error ?? "unknown error"}`;
}

/** The first stage that has not reported yet — where a silent or crashed worker gets attributed. */
function nextExpectedStage(stages: readonly SharedWorkerProofStage[]): SharedWorkerProofStageId {
  for (const id of SHARED_WORKER_PROOF_STAGES) {
    if (!stages.some((s) => s.stage === id)) return id;
  }
  return "cleanup";
}

export function runSharedWorkerProof(
  engineClass: OpfsEngineClass,
  progress: (line: string) => void,
): Promise<SharedWorkerProof> {
  return new Promise<SharedWorkerProof>((resolve) => {
    const stages: SharedWorkerProofStage[] = [];
    let methodPresent = false;
    let settled = false;
    let timer = 0;
    let closePort: (() => void) | undefined;
    const startedAt = performance.now();

    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Page-side channel hygiene only — the WORKER reclaims itself (self.close() after the proof
      // settles); closing this port never terminates a SharedWorker.
      closePort?.();
      resolve({ engineClass, methodPresent, stages, verdict: deriveSharedWorkerProofVerdict(stages) });
    };

    /** Record a page-synthesized failure of the stage the worker never finished, then settle. */
    const failHere = (error: string): void => {
      if (settled) return;
      const stage: SharedWorkerProofStage = {
        stage: nextExpectedStage(stages),
        ok: false,
        ms: Math.round(performance.now() - startedAt),
        error,
      };
      stages.push(stage);
      progress(formatStageLine(stage));
      finish();
    };

    const armWatchdog = (): void => {
      clearTimeout(timer);
      timer = setTimeout(
        () => failHere(`no response for ${PROOF_INACTIVITY_MS / 1000}s — SharedWorker unresponsive`),
        PROOF_INACTIVITY_MS,
      ) as unknown as number;
    };

    if (typeof SharedWorker === "undefined") {
      failHere("SharedWorker is not available in this browser");
      return;
    }

    let worker: SharedWorker;
    const runId = crypto.randomUUID().slice(0, 8);
    try {
      // HARD-WON LESSON (mirrors runCell): the `new URL(...)` literal MUST sit INLINE inside the
      // constructor call — hoisting it makes Vite ship the raw .worker.ts as an asset, not a chunk.
      worker = new SharedWorker(new URL("./sharedworker-proof.worker.ts", import.meta.url), {
        type: "module",
        name: `sw-proof-${runId}`,
        extendedLifetime: true,
      } as WorkerOptions & { name: string; extendedLifetime: boolean });
    } catch (error) {
      failHere(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
      return;
    }

    closePort = () => worker.port.close();

    worker.addEventListener("error", () => {
      // A SharedWorker error event carries no message on most engines; the stage attribution is the signal.
      failHere("SharedWorker error event (worker script failed to load or crashed)");
    });

    worker.port.addEventListener("message", (event: MessageEvent<SwProofOutbound>) => {
      if (settled) return; // late messages after a synthesized failure must not mutate the resolved proof
      const message = event.data;
      armWatchdog();
      if (message.type === "begin") {
        methodPresent = message.methodPresent;
        return;
      }
      if (message.type === "stage") {
        stages.push(message.stage);
        progress(formatStageLine(message.stage));
        return;
      }
      finish();
    });

    armWatchdog();
    worker.port.start();
    worker.port.postMessage({ type: "start", storeName: `bench-sw-proof-${runId}` });
  });
}
