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

  it("reports the lowest complete frontier across the group (the slowest shape)", () => {
    const inbox = new ShapeInbox(["a", "b"]);
    inbox.ingestUpToDate("a", 50n);
    inbox.ingestUpToDate("b", 20n);

    expect(inbox.lowestCompleteLsn()).toBe(20n);
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
