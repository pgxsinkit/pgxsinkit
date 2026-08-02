import { z } from "zod";

import type { EventStreamEntry } from "./event-stream";
import { canonicalizeRegistry, fingerprintRegistry, hashString, type CanonicalTable } from "./fingerprint";
import { getSyncRegistryStreams, type SyncTableEntry, type SyncTableRegistry } from "./registry";

/**
 * The registry-diff gate (ADR-0006): classify a registry change as
 * `compatible | risky | breaking` so loss-detection happens at *authoring* time, not
 * as a runtime surprise. A breaking diff is a conscious release decision — rework to
 * expand/contract, or accept-and-notify. This catches the one case the runtime cannot:
 * silent column *repurposing* (a same-named column whose type/meaning changed).
 *
 * pgxsinkit ships this mechanism; enforcement (whether a non-zero check blocks CI) is
 * the consumer's, via a committed lock that makes a breaking change a reviewable diff.
 */

export type RegistryChangeSeverity = "compatible" | "risky" | "breaking";

const asString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export interface RegistryChange {
  severity: RegistryChangeSeverity;
  table: string;
  detail: string;
}

export interface RegistryDiff {
  severity: RegistryChangeSeverity;
  changes: RegistryChange[];
}

/** A committed baseline of a registry's shape — the enforcement surface for the gate. */
export interface RegistryLock {
  version: string;
  tables: CanonicalTable[];
  /**
   * Each entry's row classification (ADR-0052), keyed by registry key; `null` = unclassified. A SIBLING of
   * `tables`, deliberately not a field of {@link CanonicalTable}: the canonical table shape is what
   * `fingerprintRegistry` hashes, and that hash is PERSISTED as the local store's cache key — so folding
   * classification into it would make merely classifying a table wipe every store's read cache. The lock
   * still records it, so an un-enrolment (a class removed or changed) is a reviewable diff.
   *
   * Optional because a committed lock is JSON on disk: one written before this field existed simply has no
   * `rowClasses`, and the diff then reads the whole baseline as unclassified — so adopting classification
   * against an old lock is a set of `compatible` declarations, never spurious risk. {@link buildRegistryLock}
   * always populates it.
   */
  rowClasses?: RegistryRowClasses;
  /**
   * Each registered Event stream (ADR-0053 decision 1), keyed by Event-stream name → a canonical hash of its
   * payload schema AND its identity declaration. A SIBLING of `tables` for the same reason `rowClasses` is:
   * the canonical table shape is what `fingerprintRegistry` hashes and that hash is the local store's
   * PERSISTED cache key, so folding an Event stream into it would make registering one wipe every store's read
   * cache — for a lane that touches no synced table, no local schema and no apply function.
   *
   * Optional because a committed lock is JSON on disk: one written before this field existed simply has no
   * `streams`, and the diff then reads the whole baseline as having none — so adopting the Event lane against
   * an old lock is a set of `compatible` additions, never spurious risk. {@link buildRegistryLock} always
   * populates it.
   */
  streams?: RegistryEventStreams;
}

/** Registry key → row class (`null` = unclassified). See {@link RegistryLock.rowClasses}. */
export type RegistryRowClasses = Record<string, string | null>;

/** Event-stream name → canonical contract hash. See {@link RegistryLock.streams}. */
export type RegistryEventStreams = Record<string, string>;

/** The row classification of every entry, with sorted keys so a serialized lock is stable. */
export function registryRowClasses(registry: SyncTableRegistry): RegistryRowClasses {
  const classes: RegistryRowClasses = {};
  for (const key of Object.keys(registry).sort()) {
    classes[key] = (registry[key] as SyncTableEntry | undefined)?.rowClass ?? null;
  }
  return classes;
}

