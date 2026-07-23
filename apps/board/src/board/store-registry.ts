import { syncDebug, storeIndexedDbDatabaseName, type ClientPGlite } from "@pgxsinkit/client";

// Spare-store binding (board cold-boot optimisation B). PGlite's `initdb` + IDBFS open costs ~1.9s even
// once the WASM is pre-warmed (optimisation A, see ./pglite-warm), and it otherwise can't start until
// sign-in answers because the store is keyed by user id. This module breaks that ordering: on the login
// SCREEN it eagerly creates an ANONYMOUS store under a generated id (consuming the WASM warm), then BINDS
// that store to whichever user signs in — so the expensive create runs during identity-picker think-time,
// not after auth on the path to first paint.
//
// The binding is a localStorage registry (one JSON key): a `map` of userId→storeId plus at most one
// `spare` (a created-but-unbound store). A returning user opens their mapped store; a new user CLAIMS the
// waiting spare. The store stays SCHEMALESS until claim — the local schema is registry/role-dependent
// (admin vs member), so schema exec stays post-login; only initdb is bought ahead.
//
// The pure logic here is driven entirely through injected {@link StoreRegistryAdapters} so it is
// unit-testable in bun without a browser. The real localStorage / IndexedDB / navigator.locks /
// `createClientPGlite`(+warm) wiring lives in ./store-registry-default (kept out of this DOM-free module
// so the unit test's root typecheck never pulls DOM globals in).
//
// RESILIENCE RULE: any failure in this machinery (storage unavailable, idb errors, no locks) falls back
// to the deterministic fallback store path `pgxsinkit-board-${userId}` with no eager create. The pattern is
// an accelerator, never a boot dependency.

/** The board store-id prefix. A store id `X` lives at store path `pgxsinkit-board-X` (ADR-0036). */
export const STORE_PREFIX = "pgxsinkit-board-";
/** The single localStorage key holding the JSON registry. */
export const REGISTRY_KEY = "pgxsinkit-board-stores";
/** The Web Locks name guarding registry mutations (spare creation, claim) across tabs. */
export const REGISTRY_LOCK = "pgxsinkit-board-stores";
// The IndexedDB database-name prefix for board stores, derived by the library's own operational helper
// (ADR-0036) rather than re-assembling PGlite's `/pglite/` naming here — so the board never encodes
// PGlite-internal storage knowledge itself. Orphan GC lists IndexedDB and keys off this prefix.
const IDB_PREFIX = storeIndexedDbDatabaseName(STORE_PREFIX);

/** The plain store path a store id opens at (ADR-0036 — a name, not a storage URL). */
export function storePathForStore(storeId: string): string {
  return `${STORE_PREFIX}${storeId}`;
}

/** The deterministic per-user resilience fallback used when the registry accelerator is unavailable. */
export function fallbackStorePathForUser(userId: string): string {
  return `${STORE_PREFIX}${userId}`;
}

/** The IndexedDB database name a store id occupies (for orphan GC / corrupt-spare deletion). */
export function idbNameForStore(storeId: string): string {
  return storeIndexedDbDatabaseName(storePathForStore(storeId));
}

/** The persisted registry shape: userId→storeId bindings plus at most one unbound spare. */
export interface StoreRegistryState {
  version: 1;
  map: Record<string, string>;
  spare?: string;
}

/** A PGlite instance opened by an adapter, paired with the store id it actually opened. */
export interface OpenedStore {
  pglite: ClientPGlite;
  /** The opened id — usually the requested one, but a fresh replacement id when a corrupt spare recovered. */
  storeId: string;
}

/**
 * The browser seams the pure logic drives — injected so the claim/bind/GC flow is unit-testable without a
 * real browser. The default implementation (./store-registry-default) wires localStorage / IndexedDB /
 * navigator.locks / `createClientPGlite`(+warm).
 */
export interface StoreRegistryAdapters {
  /** Read the raw registry JSON string, or null when unset. MAY throw when storage is unavailable. */
  readRegistry: () => string | null;
  /** Persist the raw registry JSON string. MAY throw when storage is unavailable. */
  writeRegistry: (value: string) => void;
  /** List IndexedDB database names, or null when `indexedDB.databases()` is unavailable (skip GC then). */
  listDatabases: () => Promise<readonly string[] | null>;
  /** Delete an IndexedDB database by name (best-effort). */
  deleteDatabase: (name: string) => Promise<void>;
  /** Create the raw PGlite store at `storePath` (consumes the WASM warm) — the eager/opening step. */
  createStore: (storePath: string) => Promise<ClientPGlite>;
  /** Generate a fresh random store id. */
  randomId: () => string;
  /** Run `fn` under the cross-tab registry lock when available; best-effort (just `fn()`) otherwise. */
  withLock: <T>(fn: () => Promise<T>) => Promise<T>;
}

