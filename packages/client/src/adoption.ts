// Adoption orchestrator + declaration surface — ADR-0049 (capability-driven engine placement) decision 7,
// plan step 11a. The automatic and manual adoption transitions that turn an existing idb-authoritative store
// into a committed opfs successor, expressed as ONE pure, effect-injected sequence over the plan's
// "Adoption sequence (exclusive, quiescent — D7)" and its adoption crash rows. CONTEXT § "Language — engine
// placement" terms are used exactly: "Adoption gate", "Adoption-bootstrap gate", "Drain predicate".
//
// EFFECT-INJECTED BY CONSTRUCTION. Like `store-lifecycle.ts`, this module touches NO IndexedDB, OPFS, or
// PGlite: every side effect is a method on an injected {@link AdoptionEffects}. Plan step 11b wires the REAL
// effects into the boot path (`createSyncClient` / `defineSyncWorker`) — the pre-expose idb boot, the drain
// read, the opfs candidate build via the normal server bootstrap through the Adoption-bootstrap gate, the
// shared commitment barrier (`runCommitmentBarrier` from `store-lifecycle.ts`), and the predecessor deletion.
// Here the orchestrator owns only the DECISION SEQUENCE and its failure recovery; wiring is NOT this step.
//
// INVARIANTS (ADR-0049): the transition runs at boot BEFORE any engine is exposed — the caller guarantees
// pre-expose exclusivity (invariant 3, no-race-by-construction), so the drain predicate cannot be raced by a
// concurrent mutation. Automatic adoption is default OFF and consults the declaration FIRST (invariant 4 — no
// silent local-only data loss; hook absence is never authority because `rawExec` writes documented local-only
// state on any store). The idb predecessor is deleted ONLY after the commitment barrier publishes
// (invariant 3/4 — commitment precedes exposure; nothing strands, nothing is silently lost).

import { journalOwesNothing, runCommitmentBarrier, type JournalStatusCounts } from "./store-lifecycle";
import type { StoreBootVerdict, StoreMetaPhase } from "./store-meta";

/**
 * The consumer's explicit reconstructibility declaration (ADR-0049 D7). `"server-reconstructible"` authorizes
 * AUTOMATIC adoption: the store is server-reconstructible and its local-only data is disposable. DEFAULT OFF
 * (`undefined`) — hook absence is NEVER authority: `rawExec` writes documented local-only state on any store,
 * so only this explicit declaration (or the manual adoption API) authorizes deleting the idb predecessor.
 */
export type AdoptionDeclaration = "server-reconstructible" | undefined;

/**
 * The effects the adoption transition drives, in the one order it always runs them (step 11b supplies the real
 * implementations). The transition is a strict data-before-authority sequence: prove the idb store owes the
 * server nothing, reconstruct an opfs successor through the Adoption-bootstrap gate, commit it via the shared
 * barrier, and only THEN delete the predecessor.
 */
export interface AdoptionEffects {
  /**
   * Boot the idb engine PRE-EXPOSE (never surfaced to tabs — invariant 3) and return the journal status
   * counts the drain predicate reads. The engine is booted solely to read the journal; the caller never
   * exposes THIS booted instance until adoption defers (journal owed) or fails.
   */
  bootIdbPreExpose(): Promise<JournalStatusCounts>;
  /** Strict-sync the never-exposed idb engine, then close it (all handles released) before building the successor. */
  strictSyncAndCloseIdb(): Promise<void>;
  /** Advance the store meta record phase. The transition calls it with `"adopting"` and, on failure, `"idb-authoritative"`. */
  setPhase(phase: StoreMetaPhase): Promise<void>;
  /**
   * Build the opfs candidate via the normal server bootstrap path AND await the Adoption-bootstrap gate:
   * authorized online reconstruction — the initial catch-up of the eager Consistency groups a valid initial
   * store requires ("authorized" includes legitimately anonymous/public shapes). Resolves ONLY when the gate
   * passed; THROWS on gate failure (offline, unauthorized, `syncEnabled: false`, or a bootstrap error).
   */
  buildCandidateThroughGate(): Promise<void>;
  /**
   * Run the shared commitment barrier on the CANDIDATE engine: `strictSync()` returns with VFS health good →
   * sentinel → `opfs-committed`. Step 11b wires `runCommitmentBarrier` (store-lifecycle.ts) with real effects;
   * here it is one injected step. It MUST be all-or-nothing: a barrier failure publishes NOTHING (invariant 3),
   * so a throw leaves the idb store authoritative and the candidate uncommitted.
   */
  commitCandidate(): Promise<void>;
  /** Delete the idb predecessor now the opfs successor is committed. Idempotent: absent counts as deleted. */
  deleteIdbPredecessor(): Promise<void>;
  /**
   * Tear down a failed candidate: delete the stale sentinel (if any) AND the candidate directory,
   * delete-if-present (a barrier-gap crash's sentinel must never survive). Recreate-only; idempotent.
   */
  teardownCandidate(): Promise<void>;
}

