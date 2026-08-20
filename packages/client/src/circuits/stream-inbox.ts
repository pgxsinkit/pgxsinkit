import type { ChangeLike } from "./envelope-to-change";

/** One delivery held for commit, with the offset that acknowledges it on its own stream. */
export interface BufferedBatch {
  changes: ChangeLike[];
  offset: string;
}

/**
 * The staging buffer between K durable-streams subscriptions and the applier — the offset-keyed
 * successor to the LSN-keyed `ShapeInbox` (ADR-0056).
 *
 * Three things it deliberately no longer has, each because the reason for it was Electric-shaped:
 *
 * **No commit floor.** ADR-0031's floor existed to work around a *cached catch-up body* asserting a
 * stale `global_last_seen_lsn`: a quiet shape's cacheable response could claim a watermark captured
 * before a busy sibling's writes, holding delivered changes buffered until that shape's first live
 * poll. Durable-streams carries up-to-date as a **response header on a live request**, and returns
 * `204` with it set on every long-poll timeout, so a quiet shape re-asserts freshness each cycle.
 * The failure mode the floor compensated for cannot occur, so the floor is deleted rather than
 * ported.
 *
 * **No cross-shape position comparison.** Offsets are per-stream and, per the protocol, comparable
 * only within a stream. So the commit gate is not a `min` over positions but a predicate over
 * reports: commit when **every** shape's most recent response asserted up-to-date. That is the same
 * happens-before argument ADR-0056 makes for alignment, applied per commit — every stream has
 * drained everything the server held, so no cross-shape transaction can be half-applied.
 *
 * **No snapshot-acceptance flag.** It existed because a re-snapshot's rows floored to LSN 0 while
 * the frontier might already sit high. A reset here rewinds the applied offset to nothing, and the
 * re-snapshot arrives at real offsets above it, so the problem does not arise.
 */
export class StreamInbox {
  /** Per shape: batches held for the next commit, in arrival order (which is stream order). */
  private readonly batches = new Map<string, BufferedBatch[]>();
  /**
   * Per shape: the offset already applied and persisted. `null` until the first commit.
   *
   * The dedup threshold and the resume token are **the same value** (ADR-0056 decision 1), rather
   * than an LSN frontier plus an offset that could disagree.
   */
  private readonly appliedOffsets = new Map<string, string | null>();
  /** Per shape: whether its MOST RECENT response asserted up-to-date. The commit gate reads this. */
  private readonly currentlyUpToDate = new Map<string, boolean>();
  /** Per shape: whether it has EVER reported up-to-date since registration/reset. Boot alignment. */
  private readonly reportedUpToDate = new Map<string, boolean>();
  /** Per shape: reset epoch, so an ack from a commit that peeked before a must-refetch no-ops. */
  private readonly epochs = new Map<string, number>();
  /** Whether the one-time boot alignment has run for this registration/reset generation. */
  private alignedOnce = false;

  constructor(shapeNames: Iterable<string>) {
    for (const shapeName of shapeNames) {
      this.batches.set(shapeName, []);
      this.appliedOffsets.set(shapeName, null);
      this.currentlyUpToDate.set(shapeName, false);
      this.reportedUpToDate.set(shapeName, false);
      this.epochs.set(shapeName, 0);
    }
  }

  /**
   * Buffer one delivery.
   *
   * A batch at or below the applied offset is already applied and dropped. The comparison is
   * lexicographic, which the protocol explicitly sanctions **within a stream** (offsets are opaque
   * but lexicographically sortable and strictly increasing) and equally explicitly does not sanction
   * across streams — which is why nothing here ever compares two shapes' offsets.
   */
  ingestBatch(shapeName: string, changes: ChangeLike[], offset: string, upToDate: boolean): void {
    this.currentlyUpToDate.set(shapeName, upToDate);
    if (upToDate) this.reportedUpToDate.set(shapeName, true);

    const applied = this.appliedOffsets.get(shapeName) ?? null;
    if (applied !== null && offset <= applied) return;

    // An up-to-date response with no envelopes still advances the position — that is what a `204`
    // long-poll timeout is — so it is buffered rather than discarded, and the empty batch carries the
    // offset forward on the next commit.
    this.batches.get(shapeName)?.push({ changes, offset });
  }

  /**
   * The commit gate: every shape's most recent response asserted up-to-date.
   *
   * This is the whole steady-state condition. It is stronger than it looks — a shape mid-catch-up
   * reports `false`, so a group never commits while any member is still draining backfill.
   */
  isGroupUpToDate(): boolean {
    for (const upToDate of this.currentlyUpToDate.values()) {
      if (!upToDate) return false;
    }
    return true;
  }

