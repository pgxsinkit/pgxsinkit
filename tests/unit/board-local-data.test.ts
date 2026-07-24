import { describe, expect, it } from "bun:test";

import {
  deleteAllLocalBoardDataWith,
  type WipeIdbFactorySurface,
  type WipeIdbRequestSurface,
  type WipeSurfaces,
} from "../../apps/board/src/board/local-data-core";
import { quiesceThenDestroyStoreWith } from "../../apps/board/src/board/quiesce-destroy-core";
import { REGISTRY_KEY, storePathForStore, type StoreRegistryState } from "../../apps/board/src/board/store-registry";

// Unit test of the board's "Delete local data" wipe DECISION logic through the DOM-free core
// (apps/board/src/board/local-data-core.ts) — every browser touch is an injected {@link WipeSurfaces} fake, so
// no DOM, no real PGlite, no mock.module. The three behaviours are the DEFECT-A / DEFECT-B fixes:
//   - a PARTIAL failure KEEPS the registry and retains the failed store paths on the Obsolete-stores list
//     (so a later boot's `destroyObsoleteStores` retries them) rather than removing the key and stranding them;
//   - an ALL-success wipe REMOVES the registry key (today's behaviour);
//   - a BLOCKED idb delete is NON-TERMINAL — it resolves ok once the queued delete completes, never fails at
//     `onblocked`.

/** A localStorage + retention pair backed by ONE map, so the wipe's retention writes and clears are observable
 * exactly as they are in production (both surfaces are the same underlying Storage there). */
function makeRegistryBacking(initial?: StoreRegistryState) {
  const store = new Map<string, string>();
  if (initial != null) store.set(REGISTRY_KEY, JSON.stringify(initial));
  return {
    localStorage: {
      getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
      removeItem: (key: string) => void store.delete(key),
    },
    retention: {
      readRegistry: () => (store.has(REGISTRY_KEY) ? store.get(REGISTRY_KEY)! : null),
      writeRegistry: (value: string) => void store.set(REGISTRY_KEY, value),
      // The pure decision logic; the lock is a straight pass-through here (as in the registry unit test).
      withLock: <T>(fn: () => Promise<T>) => fn(),
    },
    /** The registry state currently persisted, or null when the key was removed. */
    state: (): StoreRegistryState | null =>
      store.has(REGISTRY_KEY) ? (JSON.parse(store.get(REGISTRY_KEY)!) as StoreRegistryState) : null,
  };
}

/** Per-database delete behaviour: resolve at once, error, or fire `onblocked` first then complete shortly
 * after (the extended-lifetime worker exiting) — the DEFECT-B non-terminal-blocked case. */
type DeleteBehavior = "success" | "error" | "blocked-then-success";

function makeIdbFactory(databases: string[], behavior: Record<string, DeleteBehavior> = {}): WipeIdbFactorySurface {
  return {
    databases: async () => databases.map((name) => ({ name })),
    deleteDatabase: (name: string): WipeIdbRequestSurface => {
      const request: WipeIdbRequestSurface = { onsuccess: null, onerror: null, onblocked: null, error: null };
      const mode: DeleteBehavior = behavior[name] ?? "success";
      queueMicrotask(() => {
        if (mode === "success") request.onsuccess?.();
        else if (mode === "error") {
          request.error = { message: `delete ${name} failed` };
          request.onerror?.();
        } else {
          // Blocked is non-terminal: fire it, then land the queued delete a beat later (the holder exited).
          request.onblocked?.();
          setTimeout(() => request.onsuccess?.(), 5);
        }
      });
      return request;
    },
  };
}

/** Assemble the injected surfaces, with `destroyStore` rejecting for the given held store paths. */
function makeSurfaces(options: {
  backing: ReturnType<typeof makeRegistryBacking>;
  idb: WipeIdbFactorySurface;
  rejectDestroy?: readonly string[];
  destroyed?: string[];
}): WipeSurfaces {
  const reject = new Set(options.rejectDestroy ?? []);
  return {
    localStorage: options.backing.localStorage,
    indexedDb: options.idb,
    destroyStore: async (storePath: string) => {
      if (reject.has(storePath)) throw new Error(`held ${storePath}`);
      options.destroyed?.push(storePath);
    },
    retention: options.backing.retention,
    pgliteIdbPrefix: "/pglite/",
  };
}

