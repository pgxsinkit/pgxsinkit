// The SERVER-LANE worker entry (ADR-0049 step 12): unlike `sync.worker.ts` (serverless, `syncEnabled:false`),
// this one boots the REAL sync engine against the fixture server — the control-plane, edge and write-API URLs
// are baked at vite build time from the launcher's env (`VITE_PLACEMENT_CONTROL_PLANE_URL` /
// `VITE_PLACEMENT_STREAM_BASE_URL` / `VITE_PLACEMENT_WRITE_URL`).
// It syncs the standalone `fk_parents` table (`fkSyncRegistry`). Serves BOTH the router SharedWorker and the
// elected dedicated engine, exactly like `sync.worker.ts`. Only instantiated by the SERVER lanes (which skip when
// `PLACEMENT_SERVER_URL` is absent), so its dummy default URLs in the serverless build are never contacted.

import { fkSyncRegistry } from "@pgxsinkit/schema";

import { defineSyncWorker } from "../../../packages/client/src/index";

const env =
  (
    import.meta as unknown as {
      env?: {
        VITE_PLACEMENT_CONTROL_PLANE_URL?: string;
        VITE_PLACEMENT_STREAM_BASE_URL?: string;
        VITE_PLACEMENT_WRITE_URL?: string;
      };
    }
  ).env ?? {};

defineSyncWorker({
  registry: fkSyncRegistry,
  controlPlaneUrl: env.VITE_PLACEMENT_CONTROL_PLANE_URL ?? "http://127.0.0.1:4299",
  streamBaseUrl: env.VITE_PLACEMENT_STREAM_BASE_URL ?? "http://127.0.0.1:4299/v1/stream",
  batchWriteUrl: env.VITE_PLACEMENT_WRITE_URL ?? "http://127.0.0.1:4299/api/mutations",
  syncEnabled: true,
  // Capability placement is THE behavior (ADR-0049 D1) — the server lanes exercise the elected engine +
  // succession/relocation path via the unconditional probe (`placementRegistry` declares the default `opfs`).
  // Prompt convergence sweeps so a drained journal reaches the server quickly once writes are un-refused.
  convergenceIntervalMs: 2_000,
});
