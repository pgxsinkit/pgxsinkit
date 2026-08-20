import { getTableConfig, type AnyPgTable } from "drizzle-orm/pg-core";

import type { RowFilterSpec } from "./config";
import {
  isAndPredicate,
  isInSubqueryPredicate,
  isIsNullPredicate,
  isNotPredicate,
  isOrPredicate,
  type Predicate,
} from "./predicate";
import type { SyncTableEntry, SyncTableRegistry } from "./registry";

/**
 * The registry fingerprint (ADR-0004): a stable, order-independent description of
 * the shape-relevant registry metadata, plus a hash of it.
 *
 * This is the single source of "has the shape changed" — consumed as the local-DB
 * version key and as the basis of the registry-diff gate (ADR-0006). Function *bodies*
 * (`rowTransform`, `customPredicate`) cannot be fingerprinted and are excluded — but their
 * *presence* and the surrounding **static** filter structure (the projected columns)
 * participate. For the invisible *logic* itself, a consumer-bumped `rowFilter.revision` is
 * folded in: changing it is how a `customPredicate` authorization change is forced to shift the
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
    physicalTable: string | null;
    rowFilter: CanonicalRowFilter | null;
    /** Shared-tier scope columns, in declaration order — the order parameterizes the family. */
    scope: string[] | null;
    /**
     * The native static predicate, canonicalized in full.
     *
     * Unlike `customPredicate`, this one is *visible*: an AST can be hashed, where a closure could only
     * ever be fingerprinted by its presence. So the `revision` footgun does not apply here — editing
     * a native `where` shifts the fingerprint by itself, and a consumer cannot forget to say so.
     */
    where: string | null;
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
 * fingerprint, so the local store rebuilds and the diff gate flags it. `customPredicate`'s body is
 * invisible — only its presence (`hasCustomPredicate`) is recorded — so a `customPredicate` *logic* change
 * is surfaced only by bumping `revision`.
 */