/**
 * A stable JSON serialization with recursively SORTED object keys, so two structurally equal values
 * serialize identically regardless of key insertion order (`z.toJSONSchema`'s property order follows the
 * schema's declaration order, which an author may reshuffle without changing the contract).
 */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => asString(a, b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * The canonical string of ONE Event stream's contract: its payload schema (as a JSON Schema, stably
 * stringified), its identity declaration (field name → claim path, sorted), and its author-supplied
 * `revision`.
 *
 * The payload is converted with `io: "input"` because the schema is a PARSE contract (what a client may
 * append), and with `unrepresentable: "any"` so a schema using a type JSON Schema cannot express degrades to
 * a coarser canonical form instead of throwing at lock time — a lock build must never fail on a legal
 * registry. The cost of that choice is under-detection for such a type, which the next two paragraphs bound.
 *
 * **The blind spot is real and named.** JSON Schema cannot express a zod refinement or transform, so
 * `z.string().refine(v => v.length >= 3)` and the incompatible `>= 10` version canonicalize identically —
 * the hash sees no change and the review gate never fires. {@link EventStreamEntry.revision} is the fix and
 * it is the AUTHOR's obligation, exactly as `RowFilterSpec.revision` is for a `customWhere` closure: bump it
 * on any acceptance-logic change the JSON Schema cannot carry, and the stream's hash shifts.
 *
 * The hash exists to DETECT change, not to VALIDATE compatibility. ADR-0053 decision 1 binds a stream's
 * payload schema to backward-compatible evolution (events written offline under the old schema are still in
 * flight) and requires a NEW Event-stream name for an incompatible change — a rule no hash can check. All the
 * lock can do is force the change to be seen and reviewed, which is what the `risky` verdict is for.
 */
function canonicalEventStreamString(entry: EventStreamEntry): string {
  let payload: string;
  try {
    payload = stableStringify(z.toJSONSchema(entry.payload, { io: "input", unrepresentable: "any" }));
  } catch {
    // Defensive: an exotic schema `toJSONSchema` still refuses. A constant canonical form under-detects
    // change for that one stream rather than breaking every consumer's lock build.
    payload = '"<unrepresentable>"';
  }
  const identity = Object.keys(entry.identity ?? {})
    .sort(asString)
    .map((field) => [field, [...(entry.identity[field]?.claimPath ?? [])]]);
  // Absent === 0, so adopting `revision` on an unchanged stream by declaring `revision: 1` IS a change (as it
  // should be: an author only reaches for it because the invisible logic moved).
  return stableStringify({ payload, identity, revision: entry.revision ?? 0 });
}

/** The canonical contract hash of every registered Event stream, with sorted keys so a lock is stable. */
export function registryEventStreams(registry: SyncTableRegistry): RegistryEventStreams {
  const streams = getSyncRegistryStreams(registry);
  const hashes: RegistryEventStreams = {};
  if (!streams) {
    return hashes;
  }
  for (const name of Object.keys(streams).sort(asString)) {
    const entry = streams[name];
    if (entry) {
      hashes[name] = hashString(canonicalEventStreamString(entry));
    }
  }
  return hashes;
}

const SEVERITY_RANK: Record<RegistryChangeSeverity, number> = { compatible: 0, risky: 1, breaking: 2 };

function maxSeverity(changes: readonly RegistryChange[]): RegistryChangeSeverity {
  return changes.reduce<RegistryChangeSeverity>(
    (worst, change) => (SEVERITY_RANK[change.severity] > SEVERITY_RANK[worst] ? change.severity : worst),
    "compatible",
  );
}

/**
 * Build the committed lock (fingerprint + canonical shape + row classification + Event streams) for a
 * registry.
 */
export function buildRegistryLock(registry: SyncTableRegistry): RegistryLock {
  return {
    version: fingerprintRegistry(registry),
    tables: canonicalizeRegistry(registry),
    rowClasses: registryRowClasses(registry),
    streams: registryEventStreams(registry),
  };
}

