import { defineSyncWorker } from "../../../packages/client/src/index";
import { PLACEMENT_ELECTRIC_URL, PLACEMENT_WRITE_URL, placementRegistry } from "./registry";

// Dedicated entry for the opt-in execution-limit lane. Keeping the general placement worker unlimited avoids
// mis-wiring SW-direct browsers: ADR-0049 D5 permits this construction value only on elected placement.
defineSyncWorker({
  registry: placementRegistry,
  electricUrl: PLACEMENT_ELECTRIC_URL,
  batchWriteUrl: PLACEMENT_WRITE_URL,
  syncEnabled: false,
  convergenceIntervalMs: 60_000,
  executionLimit: { maxDispatchMs: 1_000 },
});
