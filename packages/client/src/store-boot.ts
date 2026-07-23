// Store boot resolution — assemble the boot observations and EXECUTE the classifier's verdict with real
// effects (ADR-0049 capability-driven engine placement, plan step 10a). `store-meta.ts` owns the PURE
// classifier ({@link classifyStoreBoot}, boot classification 1–7) and the meta-record IO; `store-lifecycle.ts`
// owns the PURE, effect-injected destruction/adoption/fresh-candidate machines; `opfs-effects.ts` owns the
// concrete OPFS side. This module is the WIRING that reads the meta record, observes the commitment namespace
// and the recordless idb fact, classifies, and then runs the destructive/candidate/adoption effects BEFORE
// returning the resolved `dataDir` + `storageBackend` a caller opens the store at.
//
// It never assembles a storage URL itself — every `dataDir` comes from `store-path.ts`'s
// {@link resolveStoreDataDir}, which stays the toolkit's only URL assembler. It carries no DOM lib dependency
// and takes injectable deps (meta IO, OPFS root, the recordless idb existence check) so Bun unit tests fake the
// whole surface with no real IndexedDB / OPFS / WASM.
//
// THE COMMITMENT BARRIER IS NOT HERE. When the verdict stands up a fresh opfs CANDIDATE (`virgin-create` /
// `delete-candidate-and-rebuild` with opfs access), this function returns with the candidate's record at
// `opfs-candidate` and its directory created but UNCOMMITTED. The strict-sync → sentinel → `opfs-committed`
// barrier that promotes it (invariant 3 — an uncommitted candidate is never exposed to writes) is the mint
// seam's post-open work, wired in plan step 10b/11. The returned {@link StoreBootResolution.verdict} tells the
// caller a candidate is uncommitted and needs that barrier.

import { createOpfsEffects, type OpfsEffectsDeps } from "./opfs-effects";
import { beginFreshCandidate, classifyAdoptionRecovery, completeAdoption, resumeDeletion } from "./store-lifecycle";
import {
  classifyStoreBoot,
  deleteStoreMetaRecord,
  idbStoreExists as defaultIdbStoreExists,
  META_STORE_UNAVAILABLE,
  readStoreMetaRecord,
  type StoreBootVerdict,
  type StoreMetaDeps,
  type StoreMetaPhase,
  writeStoreMetaRecord,
} from "./store-meta";
import { resolveStoreDataDir, storeIndexedDbDatabaseName } from "./store-path";

/**
 * The resolved storage backend a boot lands on. `opfs-repacked` (the elected/SW-direct opfs engine home),
 * `idbfs` (browser, no sync-access handles), `filesystem` (Bun/Node), or `memory` (the sanctioned
 * test/ephemeral lane). Surfaced on the BootReport as an additive field under the ADR-0034 reportVersion
 * rule (additive fields keep `reportVersion: 1`); ADR-0049 named the backends.
 */
export type ResolvedStorageBackend = "opfs-repacked" | "idbfs" | "filesystem" | "memory";

/** The outcome of {@link resolveStoreBoot}: the URL to open the store at, its backend, and the boot verdict. */
export interface StoreBootResolution {
  /** The PGlite dataDir URL, always assembled by {@link resolveStoreDataDir} (the one URL assembler). */
  dataDir: string;
  /** The resolved backend, for diagnostics. */
  storageBackend: ResolvedStorageBackend;
  /**
   * The executed boot verdict. Absent on the passthrough backends (`memory` / `filesystem`), which have NO
   * meta machinery. Present on every browser classification — in particular it is the signal that an opfs
   * CANDIDATE was stood up UNCOMMITTED (`virgin-create` / `delete-candidate-and-rebuild`): the mint seam must
   * run the commitment barrier before exposing that store to writes (plan step 10b/11).
   */
  verdict?: StoreBootVerdict;
}

/** Options for {@link resolveStoreBoot}. */
export interface ResolveStoreBootOptions {
  /** The placement probe's result, injected by the caller (invariant 8 — probe per boot, never cached here). */
  hasOpfsSyncAccess: boolean;
  /** The internal test-only memory backend override (ADR-0036), carried through from the mint seam. */
  backendOverride?: "memory";
  /** Injectable IO seams so Bun unit tests fake the whole browser surface. */
  deps?: {
    /** The store-meta IndexedDB seam (defaults to `globalThis.indexedDB` inside store-meta). */
    meta?: StoreMetaDeps;
    /** The OPFS root seam (defaults to `navigator.storage.getDirectory` inside opfs-effects). */
    opfs?: OpfsEffectsDeps;
    /** The recordless idb existence check (defaults to store-meta's non-creating {@link idbStoreExists}). */
    idbExists?: (storePath: string) => Promise<boolean>;
  };
}

