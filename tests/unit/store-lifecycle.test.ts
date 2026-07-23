import { describe, expect, it } from "bun:test";
// ADR-0049 (capability-driven engine placement) step 3: the fresh/restore commitment barrier, the adoption
// recovery + completion ordering, and the destructive lifecycle, all as PURE EFFECT-DRIVEN machines over
// their crash tables (plan §§ "Provenance gates and the commitment barrier (D7)", "Adoption sequence",
// "Destructive lifecycle (D8)"; ADR-0049 decisions 7 & 8; CONTEXT § "Language — engine placement", entries
// "Commitment marker", "Adoption gate", "Adoption-bootstrap gate", "Drain predicate", "Destructive
// lifecycle"). The machines never touch IDB/OPFS/PGlite — every side effect is INJECTED, so crashes are
// simulated by making an effect throw, then re-running the resume path from the observed post-crash state.
// The final composition test threads the machines' observed post-crash states through `classifyStoreBoot`
// (store-meta.ts) — the crash-table proof the plan demands: every row of all three crash tables → verdict.

import {
  type AdoptionCompletionEffects,
  type AdoptionRecoveryVerdict,
  beginFreshCandidate,
  classifyAdoptionRecovery,
  type CommitmentBarrierEffects,
  completeAdoption,
  type DestructionEffects,
  type FreshCandidateEffects,
  journalOwesNothing,
  type JournalStatusCounts,
  resumeDeletion,
  runCommitmentBarrier,
  runDestruction,
} from "../../packages/client/src/store-lifecycle";
import {
  classifyStoreBoot,
  type StoreBootObservations,
  type StoreBootVerdict,
} from "../../packages/client/src/store-meta";

// ---------------------------------------------------------------------------------------------------------
// A recording effect harness. `step(name)` logs the invocation (order + count) and, when `name` is the
// configured `throwOnce` target and it has not yet thrown, rejects ONCE — modelling a crash on that effect.
// A second invocation of the same effect succeeds (the idempotent fake: delete-if-present, create-if-absent,
// set-phase-again). This is exactly how each machine's resume path is proven crash-safe.
// ---------------------------------------------------------------------------------------------------------
interface Recorder {
  calls: string[];
  counts: Record<string, number>;
  step(name: string): Promise<void>;
}

function recorder(throwOnce?: string): Recorder {
  const calls: string[] = [];
  const counts: Record<string, number> = {};
  const thrown = new Set<string>();
  return {
    calls,
    counts,
    step(name: string): Promise<void> {
      counts[name] = (counts[name] ?? 0) + 1;
      if (throwOnce === name && !thrown.has(name)) {
        thrown.add(name);
        return Promise.reject(new Error(`crash:${name}`));
      }
      calls.push(name);
      return Promise.resolve();
    },
  };
}

function barrierEffects(rec: Recorder): CommitmentBarrierEffects {
  return {
    strictSyncReturns: () => rec.step("strictSync"),
    publishSentinel: () => rec.step("publishSentinel"),
    setPhase: (phase) => rec.step(`setPhase:${phase}`),
  };
}

function destructionEffects(rec: Recorder): DestructionEffects {
  return {
    setPhase: (phase) => rec.step(`setPhase:${phase}`),
    deleteSentinel: () => rec.step("deleteSentinel"),
    deleteBackendStore: () => rec.step("deleteBackendStore"),
    deleteMetaRecord: () => rec.step("deleteMetaRecord"),
  };
}

function completionEffects(rec: Recorder): AdoptionCompletionEffects {
  return {
    setPhase: (phase) => rec.step(`setPhase:${phase}`),
    deleteIdbPredecessor: () => rec.step("deleteIdbPredecessor"),
  };
}

function freshEffects(rec: Recorder): FreshCandidateEffects {
  return {
    writeCandidateRecord: () => rec.step("writeCandidateRecord"),
    createStoreDirectory: () => rec.step("createStoreDirectory"),
  };
}

