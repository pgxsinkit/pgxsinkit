import { storeIndexedDbDatabaseName } from "@pgxsinkit/client";

import { idbNameForStore, REGISTRY_KEY } from "./store-registry";

// Board-local "Delete local data" (login screen affordance). Wipes every local store the board holds on
// THIS browser profile so a demo visitor can start clean without digging into browser settings — the
// PGlite IndexedDB databases and the board's own localStorage bindings.
//
// WIPE-ON-BOOT DESIGN (replacing an in-place wipe that hung): the login page ITSELF holds the spare store's
// SharedWorker (ensureSpare provisions it at mount), that worker's PGlite holds the IndexedDB connection, and
// a tab has NO API to terminate a SharedWorker — so deleting from the live page cannot succeed: `deleteDatabase`
// sits in `blocked`. The wipe therefore runs in two steps: {@link requestLocalDataWipe} persists a flag and
// reloads; the reload destroys this document, which kills its SharedWorkers and releases their connections;
// {@link applyPendingLocalDataWipe} then runs at app boot — BEFORE any store machinery constructs a worker —
// where the stores are unheld.
//
// HONEST PARTIAL FAILURE: an engine in ANOTHER tab still holds its stores across our reload. We collect
// a per-target result and surface what could NOT be deleted rather than pretending success (see
// login.tsx); every target is additionally clamped by a timeout so a held store can never hang boot.

// PGlite maps `idb://<storePath>` to the IndexedDB database `/pglite/<storePath>`. Derive the namespace prefix
// from the library's own helper (never re-encode `/pglite/` here) so a rename upstream stays in lockstep. A
// marker store name with no `/` yields "<prefix>marker"; slicing the marker off leaves the bare prefix.
const PREFIX_MARKER = "x";
/** The IndexedDB database-name prefix PGlite uses for every store (`/pglite/`). */
const PGLITE_IDB_PREFIX = storeIndexedDbDatabaseName(PREFIX_MARKER).slice(0, -PREFIX_MARKER.length);

/** The outcome of deleting one target (an IndexedDB db, or the localStorage bindings). */
export interface DeletionResult {
  /** Human-readable target label for the UI (e.g. an idb db name, "localStorage bindings"). */
  target: string;
  ok: boolean;
  /** Why it failed, or an informative note on success (e.g. "nothing to delete"). */
  detail?: string;
}

/** The aggregate outcome of {@link deleteAllLocalBoardData}. */
export interface DeleteLocalDataOutcome {
  results: DeletionResult[];
  /** True only when EVERY target was deleted (or was provably absent) — the reload gate. */
  allOk: boolean;
}

/** Clamp a deletion-target promise: a store held by another tab can stall a delete indefinitely (a blocked
 * IndexedDB `deleteDatabase` may sit unresolved), and the wipe now runs ON THE BOOT PATH — so every target
 * gets a deadline and reports an honest timeout failure instead of hanging the app. */
function withDeletionTimeout(target: string, work: Promise<DeletionResult>, ms = 4000): Promise<DeletionResult> {
  return Promise.race([
    work,
    new Promise<DeletionResult>((resolve) => {
      setTimeout(
        () =>
          resolve({
            target,
            ok: false,
            detail: `timed out after ${ms}ms — another tab's engine likely holds it; close other tabs and retry`,
          }),
        ms,
      );
    }),
  ]);
}

/** Best-effort access to `indexedDB.databases()` (unavailable on some engines, e.g. older Firefox). */
function idbFactory(): (IDBFactory & { databases?: () => Promise<Array<{ name?: string }>> }) | undefined {
  const factory = (globalThis as { indexedDB?: IDBFactory }).indexedDB as
    | (IDBFactory & { databases?: () => Promise<Array<{ name?: string }>> })
    | undefined;
  return factory;
}

/** The board store IndexedDB db names to delete when `indexedDB.databases()` is unavailable: derive them from
 * the localStorage registry's known bindings (every mapped store id + the spare). Best-effort — an unreadable
 * or malformed registry yields none. */
function boardIdbNamesFromBindings(): string[] {
  try {
    const raw = (globalThis as { localStorage?: Storage }).localStorage?.getItem(REGISTRY_KEY);
    if (raw == null) return [];
    const parsed = JSON.parse(raw) as { map?: Record<string, unknown>; spare?: unknown };
    const ids = new Set<string>();
    if (parsed?.map != null && typeof parsed.map === "object") {
      for (const storeId of Object.values(parsed.map)) if (typeof storeId === "string") ids.add(storeId);
    }
    if (typeof parsed?.spare === "string") ids.add(parsed.spare);
    return [...ids].map((storeId) => idbNameForStore(storeId));
  } catch {
    return [];
  }
}

