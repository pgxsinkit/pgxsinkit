import { describe, expect, it } from "bun:test";

import { foldChangeBatch } from "../../packages/client/src/sync/shape-inbox";

// Derive the change-message type from the fold signature so the test does not depend on
// `@electric-sql/client` resolving from the tests/ scope (it is hoisted under packages/client).
type FoldInput = Parameters<typeof foldChangeBatch>[0][number];
type Operation = "insert" | "update" | "delete";
type Row = Record<string, unknown>;

let lsnCounter = 0n;
function message(key: string, operation: Operation, value: Row): FoldInput {
  return {
    key,
    value,
    headers: { operation, lsn: String(lsnCounter++), last: true },
  } as unknown as FoldInput;
}

describe("foldChangeBatch (ADR-0014 / decision 1) — targeted cases", () => {
  it("[insert, update] ⇒ one INSERT with merged values", () => {
    const folded = foldChangeBatch([
      message("k", "insert", { id: "k", a: 1, b: 2 }),
      message("k", "update", { id: "k", a: 9 }),
    ]);
    expect(folded.deletes).toHaveLength(0);
    expect(folded.updates).toHaveLength(0);
    expect(folded.inserts).toHaveLength(1);
    expect(folded.inserts[0]!.value).toEqual({ id: "k", a: 9, b: 2 });
    expect(folded.inserts[0]!.headers.operation).toBe("insert");
  });

  it("[update, update] ⇒ one UPDATE with merged values (carries the PK)", () => {
    const folded = foldChangeBatch([
      message("k", "update", { id: "k", a: 1 }),
      message("k", "update", { id: "k", b: 5 }),
    ]);
    expect(folded.inserts).toHaveLength(0);
    expect(folded.deletes).toHaveLength(0);
    expect(folded.updates).toHaveLength(1);
    expect(folded.updates[0]!.value).toEqual({ id: "k", a: 1, b: 5 });
    expect(folded.updates[0]!.headers.operation).toBe("update");
  });

  it("[update, delete] ⇒ one DELETE", () => {
    const folded = foldChangeBatch([message("k", "update", { id: "k", a: 1 }), message("k", "delete", { id: "k" })]);
    expect(folded.inserts).toHaveLength(0);
    expect(folded.updates).toHaveLength(0);
    expect(folded.deletes).toHaveLength(1);
    expect(folded.deletes[0]!.value).toEqual({ id: "k" });
  });

  it("[insert, update, delete] (trailing delete) ⇒ one DELETE, no insert", () => {
    const folded = foldChangeBatch([
      message("k", "insert", { id: "k", a: 1, b: 2 }),
      message("k", "update", { id: "k", a: 3 }),
      message("k", "delete", { id: "k" }),
    ]);
    expect(folded.inserts).toHaveLength(0);
    expect(folded.updates).toHaveLength(0);
    expect(folded.deletes).toHaveLength(1);
  });

  it("[delete, insert] (re-created) ⇒ DELETE *and* INSERT, so the pre-existing row is cleared first", () => {
    const folded = foldChangeBatch([
      message("k", "delete", { id: "k" }),
      message("k", "insert", { id: "k", a: 7, b: 8 }),
    ]);
    expect(folded.updates).toHaveLength(0);
    expect(folded.deletes).toHaveLength(1);
    expect(folded.deletes[0]!.value).toEqual({ id: "k" });
    expect(folded.inserts).toHaveLength(1);
    expect(folded.inserts[0]!.value).toEqual({ id: "k", a: 7, b: 8 });
  });

  it("[delete, insert, update] ⇒ DELETE + INSERT with merged values", () => {
    const folded = foldChangeBatch([
      message("k", "delete", { id: "k" }),
      message("k", "insert", { id: "k", a: 7, b: 8 }),
      message("k", "update", { id: "k", b: 99 }),
    ]);
    expect(folded.deletes).toHaveLength(1);
    expect(folded.inserts).toHaveLength(1);
    expect(folded.inserts[0]!.value).toEqual({ id: "k", a: 7, b: 99 });
  });

  it("[delete, update] (update after delete) ⇒ throws — malformed for a faithful stream", () => {
    expect(() =>
      foldChangeBatch([message("k", "delete", { id: "k" }), message("k", "update", { id: "k", a: 1 })]),
    ).toThrow(/malformed/);
  });

  it("folds independently per key in a mixed multi-key batch", () => {
    const folded = foldChangeBatch([
      message("ins", "insert", { id: "ins", a: 1, b: 1 }),
      message("upd", "update", { id: "upd", a: 2 }),
      message("del", "delete", { id: "del" }),
      message("upd", "update", { id: "upd", b: 3 }),
    ]);
    expect(folded.inserts.map((m) => m.key)).toEqual(["ins"]);
    expect(folded.updates.map((m) => m.key)).toEqual(["upd"]);
    expect(folded.deletes.map((m) => m.key)).toEqual(["del"]);
    expect(folded.updates[0]!.value).toEqual({ id: "upd", a: 2, b: 3 });
  });
});