// =========================================================================================================
// A. The shared commitment barrier (ADR D7 — one strict data-before-authority sequence)
// =========================================================================================================
describe("runCommitmentBarrier (D7 — data-before-authority)", () => {
  it("runs strictSync → publishSentinel → setPhase(opfs-committed) in exactly that order", async () => {
    const rec = recorder();
    await runCommitmentBarrier(barrierEffects(rec));
    expect(rec.calls).toEqual(["strictSync", "publishSentinel", "setPhase:opfs-committed"]);
  });

  it("aborts and publishes NOTHING when strictSync throws (VFS health / sync did not return)", async () => {
    const rec = recorder("strictSync");
    // oxlint-disable-next-line typescript/await-thenable -- bun-types gap: .resolves/.rejects matchers return a real promise typed as void
    await expect(runCommitmentBarrier(barrierEffects(rec))).rejects.toThrow("crash:strictSync");
    // Data-before-authority: a failed strict sync means the sentinel is never published and the phase never
    // advances — nothing commits.
    expect(rec.calls).toEqual([]);
    expect(rec.counts["publishSentinel"]).toBeUndefined();
    expect(rec.counts["setPhase:opfs-committed"]).toBeUndefined();
  });

  it("never advances the phase when publishSentinel throws (sentinel-before-record ordering held)", async () => {
    const rec = recorder("publishSentinel");
    // oxlint-disable-next-line typescript/await-thenable -- bun-types gap: .resolves/.rejects matchers return a real promise typed as void
    await expect(runCommitmentBarrier(barrierEffects(rec))).rejects.toThrow("crash:publishSentinel");
    expect(rec.calls).toEqual(["strictSync"]);
    expect(rec.counts["setPhase:opfs-committed"]).toBeUndefined();
  });
});

// =========================================================================================================
// B. Destruction machine (ADR D8; plan "Destructive lifecycle") over its crash table
// =========================================================================================================
describe("runDestruction / resumeDeletion (D8 — resumable at every boundary)", () => {
  it("full run: setPhase(deleting) → deleteSentinel → deleteBackendStore → deleteMetaRecord", async () => {
    const rec = recorder();
    await runDestruction(destructionEffects(rec));
    expect(rec.calls).toEqual(["setPhase:deleting", "deleteSentinel", "deleteBackendStore", "deleteMetaRecord"]);
  });

  it("resumeDeletion alone (observed `deleting` phase): sentinel → backend → record", async () => {
    const rec = recorder();
    await resumeDeletion(destructionEffects(rec));
    expect(rec.calls).toEqual(["deleteSentinel", "deleteBackendStore", "deleteMetaRecord"]);
  });

  // Crash-table rows: each effect throws once; re-running resumeDeletion from the observed `deleting` state
  // completes, and the idempotent earlier steps simply re-run (delete-if-present / delete-record-if-present).
  it("deleteSentinel crashes once → resume completes; sentinel ran twice, later steps once", async () => {
    const rec = recorder("deleteSentinel");
    const effects = destructionEffects(rec);
    // oxlint-disable-next-line typescript/await-thenable -- bun-types gap: .resolves/.rejects matchers return a real promise typed as void
    await expect(resumeDeletion(effects)).rejects.toThrow("crash:deleteSentinel");
    await resumeDeletion(effects);
    expect(rec.counts["deleteSentinel"]).toBe(2);
    expect(rec.counts["deleteBackendStore"]).toBe(1);
    expect(rec.counts["deleteMetaRecord"]).toBe(1);
  });

  it("deleteBackendStore crashes once → resume completes; sentinel re-runs idempotently", async () => {
    const rec = recorder("deleteBackendStore");
    const effects = destructionEffects(rec);
    // oxlint-disable-next-line typescript/await-thenable -- bun-types gap: .resolves/.rejects matchers return a real promise typed as void
    await expect(resumeDeletion(effects)).rejects.toThrow("crash:deleteBackendStore");
    await resumeDeletion(effects);
    expect(rec.counts["deleteSentinel"]).toBe(2);
    expect(rec.counts["deleteBackendStore"]).toBe(2);
    expect(rec.counts["deleteMetaRecord"]).toBe(1);
  });

  it("deleteMetaRecord crashes once → resume completes; earlier steps re-run idempotently", async () => {
    const rec = recorder("deleteMetaRecord");
    const effects = destructionEffects(rec);
    // oxlint-disable-next-line typescript/await-thenable -- bun-types gap: .resolves/.rejects matchers return a real promise typed as void
    await expect(resumeDeletion(effects)).rejects.toThrow("crash:deleteMetaRecord");
    await resumeDeletion(effects);
    expect(rec.counts["deleteSentinel"]).toBe(2);
    expect(rec.counts["deleteBackendStore"]).toBe(2);
    expect(rec.counts["deleteMetaRecord"]).toBe(2);
  });

  it("resumeDeletion is idempotent when re-run to completion twice (no crash)", async () => {
    const rec = recorder();
    const effects = destructionEffects(rec);
    await resumeDeletion(effects);
    await resumeDeletion(effects);
    expect(rec.counts["deleteSentinel"]).toBe(2);
    expect(rec.counts["deleteBackendStore"]).toBe(2);
    expect(rec.counts["deleteMetaRecord"]).toBe(2);
  });
});