/** Delete one IndexedDB database, resolving to a per-target result. A BLOCKED delete (another tab/worker holds
 * the store) is reported as a failure — the user must close other tabs — never faked as success. */
function deleteIdbDatabase(name: string): Promise<DeletionResult> {
  return new Promise<DeletionResult>((resolve) => {
    const factory = idbFactory();
    if (factory == null) {
      resolve({ target: `IndexedDB ${name}`, ok: false, detail: "indexedDB unavailable" });
      return;
    }
    const request = factory.deleteDatabase(name);
    request.onsuccess = () => resolve({ target: `IndexedDB ${name}`, ok: true });
    request.onerror = () =>
      resolve({
        target: `IndexedDB ${name}`,
        ok: false,
        detail: request.error?.message ?? "deleteDatabase failed",
      });
    request.onblocked = () =>
      resolve({
        target: `IndexedDB ${name}`,
        ok: false,
        detail: "blocked — another tab or the store's live worker holds it; close other tabs and retry",
      });
  });
}

/** Delete every board PGlite IndexedDB store. Enumerates `indexedDB.databases()` and deletes each name under the
 * `/pglite/` prefix; where enumeration is unavailable, falls back to the db names derivable from the board's
 * known store bindings. */
async function deleteIndexedDbStores(): Promise<DeletionResult[]> {
  const factory = idbFactory();
  if (typeof factory?.databases === "function") {
    let names: string[];
    try {
      const infos = await factory.databases();
      names = infos
        .map((info) => info.name)
        .filter((name): name is string => typeof name === "string" && name.startsWith(PGLITE_IDB_PREFIX));
    } catch (cause) {
      return [
        {
          target: "IndexedDB (enumeration)",
          ok: false,
          detail: cause instanceof Error ? cause.message : String(cause),
        },
      ];
    }
    if (names.length === 0) {
      return [{ target: "IndexedDB (PGlite stores)", ok: true, detail: "no stores found" }];
    }
    return Promise.all(names.map((name) => withDeletionTimeout(`IndexedDB ${name}`, deleteIdbDatabase(name))));
  }

  // `indexedDB.databases()` unavailable — delete the db names derivable from the board's known bindings.
  const fallbackNames = boardIdbNamesFromBindings();
  if (fallbackNames.length === 0) {
    return [
      {
        target: "IndexedDB (PGlite stores)",
        ok: true,
        detail: "indexedDB.databases() unavailable and no known bindings — nothing to delete",
      },
    ];
  }
  return Promise.all(fallbackNames.map((name) => withDeletionTimeout(`IndexedDB ${name}`, deleteIdbDatabase(name))));
}

/** Clear the board's own localStorage bindings — the userId→storeId registry — so no stale binding points at a
 * now-deleted store. The durability PREFERENCE is deliberately PRESERVED: a data wipe removes stores and
 * bindings, not a UI setting. */
function clearLocalStorageBindings(): DeletionResult {
  const target = "localStorage bindings";
  try {
    const storage = (globalThis as { localStorage?: Storage }).localStorage;
    if (storage == null) return { target, ok: true, detail: "localStorage unavailable — nothing to clear" };
    storage.removeItem(REGISTRY_KEY);
    return { target, ok: true };
  } catch (cause) {
    return { target, ok: false, detail: cause instanceof Error ? cause.message : String(cause) };
  }
}

/**
 * Delete ALL local board data on this browser profile: every PGlite IndexedDB store and the board's localStorage
 * bindings. Returns a per-target result set and `allOk` — deliberately does NOT reload (the caller reloads only on
 * a fully-clean wipe, and shows the partial-failure detail otherwise). Order matters: IndexedDB first (its
 * fallback reads the bindings), then the localStorage bindings.
 */
export async function deleteAllLocalBoardData(): Promise<DeleteLocalDataOutcome> {
  const results: DeletionResult[] = [];
  results.push(...(await deleteIndexedDbStores()));
  results.push(clearLocalStorageBindings());
  return { results, allOk: results.every((result) => result.ok) };
}

// ─── The wipe-on-boot flow (see the module header for why deletion cannot run on a live page) ────────────

/** The localStorage flag {@link requestLocalDataWipe} sets and {@link applyPendingLocalDataWipe} consumes. */
const WIPE_FLAG_KEY = "board:wipe-local-data";
/** The sessionStorage key carrying the wipe's outcome across the reload for the login screen to report. */
const WIPE_OUTCOME_KEY = "board:wipe-local-data-outcome";

/**
 * Request the wipe: persist the flag and reload. The reload destroys this document, which kills the
 * SharedWorkers it holds (the login page's own spare worker included) and releases their IndexedDB
 * connections — the precondition the actual deletion needs. If localStorage is unavailable the flag cannot
 * persist; reloading anyway is harmless (nothing will be wiped, and the login screen simply shows no outcome).
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
