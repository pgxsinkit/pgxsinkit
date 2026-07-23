import { getTableConfig, type AnyPgTable } from "drizzle-orm/pg-core";

import type { RowFilterSpec } from "./config";
import type { SyncTableEntry, SyncTableRegistry } from "./registry";

/**
 * The registry fingerprint (ADR-0004): a stable, order-independent description of
 * the shape-relevant registry metadata, plus a hash of it.
 *
 * This is the single source of "has the shape changed" — consumed as the local-DB
 * version key and as the basis of the registry-diff gate (ADR-0006). Function *bodies*
 * (`rowTransform`, `customWhere`) cannot be fingerprinted and are excluded — but their
 * *presence* and the surrounding **static** filter structure (the projected columns)
 * participate. For the invisible *logic* itself, a consumer-bumped `rowFilter.revision` is
 * folded in: changing it is how a `customWhere` authorization change is forced to shift the
 * fingerprint (and so rebuild the cache + reset the subscription).
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
  /**
   * Retention (ADR-0021). Part of the fingerprint because it changes the cluster DDL — an `ephemeral`
   * table's whole cluster is emitted as `TEMP`/`pg_temp` — so flipping persistent↔ephemeral must force a
   * cache rebuild + subscription reset. (Subscription timing is NOT included: it is pure runtime
   * orchestration over identical tables and needs no rebuild.)
   */
  retention: string;
}

/**
 * The static, fingerprint-able structure of a row filter. A changed projection shifts the
 * fingerprint, so the local store rebuilds and the diff gate flags it. `customWhere`'s body is
 * invisible — only its presence (`hasCustomWhere`) is recorded — so a `customWhere` *logic* change
 * is surfaced only by bumping `revision`.
 */
export interface CanonicalRowFilter {
  hasCustomWhere: boolean;
  columns: string[] | null;
  /**
   * The consumer-supplied version tag for the non-fingerprintable filter logic (the `customWhere`
   * body). Changing it shifts the fingerprint, which is the only way a `customWhere` *logic* change
   * forces a cache + subscription reset.
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
    retention: entry.retention ?? "persistent",
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
  return hashString(canonicalRegistryString(registry));
}

/**
 * The **read contract** of a single sync table: the subset of its canonical shape that decides what
 * data streams down and how a row is identified and filtered — synced-table name, columns, primary key
 * (and any local-PK override), column omission, and the shape (electric table + row filter). It is the
 * stable identity a writable entry shares with its {@link asReadonly} projection.
 *
 * Deliberately EXCLUDES the two axes a per-client projection may legitimately differ on:
 * - **write capability** — `mode`, the overlay/journal projection, `managedFields`, `conflictPolicy`,
 *   `writeMode` (one client writes the table, another only reads it);
 * - **lifecycle orchestration** — `consistencyGroup`, `subscription`, `retention` (a client may
 *   eager- or lazy-load, or group differently, without changing the data it sees).
 *
 * What it pins is the data itself: two registries that present "the same" logical table to different
 * clients must agree here, or those clients are silently seeing different rows/columns. As with the
 * full registry fingerprint, the `customWhere` *body* is invisible — only its presence and the
 * consumer-bumped {@link RowFilterSpec.revision} participate, so bump `revision` to force a divergence
 * a logic-only change would otherwise hide.
 */
export interface CanonicalReadContract {
  syncedTable: string;
  primaryKey: string[];
  localPrimaryKey: string[] | null;
  columns: CanonicalColumn[];
  omitColumns: string[];
  shape: {
    tableName: string;
    shapeKey: string;
    electricTable: string | null;
    rowFilter: CanonicalRowFilter | null;
  } | null;
}

/** The canonical {@link CanonicalReadContract} of a sync table entry (see the interface for what it omits). */
export function canonicalizeReadContract(entry: SyncTableEntry): CanonicalReadContract {
  const shape = entry.shape
    ? {
        tableName: entry.shape.tableName,
        shapeKey: entry.shape.shapeKey,
        electricTable: entry.shape.electricTable ?? null,
        rowFilter: canonicalizeRowFilter(entry.shape.rowFilter),
      }
    : null;

  return {
    syncedTable: entry.clientProjection?.syncedTable ?? getTableConfig(entry.table).name,
    primaryKey: [...entry.primaryKey.columns].sort(asString),
    localPrimaryKey: entry.clientProjection?.localPrimaryKey
      ? [...entry.clientProjection.localPrimaryKey.columns].sort(asString)
      : null,
    columns: canonicalizeColumns(entry.table),
    omitColumns: [...(entry.clientProjection?.omitColumns ?? [])].map(String).sort(asString),
    shape,
  };
}

/** A stable string serialization of a table's {@link CanonicalReadContract}. */
export function canonicalReadContractString(entry: SyncTableEntry): string {
  return JSON.stringify(canonicalizeReadContract(entry));
}

/**
 * A stable fingerprint (hex) of a table's {@link CanonicalReadContract}. Equal for a writable entry and
 * its {@link asReadonly} projection; the basis of the projection-consistency invariant
 * (`assertReadContractPreserved`).
 */
export function fingerprintReadContract(entry: SyncTableEntry): string {
  return hashString(canonicalReadContractString(entry));
}

/**
 * FNV-1a over UTF-8 bytes, returned as 16 hex chars. Pure and dependency-free so it runs
 * identically in the browser and in Bun (no crypto import). A fingerprint, not a security
 * primitive — used both for the registry shape fingerprint (ADR-0004) and for the apply-function
 * DDL fingerprint embedded in the generated migration (ADR-0018).
 */
export function hashString(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const prime = 0x100000001b3n;
  const mask = (1n << 64n) - 1n;
  let hash = 0xcbf29ce484222325n;
  for (const byte of bytes) {
    hash = ((hash ^ BigInt(byte)) * prime) & mask;
  }
  return hash.toString(16).padStart(16, "0");
}
