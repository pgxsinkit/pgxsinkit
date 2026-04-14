import { spawnSync } from "node:child_process";

import {
  concurrentPerfPresetKeys,
  concurrentPerfScenarioKeys,
  type ConcurrentPerfPresetKey,
  type ConcurrentPerfScenarioKey,
} from "../tests/performance/support/scenario";

interface MatrixCaseFailure {
  preset: ConcurrentPerfPresetKey;
  scenario: ConcurrentPerfScenarioKey;
  exitCode: number | null;
}

function main() {
  const presets = readMatrixSelection("PGXSINKIT_PERF_MATRIX_PRESETS", concurrentPerfPresetKeys, "preset");
  const scenarios = readMatrixSelection("PGXSINKIT_PERF_MATRIX_SCENARIOS", concurrentPerfScenarioKeys, "scenario");
  const failFast = readBooleanEnv("PGXSINKIT_PERF_MATRIX_FAIL_FAST", false);
  const failures: MatrixCaseFailure[] = [];

  const cases = presets.flatMap((preset) => scenarios.map((scenario) => ({ preset, scenario })));

  console.log("[performance] Running concurrent test matrix", {
    presets,
    scenarios,
    caseCount: cases.length,
    failFast,
  });

  for (const testCase of cases) {
    console.log("[performance] Starting concurrent matrix case", testCase);
    const result = spawnSync("bun", ["run", "test:performance:concurrent"], {
      env: {
        ...process.env,
        PGXSINKIT_PERF_PRESET: testCase.preset,
        PGXSINKIT_PERF_SCENARIO_KEY: testCase.scenario,
      },
      stdio: "inherit",
    });

    if (result.error) {
      throw result.error;
    }

    if (result.status !== 0) {
      failures.push({
        preset: testCase.preset,
        scenario: testCase.scenario,
        exitCode: result.status,
      });

      if (failFast) {
        break;
      }
    }
  }

  if (failures.length === 0) {
    console.log("[performance] Concurrent test matrix passed", { caseCount: cases.length });
    return;
  }

  throw new Error(
    [
      `Concurrent test matrix failed for ${failures.length} case(s):`,
      ...failures.map(
        (failure) => `- preset=${failure.preset} scenario=${failure.scenario} exitCode=${String(failure.exitCode)}`,
      ),
    ].join("\n"),
  );
}

function readMatrixSelection<const T extends readonly string[]>(
  envName: string,
  allowedValues: T,
  label: string,
): T[number][] {
  const rawValue = process.env[envName];

  if (!rawValue) {
    return [...allowedValues];
  }

  const allowedValueSet = new Set<string>(allowedValues);
  const selectedValues = rawValue
    .split(",")
    .map((value) => value.trim())
    .filter((value, index, allValues) => value.length > 0 && allValues.indexOf(value) === index);

  if (selectedValues.length === 0) {
    return [...allowedValues];
  }

  const invalidValues = selectedValues.filter((value) => !allowedValueSet.has(value));

  if (invalidValues.length > 0) {
    throw new Error(
      `Invalid ${label} value(s) for ${envName}: ${invalidValues.join(", ")}. Allowed: ${allowedValues.join(", ")}`,
    );
  }

  return selectedValues as T[number][];
}

function readBooleanEnv(name: string, fallback: boolean) {
  const rawValue = process.env[name];

  if (!rawValue) {
    return fallback;
  }

  switch (rawValue.toLowerCase()) {
    case "1":
    case "true":
    case "yes":
    case "on":
      return true;
    case "0":
    case "false":
    case "no":
    case "off":
      return false;
    default:
      return fallback;
  }
}

main();
