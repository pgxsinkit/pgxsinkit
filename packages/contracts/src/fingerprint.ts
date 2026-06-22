import { getTableConfig, type AnyPgTable } from "drizzle-orm/pg-core";

import type { SyncTableEntry, SyncTableRegistry } from "./registry";

/**
 * The registry fingerprint (ADR-0004): a stable, order-independent description of
 * the shape-relevant registry metadata, plus a hash of it.
 *
 * This is the single source of "has the shape changed" — consumed as the local-DB
 * version key and as the basis of the registry-diff gate (ADR-0006). Functions
 * (`rowTransform`, `customWhere`, function-valued filter params) are deliberately
 * excluded: only the structural shape that affects the local schema and
 * server-compatibility participates.
 */

export interface CanonicalColumn {
  name: string;
  type: string;
  notNull: boolean;
  hasDefault: boolean;
  primary: boolean;
}

export interface CanonicalTable {
  key: string;
  mode: string;
  primaryKey: string[];
  localPrimaryKey: string[] | null;
  columns: CanonicalColumn[];
  projection: {
    syncedTable: string | null;
    overlayTable: string | null;
    journalTable: string | null;
    omitColumns: string[];
  } | null;
  shape: {
    tableName: string;
    shapeKey: string;
    electricTable: string | null;
    hasRowFilter: boolean;
  } | null;
  managedFields: Array<{ field: string; strategy: string; applyOn: string[] }>;
}

const byName = (a: { name: string }, b: { name: string }): number => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
const asString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function canonicalizeColumns(table: AnyPgTable): CanonicalColumn[] {
  return getTableConfig(table)
    .columns.map((column) => ({
      name: column.name,
      type: column.getSQLType(),
      notNull: column.notNull,
      hasDefault: column.hasDefault,
      primary: column.primary,
    }))
    .sort(byName);
}

function canonicalizeManagedFields(entry: SyncTableEntry): CanonicalTable["managedFields"] {
  return (entry.governance?.managedFields ?? [])
    .map((field) => {
      const record = field as { propertyKey?: unknown; column?: unknown; strategy?: unknown; applyOn?: unknown };
      const name =
        typeof record.propertyKey === "string"
          ? record.propertyKey
          : typeof record.column === "string"
            ? record.column
            : "";
      const applyOn = Array.isArray(record.applyOn) ? [...record.applyOn].map(String).sort(asString) : [];
      const strategy = typeof record.strategy === "string" ? record.strategy : "";
      return { field: name, strategy, applyOn };
    })
    .sort((a, b) => asString(a.field, b.field));
}

function canonicalizeTable(key: string, entry: SyncTableEntry): CanonicalTable {
  const projection = entry.clientProjection
    ? {
        syncedTable: entry.clientProjection.syncedTable ?? null,
        overlayTable: entry.clientProjection.overlayTable ?? null,
        journalTable: entry.clientProjection.journalTable ?? null,
        omitColumns: [...(entry.clientProjection.omitColumns ?? [])].map(String).sort(asString),
      }
    : null;

  const shape = entry.shape
    ? {
        tableName: entry.shape.tableName,
        shapeKey: entry.shape.shapeKey,
        electricTable: entry.shape.electricTable ?? null,
        hasRowFilter: entry.shape.rowFilter != null,
      }
    : null;

  return {
    key,
    mode: entry.mode,
    primaryKey: [...entry.primaryKey.columns].sort(asString),
    localPrimaryKey: entry.clientProjection?.localPrimaryKey
      ? [...entry.clientProjection.localPrimaryKey.columns].sort(asString)
      : null,
    columns: canonicalizeColumns(entry.table),
    projection,
    shape,
    managedFields: canonicalizeManagedFields(entry),
  };
}

/**
 * The canonical, order-independent shape of a registry. Tables are sorted by key so
 * declaration order never affects the result.
 */
export function canonicalizeRegistry(registry: SyncTableRegistry): CanonicalTable[] {
  return Object.entries(registry)
    .map(([key, entry]) => canonicalizeTable(key, entry))
    .sort((a, b) => asString(a.key, b.key));
}

/** A stable string serialization of the canonical registry shape. */
export function canonicalRegistryString(registry: SyncTableRegistry): string {
  return JSON.stringify(canonicalizeRegistry(registry));
}

/**
 * A stable fingerprint (hex) of the registry's shape. Identical shapes — even with
 * tables declared in a different order — produce the same fingerprint; any
 * structural change produces a different one.
 */
export function fingerprintRegistry(registry: SyncTableRegistry): string {
  return fnv1a64Hex(canonicalRegistryString(registry));
}

// FNV-1a over UTF-8 bytes, returned as 16 hex chars. Pure and dependency-free so it
// runs identically in the browser and in Bun (no crypto import). A fingerprint, not
// a security primitive.
function fnv1a64Hex(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const prime = 0x100000001b3n;
  const mask = (1n << 64n) - 1n;
  let hash = 0xcbf29ce484222325n;
  for (const byte of bytes) {
    hash = ((hash ^ BigInt(byte)) * prime) & mask;
  }
  return hash.toString(16).padStart(16, "0");
}
