import {
  idbNameForStore,
  type ObsoleteRetentionAdapters,
  REGISTRY_KEY,
  retainObsoletePaths,
  storePathForStore,
} from "./store-registry";

// The DOM-FREE core of the board's "Delete local data" wipe. Every browser touch — localStorage, IndexedDB,
// the registry lock, `destroyStoreArtifacts`, the `/pglite/` prefix — is INJECTED through {@link WipeSurfaces}
// so the wipe's decision logic (which paths to destroy, what to retain, how a blocked idb delete resolves) is
// unit-testable in bun with plain fakes and no DOM. The real globalThis / `@pgxsinkit/client` wiring lives in
// ./local-data.ts (kept out of this module so the unit test's root typecheck never pulls DOM globals in —
// the same split store-registry.ts uses against store-registry-default.ts). See ./local-data.ts for the
// WIPE-ON-BOOT rationale (why deletion runs at boot, and why partial failures are retained, not stranded).

/** The outcome of deleting one target (an IndexedDB db, or the localStorage bindings). */
export interface DeletionResult {
  /** Human-readable target label for the UI (e.g. an idb db name, "localStorage bindings"). */
  target: string;
  ok: boolean;
  /** Why it failed, or an informative note on success (e.g. "nothing to delete"). */
  detail?: string;
}

/** The aggregate outcome of {@link deleteAllLocalBoardDataWith}. */
export interface DeleteLocalDataOutcome {
  results: DeletionResult[];
  /** True only when EVERY target was deleted (or was provably absent) — the reload gate. */
  allOk: boolean;
}

/** The minimal localStorage seam the wipe reads (bindings) and clears — a structural subset of `Storage`. */
export interface WipeStorageSurface {
  getItem(key: string): string | null;
  removeItem(key: string): void;
}

/** The minimal IndexedDB delete-request seam — a structural subset of `IDBOpenDBRequest`. */
export interface WipeIdbRequestSurface {
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
  onblocked: (() => void) | null;
  error: { message?: string } | null;
}

/** The minimal IndexedDB factory seam — a structural subset of `IDBFactory` (`databases()` is optional; it is
 * unavailable on some engines, e.g. older Firefox). */
export interface WipeIdbFactorySurface {
  deleteDatabase(name: string): WipeIdbRequestSurface;
  databases?(): Promise<Array<{ name?: string }>>;
}

/** Every browser surface the wipe touches, injected so the core is DOM-free and testable. */
export interface WipeSurfaces {
  /** The board's localStorage (absent/undefined when storage is unavailable — privacy mode / disabled). */
  localStorage?: WipeStorageSurface | undefined;
  /** The IndexedDB factory (absent/undefined when unavailable). */
  indexedDb?: WipeIdbFactorySurface | undefined;
  /** Full-artifact destruction for one store path (OPFS + sentinel + meta + idb) — the library's
   * `destroyStoreArtifacts` (ADR-0050). MAY reject (a live worker still holds the store). */
  destroyStore: (storePath: string) => Promise<void>;
  /** The registry-state seams {@link retainObsoletePaths} needs — localStorage read/write + the cross-tab lock. */
  retention: ObsoleteRetentionAdapters;
  /** The IndexedDB database-name prefix PGlite uses for every store (`/pglite/`). */
  pgliteIdbPrefix: string;
}

/** The outer clamp for a per-store full destruction ({@link destroyKnownStores}). The wipe now QUIESCES the
 * store's SharedWorker (a bounded ~6s teardown handshake) BEFORE `destroyStoreArtifacts` (its own ~5s
 * blocked-timeout on the idb delete), so the clamp must accommodate BOTH steps back-to-back — a tighter budget
 * would truncate the teardown and report a generic board timeout in place of `quiesceThenDestroyStore`'s own
 * diagnostic (which names whether the WORKER teardown or the artifact delete stalled). This ceiling bites only
 * a genuinely stuck store; the converging case (the whole point of quiescing) settles in well under a second. */
const KNOWN_STORE_DESTROY_TIMEOUT_MS = 13000;

/** Clamp a deletion-target promise: a store held by another tab (or an extended-lifetime worker surviving our
 * reload) can stall a delete indefinitely, and the wipe runs ON THE BOOT PATH — so every target gets a
 * deadline and reports an honest timeout failure instead of hanging the app. Callers pass the budget: the
 * per-store destroy uses {@link KNOWN_STORE_DESTROY_TIMEOUT_MS} (quiesce + destroy back-to-back). (The idb
 * prefix sweep does not use this wrapper — {@link deleteIdbDatabase} owns its own deadline so a blocked event
 * can shape the message.) */
function withDeletionTimeout(target: string, work: Promise<DeletionResult>, ms = 6000): Promise<DeletionResult> {
  return Promise.race([
    work,
    new Promise<DeletionResult>((resolve) => {
      setTimeout(
        () =>
          resolve({
            target,
            ok: false,
            detail: `timed out after ${ms}ms — the store's own background sync worker has not shut down yet (or, less often, another open board tab still holds it); retained and retried automatically at next launch`,
          }),
        ms,
      );
    }),
  ]);
}