  /** Whether every shape has reported up-to-date at least once — boot alignment's precondition. */
  everyShapeReported(): boolean {
    for (const reported of this.reportedUpToDate.values()) {
      if (!reported) return false;
    }
    return true;
  }

  /**
   * Whether the one-time boot alignment still has to run. Alignment additionally requires the engine
   * barrier (ADR-0056 decision 3) — `pendingFlips > 0` with every stream up-to-date is a computed
   * revocation the engine has not yet delivered, and a boot that claimed consistency there would
   * present a store missing an eviction.
   */
  needsAlignment(): boolean {
    return !this.alignedOnce;
  }

  /** Record that the barrier was satisfied and the group aligned. One-time per reset generation. */
  markAligned(): void {
    this.alignedOnce = true;
  }

  hasBufferedChanges(): boolean {
    for (const held of this.batches.values()) {
      for (const batch of held) {
        if (batch.changes.length > 0) return true;
      }
    }
    return false;
  }

  /** Whether any shape holds a batch at all, including the empty position-carrying ones. */
  hasBufferedBatches(): boolean {
    for (const held of this.batches.values()) {
      if (held.length > 0) return true;
    }
    return false;
  }

  epochFor(shapeName: string): number {
    return this.epochs.get(shapeName) ?? 0;
  }

  /** Snapshot every shape's epoch at peek time, to be handed back to {@link ackAll}. */
  snapshotEpochs(): Map<string, number> {
    return new Map([...this.epochs.keys()].map((shapeName) => [shapeName, this.epochFor(shapeName)]));
  }

  /**
   * Peek — without removing — everything held, per shape, in stream order.
   *
   * There is no target position to peek up to. The gate is "every shape has drained", so what is
   * held IS the complete unit: a partial peek could only ever split a batch the server sent whole.
   */
  peekAll(): Map<string, ChangeLike[]> {
    const peeked = new Map<string, ChangeLike[]>();
    for (const [shapeName, held] of this.batches.entries()) {
      peeked.set(
        shapeName,
        held.flatMap((batch) => batch.changes),
      );
    }
    return peeked;
  }

  /**
   * The offset each shape would resume from if the currently-held batches were committed — the last
   * buffered batch's offset, or the already-applied one where nothing is held.
   *
   * Persisted in the SAME transaction as the rows it acknowledges. Persisted ahead, a crash loses
   * the envelopes in between; persisted behind, they are re-delivered and re-applied. Only the
   * second is survivable.
   */
  pendingOffsets(): Map<string, string> {
    const offsets = new Map<string, string>();
    for (const [shapeName, held] of this.batches.entries()) {
      const last = held.length > 0 ? held[held.length - 1]!.offset : null;
      const offset = last ?? this.appliedOffsets.get(shapeName) ?? null;
      if (offset !== null) offsets.set(shapeName, offset);
    }
    return offsets;
  }

  /**
   * Drop everything peeked and advance each shape's applied offset — call only after the commit that
   * consumed a matching {@link peekAll} succeeded.
   *
   * A shape whose epoch changed since the peek is skipped entirely: a must-refetch landing
   * mid-commit replaced its buffer with post-reset content that this commit never saw, and acking it
   * would discard the rebuild.
   */
  ackAll(epochsAtPeek: Map<string, number>): void {
    for (const [shapeName, held] of this.batches.entries()) {
      const peekEpoch = epochsAtPeek.get(shapeName);
      if (peekEpoch !== undefined && this.epochFor(shapeName) !== peekEpoch) continue;
      const last = held.length > 0 ? held[held.length - 1]!.offset : null;
      if (last !== null) this.appliedOffsets.set(shapeName, last);
      this.batches.set(shapeName, []);
    }
  }

  /** The offset a shape has applied and persisted, or `null` before its first commit. */
  appliedOffsetFor(shapeName: string): string | null {
    return this.appliedOffsets.get(shapeName) ?? null;
  }

  /**
   * Reset a shape on must-refetch: drop its buffer, rewind it to the start of its stream, and re-arm
   * the group's alignment so the barrier is consulted again once every shape has re-reported.
   */
  resetShape(shapeName: string): void {
    this.batches.set(shapeName, []);
    this.appliedOffsets.set(shapeName, null);
    this.currentlyUpToDate.set(shapeName, false);
    this.reportedUpToDate.set(shapeName, false);
    this.alignedOnce = false;
    this.epochs.set(shapeName, this.epochFor(shapeName) + 1);
  }
}
