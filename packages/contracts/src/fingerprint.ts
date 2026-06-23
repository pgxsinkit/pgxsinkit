import { getTableConfig, type AnyPgTable } from "drizzle-orm/pg-core";

import type { RowFilterSpec } from "./config";
import type { SyncTableEntry, SyncTableRegistry } from "./registry";

/**
 * The registry fingerprint (ADR-0004): a stable, order-independent description of
 * the shape-relevant registry metadata, plus a hash of it.
 *
 * This is the single source of "has the shape changed" — consumed as the local-DB
 * version key and as the basis of the registry-diff gate (ADR-0006). Function *bodies*
 * (`rowTransform`, `customWhere`, a function-valued `sharedUserId`) cannot be fingerprinted
 * and are excluded — but their *presence* and the surrounding **static** filter structure
 * (ownership/shared columns, projected columns) participate, so swapping one static filter
 * for another is detected. For the invisible *logic* itself, a consumer-bumped
 * `rowFilter.revision` is folded in: changing it is how a `customWhere` authorization change
 * is forced to shift the fingerprint (and so rebuild the cache + reset the subscription).
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
    rowFilter: CanonicalRowFilter | null;
  } | null;
  managedFields: Array<{ field: string; strategy: string; applyOn: string[] }>;
  /**
   * Consistency group (ADR-0009 decision 2). Part of the fingerprint because it decides which
   * subscription-state row a table persists under: moving a table between groups must shift the
   * fingerprint (forcing a cache rebuild + subscription reset) and surface in the diff gate. `null`
   * = the default singleton group.
   */
  consistencyGroup: string | null;
}

/**
 * The static, fingerprint-able structure of a row filter. A change here (a different
 * ownership column, an added/removed shared rule, a different static `sharedUserId`, a
 * changed projection) shifts the fingerprint, so the local store rebuilds and the diff gate
 * flags it. `customWhere`'s body is invisible — only its presence (`hasCustomWhere`) is
 * recorded — and a function-valued `sharedUserId` collapses to a sentinel.
 */
export interface CanonicalRowFilter {
  ownership: { column: string; claim: string } | null;
  shared: { ownerColumn: string | null; sharedColumn: string | null; sharedUserId: string } | null;
  hasCustomWhere: boolean;
  columns: string[] | null;
  /**
   * The consumer-supplied version tag for the non-fingerprintable filter logic (the
   * `customWhere` body, a function-valued `sharedUserId`). Changing it shifts the fingerprint,
   * which is the only way a `customWhere` *logic* change forces a cache + subscription reset.
   */
  revision: string | null;
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

function canonicalizeRowFilter(filter: RowFilterSpec | undefined): CanonicalRowFilter | null {
  if (!filter) {
    return null;
  }
  return {
    ownership: filter.ownership ? { column: filter.ownership.column, claim: filter.ownership.claim ?? "sub" } : null,
    shared: filter.shared
      ? {
          ownerColumn: filter.shared.ownerColumn ?? null,
          sharedColumn: filter.shared.sharedColumn ?? null,
          // A static sharedUserId is part of the shape; a function-valued one cannot be
          // fingerprinted (as with customWhere) and collapses to a sentinel.
          sharedUserId: typeof filter.shared.sharedUserId === "string" ? filter.shared.sharedUserId : "(fn)",
        }
      : null,
    hasCustomWhere: filter.customWhere != null,
    columns: filter.columns ? [...filter.columns].sort(asString) : null,
    revision: filter.revision != null ? String(filter.revision) : null,
  };
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
        rowFilter: canonicalizeRowFilter(entry.shape.rowFilter),
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
    consistencyGroup: entry.consistencyGroup ?? null,
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
