import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export const concurrentPerfScenarioKeys = [
  "mixed-small-bursts",
  "mixed-small-plus-large",
  "hot-partition-overlap",
] as const;
export const concurrentPerfPresetKeys = ["smoke", "realistic", "heavy"] as const;
export const concurrentPerfExecutionModes = ["single-process", "multi-process"] as const;

export type ConcurrentPerfScenarioKey = (typeof concurrentPerfScenarioKeys)[number];
export type ConcurrentPerfPresetKey = (typeof concurrentPerfPresetKeys)[number];
export type ConcurrentPerfExecutionMode = (typeof concurrentPerfExecutionModes)[number];

export interface ConcurrentPerfDefaults {
  seedRowsPerTable: number;
  concurrentClients: number;
  distinctUsers: number;
  operationsPerClient: number;
  createProbability: number;
  deleteProbability: number;
  smallBurstMin: number;
  smallBurstMax: number;
  mediumBurstMin: number;
  mediumBurstMax: number;
  mediumBurstProbability: number;
  largeBatchSize: number;
  largeBatchProbability: number;
  hotPartitionRatio: number;
  jitterMinMs: number;
  jitterMaxMs: number;
  flushMode: "immediate";
}

const concurrentPresetDefaults: Record<ConcurrentPerfPresetKey, ConcurrentPerfDefaults> = {
  smoke: {
    seedRowsPerTable: 2_000,
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
    hotPartitionRatio: 0.05,
    jitterMinMs: 2,
    jitterMaxMs: 10,
    flushMode: "immediate",
  },
  realistic: {
    seedRowsPerTable: 5_000,
    concurrentClients: 10,
    distinctUsers: 10,
    operationsPerClient: 220,
    createProbability: 0.2,
    deleteProbability: 0.1,
    smallBurstMin: 1,
    smallBurstMax: 3,
    mediumBurstMin: 10,
    mediumBurstMax: 25,
    mediumBurstProbability: 0.1,
    largeBatchSize: 64,
    largeBatchProbability: 0.02,
    hotPartitionRatio: 0.1,
    jitterMinMs: 4,
    jitterMaxMs: 20,
    flushMode: "immediate",
  },
  heavy: {
    seedRowsPerTable: 25_000,
    concurrentClients: 10,
    distinctUsers: 10,
    operationsPerClient: 500,
    createProbability: 0.25,
    deleteProbability: 0.15,
    smallBurstMin: 1,
    smallBurstMax: 3,
    mediumBurstMin: 10,
    mediumBurstMax: 25,
    mediumBurstProbability: 0.12,
    largeBatchSize: 96,
    largeBatchProbability: 0.03,
    hotPartitionRatio: 0.2,
    jitterMinMs: 4,
    jitterMaxMs: 25,
    flushMode: "immediate",
  },
};

const concurrentScenarioOverrides: Record<ConcurrentPerfScenarioKey, Partial<ConcurrentPerfDefaults>> = {
  "mixed-small-bursts": {
    mediumBurstProbability: 0,
    largeBatchProbability: 0,
    hotPartitionRatio: 0,
    createProbability: 0.15,
    deleteProbability: 0.1,
  },
  "mixed-small-plus-large": {
    mediumBurstProbability: 0.1,
    largeBatchProbability: 0.02,
    hotPartitionRatio: 0,
    createProbability: 0.2,
    deleteProbability: 0.1,
  },
  "hot-partition-overlap": {
    mediumBurstProbability: 0.15,
    largeBatchProbability: 0,
    hotPartitionRatio: 0.1,
    createProbability: 0.1,
    deleteProbability: 0.05,
  },
};

const concurrentSmokeBudgetFloors = {
  enqueueP95MaxMs: 60,
  flushP95MaxMs: 320,
  convergenceP95MaxMs: 600,
} as const;

export interface PerfScenarioConfig {
  tableCount: number;
  extraColumnCount: number;
  localRows: number;
  pendingMutations: number;
  mutationBatchSize: number;
  readSamples: number;
  serverWorkers: number;
  batchesPerWorker: number;
  mutationsPerBatch: number;
  seedRowsPerTable: number;
  concurrentPreset: ConcurrentPerfPresetKey;
  scenarioKey: ConcurrentPerfScenarioKey;
  executionMode: ConcurrentPerfExecutionMode;
  concurrentClients: number;
  distinctUsers: number;
  operationsPerClient: number;
  createProbability: number;
  deleteProbability: number;
  smallBurstMin: number;
  smallBurstMax: number;
  mediumBurstMin: number;
  mediumBurstMax: number;
  mediumBurstProbability: number;
  largeBatchSize: number;
  largeBatchProbability: number;
  hotPartitionRatio: number;
  jitterMinMs: number;
  jitterMaxMs: number;
  flushMode: "immediate";
  budgets: PerfBudgetConfig;
}

