import { describe, expect, it } from "bun:test";

import type { ClientPGlite, StoreWorkerQuiesceOutcome } from "@pgxsinkit/client";

import {
  type QuiesceThenDestroyDeps,
  quiesceThenDestroyStoreWith,
} from "../../apps/board/src/board/quiesce-destroy-core";
import {
  createStoreRegistry,
  idbNameForStore,
  fallbackStorePathForUser,
  retainObsoletePaths,
  storePathForStore,
  type StoreRegistryAdapters,
  type StoreRegistryState,
} from "../../apps/board/src/board/store-registry";

// Unit test of the spare-store binding logic (board cold-boot optimisation B) through the injected
// adapters — no browser, no real PGlite. Each `createStore` returns an identity-tagged sentinel so a
// claim can prove it handed over the SAME in-flight eager create rather than opening a second store.

interface HarnessOptions {
  initial?: StoreRegistryState | null;
  storageThrows?: boolean;
  databases?: readonly string[] | null; // null → indexedDB.databases() unavailable (GC skipped)
  rejectStorePaths?: readonly string[]; // store paths for which createStore rejects (corrupt-spare simulation)
  rejectDestroyPaths?: readonly string[]; // store paths whose destroyStore rejects (a live worker still holds them)
}

function makeHarness(options: HarnessOptions = {}) {
  let stored: string | null = options.initial != null ? JSON.stringify(options.initial) : null;
  const createdStorePaths: string[] = [];
  const deletedDatabases: string[] = [];
  const destroyedStorePaths: string[] = [];
  const rejectStorePaths = new Set(options.rejectStorePaths ?? []);
  const rejectDestroyPaths = new Set(options.rejectDestroyPaths ?? []);
  let counter = 0;

  const adapters: StoreRegistryAdapters = {
    readRegistry: () => {
      if (options.storageThrows) throw new Error("localStorage unavailable");
      return stored;
    },
    writeRegistry: (value) => {
      if (options.storageThrows) throw new Error("localStorage unavailable");
      stored = value;
    },
    listDatabases: async () => (options.databases === null ? null : (options.databases ?? [])),
    deleteDatabase: async (name) => {
      deletedDatabases.push(name);
    },
    createStore: async (storePath) => {
      createdStorePaths.push(storePath);
      if (rejectStorePaths.has(storePath)) throw new Error(`corrupt store at ${storePath}`);
      return { __store: storePath } as unknown as ClientPGlite;
    },
    destroyStore: async (storePath) => {
      if (rejectDestroyPaths.has(storePath)) throw new Error(`store held at ${storePath}`);
      destroyedStorePaths.push(storePath);
    },
    randomId: () => `gen-${++counter}`,
    // Tests exercise the pure decision logic; the lock is a straight pass-through here.
    withLock: (fn) => fn(),
  };

  return {
    adapters,
    createdStorePaths,
    deletedDatabases,
    destroyedStorePaths,
    state: (): StoreRegistryState | null => (stored != null ? (JSON.parse(stored) as StoreRegistryState) : null),
  };
}

