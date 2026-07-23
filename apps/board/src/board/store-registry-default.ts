import {
  type BridgePort,
  type ClientPGlite,
  createClientPGlite,
  provisionSyncWorker,
  retireSyncWorkerHost,
} from "@pgxsinkit/client";

import { boardWorkerMode } from "./engine-host";
import { warmPgliteBootAssets } from "./pglite-warm";
import { readBackendPreference, readDurabilityPreference, workerNameForStore } from "./storage-preference";
import {
  createStoreRegistry,
  REGISTRY_KEY,
  REGISTRY_LOCK,
  type StoreRegistry,
  type StoreRegistryAdapters,
} from "./store-registry";

// The real browser wiring for the spare-store registry (see ./store-registry for the pure logic and the
// cold-boot rationale). Kept out of the DOM-free logic module so the unit test's root typecheck never has
// to resolve DOM globals — this file is only ever imported by the board app (login route + board-client),
// which typecheck under apps/board/tsconfig (DOM lib).
//
// ADR-0032 S3: when the browser has `SharedWorker`, the sync engine (PGlite included) runs in a per-store
// SharedWorker, not on the tab. The store-registry's PURE logic — id binding, the spare, GC, corrupt
// recovery — is unchanged; only the `createStore` SIDE EFFECT swaps: instead of creating a tab-side
// PGlite, it constructs the store's SharedWorker (named by its store path, so the browser dedupes N tabs
// onto one engine) and sends a `provision` (initdb only, schemaless, engine idle) that the later attach
// adopts. Where `SharedWorker` is missing, `createStore` keeps creating a tab-side PGlite (the in-process
// fallback, ADR-0032 decision 2) — today's behavior, untouched. The board is idb-only.

// `boardWorkerMode` (re-exported from ./engine-host for board-client's import) is "not in-process" — true for
// the shared-worker host.
export { boardWorkerMode };

// One SharedWorker instance per store name PER TAB — the provision (in `createStore`) and the later attach
// (board-client) must share the SAME instance/port so their messages stay ordered (provision boots the
// store before attach's engine adopts it). The browser additionally dedupes this name across tabs onto one
// shared engine. Named by the store path (unique + stable per store).
const workersByName = new Map<string, SharedWorker>();

/**
 * Quiesce every worker this tab constructed before a construction preference changes its SharedWorker name.
 * `extendedLifetime` can retain the old name after reload; awaiting the host barrier releases its IDB handle so
 * the replacement worker can open the same store under the new durability preference.
 */
export async function retireBoardWorkers(): Promise<void> {
  const workers = [...workersByName.entries()];
  await Promise.all(
    workers.map(async ([name, worker]) => {
      await retireSyncWorkerHost({ port: worker.port as unknown as BridgePort });
      workersByName.delete(name);
    }),
  );
}

/** The per-store SharedWorker, lazily constructed + cached (the inline `new URL` is Vite's worker-bundling cue). */
export function getBoardWorkerForStore(storePath: string): SharedWorker {
  // Both storage preferences ride in the worker NAME (`<storePath>?durability=<dur>&backend=<backend>`), NOT the
  // URL: Vite bundles the worker chunk only when the `new URL(...)` literal sits INLINE in the
  // `new SharedWorker(...)` call below — hoisting it out to append a query param degrades the reference to a
  // plain asset emit (the raw TS source, unloadable) in the build. The name is equally part of the SharedWorker
  // dedup identity, so a different value still yields a DIFFERENT worker; the worker reads them back off
  // `globalThis.name` (storage-preference's `durabilityPreferenceFromWorkerName` / `backendPreferenceFromWorkerName`).
  // They are read from localStorage ONCE, here at construction time; changing either first retires this tab's
  // constructed workers, then writes localStorage and reloads (`retireBoardWorkers` + `applyStoragePreferences`),
  // so an extended-lifetime worker under the old name cannot retain the database handle. The name still embeds the
  // store path, so the browser dedupes N tabs onto ONE engine per store (ADR-0032 decision 2).
  const name = workerNameForStore(storePath, readDurabilityPreference(), readBackendPreference());
  let worker = workersByName.get(name);
  if (worker == null) {
    // `type: "module"` so Vite serves an ES-module worker in dev (the chunk `import`s the registry as
    // code) and bundles a module SharedWorker in the build. The whole `new SharedWorker(new URL(...))`
    // expression is Vite's worker-bundling cue and must stay statically analyzable, inline, exactly so.
    // `extendedLifetime: true` (ADR-0049 plan step 14; Chromium 148+, ignore-safe elsewhere): the SW
    // outlives its last client for a grace period, so a pending relaxed idbfs detached flush LANDS when
    // the last tab closes right after a write, and a tab reopened within the window warm-starts on the
    // same instance. The option is an unknown dictionary member on Firefox/WebKit — ignored, never an error.
    worker = new SharedWorker(new URL("./board-sync.worker.ts", import.meta.url), {
      type: "module",
      name,
      extendedLifetime: true,
    } as WorkerOptions & { name: string; extendedLifetime: boolean });
    workersByName.set(name, worker);
  }
  return worker;
}

