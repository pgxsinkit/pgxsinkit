import { getTableConfig } from "drizzle-orm/pg-core";

import {
  buildSyntheticGovernanceSql,
  buildSyntheticPerfLabSchemaName,
  buildSyntheticRegistry,
  buildSyntheticRegistrySchemaName,
  buildSyntheticServerSchemaSql,
  buildSyntheticTruncateSql,
  countSyntheticWorkloadRows,
  findSyntheticPerfLabScenarioDefinition,
  pickSyntheticWorkloadTarget,
  syntheticPerfLabPresets,
} from "@pgxsinkit/schema";

import { buildPlpgsqlBatchFunctionDdl } from "../../packages/server/src/mutations/bulk/plpgsql-strategy";

describe("perf-lab scenario schemas", () => {
  it("builds schema-qualified synthetic tables and shape targets", () => {
    const schemaName = buildSyntheticPerfLabSchemaName("wide-schema");
    const bundle = buildSyntheticRegistry({
      tableCount: 4,
      extraColumnCount: 48,
      schemaName,
    });
    const firstTable = bundle.registry.perf_items_000;

    expect(firstTable).toBeDefined();

    const tableConfig = getTableConfig(firstTable!.table);

    expect(tableConfig.schema).toBe(schemaName);
    expect(firstTable?.shape?.electricTable).toBe(`${schemaName}.perf_items_000`);
    expect(firstTable?.shape?.shapeKey).toBe(`${schemaName}.perf_items_000`);
  });

  it("generates schema-qualified table ddl and schema-local governance sql", () => {
    const schemaName = buildSyntheticRegistrySchemaName({
      tableCount: 2,
      extraColumnCount: 6,
    });
    const bundle = buildSyntheticRegistry({
      tableCount: 2,
      extraColumnCount: 6,
      schemaName,
    });
    const schemaSql = buildSyntheticServerSchemaSql(bundle.registry);
    const governanceSql = buildSyntheticGovernanceSql(bundle.registry, {
      includeAuthHelpers: false,
    });

    expect(schemaSql).toContain(`CREATE SCHEMA IF NOT EXISTS "${schemaName}";`);
    expect(schemaSql).toContain(`CREATE TABLE "${schemaName}"."perf_items_000"`);
    expect(governanceSql).not.toContain("CREATE SCHEMA IF NOT EXISTS auth;");
    expect(governanceSql).toContain(`EXECUTE 'GRANT USAGE ON SCHEMA "${schemaName}" TO authenticated';`);
    expect(governanceSql).toContain(`ALTER TABLE "${schemaName}"."perf_items_000" ENABLE ROW LEVEL SECURITY;`);
    expect(governanceSql).toContain(
      `DROP POLICY IF EXISTS "perf_items_000_select_owner_or_admin" ON "${schemaName}"."perf_items_000";`,
    );
  });

  it("generates schema-local truncate and batch function ddl", () => {
    const schemaName = buildSyntheticRegistrySchemaName({
      tableCount: 2,
      extraColumnCount: 12,
    });
    const bundle = buildSyntheticRegistry({
      tableCount: 2,
      extraColumnCount: 12,
      schemaName,
    });
    const truncateSql = buildSyntheticTruncateSql(bundle.registry);
    const functionDdl = buildPlpgsqlBatchFunctionDdl(bundle.registry, {
      functionSchema: schemaName,
    });

    expect(truncateSql).toBe(`TRUNCATE TABLE "${schemaName}"."perf_items_000", "${schemaName}"."perf_items_001";`);
    expect(functionDdl).toContain(`CREATE OR REPLACE FUNCTION "${schemaName}"."pgxsinkit_apply_batch_mutations"(`);
    expect(functionDdl).toContain(`INSERT INTO "${schemaName}"."perf_items_000" (%s) VALUES (%s)`);
  });

  it("maps built-in scenarios onto deterministic schema names", () => {
    const scenarioDefinition = findSyntheticPerfLabScenarioDefinition({
      tableCount: 8,
      extraColumnCount: 16,
    });

    expect(scenarioDefinition?.key).toBe("mixed-pressure");
    expect(scenarioDefinition?.schemaName).toBe(buildSyntheticPerfLabSchemaName("mixed-pressure"));
  });

  it("keeps multi-table presets hot per table and distributes workload round-robin", () => {
    const wideSchemaPreset = syntheticPerfLabPresets.find((preset) => preset.key === "wide-schema");
    const mixedPressurePreset = syntheticPerfLabPresets.find((preset) => preset.key === "mixed-pressure");

    expect(wideSchemaPreset?.scenario.localRows).toBe(10_000);
    expect(mixedPressurePreset?.scenario.localRows).toBe(10_000);
    expect(countSyntheticWorkloadRows(4, 10_000)).toBe(40_000);

    expect(pickSyntheticWorkloadTarget(4, 0, 10_000)).toEqual({ tableIndex: 0, rowIndex: 0 });
    expect(pickSyntheticWorkloadTarget(4, 3, 10_000)).toEqual({ tableIndex: 3, rowIndex: 0 });
    expect(pickSyntheticWorkloadTarget(4, 4, 10_000)).toEqual({ tableIndex: 0, rowIndex: 1 });
    expect(pickSyntheticWorkloadTarget(4, 7, 10_000)).toEqual({ tableIndex: 3, rowIndex: 1 });
  });
});
