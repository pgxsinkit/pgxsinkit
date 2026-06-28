import type { ChangeMessage, MovePattern, Row } from "@electric-sql/client";

import type { InsertChangeMessage, Lsn } from "./types";

/**
 * The Shape inbox (ADR-0014 / ISS-06): the pure, in-memory staging buffer between a shape's
 * Electric subscription and the Sync applier. It buffers each shape's change messages keyed by
 * LSN, tracks each shape's complete-LSN frontier, and drains everything up to a target LSN for the
 * applier to write. No database I/O lives here — that is exactly what makes it (and the ADR-0014
 * per-PK fold that will live here) property-testable against an ordered per-row apply oracle.
 *
 * One inbox owns all shapes in a consistency group; the group commits atomically at the lowest
 * complete frontier across its shapes ({@link lowestCompleteLsn}). `must-refetch` truncation stays
 * with the applier (the inbox only drops the affected shape's buffer via {@link resetShape}).
 */
export class ShapeInbox {
  // Per shape: buffered change messages keyed by their LSN, kept in arrival order within an LSN.
  private readonly changes = new Map<string, Map<Lsn, ChangeMessage<Row<unknown>>[]>>();
  // Per shape: the highest LSN known complete (every change at or below it has been received).
  private readonly completeLsns = new Map<string, Lsn>();
  // Per shape: buffered `move-out` events (ADR-0023), one pattern set per event. The event carries no
  // LSN, so it cannot key `changes`; it is drained and applied at the next commit (the `up-to-date`
  // that follows it), in the same transaction as that frontier's changes.
  private readonly moveOuts = new Map<string, MovePattern[][]>();

  constructor(shapeNames: Iterable<string>) {
    for (const shapeName of shapeNames) {
      this.changes.set(shapeName, new Map());
      this.completeLsns.set(shapeName, BigInt(-1));
      this.moveOuts.set(shapeName, []);
    }
  }

  /** The complete-LSN frontier for one shape (the already-seen dedup threshold). */
  completeLsnFor(shapeName: string): Lsn {
    return this.completeLsns.get(shapeName) ?? BigInt(-1);
  }

  /**
   * Buffer a change message. A message at or below the shape's current complete frontier is
   * already-seen and dropped. `isLastOfLsn` advances the frontier to this LSN.
   */
  ingestChange(shapeName: string, message: ChangeMessage<Row<unknown>>, lsn: Lsn, isLastOfLsn: boolean): void {
    if (lsn <= this.completeLsnFor(shapeName)) {
      return;
    }

    const shapeChanges = this.changes.get(shapeName);
    if (!shapeChanges) {
      return;
    }

    let lsnMessages = shapeChanges.get(lsn);
    if (!lsnMessages) {
      lsnMessages = [];
      shapeChanges.set(lsn, lsnMessages);
    }
    lsnMessages.push(message);

    if (isLastOfLsn) {
      this.completeLsns.set(shapeName, lsn);
    }
  }

  /** Advance the frontier on an `up-to-date` control message (carries no buffered change). */
  ingestUpToDate(shapeName: string, globalLastSeenLsn: Lsn): void {
    if (globalLastSeenLsn <= this.completeLsnFor(shapeName)) {
      return;
    }
    this.completeLsns.set(shapeName, globalLastSeenLsn);
  }

  /** Buffer a `move-out` event's patterns for a shape (ADR-0023); applied at the next commit. */
  ingestMoveOut(shapeName: string, patterns: MovePattern[]): void {
    this.moveOuts.get(shapeName)?.push(patterns);
  }

  /** Remove and return a shape's buffered `move-out` pattern sets (one per event), in arrival order. */
  drainMoveOuts(shapeName: string): MovePattern[][] {
    const pending = this.moveOuts.get(shapeName) ?? [];
    this.moveOuts.set(shapeName, []);
    return pending;
  }

  /** Whether any shape has a buffered `move-out` awaiting a commit. */
  hasPendingMoveOuts(): boolean {
    for (const pending of this.moveOuts.values()) {
      if (pending.length > 0) return true;
    }
    return false;
  }

  /** Reset a shape on `must-refetch`: drop its buffer and rewind its frontier (the applier truncates). */
  resetShape(shapeName: string): void {
    this.changes.get(shapeName)?.clear();
    this.completeLsns.set(shapeName, BigInt(-1));
    this.moveOuts.set(shapeName, []);
  }

  /** The lowest complete frontier across all shapes — the atomic group commit target. */
  lowestCompleteLsn(): Lsn {
    let minimum: Lsn | null = null;
    for (const lsn of this.completeLsns.values()) {
      if (minimum === null || lsn < minimum) {
        minimum = lsn;
      }
    }
    return minimum ?? BigInt(-1);
  }

  /**
   * Remove and return every buffered change at or below `targetLsn`, per shape, in buffered-LSN
   * order. The returned map has an entry for every shape (an empty array where nothing drained).
   */
  drainUpTo(targetLsn: Lsn): Map<string, ChangeMessage<Row<unknown>>[]> {
    const drained = new Map<string, ChangeMessage<Row<unknown>>[]>();

    for (const [shapeName, shapeChanges] of this.changes.entries()) {
      const messages: ChangeMessage<Row<unknown>>[] = [];
      for (const lsn of [...shapeChanges.keys()]) {
        if (lsn <= targetLsn) {
          for (const message of shapeChanges.get(lsn)!) {
            messages.push(message);
          }
          shapeChanges.delete(lsn);
        }
      }
      drained.set(shapeName, messages);
    }

    return drained;
  }
}

