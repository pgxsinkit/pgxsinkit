import { describe, expect, it } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sql";

import { readIntegrationEnv } from "@pgxsinkit/test-utils";

import { readRlsReadConfig, runRlsReadLoad } from "./support/rls-read-load";
import { assertPerfBudgets, evaluatePerfBudget, writePerfReport } from "./support/scenario";

const env = readIntegrationEnv();

// RLS read-load: measures the cost of RLS-governed reads at scale for the membership-fanout and
// JWT grant-scope authorization shapes, three ways each (baseline / Electric shape-query / direct-read
// RLS) across {InitPlan-correct, naive} × {with index, without index}. The hard budget is the correct,
// indexed RLS p95 — the path a direct-read endpoint actually takes; the naive and no-index lines, plus
// the cliff / index-speedup / RLS-vs-shape ratios, are reported (and EXPLAIN ANALYZE captured) so the
// suite both regression-guards the fast path and demonstrates why it is fast.
describe("performance: RLS read load", () => {
  it(
    "measures RLS read cost across baseline / shape-query / RLS × {correct, naive} × {index, no-index}",
    async () => {
      const config = readRlsReadConfig();
      const startedAt = new Date().toISOString();
      const db = drizzle({ connection: env.databaseUrl });

      try {
        const { scenarios } = await runRlsReadLoad(db, config);

        const budgetResults = scenarios.map((scenario) => {
          const correctIndexed = scenario.modes.find((mode) => mode.mode === "rls-correct" && mode.indexed);
          return evaluatePerfBudget(
            `${scenario.scenario} rls-correct indexed p95`,
            correctIndexed?.latencyMs.p95 ?? Number.POSITIVE_INFINITY,
            config.rlsP95MaxMs,
          );
        });

        const reportPath = await writePerfReport({
          name: "rls-read-load",
          startedAt,
          finishedAt: new Date().toISOString(),
          config: { ...config },
          metrics: { scenarios },
        });

        for (const scenario of scenarios) {
          console.log(`[perf] rls-read-load ${scenario.scenario}`, {
            visibleRowEstimate: scenario.visibleRowEstimate,
            cliffRatioP95: round(scenario.cliffRatioP95),
            indexSpeedupP95: round(scenario.indexSpeedupP95),
            // Each RLS variant's indexed p95 as a multiple of the Electric shape query (1.0 = as fast).
            // rls-anyarray / rls-fnrows are the planner-guiding experiments; ~1 means they close the gap.
            vsShapeP95: Object.fromEntries(
              Object.entries(scenario.vsShapeP95).map(([mode, ratio]) => [mode, round(ratio)]),
            ),
            modes: scenario.modes.map((mode) => ({
              mode: mode.mode,
              indexed: mode.indexed,
              p95: round(mode.latencyMs.p95),
              rows: mode.rowsReturned,
              ...(mode.timedOut ? { timedOut: true } : {}),
            })),
          });
        }

        console.log("[perf] rls-read-load report", { reportPath });
        // Correctness gate: every RLS variant (correct / naive / the anyarray / fnrows experiments) must
        // return the SAME non-empty visible set as the privileged shape query — otherwise a rewrite changed
        // the authorization, and any speed comparison is meaningless.
        for (const scenario of scenarios) {
          const shapeIndexed = scenario.modes.find((mode) => mode.mode === "shape-query" && mode.indexed);
          expect(shapeIndexed?.rowsReturned).toBeGreaterThan(0);
          const rlsIndexed = scenario.modes.filter((mode) => mode.mode.startsWith("rls-") && mode.indexed);
          for (const mode of rlsIndexed) {
            expect(mode.rowsReturned).toBe(shapeIndexed?.rowsReturned ?? -1);
          }
        }

        assertPerfBudgets(budgetResults);
      } finally {
        await db.$client.close();
      }
    },
    20 * 60_000,
  );
});

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