/**
 * Bounded re-classification budget. Only `resume-deletion` re-runs the loop: it completes the destructive
 * lifecycle (delete sentinel → backend store → meta record), which leaves a CLEAN state whose next
 * classification is necessarily terminal (`virgin-create` or, if an idb store somehow lingers, an idb boot).
 * One resume is enough; the small budget is a guard against an unexpected non-terminating cycle.
 */
const MAX_DELETION_RECLASSIFY = 4;

/** The minimal structural shape of the `indexedDB.deleteDatabase` surface (no DOM lib). */
interface IdbDeleteSurface {
  deleteDatabase(name: string): {
    error?: unknown;
    onsuccess: (() => void) | null;
    onerror: (() => void) | null;
    onblocked?: (() => void) | null;
  };
}

/** Resolve the `deleteDatabase` surface: injected meta deps first (tests), else structural off `globalThis`. */
function resolveDeleteSurface(meta?: StoreMetaDeps): IdbDeleteSurface | undefined {
  if (meta != null && "indexedDB" in meta) return meta.indexedDB as unknown as IdbDeleteSurface | undefined;
  return (globalThis as { indexedDB?: IdbDeleteSurface }).indexedDB;
}

/**
 * Delete-if-present the PGlite idb database for a store (`indexedDB.deleteDatabase`), backend-agnostic and
 * idempotent: absent counts as deleted, while a real failure rejects. The database name comes
 * ONLY from {@link storeIndexedDbDatabaseName} (store-path's sole owner of PGlite's `/pglite/` naming).
 */
function deleteIdbDatabase(storePath: string, meta?: StoreMetaDeps): Promise<void> {
  const idb = resolveDeleteSurface(meta);
  if (idb?.deleteDatabase == null) return Promise.resolve();
  const name = storeIndexedDbDatabaseName(storePath);
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) clearTimeout(timeout);
      if (error === undefined) resolve();
      else reject(error);
    };
    let request: {
      error?: unknown;
      onsuccess: (() => void) | null;
      onerror: (() => void) | null;
      onblocked?: (() => void) | null;
    };
    try {
      request = idb.deleteDatabase(name);
    } catch (error) {
      finish(error);
      return;
    }
    request.onsuccess = () => finish();
    request.onerror = () => finish(request.error ?? new Error(`indexedDB deletion failed for ${name}`));
    request.onblocked = () => undefined;
    timeout = setTimeout(() => finish(new Error(`indexedDB deletion timed out while blocked for ${name}`)), 5_000);
  });
}

/** Is IndexedDB present (a browser/worker scope)? Injected meta deps win so tests select the browser branch. */
function resolveHasIndexedDb(meta?: StoreMetaDeps): boolean {
  if (meta != null && "indexedDB" in meta) return meta.indexedDB != null;
  return typeof (globalThis as { indexedDB?: unknown }).indexedDB !== "undefined";
}

/**
 * A probe-denied browser still has to honour an existing `deleting` phase before it may create a replacement
 * IDB store. The old cache is already explicitly destructible; the only authority handoff required is to
 * remove the OPFS commitment sentinel, then publish `idb-authoritative` before the replacement is exposed.
 * Any sentinel-less directory is disposable residue and is removed before a later OPFS candidate is minted.
 */
export async function recoverDeniedBootDeletion(
  storePath: string,
  deps?: ResolveStoreBootOptions["deps"],
): Promise<boolean> {
  const meta = deps?.meta;
  const record = await readStoreMetaRecord(storePath, meta);
  if (record === META_STORE_UNAVAILABLE || record?.phase !== "deleting") return false;

  const effects = createOpfsEffects(storePath, deps?.opfs);
  // If the namespace cannot be observed, sentinel deletion cannot be confirmed. Keep `deleting` authoritative
  // and fail closed rather than publish a conflicting replacement.
  if ((await effects.observeCommitmentNamespace()) === "unobservable") {
    throw new Error(
      `[pgxsinkit] cannot resume deletion for ${JSON.stringify(storePath)}: the OPFS commitment namespace is ` +
        "unobservable in this scope, so sentinel removal cannot be confirmed.",
    );
  }
  await deleteIdbDatabase(storePath, meta);
  await effects.deleteSentinel();
  await writeStoreMetaRecord(storePath, { phase: "idb-authoritative", updatedAt: Date.now() }, meta);
  return true;
}

