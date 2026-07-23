import { describe, expect, it } from "bun:test";
// ADR-0049 (capability-driven engine placement) step 11a: the ADOPTION ORCHESTRATOR + declaration surface —
// the automatic and manual adoption transitions as a PURE, effect-injected sequence over the plan's
// "Adoption sequence (exclusive, quiescent — D7)" and adoption crash rows (plan §§ "Adoption sequence",
// "Provenance gates and the commitment barrier"; ADR-0049 decision 7; CONTEXT § "Language — engine placement",
// entries "Adoption gate", "Adoption-bootstrap gate", "Drain predicate"). The orchestrator never touches
// IDB/OPFS/PGlite: every side effect is INJECTED (step 11b wires the real effects — the pre-expose idb boot,
// the drain read, the server bootstrap through the Adoption-bootstrap gate, the commitment barrier). Here a
// recording fake proves the exact call order, the declaration gate (default off — invariant 4), the drain
// gate (invariant 3, no-race-by-construction pre-expose), and the two recovery branches (gate/barrier
// failure → idb stays authoritative; a post-commit predecessor-cleanup failure never unadopts).

import {
  type AdoptionEffects,
  adoptionEligible,
  buildAdoptionEffects,
  runAdoptionTransition,
  runManualAdoption,
} from "../../packages/client/src/adoption";
import type { JournalStatusCounts } from "../../packages/client/src/store-lifecycle";
import type { StoreBootVerdict } from "../../packages/client/src/store-meta";

// ---------------------------------------------------------------------------------------------------------
// A recording effects fake. `bootIdbPreExpose` returns the configured journal counts (the drain input); every
// other effect records its invocation and, when its name is in `throwOn`, rejects with `errorText`. The
// recorded `calls` array is the exact orchestration order each test asserts.
// ---------------------------------------------------------------------------------------------------------
function drained(overrides: Partial<JournalStatusCounts> = {}): JournalStatusCounts {
  return { pending: 0, sending: 0, acked: 0, failed: 0, quarantined: 0, conflicted: 0, rejected: 0, ...overrides };
}

const FULL_ORDER = [
  "bootIdbPreExpose",
  "strictSyncAndCloseIdb",
  "setPhase:adopting",
  "buildCandidateThroughGate",
  "commitCandidate",
  "deleteIdbPredecessor",
];

function fakeEffects(opts: { counts?: JournalStatusCounts; throwOn?: string; errorText?: string } = {}): {
  effects: AdoptionEffects;
  calls: string[];
} {
  const calls: string[] = [];
  const counts = opts.counts ?? drained();
  const throwOn = opts.throwOn;
  const message = opts.errorText ?? "boom";
  const step = (name: string): Promise<void> => {
    calls.push(name);
    if (throwOn === name) return Promise.reject(new Error(message));
    return Promise.resolve();
  };
  const effects: AdoptionEffects = {
    bootIdbPreExpose: () => {
      calls.push("bootIdbPreExpose");
      return Promise.resolve(counts);
    },
    strictSyncAndCloseIdb: () => step("strictSyncAndCloseIdb"),
    setPhase: (phase) => step(`setPhase:${phase}`),
    buildCandidateThroughGate: () => step("buildCandidateThroughGate"),
    commitCandidate: () => step("commitCandidate"),
    deleteIdbPredecessor: () => step("deleteIdbPredecessor"),
    teardownCandidate: () => step("teardownCandidate"),
  };
  return { effects, calls };
}

// =========================================================================================================
// A. Automatic transition — declaration gated (default off), drained, full success
// =========================================================================================================
describe("runAdoptionTransition (automatic, declaration-gated)", () => {
  it("declared + drained → full ordered transition, outcome adopted:true", async () => {
    const { effects, calls } = fakeEffects();
    const outcome = await runAdoptionTransition("server-reconstructible", effects);
    expect(outcome).toEqual({ adopted: true });
    expect(calls).toEqual(FULL_ORDER);
  });

  it("no declaration (default off) → not-declared, ZERO effects called (invariant 4)", async () => {
    const { effects, calls } = fakeEffects();
    const outcome = await runAdoptionTransition(undefined, effects);
    expect(outcome).toEqual({ adopted: false, reason: "not-declared" });
    // Hook absence is never authority: the orchestrator does not even boot the idb engine.
    expect(calls).toEqual([]);
  });
});