/**
 * The store's SharedWorker port as the library's transport-agnostic {@link BridgePort}. The DOM `MessagePort`
 * IS a valid bridge port at runtime; the cast only bridges TS's DOM `postMessage` transfer-overload variance
 * (the library stays DOM-lib-free by design). `SharedWorker.port` is stable, so provision + attach in one tab
 * share ONE ordered port to the same engine.
 */
export function getBoardStorePort(storePath: string): BridgePort {
  return getBoardWorkerForStore(storePath).port as unknown as BridgePort;
}

/**
 * The engine bridge port for a store. The shared-worker host returns today's `SharedWorker.port`, stable per
 * store within a tab, so provision (in `createStore`) and the later attach (board-client) share ONE ordered port
 * to the same engine. Never called in the in-process fallback (there is no worker port there).
 */
export function getBoardEnginePort(storePath: string): Promise<BridgePort> {
  return Promise.resolve(getBoardStorePort(storePath));
}

// A placeholder the worker-mode `createStore` resolves to: in worker mode the raw store lives in the
// worker, so there is no tab-side PGlite. The registry only awaits this promise (resolve = store ready,
// reject = corrupt → recover); board-client IGNORES the value and attaches by store name instead.
const WORKER_STORE_PLACEHOLDER = {} as unknown as ClientPGlite;

/** The registry adapters bound to real localStorage / IndexedDB / navigator.locks / (worker provision | `createClientPGlite`). */
export function createBoardStoreAdapters(): StoreRegistryAdapters {
  return {
    // `getItem` returns null for an absent key (a fresh visitor) without throwing; a genuinely
    // unavailable localStorage (privacy mode, disabled storage) throws on access, and that propagates so
    // the caller falls back to the deterministic per-user path.
    readRegistry: () => globalThis.localStorage.getItem(REGISTRY_KEY),
    writeRegistry: (value) => globalThis.localStorage.setItem(REGISTRY_KEY, value),
    listDatabases: async () => {
      const factory = globalThis.indexedDB as IDBFactory & {
        databases?: () => Promise<Array<{ name?: string }>>;
      };
      // `databases()` is unavailable on some engines (older Firefox); returning null skips orphan GC.
      if (typeof factory?.databases !== "function") return null;
      const infos = await factory.databases();
      return infos.map((info) => info.name).filter((name): name is string => typeof name === "string");
    },
    deleteDatabase: (name) =>
      new Promise<void>((resolve, reject) => {
        const request = globalThis.indexedDB.deleteDatabase(name);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error ?? new Error(`deleteDatabase(${name}) failed`));
        // A blocked delete (an open connection in another tab OR the store's own live SharedWorker) must
        // not hang boot — treat it as done and let the next GC retry. Best-effort by design (ADR-0032 §2).
        request.onblocked = () => resolve();
      }),
    // In worker mode: construct the store's SharedWorker and `provision` it (initdb runs INSIDE the worker,
    // off every thread that matters), resolving when the worker acks — a rejected provision (initdb failed)
    // propagates so the pure logic's corrupt-spare recovery deletes the idb and re-provisions under a fresh
    // id, exactly as it recovers a corrupt tab-side create. In the in-process fallback: create the tab-side
    // PGlite, consuming the login-screen WASM warm (optimisation A).
    createStore: (storePath) =>
      boardWorkerMode
        ? getBoardEnginePort(storePath)
            .then((port) => provisionSyncWorker({ port, storePath }))
            .then(() => WORKER_STORE_PLACEHOLDER)
        : // In-process fallback: the durability preference is baked into the store at CREATE time (board-client
          // later adopts this store via `precreatedPglite`, so the create must carry it). The BACKEND preference
          // needs NO equivalent here: `createClientPGlite` takes no backend/idbfs knob (only the internal
          // capability flag `hasOpfsSyncAccess`, which DEFAULTS to false → the store resolves to `idb://`, ADR-0049
          // step 10a). This precreate never runs the opfs probe/election, so it already opens on idbfs — forcing
          // idbfs is a no-op relative to what it already does, and the `opfs` default cannot make it opfs here (the
          // board is idb-only in-process, see the module header). Only the durability axis is un-derivable, so only
          // it is threaded in.
          createClientPGlite(storePath, {
            bootAssets: warmPgliteBootAssets(),
            durability: readDurabilityPreference(),
          }),
    randomId: () => globalThis.crypto.randomUUID(),
    withLock: async (fn) => {
      const locks = (globalThis.navigator as Navigator & { locks?: LockManager }).locks;
      // Best-effort without Web Locks: proceed unguarded (a rare cross-tab race at worst leaves a second
      // spare, which the next GC reaps).
      if (locks == null) return fn();
      return locks.request(REGISTRY_LOCK, () => fn());
    },
  };
}

/** The app-wide spare-store registry singleton (one page-local eager state for the whole board). */
export const boardStoreRegistry: StoreRegistry = createStoreRegistry(createBoardStoreAdapters());
