import { runConcurrentMixedLoadScenario } from "./support/concurrent-mixed-load";
import {
  assertPerfBudgets,
  computePercentiles,
  evaluatePerfBudget,
  readPerfScenarioConfig,
  writePerfReport,
} from "./support/scenario";

describe("performance: client concurrent mixed load", () => {
  it(
    "handles overlapping multi-client traffic end to end",
    async () => {
      const config = readPerfScenarioConfig();
      const startedAt = new Date().toISOString();
      const result = await runConcurrentMixedLoadScenario(config);
      const enqueueLatencyMs = computePercentiles(result.enqueueTimingsMs);
      const flushLatencyMs = computePercentiles(result.flushTimingsMs);
      const convergenceLatencyMs = computePercentiles(result.convergenceTimingsMs);
      const durationSeconds = Math.max(1, result.durationMs / 1000);
      const budgetResults = [
        evaluatePerfBudget("concurrent enqueue p95", enqueueLatencyMs.p95, config.budgets.concurrentEnqueueP95MaxMs),
        evaluatePerfBudget("concurrent flush p95", flushLatencyMs.p95, config.budgets.concurrentFlushP95MaxMs),
        evaluatePerfBudget(
          "concurrent convergence p95",
          convergenceLatencyMs.p95,
          config.budgets.concurrentConvergenceP95MaxMs,
        ),
      ];

      expect(result.totalOperations).toBe(config.concurrentClients * config.operationsPerClient);
      expect(result.failedFlushCount).toBe(0);
      expect(result.nonConvergedClientCount).toBe(0);

      if (config.createProbability > 0) {
        expect(result.createMutations).toBeGreaterThan(0);
      }

      if (config.deleteProbability > 0) {
        expect(result.deleteMutations).toBeGreaterThan(0);
      }

      const reportPath = await writePerfReport({
        name: `client-concurrent-${config.scenarioKey}`,
        startedAt,
        finishedAt: new Date().toISOString(),
        config,
        metrics: {
          scenarioKey: result.scenarioKey,
          concurrentPreset: result.concurrentPreset,
          executionMode: config.executionMode,
          registryTableNames: result.registryTableNames,
          concurrentClients: config.concurrentClients,
          distinctUsers: config.distinctUsers,
          totalOperations: result.totalOperations,
          totalMutations: result.totalMutations,
          createMutations: result.createMutations,
          updateMutations: result.updateMutations,
          deleteMutations: result.deleteMutations,
          completedFlushes: result.completedFlushes,
          acknowledgedMutations: result.acknowledgedMutations,
          flushesPerSecond: result.completedFlushes / durationSeconds,
          acknowledgementsPerSecond: result.acknowledgedMutations / durationSeconds,
          enqueueLatencyMs,
          flushLatencyMs,
          convergenceLatencyMs,
          batchSizeHistogram: result.batchSizeHistogram,
          failedFlushCount: result.failedFlushCount,
          retryCount: result.retryCount,
          mutationFallbackCount: result.mutationFallbackCount,
          skippedDeleteCount: result.skippedDeleteCount,
          nonConvergedClientCount: result.nonConvergedClientCount,
          perClient: result.perClient,
          finalDiagnostics: result.finalDiagnostics,
          budgetResults,
        },
      });

      console.log("[perf] client-concurrent-mixed-load report", {
        reportPath,
        scenarioKey: config.scenarioKey,
        preset: config.concurrentPreset,
        executionMode: config.executionMode,
      });

      assertPerfBudgets(budgetResults);
    },
    20 * 60_000,
  );
});
