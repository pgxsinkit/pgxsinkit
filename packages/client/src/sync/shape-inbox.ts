import type { ChangeMessage, Row } from "@electric-sql/client";

import type { Lsn } from "./types";

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

  constructor(shapeNames: Iterable<string>) {
    for (const shapeName of shapeNames) {
      this.changes.set(shapeName, new Map());
      this.completeLsns.set(shapeName, BigInt(-1));
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

  /** Reset a shape on `must-refetch`: drop its buffer and rewind its frontier (the applier truncates). */
  resetShape(shapeName: string): void {
    this.changes.get(shapeName)?.clear();
    this.completeLsns.set(shapeName, BigInt(-1));
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
