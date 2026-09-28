// Began as a copy of `@electric-sql/pglite` (taken under its PostgreSQL License option, © ElectricSQL
// — see NOTICE). Owned outright (ADR-0062); compatibility with PGlite is an anti-goal — evolve freely.

import { StorageInUseError, UnsupportedFeatureError } from "@pgxsinkit/pgwasm";

import type { PostgresModule } from "../emscripten";
import { PG_ROOT, PGDATA } from "../paths";
import type { StorageMount } from "./storage-mount";

/**
 * The IndexedDB database behind `idb://<name>`: `/pgwasm/<name>`. IDBFS names the database after its
 * mount point, so this is both. It is a store's identity: a change to it (as the root rename in 18.6.2)
 * opens a new, empty store and leaves the old database behind, never deleted here.
 */
export function idbDatabaseName(name: string): string {
  return `${PG_ROOT}/${name}`;
}

/** The Web Lock that guards `idb://<name>` against a second open: `pgwasm-idbfs:/pgwasm/<name>`. */
export function idbLockName(name: string): string {
  return `pgwasm-idbfs:${idbDatabaseName(name)}`;
}

/** The slice of the Web Locks API this mount uses. */
interface LockManagerLike {
  request(
    name: string,
    options: { mode: "exclusive"; ifAvailable: boolean },
    callback: (lock: unknown) => Promise<void>,
  ): Promise<void>;
}

/**
 * The data directory in IndexedDB, through Emscripten's IDBFS: the whole directory lives in memory and
 * is synced to an IndexedDB database named after its mount point, `/pgwasm/<name>`.
 *
 * One open per database: a Web Lock named after the database guards it, so a second open fails with
 * {@link StorageInUseError}. Both names come from {@link idbDatabaseName} and {@link idbLockName} only.
 *
 * Deliberately no exclusive persist: a relaxed persist is a background snapshot that statements run
 * beside (measured: an exclusive lane made relaxed as slow as strict, ~80 ms per statement). A crash
 * during a snapshot can lose its tail, which is relaxed durability's documented loss window.
 */
export class IdbMount implements StorageMount {
  readonly #name: string;
  #releaseHeldLock: (() => void) | undefined;
  #lockRequest: Promise<void> | undefined;

  constructor(name: string) {
    this.#name = name;
  }

  get #mountPoint(): string {
    return idbDatabaseName(this.#name);
  }

  async acquire(): Promise<void> {
    const locks = (globalThis as { navigator?: { locks?: LockManagerLike } }).navigator?.locks;
    if (!locks) {
      throw new UnsupportedFeatureError("IndexedDB storage needs the Web Locks API, which this context lacks.");
    }
    let resolveAcquired!: (acquired: boolean) => void;
    let rejectAcquired!: (reason: unknown) => void;
    const acquired = new Promise<boolean>((resolve, reject) => {
      resolveAcquired = resolve;
      rejectAcquired = reject;
    });
    let releaseLock!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const lockRequest = locks.request(
      idbLockName(this.#name),
      { mode: "exclusive", ifAvailable: true },
      async (lock) => {
        resolveAcquired(lock !== null);
        if (lock !== null) await held;
      },
    );
    this.#lockRequest = lockRequest;
    lockRequest.catch(rejectAcquired);
    if (!(await acquired)) {
      await lockRequest;
      this.#lockRequest = undefined;
      throw new StorageInUseError(`The IndexedDB store "${this.#name}" is already open.`);
    }
    this.#releaseHeldLock = releaseLock;
  }

  get preRun(): (module: PostgresModule) => void {
    return (module) => {
      const FS = module.FS;
      if (!FS.analyzePath(this.#mountPoint).exists) FS.mkdirTree(this.#mountPoint);
      FS.mount(FS.filesystems.IDBFS, {}, this.#mountPoint);
      FS.symlink(this.#mountPoint, PGDATA);
    };
  }

  async initialSync(module: PostgresModule): Promise<void> {
    await this.#syncfs(module, true);
  }

  async persist(module: PostgresModule): Promise<void> {
    await this.#syncfs(module, false);
  }

  async close(module: PostgresModule | undefined): Promise<void> {
    await this.#closeAndRelease(module);
  }

  async cleanupFailedInit(module: PostgresModule | undefined): Promise<void> {
    await this.#closeAndRelease(module);
  }

  async #closeAndRelease(module: PostgresModule | undefined): Promise<void> {
    try {
      if (module) {
        // IDBDatabase.close() returns at once; the database closes when its transactions finish. Deleting
        // it right after needs the caller to wait for that.
        module.FS.filesystems.IDBFS.dbs[this.#mountPoint]?.close();
        module.FS.quit();
      }
    } finally {
      const release = this.#releaseHeldLock;
      const request = this.#lockRequest;
      this.#releaseHeldLock = undefined;
      this.#lockRequest = undefined;
      release?.();
      await request;
    }
  }

  async #syncfs(module: PostgresModule, populate: boolean): Promise<void> {
    const timestampFloor = Date.now();
    await new Promise<void>((resolve, reject) => {
      module.FS.syncfs(populate, (error) => {
        if (error) {
          reject(error instanceof Error ? error : new Error(`IDBFS sync failed: ${JSON.stringify(error)}`));
        } else resolve();
      });
    });
    // IDBFS compares millisecond mtimes only: a later write must not reuse a timestamp this sync may have
    // persisted. This spins only when the whole sync fit inside one clock millisecond.
    const waitStartedAt = performance.now();
    while (Date.now() === timestampFloor) {
      if (performance.now() - waitStartedAt >= 1000) {
        throw new Error("IDBFS cannot guarantee a distinct MEMFS timestamp");
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
}