describe("board spare-store registry", () => {
  it("fresh visitor: creates a spare on ensure, then claims it on first login (one create, handed over)", async () => {
    const harness = makeHarness();
    const registry = createStoreRegistry(harness.adapters);

    const ensured = await registry.ensureSpare();
    expect(ensured.created).toBe(true);
    expect(harness.state()?.spare).toBe("gen-1");
    expect(harness.createdStorePaths).toEqual([storePathForStore("gen-1")]);

    const opened = await registry.openUserStore("user-1");
    expect(opened.storeId).toBe("gen-1");
    expect(opened.storePath).toBe(storePathForStore("gen-1"));
    expect(await opened.pglite).toBeDefined();
    // A claimed schemaless spare is provably fresh (ADR-0032 S4): the fresh-store prefetch-overlap hint.
    expect(opened.fresh).toBe(true);

    // The spare was bound, not re-created: still exactly one create, and the spare pointer is cleared.
    expect(harness.createdStorePaths).toEqual([storePathForStore("gen-1")]);
    expect(harness.state()?.map).toEqual({ "user-1": "gen-1" });
    expect(harness.state()?.spare).toBeUndefined();
  });

  it("returning user: opens the mapped store and leaves the spare untouched", async () => {
    const harness = makeHarness({ initial: { version: 1, map: { "user-1": "store-1" }, spare: "spare-1" } });
    const registry = createStoreRegistry(harness.adapters);

    const opened = await registry.openUserStore("user-1");
    expect(opened.storeId).toBe("store-1");
    expect(opened.storePath).toBe(storePathForStore("store-1"));
    expect(await opened.pglite).toBeDefined();
    // A returning user's mapped store already carries schema + rows — never fresh (no overlap).
    expect(opened.fresh).toBe(false);
    expect(harness.createdStorePaths).toEqual([storePathForStore("store-1")]);
    // The spare stays for a future new user.
    expect(harness.state()?.spare).toBe("spare-1");
    expect(harness.state()?.map).toEqual({ "user-1": "store-1" });
  });

  it("second user on the same browser: claims the waiting spare", async () => {
    const harness = makeHarness({ initial: { version: 1, map: { "user-1": "store-1" }, spare: "spare-1" } });
    const registry = createStoreRegistry(harness.adapters);

    const opened = await registry.openUserStore("user-2");
    expect(opened.storeId).toBe("spare-1");
    expect(await opened.pglite).toBeDefined();
    // A claimed spare is fresh for the claiming user (ADR-0032 S4).
    expect(opened.fresh).toBe(true);
    expect(harness.state()?.map).toEqual({ "user-1": "store-1", "user-2": "spare-1" });
    expect(harness.state()?.spare).toBeUndefined();
  });

  it("no spare at all: mints and creates a fresh store at sign-in (the fallback path)", async () => {
    const harness = makeHarness({ initial: { version: 1, map: {} } });
    const registry = createStoreRegistry(harness.adapters);

    const opened = await registry.openUserStore("user-1");
    expect(opened.storeId).toBe("gen-1");
    expect(harness.createdStorePaths).toEqual([storePathForStore("gen-1")]);
    expect(await opened.pglite).toBeDefined();
    // A brand-new minted store (no spare was waiting) is provably fresh (ADR-0032 S4).
    expect(opened.fresh).toBe(true);
    expect(harness.state()?.map).toEqual({ "user-1": "gen-1" });
    expect(harness.state()?.spare).toBeUndefined();
  });

  it("corrupt spare: the failed open is deleted and a fresh store is created and bound", async () => {
    const harness = makeHarness({
      initial: { version: 1, map: {}, spare: "bad" },
      rejectStorePaths: [storePathForStore("bad")],
    });
    const registry = createStoreRegistry(harness.adapters);

    const opened = await registry.openUserStore("user-1");
    expect(await opened.pglite).toBeDefined();

    // The corrupt idb was deleted, and a fresh id was created and re-bound to the user.
    expect(harness.deletedDatabases).toContain(idbNameForStore("bad"));
    expect(harness.createdStorePaths).toEqual([storePathForStore("bad"), storePathForStore("gen-1")]);
    expect(harness.state()?.map).toEqual({ "user-1": "gen-1" });
  });

  it("orphan GC: deletes every unmapped/non-spare board store and keeps mapped + spare", async () => {
    const databases = [
      idbNameForStore("store-1"), // mapped → keep
      idbNameForStore("spare-1"), // spare → keep
      idbNameForStore("orphan"), // unbound board store → delete
      idbNameForStore("unmapped-user-uuid"), // unmapped board store → delete
      "/pglite/some-other-app", // different prefix → ignore
      "unrelated-database", // not a pglite store → ignore
    ];
    const harness = makeHarness({
      initial: { version: 1, map: { "user-1": "store-1" }, spare: "spare-1" },
      databases,
    });
    const registry = createStoreRegistry(harness.adapters);

    await registry.ensureSpare();

    expect(harness.deletedDatabases.sort()).toEqual(
      [idbNameForStore("orphan"), idbNameForStore("unmapped-user-uuid")].sort(),
    );
    // The mapped store and the spare survive.
    expect(harness.deletedDatabases).not.toContain(idbNameForStore("store-1"));
    expect(harness.deletedDatabases).not.toContain(idbNameForStore("spare-1"));
  });

  it("memoises per userId: two opens for the same user share one create and the same pglite promise", async () => {
    const harness = makeHarness({ initial: { version: 1, map: { "user-1": "store-1" } } });
    const registry = createStoreRegistry(harness.adapters);

    const a = await registry.openUserStore("user-1");
    const b = await registry.openUserStore("user-1");

    // Same result object (memoised promise), so the same in-flight pglite — never a second instance on
    // the same IndexedDB store.
    expect(a).toBe(b);
    expect(a.pglite).toBe(b.pglite);
    expect(await a.pglite).toBe(await b.pglite);
    // Exactly one create for the mapped store.
    expect(harness.createdStorePaths).toEqual([storePathForStore("store-1")]);
  });

  it("distinct userIds still get distinct stores (memo is keyed by userId)", async () => {
    const harness = makeHarness({
      initial: { version: 1, map: { "user-1": "store-1", "user-2": "store-2" } },
    });
    const registry = createStoreRegistry(harness.adapters);

    const a = await registry.openUserStore("user-1");
    const b = await registry.openUserStore("user-2");

    expect(a).not.toBe(b);
    expect(a.storeId).toBe("store-1");
    expect(b.storeId).toBe("store-2");
    expect(harness.createdStorePaths.sort()).toEqual(
      [storePathForStore("store-1"), storePathForStore("store-2")].sort(),
    );
  });

  it("failed open is not cached forever: a later call retries the open", async () => {
    const harness = makeHarness({
      initial: { version: 1, map: { "user-1": "store-1" } },
      rejectStorePaths: [storePathForStore("store-1")],
    });
    const registry = createStoreRegistry(harness.adapters);

    const first = await registry.openUserStore("user-1");
    expect(first.pglite).toBeDefined();
    // Drain the rejection (mapped path always precreates) so the drop-cache-on-failure hook fires.
    let firstError: unknown;
    await (first.pglite ?? Promise.resolve()).catch((cause: unknown) => {
      firstError = cause;
    });
    expect(firstError).toBeInstanceOf(Error);
    // Let the drop-cache-on-failure microtask settle before the retry.
    await Promise.resolve();

    const second = await registry.openUserStore("user-1");
    // A fresh open was attempted rather than the rejected instance being handed back forever.
    expect(second).not.toBe(first);
    expect(harness.createdStorePaths).toEqual([storePathForStore("store-1"), storePathForStore("store-1")]);
  });

  it("claim-then-ensureSpare ordering: a subsequent GC keeps the just-claimed store", async () => {
    const harness = makeHarness({
      initial: { version: 1, map: {}, spare: "spare-1" },
      databases: [idbNameForStore("spare-1"), idbNameForStore("orphan")],
    });
    const registry = createStoreRegistry(harness.adapters);

    // Claim the spare (this is what prewarm does on a signed-in reload for an unmapped-but-spare user).
    const opened = await registry.openUserStore("user-1");
    expect(opened.storeId).toBe("spare-1");

    // A GC pass now runs (ensureSpare). It must NOT delete the store the claim just bound.
    await registry.ensureSpare();

    expect(harness.deletedDatabases).toContain(idbNameForStore("orphan"));
    expect(harness.deletedDatabases).not.toContain(idbNameForStore("spare-1"));
    expect(harness.state()?.map).toEqual({ "user-1": "spare-1" });
  });

  it("registry disabled (storage throws): falls back to the deterministic per-user store", async () => {
    const harness = makeHarness({ storageThrows: true });
    const registry = createStoreRegistry(harness.adapters);

    const opened = await registry.openUserStore("user-1");
    expect(opened.storeId).toBeNull();
    expect(opened.storePath).toBe(fallbackStorePathForUser("user-1"));
    expect(opened.pglite).toBeUndefined();
    // The deterministic fallback path may hold a prior session's store — conservatively NOT fresh, so the
    // sync client takes the safe sequential path (no prefetch overlap).
    expect(opened.fresh).toBe(false);
    // No eager create happened on the failed path.
    expect(harness.createdStorePaths).toEqual([]);
  });
});

