// Store lifecycle machines — ADR-0049 (capability-driven engine placement) step 3. The fresh/restore
// COMMITMENT BARRIER (decision 7) and the DESTRUCTIVE lifecycle (decision 8) as PURE, EFFECT-DRIVEN modules
// over the plan's crash tables. CONTEXT § "Language — engine placement" terms used exactly: "Commitment
// marker", "Destructive lifecycle".
//
// EFFECT-INJECTED BY CONSTRUCTION. None of these machines touches IndexedDB, OPFS, or PGlite: every side
// effect is a method on an injected effects object. Plan step 10 wires the REAL effects (the meta record IO
// from `store-meta.ts`, the OPFS namespace builders from `store-path.ts`, the live engine's `strictSync()`);
// unit tests inject fakes and simulate a crash by making one effect throw, then re-run the resume path from
// the observed state. Because of that, EVERY step must be IDEMPOTENT under resume — each effect's contract
// below states the idempotency the wirer must provide (delete-if-present, create-if-absent, set-phase-again).
//
// The PROVENANCE GATES themselves (fresh = successful local initialization/recovery; restore = successful
// backup load + restore recovery) are CALLER facts, not modelled here: the caller invokes the barrier only
// AFTER its provenance gate has passed. This module owns the shared data-before-authority SEQUENCE, not the
// gates that authorize entering it.

import type { StoreMetaPhase } from "./store-meta";

// =========================================================================================================
// A. The shared commitment barrier (ADR-0049 decision 7 — one strict data-before-authority sequence)
// =========================================================================================================

/**
 * The effects the shared commitment barrier drives, in the one order it always runs them. The barrier is the
 * SINGLE data-before-authority sequence every provenance shares (fresh, restore): the caller has already
 * passed its provenance gate; the barrier makes the data durable, THEN publishes authority.
 */
export interface CommitmentBarrierEffects {
  /**
   * The explicit `strictSync()` on the live engine. MUST resolve ONLY when the sync returned AND VFS health
   * is good (data-before-authority — required even under relaxed runtime durability, ADR-0049 D7/D9).
   * Throwing ABORTS the barrier: nothing downstream runs, so nothing publishes. No idempotency requirement —
   * it is the first step and is never resumed past.
   */
  strictSyncReturns(): Promise<void>;
  /**
   * Publish the commitment sentinel (`pgxsinkit/commitments/<identity>`, the "Commitment marker"). Published
   * BEFORE the record's committed phase, so a crash between the two reads as committed off the sentinel
   * (store-meta's `repair-record-then-open-committed`). Idempotency required: CREATE-IF-ABSENT (a resume that
   * finds the sentinel already there is a no-op success).
   */
  publishSentinel(): Promise<void>;
  /**
   * Advance the store meta record phase. The barrier only ever calls it with `"opfs-committed"`. Idempotency
   * required: SET-PHASE-AGAIN is a no-op success (writing the same phase twice is harmless).
   */
  setPhase(phase: StoreMetaPhase): Promise<void>;
}

/**
 * Run the shared commitment barrier (ADR-0049 decision 7): `strictSync()` returns with VFS health good →
 * publish the sentinel → set the `opfs-committed` phase. The caller invokes this ONLY after its provenance
 * gate has passed (fresh: local init/recovery; restore: backup load + restore recovery). Any throw propagates
 * and later steps NEVER run — so a failed barrier publishes NOTHING and an uncommitted candidate is never
 * granted authority (invariant 3). After it resolves the caller exposes the store.
 */
export async function runCommitmentBarrier(effects: CommitmentBarrierEffects): Promise<void> {
  await effects.strictSyncReturns();
  await effects.publishSentinel();
  await effects.setPhase("opfs-committed");
}

// =========================================================================================================
// E. Fresh/restore candidate flow helper (record-first — invariant 12)
// =========================================================================================================
// (Declared here, before the barrier's downstream machines, because it is the barrier's UPSTREAM half: it
//  builds the uncommitted candidate the barrier later commits.)

