// The SharedWorker startup PLACEMENT DECISION (ADR-0049 decision 1/2, plan step 10b). A SharedWorker decides
// its ENGINE HOME by running the placement probe (`placement-probe.ts`) ONCE at startup — a real
// `createSyncAccessHandle` open in its own scope — and turns the probe's verdict into a placement result the
// bootstrap gates every tab connection on. Granted → the engine lives IN the SharedWorker (`shared-worker`,
// SW-direct, election disabled this lifetime); denied → the SharedWorker is ROUTER-ONLY (`elected-worker`) and
// each tab's election coordinator spawns the real engine in a dedicated worker.
//
// This module is the PURE decision only — it boots NO engine and creates NO router. It is testable off-worker
// (no real OPFS) via the injectable `probe`/`mintInstanceId` seams, the same discipline `placement-probe.ts`,
// `engine-router.ts`, and `election-coordinator.ts` follow. The probe is NEVER cached across SW lifetimes
// (invariant 8): a fresh SharedWorker runs a fresh decision.

import { type PlacementProbeResult, probeOpfsSyncAccess } from "../placement-probe";

/**
 * The SharedWorker's engine-home decision (ADR-0049 D1). `shared-worker` = the engine boots in this
 * SharedWorker scope (granted OPFS sync access, SW-direct, election never engages); `elected-worker` = the
 * SharedWorker is router-only and each tab elects a dedicated engine worker. `probeError` carries the probe's
 * verbatim denial attribution when NOT granted (diagnostics only, never parsed). `swInstanceId` scopes every
 * minted engine identity's generation (`engine-router.ts`).
 */
export interface SwPlacementResult {
  engineHome: "shared-worker" | "elected-worker";
  probeError?: string;
  swInstanceId: string;
  /**
   * Present ONLY on a `shared-worker` home that is a CAPABILITY-ABSENCE fallback (ADR-0049 D1), not an OPFS
   * grant: the platform cannot hold sync-access handles in any home, so the engine boots in-SharedWorker on the
   * IDBFS backend with the registry-declared durability. Carries the verbatim probe attribution the fallback
   * boot stamps into `storageFallbackReason` (decision 12). Absent on a granted `shared-worker` (SW-direct OPFS)
   * and on `elected-worker` — an OPFS-capable elected home is not a fallback.
   */
  storageFallbackReason?: string;
}

/** Injectable seams so the decision is deterministic in a Bun unit test (no real OPFS, no real crypto needed). */
export interface DecideSwPlacementDeps {
  /** The placement probe; defaults to {@link probeOpfsSyncAccess}. Injected in tests to drive both verdicts. */
  probe?: () => Promise<PlacementProbeResult>;
  /** Mint the opaque SharedWorker instance id; defaults to `crypto.randomUUID()`. Injected for deterministic tests. */
  mintInstanceId?: () => string;
}

/**
 * Decide the SharedWorker's engine home ONCE at startup (ADR-0049 D1, invariant 8 — probe per boot, never
 * cached). Runs the placement probe; a granted verdict places the engine in-scope (`shared-worker`), a denied
 * one puts the SharedWorker in router-only mode (`elected-worker`) and carries the probe's verbatim error for
 * diagnostics. This is a PURE decision — no engine boots and no router is created here; the bootstrap
 * (`define-sync-worker.ts`) acts on the result.
 */
export async function decideSwPlacement(deps?: DecideSwPlacementDeps): Promise<SwPlacementResult> {
  const probe = deps?.probe ?? probeOpfsSyncAccess;
  const mintInstanceId = deps?.mintInstanceId ?? (() => crypto.randomUUID());
  const swInstanceId = mintInstanceId();
  const result = await probe();
  if (result.granted) {
    return { engineHome: "shared-worker", swInstanceId };
  }
  return {
    engineHome: "elected-worker",
    swInstanceId,
    ...(result.error !== undefined ? { probeError: result.error } : {}),
  };
}
