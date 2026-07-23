import { describe, expect, it } from "bun:test";

import {
  ENGINE_RELOCATED_CODE,
  EngineRelocatedError,
  ExecutionLimitMismatchError,
  retireSyncWorkerHost,
  StoreDestroyRefusedError,
  wrapEngineWorker,
  type ElectedEngineWorker,
  type EngineRelocatedOutcome,
  type ExecutionLimitConfig,
} from "../../packages/client/src/index";

describe("public engine-placement surface", () => {
  it("is reachable from the package root", () => {
    const outcome: EngineRelocatedOutcome = "not-dispatched";
    const limit: ExecutionLimitConfig = { maxDispatchMs: 1_000 };
    const worker: ElectedEngineWorker = wrapEngineWorker({
      postMessage: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      terminate: () => undefined,
    });

    expect(ENGINE_RELOCATED_CODE).toBe("engine-relocated");
    expect(new EngineRelocatedError(outcome).outcome).toBe(outcome);
    expect(new ExecutionLimitMismatchError(limit.maxDispatchMs, undefined)).toBeInstanceOf(Error);
    expect(new StoreDestroyRefusedError(2)).toBeInstanceOf(Error);
    expect(typeof retireSyncWorkerHost).toBe("function");
    expect(typeof worker.terminate).toBe("function");
  });
});
