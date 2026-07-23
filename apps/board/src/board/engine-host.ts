// Where the board hosts its sync engine (ADR-0032). The board is idb-only: when the browser has `SharedWorker`
// the engine runs in a per-store SharedWorker; otherwise it falls back to the main-thread in-process engine
// (ADR-0032 decision 2). There is no OPFS hosting path.

/** The two board engine hosts: the shared-worker engine, or the in-process fallback. */
export type EngineHost = "shared" | "in-process";

/**
 * The PURE hosting decision (ADR-0032) — injectable so it is unit-reasonable off-browser. With `SharedWorker`
 * the engine runs in a shared worker; absent it, the in-process fallback wins.
 */
export function resolveEngineHost(hasSharedWorker: boolean): EngineHost {
  return hasSharedWorker ? "shared" : "in-process";
}

/**
 * The board's hosting decision for THIS page, resolved once at module load. Consumed by store-registry-default
 * (which port/worker to construct).
 */
export const boardEngineHost: EngineHost = resolveEngineHost(typeof SharedWorker !== "undefined");

/** True when this browser hosts the engine off-tab (shared worker) — the not-in-process gate. */
export const boardWorkerMode = boardEngineHost !== "in-process";
