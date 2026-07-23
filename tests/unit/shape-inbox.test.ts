import { describe, expect, it } from "bun:test";

import { ShapeInbox } from "../../packages/client/src/sync/shape-inbox";

// The change-message type, derived from the inbox signature so the test does not depend on
// `@electric-sql/client` resolving from the tests/ scope (it is hoisted under packages/client).
type InboxChange = Parameters<ShapeInbox["ingestChange"]>[1];

function changeMessage(
  shape: string,
  lsn: bigint,
  isLastOfLsn: boolean,
  operation: "insert" | "update" | "delete" = "insert",
  id = "x",
): InboxChange {
  return {
    shape,
    key: `${shape}/${id}`,
    value: { id },
    headers: { operation, lsn: String(lsn), last: isLastOfLsn },
  } as unknown as InboxChange;
}

describe("ShapeInbox (ADR-0014 / ISS-06)", () => {
  it("buffers changes per shape and advances the frontier only on isLastOfLsn", () => {
    const inbox = new ShapeInbox(["a", "b"]);
    expect(inbox.completeLsnFor("a")).toBe(-1n);

    inbox.ingestChange("a", changeMessage("a", 10n, false), 10n, false);
    expect(inbox.completeLsnFor("a")).toBe(-1n); // not the last of its LSN → frontier unchanged
    expect(inbox.completeLsnFor("b")).toBe(-1n); // a sibling shape is unaffected

    inbox.ingestChange("a", changeMessage("a", 10n, true), 10n, true);
    expect(inbox.completeLsnFor("a")).toBe(10n);
  });

  it("drops already-seen changes at or below the frontier", () => {
    const inbox = new ShapeInbox(["a"]);
    inbox.ingestChange("a", changeMessage("a", 10n, true), 10n, true);
    // A re-delivery at the same (now complete) LSN is already-seen and dropped.
    inbox.ingestChange("a", changeMessage("a", 10n, true, "update"), 10n, true);

    expect(inbox.drainUpTo(10n).get("a")).toHaveLength(1);
  });

  it("drains only up to the target LSN, leaving later LSNs buffered", () => {
    const inbox = new ShapeInbox(["a"]);
    inbox.ingestChange("a", changeMessage("a", 5n, true), 5n, true);
    inbox.ingestChange("a", changeMessage("a", 20n, true), 20n, true);

    expect(inbox.drainUpTo(10n).get("a")).toHaveLength(1); // only LSN 5
    expect(inbox.drainUpTo(20n).get("a")).toHaveLength(1); // then LSN 20
    expect(inbox.drainUpTo(20n).get("a")).toHaveLength(0); // nothing left
  });

  it("advances the frontier on up-to-date without buffering a change", () => {
    const inbox = new ShapeInbox(["a"]);
    inbox.ingestUpToDate("a", 30n);

    expect(inbox.completeLsnFor("a")).toBe(30n);
    expect(inbox.drainUpTo(30n).get("a")).toHaveLength(0);
  });

  it("reports the lowest complete frontier across the group (the slowest shape), before alignment", () => {
    const inbox = new ShapeInbox(["a", "b"]);
    // Only shape a has reported up-to-date; b has not, so the one-time ADR-0031 alignment has NOT fired.
    // The group commit target is the slowest shape's raw frontier — b's -1 (it has reported nothing).
    inbox.ingestUpToDate("a", 50n);
    expect(inbox.lowestCompleteLsn()).toBe(-1n);

    // Once b also reports up-to-date, every shape has completed a catch-up → the alignment lifts the floors
    // to the freshest asserted global head (max(50, 20) = 50), so the group can commit to 50. (Live-tail
    // "slowest shape" min-watermark gating resumes above the floor — see the ADR-0031 (c) case below.)
    inbox.ingestUpToDate("b", 20n);
    expect(inbox.lowestCompleteLsn()).toBe(50n);
  });

  it("resetShape drops the buffer and rewinds the frontier on must-refetch", () => {
    const inbox = new ShapeInbox(["a"]);
    inbox.ingestChange("a", changeMessage("a", 10n, true), 10n, true);

    inbox.resetShape("a");

    expect(inbox.completeLsnFor("a")).toBe(-1n);
    expect(inbox.drainUpTo(100n).get("a")).toHaveLength(0);
  });

  it("returns an entry for every shape on drain, even when nothing buffered", () => {
    const inbox = new ShapeInbox(["a", "b"]);
    inbox.ingestChange("a", changeMessage("a", 5n, true), 5n, true);

    const drained = inbox.drainUpTo(5n);
    expect(drained.get("a")).toHaveLength(1);
    expect(drained.get("b")).toHaveLength(0);
  });

  // F1 — the non-destructive peek/ack pair the degraded-commit fix relies on: the commit path PEEKS the
  // batch, writes it, and ACKs (removes) only after the transaction succeeds, so a failed commit holds
  // the batch rather than losing it.
  describe("peek / ack (F1 — non-destructive drain)", () => {
    it("peekUpTo returns the batch WITHOUT removing it; ackUpTo removes it", () => {
      const inbox = new ShapeInbox(["a"]);
      inbox.ingestChange("a", changeMessage("a", 5n, true), 5n, true);

      // A peek is repeatable — the batch is still buffered (this is what lets a degraded commit hold it).
      const epochs = inbox.snapshotEpochs();
      expect(inbox.peekUpTo(5n).get("a")).toHaveLength(1);
      expect(inbox.peekUpTo(5n).get("a")).toHaveLength(1);

      inbox.ackUpTo(5n, epochs);
      expect(inbox.peekUpTo(5n).get("a")).toHaveLength(0);
    });

    it("ackMoveOuts / ackMoveIns remove only the peeked count, keeping anything that arrived since", () => {
      const inbox = new ShapeInbox(["a"]);
      const epoch = inbox.epochFor("a");
      inbox.ingestMoveOut("a", [{ type: "and", patterns: [] }] as never);
      const peekedOut = inbox.peekMoveOuts("a");
      expect(peekedOut).toHaveLength(1);

      // A second move-out arrives DURING the (peeked) commit — the coalescing path.
      inbox.ingestMoveOut("a", [{ type: "or", patterns: [] }] as never);

      // Ack only the peeked count → the newly-arrived one survives for the next run.
      inbox.ackMoveOuts("a", peekedOut.length, epoch);
      expect(inbox.peekMoveOuts("a")).toHaveLength(1);

      inbox.ingestMoveIn("a", changeMessage("a", 0n, false, "insert", "in1"));
      const peekedIn = inbox.peekMoveIns("a");
      inbox.ingestMoveIn("a", changeMessage("a", 0n, false, "insert", "in2"));
      inbox.ackMoveIns("a", peekedIn.length, epoch);
      expect(inbox.peekMoveIns("a")).toHaveLength(1);
    });

    it("acks NO-OP for a shape reset (epoch bumped) between peek and ack — the rebuild survives (F1-R1)", () => {
      const inbox = new ShapeInbox(["a", "b"]);

      // Simulate a commit peeking BOTH shapes at their current epochs.
      inbox.ingestChange("a", changeMessage("a", 5n, true), 5n, true);
      inbox.ingestChange("b", changeMessage("b", 5n, true, "insert", "old"), 5n, true);
      inbox.ingestMoveOut("b", [{ type: "and", patterns: [] }] as never);
      inbox.ingestMoveIn("b", changeMessage("b", 0n, false, "insert", "movein-old"));
      const epochsAtPeek = inbox.snapshotEpochs();
      const bOutPeek = inbox.peekMoveOuts("b").length;
      const bInPeek = inbox.peekMoveIns("b").length;

      // Shape B gets a must-refetch + re-snapshot mid-commit: frontier rewinds, buffers replaced.
      inbox.resetShape("b");
      inbox.ingestChange("b", changeMessage("b", 0n, true, "insert", "rebuilt"), 0n, true);
      inbox.ingestMoveIn("b", changeMessage("b", 0n, false, "insert", "movein-new"));

      // The commit succeeds and acks with the peek-time epochs.
      inbox.ackUpTo(5n, epochsAtPeek);
      inbox.ackMoveOuts("b", bOutPeek, epochsAtPeek.get("b")!);
      inbox.ackMoveIns("b", bInPeek, epochsAtPeek.get("b")!);

      // Shape A (unchanged epoch) was acked normally; shape B's POST-RESET rebuild survives untouched.
      expect(inbox.peekUpTo(5n).get("a")).toHaveLength(0); // A drained
      const bRebuilt = inbox.peekUpTo(5n).get("b")!;
      expect(bRebuilt).toHaveLength(1);
      expect(bRebuilt[0]?.key).toBe("b/rebuilt");
      expect(inbox.peekMoveIns("b")).toHaveLength(1); // the post-reset move-in, not spliced away
      expect(inbox.peekMoveIns("b")[0]?.key).toBe("b/movein-new");
    });
  });

  // ADR-0031 — catch-up commit-floor alignment. Electric's non-live catch-up responses are CDN-cacheable
  // and carry the `up-to-date` watermark INSIDE the cached body, so a quiet shape can report a STALE
  // watermark that drags the group min-frontier below a busy shape's freshly-delivered changes. Once every
  // shape in the group has reported up-to-date, the inbox aligns each shape's COMMIT floor up to the
  // freshest asserted global head — a watermark that is separate from the dedup frontier.
  describe("catch-up commit-floor alignment (ADR-0031)", () => {
    it("(a) aligns floors to the group max once every shape has reported up-to-date", () => {
      const inbox = new ShapeInbox(["a", "b"]);

      // Shape A: a snapshot at 0, then a real change at 100 (its fresh catch-up), then up-to-date at 100.
      // Snapshot inserts carry no `last` header → isLastOfLsn=false: they DON'T advance the frontier.
      inbox.ingestChange("a", changeMessage("a", 0n, false, "insert", "a0"), 0n, false);
      inbox.ingestChange("a", changeMessage("a", 100n, true, "insert", "a100"), 100n, true);
      inbox.ingestUpToDate("a", 100n);

      // Shape B: only a snapshot at 0, then a STALE cached watermark at 40 (captured before A's writes).
      inbox.ingestChange("b", changeMessage("b", 0n, false, "insert", "b0"), 0n, false);
      // BEFORE B reports up-to-date, only A has been seen → no alignment yet; the group min is still B's
      // raw frontier (-1), and A's 100n change is held below it.
      expect(inbox.lowestCompleteLsn()).toBe(-1n);

      // B reports its stale watermark: this call completes the group (both seen) → alignment fires. The
      // group max over REPORTED watermarks is max(100, 40) = 100, so both floors lift to 100n.
      const aligned = inbox.ingestUpToDate("b", 40n);
      expect(aligned).toBe(true);
      expect(inbox.commitFloorFor("a")).toBe(100n);
      expect(inbox.commitFloorFor("b")).toBe(100n);
      expect(inbox.alignedFloor()).toBe(100n);
      // The effective group commit target is now 100n — A's changes commit at catch-up completion instead
      // of being held until B's first live long-poll. B's raw dedup frontier is untouched (still 40n).
      expect(inbox.lowestCompleteLsn()).toBe(100n);
      expect(inbox.completeLsnFor("b")).toBe(40n);
    });

    it("(b) a late sub-floor change is still ingested, never dedup-dropped, under an aligned floor", () => {
      const inbox = new ShapeInbox(["a", "b"]);
      // Snapshot inserts carry no `last` header → isLastOfLsn=false: they DON'T advance the frontier.
      inbox.ingestChange("a", changeMessage("a", 0n, false, "insert", "a0"), 0n, false);
      inbox.ingestChange("a", changeMessage("a", 100n, true, "insert", "a100"), 100n, true);
      inbox.ingestUpToDate("a", 100n);
      inbox.ingestChange("b", changeMessage("b", 0n, false, "insert", "b0"), 0n, false);
      inbox.ingestUpToDate("b", 40n); // aligns floors → 100n; B raw frontier 40n

      // A late entry for B at 60n — below B's floor (100n) but ABOVE its raw dedup frontier (40n): the
      // cached catch-up omitted it, and it arrives now. It MUST be buffered (the floor is a commit
      // watermark, not a dedup threshold).
      inbox.ingestChange("b", changeMessage("b", 60n, true, "update", "b60"), 60n, true);
      const peekedB = inbox.peekUpTo(100n).get("b")!;
      expect(peekedB.some((m) => m.key === "b/b60")).toBe(true);
      expect(inbox.hasBufferedChangesAtOrBelow(100n)).toBe(true);

      // The RAW dedup still drops a change at or below B's raw frontier (40n) — the floor did not move it.
      inbox.ingestChange("b", changeMessage("b", 40n, true, "update", "b40"), 40n, true);
      const peekedB2 = inbox.peekUpTo(100n).get("b")!;
      expect(peekedB2.some((m) => m.key === "b/b40")).toBe(false);
    });

    it("(c) live-tail min-watermark gating is preserved after alignment", () => {
      const inbox = new ShapeInbox(["a", "b"]);
      // Snapshot inserts carry no `last` header → isLastOfLsn=false: they DON'T advance the frontier.
      inbox.ingestChange("a", changeMessage("a", 0n, false, "insert", "a0"), 0n, false);
      inbox.ingestChange("a", changeMessage("a", 100n, true, "insert", "a100"), 100n, true);
      inbox.ingestUpToDate("a", 100n);
      inbox.ingestChange("b", changeMessage("b", 0n, false, "insert", "b0"), 0n, false);
      inbox.ingestUpToDate("b", 40n); // aligned to 100n
      expect(inbox.lowestCompleteLsn()).toBe(100n);

      // A live change advances A's frontier to 200n WITHOUT any new up-to-date from B. The group must NOT
      // commit to 200n — B's effective frontier is still its floor (100n) — the min-watermark gate holds.
      inbox.ingestChange("a", changeMessage("a", 200n, true, "update", "a200"), 200n, true);
      expect(inbox.lowestCompleteLsn()).toBe(100n);

      // Only when B reports up-to-date at 200n does the group advance to 200n.
      inbox.ingestUpToDate("b", 200n);
      expect(inbox.lowestCompleteLsn()).toBe(200n);
    });

    it("(d) alignment uses reported watermarks, not frontiers", () => {
      const inbox = new ShapeInbox(["a", "b"]);
      // A's frontier is pushed to 300n by a CHANGE (isLastOfLsn), but its last reported up-to-date
      // watermark is only 250n — a live batch in flight above the asserted head.
      inbox.ingestChange("a", changeMessage("a", 250n, true, "insert", "a250"), 250n, true);
      inbox.ingestUpToDate("a", 250n);
      inbox.ingestChange("a", changeMessage("a", 300n, true, "update", "a300"), 300n, true);
      expect(inbox.completeLsnFor("a")).toBe(300n);

      // B reports up-to-date at 240n → alignment fires. The group max is over REPORTED watermarks
      // (max(250, 240) = 250), NOT over frontiers (which would be 300) — aligning to 300 would tear A's
      // in-flight transaction whose B half has not arrived.
      inbox.ingestUpToDate("b", 240n);
      expect(inbox.alignedFloor()).toBe(250n);
      expect(inbox.commitFloorFor("a")).toBe(250n);
      expect(inbox.commitFloorFor("b")).toBe(250n);
      // A effective = max(300, 250) = 300; B effective = max(240, 250) = 250 → group min = 250n.
      expect(inbox.lowestCompleteLsn()).toBe(250n);
    });

    it("(e) resetShape realigns: the floor is retained, and a fresh catch-up realigns the group", () => {
      const inbox = new ShapeInbox(["a", "b"]);
      // Reach the aligned state of (a): floors at 100n.
      // Snapshot inserts carry no `last` header → isLastOfLsn=false: they DON'T advance the frontier.
      inbox.ingestChange("a", changeMessage("a", 0n, false, "insert", "a0"), 0n, false);
      inbox.ingestChange("a", changeMessage("a", 100n, true, "insert", "a100"), 100n, true);
      inbox.ingestUpToDate("a", 100n);
      inbox.ingestChange("b", changeMessage("b", 0n, false, "insert", "b0"), 0n, false);
      inbox.ingestUpToDate("b", 40n);
      expect(inbox.lowestCompleteLsn()).toBe(100n);

      // A advances into the live tail so its LAST reported watermark is 200n (the head B will realign to).
      inbox.ingestChange("a", changeMessage("a", 200n, true, "update", "a200"), 200n, true);
      inbox.ingestUpToDate("a", 200n);

      // B gets a must-refetch: its floor is RETAINED (100n) but its raw frontier rewinds to -1n; the group
      // aligned flag clears. B's effective frontier is now max(-1, 100) = 100n, so the group holds at 100n.
      inbox.resetShape("b");
      expect(inbox.commitFloorFor("b")).toBe(100n);
      expect(inbox.completeLsnFor("b")).toBe(-1n);
      expect(inbox.lowestCompleteLsn()).toBe(100n);

      // B re-snapshots (LSN-0 rows accepted — snapshotAccepted behavior) and reports a STALE cached
      // watermark again (90n). Every shape has now reported up-to-date since the reset → realign to
      // max(reported) = A's 200n. Floors lift to 200n.
      inbox.ingestChange("b", changeMessage("b", 0n, false, "insert", "b0-again"), 0n, false);
      const realigned = inbox.ingestUpToDate("b", 90n);
      expect(realigned).toBe(true);
      expect(inbox.alignedFloor()).toBe(200n);
      expect(inbox.commitFloorFor("a")).toBe(200n);
      expect(inbox.commitFloorFor("b")).toBe(200n);
      expect(inbox.lowestCompleteLsn()).toBe(200n);
    });
  });

  // ADR-0031 live-tail nudge accessors: the effective per-shape frontier the group min is taken over, and
  // the up-to-date-reported flag the nudge reads to skip shapes still catching up (they advance on their own).
  describe("effective frontier + up-to-date reporting accessors (ADR-0031 live-tail nudge)", () => {
    it("effectiveLsnFor returns the raw frontier when above the floor, the floor when above the frontier", () => {
      const inbox = new ShapeInbox(["a", "b"]);
      // Align the group so a commit floor exists: A reports a fresh head (100), B a stale one (40) → both
      // floors lift to max(reported) = 100. B's raw frontier stays 40 (below its floor); A now advances.
      inbox.ingestUpToDate("a", 100n);
      inbox.ingestUpToDate("b", 40n);
      expect(inbox.commitFloorFor("b")).toBe(100n);

      // B: floor (100) above the raw frontier (40) → effective is the floor.
      expect(inbox.completeLsnFor("b")).toBe(40n);
      expect(inbox.effectiveLsnFor("b")).toBe(100n);

      // A: a live change advances the raw frontier (200) above the floor (100) → effective is the frontier.
      inbox.ingestChange("a", changeMessage("a", 200n, true, "update", "a200"), 200n, true);
      expect(inbox.completeLsnFor("a")).toBe(200n);
      expect(inbox.effectiveLsnFor("a")).toBe(200n);
    });

    it("hasReportedUpToDate: false initially, true after up-to-date, false again after resetShape", () => {
      const inbox = new ShapeInbox(["a"]);
      expect(inbox.hasReportedUpToDate("a")).toBe(false);

      inbox.ingestUpToDate("a", 30n);
      expect(inbox.hasReportedUpToDate("a")).toBe(true);

      // A must-refetch rewinds the shape: it must re-report up-to-date before it counts again.
      inbox.resetShape("a");
      expect(inbox.hasReportedUpToDate("a")).toBe(false);
    });
  });

  // ADR-0024 — the move-in channel: a snapshot row entering the shape (no LSN) buffered separately from
  // the LSN-keyed changes, so the change dedup can never drop it.
  describe("move-in channel (ADR-0024)", () => {
    it("buffers and drains move-in rows per shape, independent of the LSN frontier", () => {
      const inbox = new ShapeInbox(["a", "b"]);
      // Advance the frontier well past 0 — exactly the state in which a live move-in (lsn floored to 0)
      // would be dropped by ingestChange. The move-in channel must be immune.
      inbox.ingestUpToDate("a", 99n);
      expect(inbox.hasPendingMoveIns()).toBe(false);

      inbox.ingestMoveIn("a", changeMessage("a", 0n, false, "insert", "in1"));
      expect(inbox.hasPendingMoveIns()).toBe(true);

      const drainedA = inbox.drainMoveIns("a");
      expect(drainedA).toHaveLength(1);
      expect(drainedA[0]?.key).toBe("a/in1");
      // A sibling shape is unaffected, and a drain empties the buffer.
      expect(inbox.drainMoveIns("b")).toHaveLength(0);
      expect(inbox.hasPendingMoveIns()).toBe(false);
    });

    it("resetShape clears buffered move-ins on must-refetch", () => {
      const inbox = new ShapeInbox(["a"]);
      inbox.ingestMoveIn("a", changeMessage("a", 0n, false, "insert", "in1"));
      expect(inbox.hasPendingMoveIns()).toBe(true);

      inbox.resetShape("a");
      expect(inbox.hasPendingMoveIns()).toBe(false);
      expect(inbox.drainMoveIns("a")).toHaveLength(0);
    });
  });
});