export interface PerfBudgetConfig {
  clientMutationP95MaxMs: number;
  clientReadP95MaxMs: number;
  serverBatchP95MaxMs: number;
  concurrentEnqueueP95MaxMs: number;
  concurrentFlushP95MaxMs: number;
  concurrentConvergenceP95MaxMs: number;
}

export interface PerfBudgetResult {
  label: string;
  actualMs: number;
  maxMs: number;
  passed: boolean;
}

export interface PerfReport {
  name: string;
  startedAt: string;
  finishedAt: string;
  config: PerfScenarioConfig | Record<string, unknown>;
  metrics: Record<string, unknown>;
}

type PerfScenarioBudgetInputs = Omit<PerfScenarioConfig, "budgets">;

export function computeDefaultConcurrentFlushBudgetMs(baseConfig: PerfScenarioBudgetInputs): number {
  const largestExpectedBurst = Math.max(baseConfig.mediumBurstMax, baseConfig.largeBatchSize, baseConfig.smallBurstMax);
  const smokeFlushBudgetFloor = baseConfig.concurrentPreset === "smoke" ? concurrentSmokeBudgetFloors.flushP95MaxMs : 0;
  const sameUserContention = Math.max(0, baseConfig.concurrentClients - baseConfig.distinctUsers);
  const seededRowPressure = Math.ceil(Math.max(0, baseConfig.seedRowsPerTable - 2_000) / 10_000);

  return Math.max(
    smokeFlushBudgetFloor,
    120 +
      largestExpectedBurst * 3.5 +
      baseConfig.concurrentClients * 10 +
      baseConfig.tableCount * 5 +
      sameUserContention * 30 +
      seededRowPressure * 25,
  );
}