// =========================================================================================================
// C. Adoption recovery (pure verdict + completion ordering)
// =========================================================================================================
describe("classifyAdoptionRecovery + completeAdoption", () => {
  it("sentinel present → complete-adoption (committed; barrier had published before the crash)", () => {
    const verdict: AdoptionRecoveryVerdict = classifyAdoptionRecovery({ sentinelPresent: true });
    expect(verdict).toEqual({ action: "complete-adoption" });
  });

  it("no sentinel → teardown-and-restart (idb still authoritative; re-run adoption from step 1)", () => {
    const verdict: AdoptionRecoveryVerdict = classifyAdoptionRecovery({ sentinelPresent: false });
    expect(verdict).toEqual({ action: "teardown-and-restart" });
  });

  it("completeAdoption runs setPhase(opfs-committed) → deleteIdbPredecessor in order", async () => {
    const rec = recorder();
    await completeAdoption(completionEffects(rec));
    expect(rec.calls).toEqual(["setPhase:opfs-committed", "deleteIdbPredecessor"]);
  });

  it("deleteIdbPredecessor crashes once → re-run completes (setPhase idempotent)", async () => {
    const rec = recorder("deleteIdbPredecessor");
    const effects = completionEffects(rec);
    // oxlint-disable-next-line typescript/await-thenable -- bun-types gap: .resolves/.rejects matchers return a real promise typed as void
    await expect(completeAdoption(effects)).rejects.toThrow("crash:deleteIdbPredecessor");
    await completeAdoption(effects);
    expect(rec.counts["setPhase:opfs-committed"]).toBe(2);
    expect(rec.counts["deleteIdbPredecessor"]).toBe(2);
  });
});

