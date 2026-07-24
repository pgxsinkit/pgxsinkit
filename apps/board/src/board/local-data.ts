import { storeIndexedDbDatabaseName } from "@pgxsinkit/client";

import {
  type DeleteLocalDataOutcome,
  deleteAllLocalBoardDataWith,
  type DeletionResult,
  type WipeIdbFactorySurface,
  type WipeStorageSurface,
  type WipeSurfaces,
} from "./local-data-core";
import { type ObsoleteRetentionAdapters, REGISTRY_KEY, REGISTRY_LOCK } from "./store-registry";
import { quiesceThenDestroyStore } from "./store-registry-default";

// Board-local "Delete local data" (login screen affordance). Wipes every local store the board holds on
// THIS browser profile so a demo visitor can start clean without digging into browser settings — the
// PGlite store artifacts (OPFS directory + sentinel + meta + idb) and the board's own localStorage bindings.
//
// This module is the DOM wiring only: it binds real globalThis surfaces (localStorage / IndexedDB /
// navigator.locks / the store-registry-default quiesce-then-destroy) into {@link WipeSurfaces} and drives the
// DOM-free core (./local-data-core) — the split mirrors store-registry.ts vs store-registry-default.ts, so the
// wipe's decision logic stays unit-testable without pulling DOM globals into the root typecheck.
//
// WIPE-ON-BOOT DESIGN (replacing an in-place wipe that hung): the login page ITSELF holds the spare store's
// SharedWorker (ensureSpare provisions it at mount) and that worker's engine holds the store's connections,
// and a tab has NO API to terminate a SharedWorker — so deleting from the live page cannot succeed:
// `deleteDatabase` sits in `blocked`. The wipe therefore runs in two steps: {@link requestLocalDataWipe}
// persists a flag and reloads; {@link applyPendingLocalDataWipe} then runs at app boot — BEFORE any store
// machinery constructs a worker — where THIS page holds nothing.
//
// The reload releases NOTHING immediately, though: the board's workers are `extendedLifetime: true`
// (store-registry-default.ts:60-68), so they deliberately OUTLIVE the document that spawned them and keep
// holding their connections across our reload — an idbfs engine holds its IndexedDB connection for its whole
// life. So the wipe QUIESCES each known store before destroying it: it tears down the store's surviving
// SharedWorker host (`quiesceThenDestroyStore`) so an idbfs worker releases its IndexedDB connection, THEN
// destroys the artifacts — which now converges on THIS boot instead of blocking past the deadline. An OPFS
// store's handle releases when idle either way. Any path whose destruction still fails (the teardown itself
// timed out) is RETAINED on the registry's Obsolete-stores list ({@link retainObsoletePaths}) — the same retry
// state a preference change uses. The teardown handshake is why this pass now runs BEFORE render (bounded,
// best-effort) rather than deferring quiescence: because the wipe runs at boot before any spare is provisioned,
// it only tears down the surviving pre-reload workers, and delaying an explicit destructive action by that
// bounded handshake is acceptable. `boardStoreRegistry.destroyObsoleteStores()` (main.tsx, every boot, off the
// sign-in path) stays as a belt-and-suspenders background retry for anything still failing.
//
// HONEST PARTIAL FAILURE: we collect a per-target result and surface what could NOT be deleted rather than
// pretending success (see login.tsx). Crucially, a partial failure does NOT clear the registry: doing so
// would discard the only record of the failed store PATHS (OPFS directory paths included), leaving the
// idb-only prefix sweep unable to ever reach those OPFS arenas — so the failed paths are retained for retry.

export type { DeleteLocalDataOutcome, DeletionResult };

// PGlite maps `idb://<storePath>` to the IndexedDB database `/pglite/<storePath>`. Derive the namespace prefix
// from the library's own helper (never re-encode `/pglite/` here) so a rename upstream stays in lockstep. A
// marker store name with no `/` yields "<prefix>marker"; slicing the marker off leaves the bare prefix.
const PREFIX_MARKER = "x";
/** The IndexedDB database-name prefix PGlite uses for every store (`/pglite/`). */
const PGLITE_IDB_PREFIX = storeIndexedDbDatabaseName(PREFIX_MARKER).slice(0, -PREFIX_MARKER.length);

/** The minimal registry-state seams {@link retainObsoletePaths} needs — localStorage read/write + the
 * cross-tab lock. Built HERE rather than reaching for the full StoreRegistryAdapters: retention touches only
 * localStorage + the lock, so it mirrors just those two adapters, minus everything retention never uses. */
function retentionAdapters(): ObsoleteRetentionAdapters {
  return {
    readRegistry: () => globalThis.localStorage.getItem(REGISTRY_KEY),
    writeRegistry: (value) => globalThis.localStorage.setItem(REGISTRY_KEY, value),
    withLock: async (fn) => {
      const locks = (globalThis.navigator as Navigator & { locks?: LockManager }).locks;
      // Best-effort without Web Locks: a rare cross-tab race is harmless here (the next boot re-reads the list).
      if (locks == null) return fn();
      return locks.request(REGISTRY_LOCK, () => fn());
    },
  };
}