// =========================================================================================================
// B. Manual adoption — identical transition, the explicit call IS the authorization (no declaration check)
// =========================================================================================================
describe("runManualAdoption (explicit authorization)", () => {
  it("runs the identical full ordered transition with no declaration", async () => {
    const { effects, calls } = fakeEffects();
    const outcome = await runManualAdoption(effects);
    expect(outcome).toEqual({ adopted: true });
    expect(calls).toEqual(FULL_ORDER);
  });

  it("still honours the drain gate (owed journal → journal-owed, only the idb boot ran)", async () => {
    const { effects, calls } = fakeEffects({ counts: drained({ pending: 1 }) });
    const outcome = await runManualAdoption(effects);
    expect(outcome).toEqual({ adopted: false, reason: "journal-owed" });
    expect(calls).toEqual(["bootIdbPreExpose"]);
  });
});

describe("buildAdoptionEffects — extracted candidate ownership", () => {
  it("keeps strict data-before-authority ordering and closes the candidate before predecessor deletion", async () => {
    const calls: string[] = [];
    const effects = buildAdoptionEffects({
      readIdbJournal: async () => drained(),
      setPhase: async (phase) => {
        calls.push(`phase:${phase}`);
      },
      buildCandidate: async () => ({
        ready: Promise.resolve(),
        strictSync: async () => {
          calls.push("strictSync");
        },
        close: async () => {
          calls.push("close");
        },
      }),
      publishSentinel: async () => {
        calls.push("sentinel");
      },
      deleteSentinel: async () => {
        calls.push("deleteSentinel");
      },
      deleteStoreDirectory: async () => {
        calls.push("deleteDirectory");
      },
      deleteIdbPredecessor: async () => {
        calls.push("deleteIdb");
      },
    });

    expect(await runManualAdoption(effects)).toEqual({ adopted: true });
    expect(calls).toEqual(["phase:adopting", "strictSync", "sentinel", "phase:opfs-committed", "close", "deleteIdb"]);
  });
});

// =========================================================================================================
// C. Drain gate — each blocking journal status alone defers adoption (pre-expose, no-race-by-construction)
// =========================================================================================================
describe("drain gate (invariant 3 — the transition is pre-expose)", () => {
  for (const blocking of ["pending", "sending", "failed", "quarantined", "conflicted"] as const) {
    it(`a single ${blocking} row → journal-owed; ONLY bootIdbPreExpose ran (adoption deferred)`, async () => {
      const { effects, calls } = fakeEffects({ counts: drained({ [blocking]: 1 }) });
      const outcome = await runAdoptionTransition("server-reconstructible", effects);
      expect(outcome).toEqual({ adopted: false, reason: "journal-owed" });
      // The orchestrator boots the idb engine to READ the journal, then does nothing else — the caller
      // exposes the idb engine normally (adoption deferred). Nothing was strict-synced, no phase advanced.
      expect(calls).toEqual(["bootIdbPreExpose"]);
    });
  }

  it("settled rows (acked + rejected) do not block the drain → adoption proceeds", async () => {
    const { effects, calls } = fakeEffects({ counts: drained({ acked: 9, rejected: 4 }) });
    const outcome = await runAdoptionTransition("server-reconstructible", effects);
    expect(outcome).toEqual({ adopted: true });
    expect(calls).toEqual(FULL_ORDER);
  });
});