// =========================================================================================================
// D. Drain predicate (canonical journal status terms — CONTEXT "Drain predicate")
// =========================================================================================================
describe("journalOwesNothing (drain predicate)", () => {
  function counts(overrides: Partial<JournalStatusCounts>): JournalStatusCounts {
    return {
      pending: 0,
      sending: 0,
      acked: 0,
      failed: 0,
      quarantined: 0,
      conflicted: 0,
      rejected: 0,
      ...overrides,
    };
  }

  it("all zero → owes nothing", () => {
    expect(journalOwesNothing(counts({}))).toBe(true);
  });

  it("acked rows alone are settled → owes nothing", () => {
    expect(journalOwesNothing(counts({ acked: 7 }))).toBe(true);
  });

  it("rejected rows alone are settled (rejection terminal, ADR-0022) → owes nothing", () => {
    expect(journalOwesNothing(counts({ rejected: 4 }))).toBe(true);
  });

  it("acked + rejected together (both settled) → owes nothing", () => {
    expect(journalOwesNothing(counts({ acked: 3, rejected: 2 }))).toBe(true);
  });

  for (const blocking of ["pending", "sending", "failed", "quarantined", "conflicted"] as const) {
    it(`a single ${blocking} row blocks the drain → owes something`, () => {
      expect(journalOwesNothing(counts({ [blocking]: 1 }))).toBe(false);
    });
  }

  it("a blocking row alongside settled rows still blocks", () => {
    expect(journalOwesNothing(counts({ acked: 9, rejected: 9, conflicted: 1 }))).toBe(false);
  });
});

// =========================================================================================================
// E. Fresh/restore candidate flow + the three-machine crash-table composition proof
// =========================================================================================================
describe("beginFreshCandidate (record-first — invariant 12)", () => {
  it("writes the candidate record BEFORE creating the store directory", async () => {
    const rec = recorder();
    await beginFreshCandidate(freshEffects(rec));
    expect(rec.calls).toEqual(["writeCandidateRecord", "createStoreDirectory"]);
  });

  it("a crash before the record leaves nothing recorded (record-first authority)", async () => {
    const rec = recorder("writeCandidateRecord");
    // oxlint-disable-next-line typescript/await-thenable -- bun-types gap: .resolves/.rejects matchers return a real promise typed as void
    await expect(beginFreshCandidate(freshEffects(rec))).rejects.toThrow("crash:writeCandidateRecord");
    expect(rec.calls).toEqual([]);
    expect(rec.counts["createStoreDirectory"]).toBeUndefined();
  });

  it("a crash between the record and the directory leaves the record written, directory absent", async () => {
    const rec = recorder("createStoreDirectory");
    // oxlint-disable-next-line typescript/await-thenable -- bun-types gap: .resolves/.rejects matchers return a real promise typed as void
    await expect(beginFreshCandidate(freshEffects(rec))).rejects.toThrow("crash:createStoreDirectory");
    expect(rec.calls).toEqual(["writeCandidateRecord"]);
  });
});

