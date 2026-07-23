import { boolean, pgSchema, text } from "drizzle-orm/pg-core";

/**
 * Read-only Drizzle stubs for the standard-fixed system catalogs the tests introspect. Column sets
 * are the minimal subset the suites read; everything is `text` (the catalogs' `name`/`sql_identifier`
 * types coerce cleanly). Query-authoring objects only — never create/migrate these.
 */

const informationSchema = pgSchema("information_schema");
const pgCatalog = pgSchema("pg_catalog");

export const informationSchemaTables = informationSchema.table("tables", {
  tableCatalog: text("table_catalog"),
  tableSchema: text("table_schema"),
  tableName: text("table_name"),
  tableType: text("table_type"),
});

export const informationSchemaColumns = informationSchema.table("columns", {
  tableSchema: text("table_schema"),
  tableName: text("table_name"),
  columnName: text("column_name"),
  dataType: text("data_type"),
  udtName: text("udt_name"),
});

export const informationSchemaSchemata = informationSchema.table("schemata", {
  schemaName: text("schema_name"),
});

export const informationSchemaSequences = informationSchema.table("sequences", {
  sequenceSchema: text("sequence_schema"),
  sequenceName: text("sequence_name"),
});

export const informationSchemaTriggers = informationSchema.table("triggers", {
  triggerSchema: text("trigger_schema"),
  triggerName: text("trigger_name"),
});

export const pgViews = pgCatalog.table("pg_views", {
  schemaname: text("schemaname"),
  viewname: text("viewname"),
});

export const pgClass = pgCatalog.table("pg_class", {
  oid: text("oid"),
  relname: text("relname"),
  relnamespace: text("relnamespace"),
  relkind: text("relkind"),
});

export const pgNamespace = pgCatalog.table("pg_namespace", {
  oid: text("oid"),
  nspname: text("nspname"),
});

export const pgPolicies = pgCatalog.table("pg_policies", {
  schemaname: text("schemaname"),
  tablename: text("tablename"),
  policyname: text("policyname"),
  permissive: text("permissive"),
  cmd: text("cmd"),
});

export const pgTypeCatalog = pgCatalog.table("pg_type", {
  oid: text("oid"),
  typname: text("typname"),
  typnamespace: text("typnamespace"),
  typisdefined: boolean("typisdefined"),
});