// =========================================================================================================
// D. Failure recovery — gate/barrier failure tears the candidate down; idb stays authoritative
// =========================================================================================================
describe("adoption failure recovery (idb stays authoritative)", () => {
  it("gate failure → teardownCandidate + setPhase(idb-authoritative); reason gate-failed with error text", async () => {
    const { effects, calls } = fakeEffects({ throwOn: "buildCandidateThroughGate", errorText: "gate offline" });
    const outcome = await runAdoptionTransition("server-reconstructible", effects);
    expect(outcome).toEqual({ adopted: false, reason: "gate-failed", error: "gate offline" });
    expect(calls).toEqual([
      "bootIdbPreExpose",
      "strictSyncAndCloseIdb",
      "setPhase:adopting",
      "buildCandidateThroughGate",
      "teardownCandidate",
      "setPhase:idb-authoritative",
    ]);
    // Nothing published: the barrier and the predecessor deletion never ran.
    expect(calls).not.toContain("commitCandidate");
    expect(calls).not.toContain("deleteIdbPredecessor");
  });

  it("barrier failure → same recovery; reason barrier-failed (barrier publishes nothing)", async () => {
    const { effects, calls } = fakeEffects({ throwOn: "commitCandidate", errorText: "vfs health bad" });
    const outcome = await runAdoptionTransition("server-reconstructible", effects);
    expect(outcome).toEqual({ adopted: false, reason: "barrier-failed", error: "vfs health bad" });
    expect(calls).toEqual([
      "bootIdbPreExpose",
      "strictSyncAndCloseIdb",
      "setPhase:adopting",
      "buildCandidateThroughGate",
      "commitCandidate",
      "teardownCandidate",
      "setPhase:idb-authoritative",
    ]);
    // A failed barrier deletes no predecessor — the idb store is untouched.
    expect(calls).not.toContain("deleteIdbPredecessor");
  });

  it("manual adoption uses the same recovery on gate failure", async () => {
    const { effects } = fakeEffects({ throwOn: "buildCandidateThroughGate", errorText: "unauthorized" });
    const outcome = await runManualAdoption(effects);
    expect(outcome).toEqual({ adopted: false, reason: "gate-failed", error: "unauthorized" });
  });
});

// =========================================================================================================
// E. Post-commit predecessor cleanup — a delete failure after commit does NOT unadopt (crash-row 3)
// =========================================================================================================
describe("post-commit predecessor cleanup", () => {
  it("deleteIdbPredecessor failure after commit → adopted:true with predecessorCleanupPending", async () => {
    const { effects, calls } = fakeEffects({ throwOn: "deleteIdbPredecessor", errorText: "idb delete blocked" });
    const outcome = await runAdoptionTransition("server-reconstructible", effects);
    // Adoption SUCCEEDED (phase is opfs-committed); the boot classifier's lingering-idb row completes the
    // deletion next boot. The failure is recorded, never surfaced as an un-adoption.
    expect(outcome).toEqual({ adopted: true, predecessorCleanupPending: "idb delete blocked" });
    expect(calls).toEqual(FULL_ORDER);
  });
});

// =========================================================================================================
// F. adoptionEligible — the boot-wiring (11b) predicate
// =========================================================================================================
describe("adoptionEligible (boot-wiring predicate)", () => {
  const idbAuthoritative: StoreBootVerdict = { action: "boot-idb-authoritative" };
  const otherVerdicts: StoreBootVerdict[] = [
    { action: "open-committed" },
    { action: "virgin-create" },
    { action: "resume-deletion" },
    { action: "adoption-recovery" },
    { action: "delete-candidate-and-rebuild" },
    { action: "repair-record-then-open-committed" },
  ];

  it("true iff declared AND opfs access AND verdict is boot-idb-authoritative", () => {
    expect(adoptionEligible("server-reconstructible", idbAuthoritative, true)).toBe(true);
  });

  it("false without the declaration (default off)", () => {
    expect(adoptionEligible(undefined, idbAuthoritative, true)).toBe(false);
  });

  it("false without opfs sync access (adoption only starts where opfs is available)", () => {
    expect(adoptionEligible("server-reconstructible", idbAuthoritative, false)).toBe(false);
  });

  it("false for every verdict other than boot-idb-authoritative, even when declared with opfs access", () => {
    for (const verdict of otherVerdicts) {
      expect(adoptionEligible("server-reconstructible", verdict, true)).toBe(false);
    }
  });

  it("false when all three conditions are absent", () => {
    expect(adoptionEligible(undefined, otherVerdicts[0]!, false)).toBe(false);
  });
});
