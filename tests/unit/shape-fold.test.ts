import { describe, expect, it } from "bun:test";

import { foldChangeBatch } from "../../packages/client/src/sync/fold";

// Derive the change-message type from the fold signature so the test does not depend on the client
// package's own module resolution from the tests/ scope.
type FoldInput = Parameters<typeof foldChangeBatch>[0][number];
type Operation = "upsert" | "delete";
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
  it("[upsert, upsert] ⇒ one UPSERT with merged values", () => {
    const folded = foldChangeBatch([
      message("k", "upsert", { id: "k", a: 1, b: 2 }),
      message("k", "upsert", { id: "k", a: 9 }),
    ]);
    expect(folded.deletes).toHaveLength(0);
    expect(folded.upserts).toHaveLength(1);
    expect(folded.upserts[0]!.value).toEqual({ id: "k", a: 9, b: 2 });
    expect(folded.upserts[0]!.headers.operation).toBe("upsert");
  });

  it("[upsert, delete] ⇒ one DELETE", () => {
    const folded = foldChangeBatch([message("k", "upsert", { id: "k", a: 1 }), message("k", "delete", { id: "k" })]);
    expect(folded.upserts).toHaveLength(0);
    expect(folded.deletes).toHaveLength(1);
    expect(folded.deletes[0]!.value).toEqual({ id: "k" });
  });

  it("[upsert, upsert, delete] (trailing delete) ⇒ one DELETE, no upsert", () => {
    const folded = foldChangeBatch([
      message("k", "upsert", { id: "k", a: 1, b: 2 }),
      message("k", "upsert", { id: "k", a: 3 }),
      message("k", "delete", { id: "k" }),
    ]);
    expect(folded.upserts).toHaveLength(0);
    expect(folded.deletes).toHaveLength(1);
  });

  // The clearing DELETE is load-bearing, not belt-and-braces: `ON CONFLICT DO UPDATE` refreshes only
  // the columns the row carries, so folding `[delete, upsert]` down to a bare UPSERT would let a row
  // that genuinely left and re-entered keep column values from its previous life.
  it("[delete, upsert] (re-created) ⇒ DELETE *and* UPSERT, so the pre-existing row is cleared first", () => {
    const folded = foldChangeBatch([
      message("k", "delete", { id: "k" }),
      message("k", "upsert", { id: "k", a: 7, b: 8 }),
    ]);
    expect(folded.deletes).toHaveLength(1);
    expect(folded.deletes[0]!.value).toEqual({ id: "k" });
    expect(folded.upserts).toHaveLength(1);
    expect(folded.upserts[0]!.value).toEqual({ id: "k", a: 7, b: 8 });
  });

  it("[delete, upsert, upsert] ⇒ DELETE + UPSERT with merged values", () => {
    const folded = foldChangeBatch([
      message("k", "delete", { id: "k" }),
      message("k", "upsert", { id: "k", a: 7, b: 8 }),
      message("k", "upsert", { id: "k", b: 99 }),
    ]);
    expect(folded.deletes).toHaveLength(1);
    expect(folded.upserts).toHaveLength(1);
    expect(folded.upserts[0]!.value).toEqual({ id: "k", a: 7, b: 99 });
  });

  it("folds independently per key in a mixed multi-key batch", () => {
    const folded = foldChangeBatch([
      message("ins", "upsert", { id: "ins", a: 1, b: 1 }),
      message("upd", "upsert", { id: "upd", a: 2 }),
      message("del", "delete", { id: "del" }),
      message("upd", "upsert", { id: "upd", b: 3 }),
    ]);
    expect(folded.upserts.map((m) => m.key).sort()).toEqual(["ins", "upd"]);
    expect(folded.deletes.map((m) => m.key)).toEqual(["del"]);
    expect(folded.upserts.find((m) => m.key === "upd")!.value).toEqual({ id: "upd", a: 2, b: 3 });
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

/**
 * One upsert, as `INSERT … ON CONFLICT (pk) DO UPDATE SET <carried cols> = excluded.<col>` behaves:
 * absent row ⇒ inserted as-is; present row ⇒ the carried columns are overwritten and any column the
 * row does not carry is left alone. Modelling it as a wholesale replace would hide exactly the case
 * the clearing delete exists for.
 */
function upsertInto(state: State, key: string, value: Row): void {
  const current = state.get(key);
  state.set(key, current ? { ...current, ...value } : { ...value });
}

/** The oracle: apply raw ops one at a time, exactly as the per-row Sync applier does today. */
function applyPerRow(state: State, ops: FoldInput[]): State {
  for (const op of ops) {
    if (op.headers.operation === "delete") state.delete(op.key);
    else upsertInto(state, op.key, op.value as Row);
  }
  return state;
}

/** Apply a folded batch as the two bulk statements will: deletes → upserts. */
function applyFolded(state: State, folded: ReturnType<typeof foldChangeBatch>): State {
  for (const d of folded.deletes) state.delete(d.key);
  for (const u of folded.upserts) upsertInto(state, u.key, u.value as Row);
  return state;
}

function stable(state: State): string {
  return JSON.stringify([...state.entries()].sort((a, b) => a[0].localeCompare(b[0])));
}

describe("foldChangeBatch — property: fold-then-bulk ≡ ordered per-row apply", () => {
  it("holds over random upsert/delete sequences and random initial DB state", () => {
    const rand = mulberry32(0x5e1f0d);
    const randInt = (n: number) => Math.floor(rand() * n);

    for (let iteration = 0; iteration < 2000; iteration++) {
      const keyCount = 1 + randInt(4);
      const initial: State = new Map();
      const perKeyOps: FoldInput[][] = [];

      for (let k = 0; k < keyCount; k++) {
        const key = `k${k}`;
        // No faithfulness precondition to respect any more: an upsert is legal whether or not the
        // row exists, and a delete of an absent row is a no-op. So the generator is free to emit any
        // sequence, which covers strictly more than the old insert/update/delete state machine did.
        if (rand() < 0.5) initial.set(key, { id: key, a: randInt(5), b: randInt(5), local: iteration });

        const ops: FoldInput[] = [];
        const steps = 1 + randInt(6);
        for (let s = 0; s < steps; s++) {
          if (rand() < 0.65) {
            const value: Row = { id: key };
            if (rand() < 0.7) value["a"] = randInt(5);
            if (rand() < 0.7 || value["a"] === undefined) value["b"] = randInt(5);
            ops.push(message(key, "upsert", value));
          } else {
            ops.push(message(key, "delete", { id: key }));
          }
        }
        perKeyOps.push(ops);
      }

      // Interleave the per-key op lists into one stream-ordered batch, preserving each key's order.
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