type Operation = "insert" | "update" | "delete";

/**
 * A drained shape batch folded to **one net operation per primary key** (ADR-0014 decision 1).
 * Each PK appears in at most one of `inserts`/`updates`, and at most once in `deletes` — except a
 * *re-created* PK (`[delete, insert]`), which appears in both `deletes` and `inserts` so the bulk
 * apply clears the pre-existing row before inserting the new one. The Sync applier therefore runs
 * three bulk statements **in the order `deletes → inserts → updates`** (Phase 3): that ordering is
 * what makes a re-create safe, and every other PK is touched by exactly one statement, so the rest
 * of the order is irrelevant within the atomic commit.
 */
export interface FoldedShapeBatch {
  /** PKs to delete — net-`delete` keys, plus the clearing delete of each re-created key. */
  deletes: ChangeMessage<Row<unknown>>[];
  /** Full rows to insert — net-`insert` keys, plus each re-created key's new row (merged values). */
  inserts: InsertChangeMessage[];
  /** Merged partial updates — net-`update` keys (carry the PK plus the union of updated columns). */
  updates: ChangeMessage<Row<unknown>>[];
}

/** Clone a representative message, overriding its row value and operation (headers like LSN are kept). */
function withValue(
  template: ChangeMessage<Row<unknown>>,
  value: Row<unknown>,
  operation: Operation,
): ChangeMessage<Row<unknown>> {
  return { ...template, value, headers: { ...template.headers, operation } };
}

/** Shallow-merge the row values of an ordered op segment, last-write-wins per column. */
function mergeValues(segment: ChangeMessage<Row<unknown>>[]): Row<unknown> {
  return Object.assign({}, ...segment.map((message) => message.value)) as Row<unknown>;
}

/**
 * Fold a drained shape batch (ordered by LSN, one shape) to one net operation per primary key
 * (ADR-0014 decision 1), so the read path can bulk-apply without the `UPDATE … FROM` / `INSERT …
 * SELECT json_to_recordset(…)` same-PK join hazard (those use **one arbitrary** matching row when
 * the source holds duplicate PKs). Each PK's ops are replayed in LSN order down to:
 *
 * - **trailing `delete`** ⇒ a single DELETE;
 * - **`insert` with no preceding delete**, then any updates ⇒ a single INSERT with merged values
 *   (a *plain* insert — a genuine PK collision still surfaces, never a silent upsert, commit `de12bb6`);
 * - **only `update`s** ⇒ a single UPDATE with merged values;
 * - **re-created** (`[delete, … , insert, …]`, no trailing delete) ⇒ DELETE **and** INSERT, so the
 *   pre-existing row is cleared first (faithful to the per-row `DELETE`-then-`INSERT`; a plain INSERT
 *   would collide with the row the dropped delete was meant to remove);
 * - **`update` after a delete** (`[delete, update]` and kin) is malformed for a faithful stream
 *   (an update asserts the row exists) ⇒ throw, surfacing stream corruption rather than silently
 *   dropping it.
 *
 * Pure and dependency-free by design (ADR-0014 / ISS-06): property-tested against the oracle
 * *fold-then-bulk ≡ ordered per-row apply* over random same-PK sequences and random initial state.
 */
export function foldChangeBatch(messages: ChangeMessage<Row<unknown>>[]): FoldedShapeBatch {
  const groups = new Map<string, ChangeMessage<Row<unknown>>[]>();
  for (const message of messages) {
    let group = groups.get(message.key);
    if (!group) {
      group = [];
      groups.set(message.key, group);
    }
    group.push(message);
  }

  const folded: FoldedShapeBatch = { deletes: [], inserts: [], updates: [] };
  for (const [key, ops] of groups) {
    foldKey(key, ops, folded);
  }
  return folded;
}

function foldKey(key: string, ops: ChangeMessage<Row<unknown>>[], folded: FoldedShapeBatch): void {
  const lastDeleteIndex = ops.findLastIndex((message) => message.headers.operation === "delete");

  // A trailing delete is the net effect regardless of anything before it; emit one DELETE.
  if (lastDeleteIndex === ops.length - 1) {
    folded.deletes.push(ops[lastDeleteIndex]!);
    return;
  }

  // The net is decided by the segment after the last delete (or the whole sequence if none).
  const segment = ops.slice(lastDeleteIndex + 1);
  const merged = mergeValues(segment);
  const template = segment[segment.length - 1]!;
  const startsWithInsert = segment[0]!.headers.operation === "insert";
  const hadDelete = lastDeleteIndex >= 0;

  if (startsWithInsert) {
    if (hadDelete) {
      // Re-created: clear the pre-existing row, then insert the new one (DELETE before INSERT).
      folded.deletes.push(ops[lastDeleteIndex]!);
    }
    folded.inserts.push(withValue(template, merged, "insert") as InsertChangeMessage);
    return;
  }

  if (hadDelete) {
    throw new Error(`foldChangeBatch: malformed batch — update after delete for key ${JSON.stringify(key)}`);
  }
  folded.updates.push(withValue(template, merged, "update"));
}
