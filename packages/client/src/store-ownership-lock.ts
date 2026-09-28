// A store's OPFS OWNERSHIP LOCK — the ordering between the context that holds an opfs-repacked store's EXCLUSIVE
// sync-access handles and anything that deletes the store directory.
//
// The gap it closes: the VFS enforces single ownership with the handles themselves (`StoreOwnedError`), which a
// deleter cannot wait on — it can only fail. And a store's previous owner is routinely still dying when its
// successor deletes: a reload or a closed tab terminates the old elected engine worker ASYNCHRONOUSLY, so a
// `removeEntry` issued at the next boot can land while that worker still holds the handles. Chromium refuses it
// with `NoModificationAllowedError`, WebKit with `UnknownError`; a short blind retry only shrinks the window.
//
// The protocol: the opening context requests this Web Lock EXCLUSIVELY before it opens the handles and releases
// it only after it has closed them (`createPgwasmClient`'s opfs branch). A deleter takes the same lock around its
// `removeEntry` (`opfs-effects.ts`), so the delete runs only once the owner has provably let go. A worker that
// dies without closing loses the lock with its context, the same moment the browser reclaims its handles.
// Bounded: a LIVE owner never releases, so a wait longer than `waitMs` fails loudly with
// {@link StoreOwnershipWaitError} rather than hanging — the destruction stays re-runnable.
//
// Structural `navigator.locks` (no DOM lib), injectable for unit tests. A scope with no Web Locks API (Bun, Node)
// has no OPFS store to order against, so the lock degrades to a no-op there.

import { storeOwnershipLockName } from "./store-path";

/** The minimal `navigator.locks` shape this module needs: an exclusive, abortable `request`. */
export interface OwnershipLocks {
  request(
    name: string,
    options: { mode: "exclusive"; signal: AbortSignal },
    callback: (lock: unknown) => Promise<void>,
  ): Promise<unknown>;
}

/** Options for {@link acquireStoreOwnership} / {@link withStoreOwnership}. */
export interface StoreOwnershipOptions {
  /** The Web Locks surface. Omit in production: the default reads `navigator.locks` off `globalThis`. */
  locks?: OwnershipLocks | null;
  /** How long to wait for the current owner to release before failing. Default {@link STORE_OWNERSHIP_WAIT_MS}. */
  waitMs?: number;
}

/**
 * The default bound on waiting for a store's owner to let go. It covers a dying engine worker's teardown with a
 * wide margin while still failing loudly (and re-runnably) under an owner that is alive and staying.
 */
export const STORE_OWNERSHIP_WAIT_MS = 10_000;

/** The store is still owned by another live context after the bounded wait — the owner never released it. */
export class StoreOwnershipWaitError extends Error {
  readonly storePath: string;
  constructor(storePath: string, waitMs: number) {
    super(
      `[pgxsinkit] the OPFS store "${storePath}" is still owned by another live engine after ${waitMs} ms. ` +
        "Stop the client (or close the tab) that holds it, then retry.",
    );
    this.name = "StoreOwnershipWaitError";
    this.storePath = storePath;
  }
}

function resolveDefaultLocks(): OwnershipLocks | null {
  const locks = (globalThis as { navigator?: { locks?: OwnershipLocks } }).navigator?.locks;
  return locks != null && typeof locks.request === "function" ? locks : null;
}

/**
 * Take the store's ownership lock, waiting at most `waitMs` for the current holder to release it. Resolves with
 * an idempotent `release` once granted; rejects with {@link StoreOwnershipWaitError} when the wait runs out.
 * Without a Web Locks API the returned `release` is a no-op.
 */
export function acquireStoreOwnership(storePath: string, options?: StoreOwnershipOptions): Promise<() => void> {
  const locks = options?.locks === undefined ? resolveDefaultLocks() : options.locks;
  if (locks == null) return Promise.resolve(() => undefined);
  const waitMs = options?.waitMs ?? STORE_OWNERSHIP_WAIT_MS;
  return new Promise<() => void>((resolve, reject) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), waitMs);
    let granted = false;
    locks
      .request(storeOwnershipLockName(storePath), { mode: "exclusive", signal: controller.signal }, () => {
        granted = true;
        clearTimeout(timer);
        return new Promise<void>((releaseLock) => {
          let released = false;
          resolve(() => {
            if (released) return;
            released = true;
            releaseLock();
          });
        });
      })
      .catch((error: unknown) => {
        clearTimeout(timer);
        // An abort before the grant is the bounded wait running out; anything else is the Locks API failing.
        if (!granted) reject(controller.signal.aborted ? new StoreOwnershipWaitError(storePath, waitMs) : error);
      });
  });
}

/** Run `effect` while holding the store's ownership lock (see {@link acquireStoreOwnership}), then release it. */
export async function withStoreOwnership<T>(
  storePath: string,
  effect: () => Promise<T>,
  options?: StoreOwnershipOptions,
): Promise<T> {
  const release = await acquireStoreOwnership(storePath, options);
  try {
    return await effect();
  } finally {
    release();
  }
}