/** The narrow candidate surface the real boot wiring hands this module. */
export interface AdoptionCandidateHandle {
  ready: Promise<void>;
  strictSync(): Promise<void>;
  close(): Promise<void>;
}

/** IO callbacks needed to construct the real stateful adoption effects without importing the client entrypoint. */
export interface AdoptionEffectBuilderOptions {
  readIdbJournal(): Promise<JournalStatusCounts>;
  setPhase(phase: StoreMetaPhase): Promise<void>;
  buildCandidate(): Promise<AdoptionCandidateHandle>;
  publishSentinel(): Promise<void>;
  deleteSentinel(): Promise<void>;
  deleteStoreDirectory(): Promise<void>;
  deleteIdbPredecessor(): Promise<void>;
  gateDeadlineMs?: number;
}

const DEFAULT_ADOPTION_GATE_DEADLINE_MS = 30_000;

async function awaitAdoptionGate(ready: Promise<void>, deadlineMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            "[pgxsinkit] adoption gate unmet: the eager Consistency groups did not complete their initial " +
              `catch-up within ${deadlineMs}ms (offline, unauthorized, or the server was unreachable). The idb ` +
              "store stays authoritative.",
          ),
        ),
      deadlineMs,
    );
  });
  try {
    await Promise.race([ready, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Construct the stateful adoption effects around narrow IO callbacks. Candidate ownership, gate timing,
 * data-before-authority publication, and failed-candidate cleanup live here rather than in the package entrypoint.
 */
export function buildAdoptionEffects(options: AdoptionEffectBuilderOptions): AdoptionEffects {
  let candidate: AdoptionCandidateHandle | undefined;
  return {
    bootIdbPreExpose: () => options.readIdbJournal(),
    async strictSyncAndCloseIdb() {
      // The callback's drain read closes its read-only strict IDB engine before returning.
    },
    setPhase: (phase) => options.setPhase(phase),
    async buildCandidateThroughGate() {
      candidate = await options.buildCandidate();
      await awaitAdoptionGate(candidate.ready, options.gateDeadlineMs ?? DEFAULT_ADOPTION_GATE_DEADLINE_MS);
    },
    async commitCandidate() {
      const active = candidate;
      if (active === undefined) throw new Error("[pgxsinkit] adoption: commit called before the candidate was built");
      await runCommitmentBarrier({
        strictSyncReturns: () => active.strictSync(),
        publishSentinel: () => options.publishSentinel(),
        setPhase: (phase) => options.setPhase(phase),
      });
      await active.close().catch(() => undefined);
      candidate = undefined;
    },
    deleteIdbPredecessor: () => options.deleteIdbPredecessor(),
    async teardownCandidate() {
      if (candidate !== undefined) {
        await candidate.close().catch(() => undefined);
        candidate = undefined;
      }
      await options.deleteSentinel();
      await options.deleteStoreDirectory();
    },
  };
}

/**
 * The outcome of an adoption transition. `adopted: true` means the opfs successor is committed and the idb
 * predecessor is gone (or scheduled for cleanup — see `predecessorCleanupPending`). Every `adopted: false`
 * outcome leaves the idb store AUTHORITATIVE and untouched:
 * - `not-declared` — automatic adoption without the declaration (default off); nothing ran (invariant 4).
 * - `journal-owed` — the drain predicate failed; adoption is DEFERRED (the caller exposes the idb engine
 *   normally). The orchestrator boots the idb engine to READ the journal but exposes nothing itself.
 * - `gate-failed` — the Adoption-bootstrap gate rejected (offline/unauthorized/`syncEnabled: false`/bootstrap
 *   error). The candidate was torn down; idb stays authoritative. `error` carries the gate failure text.
 * - `barrier-failed` — the commitment barrier threw (strict sync did not return / VFS health bad). Nothing
 *   published; candidate torn down; idb stays authoritative. `error` carries the barrier failure text.
 */
export type AdoptionOutcome =
  | {
      adopted: true;
      /**
       * Set only when the predecessor deletion FAILED after a successful commit. Adoption still SUCCEEDED
       * (the phase is `opfs-committed`); the boot classifier's lingering-idb row (adoption crash-row 3 →
       * `opfs-committed` with an idb store present → `open-committed`, then `completeAdoption` finishes the
       * deletion) completes the cleanup on the next boot. Carries the deletion failure text for diagnostics.
       */
      predecessorCleanupPending?: string;
    }
  | { adopted: false; reason: "not-declared" | "journal-owed" | "gate-failed" | "barrier-failed"; error?: string };

/** Extract a stable message from a thrown value (an `Error`'s message, else its string form). */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The shared transition body — identical for the automatic and manual entry points (they differ ONLY in the
 * declaration check, applied before this runs). Steps, in order (plan "Adoption sequence"):
 *
 * 1. Boot the idb engine pre-expose and read the journal. NOT drained → `journal-owed` (the orchestrator boots
 *    NOTHING further and exposes NOTHING itself — the caller then exposes the idb engine normally; adoption
 *    deferred). Drained → continue.
 * 2. Strict-sync + close the never-exposed idb engine.
 * 3. Phase → `adopting`.
 * 4. Build the opfs candidate through the Adoption-bootstrap gate. On throw → tear the candidate down + set
 *    `idb-authoritative` (idb stays authoritative, plan gate-unmet row) → `gate-failed`.
 * 5. Commit the candidate via the shared barrier. On throw → tear the candidate down + set `idb-authoritative`
 *    → `barrier-failed` (the barrier is all-or-nothing; nothing published).
 * 6. Delete the idb predecessor → adopted. A deletion throw here does NOT unadopt: the phase is already
 *    `opfs-committed`, so the outcome is `adopted: true` with `predecessorCleanupPending` recorded and the
 *    classifier's lingering-idb row finishes the deletion next boot.
 */
async function runTransition(effects: AdoptionEffects): Promise<AdoptionOutcome> {
  const counts = await effects.bootIdbPreExpose();
  if (!journalOwesNothing(counts)) return { adopted: false, reason: "journal-owed" };

  await effects.strictSyncAndCloseIdb();
  await effects.setPhase("adopting");

  try {
    await effects.buildCandidateThroughGate();
  } catch (error) {
    // Adoption-bootstrap gate unmet (offline/unauthorized/syncEnabled: false/bootstrap error): nothing
    // published, so idb stays authoritative (plan "Adoption gate unmet" row).
    await effects.teardownCandidate();
    await effects.setPhase("idb-authoritative");
    return { adopted: false, reason: "gate-failed", error: errorText(error) };
  }

  try {
    await effects.commitCandidate();
  } catch (error) {
    // The barrier is all-or-nothing — a failure publishes NOTHING (invariant 3). Recover to idb-authoritative.
    await effects.teardownCandidate();
    await effects.setPhase("idb-authoritative");
    return { adopted: false, reason: "barrier-failed", error: errorText(error) };
  }

  try {
    await effects.deleteIdbPredecessor();
  } catch (error) {
    // Adoption already SUCCEEDED (phase `opfs-committed`); a failed predecessor deletion never unadopts. The
    // boot classifier's lingering-idb row completes the deletion next boot (plan adoption crash-row 3).
    return { adopted: true, predecessorCleanupPending: errorText(error) };
  }
  return { adopted: true };
}

/**
 * The AUTOMATIC adoption transition, run at boot BEFORE any engine is exposed (the caller guarantees pre-expose
 * exclusivity — invariant 3's no-race-by-construction). Consults the {@link AdoptionDeclaration} FIRST: without
 * `"server-reconstructible"` it refuses with `not-declared` and runs ZERO effects (invariant 4 — default off,
 * hook absence is never authority). With the declaration it runs the shared {@link runTransition}.
 */
export function runAdoptionTransition(
  declaration: AdoptionDeclaration,
  effects: AdoptionEffects,
): Promise<AdoptionOutcome> {
  if (declaration !== "server-reconstructible") {
    return Promise.resolve({ adopted: false, reason: "not-declared" });
  }
  return runTransition(effects);
}

/**
 * The MANUAL adoption API's core: the identical transition, but WITHOUT the declaration check — the consumer's
 * explicit call IS the authorization (they were told to export/migrate any local-only data first). The drain
 * predicate still gates it (a store that owes the server work is not adoptable), and every failure recovery is
 * identical to the automatic path.
 */
export function runManualAdoption(effects: AdoptionEffects): Promise<AdoptionOutcome> {
  return runTransition(effects);
}

/**
 * The boot-wiring predicate (plan step 11b): is a boot eligible to START an automatic adoption? True IFF the
 * consumer declared `"server-reconstructible"` AND opfs sync access is available in this scope AND the boot
 * classifier landed on `boot-idb-authoritative` — adoption only ever starts from an idb-authoritative store
 * with opfs available (there is nowhere to build the successor otherwise, and no other verdict is a candidate).
 */
export function adoptionEligible(
  declaration: AdoptionDeclaration,
  verdict: StoreBootVerdict,
  hasOpfsSyncAccess: boolean,
): boolean {
  return declaration === "server-reconstructible" && hasOpfsSyncAccess && verdict.action === "boot-idb-authoritative";
}