// ── The ADR-0014 oracle: fold-then-bulk ≡ ordered per-row apply ───────────────────────────────
// A deterministic seeded PRNG keeps failures reproducible without pulling in a property library.
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type State = Map<string, Row>;

/** The oracle: apply raw ops one at a time, exactly as the per-row Sync applier does today. */
function applyPerRow(state: State, ops: FoldInput[]): State {
  for (const op of ops) {
    const key = op.key;
    switch (op.headers.operation) {
      case "insert":
        if (state.has(key)) throw new Error(`collision on insert ${key}`);
        state.set(key, { ...(op.value as Row) });
        break;
      case "update": {
        const current = state.get(key);
        if (current) state.set(key, { ...current, ...(op.value as Row) }); // missing row ⇒ no-op, as in SQL
        break;
      }
      case "delete":
        state.delete(key);
        break;
    }
  }
  return state;
}

/** Apply a folded batch as the three bulk statements will (Phase 3): deletes → inserts → updates. */
function applyFolded(state: State, folded: ReturnType<typeof foldChangeBatch>): State {
  for (const d of folded.deletes) state.delete(d.key);
  for (const i of folded.inserts) {
    if (state.has(i.key)) throw new Error(`collision on insert ${i.key}`);
    state.set(i.key, { ...(i.value as Row) });
  }
  for (const u of folded.updates) {
    const current = state.get(u.key);
    if (current) state.set(u.key, { ...current, ...(u.value as Row) });
  }
  return state;
}

function stable(state: State): string {
  return JSON.stringify([...state.entries()].sort((a, b) => a[0].localeCompare(b[0])));
}

describe("foldChangeBatch — property: fold-then-bulk ≡ ordered per-row apply", () => {
  it("holds over random faithful same-PK sequences and random initial DB state", () => {
    const rand = mulberry32(0x5e1f0d);
    const randInt = (n: number) => Math.floor(rand() * n);

    for (let iteration = 0; iteration < 2000; iteration++) {
      const keyCount = 1 + randInt(4);
      const initial: State = new Map();
      const perKeyOps: FoldInput[][] = [];

      for (let k = 0; k < keyCount; k++) {
        const key = `k${k}`;
        // A faithful stream only `insert`s a row that does not currently exist, and only
        // `update`s/`delete`s one that does — so the row's initial existence is fixed by its first op.
        let exists = rand() < 0.5;
        if (exists) initial.set(key, { id: key, a: randInt(5), b: randInt(5) });

        const ops: FoldInput[] = [];
        const steps = 1 + randInt(6);
        for (let s = 0; s < steps; s++) {
          if (!exists) {
            ops.push(message(key, "insert", { id: key, a: randInt(5), b: randInt(5) }));
            exists = true;
          } else if (rand() < 0.5) {
            const value: Row = { id: key };
            if (rand() < 0.7) value["a"] = randInt(5);
            if (rand() < 0.7 || value["a"] === undefined) value["b"] = randInt(5);
            ops.push(message(key, "update", value));
          } else {
            ops.push(message(key, "delete", { id: key }));
            exists = false;
          }
        }
        perKeyOps.push(ops);
      }

      // Interleave the per-key op lists into one LSN-ordered batch, preserving each key's order.
      const cursors = perKeyOps.map(() => 0);
      const batch: FoldInput[] = [];
      let remaining = perKeyOps.reduce((sum, ops) => sum + ops.length, 0);
      while (remaining > 0) {
        let pick = randInt(keyCount);
        while (cursors[pick]! >= perKeyOps[pick]!.length) pick = (pick + 1) % keyCount;
        batch.push(perKeyOps[pick]![cursors[pick]!]!);
        cursors[pick]!++;
        remaining--;
      }

      const viaPerRow = stable(applyPerRow(new Map(structuredClone([...initial])), batch));
      const viaFold = stable(applyFolded(new Map(structuredClone([...initial])), foldChangeBatch(batch)));

      if (viaPerRow !== viaFold) {
        throw new Error(
          `fold diverged at iteration ${iteration}:\n  per-row: ${viaPerRow}\n  folded:  ${viaFold}\n  batch: ${JSON.stringify(batch.map((m) => [m.key, m.headers.operation, m.value]))}`,
        );
      }
      expect(viaFold).toBe(viaPerRow);
    }
  });
});