/** Bind the real browser surfaces (globalThis localStorage / IndexedDB / navigator.locks + the store-registry's
 * `quiesceThenDestroyStore`) into the DOM-free core's {@link WipeSurfaces}. A genuinely unavailable localStorage /
 * indexedDB is left `undefined` — the core reports it honestly per target rather than throwing.
 *
 * The wipe QUIESCES-then-destroys each known store (ADR-0050): `quiesceThenDestroyStore` tears down the store's
 * surviving SharedWorker host so an `extendedLifetime` idbfs worker releases its IndexedDB connection, THEN
 * destroys the artifacts — so the wipe converges on the SAME boot instead of blocking past the deadline and
 * deferring to a later invisible background pass. The quiesce primitive (`quiesceStoreWorker`) exists precisely
 * so this pass can do the teardown in-line; because the wipe runs at boot before any spare is provisioned, it
 * only tears down the surviving pre-reload workers, and the bounded (~6s) best-effort handshake delays only this
 * explicit destructive action's boot, which is acceptable. `{ diagnostic: true }` makes a still-failing store's
 * thrown message name WHICH step stalled (worker teardown vs. artifact delete) so a real-device failure is
 * self-diagnosing. An OPFS store releases its handle when idle, so it deletes straight away regardless; anything
 * still held is RETAINED on the Obsolete-stores list, which `destroyObsoleteStores()` (main.tsx) retries as a
 * belt-and-suspenders background pass. */
function realWipeSurfaces(): WipeSurfaces {
  return {
    localStorage: (globalThis as { localStorage?: WipeStorageSurface }).localStorage,
    indexedDb: (globalThis as { indexedDB?: WipeIdbFactorySurface }).indexedDB,
    destroyStore: (storePath) => quiesceThenDestroyStore(storePath, { diagnostic: true }),
    retention: retentionAdapters(),
    pgliteIdbPrefix: PGLITE_IDB_PREFIX,
  };
}

/** Delete ALL local board data on this browser profile through the DOM-free core, bound to the real browser
 * surfaces. See {@link deleteAllLocalBoardDataWith} for the ordering and the partial-failure retention branch. */
export async function deleteAllLocalBoardData(): Promise<DeleteLocalDataOutcome> {
  return deleteAllLocalBoardDataWith(realWipeSurfaces());
}

// ─── The wipe-on-boot flow (see the module header for why deletion cannot run on a live page) ────────────

/** The localStorage flag {@link requestLocalDataWipe} sets and {@link applyPendingLocalDataWipe} consumes. */
const WIPE_FLAG_KEY = "board:wipe-local-data";
/** The sessionStorage key carrying the wipe's outcome across the reload for the login screen to report. */
const WIPE_OUTCOME_KEY = "board:wipe-local-data-outcome";

/**
 * Request the wipe: persist the flag and reload. The reload destroys this document but does NOT terminate the
 * SharedWorkers it spawned — they are `extendedLifetime: true` and survive their spawning document for a grace
 * period (store-registry-default.ts) — so the deletion at next boot still has to WAIT through blocked deletes
 * under a deadline, retaining anything still held (see {@link applyPendingLocalDataWipe} / the module header).
 * The reload's value is that it moves the deletion off the live page (where THIS page's own port kept the
 * store pinned with no chance of ever releasing) onto the boot path, where the workers are at least dying. If
 * localStorage is unavailable the flag cannot persist; reloading anyway is harmless (nothing will be wiped).
 */
export function requestLocalDataWipe(): void {
  try {
    globalThis.localStorage.setItem(WIPE_FLAG_KEY, "1");
  } catch {
    // Storage unavailable — fall through to the reload; there is no persisted state to wipe anyway.
  }
  globalThis.location.reload();
}

/**
 * Run a requested wipe at app boot — call this BEFORE any store machinery (prewarm, ensureSpare, provider
 * mount) constructs a worker, while every store is unheld by this page. The flag is cleared FIRST so a wipe
 * that itself fails cannot loop the app; the outcome is stashed in sessionStorage for the login screen
 * ({@link readLocalDataWipeOutcome}). No-op (fast, storage-free) when no wipe was requested.
 */
export async function applyPendingLocalDataWipe(): Promise<void> {
  try {
    if (globalThis.localStorage.getItem(WIPE_FLAG_KEY) == null) return;
    globalThis.localStorage.removeItem(WIPE_FLAG_KEY);
  } catch {
    return;
  }
  const outcome = await deleteAllLocalBoardData();
  try {
    globalThis.sessionStorage.setItem(WIPE_OUTCOME_KEY, JSON.stringify(outcome));
  } catch {
    // Session storage unavailable — the wipe still ran; only the report is lost.
  }
}

/** Read-and-clear the boot wipe's outcome (one-shot; `null` when no wipe ran or the report is unreadable). */
export function readLocalDataWipeOutcome(): DeleteLocalDataOutcome | null {
  try {
    const raw = globalThis.sessionStorage.getItem(WIPE_OUTCOME_KEY);
    if (raw == null) return null;
    globalThis.sessionStorage.removeItem(WIPE_OUTCOME_KEY);
    const parsed = JSON.parse(raw) as DeleteLocalDataOutcome;
    return Array.isArray(parsed?.results) ? parsed : null;
  } catch {
    return null;
  }
}
