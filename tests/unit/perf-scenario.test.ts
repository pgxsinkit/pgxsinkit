import { describe, expect, it } from "bun:test";

import { computeDefaultConcurrentFlushBudgetMs } from "../performance/support/scenario";

function buildBudgetInputs(overrides: Partial<Parameters<typeof computeDefaultConcurrentFlushBudgetMs>[0]> = {}) {
  return {
    tableCount: 4,
    extraColumnCount: 12,
    localRows: 10_000,
    pendingMutations: 1_000,
    mutationBatchSize: 1,
    readSamples: 200,
    serverWorkers: 4,
    batchesPerWorker: 20,
    mutationsPerBatch: 20,
    seedRowsPerTable: 2_000,
    concurrentPreset: "smoke" as const,
    scenarioKey: "mixed-small-bursts" as const,
    executionMode: "single-process" as const,
    concurrentClients: 3,
    distinctUsers: 2,
    operationsPerClient: 40,
    createProbability: 0.15,
    deleteProbability: 0.1,
    smallBurstMin: 1,
    smallBurstMax: 3,
    mediumBurstMin: 10,
    mediumBurstMax: 16,
    mediumBurstProbability: 0,
    largeBatchSize: 32,
    largeBatchProbability: 0,
    hotPartitionRatio: 0,
    jitterMinMs: 2,
    jitterMaxMs: 10,
    flushMode: "immediate" as const,
    ...overrides,
  };
}

describe("computeDefaultConcurrentFlushBudgetMs", () => {
  it("preserves the smoke floor for the smallest mixed-small-bursts preset", () => {
    expect(computeDefaultConcurrentFlushBudgetMs(buildBudgetInputs())).toBe(320);
  });

  it("raises the budget when same-user fan-in and seeded rows increase", () => {
    const lowContention = computeDefaultConcurrentFlushBudgetMs(
      buildBudgetInputs({
        concurrentPreset: "heavy",
        seedRowsPerTable: 25_000,
        concurrentClients: 10,
        distinctUsers: 10,
        operationsPerClient: 500,
        largeBatchSize: 96,
        mediumBurstMax: 25,
        jitterMinMs: 4,
        jitterMaxMs: 25,
      }),
    );
    const highContention = computeDefaultConcurrentFlushBudgetMs(
      buildBudgetInputs({
        concurrentPreset: "heavy",
        seedRowsPerTable: 25_000,
        concurrentClients: 10,
        distinctUsers: 2,
        operationsPerClient: 500,
        largeBatchSize: 96,
        mediumBurstMax: 25,
        jitterMinMs: 4,
        jitterMaxMs: 25,
      }),
    );

    expect(lowContention).toBe(651);
    expect(highContention).toBe(891);
    expect(highContention).toBeGreaterThan(lowContention);
  });
});
