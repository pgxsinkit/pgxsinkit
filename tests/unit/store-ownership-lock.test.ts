// The store's OPFS ownership lock orders a directory delete after the previous owner's handle release
// (store-ownership-lock.ts, opfs-effects.ts). The reproduction: a "previous" engine still holds the store's
// exclusive sync-access handles (as a reloaded page's dying worker does) when the successor deletes the store.
// Real OPFS refuses that `removeEntry` (Chromium `NoModificationAllowedError`, WebKit `UnknownError`); before the
// lock the delete ran straight into it. With the lock, the delete waits until the owner has let go.

import { describe, expect, test } from "bun:test";

import { createOpfsEffects, type DirLike } from "../../packages/client/src/opfs-effects";
import {
  acquireStoreOwnership,
  StoreOwnershipWaitError,
  type OwnershipLocks,
} from "../../packages/client/src/store-ownership-lock";
import { storeOwnershipLockName } from "../../packages/client/src/store-path";

/** An exclusive, FIFO, abortable Web Locks fake — the subset `navigator.locks.request` semantics the lock uses. */
function fakeLocks(): OwnershipLocks & { held(): string[] } {
  const held = new Set<string>();
  const queues = new Map<string, Array<() => void>>();
  const grantNext = (name: string): void => {
    const next = queues.get(name)?.shift();
    if (next) next();
  };
  return {
    held: () => [...held],
    request(name, options, callback) {
      return new Promise((resolve, reject) => {
        const run = (): void => {
          options.signal.removeEventListener("abort", onAbort);
          held.add(name);
          void callback({ name })
            .then(resolve, reject)
            .finally(() => {
              held.delete(name);
              grantNext(name);
            });
        };
        const onAbort = (): void => {
          const queue = queues.get(name) ?? [];
          queues.set(
            name,
            queue.filter((entry) => entry !== run),
          );
          reject(Object.assign(new Error("The request was aborted."), { name: "AbortError" }));
        };
        if (!held.has(name) && (queues.get(name)?.length ?? 0) === 0) {
          run();
          return;
        }
        options.signal.addEventListener("abort", onAbort, { once: true });
        queues.set(name, [...(queues.get(name) ?? []), run]);
      });
    },
  };
}

/** A fake OPFS tree whose store directory refuses deletion while `handlesOpen` — exactly real OPFS's refusal. */
function fakeOpfs(storeIdentity: string) {
  const state = { handlesOpen: false, storePresent: true, removeCalls: 0 };
  const dir = (children: Record<string, () => DirLike>, onRemove?: (name: string) => void): DirLike => ({
    getDirectoryHandle: async (name) => {
      const child = children[name];
      if (!child) throw Object.assign(new Error(`${name} not found`), { name: "NotFoundError" });
      return child();
    },
    getFileHandle: async () => ({}),
    removeEntry: async (name) => {
      onRemove?.(name);
    },
  });
  const stores = (): DirLike =>
    dir(state.storePresent ? { [storeIdentity]: () => dir({}) } : {}, (name) => {
      state.removeCalls += 1;
      if (name !== storeIdentity || !state.storePresent) {
        throw Object.assign(new Error(`${name} not found`), { name: "NotFoundError" });
      }
      if (state.handlesOpen) {
        throw Object.assign(new Error("An attempt was made to modify an object where modifications are not allowed."), {
          name: "NoModificationAllowedError",
        });
      }
      state.storePresent = false;
    });
  const root = dir({ pgxsinkit: () => dir({ stores }) });
  return { state, getRoot: async () => root };
}

/** Drain every pending microtask (one macrotask turn) — the deletion's async chain settles or parks by then. */
const drain = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const STORE = "ownership-lock-store";
const IDENTITY = storeOwnershipLockName(STORE).split(":").at(-1)!;

describe("store ownership lock", () => {
  test("a store-directory delete waits for the previous owner's release instead of failing under its handles", async () => {
    const locks = fakeLocks();
    const opfs = fakeOpfs(IDENTITY);

    // The previous engine: takes the ownership lock, THEN opens its exclusive handles (the open path's order).
    const releaseOwnership = await acquireStoreOwnership(STORE, { locks });
    opfs.state.handlesOpen = true;

    const effects = createOpfsEffects(STORE, { getRoot: opfs.getRoot, locks });
    let settled = "pending" as "pending" | "deleted" | Error;
    const deletion = effects.deleteStoreDirectory().then(
      () => (settled = "deleted"),
      (error: Error) => (settled = error),
    );

    // While the owner holds the store, the delete must not reach `removeEntry` (it would be refused).
    await drain();
    expect(settled).toBe("pending");
    expect(opfs.state.removeCalls).toBe(0);

    // The owner closes its handles, then releases the lock — the engine's close order.
    opfs.state.handlesOpen = false;
    releaseOwnership();
    await deletion;

    expect(settled).toBe("deleted");
    expect(opfs.state.storePresent).toBe(false);
    expect(opfs.state.removeCalls).toBe(1);
    expect(locks.held()).toEqual([]);
  });

  test("a live owner that never releases fails the delete loudly after the bounded wait", async () => {
    const locks = fakeLocks();
    const opfs = fakeOpfs(IDENTITY);
    const releaseOwnership = await acquireStoreOwnership(STORE, { locks });
    opfs.state.handlesOpen = true;

    const effects = createOpfsEffects(STORE, { getRoot: opfs.getRoot, locks, ownershipWaitMs: 5 });
    const failure = await effects.deleteStoreDirectory().then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(StoreOwnershipWaitError);
    expect((failure as Error).name).toBe("StoreOwnershipWaitError");
    expect(opfs.state.removeCalls).toBe(0);
    expect(opfs.state.storePresent).toBe(true);
    releaseOwnership();
    await drain();
    expect(locks.held()).toEqual([]);
  });

  test("a store with no owner is deleted at once, and a missing directory is still delete-if-present", async () => {
    const locks = fakeLocks();
    const opfs = fakeOpfs(IDENTITY);
    const effects = createOpfsEffects(STORE, { getRoot: opfs.getRoot, locks });
    await effects.deleteStoreDirectory();
    await effects.deleteStoreDirectory();
    expect(opfs.state.storePresent).toBe(false);
    expect(locks.held()).toEqual([]);
  });

  test("the release is idempotent and distinct stores never share a lock", async () => {
    const locks = fakeLocks();
    const releaseA = await acquireStoreOwnership("store-a", { locks });
    const releaseB = await acquireStoreOwnership("store-b", { locks });
    expect(locks.held().sort()).toEqual([storeOwnershipLockName("store-a"), storeOwnershipLockName("store-b")].sort());
    releaseA();
    releaseA();
    releaseB();
    await drain();
    expect(locks.held()).toEqual([]);
  });
});