/** The result of {@link StoreRegistry.ensureSpare} — whether a NEW spare was created on this mount. */
export interface EnsureSpareResult {
  created: boolean;
}

/**
 * The result of {@link StoreRegistry.openUserStore}. `pglite` is the (possibly still-pending) precreated
 * instance to hand to `createSyncClient` via `precreatedPglite`; it is absent only on the fallback
 * path, where the caller opens `storePath` itself. `storePath` is always the store's plain path (ADR-0036)
 * — the library's fallback if `pglite` rejects, and the actual store on the deterministic fallback path.
 */
export interface OpenUserStoreResult {
  storeId: string | null;
  storePath: string;
  pglite?: Promise<ClientPGlite>;
  /**
   * Whether this store is PROVABLY fresh — a just-claimed schemaless spare or a brand-new create, with no
   * prior schema/rows/subscription state (ADR-0032 S4 fresh-store prefetch overlap). A mapped (returning)
   * user's store and the deterministic fallback are NOT fresh. Forwarded as the `freshStore` hint to the sync
   * client so a cold boot overlaps the shape catch-up with the local boot phases.
   */
  fresh: boolean;
}

export interface StoreRegistry {
  /**
   * Login-screen entry point. GC orphaned stores, then ensure exactly one spare exists: if none, mint an
   * id, record it FIRST, and eagerly start its create (consuming the WASM warm). If a spare already
   * exists but was recorded by a previous page/tab, open it eagerly (recovering a corrupt one) so a claim
   * is instant. Any failure is swallowed — this is a pure accelerator. Emits `boot spare store ensured`.
   */
  ensureSpare: () => Promise<EnsureSpareResult>;
  /**
   * Sign-in entry point for `userId`. Returns the store to boot on: the user's MAPPED store, else the
   * CLAIMED waiting spare (handing over this page's in-flight eager create when present), else a FRESH
   * create. Any registry/spare failure falls back to the deterministic per-user path. Emits
   * `boot store claimed`.
   */
  openUserStore: (userId: string) => Promise<OpenUserStoreResult>;
}

/** Parse the persisted registry, defaulting/repairing any malformed shape to an empty registry. */
function readState(adapters: StoreRegistryAdapters): StoreRegistryState {
  const raw = adapters.readRegistry();
  if (raw == null) return { version: 1, map: {} };
  const parsed = JSON.parse(raw) as unknown;
  if (
    parsed == null ||
    typeof parsed !== "object" ||
    (parsed as { version?: unknown }).version !== 1 ||
    typeof (parsed as { map?: unknown }).map !== "object" ||
    (parsed as { map?: unknown }).map == null
  ) {
    return { version: 1, map: {} };
  }
  const source = parsed as { map: Record<string, unknown>; spare?: unknown };
  const map: Record<string, string> = {};
  for (const [userId, storeId] of Object.entries(source.map)) {
    if (typeof storeId === "string") map[userId] = storeId;
  }
  return {
    version: 1,
    map,
    ...(typeof source.spare === "string" ? { spare: source.spare } : {}),
  };
}

function writeState(adapters: StoreRegistryAdapters, state: StoreRegistryState): void {
  adapters.writeRegistry(JSON.stringify(state));
}

/** Delete any board IndexedDB store whose id is neither a `map` value nor the current `spare`. */
async function gcOrphans(adapters: StoreRegistryAdapters, state: StoreRegistryState): Promise<void> {
  const names = await adapters.listDatabases();
  // `indexedDB.databases()` unavailable (older Firefox / a non-DOM host): skip GC entirely.
  if (names == null) return;
  const keep = new Set<string>(Object.values(state.map));
  if (state.spare != null) keep.add(state.spare);
  for (const name of names) {
    if (!name.startsWith(IDB_PREFIX)) continue;
    const storeId = name.slice(IDB_PREFIX.length);
    // Any board store not mapped to a user and not held as the spare is an orphan under the current registry.
    if (keep.has(storeId)) continue;
    await adapters.deleteDatabase(name);
  }
}