/**
 * Resolve where a store boots and finish any destructive/candidate/adoption work the verdict demands, then
 * return the `dataDir` + `storageBackend` the mint seam opens at. The full plan boot classification 1–7,
 * EXECUTED:
 *
 * - **memory override** → `memory://` passthrough, no classification (the sanctioned test/ephemeral lane has
 *   no meta machinery).
 * - **non-browser** (no idb, no opfs handles) → `file://` passthrough, no classification (the filesystem
 *   backend has no meta machinery either).
 * - **browser** → read the meta record ({@link readStoreMetaRecord}; {@link StoreMetaUnreadableError}
 *   propagates = fail closed, invariant 12), map {@link META_STORE_UNAVAILABLE} to a provable absence
 *   (no idb ⇒ no record and no existing idb store), observe the commitment namespace and the recordless idb fact,
 *   classify, and execute:
 *   - `resume-deletion` → complete the destructive lifecycle, then RE-CLASSIFY from the now-clean state
 *     (bounded by {@link MAX_DELETION_RECLASSIFY}).
 *   - `delete-candidate-and-rebuild` → delete the stale sentinel AND the candidate directory (a barrier-gap
 *     crash's sentinel must never survive), then rebuild per placement (the virgin path).
 *   - `repair-record-then-open-committed` → write `opfs-committed`, then open committed.
 *   - `open-committed` → open the committed opfs store (open failures are HARD at mint time; the bounded
 *     retries for transient UnknownError-class failures live in the mint seam's factory-call wrapper).
 *   - `boot-idb-authoritative` → write `idb-authoritative` FIRST when there is no record yet (recordless idb), then
 *     `idb://`.
 *   - `adoption-recovery` → {@link classifyAdoptionRecovery}: `complete-adoption` finishes the barrier
 *     (`opfs-committed` + delete the idb predecessor) → `opfs://`; `teardown-and-restart` tears the candidate
 *     down, sets `idb-authoritative`, and boots `idb://` (adoption re-runs later, plan step 11).
 *   - `virgin-create` → with opfs access, {@link beginFreshCandidate} (record `opfs-candidate` BEFORE the
 *     directory) → `opfs://` UNCOMMITTED (barrier is step 10b/11); without opfs access, `idb-authoritative` →
 *     `idb://`.
 */
