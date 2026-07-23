// The live-query DIFF machinery (ADR-0032 S2 §4). Two pure pieces sit either side of the bridge:
//   - {@link computeLiveDiff} (worker-side): turn a fresh ordered result-set into a {added, changed, removed}
//     diff against the previously-sent one, keyed by the query's PK — so only deltas cross the wire.
//   - {@link LiveRowsMaterializer} (tab-side): fold each diff back into an ordered array while preserving
//     row-object identity for unchanged rows (React memo bails on `===`).
// Both are transport-free and worker-free, so they unit-test directly.

import type { LiveDiffPayload } from "./protocol";

// A NUL separator — never a legitimate character inside a PK text value, so composite keys can't collide.
const KEY_SEP = String.fromCharCode(0);

/**
 * The stable key for a result row (§4). With `pkColumns`, join their values (composite-safe) — this is the
 * diff-keying identity, so a row whose PK is unchanged is the SAME logical row even if other columns moved.
 * Without `pkColumns` (a keyless query) fall back to the whole-row JSON value: still diff-shaped (never a
 * full resend), but an update surfaces as remove+add rather than a `changed` — the documented keyless
 * fallback. Duplicate identical keyless rows collapse under this scheme (accepted for the fallback).
 */
export function rowKey(row: Record<string, unknown>, pkColumns: readonly string[] | undefined): string {
  if (pkColumns && pkColumns.length > 0) {
    return pkColumns.map((col) => String(row[col])).join(KEY_SEP);
  }
  return JSON.stringify(row);
}

/** A shallow value-equality over a row's own enumerable keys — decides `changed` vs unchanged in a diff. */
function rowsEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!Object.is(a[key], b[key])) return false;
  }
  return true;
}

/** The worker's per-subscription memory: the last delivered rows keyed by {@link rowKey}, in delivered order. */
export interface LiveDiffState {
  pkColumns?: readonly string[];
  /** key → the exact row body last sent, so the next diff can detect `changed` and skip unchanged rows. */
  previous: Map<string, Record<string, unknown>>;
}

/** Seed the diff state from the initial snapshot (which the worker sends verbatim, not as a diff). */
export function seedLiveDiffState(
  rows: readonly Record<string, unknown>[],
  pkColumns: readonly string[] | undefined,
): LiveDiffState {
  const previous = new Map<string, Record<string, unknown>>();
  for (const row of rows) previous.set(rowKey(row, pkColumns), row);
  return { ...(pkColumns ? { pkColumns } : {}), previous };
}

/**
 * Diff a fresh ordered result set against the state's previous set, MUTATING the state to the new set and
 * returning the wire diff (§4). `order` is every key in the new ORDER BY order (keys only — cheap); `added`/
 * `changed` carry the delta row BODIES; `removed` carries dropped keys. Never emits the full result set: a
 * single-row change yields one `changed` and the (key-only) `order`.
 */
export function computeLiveDiff(
  state: LiveDiffState,
  nextRows: readonly Record<string, unknown>[],
): Omit<LiveDiffPayload, "queryId"> {
  const order: string[] = [];
  const added: { key: string; row: Record<string, unknown> }[] = [];
  const changed: { key: string; row: Record<string, unknown> }[] = [];
  const nextKeys = new Set<string>();
  const nextMap = new Map<string, Record<string, unknown>>();

  for (const row of nextRows) {
    const key = rowKey(row, state.pkColumns);
    // A duplicate key within one result set (composite PK not actually unique, or a keyless collision):
    // keep the first, so `order`/diff stay a faithful set. Rare; the read projections are PK-unique.
    if (nextKeys.has(key)) continue;
    nextKeys.add(key);
    nextMap.set(key, row);
    order.push(key);

    const prior = state.previous.get(key);
    if (prior === undefined) {
      added.push({ key, row });
    } else if (!rowsEqual(prior, row)) {
      changed.push({ key, row });
    }
  }

  const removed: string[] = [];
  for (const key of state.previous.keys()) {
    if (!nextKeys.has(key)) removed.push(key);
  }

  state.previous = nextMap;
  return { order, added, changed, removed };
}

/**
 * The tab-side fold of live diffs into an ordered row array with STABLE object identity (§4). The initial
 * snapshot seeds the cache; each diff rebuilds the array from `diff.order`, reusing the cached object for
 * any key not in `added`/`changed` (so an unchanged row keeps `===` and a memoized React row skips its
 * re-render), and installing a fresh object for added/changed keys. Order is exactly `diff.order` — the
 * query's ORDER BY as delivered by the worker.
 */
export class LiveRowsMaterializer<TRow extends Record<string, unknown> = Record<string, unknown>> {
  private byKey = new Map<string, TRow>();
  private rows: TRow[] = [];
  private readonly pkColumns: readonly string[] | undefined;

  constructor(pkColumns: readonly string[] | undefined) {
    this.pkColumns = pkColumns;
  }

  /** Seed from the initial snapshot; returns the initial ordered rows (each a distinct cached object). */
  seed(initialRows: readonly TRow[]): TRow[] {
    this.byKey = new Map();
    this.rows = [];
    for (const row of initialRows) {
      const key = rowKey(row, this.pkColumns);
      this.byKey.set(key, row);
      this.rows.push(row);
    }
    return this.rows;
  }

  /** Apply a diff; returns the new ordered array (a fresh array, but unchanged rows keep their object identity). */
  apply(diff: Omit<LiveDiffPayload, "queryId">): TRow[] {
    for (const key of diff.removed) this.byKey.delete(key);
    for (const { key, row } of diff.added) this.byKey.set(key, row as TRow);
    for (const { key, row } of diff.changed) this.byKey.set(key, row as TRow);
    // Rebuild strictly from the delivered order, reusing whatever object each key now maps to. Added/changed
    // keys already point at fresh objects (set above); every other key keeps its prior object (=== holds).
    this.rows = diff.order.map((key) => this.byKey.get(key)!).filter((row): row is TRow => row !== undefined);
    return this.rows;
  }

  /** The current ordered rows (identity-stable across `apply` calls for unchanged rows). */
  current(): TRow[] {
    return this.rows;
  }
}