function diffTable(table: string, previous: CanonicalTable, next: CanonicalTable, changes: RegistryChange[]): void {
  const prevColumns = new Map(previous.columns.map((column) => [column.name, column]));
  const nextColumns = new Map(next.columns.map((column) => [column.name, column]));

  for (const [name, prevColumn] of prevColumns) {
    const nextColumn = nextColumns.get(name);
    if (!nextColumn) {
      // A rename appears as remove + add; both are breaking, which is the safe read.
      changes.push({ severity: "breaking", table, detail: `column removed: ${name}` });
      continue;
    }
    if (prevColumn.type !== nextColumn.type) {
      // Same name, different type: the silent-repurposing case the runtime cannot see.
      changes.push({
        severity: "breaking",
        table,
        detail: `column type changed: ${name} (${prevColumn.type} -> ${nextColumn.type})`,
      });
    }
    if (!prevColumn.notNull && nextColumn.notNull) {
      changes.push({ severity: "breaking", table, detail: `column became NOT NULL: ${name}` });
    } else if (prevColumn.notNull && !nextColumn.notNull) {
      changes.push({ severity: "compatible", table, detail: `column relaxed to nullable: ${name}` });
    }
  }

  for (const [name, nextColumn] of nextColumns) {
    if (prevColumns.has(name)) {
      continue;
    }
    const safe = !nextColumn.notNull || nextColumn.hasDefault;
    changes.push({
      severity: safe ? "compatible" : "breaking",
      table,
      detail: safe ? `column added: ${name}` : `NOT NULL column added without default: ${name}`,
    });
  }

  if (JSON.stringify(previous.primaryKey) !== JSON.stringify(next.primaryKey)) {
    changes.push({ severity: "breaking", table, detail: "primary key changed" });
  }
  if (JSON.stringify(previous.localPrimaryKey) !== JSON.stringify(next.localPrimaryKey)) {
    // The local identity the overlay + journal rows are keyed on; changing it orphans
    // any owed (un-acked) writes — the runtime cannot re-key them.
    changes.push({ severity: "breaking", table, detail: "local primary key changed" });
  }
  if (previous.mode !== next.mode) {
    changes.push({ severity: "risky", table, detail: `mode changed: ${previous.mode} -> ${next.mode}` });
  }
  diffProjection(table, previous.projection, next.projection, changes);
  diffShape(table, previous.shape, next.shape, changes);
  if ((previous.consistencyGroup ?? null) !== (next.consistencyGroup ?? null)) {
    // A group move re-keys the table's subscription-state row (ADR-0009 decision 2): the local cache
    // columns survive, but the subscription must reset so the table re-streams under its new group.
    changes.push({
      severity: "risky",
      table,
      detail: `consistency group changed: ${previous.consistencyGroup ?? "(singleton)"} -> ${next.consistencyGroup ?? "(singleton)"} (re-sync required)`,
    });
  }
  if (JSON.stringify(previous.managedFields) !== JSON.stringify(next.managedFields)) {
    // Managed-field governance changes how writes are constructed/owned; a returning client
    // with owed writes authored under the old governance needs a conscious re-sync.
    changes.push({ severity: "risky", table, detail: "managed fields changed (re-sync required)" });
  }
}

/**
 * Projection changes. Renaming the synced/overlay/journal tables orphans their
 * name-coupled local data (ADR-0006) → breaking; changing the omitted-column set changes
 * which columns exist locally → a re-sync (risky).
 */
function diffProjection(
  table: string,
  previous: CanonicalTable["projection"],
  next: CanonicalTable["projection"],
  changes: RegistryChange[],
): void {
  for (const key of ["syncedTable", "overlayTable", "journalTable"] as const) {
    if ((previous?.[key] ?? null) !== (next?.[key] ?? null)) {
      changes.push({ severity: "breaking", table, detail: `projection ${key} changed (orphans local data)` });
    }
  }
  if (JSON.stringify(previous?.omitColumns ?? null) !== JSON.stringify(next?.omitColumns ?? null)) {
    changes.push({ severity: "risky", table, detail: "omitted columns changed (re-sync required)" });
  }
}