export function createStoreRegistry(adapters: StoreRegistryAdapters): StoreRegistry {
  // Page-local eager state: the spare id this page started creating and its in-flight open, so a claim on
  // this same page can hand the already-running create over rather than opening a second time.
  let eager: { spareId: string; promise: Promise<OpenedStore> } | null = null;

  // Page-local memo of the in-flight/settled open PER userId. Bootstrap prewarm and the board provider
  // both call openUserStore(userId) on a signed-in reload; they MUST share one result so a single store
  // is opened. Without this a second call would (a) mint a SECOND binding for an unmapped user, or
  // (b) open a SECOND PGlite instance on the same IndexedDB store for a mapped user — both corruption
  // hazards. Keyed by userId so distinct identities still get distinct stores.
  const openByUser = new Map<string, Promise<OpenUserStoreResult>>();

  // Open a spare by id, recovering from a corrupt/partial idb: if the open rejects (e.g. a crash left a
  // half-written store mid-initdb), delete that database and create fresh under a NEW id, so a corrupt
  // spare can never wedge login. Returns the working instance and the id actually opened.
  async function openSpareRecovering(spareId: string): Promise<OpenedStore> {
    try {
      const pglite = await adapters.createStore(storePathForStore(spareId));
      return { pglite, storeId: spareId };
    } catch (error) {
      syncDebug("boot spare store corrupt — recreating", {
        error: error instanceof Error ? error.message : String(error),
      });
      try {
        await adapters.deleteDatabase(idbNameForStore(spareId));
      } catch {
        // Best-effort delete; a still-blocked/absent db must not stop the fresh create.
      }
      const freshId = adapters.randomId();
      const pglite = await adapters.createStore(storePathForStore(freshId));
      return { pglite, storeId: freshId };
    }
  }

  // Move the registry's `spare` pointer from `fromId` to `toId` (a corrupt-spare recovery minted a fresh
  // store) — but only while `fromId` is still the recorded spare, so a concurrent claim never resurrects it.
  async function reconcileSparePointer(fromId: string, toId: string): Promise<void> {
    await adapters.withLock(async () => {
      const state = readState(adapters);
      if (state.spare === fromId) writeState(adapters, { ...state, spare: toId });
    });
  }

  // Re-point a user's binding after a corrupt spare recovered to a fresh id during claim.
  async function reconcileMapEntry(userId: string, fromId: string, toId: string): Promise<void> {
    await adapters.withLock(async () => {
      const state = readState(adapters);
      if (state.map[userId] === fromId) {
        writeState(adapters, { ...state, map: { ...state.map, [userId]: toId } });
      }
    });
  }

  function startEagerOpen(spareId: string): void {
    const promise = (async () => {
      const opened = await openSpareRecovering(spareId);
      // A recovery minted a fresh id: keep the registry's spare pointer consistent so GC keeps the new
      // store and the next load/claim sees it (a no-op if a claim already cleared the spare).
      if (opened.storeId !== spareId) await reconcileSparePointer(spareId, opened.storeId);
      return opened;
    })();
    eager = { spareId, promise };
    // Guard an unobserved rejection when no claim ever consumes this promise (a page that navigates away).
    // The claim path re-awaits `promise` itself, so this guard never swallows its result.
    void promise.catch(() => undefined);
  }

  // The uncached open logic. The exported openUserStore memoises this per userId (see below).
  async function openUserStoreUncached(userId: string): Promise<OpenUserStoreResult> {
    try {
      const plan = await adapters.withLock(async () => {
        const state = readState(adapters);
        const mappedId = state.map[userId];
        if (mappedId != null) return { kind: "mapped" as const, storeId: mappedId };
        if (state.spare != null) {
          // Claim the spare: move its id into the user's binding and clear it, so a future NEW user mints
          // their own rather than re-claiming this one.
          const spareId = state.spare;
          const next: StoreRegistryState = { ...state, map: { ...state.map, [userId]: spareId } };
          delete next.spare;
          writeState(adapters, next);
          return { kind: "claim" as const, storeId: spareId };
        }
        // No spare at all — the fallback path: mint an id, bind it, create at this point (today's cost).
        const freshId = adapters.randomId();
        writeState(adapters, { ...state, map: { ...state.map, [userId]: freshId } });
        return { kind: "fresh" as const, storeId: freshId };
      });

      if (plan.kind === "mapped") {
        syncDebug("boot store claimed", { spare: false, mapped: true });
        return {
          storeId: plan.storeId,
          storePath: storePathForStore(plan.storeId),
          pglite: adapters.createStore(storePathForStore(plan.storeId)),
          // A returning user's mapped store already carries schema + synced rows — never fresh.
          fresh: false,
        };
      }

      if (plan.kind === "claim") {
        syncDebug("boot store claimed", { spare: true, mapped: false });
        // Hand over this page's in-flight eager create when it is for this spare; else open it now
        // (recovering a corrupt cross-session spare).
        let opened: Promise<OpenedStore>;
        if (eager != null && eager.spareId === plan.storeId) {
          opened = eager.promise;
          eager = null;
        } else {
          opened = openSpareRecovering(plan.storeId);
        }
        const pglite = opened.then(async (result) => {
          // A corrupt spare recovered to a fresh id: re-point the user's binding at the store we actually
          // opened. The returned `storePath` (the original claim id) is then only ever the reject-fallback,
          // and unused because this resolved.
          if (result.storeId !== plan.storeId) await reconcileMapEntry(userId, plan.storeId, result.storeId);
          return result.pglite;
        });
        // A claimed spare is schemaless by construction (created but never schema-exec'd) — provably fresh.
        return { storeId: plan.storeId, storePath: storePathForStore(plan.storeId), pglite, fresh: true };
      }

      syncDebug("boot store claimed", { spare: false, mapped: false });
      // A freshly-minted store (no spare was waiting) — brand new, never synced — is also provably fresh.
      return {
        storeId: plan.storeId,
        storePath: storePathForStore(plan.storeId),
        pglite: adapters.createStore(storePathForStore(plan.storeId)),
        fresh: true,
      };
    } catch {
      // RESILIENCE: any registry/spare failure → deterministic fallback path, no eager create. The library
      // opens `storePath` itself (no `precreatedPglite`). Conservatively NOT fresh: the deterministic
      // per-user store path may hold a prior session's store, so take the safe sequential path.
      return { storeId: null, storePath: fallbackStorePathForUser(userId), fresh: false };
    }
  }

  return {
    ensureSpare: async () => {
      try {
        const decision = await adapters.withLock(async () => {
          const state = readState(adapters);
          await gcOrphans(adapters, state);
          if (state.spare != null) return { spareId: state.spare, created: false as const };
          const spareId = adapters.randomId();
          // Record the spare FIRST, then start the create — so a crash between the two leaves a recorded
          // spare (recoverable next load) rather than an orphaned, unrecorded store.
          writeState(adapters, { ...state, spare: spareId });
          return { spareId, created: true as const };
        });

        if (decision.created) {
          startEagerOpen(decision.spareId);
        } else if (eager == null || eager.spareId !== decision.spareId) {
          // A spare recorded by a PREVIOUS page/tab (this page has no eager create for it). Open it now so
          // a claim is instant, recovering a corrupt one. If this page already owns the eager create for
          // it, do nothing — the login might be for this db or another, so just wait.
          startEagerOpen(decision.spareId);
        }
        syncDebug("boot spare store ensured", { created: decision.created });
        return { created: decision.created };
      } catch {
        // The accelerator failed (storage/idb/locks) — the deterministic fallback still boots.
        syncDebug("boot spare store ensured", { created: false });
        return { created: false };
      }
    },

    // Memoise the open PER userId so bootstrap prewarm and the later provider mount share ONE open
    // (see openByUser above) — repeated calls for the same userId return the same in-flight/settled
    // result, never a second store on the same IndexedDB db, never a second binding for an unmapped user.
    openUserStore: (userId) => {
      const existing = openByUser.get(userId);
      if (existing != null) return existing;
      const opening = openUserStoreUncached(userId);
      openByUser.set(userId, opening);
      // Failure-retry: drop the memo if the open ULTIMATELY FAILED so a later call re-opens rather than
      // handing back a permanently-rejected instance (mirrors the warm module's drop-cache-on-failure).
      // The only real failure is the precreated pglite rejecting (the actual initdb/IDBFS open failing);
      // a fallback result (no pglite — the library opens `storePath` itself) is a deterministic,
      // cheap, cacheable success and is deliberately kept. openUserStoreUncached swallows into that
      // fallback and never rejects, but the outer-rejection arm guards defensively regardless.
      void opening.then(
        (result) => {
          if (result.pglite != null) {
            void result.pglite.catch(() => {
              if (openByUser.get(userId) === opening) openByUser.delete(userId);
            });
          }
        },
        () => {
          if (openByUser.get(userId) === opening) openByUser.delete(userId);
        },
      );
      return opening;
    },
  };
}