// ─── Obsolete stores (ADR-0050): Apply drops bindings to the list; boots destroy it best-effort ──────

describe("obsoleteAllStores — Apply atomically drops every binding onto the Obsolete-stores list", () => {
  it("records every mapped store and the spare as exact paths, clears map+spare, and keeps prior entries", async () => {
    const harness = makeHarness({
      initial: {
        version: 1,
        map: { "user-1": "store-a", "user-2": "store-b" },
        spare: "spare-1",
        obsolete: [storePathForStore("old-x")],
      },
    });
    const registry = createStoreRegistry(harness.adapters);

    const dropped = await registry.obsoleteAllStores();

    expect(new Set(dropped)).toEqual(
      new Set([
        storePathForStore("old-x"),
        storePathForStore("store-a"),
        storePathForStore("store-b"),
        storePathForStore("spare-1"),
      ]),
    );
    const state = harness.state();
    expect(state?.map).toEqual({});
    expect(state?.spare).toBeUndefined();
    expect(new Set(state?.obsolete)).toEqual(new Set(dropped));
  });

  it("a subsequent openUserStore mints a FRESH store — never a just-obsoleted path", async () => {
    const harness = makeHarness({
      initial: { version: 1, map: { "user-1": "store-a" }, spare: "spare-1" },
    });
    const registry = createStoreRegistry(harness.adapters);

    await registry.obsoleteAllStores();
    const opened = await registry.openUserStore("user-1");

    expect(opened.storeId).toBe("gen-1"); // freshly minted, not the obsoleted store-a / spare-1
    expect(opened.fresh).toBe(true);
  });

  it("GC keeps obsolete stores' idb out of the orphan sweep (full destruction owns them)", async () => {
    const obsoletePath = storePathForStore("old-x");
    const harness = makeHarness({
      initial: { version: 1, map: {}, obsolete: [obsoletePath] },
      databases: [idbNameForStore("old-x"), idbNameForStore("orphan")],
    });
    const registry = createStoreRegistry(harness.adapters);

    await registry.ensureSpare();

    expect(harness.deletedDatabases).toContain(idbNameForStore("orphan"));
    expect(harness.deletedDatabases).not.toContain(idbNameForStore("old-x"));
  });
});