export function readPerfScenarioConfig(): PerfScenarioConfig {
  const concurrentPreset = resolveConcurrentPresetKey(process.env["PGXSINKIT_PERF_PRESET"]);
  const scenarioKey = resolveConcurrentScenarioKey(process.env["PGXSINKIT_PERF_SCENARIO_KEY"]);
  const executionMode = resolveConcurrentExecutionMode(process.env["PGXSINKIT_PERF_CONCURRENT_EXEC_MODE"]);
  const concurrentDefaults = {
    ...concurrentPresetDefaults[concurrentPreset],
    ...concurrentScenarioOverrides[scenarioKey],
  };
  const baseConfig = {
    tableCount: readPositiveIntEnv("PGXSINKIT_PERF_TABLE_COUNT", 4),
    extraColumnCount: readPositiveIntEnv("PGXSINKIT_PERF_EXTRA_COLUMNS", 12),
    localRows: readPositiveIntEnv("PGXSINKIT_PERF_LOCAL_ROWS", 10_000),
    pendingMutations: readPositiveIntEnv("PGXSINKIT_PERF_PENDING_MUTATIONS", 1_000),
    mutationBatchSize: readPositiveIntEnv("PGXSINKIT_PERF_MUTATION_BATCH_SIZE", 1),
    readSamples: readPositiveIntEnv("PGXSINKIT_PERF_READ_SAMPLES", 200),
    serverWorkers: readPositiveIntEnv("PGXSINKIT_PERF_SERVER_WORKERS", 4),
    batchesPerWorker: readPositiveIntEnv("PGXSINKIT_PERF_BATCHES_PER_WORKER", 20),
    mutationsPerBatch: readPositiveIntEnv("PGXSINKIT_PERF_MUTATIONS_PER_BATCH", 20),
    seedRowsPerTable: readPositiveIntEnv("PGXSINKIT_PERF_SEED_ROWS_PER_TABLE", concurrentDefaults.seedRowsPerTable),
    concurrentPreset,
    scenarioKey,
    executionMode,
    concurrentClients: readPositiveIntEnv("PGXSINKIT_PERF_CONCURRENT_CLIENTS", concurrentDefaults.concurrentClients),
    distinctUsers: readPositiveIntEnv("PGXSINKIT_PERF_DISTINCT_USERS", concurrentDefaults.distinctUsers),
    operationsPerClient: readPositiveIntEnv(
      "PGXSINKIT_PERF_OPERATIONS_PER_CLIENT",
      concurrentDefaults.operationsPerClient,
    ),
    createProbability: readProbabilityEnv("PGXSINKIT_PERF_CREATE_PROBABILITY", concurrentDefaults.createProbability),
    deleteProbability: readProbabilityEnv("PGXSINKIT_PERF_DELETE_PROBABILITY", concurrentDefaults.deleteProbability),
    smallBurstMin: readPositiveIntEnv("PGXSINKIT_PERF_SMALL_BURST_MIN", concurrentDefaults.smallBurstMin),
    smallBurstMax: readPositiveIntEnv("PGXSINKIT_PERF_SMALL_BURST_MAX", concurrentDefaults.smallBurstMax),
    mediumBurstMin: readPositiveIntEnv("PGXSINKIT_PERF_MEDIUM_BURST_MIN", concurrentDefaults.mediumBurstMin),
    mediumBurstMax: readPositiveIntEnv("PGXSINKIT_PERF_MEDIUM_BURST_MAX", concurrentDefaults.mediumBurstMax),
    mediumBurstProbability: readProbabilityEnv(
      "PGXSINKIT_PERF_MEDIUM_BURST_PROBABILITY",
      concurrentDefaults.mediumBurstProbability,
    ),
    largeBatchSize: readPositiveIntEnv("PGXSINKIT_PERF_LARGE_BATCH_SIZE", concurrentDefaults.largeBatchSize),
    largeBatchProbability: readProbabilityEnv(
      "PGXSINKIT_PERF_LARGE_BATCH_PROBABILITY",
      concurrentDefaults.largeBatchProbability,
    ),
    hotPartitionRatio: readProbabilityEnv("PGXSINKIT_PERF_HOT_PARTITION_RATIO", concurrentDefaults.hotPartitionRatio),
    jitterMinMs: readPositiveIntEnv("PGXSINKIT_PERF_JITTER_MIN_MS", concurrentDefaults.jitterMinMs),
    jitterMaxMs: readPositiveIntEnv("PGXSINKIT_PERF_JITTER_MAX_MS", concurrentDefaults.jitterMaxMs),
    flushMode: concurrentDefaults.flushMode,
  };

  const largestExpectedBurst = Math.max(baseConfig.mediumBurstMax, baseConfig.largeBatchSize, baseConfig.smallBurstMax);
  const smokeEnqueueBudgetFloor =
    baseConfig.concurrentPreset === "smoke" ? concurrentSmokeBudgetFloors.enqueueP95MaxMs : 0;
  const smokeConvergenceBudgetFloor =
    baseConfig.concurrentPreset === "smoke" ? concurrentSmokeBudgetFloors.convergenceP95MaxMs : 0;
  const nonSmokeEnqueueBudgetFloor = baseConfig.concurrentPreset === "smoke" ? 0 : 100;

  return {
    ...baseConfig,
    budgets: {
      clientMutationP95MaxMs: readPositiveFloatEnv(
        "PGXSINKIT_PERF_CLIENT_MUTATION_P95_MAX_MS",
        12 +
          baseConfig.extraColumnCount * 0.4 +
          Math.ceil(baseConfig.localRows / 25_000) * 4 +
          Math.ceil(baseConfig.pendingMutations / 5_000) * 2,
      ),
      clientReadP95MaxMs: readPositiveFloatEnv(
        "PGXSINKIT_PERF_CLIENT_READ_P95_MAX_MS",
        2 +
          baseConfig.extraColumnCount * 0.08 +
          Math.ceil(baseConfig.localRows / 25_000) * 0.8 +
          Math.ceil(baseConfig.pendingMutations / 5_000) * 0.4,
      ),
      serverBatchP95MaxMs: readPositiveFloatEnv(
        "PGXSINKIT_PERF_SERVER_BATCH_P95_MAX_MS",
        80 +
          baseConfig.mutationsPerBatch * 2.5 +
          baseConfig.serverWorkers * 6 +
          baseConfig.extraColumnCount * 1.2 +
          baseConfig.tableCount * 5,
      ),
      concurrentEnqueueP95MaxMs: readPositiveFloatEnv(
        "PGXSINKIT_PERF_CONCURRENT_ENQUEUE_P95_MAX_MS",
        Math.max(
          smokeEnqueueBudgetFloor,
          nonSmokeEnqueueBudgetFloor,
          15 + largestExpectedBurst * 0.35 + baseConfig.extraColumnCount * 0.25 + baseConfig.concurrentClients * 1.5,
        ),
      ),
      concurrentFlushP95MaxMs: readPositiveFloatEnv(
        "PGXSINKIT_PERF_CONCURRENT_FLUSH_P95_MAX_MS",
        computeDefaultConcurrentFlushBudgetMs(baseConfig),
      ),
      concurrentConvergenceP95MaxMs: readPositiveFloatEnv(
        "PGXSINKIT_PERF_CONCURRENT_CONVERGENCE_P95_MAX_MS",
        Math.max(
          smokeConvergenceBudgetFloor,
          200 +
            largestExpectedBurst * 2.5 +
            baseConfig.concurrentClients * 12 +
            Math.ceil(baseConfig.seedRowsPerTable / 10_000) * 40,
        ),
      ),
    },
  };
}

