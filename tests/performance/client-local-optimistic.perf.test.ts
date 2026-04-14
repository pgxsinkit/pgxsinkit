import { performance } from "node:perf_hooks";

import { createSyncClient, type ClientPGlite } from "@pgxsinkit/client";

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

      const client = await createSyncClient({
        registry,
        electricUrl: "http://127.0.0.1:1/v1/shape",
        writeUrl: "http://127.0.0.1:1",
        batchWriteUrl: "http://127.0.0.1:1",
        syncEnabled: false,
        dataDir: `memory://perf-client-${Date.now()}`,
      });

      try {
        await client.ready;
        await seedLocalRows(client.pglite, targetTable, config.localRows, config.extraColumnCount);

        const mutationTimings: number[] = [];
        const effectiveMutationBatchSize = Math.max(1, config.mutationBatchSize);
        type UpdateBatchItem = Extract<Parameters<typeof client.mutate.batch>[0][number], { kind: "update" }>;

        for (let start = 0; start < config.pendingMutations; start += effectiveMutationBatchSize) {
          const batchEnd = Math.min(config.pendingMutations, start + effectiveMutationBatchSize);
          const batchItems: UpdateBatchItem[] = [];

          for (let index = start; index < batchEnd; index += 1) {
            const rowId = buildSyntheticCreatePayload(0, index % config.localRows, config.extraColumnCount)
              .id as string;

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

        for (let index = 0; index < config.readSamples; index += 1) {
          const rowId = buildSyntheticCreatePayload(0, index % config.localRows, config.extraColumnCount).id as string;
          const started = performance.now();
          const result = await client.pglite.query<{ id: string; overlay_kind: string }>(
            `SELECT id, overlay_kind FROM ${targetTable}_read_model WHERE id = $1`,
            [rowId],
          );
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
        await client.destroy();
      }
    },
    10 * 60_000,
  );
});

async function seedLocalRows(db: ClientPGlite, tableName: string, rowCount: number, extraColumnCount: number) {
  const columnNames = [
    "id",
    ...Array.from({ length: extraColumnCount }, (_, index) => `field_${index.toString().padStart(2, "0")}`),
    "owner_id",
    "modified_by",
    "status",
    "priority",
    "created_at_us",
    "updated_at_us",
  ];
  const batchSize = 250;

  for (let start = 0; start < rowCount; start += batchSize) {
    const batchEnd = Math.min(rowCount, start + batchSize);
    const values: Array<string | number> = [];
    const tuples: string[] = [];

    for (let rowIndex = start; rowIndex < batchEnd; rowIndex += 1) {
      const payload = buildSyntheticCreatePayload(0, rowIndex, extraColumnCount);
      const placeholders: string[] = [];

      values.push(String(payload.id));
      placeholders.push(`$${values.length}`);

      for (let columnIndex = 0; columnIndex < extraColumnCount; columnIndex += 1) {
        values.push(String(payload[`field${columnIndex.toString().padStart(2, "0")}`]));
        placeholders.push(`$${values.length}`);
      }

      values.push("11111111-1111-4111-8111-111111111111");
      placeholders.push(`$${values.length}`);
      values.push("11111111-1111-4111-8111-111111111111");
      placeholders.push(`$${values.length}`);
      values.push(String(payload.status));
      placeholders.push(`$${values.length}`);
      values.push(String(payload.priority));
      placeholders.push(`$${values.length}`);
      values.push(1_700_000_000_000_000 + rowIndex);
      placeholders.push(`$${values.length}`);
      values.push(1_700_000_000_000_000 + rowIndex);
      placeholders.push(`$${values.length}`);

      tuples.push(`(${placeholders.join(", ")})`);
    }

    await db.query(`INSERT INTO ${tableName} (${columnNames.join(", ")}) VALUES ${tuples.join(", ")}`, values);
  }
}