describe("destroyObsoleteStores — best-effort boot-time destruction with retry-next-boot", () => {
  it("destroys each listed path and removes it from the list", async () => {
    const pathA = storePathForStore("old-a");
    const pathB = storePathForStore("old-b");
    const harness = makeHarness({ initial: { version: 1, map: {}, obsolete: [pathA, pathB] } });
    const registry = createStoreRegistry(harness.adapters);

    await registry.destroyObsoleteStores();

    expect(harness.destroyedStorePaths).toEqual([pathA, pathB]);
    expect(harness.state()?.obsolete).toBeUndefined();
  });

  it("a failed destruction (a live worker still holds the store) KEEPS the path listed and never throws", async () => {
    const held = storePathForStore("held");
    const free = storePathForStore("free");
    const harness = makeHarness({
      initial: { version: 1, map: { "user-1": "live" }, obsolete: [held, free] },
      rejectDestroyPaths: [held],
    });
    const registry = createStoreRegistry(harness.adapters);

    await registry.destroyObsoleteStores(); // resolves despite the held path

    expect(harness.destroyedStorePaths).toEqual([free]);
    const state = harness.state();
    expect(state?.obsolete).toEqual([held]); // retry state for the next boot
    expect(state?.map).toEqual({ "user-1": "live" }); // live bindings untouched
  });
});

// ─── retainObsoletePaths (the "Delete local data" wipe's partial-failure retry state) ──────────────────

describe("retainObsoletePaths — a partial wipe hands failed paths to the Obsolete-stores list", () => {
  it("merges the given paths onto the existing obsolete list AND collapses map + spare", async () => {
    const existing = storePathForStore("old-x");
    const harness = makeHarness({
      initial: { version: 1, map: { "user-1": "store-a" }, spare: "spare-1", obsolete: [existing] },
    });
    const failed = [storePathForStore("held-1"), storePathForStore("held-2")];

    await retainObsoletePaths(harness.adapters, failed);

    const state = harness.state();
    // Bindings and the spare are cleared — no binding may survive pointing at a now-deleted store.
    expect(state?.map).toEqual({});
    expect(state?.spare).toBeUndefined();
    // Existing obsolete entries are preserved and the failed paths merged in (the same list shape Apply uses).
    expect(new Set(state?.obsolete)).toEqual(new Set([existing, ...failed]));
    // The registry key is NOT removed — it is the only record of these paths (OPFS dirs included).
    expect(harness.state()).not.toBeNull();
  });

  it("dedupes a path already listed (a previously-obsolete path that failed again stays once)", async () => {
    const held = storePathForStore("held");
    const harness = makeHarness({ initial: { version: 1, map: {}, obsolete: [held] } });

    await retainObsoletePaths(harness.adapters, [held]);

    expect(harness.state()?.obsolete).toEqual([held]);
  });

  it("no failed paths + no prior obsolete writes a clean empty state (no obsolete key)", async () => {
    const harness = makeHarness({ initial: { version: 1, map: { "user-1": "store-a" }, spare: "spare-1" } });

    await retainObsoletePaths(harness.adapters, []);

    const state = harness.state();
    expect(state?.map).toEqual({});
    expect(state?.spare).toBeUndefined();
    expect(state?.obsolete).toBeUndefined();
  });

  it("runs its mutation under the cross-tab lock (consistent with obsoleteAllStores/destroyObsoleteStores)", async () => {
    const harness = makeHarness();
    let lockCalls = 0;
    const adapters: StoreRegistryAdapters = {
      ...harness.adapters,
      withLock: async (fn) => {
        lockCalls += 1;
        return fn();
      },
    };

    await retainObsoletePaths(adapters, [storePathForStore("held")]);

    expect(lockCalls).toBe(1);
    expect(harness.state()?.obsolete).toEqual([storePathForStore("held")]);
  });
});

