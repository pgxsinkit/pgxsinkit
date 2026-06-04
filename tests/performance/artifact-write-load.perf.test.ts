import { performance } from "node:perf_hooks";

import { sql } from "drizzle-orm";

import { DEMO_JWT_USER1, DEMO_JWT_USER2 } from "@pgxsinkit/schema";
import { createSyncServer } from "@pgxsinkit/server";
import { createServerDb, readIntegrationEnv } from "@pgxsinkit/test-utils";

import { parseDemoAuthClaimsFromRequest } from "../../apps/write-api/src/demo-auth";
import {
  installPlpgsqlBatchFunction,
  verifyPlpgsqlBatchFunction,
} from "../../packages/server/src/mutations/bulk/plpgsql-strategy";
import {
  assertPerfBudgets,
  computePercentiles,
  evaluatePerfBudget,
  readPerfScenarioConfig,
  writePerfReport,
} from "./support/scenario";
import {
  buildSyntheticCreatePayload,
  buildSyntheticGovernanceSql,
  buildSyntheticRegistry,
  buildSyntheticServerSchemaSql,
  buildSyntheticUpdatePatch,
} from "./support/synthetic-registry";

const env = readIntegrationEnv();

describe("performance: artifact write load", () => {
  it(
    "handles concurrent same-user and different-user mutation pressure",
    async () => {
      const config = readPerfScenarioConfig();
      const startedAt = new Date().toISOString();
      const { registry, tableNames } = buildSyntheticRegistry({
        tableCount: config.tableCount,
        extraColumnCount: config.extraColumnCount,
      });

      const serverDb = createServerDb(registry, env.databaseUrl);

      const provisioningServer = createSyncServer({
        registry,
        db: serverDb.db,
      });

      try {
        await provisioningServer.drizzle.execute(sql.raw(buildSyntheticServerSchemaSql(registry)));
        await provisioningServer.drizzle.execute(sql.raw(buildSyntheticGovernanceSql(registry)));
        await installPlpgsqlBatchFunction(provisioningServer.drizzle, registry);
        await verifyPlpgsqlBatchFunction(provisioningServer.drizzle);
      } finally {
        await provisioningServer.stop();
      }

      const server = createSyncServer({
        registry,
        db: serverDb.db,
        backend: "bulk-plpgsql-artifact",
        resolveAuthClaims: (request) => {
          const claims = parseDemoAuthClaimsFromRequest(request);
          return claims ? { ...claims } : null;
        },
      });

      try {
        const timings: number[] = [];
        const tokens = [DEMO_JWT_USER1, DEMO_JWT_USER1, DEMO_JWT_USER2, DEMO_JWT_USER2];

        await Promise.all(
          Array.from({ length: config.serverWorkers }, async (_, workerIndex) => {
            const authToken = tokens[workerIndex % tokens.length]!;

            for (let batchIndex = 0; batchIndex < config.batchesPerWorker; batchIndex += 1) {
              const started = performance.now();
              const mutations = Array.from({ length: config.mutationsPerBatch }, (_, mutationIndex) => {
                const tableIndex = mutationIndex % tableNames.length;
                const tableName = tableNames[tableIndex]!;
                const entityIndex = workerIndex * config.mutationsPerBatch + mutationIndex;
                const entityKey = {
                  id: buildSyntheticCreatePayload(tableIndex, entityIndex, config.extraColumnCount).id as string,
                };
                const isCreate = batchIndex === 0;
                const eventIndex =
                  workerIndex * config.batchesPerWorker * config.mutationsPerBatch +
                  batchIndex * config.mutationsPerBatch +
                  mutationIndex;

                return {
                  tableName,
                  entityKey,
                  mutationId: `${workerIndex.toString().padStart(8, "0")}-0000-4000-8000-${eventIndex.toString().padStart(12, "0")}`,
                  mutationSeq: batchIndex * config.mutationsPerBatch + mutationIndex + 1,
                  kind: isCreate ? "create" : "update",
                  payload: isCreate
                    ? buildSqlPayload(buildSyntheticCreatePayload(tableIndex, entityIndex, config.extraColumnCount))
                    : buildSqlPayload(buildSyntheticUpdatePatch(entityIndex, config.extraColumnCount)),
                  clientTimestampUs: String(1_700_000_000_000_000 + eventIndex),
                };
              });

              const response = await server.request("/api/mutations", {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Authorization: `Bearer ${authToken}`,
                },
                body: JSON.stringify({ mutations }),
              });

              if (response.status !== 200) {
                console.error("[perf] artifact-write-load failed response", await response.text());
              }

              expect(response.status).toBe(200);
              timings.push(performance.now() - started);
            }
          }),
        );

        const batchLatencyMs = computePercentiles(timings);
        const budgetResults = [
          evaluatePerfBudget("artifact batch p95", batchLatencyMs.p95, config.budgets.serverBatchP95MaxMs),
        ];

        const reportPath = await writePerfReport({
          name: "artifact-write-load",
          startedAt,
          finishedAt: new Date().toISOString(),
          config,
          metrics: {
            workers: config.serverWorkers,
            batchesPerWorker: config.batchesPerWorker,
            mutationsPerBatch: config.mutationsPerBatch,
            totalMutations: config.serverWorkers * config.batchesPerWorker * config.mutationsPerBatch,
            batchLatencyMs,
            budgetResults,
          },
        });

        console.log("[perf] artifact-write-load report", { reportPath });
        assertPerfBudgets(budgetResults);
      } finally {
        await server.stop();
        await serverDb.close();
      }
    },
    15 * 60_000,
  );
});

function buildSqlPayload(payload: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(payload).map(([key, value]) => [toSqlPayloadKey(key), value]));
}

function toSqlPayloadKey(key: string) {
  return key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`).replace(/([a-z])(\d+)$/i, "$1_$2");
}
