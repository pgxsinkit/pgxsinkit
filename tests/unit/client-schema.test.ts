import { buildSyntheticRegistry, buildSyntheticRegistrySchemaName, demoSyncRegistry } from "@pgxsinkit/demo";

import { generateLocalSchemaSql } from "../../packages/client/src/schema";

describe("client local schema generation", () => {
  it("generates local synced, overlay, journal, and read-model SQL from the registry", () => {
    const sql = generateLocalSchemaSql(demoSyncRegistry);

    expect(sql).toContain("CREATE TABLE IF NOT EXISTS authors");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS author_overlay");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS author_mutations");
    expect(sql).toContain("CREATE OR REPLACE VIEW author_read_model AS");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS todos");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS todo_overlay");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS todo_mutations");
    expect(sql).toContain("CREATE OR REPLACE VIEW todo_read_model AS");
    expect(sql).toContain("entity_key_json TEXT NOT NULL");
    expect(sql).toContain("author_mutations_status_retry_idx");
    expect(sql).toContain("author_mutations_entity_status_seq_idx");
  });

  it("qualifies local tables and views when the registry schema is non-public", () => {
    const schemaName = buildSyntheticRegistrySchemaName({
      tableCount: 2,
      extraColumnCount: 8,
    });
    const { registry } = buildSyntheticRegistry({
      tableCount: 2,
      extraColumnCount: 8,
      schemaName,
    });
    const sql = generateLocalSchemaSql(registry);

    expect(sql).toContain(`CREATE SCHEMA IF NOT EXISTS "${schemaName}";`);
    expect(sql).toContain(`CREATE TABLE IF NOT EXISTS "${schemaName}"."perf_items_000"`);
    expect(sql).toContain(`CREATE TABLE IF NOT EXISTS "${schemaName}"."perf_items_000_overlay"`);
    expect(sql).toContain(`CREATE TABLE IF NOT EXISTS "${schemaName}"."perf_items_000_mutations"`);
    expect(sql).toContain(`CREATE OR REPLACE VIEW "${schemaName}"."perf_items_000_read_model" AS`);
  });
});
