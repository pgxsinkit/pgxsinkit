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
 *
 * COMMIT WATERMARK vs DEDUP FRONTIER (ADR-0031) — the load-bearing separation. Two per-shape LSNs live
 * here and they are deliberately NOT the same number:
 *
 *   - {@link completeLsns} — the SOLE dedup threshold. {@link ingestChange} drops any change at or below
 *     it as already-seen. Nothing else may narrow what the inbox accepts; a change below a shape's floor
 *     (below) but above its raw frontier is still buffered, never dropped.
 *   - {@link commitFloors} — a per-shape COMMIT watermark laid down once per catch-up completion (see
 *     {@link ingestUpToDate}'s alignment). It only ever RAISES a shape's effective commit frontier in
 *     {@link lowestCompleteLsn}; it never gates ingestion.
 *
 * Why the two must be separate: Electric's catch-up (non-live) shape responses are CDN-cacheable
 * (`s-maxage`, `stale-while-revalidate`), and the `up-to-date` control message — with its
 * `global_last_seen_lsn` watermark — rides INSIDE that cached body. So a quiet shape's cached catch-up
 * can assert a STALE watermark (captured before a busy sibling shape's newer writes), which drags the
 * group min-frontier below changes already delivered on the busy shape, holding them buffered until the
 * quiet shape's first LIVE long-poll returns a fresh watermark (~tens of seconds on Electric Cloud). The
 * alignment lifts the commit floors to the freshest ASSERTED global head so those changes commit at
 * catch-up completion — while the dedup frontier stays put, so a late sub-floor change from a shape whose
 * cached catch-up omitted it is still ingested and committed rather than dropped.
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
  // Per shape: buffered `move-in` snapshot rows (ADR-0024). A move-in row (`is_move_in`) is a row
  // ENTERING the shape; Electric delivers it as a snapshot insert with NO `lsn`/`last`, so it cannot
  // key `changes` either (and the change dedup, which floors a missing lsn to 0, would drop it once the
  // frontier passed 0). Drained and applied — idempotently — at the next commit, like the move-outs.
  private readonly moveIns = new Map<string, ChangeMessage<Row<unknown>>[]>();
  // Per shape: a reset epoch, bumped every time {@link resetShape} rewinds a shape (must-refetch). The
  // commit path records each shape's epoch at PEEK time and passes it back to the acks; an ack no-ops for
  // any shape whose epoch has since changed. This closes the mid-commit-reset hole: if a must-refetch +
  // re-snapshot arrives for shape B WHILE a commit that peeked B is in flight, B's frontier is rewound and
  // its buffers replaced with post-reset content; without the epoch guard the succeeding commit's
  // `ackUpTo`/`ackMove*` would delete/splice that never-peeked post-reset content, leaving B truncated-empty.
  private readonly epochs = new Map<string, number>();
  // Per shape: whether a snapshot (LSN-0) row is currently accepted PAST the dedup frontier. Set on
  // registration and every {@link resetShape} (must-refetch); re-armed (cleared) the first time a change
  // with a REAL lsn (> 0) is ingested for the shape. Invariant: after a reset — and on a brand-new shape
  // before any real replication LSN has been seen — a re-snapshot's rows are floored to LSN 0, yet the
  // frontier may already sit at a large LSN (a racing bare `up-to-date` advanced it before the rows
  // landed). The LSN-0 dedup ({@link ingestChange}) would then drop the whole re-snapshot. So while this
  // flag is set, LSN-0 rows bypass the dedup; the first real lsn (> 0) proves the stream has moved past
  // the snapshot into the live tail, and re-arms the dedup. The re-snapshot's rows reaching the applier
  // is what keeps the reconcile loop — the completeness guarantee (ADR-0029 D4) — whole.
  private readonly snapshotAccepted = new Map<string, boolean>();
  // Per shape: whether this shape has reported `up-to-date` at least once since registration / its last
  // {@link resetShape}. Set true in {@link ingestUpToDate} even when the reported watermark does NOT
  // advance the frontier (a stale cached watermark still means "this shape has completed a catch-up and
  // asserted a global head"). The catch-up alignment (ADR-0031) fires only once EVERY shape in the group
  // has reported up-to-date — i.e. once the whole group has a first asserted global head to align to.
  private readonly upToDateSeen = new Map<string, boolean>();
  // Per shape: the watermark (`global_last_seen_lsn`) this shape MOST RECENTLY reported via
  // {@link ingestUpToDate}, recorded unconditionally — even a stale cached watermark that does not
  // advance {@link completeLsns}. This is the input to the group-max alignment: the freshest asserted
  // global head across the group is `max` over these REPORTED watermarks (NOT over the frontiers — a
  // frontier can sit ahead of every reported watermark mid-live-batch; see {@link ingestUpToDate}).
  private readonly lastUpToDateLsn = new Map<string, Lsn>();
  // Per shape: the COMMIT floor (ADR-0031) — a watermark that only ever RAISES this shape's effective
  // commit frontier in {@link lowestCompleteLsn}, never its dedup threshold. Laid down once per catch-up
  // completion by the alignment in {@link ingestUpToDate}. Deliberately NOT reset by {@link resetShape}:
  // floors are monotonic, so a reset shape keeps its old floor (its buffer is empty anyway) until the
  // next group-wide realignment lifts it. Default -1 = no floor.
  private readonly commitFloors = new Map<string, Lsn>();
  // Whether the one-time catch-up commit-floor alignment (ADR-0031) has already run for the current
  // registration/reset generation. False at construction; set true when the alignment lays down floors in
  // {@link ingestUpToDate}; reset to false by {@link resetShape} so a must-refetch re-catch-up realigns
  // the group once every shape has completed again (a reset shape re-streams a fresh — possibly cached —
  // catch-up, so the group needs a fresh asserted global head to align to).
  private aligned = false;
  // The freshest asserted global head the last alignment aligned to (`max` over reported watermarks) —
  // surfaced on the debug rail by the caller as the `floor` of the `catch-up watermark aligned` line.
  private lastAlignedFloor: Lsn = BigInt(-1);

  constructor(shapeNames: Iterable<string>) {
    for (const shapeName of shapeNames) {
      this.changes.set(shapeName, new Map());
      this.completeLsns.set(shapeName, BigInt(-1));
      this.moveOuts.set(shapeName, []);
      this.moveIns.set(shapeName, []);
      this.epochs.set(shapeName, 0);
      this.snapshotAccepted.set(shapeName, true);
      this.upToDateSeen.set(shapeName, false);
      this.lastUpToDateLsn.set(shapeName, BigInt(-1));
      this.commitFloors.set(shapeName, BigInt(-1));
    }
  }

  /**
   * Whether the shape is still accepting snapshot (LSN-0) rows past the dedup frontier — true from
   * registration / the last {@link resetShape} until the first real-lsn change re-armed the dedup. The
   * commit path reads this to apply such rows idempotently (the racing recovery loops can double-deliver
   * them), consistent with the move-in upsert path, rather than as a plain collision-surfacing insert.
   */
  acceptsSnapshotRowsFor(shapeName: string): boolean {
    return this.snapshotAccepted.get(shapeName) === true;
  }

  /** The complete-LSN frontier for one shape (the already-seen dedup threshold). */
  completeLsnFor(shapeName: string): Lsn {
    return this.completeLsns.get(shapeName) ?? BigInt(-1);
  }

  /**
   * The shape's current reset epoch. The commit path snapshots this for every peeked shape and passes it
   * back to the acks, which no-op for any shape whose epoch changed (a mid-commit {@link resetShape}) so
   * the reset's own truncate+rebuild path owns that shape's post-reset state.
   */
  epochFor(shapeName: string): number {
    return this.epochs.get(shapeName) ?? 0;
  }

  /**
   * Buffer a change message. A message at or below the shape's current complete frontier is
   * already-seen and dropped. `isLastOfLsn` advances the frontier to this LSN.
   */
  ingestChange(shapeName: string, message: ChangeMessage<Row<unknown>>, lsn: Lsn, isLastOfLsn: boolean): void {
    // A real replication lsn (> 0) proves the stream has moved past the snapshot into the live tail:
    // re-arm the LSN-0 dedup for this shape (see {@link snapshotAccepted}).
    if (lsn > BigInt(0)) {
      this.snapshotAccepted.set(shapeName, false);
    }
    // A snapshot (LSN-0) row while snapshot acceptance is open bypasses the dedup even if the frontier
    // has advanced past 0 — otherwise a re-snapshot delivered AFTER a racing `up-to-date` (which pushed
    // the frontier to a large LSN) would be dropped wholesale, truncating the shape to empty. It still
    // buffers at LSN 0 (and does not advance the frontier), so drains/acks/truncate are unchanged.
    const acceptSnapshotRow = lsn === BigInt(0) && this.acceptsSnapshotRowsFor(shapeName);
    if (!acceptSnapshotRow && lsn <= this.completeLsnFor(shapeName)) {
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

  /** The commit floor (ADR-0031) for one shape — the aligned watermark; -1 when no floor has been laid. */
  commitFloorFor(shapeName: string): Lsn {
    return this.commitFloors.get(shapeName) ?? BigInt(-1);
  }

  /**
   * A shape's EFFECTIVE complete frontier (ADR-0031): `max(completeLsnFor(shape), commitFloorFor(shape))` —
   * the raw dedup frontier raised by any aligned commit floor. This is the exact per-shape quantity
   * {@link lowestCompleteLsn} minimizes over (both go through here, so the two definitions cannot drift),
   * and the input the live-tail sibling nudge reads to decide which siblings still lag a target LSN.
   */
  effectiveLsnFor(shapeName: string): Lsn {
    const raw = this.completeLsnFor(shapeName);
    const floor = this.commitFloorFor(shapeName);
    return raw > floor ? raw : floor;
  }

  /**
   * Whether this shape has reported `up-to-date` at least once since registration / its last
   * {@link resetShape} — the {@link upToDateSeen} flag. The live-tail sibling nudge (ADR-0031) reads this:
   * a shape still catching up advances on its own, so only a shape already in its live tail is ever nudged.
   */
  hasReportedUpToDate(shapeName: string): boolean {
    return this.upToDateSeen.get(shapeName) === true;
  }

  /** The freshest asserted global head the last catch-up alignment aligned to (ADR-0031); -1 if never aligned. */
  alignedFloor(): Lsn {
    return this.lastAlignedFloor;
  }

  /**
   * Advance the frontier on an `up-to-date` control message (carries no buffered change) AND run the
   * one-time catch-up commit-floor alignment (ADR-0031) once the whole group has reported up-to-date.
   *
   * Returns `true` iff THIS call performed the alignment (the caller emits a single diagnostic line on
   * that transition); `false` on every other call.
   */
  ingestUpToDate(shapeName: string, globalLastSeenLsn: Lsn): boolean {
    // Record the report unconditionally: this shape has now completed a catch-up and asserted a global
    // head, and this is the watermark to align to — even if it is stale (below the frontier) and so does
    // NOT advance the dedup frontier below. Both facts feed the alignment; neither is the frontier.
    this.upToDateSeen.set(shapeName, true);
    this.lastUpToDateLsn.set(shapeName, globalLastSeenLsn);

    // The existing conditional frontier advance is UNCHANGED: a watermark only advances the dedup frontier
    // when it is strictly ahead of it. A stale cached watermark leaves the frontier where it was.
    if (globalLastSeenLsn > this.completeLsnFor(shapeName)) {
      this.completeLsns.set(shapeName, globalLastSeenLsn);
    }

    // Catch-up commit-floor alignment (ADR-0031), one-time per registration/reset generation: once EVERY
    // shape in the group has reported up-to-date, lift each shape's commit floor to the freshest asserted
    // global head. That is `max` over the REPORTED watermarks ({@link lastUpToDateLsn}) — deliberately NOT
    // over the frontiers ({@link completeLsns}). A frontier can be ahead of every reported watermark when a
    // live change batch is in flight and its sibling shapes' halves have not arrived yet; aligning floors
    // to such a frontier would commit one shape's half of a cross-shape transaction ahead of the other's
    // (a torn write). The freshest asserted global head is a watermark every shape has been told is
    // complete, so aligning to it can never tear a transaction that is still assembling above it.
    if (!this.aligned) {
      let everySeen = true;
      for (const seen of this.upToDateSeen.values()) {
        if (!seen) {
          everySeen = false;
          break;
        }
      }
      if (everySeen) {
        let groupMax: Lsn = BigInt(-1);
        for (const reported of this.lastUpToDateLsn.values()) {
          if (reported > groupMax) {
            groupMax = reported;
          }
        }
        for (const shape of this.commitFloors.keys()) {
          const existing = this.commitFloorFor(shape);
          this.commitFloors.set(shape, groupMax > existing ? groupMax : existing);
        }
        this.aligned = true;
        this.lastAlignedFloor = groupMax;
        return true;
      }
    }
    return false;
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

  /**
   * Peek — WITHOUT removing — a shape's buffered `move-out` pattern sets (a copy, arrival order). Pairs
   * with {@link ackMoveOuts}: the commit path peeks, applies inside its transaction, and acks (removes)
   * only after the transaction succeeds — so a failed/degraded commit (ADR-0009 decision 5) leaves the
   * revocations buffered rather than silently losing them.
   */
  peekMoveOuts(shapeName: string): MovePattern[][] {
    return [...(this.moveOuts.get(shapeName) ?? [])];
  }

  /**
   * Remove the first `count` buffered `move-out` pattern sets for a shape (call only after the commit
   * that consumed a matching {@link peekMoveOuts} of that many entries succeeded). Removing exactly the
   * peeked count — not clear-all — keeps any move-out that arrived DURING the commit (coalescing path)
   * buffered for the next run. `epochAtPeek` is the shape's {@link epochFor} captured at peek time: if a
   * {@link resetShape} bumped it since, the peeked entries no longer exist (the array was replaced), so
   * this no-ops rather than splicing the post-reset replacement.
   */
  ackMoveOuts(shapeName: string, count: number, epochAtPeek: number): void {
    if (this.epochFor(shapeName) !== epochAtPeek) {
      return;
    }
    this.moveOuts.get(shapeName)?.splice(0, count);
  }

  /** Whether any shape has a buffered `move-out` awaiting a commit. */
  hasPendingMoveOuts(): boolean {
    for (const pending of this.moveOuts.values()) {
      if (pending.length > 0) return true;
    }
    return false;
  }

  /** Buffer a `move-in` snapshot row for a shape (ADR-0024); applied idempotently at the next commit. */
  ingestMoveIn(shapeName: string, message: ChangeMessage<Row<unknown>>): void {
    this.moveIns.get(shapeName)?.push(message);
  }

  /** Remove and return a shape's buffered `move-in` snapshot rows, in arrival order. */
  drainMoveIns(shapeName: string): ChangeMessage<Row<unknown>>[] {
    const pending = this.moveIns.get(shapeName) ?? [];
    this.moveIns.set(shapeName, []);
    return pending;
  }

  /** Peek — WITHOUT removing — a shape's buffered `move-in` snapshot rows (a copy, arrival order). See {@link peekMoveOuts}. */
  peekMoveIns(shapeName: string): ChangeMessage<Row<unknown>>[] {
    return [...(this.moveIns.get(shapeName) ?? [])];
  }

  /**
   * Remove the first `count` buffered `move-in` snapshot rows for a shape (post-commit ack; see
   * {@link ackMoveOuts}). No-ops if `epochAtPeek` no longer matches the shape's current epoch (a
   * mid-commit {@link resetShape}), so the post-reset replacement rows survive.
   */
  ackMoveIns(shapeName: string, count: number, epochAtPeek: number): void {
    if (this.epochFor(shapeName) !== epochAtPeek) {
      return;
    }
    this.moveIns.get(shapeName)?.splice(0, count);
  }

  /** Whether any shape has a buffered `move-in` awaiting a commit. */
  hasPendingMoveIns(): boolean {
    for (const pending of this.moveIns.values()) {
      if (pending.length > 0) return true;
    }
    return false;
  }

  /** Reset a shape on `must-refetch`: drop its buffer and rewind its frontier (the applier truncates). */
  resetShape(shapeName: string): void {
    this.changes.get(shapeName)?.clear();
    this.completeLsns.set(shapeName, BigInt(-1));
    this.moveOuts.set(shapeName, []);
    this.moveIns.set(shapeName, []);
    // Re-open snapshot acceptance: the re-snapshot's LSN-0 rows must survive the dedup even if a racing
    // `up-to-date` advances the rewound frontier again before they arrive (see {@link snapshotAccepted}).
    this.snapshotAccepted.set(shapeName, true);
    // ADR-0031: this shape must re-report up-to-date before it counts toward the group again, and its
    // last reported watermark is void (it re-streams a fresh — possibly cached — catch-up). Clear the
    // group's aligned flag so the whole group realigns once every shape has completed again. The commit
    // floor is NOT cleared: floors are monotonic (the buffer is empty post-reset anyway), so the shape
    // keeps its old floor until realignment lifts it.
    this.upToDateSeen.set(shapeName, false);
    this.lastUpToDateLsn.set(shapeName, BigInt(-1));
    this.aligned = false;
    // Bump the epoch so any in-flight commit that peeked this shape BEFORE the reset skips its acks — the
    // post-reset buffers just installed above must survive to be committed on the follow-up pass.
    this.epochs.set(shapeName, this.epochFor(shapeName) + 1);
  }

  /**
   * The lowest EFFECTIVE complete frontier across all shapes — the atomic group commit target. A shape's
   * effective frontier is `max(completeLsnFor(shape), commitFloorFor(shape))` (ADR-0031): the raw dedup
   * frontier, raised by any aligned commit floor. Aligning the floors up to the freshest asserted global
   * head lets a group whose quiet shapes reported a STALE cached catch-up watermark still commit a busy
   * shape's delivered changes at catch-up completion, instead of holding them until the quiet shapes'
   * first live long-poll. The floor never narrows what {@link ingestChange} accepts (that remains the raw
   * {@link completeLsns}), so a late sub-floor change is still ingested and then committed.
   */
  lowestCompleteLsn(): Lsn {
    let minimum: Lsn | null = null;
    for (const shapeName of this.completeLsns.keys()) {
      const effective = this.effectiveLsnFor(shapeName);
      if (minimum === null || effective < minimum) {
        minimum = effective;
      }
    }
    return minimum ?? BigInt(-1);
  }

  /**
   * Whether any shape has a buffered change entry at an LSN at or below `targetLsn` (ADR-0031). The commit
   * loop uses this to fire a commit for a LATE-arriving change that lands at or below an already-committed
   * target — possible exactly because the aligned commit floor lets {@link ingestChange} accept a change
   * below the floor while the group frontier already sits at (or above) it, so no new frontier advance
   * would otherwise trigger a commit for it.
   */
  hasBufferedChangesAtOrBelow(targetLsn: Lsn): boolean {
    for (const shapeChanges of this.changes.values()) {
      for (const lsn of shapeChanges.keys()) {
        if (lsn <= targetLsn) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Peek — WITHOUT removing — every buffered change at or below `targetLsn`, per shape, in buffered-LSN
   * order. The returned map has an entry for every shape (an empty array where nothing peeked). Pairs
   * with {@link ackUpTo}: the commit path peeks, writes the batch inside its transaction, and acks
   * (removes) only after the transaction succeeds — so a failed/degraded commit (ADR-0009 decision 5)
   * holds the batch in the buffer rather than dropping it, and a newer LSN can never land over it.
   */
  peekUpTo(targetLsn: Lsn): Map<string, ChangeMessage<Row<unknown>>[]> {
    const peeked = new Map<string, ChangeMessage<Row<unknown>>[]>();

    for (const [shapeName, shapeChanges] of this.changes.entries()) {
      const messages: ChangeMessage<Row<unknown>>[] = [];
      for (const lsn of [...shapeChanges.keys()]) {
        if (lsn <= targetLsn) {
          for (const message of shapeChanges.get(lsn)!) {
            messages.push(message);
          }
        }
      }
      peeked.set(shapeName, messages);
    }

    return peeked;
  }

  /**
   * Remove every buffered change at or below `targetLsn` (call only after the commit that consumed a
   * matching {@link peekUpTo} succeeded). `epochsAtPeek` maps each shape to its {@link epochFor} captured
   * at peek time; a shape whose epoch has since changed is **skipped entirely**.
   *
   * The epoch guard is load-bearing under a frontier REWIND. In the steady state, the frontier only
   * advances, so nothing new at or below `targetLsn` can be buffered between peek and ack. But a mid-commit
   * {@link resetShape} (must-refetch) rewinds a shape's frontier to -1 and lets its re-snapshot buffer at
   * LSN 0 — content that was NOT in this commit's peek. Deleting it here (LSN 0 ≤ `targetLsn`) would drop
   * the rebuild; the epoch bump makes this no-op for that shape so the reset's own rebuild path owns it.
   */
  ackUpTo(targetLsn: Lsn, epochsAtPeek: Map<string, number>): void {
    for (const [shapeName, shapeChanges] of this.changes.entries()) {
      const peekEpoch = epochsAtPeek.get(shapeName);
      if (peekEpoch !== undefined && this.epochFor(shapeName) !== peekEpoch) {
        continue;
      }
      for (const lsn of [...shapeChanges.keys()]) {
        if (lsn <= targetLsn) {
          shapeChanges.delete(lsn);
        }
      }
    }
  }

  /** Snapshot every shape's current {@link epochFor} — captured at peek time and passed to the acks. */
  snapshotEpochs(): Map<string, number> {
    return new Map([...this.epochs.keys()].map((shapeName) => [shapeName, this.epochFor(shapeName)]));
  }

  /**
   * Remove and return every buffered change at or below `targetLsn`, per shape, in buffered-LSN order
   * ({@link peekUpTo} then {@link ackUpTo}). The returned map has an entry for every shape (an empty
   * array where nothing drained).
   */
  drainUpTo(targetLsn: Lsn): Map<string, ChangeMessage<Row<unknown>>[]> {
    const epochsAtPeek = this.snapshotEpochs();
    const drained = this.peekUpTo(targetLsn);
    this.ackUpTo(targetLsn, epochsAtPeek);
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
 *   (a *plain* insert — a genuine PK collision still surfaces, never a silent upsert);
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