/**
 * Shape changes. The Electric target (table/shapeKey/electricTable) and the row filter both
 * govern which rows stream; a change to either needs a re-sync so the local cache is not left
 * holding rows selected under the old definition (risky). The row filter's `customWhere` body
 * is invisible to the fingerprint, so a change confined to it is not detectable here.
 */
function diffShape(
  table: string,
  previous: CanonicalTable["shape"],
  next: CanonicalTable["shape"],
  changes: RegistryChange[],
): void {
  const target = (shape: CanonicalTable["shape"]): string | null =>
    shape ? `${shape.tableName}|${shape.shapeKey}|${shape.electricTable ?? ""}` : null;

  if (target(previous) !== target(next)) {
    changes.push({ severity: "risky", table, detail: "shape target changed (re-sync required)" });
  }
  if (JSON.stringify(previous?.rowFilter ?? null) !== JSON.stringify(next?.rowFilter ?? null)) {
    changes.push({ severity: "risky", table, detail: "row filter changed (re-sync required)" });
  }
}

/**
 * Row-classification changes (ADR-0052). Classification is authoring metadata, invisible to the runtime and
 * to the fingerprint — but it decides which registry invariants an entry is ENROLLED in, so a change to it
 * is exactly the kind of quiet authoring drift the gate exists to surface.
 *
 * - class → different class: `risky` (the entry left one invariant's coverage and joined another's).
 * - unclassified → classified: `compatible` (pure adoption; nothing loses coverage).
 * - classified → unclassified: `risky` (the entry un-enrols from every invariant bound to that class).
 */
function diffRowClass(table: string, previous: string | null, next: string | null, changes: RegistryChange[]): void {
  if (previous === next) {
    return;
  }
  if (previous == null) {
    changes.push({ severity: "compatible", table, detail: `row class declared: ${next}` });
    return;
  }
  if (next == null) {
    changes.push({
      severity: "risky",
      table,
      detail: `row class removed: ${previous} (un-enrols from registry invariants)`,
    });
    return;
  }
  changes.push({
    severity: "risky",
    table,
    detail: `row class changed: ${previous} -> ${next} (review invariant enrollment)`,
  });
}

/**
 * Event-stream changes (ADR-0053 decision 1). The Event lane is invisible to the fingerprint, so the lock is
 * the ONLY place a change to it can surface.
 *
 * - added → `compatible` (a new Event stream takes nothing away; a client that does not know it appends
 *   nothing to it).
 * - removed → `breaking`. Events for it are already durable in some clients' Outboxes, and a server that no
 *   longer knows the stream can only park them (`deferred`, retried forever) or refuse them — the removal is
 *   a deliberate release decision, exactly what the gate exists to force.
 * - payload/identity hash changed → `risky`. The hash cannot judge compatibility (see
 *   {@link canonicalEventStreamString}); the rule it enforces socially is the ADR's: evolve only
 *   backward-compatibly, and take a NEW Event-stream name for anything else.
 */
function diffEventStreams(previous: RegistryEventStreams, next: RegistryEventStreams, changes: RegistryChange[]): void {
  for (const name of Object.keys(previous).sort(asString)) {
    const nextHash = next[name];
    if (nextHash === undefined) {
      changes.push({
        severity: "breaking",
        table: name,
        detail: `event stream removed: ${name} (in-flight client events will be deferred/refused)`,
      });
      continue;
    }
    if (previous[name] !== nextHash) {
      changes.push({
        severity: "risky",
        table: name,
        detail:
          `event stream ${name} payload/identity changed (must remain backward-compatible; ` +
          `incompatible change requires a new Event-stream name)`,
      });
    }
  }

  for (const name of Object.keys(next).sort(asString)) {
    if (!(name in previous)) {
      changes.push({ severity: "compatible", table: name, detail: `event stream added: ${name}` });
    }
  }
}