describe("deleteAllLocalBoardData — partial failure retains, full success removes the registry", () => {
  it("DEFECT A: a failed store destruction is retained on the Obsolete list; the registry key is KEPT", async () => {
    const heldPath = storePathForStore("a"); // pgxsinkit-board-a — destruction will fail
    const freePath = storePathForStore("s1"); // the spare — destruction will succeed
    const backing = makeRegistryBacking({ version: 1, map: { "user-1": "a" }, spare: "s1" });
    const destroyed: string[] = [];
    const surfaces = makeSurfaces({
      backing,
      idb: makeIdbFactory([`/pglite/${heldPath}`, `/pglite/${freePath}`]),
      rejectDestroy: [heldPath],
      destroyed,
    });

    const outcome = await deleteAllLocalBoardDataWith(surfaces);

    expect(outcome.allOk).toBe(false);
    // The registry survives — it is the only record of the held path (OPFS dir included).
    const state = backing.state();
    expect(state).not.toBeNull();
    expect(state?.map).toEqual({});
    expect(state?.spare).toBeUndefined();
    // Exactly the failed store path is retained for `destroyObsoleteStores` to retry each boot.
    expect(state?.obsolete).toEqual([heldPath]);
    // The store whose destruction succeeded was actually destroyed and is NOT retained.
    expect(destroyed).toContain(freePath);
    expect(state?.obsolete).not.toContain(freePath);
    // The failure is surfaced honestly, tagged as retained-for-retry.
    const failure = outcome.results.find((result) => result.target === `store ${heldPath}`);
    expect(failure?.ok).toBe(false);
    expect(failure?.detail).toContain("retained for retry at next launch");
  });

  it("all destructions succeed → the registry key is REMOVED (today's clean-wipe behaviour)", async () => {
    const aPath = storePathForStore("a");
    const sPath = storePathForStore("s1");
    const backing = makeRegistryBacking({ version: 1, map: { "user-1": "a" }, spare: "s1" });
    const destroyed: string[] = [];
    const surfaces = makeSurfaces({
      backing,
      idb: makeIdbFactory([`/pglite/${aPath}`, `/pglite/${sPath}`]),
      destroyed,
    });

    const outcome = await deleteAllLocalBoardDataWith(surfaces);

    expect(outcome.allOk).toBe(true);
    expect(backing.state()).toBeNull(); // registry key removed
    expect(destroyed.sort()).toEqual([aPath, sPath].sort());
  });

  it("DEFECT B: a BLOCKED idb delete is non-terminal — it resolves ok once the queued delete lands", async () => {
    // No registry-known stores (empty map) so the outcome hinges solely on the idb prefix sweep, whose one db
    // fires `onblocked` first and then completes — the reported result must be a success, never a blocked failure.
    const strayName = `/pglite/${storePathForStore("stray")}`;
    const backing = makeRegistryBacking({ version: 1, map: {} });
    const surfaces = makeSurfaces({
      backing,
      idb: makeIdbFactory([strayName], { [strayName]: "blocked-then-success" }),
    });

    const outcome = await deleteAllLocalBoardDataWith(surfaces);

    const idbResult = outcome.results.find((result) => result.target === `IndexedDB ${strayName}`);
    expect(idbResult?.ok).toBe(true);
    expect(outcome.allOk).toBe(true);
    // A clean wipe with no held stores still removes the registry key.
    expect(backing.state()).toBeNull();
  });

  it("wipe path: a store whose WORKER TEARDOWN times out surfaces the diagnostic in its per-store detail", async () => {
    // The wipe's real destroyStore is store-registry-default's `quiesceThenDestroyStore(path, { diagnostic: true })`.
    // Emulate its DOM-free core here: the quiesce times out and the subsequent artifact delete then blocks — the
    // reported failure detail must name the WORKER teardown, not a generic timeout, so a real device is self-diagnosing.
    const heldPath = storePathForStore("held");
    const backing = makeRegistryBacking({ version: 1, map: { "user-1": "held" } });
    const surfaces: WipeSurfaces = {
      localStorage: backing.localStorage,
      indexedDb: makeIdbFactory([`/pglite/${heldPath}`]),
      destroyStore: (storePath) =>
        quiesceThenDestroyStoreWith(
          {
            workerMode: true,
            quiesce: async () => {
              throw new Error("[pgxsinkit] quiesceStoreWorker timed out after 6000ms");
            },
            destroy: async () => {
              throw new Error("deleteDatabase blocked after 5000ms");
            },
          },
          storePath,
          { diagnostic: true },
        ),
      retention: backing.retention,
      pgliteIdbPrefix: "/pglite/",
    };

    const outcome = await deleteAllLocalBoardDataWith(surfaces);

    expect(outcome.allOk).toBe(false);
    const failure = outcome.results.find((result) => result.target === `store ${heldPath}`);
    expect(failure?.ok).toBe(false);
    // The diagnostic reaches the user: the WORKER teardown is named as the step that stalled, plus the retry note.
    expect(failure?.detail).toContain("worker teardown timed out after 6000ms");
    expect(failure?.detail).toContain("background sync worker did not shut down");
    expect(failure?.detail).toContain("retained for retry at next launch");
    // The failed path is retained on the Obsolete list for the belt-and-suspenders background retry.
    expect(backing.state()?.obsolete).toEqual([heldPath]);
  });
});
