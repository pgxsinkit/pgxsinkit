import { describe, expect, it } from "bun:test";

import { StreamInbox } from "@pgxsinkit/client";
import type { ChangeLike } from "@pgxsinkit/client";

// The offset-keyed inbox (ADR-0056). What is pinned here is the commit GATE and the resume position,
// because both are correctness rather than convenience: the gate is what stops half a cross-shape
// transaction being applied, and the offset is what a crash resumes from.

function change(key: string): ChangeLike {
  return { key, value: { id: key }, headers: { operation: "insert" } };
}

/** Offsets are opaque but lexicographically sortable WITHIN a stream — the protocol says so (S10.2). */
function offset(n: number): string {
  return String(n).padStart(16, "0");
}

describe("commit gate", () => {
  // The whole steady-state condition. A group must never commit while a member is still draining.
  it("holds while any shape is mid-catch-up, and opens when all report drained", () => {
    const inbox = new StreamInbox(["a", "b"]);

    inbox.ingestBatch("a", [change("a1")], offset(1), true);
    expect(inbox.isGroupUpToDate()).toBe(false);

    inbox.ingestBatch("b", [change("b1")], offset(1), false);
    expect(inbox.isGroupUpToDate()).toBe(false);

    inbox.ingestBatch("b", [change("b2")], offset(2), true);
    expect(inbox.isGroupUpToDate()).toBe(true);
  });

  // A live batch means that shape is no longer drained; the group must close again until it re-reports.
  it("closes again when a shape delivers new data mid-session", () => {
    const inbox = new StreamInbox(["a", "b"]);
    inbox.ingestBatch("a", [], offset(1), true);
    inbox.ingestBatch("b", [], offset(1), true);
    expect(inbox.isGroupUpToDate()).toBe(true);

    inbox.ingestBatch("a", [change("a9")], offset(2), false);
    expect(inbox.isGroupUpToDate()).toBe(false);
  });
});

describe("offsets", () => {
  it("carries the last batch offset per shape and advances only on ack", () => {
    const inbox = new StreamInbox(["a", "b"]);
    inbox.ingestBatch("a", [change("a1")], offset(1), true);
    inbox.ingestBatch("a", [change("a2")], offset(2), true);
    inbox.ingestBatch("b", [change("b1")], offset(7), true);

    expect(inbox.pendingOffsets()).toEqual(
      new Map([
        ["a", offset(2)],
        ["b", offset(7)],
      ]),
    );
    expect(inbox.appliedOffsetFor("a")).toBeNull();

    const epochs = inbox.snapshotEpochs();
    inbox.peekAll();
    inbox.ackAll(epochs);

    expect(inbox.appliedOffsetFor("a")).toBe(offset(2));
    expect(inbox.hasBufferedBatches()).toBe(false);
  });

  // An empty up-to-date response — what a 204 long-poll timeout is — still moves the position, and
  // that position has to survive to the next commit or a resume re-reads ground already covered.
  it("carries an empty batch's offset forward", () => {
    const inbox = new StreamInbox(["a"]);
    inbox.ingestBatch("a", [], offset(5), true);
    expect(inbox.hasBufferedChanges()).toBe(false);
    expect(inbox.pendingOffsets().get("a")).toBe(offset(5));
  });

  it("drops a batch at or below the applied offset", () => {
    const inbox = new StreamInbox(["a"]);
    inbox.ingestBatch("a", [change("a1")], offset(3), true);
    inbox.ackAll(inbox.snapshotEpochs());

    inbox.ingestBatch("a", [change("a1-again")], offset(3), true);
    inbox.ingestBatch("a", [change("a0")], offset(1), true);
    expect(inbox.hasBufferedBatches()).toBe(false);

    inbox.ingestBatch("a", [change("a4")], offset(4), true);
    expect(
      inbox
        .peekAll()
        .get("a")
        ?.map((c) => c.key),
    ).toEqual(["a4"]);
  });
});

describe("must-refetch", () => {
  // A reset mid-commit installs content this commit never peeked; acking it would drop the rebuild.
  it("makes a stale ack no-op for the reset shape only", () => {
    const inbox = new StreamInbox(["a", "b"]);
    inbox.ingestBatch("a", [change("a1")], offset(1), true);
    inbox.ingestBatch("b", [change("b1")], offset(1), true);

    const epochs = inbox.snapshotEpochs();
    inbox.peekAll();

    inbox.resetShape("a");
    inbox.ingestBatch("a", [change("a-fresh")], offset(1), true);

    inbox.ackAll(epochs);

    expect(
      inbox
        .peekAll()
        .get("a")
        ?.map((c) => c.key),
    ).toEqual(["a-fresh"]);
    expect(inbox.peekAll().get("b")).toEqual([]);
  });

  it("rewinds the shape to the start of its stream and re-arms alignment", () => {
    const inbox = new StreamInbox(["a"]);
    inbox.ingestBatch("a", [change("a1")], offset(1), true);
    inbox.ackAll(inbox.snapshotEpochs());
    inbox.markAligned();
    expect(inbox.needsAlignment()).toBe(false);

    inbox.resetShape("a");

    expect(inbox.appliedOffsetFor("a")).toBeNull();
    expect(inbox.everyShapeReported()).toBe(false);
    expect(inbox.needsAlignment()).toBe(true);
    // Rewound, so the re-snapshot's own offsets are accepted rather than deduped away.
    inbox.ingestBatch("a", [change("a1")], offset(1), true);
    expect(
      inbox
        .peekAll()
        .get("a")
        ?.map((c) => c.key),
    ).toEqual(["a1"]);
  });
});