/**
 * Classify the change from one canonical registry shape to another. `rowClasses` carries each side's row
 * classification (ADR-0052) and `streams` each side's Event-stream contract hashes (ADR-0053) — both siblings
 * of the canonical tables, never fields of them (see {@link RegistryLock.rowClasses} /
 * {@link RegistryLock.streams}). An omitted side reads as entirely unclassified / streamless, which is how a
 * lock predating either field diffs as adoption rather than as spurious risk.
 *
 * `RegistryChange.table` names the SUBJECT of the change, which for an Event-stream change is the
 * Event-stream name rather than a registry table key; each such `detail` says "event stream …" so the
 * summary line stays unambiguous.
 */
export function diffCanonicalRegistries(
  previous: readonly CanonicalTable[],
  next: readonly CanonicalTable[],
  rowClasses?: { previous?: RegistryRowClasses | undefined; next?: RegistryRowClasses | undefined },
  streams?: { previous?: RegistryEventStreams | undefined; next?: RegistryEventStreams | undefined },
): RegistryDiff {
  const changes: RegistryChange[] = [];
  const prevByKey = new Map(previous.map((table) => [table.key, table]));
  const nextByKey = new Map(next.map((table) => [table.key, table]));
  const prevClasses = rowClasses?.previous ?? {};
  const nextClasses = rowClasses?.next ?? {};

  for (const [key, prevTable] of prevByKey) {
    const nextTable = nextByKey.get(key);
    if (!nextTable) {
      changes.push({ severity: "breaking", table: key, detail: "table removed" });
      continue;
    }
    diffTable(key, prevTable, nextTable, changes);
    diffRowClass(key, prevClasses[key] ?? null, nextClasses[key] ?? null, changes);
  }

  for (const key of nextByKey.keys()) {
    if (!prevByKey.has(key)) {
      changes.push({ severity: "compatible", table: key, detail: "table added" });
    }
  }

  diffEventStreams(streams?.previous ?? {}, streams?.next ?? {}, changes);

  return { changes, severity: maxSeverity(changes) };
}

/** Classify the change between two registries. */
export function compareRegistries(previous: SyncTableRegistry, next: SyncTableRegistry): RegistryDiff {
  return diffCanonicalRegistries(
    canonicalizeRegistry(previous),
    canonicalizeRegistry(next),
    { previous: registryRowClasses(previous), next: registryRowClasses(next) },
    { previous: registryEventStreams(previous), next: registryEventStreams(next) },
  );
}

/** Classify a registry against a committed lock baseline. */
export function diffRegistryAgainstLock(registry: SyncTableRegistry, lock: RegistryLock): RegistryDiff {
  return diffCanonicalRegistries(
    lock.tables,
    canonicalizeRegistry(registry),
    { previous: lock.rowClasses, next: registryRowClasses(registry) },
    { previous: lock.streams, next: registryEventStreams(registry) },
  );
}

/**
 * The consumer-facing check: `ok` is false on a breaking diff. The consumer wires the
 * exit code (e.g. `process.exit(result.ok ? 0 : 1)`) into their own CI — pgxsinkit does
 * not reach into anyone's pipeline.
 */
export function runRegistryCheck(input: { registry: SyncTableRegistry; lock: RegistryLock }): {
  ok: boolean;
  diff: RegistryDiff;
} {
  const diff = diffRegistryAgainstLock(input.registry, input.lock);
  return { ok: diff.severity !== "breaking", diff };
}

/** A human-readable, stable summary of a diff (one line per change). */
export function summarizeRegistryDiff(diff: RegistryDiff): string {
  if (diff.changes.length === 0) {
    return "no registry changes";
  }
  return diff.changes.map((change) => `[${change.severity}] ${change.table}: ${change.detail}`).join("\n");
}
