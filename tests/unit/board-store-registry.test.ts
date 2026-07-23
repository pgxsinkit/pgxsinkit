import { describe, expect, it } from "bun:test";

import type { ClientPGlite } from "@pgxsinkit/client";

import {
  createStoreRegistry,
  idbNameForStore,
  fallbackStorePathForUser,
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
}

function makeHarness(options: HarnessOptions = {}) {
  let stored: string | null = options.initial != null ? JSON.stringify(options.initial) : null;
  const createdStorePaths: string[] = [];
  const deletedDatabases: string[] = [];
  const rejectStorePaths = new Set(options.rejectStorePaths ?? []);
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
    randomId: () => `gen-${++counter}`,
    // Tests exercise the pure decision logic; the lock is a straight pass-through here.
    withLock: (fn) => fn(),
  };

  return {
    adapters,
    createdStorePaths,
    deletedDatabases,
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