/** The board store IndexedDB db names to delete when `databases()` is unavailable: derive them from the
 * localStorage registry's known bindings (every mapped store id + the spare). Best-effort — an unreadable or
 * malformed registry yields none. */
function boardIdbNamesFromBindings(surfaces: WipeSurfaces): string[] {
  try {
    const raw = surfaces.localStorage?.getItem(REGISTRY_KEY);
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

/** Delete one IndexedDB database, resolving to a per-target result. Owns its OWN deadline (default 6000ms)
 * rather than deferring to {@link withDeletionTimeout}, so a `blocked` event — which is NON-TERMINAL — can
 * shape the timeout message without terminating the wait. A blocked delete is queued: it completes the moment
 * the connection-holder exits (an extended-lifetime worker dies a few seconds after our reload), firing
 * `onsuccess`. So on `blocked` we merely REMEMBER it and keep waiting for success/error; only if the deadline
 * then fires do we report failure, and say it was held so the "retry at next launch" is the honest story. */
function deleteIdbDatabase(
  factory: WipeIdbFactorySurface | undefined,
  name: string,
  ms = 6000,
): Promise<DeletionResult> {
  const target = `IndexedDB ${name}`;
  return new Promise<DeletionResult>((resolve) => {
    if (factory == null) {
      resolve({ target, ok: false, detail: "indexedDB unavailable" });
      return;
    }
    let blocked = false;
    let settled = false;
    const settle = (result: DeletionResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(
      () =>
        settle({
          target,
          ok: false,
          detail: blocked
            ? `still held after ${ms}ms — the store's own background sync worker still has its IndexedDB connection open (or, less often, another open board tab); retained and retried automatically at next launch`
            : `timed out after ${ms}ms — retained for retry at next launch`,
        }),
      ms,
    );
    const request = factory.deleteDatabase(name);
    request.onsuccess = () => settle({ target, ok: true });
    request.onerror = () => settle({ target, ok: false, detail: request.error?.message ?? "deleteDatabase failed" });
    // BLOCKED is non-terminal (see the doc): remember it shaped the wait, keep waiting for onsuccess/onerror.
    request.onblocked = () => {
      blocked = true;
    };
  });
}

/** Delete every board PGlite IndexedDB store. Enumerates `databases()` and deletes each name under the
 * `/pglite/` prefix; where enumeration is unavailable, falls back to the db names derivable from the board's
 * known store bindings. */
async function deleteIndexedDbStores(surfaces: WipeSurfaces): Promise<DeletionResult[]> {
  const factory = surfaces.indexedDb;
  if (typeof factory?.databases === "function") {
    let names: string[];
    try {
      const infos = await factory.databases();
      names = infos
        .map((info) => info.name)
        .filter((name): name is string => typeof name === "string" && name.startsWith(surfaces.pgliteIdbPrefix));
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
    // No outer withDeletionTimeout: deleteIdbDatabase owns its deadline so a blocked event shapes the message.
    return Promise.all(names.map((name) => deleteIdbDatabase(factory, name)));
  }

  // `databases()` unavailable — delete the db names derivable from the board's known bindings.
  const fallbackNames = boardIdbNamesFromBindings(surfaces);
  if (fallbackNames.length === 0) {
    return [
      {
        target: "IndexedDB (PGlite stores)",
        ok: true,
        detail: "indexedDB.databases() unavailable and no known bindings — nothing to delete",
      },
    ];
  }
  return Promise.all(fallbackNames.map((name) => deleteIdbDatabase(factory, name)));
}

/** Every store PATH the board's registry knows — user bindings, the spare, and the Obsolete-stores list —
 * i.e. the full-destruction targets ({@link WipeSurfaces.destroyStore} removes OPFS directory + sentinel +
 * meta + idb per path; the generic idb prefix sweep alone would leak the OPFS artifacts, ADR-0050).
 * Best-effort — an unreadable or malformed registry yields none. */
function knownStorePaths(surfaces: WipeSurfaces): string[] {
  try {
    const raw = surfaces.localStorage?.getItem(REGISTRY_KEY);
    if (raw == null) return [];
    const parsed = JSON.parse(raw) as { map?: Record<string, unknown>; spare?: unknown; obsolete?: unknown };
    const paths = new Set<string>();
    if (parsed?.map != null && typeof parsed.map === "object") {
      for (const storeId of Object.values(parsed.map)) {
        if (typeof storeId === "string") paths.add(storePathForStore(storeId));
      }
    }
    if (typeof parsed?.spare === "string") paths.add(storePathForStore(parsed.spare));
    if (Array.isArray(parsed?.obsolete)) {
      for (const path of parsed.obsolete) if (typeof path === "string") paths.add(path);
    }
    return [...paths];
  } catch {
    return [];
  }
}

/** The outcome of {@link destroyKnownStores}: the per-target results AND the exact store PATHS whose
 * destruction FAILED — the retention driver. Full paths (`pgxsinkit-board-<uuid>`), the Obsolete-list format. */
interface KnownStoresOutcome {
  results: DeletionResult[];
  /** Store paths whose full destruction did not succeed — retained on the Obsolete-stores list for retry. */
  failedPaths: string[];
}

/** Destroy every registry-known store's FULL artifact set (OPFS + sentinel + meta + idb) — per-target results,
 * per-target timeout, a held store reported honestly as a failure and its PATH collected so the caller can
 * retain it on the Obsolete-stores list for automatic retry at the next boot. */
async function destroyKnownStores(surfaces: WipeSurfaces): Promise<KnownStoresOutcome> {
  const paths = knownStorePaths(surfaces);
  if (paths.length === 0) {
    return { results: [{ target: "store artifacts", ok: true, detail: "no registry-known stores" }], failedPaths: [] };
  }
  const results = await Promise.all(
    paths.map((path) =>
      withDeletionTimeout(
        `store ${path}`,
        surfaces.destroyStore(path).then(
          () => ({ target: `store ${path}`, ok: true }) satisfies DeletionResult,
          (cause: unknown) =>
            ({
              target: `store ${path}`,
              ok: false,
              detail: `${cause instanceof Error ? cause.message : String(cause)} — retained for retry at next launch`,
            }) satisfies DeletionResult,
        ),
        KNOWN_STORE_DESTROY_TIMEOUT_MS,
      ).then((result) => ({ path, result })),
    ),
  );
  return {
    results: results.map((entry) => entry.result),
    failedPaths: results.filter((entry) => !entry.result.ok).map((entry) => entry.path),
  };
}

/** Clear the board's own localStorage bindings — the userId→storeId registry — so no stale binding points at a
 * now-deleted store. The durability/backend PREFERENCES are deliberately PRESERVED (a data wipe removes stores
 * and bindings, not a UI setting). Called ONLY on a fully-clean wipe (see {@link retainFailedStorePaths} for
 * the partial-failure path, which must NOT remove the key). */
function clearLocalStorageBindings(surfaces: WipeSurfaces): DeletionResult {
  const target = "localStorage bindings";
  try {
    const storage = surfaces.localStorage;
    if (storage == null) return { target, ok: true, detail: "localStorage unavailable — nothing to clear" };
    storage.removeItem(REGISTRY_KEY);
    return { target, ok: true };
  } catch (cause) {
    return { target, ok: false, detail: cause instanceof Error ? cause.message : String(cause) };
  }
}

/** Partial-failure retention: instead of removing the registry (which would discard the ONLY record of the
 * failed store paths — OPFS directory paths included — making retry impossible), collapse it to an empty map
 * with the failed paths on the Obsolete-stores list. `destroyObsoleteStores` retries them each boot and drops
 * each on success, so a later boot — once the holding worker's grace period elapses — finishes the wipe. */
async function retainFailedStorePaths(surfaces: WipeSurfaces, paths: string[]): Promise<DeletionResult> {
  const target = "localStorage bindings";
  try {
    await retainObsoletePaths(surfaces.retention, paths);
    return {
      target,
      ok: true,
      detail: `${paths.length} store path(s) retained on the Obsolete list for automatic retry at next launch`,
    };
  } catch (cause) {
    return { target, ok: false, detail: cause instanceof Error ? cause.message : String(cause) };
  }
}

/**
 * Delete ALL local board data on this browser profile: every registry-known store's FULL artifact set (OPFS
 * included), any stray PGlite IndexedDB databases the registry does not know (the prefix sweep — idb-only
 * strays by construction), and the board's localStorage bindings. Returns a per-target result set and `allOk`
 * — deliberately does NOT reload (the caller reloads only on a fully-clean wipe, and shows the partial-failure
 * detail otherwise). Order matters: known stores first, then the stray sweep, then the bindings (both earlier
 * steps read them).
 *
 * The bindings step BRANCHES on the known-store outcome: when every registry-known store was destroyed, the
 * registry is removed entirely (today's behavior); when some FAILED, the registry is NOT removed — the failed
 * paths are retained on the Obsolete-stores list so `destroyObsoleteStores` retries them at each subsequent
 * boot (removing the key would strand those paths, defeating the OPFS-aware retry — see ./local-data.ts).
 */
export async function deleteAllLocalBoardDataWith(surfaces: WipeSurfaces): Promise<DeleteLocalDataOutcome> {
  const results: DeletionResult[] = [];
  const known = await destroyKnownStores(surfaces);
  results.push(...known.results);
  results.push(...(await deleteIndexedDbStores(surfaces)));
  results.push(
    known.failedPaths.length > 0
      ? await retainFailedStorePaths(surfaces, known.failedPaths)
      : clearLocalStorageBindings(surfaces),
  );
  return { results, allOk: results.every((result) => result.ok) };
}
