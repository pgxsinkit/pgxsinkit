import { describe, expect, it } from "bun:test";
import { performance } from "node:perf_hooks";

import { eq, sql } from "drizzle-orm";
import type { AnyPgTable } from "drizzle-orm/pg-core";

import { createSyncClient, getReadModelView, type SyncClient } from "@pgxsinkit/client";
import { memoryStoreForTests } from "@pgxsinkit/client/testing";
import type { SyncTableRegistry } from "@pgxsinkit/contracts";

import {
  assertPerfBudgets,
  computePercentiles,
  evaluatePerfBudget,
  readPerfScenarioConfig,
  writePerfReport,
} from "./support/scenario";
import { buildSyntheticCreatePayload, buildSyntheticRegistry } from "./support/synthetic-registry";

describe("performance: client local optimistic views", () => {
  it(
    "handles large local tables and pending mutations without crashing",
    async () => {
      const config = readPerfScenarioConfig();
      const startedAt = new Date().toISOString();
      const { registry, tableNames } = buildSyntheticRegistry({
        tableCount: Math.max(1, config.tableCount),
        extraColumnCount: config.extraColumnCount,
      });
      const targetTable = tableNames[0]!;
      const targetEntry = registry[targetTable];

      if (!targetEntry) {
        throw new Error(`Missing registry entry for ${targetTable}`);
      }

      const client = await createSyncClient({
        registry,
        electricUrl: "http://127.0.0.1:1/v1/shape",
        batchWriteUrl: "http://127.0.0.1:1/api/mutations",
        syncEnabled: false,
        ...memoryStoreForTests(`perf-client-${Date.now()}`),
      });

      try {
        await client.ready;
        await seedLocalRows(client.drizzle, targetEntry.table, config.localRows, config.extraColumnCount);

        const mutationTimings: number[] = [];
        const effectiveMutationBatchSize = Math.max(1, config.mutationBatchSize);
        type UpdateBatchItem = Extract<Parameters<typeof client.mutate.batch>[0][number], { kind: "update" }>;

        for (let start = 0; start < config.pendingMutations; start += effectiveMutationBatchSize) {
          const batchEnd = Math.min(config.pendingMutations, start + effectiveMutationBatchSize);
          const batchItems: UpdateBatchItem[] = [];

          for (let index = start; index < batchEnd; index += 1) {
            const rowId = buildSyntheticCreatePayload(0, index % config.localRows, config.extraColumnCount).id;

            batchItems.push({
              table: targetTable,
              kind: "update",
              entityKey: { id: rowId },
              patch: { field00: `pending-${index}`, status: "in_progress" },
            });
          }

          const started = performance.now();

          if (batchItems.length === 1) {
            const onlyItem = batchItems[0]!;
            await client.mutate.update(onlyItem.table, onlyItem.entityKey, onlyItem.patch);
            mutationTimings.push(performance.now() - started);
          } else {
            await client.mutate.batch(batchItems);
            const perMutationMs = (performance.now() - started) / batchItems.length;

            for (let index = 0; index < batchItems.length; index += 1) {
              mutationTimings.push(perMutationMs);
            }
          }
        }

        const readTimings: number[] = [];

        // Authored ONCE from the registry's schema-qualified read-model view factory (tier-①) and
        // rendered to raw text with a bound-parameter placeholder; the timed loop below keeps calling the
        // raw driver with this pre-rendered string, so no per-iteration builder work enters the read metric.
        const readModelView = getReadModelView(registry, targetTable);

        const readModelId = readModelView["id"];
        const readModelOverlayKind = readModelView["overlay_kind"];

        if (!readModelId || !readModelOverlayKind) {
          throw new Error(`Missing id/overlay_kind columns on the ${targetTable} read-model view`);
        }

        const readQuerySql = client.drizzle
          .select({ id: readModelId, overlay_kind: readModelOverlayKind })
          .from(readModelView)
          .where(eq(readModelId, sql.placeholder("id")))
          .toSQL().sql;

        for (let index = 0; index < config.readSamples; index += 1) {
          const rowId = buildSyntheticCreatePayload(0, index % config.localRows, config.extraColumnCount).id;
          const started = performance.now();
          const result = await client.pglite.query<{ id: string; overlay_kind: string }>(readQuerySql, [rowId]);
          readTimings.push(performance.now() - started);
          expect(result.rows[0]?.id).toBe(rowId);
        }

        const diagnostics = await client.diagnostics(targetTable);
        expect(
          diagnostics.mutation.pendingCount + diagnostics.mutation.sendingCount + diagnostics.mutation.failedCount,
        ).toBe(config.pendingMutations);

        const mutationTimingsMs = computePercentiles(mutationTimings);
        const readTimingsMs = computePercentiles(readTimings);
        const budgetResults = [
          evaluatePerfBudget("client mutation p95", mutationTimingsMs.p95, config.budgets.clientMutationP95MaxMs),
          evaluatePerfBudget("client read p95", readTimingsMs.p95, config.budgets.clientReadP95MaxMs),
        ];

        const reportPath = await writePerfReport({
          name: "client-local-optimistic",
          startedAt,
          finishedAt: new Date().toISOString(),
          config,
          metrics: {
            rowsSeeded: config.localRows,
            pendingMutations: config.pendingMutations,
            mutationBatchSize: effectiveMutationBatchSize,
            mutationTimingsMs,
            readTimingsMs,
            budgetResults,
          },
        });

        console.log("[perf] client-local-optimistic report", { reportPath });
        assertPerfBudgets(budgetResults);
      } finally {
        await client.stop();
      }
    },
    10 * 60_000,
  );
});

// Setup-phase seeding (unmeasured): tier-① inserts through the client's drizzle handle over the
// registry table, in the same 250-row batches as the raw form.
async function seedLocalRows(
  db: SyncClient<SyncTableRegistry>["drizzle"],
  table: AnyPgTable,
  rowCount: number,
  extraColumnCount: number,
) {
  const batchSize = 250;

  for (let start = 0; start < rowCount; start += batchSize) {
    const batchEnd = Math.min(rowCount, start + batchSize);
    const rows: Array<Record<string, string | bigint>> = [];

    for (let rowIndex = start; rowIndex < batchEnd; rowIndex += 1) {
      const payload = buildSyntheticCreatePayload(0, rowIndex, extraColumnCount);
      const timestampUs = 1_700_000_000_000_000n + BigInt(rowIndex);
      const row: Record<string, string | bigint> = {
        id: payload.id,
        ownerId: "11111111-1111-4111-8111-111111111111",
        modifiedBy: "11111111-1111-4111-8111-111111111111",
        status: payload.status,
        priority: payload.priority,
        createdAtUs: timestampUs,
        updatedAtUs: timestampUs,
      };

      for (let columnIndex = 0; columnIndex < extraColumnCount; columnIndex += 1) {
        const fieldKey = `field${columnIndex.toString().padStart(2, "0")}`;
        row[fieldKey] = payload[fieldKey] ?? "";
      }

      rows.push(row);
    }

    await db.insert(table).values(rows);
  }
}