export async function resolveStoreBoot(storePath: string, opts: ResolveStoreBootOptions): Promise<StoreBootResolution> {
  const meta = opts.deps?.meta;

  // Memory override: the sanctioned test/ephemeral lane. No meta machinery — a memory store lives only for the
  // instance about to be created (documented in store-path's `storeTargetExists`).
  if (opts.backendOverride === "memory") {
    return { dataDir: resolveStoreDataDir(storePath, "memory"), storageBackend: "memory" };
  }

  // Non-browser (no IndexedDB, no opfs handles): the filesystem backend has no meta machinery. Passthrough.
  const hasIndexedDb = resolveHasIndexedDb(meta);
  if (!hasIndexedDb && !opts.hasOpfsSyncAccess) {
    return {
      dataDir: resolveStoreDataDir(storePath, undefined, { hasIndexedDb: false }),
      storageBackend: "filesystem",
    };
  }

  const effects = createOpfsEffects(storePath, opts.deps?.opfs);
  const idbExists = opts.deps?.idbExists ?? ((sp: string) => defaultIdbStoreExists(sp, meta));

  // The two browser dataDir forms — always via store-path (the one URL assembler). A COMMITTED opfs store
  // opens on opfs regardless of THIS boot's probe result (the committed store is opfs by construction); an
  // open failure in a scope without handles is a hard mint-time failure, not a re-derivation.
  const opfsDataDir = resolveStoreDataDir(storePath, undefined, { hasIndexedDb: true, hasOpfsSyncAccess: true });
  const idbDataDir = resolveStoreDataDir(storePath, undefined, { hasIndexedDb: true, hasOpfsSyncAccess: false });

  const writePhase = (phase: StoreMetaPhase): Promise<void> =>
    writeStoreMetaRecord(storePath, { phase, updatedAt: Date.now() }, meta);

  // The virgin creation path — reused by `virgin-create` and by `delete-candidate-and-rebuild`'s rebuild.
  const finishVirginCreate = async (verdict: StoreBootVerdict): Promise<StoreBootResolution> => {
    if (opts.hasOpfsSyncAccess) {
      // Record-first authority (invariant 12): the `opfs-candidate` record is written BEFORE the directory, so
      // a crash between them leaves a candidate a later boot deletes and rebuilds. Returned UNCOMMITTED — the
      // commitment barrier is the mint seam's post-open work (plan step 10b/11).
      await beginFreshCandidate({
        writeCandidateRecord: () => writePhase("opfs-candidate"),
        createStoreDirectory: async () => {
          await effects.getStoreDirectoryHandle();
        },
      });
      return { dataDir: opfsDataDir, storageBackend: "opfs-repacked", verdict };
    }
    // No opfs handles in this scope: create an idb store instead (classification 7). Record first.
    await writePhase("idb-authoritative");
    return { dataDir: idbDataDir, storageBackend: "idbfs", verdict };
  };

  // Only `resume-deletion` loops; every other verdict returns. Deletion → clean state → a terminal verdict.
  for (let iteration = 0; iteration < MAX_DELETION_RECLASSIFY; iteration += 1) {
    // A failed meta read is an ERROR, never "no record" (invariant 12): StoreMetaUnreadableError propagates
    // here and fails the boot closed.
    const metaResult = await readStoreMetaRecord(storePath, meta);
    // META_STORE_UNAVAILABLE means IndexedDB is entirely absent — a no-idb scope cannot hold a record, so
    // absence is PROVABLE (record undefined) and there can be no existing idb store either (idbStoreExists
    // false). Faithful to store-meta's documented mapping.
    const metaUnavailable = metaResult === META_STORE_UNAVAILABLE;
    const record = metaUnavailable ? undefined : metaResult;
    const opfsObservation = await effects.observeCommitmentNamespace();
    const idbPresent = metaUnavailable ? false : await idbExists(storePath);
    const verdict = classifyStoreBoot({ record, opfs: opfsObservation, idbStoreExists: idbPresent });

    switch (verdict.action) {
      case "resume-deletion":
        // Complete the destructive lifecycle. `deleteBackendStore` is backend-agnostic: a `deleting` record
        // does not say which backend, so we delete-if-present BOTH the opfs directory and the idb database
        // (idempotent). Then re-classify from the now-clean state.
        await resumeDeletion({
          setPhase: writePhase,
          deleteSentinel: () => effects.deleteSentinel(),
          deleteBackendStore: async () => {
            await effects.deleteStoreDirectory();
            await deleteIdbDatabase(storePath, meta);
          },
          deleteMetaRecord: () => deleteStoreMetaRecord(storePath, meta),
        });
        continue;

      case "delete-candidate-and-rebuild":
        // An unexposed candidate has no authority. The stale sentinel MUST go alongside the directory — a
        // barrier-gap crash's published sentinel must never survive into the rebuilt candidate's lifetime
        // (plan fresh/restore crash table). Then rebuild per placement.
        await effects.deleteSentinel();
        await effects.deleteStoreDirectory();
        return finishVirginCreate(verdict);

      case "repair-record-then-open-committed":
        // Sentinel present without a record (record loss): the sentinel is committed authority. Repair the
        // record, then open committed.
        await writePhase("opfs-committed");
        if (idbPresent) await deleteIdbDatabase(storePath, meta);
        return { dataDir: opfsDataDir, storageBackend: "opfs-repacked", verdict };

      case "open-committed":
        // Adoption may have committed before its predecessor deletion completed. Finish that cleanup
        // idempotently before publishing the committed store to this boot.
        if (idbPresent) await deleteIdbDatabase(storePath, meta);
        return { dataDir: opfsDataDir, storageBackend: "opfs-repacked", verdict };

      case "boot-idb-authoritative":
        // Recordless idb store (no record yet, an existing idb store): write the record FIRST (invariant 14). A
        // present `idb-authoritative` record is left as-is.
        if (record == null) await writePhase("idb-authoritative");
        return { dataDir: idbDataDir, storageBackend: "idbfs", verdict };

      case "adoption-recovery": {
        // Disambiguate purely from the sentinel (plan adoption crash rows). "unobservable" ⇒ no sentinel.
        const sentinelPresent = opfsObservation !== "unobservable" && opfsObservation.sentinelPresent;
        const recovery = classifyAdoptionRecovery({ sentinelPresent });
        if (recovery.action === "complete-adoption") {
          // The barrier had published before the crash: set `opfs-committed`, delete the idb predecessor.
          await completeAdoption({
            setPhase: writePhase,
            deleteIdbPredecessor: () => deleteIdbDatabase(storePath, meta),
          });
          return { dataDir: opfsDataDir, storageBackend: "opfs-repacked", verdict };
        }
        // Nothing committed: tear the candidate down and fall back to the still-authoritative idb store.
        // Adoption re-runs later from step 1 (plan step 11).
        await effects.deleteSentinel();
        await effects.deleteStoreDirectory();
        await writePhase("idb-authoritative");
        return { dataDir: idbDataDir, storageBackend: "idbfs", verdict };
      }

      case "virgin-create":
        return finishVirginCreate(verdict);

      default: {
        // Exhaustiveness guard: a new verdict MUST be wired explicitly, never silently ignored.
        const unreachable: never = verdict;
        throw new Error(`[pgxsinkit] unhandled store boot verdict: ${JSON.stringify(unreachable)}`);
      }
    }
  }

  // Only reachable if deletion never leaves a clean, terminal state — a guard against a non-terminating cycle.
  throw new Error(
    "[pgxsinkit] store boot did not settle after resuming a deletion (bounded re-classification exhausted).",
  );
}