/** The effects that stand up a fresh/restore candidate before the commitment barrier commits it. */
export interface FreshCandidateEffects {
  /**
   * Write the store meta record at `{ phase: "opfs-candidate" }`. Written FIRST — the record is the first-use
   * authority (invariant 12), so a crash after this but before the directory leaves a state the boot
   * classifier maps to `delete-candidate-and-rebuild` (an unexposed candidate has no authority). Idempotency
   * required: overwrite-if-present.
   */
  writeCandidateRecord(): Promise<void>;
  /** Create the store's OPFS directory (`pgxsinkit/stores/<identity>`). Idempotency required: create-if-absent. */
  createStoreDirectory(): Promise<void>;
}

/**
 * Begin a fresh/restore candidate: write the `opfs-candidate` meta record BEFORE creating the store
 * directory. Order is load-bearing (record-first authority, invariant 12) — a crash between the two leaves an
 * `opfs-candidate` record whose directory may be absent, which the boot classifier deletes and rebuilds
 * fresh. The forward path from here is the shared {@link runCommitmentBarrier} (after the caller's provenance
 * gate). Full fresh/restore wiring is plan step 10.
 */
export async function beginFreshCandidate(effects: FreshCandidateEffects): Promise<void> {
  await effects.writeCandidateRecord();
  await effects.createStoreDirectory();
}

// =========================================================================================================
// B. Destruction machine (ADR-0049 decision 8; plan "Destructive lifecycle")
// =========================================================================================================

/**
 * The effects the destructive lifecycle drives. ONE backend-agnostic machine: {@link deleteBackendStore} is a
 * single effect the wirer (plan step 10) branches by backend (OPFS store directory OR the idb database) — the
 * machine never knows which. The supervisor-level REFUSALS that guard this machine (owed mutations unless
 * `force`; other tabs still holding claims — close the peers first) live OUTSIDE it, in the coordinator/
 * communication-centre supervisor that survives engine shutdown (ADR-0049 D8, plan step 10). This module owns
 * only the resumable delete SEQUENCE once destruction is authorized and the engine is quiesced/closed.
 */
export interface DestructionEffects {
  /** Advance the meta record phase; the machine only ever calls it with `"deleting"`. Idempotency: set-again. */
  setPhase(phase: StoreMetaPhase): Promise<void>;
  /** Delete the commitment sentinel. Idempotency required: ABSENT COUNTS AS DELETED (delete-if-present). */
  deleteSentinel(): Promise<void>;
  /**
   * Delete the backend store — the OPFS store directory OR the idb database, chosen by the wirer; the machine
   * is backend-agnostic. Idempotency required: absent counts as deleted (delete-if-present).
   */
  deleteBackendStore(): Promise<void>;
  /** Delete the store meta record — the terminal step. Idempotency required: absent counts as deleted. */
  deleteMetaRecord(): Promise<void>;
}

/**
 * The resume path of the destructive lifecycle, entered from an observed `deleting` phase (a boot that finds
 * `deleting` completes the deletion first — invariant 13): delete sentinel → delete backend store → delete
 * meta record. Every step is idempotent, so a crash at any boundary and a re-run from the top completes
 * cleanly (plan's destruction crash table — each row is `resume-deletion` until the record is gone).
 */
export async function resumeDeletion(effects: DestructionEffects): Promise<void> {
  await effects.deleteSentinel();
  await effects.deleteBackendStore();
  await effects.deleteMetaRecord();
}

/**
 * Run the full destructive lifecycle from an already-quiesced engine (ADR-0049 D8): record the `deleting`
 * phase (highest-precedence commitment that survives a crash), then {@link resumeDeletion}. The upstream steps
 * (refuse owed mutations unless `force`, stop admissions, quiesce/close the engine) and the supervision that
 * lets the initiating `destroy()` resolve from a context surviving engine shutdown are plan step 10 — this
 * machine begins once destruction is authorized and the engine is down.
 */
export async function runDestruction(effects: DestructionEffects): Promise<void> {
  await effects.setPhase("deleting");
  await resumeDeletion(effects);
}