// ─── quiesceThenDestroyStoreWith (ADR-0050): quiesce-before-destroy + the wipe/background failure split ─────

describe("quiesceThenDestroyStoreWith — quiesce the store's worker before destroying its artifacts", () => {
  const path = storePathForStore("s");
  const toreDownOutcome: StoreWorkerQuiesceOutcome = { engineHome: "shared-worker", toreDown: true };
  const timeoutError = () => new Error("[pgxsinkit] quiesceStoreWorker timed out after 6000ms");

  /** A deps fake recording the call order across quiesce/destroy so a test can prove quiesce ran FIRST. */
  function makeDeps(overrides: Partial<QuiesceThenDestroyDeps> = {}): {
    deps: QuiesceThenDestroyDeps;
    order: string[];
  } {
    const order: string[] = [];
    const deps: QuiesceThenDestroyDeps = {
      workerMode: true,
      quiesce: async () => {
        order.push("quiesce");
        return toreDownOutcome;
      },
      destroy: async () => {
        order.push("destroy");
      },
      ...overrides,
    };
    return { deps, order };
  }

  async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
    try {
      await promise;
    } catch (error) {
      return error;
    }
    throw new Error("expected the promise to reject, but it resolved");
  }

  it("(a) quiesces the store's worker BEFORE destroying its artifacts", async () => {
    const { deps, order } = makeDeps();
    await quiesceThenDestroyStoreWith(deps, path);
    expect(order).toEqual(["quiesce", "destroy"]);
  });

  it("skips the quiesce entirely in the in-process fallback (workerMode false) — only destroy runs", async () => {
    const { deps, order } = makeDeps({ workerMode: false });
    await quiesceThenDestroyStoreWith(deps, path);
    expect(order).toEqual(["destroy"]);
  });

  it("(b) diagnostic: a quiesce TIMEOUT followed by a destroy failure throws a WORKER-TEARDOWN message", async () => {
    const { deps } = makeDeps({
      quiesce: async () => {
        throw timeoutError();
      },
      destroy: async () => {
        throw new Error("deleteDatabase blocked");
      },
    });

    const error = await rejectionOf(quiesceThenDestroyStoreWith(deps, path, { diagnostic: true }));

    expect(error).toBeInstanceOf(Error);
    // The message names the WORKER teardown as the step that stalled, carrying the 6000ms timeout figure.
    expect((error as Error).message).toContain("worker teardown timed out after 6000ms");
    expect((error as Error).message).toContain("background sync worker did not shut down");
    // The subsequent artifact-delete failure is included so the whole picture is legible.
    expect((error as Error).message).toContain("deleteDatabase blocked");
  });

  it("diagnostic: a SUCCEEDED teardown (toreDown) but a still-blocked delete names the delete, not the teardown", async () => {
    const { deps } = makeDeps({
      destroy: async () => {
        throw new Error("deleteDatabase blocked");
      },
    });

    const error = await rejectionOf(quiesceThenDestroyStoreWith(deps, path, { diagnostic: true }));

    const message = (error as Error).message;
    expect(message).toContain("worker teardown succeeded but the artifact delete was still blocked");
    expect(message).toContain("deleteDatabase blocked");
    expect(message).not.toContain("timed out");
  });

  it("(c) background best-effort: a quiesce failure is SWALLOWED when the destroy then succeeds (no throw)", async () => {
    const { deps, order } = makeDeps({
      quiesce: async () => {
        order.push("quiesce");
        throw timeoutError();
      },
    });

    // No diagnostic option → the background obsolete-drain semantics: quiesce failure never aborts the destroy.
    await quiesceThenDestroyStoreWith(deps, path);
    expect(order).toEqual(["quiesce", "destroy"]);
  });

  it("without diagnostic, a destroy failure propagates the ORIGINAL error unchanged (no synthesized message)", async () => {
    const { deps } = makeDeps({
      quiesce: async () => {
        throw timeoutError();
      },
      destroy: async () => {
        throw new Error("raw destroy failure");
      },
    });

    const error = await rejectionOf(quiesceThenDestroyStoreWith(deps, path));

    expect((error as Error).message).toBe("raw destroy failure");
  });
});
