// The SharedWorker-direct proof verdict (bench phase 0, ADR-0048 open item): the pure derivation the
// page and the JSON envelope rely on. The staged runner itself needs a real browser SharedWorker; what
// is unit-testable is the total stages → verdict function every consumer of the envelope reads.
import { describe, expect, test } from "bun:test";

import { deriveSharedWorkerProofVerdict, type SharedWorkerProofStage } from "../../apps/perf-lab/src/bench/protocol";

function stage(id: SharedWorkerProofStage["stage"], ok: boolean, error?: string): SharedWorkerProofStage {
  return { stage: id, ok, ms: 1, ...(error === undefined ? {} : { error }) };
}

const ALL_OK: SharedWorkerProofStage[] = [
  stage("probe", true),
  stage("boot", true),
  stage("write", true),
  stage("close", true),
  stage("reopen", true),
  stage("verify", true),
  stage("cleanup", true),
];

describe("deriveSharedWorkerProofVerdict", () => {
  test("every stage green is granted-and-persisted", () => {
    expect(deriveSharedWorkerProofVerdict(ALL_OK)).toBe("granted-and-persisted");
  });

  test("a failed probe is denied — the engine refused the SharedWorker grant", () => {
    const stages = [stage("probe", false, "createSyncAccessHandle absent in SharedWorker scope")];
    expect(deriveSharedWorkerProofVerdict(stages)).toBe("denied");
  });

  test("a failure after the grant names the refusing stage", () => {
    const stages = [stage("probe", true), stage("boot", false, "UnknownError: transient")];
    expect(deriveSharedWorkerProofVerdict(stages)).toBe("failed:boot");
    expect(
      deriveSharedWorkerProofVerdict([
        stage("probe", true),
        stage("boot", true),
        stage("write", true),
        stage("close", true),
        stage("reopen", false, "CorruptStoreError: …"),
      ]),
    ).toBe("failed:reopen");
  });

  test("a cleanup failure does not demote a proven verdict — the evidence question is answered", () => {
    const stages = [...ALL_OK.slice(0, 6), stage("cleanup", false, "NoModificationAllowedError")];
    expect(deriveSharedWorkerProofVerdict(stages)).toBe("granted-and-persisted");
  });

  test("a truncated run (worker went silent, no synthesized stage) fails at the first missing stage", () => {
    const stages = [stage("probe", true), stage("boot", true)];
    expect(deriveSharedWorkerProofVerdict(stages)).toBe("failed:write");
  });

  test("no stages at all fails at probe — nothing ran, which is not a denial", () => {
    expect(deriveSharedWorkerProofVerdict([])).toBe("failed:probe");
  });
});