export function computePercentiles(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right);

  return {
    p50: pickPercentile(sorted, 0.5),
    p95: pickPercentile(sorted, 0.95),
    p99: pickPercentile(sorted, 0.99),
  };
}

export async function writePerfReport(report: PerfReport): Promise<string> {
  const resultsDir = process.env["PGXSINKIT_PERF_RESULTS_DIR"] ?? "tmp/perf-results";
  const absoluteDir = path.isAbsolute(resultsDir) ? resultsDir : path.join(process.cwd(), resultsDir);
  await mkdir(absoluteDir, { recursive: true });

  const filePath = path.join(absoluteDir, `${report.name}-${Date.now()}.json`);
  await writeFile(filePath, JSON.stringify(report, null, 2), "utf8");
  return filePath;
}

export function evaluatePerfBudget(label: string, actualMs: number, maxMs: number): PerfBudgetResult {
  return {
    label,
    actualMs,
    maxMs,
    passed: actualMs <= maxMs,
  };
}

export function assertPerfBudgets(results: PerfBudgetResult[]) {
  const failures = results.filter((result) => !result.passed);

  if (failures.length === 0) {
    return;
  }

  throw new Error(
    [
      "Performance budgets failed:",
      ...failures.map(
        (failure) =>
          `- ${failure.label}: actual ${failure.actualMs.toFixed(2)} ms exceeded budget ${failure.maxMs.toFixed(2)} ms`,
      ),
    ].join("\n"),
  );
}

function pickPercentile(values: number[], percentile: number): number {
  if (values.length === 0) {
    return 0;
  }

  const index = Math.min(values.length - 1, Math.floor(values.length * percentile));
  return values[index] ?? values[values.length - 1] ?? 0;
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const rawValue = process.env[name];

  if (!rawValue) {
    return fallback;
  }

  const parsed = Number.parseInt(rawValue, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function readPositiveFloatEnv(name: string, fallback: number): number {
  const rawValue = process.env[name];

  if (!rawValue) {
    return fallback;
  }

  const parsed = Number.parseFloat(rawValue);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readProbabilityEnv(name: string, fallback: number): number {
  const rawValue = process.env[name];

  if (!rawValue) {
    return fallback;
  }

  const parsed = Number.parseFloat(rawValue);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : fallback;
}

function resolveConcurrentPresetKey(rawValue: string | undefined): ConcurrentPerfPresetKey {
  switch (rawValue) {
    case "smoke":
    case "heavy":
    case "realistic":
      return rawValue;
    default:
      return "realistic";
  }
}

function resolveConcurrentScenarioKey(rawValue: string | undefined): ConcurrentPerfScenarioKey {
  switch (rawValue) {
    case "mixed-small-bursts":
    case "mixed-small-plus-large":
    case "hot-partition-overlap":
      return rawValue;
    default:
      return "mixed-small-bursts";
  }
}

function resolveConcurrentExecutionMode(rawValue: string | undefined): ConcurrentPerfExecutionMode {
  switch (rawValue) {
    case "multi-process":
    case "single-process":
      return rawValue;
    default:
      return "single-process";
  }
}
