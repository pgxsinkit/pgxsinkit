import { describe, expect, it } from "bun:test";
// Pure unit test of the live-query DIFF machinery (ADR-0032 S2 §4): the worker-side `computeLiveDiff`
// producing {added, changed, removed} deltas keyed by PK, and the tab-side `LiveRowsMaterializer` folding
// those diffs back into an ordered array while KEEPING object identity for unchanged rows (the React memo
// contract). No transport/worker — both pieces are transport-free.

import {
  computeLiveDiff,
  LiveRowsMaterializer,
  rowKey,
  seedLiveDiffState,
} from "../../packages/client/src/worker/live-diff";

describe("computeLiveDiff (worker-side)", () => {
  it("keys by a single PK column and emits only the delta, never the full set", () => {
    const state = seedLiveDiffState(
      [
        { id: "a", n: 1 },
        { id: "b", n: 2 },
      ],
      ["id"],
    );
    // Change only row b; add row c.
    const diff = computeLiveDiff(state, [
      { id: "a", n: 1 },
      { id: "b", n: 22 },
      { id: "c", n: 3 },
    ]);
    expect(diff.order).toEqual(["a", "b", "c"]);
    expect(diff.added).toEqual([{ key: "c", row: { id: "c", n: 3 } }]);
    expect(diff.changed).toEqual([{ key: "b", row: { id: "b", n: 22 } }]);
    expect(diff.removed).toEqual([]);
    // Not a full resend: the unchanged row `a` is NOT in added/changed.
    expect(diff.added.concat(diff.changed).some((d) => d.key === "a")).toBe(false);
  });

  it("emits removals for rows dropped from the result", () => {
    const state = seedLiveDiffState([{ id: "a" }, { id: "b" }], ["id"]);
    const diff = computeLiveDiff(state, [{ id: "a" }]);
    expect(diff.removed).toEqual(["b"]);
    expect(diff.order).toEqual(["a"]);
    expect(diff.added).toEqual([]);
    expect(diff.changed).toEqual([]);
  });

  it("keys a composite PK across columns", () => {
    const state = seedLiveDiffState([{ tenant: "t1", id: "a", v: 1 }], ["tenant", "id"]);
    const diff = computeLiveDiff(state, [
      { tenant: "t1", id: "a", v: 1 },
      { tenant: "t2", id: "a", v: 9 },
    ]);
    // Same `id` but different tenant is a DIFFERENT logical row (composite key), so it is an add, not a change.
    expect(diff.added.map((d) => d.key)).toEqual([rowKey({ tenant: "t2", id: "a" }, ["tenant", "id"])]);
    expect(diff.changed).toEqual([]);
  });

  it("keyless fallback keys by whole-row value — an update surfaces as remove+add", () => {
    const state = seedLiveDiffState([{ label: "x" }], undefined);
    const diff = computeLiveDiff(state, [{ label: "y" }]);
    expect(diff.added).toEqual([{ key: JSON.stringify({ label: "y" }), row: { label: "y" } }]);
    expect(diff.removed).toEqual([JSON.stringify({ label: "x" })]);
    expect(diff.changed).toEqual([]);
  });
});

describe("LiveRowsMaterializer (tab-side)", () => {
  it("keeps object identity for unchanged rows and installs a fresh object for a changed row", () => {
    const state = seedLiveDiffState([], ["id"]);
    const materializer = new LiveRowsMaterializer<{ id: string; n: number }>(["id"]);

    const a = { id: "a", n: 1 };
    const b = { id: "b", n: 2 };
    const initial = materializer.seed([a, b]);
    expect(initial.map((r) => r.id)).toEqual(["a", "b"]);

    // Reference the seeded objects to assert identity later.
    seedStateFrom(state, [a, b]);
    const diff = computeLiveDiff(state, [
      { id: "a", n: 1 },
      { id: "b", n: 99 },
    ]);
    const next = materializer.apply(diff);

    expect(next).not.toBe(initial); // a fresh array each apply
    expect(next[0]).toBe(a); // unchanged row keeps its EXACT object (===) — React memo bails
    expect(next[1]).not.toBe(b); // changed row is a fresh object
    expect(next[1]).toEqual({ id: "b", n: 99 });
  });

  it("applies adds, removes, and reorders from the diff's order", () => {
    const materializer = new LiveRowsMaterializer<{ id: string }>(["id"]);
    materializer.seed([{ id: "a" }, { id: "b" }, { id: "c" }]);
    const next = materializer.apply({
      order: ["c", "a", "d"],
      added: [{ key: "d", row: { id: "d" } }],
      changed: [],
      removed: ["b"],
    });
    expect(next.map((r) => r.id)).toEqual(["c", "a", "d"]);
  });
});

// Seed a diff-state's `previous` map from concrete objects (helper for the identity test above).
function seedStateFrom(state: ReturnType<typeof seedLiveDiffState>, rows: Array<Record<string, unknown>>): void {
  state.previous = new Map(rows.map((row) => [rowKey(row, state.pkColumns), row]));
}
