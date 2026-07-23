// The ONE `defineSyncWorker` entry the placement lanes use for BOTH worker roles (ADR-0049 step 12, per the
// consumer wiring in `docs/runbooks/0049-engine-placement.md`):
//
//   - as a **SharedWorker** (the attach point / router): the page constructs
//     `new SharedWorker(new URL("./sync.worker.ts", import.meta.url), { type: "module", name, extendedLifetime: true })`.
//     At startup it runs the placement probe and decides its engine home (SW-direct vs elected).
//   - as the **elected dedicated engine `Worker`**: the tab's election coordinator spawns THIS SAME entry as a
//     dedicated `Worker` (via the page's `createEngineWorker` factory), where it holds the OPFS handles and
//     hosts the engine.
//
// `defineSyncWorker`'s `bootstrapWorkerScope` auto-detects which scope it is running in, so a single file serves
// both. `syncEnabled: false` keeps every boot offline — the lanes prove placement, not convergence.

import { defineSyncWorker } from "../../../packages/client/src/index";
import { PLACEMENT_ELECTRIC_URL, PLACEMENT_WRITE_URL, placementRegistry } from "./registry";

defineSyncWorker({
  registry: placementRegistry,
  electricUrl: PLACEMENT_ELECTRIC_URL,
  batchWriteUrl: PLACEMENT_WRITE_URL,
  syncEnabled: false,
  // ADR-0049 capability-driven engine placement is THE behavior — the SharedWorker runs the UNCONDITIONAL probe
  // and decides its home (SW-direct vs elected). `placementRegistry` declares the default `backend: "opfs"`, so
  // these lanes exercise the probe/election path.
  // Durability is registry-declared (ADR-0047); `placementRegistry` declares none, so it resolves to the
  // relaxed default — which is what these placement lanes want.
  // A short fallback sweep only — no server is contacted, so it never actually flushes.
  convergenceIntervalMs: 60_000,
});