export interface CanonicalRowFilter {
  hasCustomPredicate: boolean;
  columns: string[] | null;
  /**
   * The consumer-supplied version tag for the non-fingerprintable filter logic (the `customPredicate`
   * body). Changing it shifts the fingerprint, which is the only way a `customPredicate` *logic* change
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

/**
 * A stable string form of a native predicate.
 *
 * Keys are emitted in a fixed order rather than serialized as authored, so two predicates that
 * differ only in how their object literals were written fingerprint identically — otherwise a
 * cosmetic edit would force every client to rebuild its local cache.
 */
function canonicalizePredicate(node: Predicate | undefined): string | null {
  if (node === undefined) return null;
  const render = (current: Predicate): unknown => {
    if (isAndPredicate(current)) return { and: current.and.map(render) };
    if (isOrPredicate(current)) return { or: current.or.map(render) };
    if (isNotPredicate(current)) return { not: render(current.not) };
    if (isInSubqueryPredicate(current)) {
      return {
        col: current.col,
        in: {
          table: current.in.table,
          project: current.in.project,
          where: current.in.where ? render(current.in.where) : null,
        },
        negated: current.negated === true,
      };
    }
    if (isIsNullPredicate(current)) return { col: current.col, isNull: current.isNull };
    return { col: current.col, op: current.op, value: current.value };
  };
  return JSON.stringify(render(node));
}

function canonicalizeRowFilter(filter: RowFilterSpec | undefined): CanonicalRowFilter | null {
  if (!filter) {
    return null;
  }
  return {
    hasCustomPredicate: filter.customPredicate != null,
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
        physicalTable: entry.shape.physicalTable ?? null,
        rowFilter: canonicalizeRowFilter(entry.shape.rowFilter),
        scope: entry.shape.scope ? [...entry.shape.scope] : null,
        where: canonicalizePredicate(entry.shape.where),
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
 * Per-registry-object memo. The full canonicalize → JSON.stringify → hash chain is walked at least twice per
 * client boot over the SAME registry object (the boot report's `registryFingerprint` and the mutation
 * runtime's `registryVersion`), and its cost scales with registry width — so cache it on the object.
 *
 * There is deliberately no invalidation: a registry is a frozen-by-convention module constant built once by
 * `defineSyncRegistry` (mutating one after handing it to a client is already undefined behaviour — the shape
 * fingerprint is what the local store's DDL and subscription state are keyed by). A `WeakMap` keeps the entry
 * exactly as long as the registry itself, so a per-request/per-tenant registry object is collected normally.
 */
const registryFingerprintMemo = new WeakMap<SyncTableRegistry, string>();

/**
 * A stable fingerprint (hex) of the registry's shape. Identical shapes — even with
 * tables declared in a different order — produce the same fingerprint; any
 * structural change produces a different one. Memoised per registry object (see
 * {@link registryFingerprintMemo}); two structurally equal registries still fingerprint equal, memo or not.
 */
export function fingerprintRegistry(registry: SyncTableRegistry): string {
  const memoised = registryFingerprintMemo.get(registry);
  if (memoised !== undefined) return memoised;
  const fingerprint = hashString(canonicalRegistryString(registry));
  registryFingerprintMemo.set(registry, fingerprint);
  return fingerprint;
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
 * full registry fingerprint, the `customPredicate` *body* is invisible — only its presence and the
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
    physicalTable: string | null;
    rowFilter: CanonicalRowFilter | null;
    /** Shared-tier scope columns, in declaration order — the order parameterizes the family. */
    scope: string[] | null;
    /**
     * The native static predicate, canonicalized in full.
     *
     * Unlike `customPredicate`, this one is *visible*: an AST can be hashed, where a closure could only
     * ever be fingerprinted by its presence. So the `revision` footgun does not apply here — editing
     * a native `where` shifts the fingerprint by itself, and a consumer cannot forget to say so.
     */
    where: string | null;
  } | null;
}

/** The canonical {@link CanonicalReadContract} of a sync table entry (see the interface for what it omits). */
export function canonicalizeReadContract(entry: SyncTableEntry): CanonicalReadContract {
  const shape = entry.shape
    ? {
        tableName: entry.shape.tableName,
        shapeKey: entry.shape.shapeKey,
        physicalTable: entry.shape.physicalTable ?? null,
        rowFilter: canonicalizeRowFilter(entry.shape.rowFilter),
        scope: entry.shape.scope ? [...entry.shape.scope] : null,
        where: canonicalizePredicate(entry.shape.where),
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
 *
 * The 64-bit state is carried in TWO 32-bit Number lanes rather than a BigInt, because this runs over
 * multi-KB payloads on the boot critical path (the local-schema fingerprint hashes the whole generated
 * durable DDL) and a BigInt allocates per byte. The output is IDENTICAL — same algorithm, same offset
 * basis, same prime, same modulo-2^64 truncation — and it MUST stay that way: the values are PERSISTED
 * (`registry_fingerprint`, the `lsf1` local-schema fingerprint, the `apply` DDL fingerprint), so a
 * changed value would silently wipe every existing store's read cache. `tests/unit/registry-fingerprint`
 * pins goldens against the original BigInt implementation as the oracle.
 *
 * Why plain Numbers are exact here: the prime 0x100000001b3 splits into small halves (high 0x100, low
 * 0x1b3), so every partial product stays under 2^42 — far inside the 2^53 integer-exact range. The lane
 * arithmetic therefore needs no `Math.imul` truncation games; only the final `% 2^32` per lane.
 */
export function hashString(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const TWO_32 = 4294967296;
  const PRIME_LOW = 0x1b3;
  const PRIME_HIGH = 0x100;
  // The FNV-1a 64-bit offset basis 0xcbf29ce484222325, split into its two 32-bit halves.
  let high = 0xcbf29ce4;
  let low = 0x84222325;
  for (let index = 0; index < bytes.length; index += 1) {
    // The byte only ever touches the bottom 8 bits, so the XOR is confined to the low lane.
    low = (low ^ bytes[index]!) >>> 0;
    // 64-bit multiply, mod 2^64: low·primeLow feeds the low lane and carries into the high lane, which
    // also takes high·primeLow + low·primeHigh (the primeHigh·high term overflows 2^64 and is dropped).
    const lowProduct = low * PRIME_LOW;
    const carry = Math.floor(lowProduct / TWO_32);
    const nextHigh = (high * PRIME_LOW + low * PRIME_HIGH + carry) % TWO_32;
    low = lowProduct - carry * TWO_32;
    high = nextHigh;
  }
  // Two zero-padded 32-bit halves are byte-identical to padStart(16) over the joined 64-bit value.
  return high.toString(16).padStart(8, "0") + low.toString(16).padStart(8, "0");
}