// The crash-table proof: for each crash boundary of ALL THREE machines, the observed store state maps
// through `classifyStoreBoot` (store-meta.ts) to exactly one boot verdict. Covers every row of the plan's
// fresh/restore, adoption, and destruction crash tables. Adoption's two `adopting` rows additionally pass
// through `classifyAdoptionRecovery` to disambiguate.
describe("three-machine crash-table composition over classifyStoreBoot", () => {
  function obs(
    record: StoreBootObservations["record"],
    opfs: StoreBootObservations["opfs"],
    idbStoreExists = false,
  ): StoreBootObservations {
    return { record, opfs, idbStoreExists };
  }
  const nothingInOpfs = { sentinelPresent: false, storeDirectoryPresent: false };
  const sentinelAndDir = { sentinelPresent: true, storeDirectoryPresent: true };
  const dirOnly = { sentinelPresent: false, storeDirectoryPresent: true };

  const cases: Array<{ name: string; observed: StoreBootObservations; verdict: StoreBootVerdict["action"] }> = [
    // ---- fresh/restore crash table ----
    {
      name: "fresh: before beginFreshCandidate (no record, no dir, no sentinel)",
      observed: obs(undefined, nothingInOpfs),
      verdict: "virgin-create",
    },
    {
      name: "fresh: after writeCandidateRecord, before directory (opfs-candidate, no dir)",
      observed: obs({ phase: "opfs-candidate", updatedAt: 1 }, nothingInOpfs),
      verdict: "delete-candidate-and-rebuild",
    },
    {
      name: "fresh: after createStoreDirectory / after barrier strictSync (opfs-candidate + dir, no sentinel)",
      observed: obs({ phase: "opfs-candidate", updatedAt: 1 }, dirOnly),
      verdict: "delete-candidate-and-rebuild",
    },
    {
      // The barrier-gap crash: the record is STILL `opfs-candidate` (the phase never flipped to committed),
      // but the sentinel was already published. Phase-total authority — a PRESENT record's phase is the sole
      // authority and the sentinel never overrides it, so this is `delete-candidate-and-rebuild` BY DESIGN:
      // nothing was exposed, nothing strands, and a restore just re-invokes `restoreFrom`. Step-10 teardown of
      // `delete-candidate-and-rebuild` deletes the stale sentinel alongside the candidate directory (plan,
      // fresh/restore crash table; CONTEXT § "Commitment marker").
      name: "fresh: barrier-gap crash (opfs-candidate record + sentinel published, phase never flipped)",
      observed: obs({ phase: "opfs-candidate", updatedAt: 3 }, sentinelAndDir),
      verdict: "delete-candidate-and-rebuild",
    },
    {
      // Record LOSS (e.g. partial site-data clearing wiped the meta record) while the sentinel survives.
      // Sentinel authority applies ONLY when the record is absent — a sentinel-without-record reads as
      // committed, so repair the record and open committed (plan; CONTEXT § "Commitment marker").
      name: "fresh: record loss with surviving sentinel (no record, sentinel present)",
      observed: obs(undefined, sentinelAndDir),
      verdict: "repair-record-then-open-committed",
    },
    {
      name: "fresh: barrier complete (opfs-committed + sentinel + dir)",
      observed: obs({ phase: "opfs-committed", updatedAt: 2 }, sentinelAndDir),
      verdict: "open-committed",
    },
    // ---- adoption crash table (adopting rows also go through classifyAdoptionRecovery below) ----
    {
      name: "adoption: setPhase(adopting), no sentinel yet",
      observed: obs({ phase: "adopting", updatedAt: 3 }, dirOnly),
      verdict: "adoption-recovery",
    },
    {
      name: "adoption: sentinel published, still adopting",
      observed: obs({ phase: "adopting", updatedAt: 3 }, sentinelAndDir),
      verdict: "adoption-recovery",
    },
    {
      name: "adoption: completeAdoption set opfs-committed, idb predecessor lingers",
      observed: obs({ phase: "opfs-committed", updatedAt: 4 }, sentinelAndDir, true),
      verdict: "open-committed",
    },
    // ---- destruction crash table ----
    {
      name: "destruction: after setPhase(deleting) — deleting + sentinel + dir",
      observed: obs({ phase: "deleting", updatedAt: 5 }, sentinelAndDir),
      verdict: "resume-deletion",
    },
    {
      name: "destruction: after deleteSentinel — deleting + dir",
      observed: obs({ phase: "deleting", updatedAt: 5 }, dirOnly),
      verdict: "resume-deletion",
    },
    {
      name: "destruction: after deleteBackendStore — deleting only",
      observed: obs({ phase: "deleting", updatedAt: 5 }, nothingInOpfs),
      verdict: "resume-deletion",
    },
    {
      name: "destruction: after deleteMetaRecord — clean, fresh creation permitted",
      observed: obs(undefined, nothingInOpfs),
      verdict: "virgin-create",
    },
  ];

  for (const { name, observed, verdict } of cases) {
    it(`${name} → ${verdict}`, () => {
      expect(classifyStoreBoot(observed).action).toBe(verdict);
    });
  }

  it("adoption-recovery disambiguation: no sentinel → teardown-and-restart, sentinel → complete-adoption", () => {
    expect(classifyAdoptionRecovery({ sentinelPresent: false })).toEqual({ action: "teardown-and-restart" });
    expect(classifyAdoptionRecovery({ sentinelPresent: true })).toEqual({ action: "complete-adoption" });
  });
});
