import {
  type BridgePort,
  type ClientPGlite,
  createClientPGlite,
  destroyStoreArtifacts,
  provisionSyncWorker,
  quiesceStoreWorker,
} from "@pgxsinkit/client";

import { boardWorkerMode } from "./engine-host";
import { warmPgliteBootAssets } from "./pglite-warm";
import { boardStorageDeclaration, readBackendPreference, readDurabilityPreference } from "./storage-preference";
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

// One SharedWorker instance per store PER TAB — the provision (in `createStore`) and the later attach
// (board-client) must share the SAME instance/port so their messages stay ordered (provision boots the
// store before attach's engine adopts it). The browser additionally dedupes the name across tabs onto one
// shared engine. Named by the store path (unique + stable per store).
const workersByStorePath = new Map<string, SharedWorker>();

/** The board's current wire storage declaration (ADR-0050) — read fresh from localStorage per send. */
function currentStorageDeclaration() {
  return boardStorageDeclaration(readDurabilityPreference(), readBackendPreference());
}

/** The per-store SharedWorker, lazily constructed + cached (the inline `new URL` is Vite's worker-bundling cue). */
export function getBoardWorkerForStore(storePath: string): SharedWorker {
  // The worker NAME is the store path — nothing else, ever (ADR-0050). The storage preferences travel as the
  // wire declaration on the port (provision/attach send it), never in the name: configuration in the dedup
  // identity is what made a preference change replace the worker under a live extended-lifetime predecessor.
  // A preference change instead obsoletes the current store paths and reloads; fresh stores mint under fresh
  // paths, so this name never needs to change for a live store.
  let worker = workersByStorePath.get(storePath);
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
      name: storePath,
      extendedLifetime: true,
    } as WorkerOptions & { name: string; extendedLifetime: boolean });
    workersByStorePath.set(storePath, worker);
  }
  return worker;
}

/**
 * A store's SharedWorker for a one-shot TEARDOWN by name (ADR-0050), constructed fresh and NOT cached in
 * {@link workersByStorePath} — `quiesceStoreWorker` closes it, so it must never be handed out as a live store
 * worker. Connecting by the store's name reaches the LIVE (extendedLifetime) worker if one survives, else spawns
 * a throwaway the teardown immediately closes.
 *
 * The options here MUST MATCH the live worker's (`getBoardWorkerForStore`) — same `type`, same `name`, and
 * crucially `extendedLifetime: true`. A named SharedWorker is deduped by the browser onto ONE instance, but
 * Chromium (148+, where `extendedLifetime` is honoured) treats a second `new SharedWorker(name, …)` whose
 * options DISAGREE with the live instance's as a conflict and FAILS the connection (an `error` event, no
 * `onconnect`) — so the teardown port would exchange zero messages and time out. Omitting `extendedLifetime`
 * here (on the theory that the throwaway should not outlive) was exactly that bug: it does not shorten this
 * worker's life (the teardown handshake's `closeHost` + `scope.close()` ends it regardless), it only breaks the
 * dedup match. The `new SharedWorker(new URL(...))` stays inline + statically analyzable for Vite's worker
 * bundling (as above).
 */
function quiesceWorkerForStore(storePath: string): SharedWorker {
  return new SharedWorker(new URL("./board-sync.worker.ts", import.meta.url), {
    type: "module",
    name: storePath,
    extendedLifetime: true,
  } as WorkerOptions & { name: string; extendedLifetime: boolean });
}

/**
 * Release a store's backend connection before a path-addressed destroy (ADR-0050): tear down its SharedWorker
 * host so an `extendedLifetime` idbfs worker surviving a reload stops holding its IndexedDB connection (else
 * `deleteDatabase` blocks forever). Best-effort — a quiesce failure (timeout, or the worker already gone) is
 * swallowed; `destroyStoreArtifacts` then runs regardless, its own ownership-lag retry reporting honestly and
 * leaving the path re-runnable. `storage` is deliberately omitted (no opinion) so a live worker bound to an
 * older declaration is never refused. Not called in the in-process fallback (no worker to tear down).
 */
async function quiesceThenDestroyStore(storePath: string): Promise<void> {
  if (boardWorkerMode) {
    // Best-effort: release the store's SharedWorker host so its idbfs connection frees before the delete
    // (ADR-0050). A quiesce failure (timeout, or the worker already gone) is swallowed; destroyStoreArtifacts
    // then runs regardless and reports honestly, leaving the path re-runnable.
    await quiesceStoreWorker(() => quiesceWorkerForStore(storePath) as unknown as { port: BridgePort }).catch(
      () => undefined,
    );
  }
  await destroyStoreArtifacts(storePath);
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
            // The wire storage declaration (ADR-0050) rides the provision: it unblocks the worker's deferred
            // placement decision (idbfs must skip the probe) and binds the mint's durability.
            .then((port) => provisionSyncWorker({ port, storePath, storage: currentStorageDeclaration() }))
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
    // Full artifact destruction for a store (ADR-0050): first TEAR DOWN its SharedWorker host so an
    // extendedLifetime idbfs worker surviving a reload releases its IndexedDB connection (else the delete
    // blocks forever), then destroy every artifact (OPFS directory + sentinel + meta + idb) via the library's
    // own machinery — never an idb-only sweep that leaks the OPFS arena.
    destroyStore: (storePath) => quiesceThenDestroyStore(storePath),
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
