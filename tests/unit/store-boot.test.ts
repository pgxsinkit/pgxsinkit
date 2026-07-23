import { describe, expect, it } from "bun:test";
// ADR-0049 (capability-driven engine placement) step 10a: the store-boot WIRING — `resolveStoreBoot`
// assembles the boot observations (meta record + commitment namespace + recordless idb fact) and EXECUTES the
// classifier's verdict with real effects, and `createClientPGlite`'s `opfs://` branch routes to the
// opfs-repacked factory. Bun has no browser IndexedDB / OPFS / WASM, so every IO surface is faked here and
// the opfs-repacked factory is injected — no real engine is ever constructed.

import { createClientPGlite, resolveStoreBoot } from "../../packages/client/src/index";
import { recoverDeniedBootDeletion } from "../../packages/client/src/store-boot";
import { StoreMetaUnreadableError } from "../../packages/client/src/store-meta";
import {
  opfsCommitmentSentinelPath,
  opfsStoreDirectoryPath,
  storeIdentityComponent,
  storeIndexedDbDatabaseName,
} from "../../packages/client/src/store-path";
import { memoryStoreForTests } from "../../packages/client/src/testing";

// ---------------------------------------------------------------------------------------------------------
// Fake OPFS: a tiny in-memory FileSystemDirectoryHandle tree implementing only the surface opfs-effects
// touches — getDirectoryHandle / getFileHandle (create true|false) and recursive removeEntry. A shared `log`
// records directory CREATES so the record-before-directory ordering of a fresh candidate can be asserted.
// ---------------------------------------------------------------------------------------------------------

function notFound(): Error {
  const error = new Error("not found");
  error.name = "NotFoundError";
  return error;
}

class FakeDir {
  dirs = new Map<string, FakeDir>();
  files = new Set<string>();
  log: string[] | undefined;
  constructor(log?: string[]) {
    this.log = log;
  }

  async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<FakeDir> {
    const existing = this.dirs.get(name);
    if (existing != null) return existing;
    if (options?.create) {
      const dir = new FakeDir(this.log);
      this.dirs.set(name, dir);
      this.log?.push(`mkdir:${name}`);
      return dir;
    }
    throw notFound();
  }

  async getFileHandle(name: string, options?: { create?: boolean }): Promise<unknown> {
    if (this.files.has(name)) return { name };
    if (options?.create) {
      this.files.add(name);
      return { name };
    }
    throw notFound();
  }

  async removeEntry(name: string): Promise<void> {
    if (this.dirs.delete(name)) return;
    if (this.files.delete(name)) return;
    throw notFound();
  }
}

async function seedStoreDir(root: FakeDir, storePath: string): Promise<void> {
  let handle = root;
  for (const segment of opfsStoreDirectoryPath(storePath))
    handle = await handle.getDirectoryHandle(segment, { create: true });
}

async function seedSentinel(root: FakeDir, storePath: string): Promise<void> {
  const path = opfsCommitmentSentinelPath(storePath);
  let handle = root;
  for (let i = 0; i < path.length - 1; i += 1) handle = await handle.getDirectoryHandle(path[i]!, { create: true });
  await handle.getFileHandle(path[path.length - 1]!, { create: true });
}

// ---------------------------------------------------------------------------------------------------------
// Fake meta IndexedDB: the store-meta record IO protocol (open → upgradeneeded object-store create → success,
// then transaction → objectStore → get/put/delete/close) PLUS `deleteDatabase` and a `hasDb` probe used by the
// injected recordless `idbExists`. Record puts are logged as `record:<phase>` for the ordering assertion.
// ---------------------------------------------------------------------------------------------------------

const META_DB = "pgxsinkit-store-meta";
const META_STORE = "stores";

class FakeObjectStore {
  data = new Map<string, unknown>();
  log: string[] | undefined;
  constructor(log?: string[]) {
    this.log = log;
  }
  private request(op: () => unknown) {
    const req: { result: unknown; error: unknown; onsuccess: (() => void) | null; onerror: (() => void) | null } = {
      result: undefined,
      error: null,
      onsuccess: null,
      onerror: null,
    };
    queueMicrotask(() => {
      req.result = op();
      req.onsuccess?.();
    });
    return req;
  }
  get(key: string) {
    return this.request(() => this.data.get(key));
  }
  put(value: unknown, key: string) {
    return this.request(() => {
      this.data.set(key, value);
      const phase = (value as { phase?: string } | null)?.phase;
      if (phase != null) this.log?.push(`record:${phase}`);
    });
  }
  delete(key: string) {
    return this.request(() => {
      this.data.delete(key);
    });
  }
}

class FakeDatabase {
  stores = new Map<string, FakeObjectStore>();
  objectStoreNames = { contains: (name: string) => this.stores.has(name) };
  log: string[] | undefined;
  constructor(log?: string[]) {
    this.log = log;
  }
  createObjectStore(name: string) {
    const store = new FakeObjectStore(this.log);
    this.stores.set(name, store);
    return store;
  }
  transaction(name: string) {
    const store = this.stores.get(name);
    if (store == null) throw new Error(`no object store ${name}`);
    const transaction = {
      objectStore: () => store,
      abort: () => undefined,
      error: null as unknown,
      oncomplete: null as (() => void) | null,
      onabort: null as (() => void) | null,
      onerror: null as (() => void) | null,
    };
    queueMicrotask(() => queueMicrotask(() => transaction.oncomplete?.()));
    return transaction;
  }
  close() {}
}

class FakeMetaIdb {
  dbs = new Map<string, FakeDatabase>();
  log: string[] | undefined;
  constructor(log?: string[]) {
    this.log = log;
  }

  open(name: string, _version?: number) {
    const req: {
      result: FakeDatabase | undefined;
      error: unknown;
      transaction: null;
      onupgradeneeded: ((event: unknown) => void) | null;
      onsuccess: (() => void) | null;
      onerror: (() => void) | null;
    } = { result: undefined, error: null, transaction: null, onupgradeneeded: null, onsuccess: null, onerror: null };
    queueMicrotask(() => {
      let db = this.dbs.get(name);
      const isNew = db == null;
      if (db == null) {
        db = new FakeDatabase(this.log);
        this.dbs.set(name, db);
      }
      req.result = db;
      if (isNew) req.onupgradeneeded?.({ target: { result: db } });
      req.onsuccess?.();
    });
    return req;
  }

  deleteDatabase(name: string) {
    const req: { onsuccess: (() => void) | null; onerror: (() => void) | null; onblocked: (() => void) | null } = {
      onsuccess: null,
      onerror: null,
      onblocked: null,
    };
    queueMicrotask(() => {
      this.dbs.delete(name);
      req.onsuccess?.();
    });
    return req;
  }

  hasDb(name: string): boolean {
    return this.dbs.has(name);
  }

  seedMeta(storePath: string, phase: string): void {
    let db = this.dbs.get(META_DB);
    if (db == null) {
      db = new FakeDatabase(this.log);
      this.dbs.set(META_DB, db);
    }
    let store = db.stores.get(META_STORE);
    if (store == null) store = db.createObjectStore(META_STORE);
    store.data.set(storeIdentityComponent(storePath), { phase, updatedAt: 1 });
  }

  seedPgliteDb(storePath: string): void {
    const name = storeIndexedDbDatabaseName(storePath);
    if (!this.dbs.has(name)) this.dbs.set(name, new FakeDatabase(this.log));
  }
}

/** An IndexedDB whose `open` always fails (fires `onerror`) — drives StoreMetaUnreadableError (fail closed). */
class AlwaysFailingIdb {
  open(_name: string, _version?: number) {
    const req: {
      result: undefined;
      error: unknown;
      transaction: null;
      onupgradeneeded: null;
      onsuccess: (() => void) | null;
      onerror: (() => void) | null;
    } = { result: undefined, error: null, transaction: null, onupgradeneeded: null, onsuccess: null, onerror: null };
    queueMicrotask(() => {
      req.error = new Error("simulated open failure");
      req.onerror?.();
    });
    return req;
  }
}

// Build the injected deps for a browser classification. `meta.indexedDB` present selects the browser branch;
// `delay` is instant so the fail-closed retry budget does not slow the suite. `idbExists` reads the fake map
// so it tracks `deleteDatabase` (deletion → recordless fact flips false → re-classify to virgin).
function browserDeps(root: FakeDir, metaIdb: FakeMetaIdb) {
  return {
    meta: { indexedDB: metaIdb, delay: () => Promise.resolve() } as never,
    opfs: { getRoot: async () => root },
    idbExists: async (sp: string) => metaIdb.hasDb(storeIndexedDbDatabaseName(sp)),
  };
}

async function observe(root: FakeDir, storePath: string) {
  const { createOpfsEffects } = await import("../../packages/client/src/opfs-effects");
  return createOpfsEffects(storePath, { getRoot: async () => root }).observeCommitmentNamespace();
}

function metaPhase(metaIdb: FakeMetaIdb, storePath: string): string | undefined {
  const db = metaIdb.dbs.get(META_DB);
  const record = db?.stores.get(META_STORE)?.data.get(storeIdentityComponent(storePath)) as
    | { phase?: string }
    | undefined;
  return record?.phase;
}

// =========================================================================================================
// A. resolveStoreBoot — verdict execution
// =========================================================================================================

describe("resolveStoreBoot — passthrough backends", () => {
  it("memory override bypasses classification (no meta read)", async () => {
    const metaIdb = new FakeMetaIdb();
    const root = new FakeDir();
    const resolution = await resolveStoreBoot("mem-store", {
      hasOpfsSyncAccess: true,
      backendOverride: "memory",
      deps: browserDeps(root, metaIdb),
    });
    expect(resolution.dataDir).toBe("memory://mem-store");
    expect(resolution.storageBackend).toBe("memory");
    expect(resolution.verdict).toBeUndefined();
    // Classification never ran, so no meta database was opened.
    expect(metaIdb.dbs.has(META_DB)).toBe(false);
  });
});

describe("resolveStoreBoot — virgin creation", () => {
  it("virgin + opfs access → beginFreshCandidate (record BEFORE directory), opfs:// + opfs-repacked", async () => {
    const log: string[] = [];
    const metaIdb = new FakeMetaIdb(log);
    const root = new FakeDir(log);
    const resolution = await resolveStoreBoot("virgin-opfs", {
      hasOpfsSyncAccess: true,
      deps: browserDeps(root, metaIdb),
    });
    expect(resolution.dataDir).toBe("opfs://virgin-opfs");
    expect(resolution.storageBackend).toBe("opfs-repacked");
    expect(resolution.verdict?.action).toBe("virgin-create");
    expect(metaPhase(metaIdb, "virgin-opfs")).toBe("opfs-candidate");
    // Record-first authority: the opfs-candidate record write precedes the store-directory create.
    const identity = storeIdentityComponent("virgin-opfs");
    expect(log.indexOf("record:opfs-candidate")).toBeGreaterThanOrEqual(0);
    expect(log.indexOf("record:opfs-candidate")).toBeLessThan(log.indexOf(`mkdir:${identity}`));
    // The store directory now exists, uncommitted (no sentinel).
    expect(await observe(root, "virgin-opfs")).toEqual({ sentinelPresent: false, storeDirectoryPresent: true });
  });

  it("virgin WITHOUT opfs access → idb-authoritative record + idb://", async () => {
    const metaIdb = new FakeMetaIdb();
    const root = new FakeDir();
    const resolution = await resolveStoreBoot("virgin-idb", {
      hasOpfsSyncAccess: false,
      deps: browserDeps(root, metaIdb),
    });
    expect(resolution.dataDir).toBe("idb://virgin-idb");
    expect(resolution.storageBackend).toBe("idbfs");
    expect(resolution.verdict?.action).toBe("virgin-create");
    expect(metaPhase(metaIdb, "virgin-idb")).toBe("idb-authoritative");
  });
});

describe("resolveStoreBoot — recordless-idb recognition", () => {
  it("no record + existing idb store → boot-idb-authoritative, record written idb-authoritative + idb://", async () => {
    const metaIdb = new FakeMetaIdb();
    metaIdb.seedPgliteDb("recordless");
    const root = new FakeDir();
    const resolution = await resolveStoreBoot("recordless", {
      hasOpfsSyncAccess: false,
      deps: browserDeps(root, metaIdb),
    });
    expect(resolution.dataDir).toBe("idb://recordless");
    expect(resolution.storageBackend).toBe("idbfs");
    expect(resolution.verdict?.action).toBe("boot-idb-authoritative");
    expect(metaPhase(metaIdb, "recordless")).toBe("idb-authoritative");
  });
});

describe("resolveStoreBoot — committed / repair", () => {
  it("record opfs-committed → open-committed, opfs:// + opfs-repacked (no writes)", async () => {
    const metaIdb = new FakeMetaIdb();
    metaIdb.seedMeta("committed", "opfs-committed");
    const root = new FakeDir();
    await seedStoreDir(root, "committed");
    await seedSentinel(root, "committed");
    const resolution = await resolveStoreBoot("committed", {
      hasOpfsSyncAccess: true,
      deps: browserDeps(root, metaIdb),
    });
    expect(resolution.dataDir).toBe("opfs://committed");
    expect(resolution.storageBackend).toBe("opfs-repacked");
    expect(resolution.verdict?.action).toBe("open-committed");
    expect(metaPhase(metaIdb, "committed")).toBe("opfs-committed");
  });

  it("committed boot removes a lingering idb predecessor and the next boot stays clean", async () => {
    const storePath = "committed-with-predecessor";
    const metaIdb = new FakeMetaIdb();
    metaIdb.seedMeta(storePath, "opfs-committed");
    metaIdb.seedPgliteDb(storePath);
    const root = new FakeDir();
    await seedStoreDir(root, storePath);
    await seedSentinel(root, storePath);

    const first = await resolveStoreBoot(storePath, {
      hasOpfsSyncAccess: true,
      deps: browserDeps(root, metaIdb),
    });
    expect(first.verdict?.action).toBe("open-committed");
    expect(metaIdb.hasDb(storeIndexedDbDatabaseName(storePath))).toBe(false);

    const second = await resolveStoreBoot(storePath, {
      hasOpfsSyncAccess: true,
      deps: browserDeps(root, metaIdb),
    });
    expect(second.verdict?.action).toBe("open-committed");
    expect(second.storageBackend).toBe("opfs-repacked");
    expect(metaIdb.hasDb(storeIndexedDbDatabaseName(storePath))).toBe(false);
  });

  it("no record + sentinel present → repair-record-then-open-committed writes opfs-committed", async () => {
    const metaIdb = new FakeMetaIdb();
    const root = new FakeDir();
    await seedStoreDir(root, "repair");
    await seedSentinel(root, "repair");
    const resolution = await resolveStoreBoot("repair", {
      hasOpfsSyncAccess: true,
      deps: browserDeps(root, metaIdb),
    });
    expect(resolution.dataDir).toBe("opfs://repair");
    expect(resolution.storageBackend).toBe("opfs-repacked");
    expect(resolution.verdict?.action).toBe("repair-record-then-open-committed");
    expect(metaPhase(metaIdb, "repair")).toBe("opfs-committed");
  });
});

describe("resolveStoreBoot — candidate rebuild", () => {
  it("opfs-candidate + stale sentinel → deletes BOTH then re-creates the candidate", async () => {
    const metaIdb = new FakeMetaIdb();
    metaIdb.seedMeta("cand", "opfs-candidate");
    const root = new FakeDir();
    await seedStoreDir(root, "cand");
    await seedSentinel(root, "cand");
    // Sanity: both present before boot.
    expect(await observe(root, "cand")).toEqual({ sentinelPresent: true, storeDirectoryPresent: true });

    const resolution = await resolveStoreBoot("cand", {
      hasOpfsSyncAccess: true,
      deps: browserDeps(root, metaIdb),
    });
    expect(resolution.dataDir).toBe("opfs://cand");
    expect(resolution.storageBackend).toBe("opfs-repacked");
    expect(resolution.verdict?.action).toBe("delete-candidate-and-rebuild");
    // The stale sentinel is gone; a fresh candidate directory was rebuilt; the record is a fresh candidate.
    expect(await observe(root, "cand")).toEqual({ sentinelPresent: false, storeDirectoryPresent: true });
    expect(metaPhase(metaIdb, "cand")).toBe("opfs-candidate");
  });
});

describe("resolveStoreBoot — resume deletion then re-classify", () => {
  it("record deleting → completes deletion (opfs + idb) then re-classifies to virgin", async () => {
    const metaIdb = new FakeMetaIdb();
    metaIdb.seedMeta("del", "deleting");
    metaIdb.seedPgliteDb("del");
    const root = new FakeDir();
    await seedStoreDir(root, "del");
    await seedSentinel(root, "del");

    const resolution = await resolveStoreBoot("del", {
      hasOpfsSyncAccess: true,
      deps: browserDeps(root, metaIdb),
    });
    // Deletion ran to completion (sentinel + opfs dir + idb db all gone), the clean state re-classified as
    // virgin, and a fresh opfs candidate was stood up.
    expect(resolution.verdict?.action).toBe("virgin-create");
    expect(resolution.dataDir).toBe("opfs://del");
    expect(resolution.storageBackend).toBe("opfs-repacked");
    expect(metaIdb.hasDb(storeIndexedDbDatabaseName("del"))).toBe(false);
    expect(metaPhase(metaIdb, "del")).toBe("opfs-candidate");
    expect(await observe(root, "del")).toEqual({ sentinelPresent: false, storeDirectoryPresent: true });
  });
});

describe("recoverDeniedBootDeletion — denied-home authority handoff", () => {
  it("removes the old sentinel, publishes idb authority, and protects replacement journal data on a granted boot", async () => {
    const metaIdb = new FakeMetaIdb();
    metaIdb.seedMeta("denied-delete", "deleting");
    metaIdb.seedPgliteDb("denied-delete");
    const root = new FakeDir();
    await seedStoreDir(root, "denied-delete");
    await seedSentinel(root, "denied-delete");

    expect(await recoverDeniedBootDeletion("denied-delete", browserDeps(root, metaIdb))).toBe(true);
    expect(metaPhase(metaIdb, "denied-delete")).toBe("idb-authoritative");
    expect(metaIdb.hasDb(storeIndexedDbDatabaseName("denied-delete"))).toBe(false);
    expect(await observe(root, "denied-delete")).toEqual({
      sentinelPresent: false,
      storeDirectoryPresent: true,
    });

    // The replacement IDB now contains locally owed work. A later granted boot must follow the record instead
    // of treating the old sentinel-less OPFS directory as a candidate and abandoning this store.
    metaIdb.seedPgliteDb("denied-delete");
    const granted = await resolveStoreBoot("denied-delete", {
      hasOpfsSyncAccess: true,
      deps: browserDeps(root, metaIdb),
    });
    expect(granted.verdict?.action).toBe("boot-idb-authoritative");
    expect(granted.storageBackend).toBe("idbfs");
    expect(metaIdb.hasDb(storeIndexedDbDatabaseName("denied-delete"))).toBe(true);
  });

  it("keeps deleting authority when sentinel removal cannot be confirmed", async () => {
    const metaIdb = new FakeMetaIdb();
    metaIdb.seedMeta("unobservable-delete", "deleting");
    metaIdb.seedPgliteDb("unobservable-delete");
    // oxlint-disable-next-line typescript/await-thenable -- bun-types gap: .rejects returns a promise typed as void
    await expect(
      recoverDeniedBootDeletion("unobservable-delete", {
        ...browserDeps(new FakeDir(), metaIdb),
        opfs: { getRoot: async () => Promise.reject(new Error("OPFS unavailable")) },
      }),
    ).rejects.toThrow("sentinel removal cannot be confirmed");
    expect(metaPhase(metaIdb, "unobservable-delete")).toBe("deleting");
    expect(metaIdb.hasDb(storeIndexedDbDatabaseName("unobservable-delete"))).toBe(true);
  });
});

describe("resolveStoreBoot — adoption recovery", () => {
  it("adopting + sentinel present → complete-adoption (opfs-committed + delete idb predecessor)", async () => {
    const metaIdb = new FakeMetaIdb();
    metaIdb.seedMeta("adopt-done", "adopting");
    metaIdb.seedPgliteDb("adopt-done");
    const root = new FakeDir();
    await seedStoreDir(root, "adopt-done");
    await seedSentinel(root, "adopt-done");

    const resolution = await resolveStoreBoot("adopt-done", {
      hasOpfsSyncAccess: true,
      deps: browserDeps(root, metaIdb),
    });
    expect(resolution.verdict?.action).toBe("adoption-recovery");
    expect(resolution.dataDir).toBe("opfs://adopt-done");
    expect(resolution.storageBackend).toBe("opfs-repacked");
    expect(metaPhase(metaIdb, "adopt-done")).toBe("opfs-committed");
    // The idb predecessor is deleted only after commitment.
    expect(metaIdb.hasDb(storeIndexedDbDatabaseName("adopt-done"))).toBe(false);
  });

  it("adopting + NO sentinel → teardown-and-restart (idb-authoritative + idb://)", async () => {
    const metaIdb = new FakeMetaIdb();
    metaIdb.seedMeta("adopt-restart", "adopting");
    const root = new FakeDir();
    await seedStoreDir(root, "adopt-restart");

    const resolution = await resolveStoreBoot("adopt-restart", {
      hasOpfsSyncAccess: true,
      deps: browserDeps(root, metaIdb),
    });
    expect(resolution.verdict?.action).toBe("adoption-recovery");
    expect(resolution.dataDir).toBe("idb://adopt-restart");
    expect(resolution.storageBackend).toBe("idbfs");
    expect(metaPhase(metaIdb, "adopt-restart")).toBe("idb-authoritative");
    // The torn-down candidate directory is gone.
    expect(await observe(root, "adopt-restart")).toEqual({ sentinelPresent: false, storeDirectoryPresent: false });
  });
});

describe("resolveStoreBoot — fail closed", () => {
  it("StoreMetaUnreadableError propagates (a failed meta read is never 'no record')", async () => {
    const root = new FakeDir();
    // oxlint-disable-next-line typescript/await-thenable -- bun-types gap: .rejects matchers return a real promise typed as void
    await expect(
      resolveStoreBoot("unreadable", {
        hasOpfsSyncAccess: true,
        deps: {
          meta: { indexedDB: new AlwaysFailingIdb(), delay: () => Promise.resolve() } as never,
          opfs: { getRoot: async () => root },
          idbExists: async () => false,
        },
      }),
    ).rejects.toThrow(StoreMetaUnreadableError);
  });
});

// =========================================================================================================
// B. createClientPGlite — the opfs:// branch routes to the injected opfs-repacked factory
// =========================================================================================================

interface CapturedFactoryOptions {
  directory: unknown;
  durability: "relaxed" | "strict";
  extentSize?: number;
}

describe("createClientPGlite — opfs:// factory routing", () => {
  it("routes opfs:// to the factory with durability relaxed (default) + extentSize 65536 + the directory handle", async () => {
    const captured: CapturedFactoryOptions[] = [];
    const directoryHandle = { opfsDir: true };
    await createClientPGlite("opfs-default", {
      hasOpfsSyncAccess: true,
      pgliteFactories: {
        createOpfsRepacked: async (options: CapturedFactoryOptions) => {
          captured.push(options);
          return { engineless: true } as never;
        },
        getStoreDirectoryHandle: async () => directoryHandle,
        retryDelayMs: 0,
      },
    } as never);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.durability).toBe("relaxed");
    expect(captured[0]!.extentSize).toBe(65536);
    expect(captured[0]!.directory).toBe(directoryHandle);
  });

  it('maps durability:"strict" → factory durability "strict"', async () => {
    const captured: CapturedFactoryOptions[] = [];
    await createClientPGlite("opfs-strict", {
      hasOpfsSyncAccess: true,
      durability: "strict",
      pgliteFactories: {
        createOpfsRepacked: async (options: CapturedFactoryOptions) => {
          captured.push(options);
          return { engineless: true } as never;
        },
        getStoreDirectoryHandle: async () => ({}),
        retryDelayMs: 0,
      },
    } as never);
    expect(captured[0]!.durability).toBe("strict");
  });

  it("retries a transient factory failure (twice then success) with bounded backoff", async () => {
    let calls = 0;
    const result = await createClientPGlite("opfs-retry", {
      hasOpfsSyncAccess: true,
      pgliteFactories: {
        createOpfsRepacked: async () => {
          calls += 1;
          if (calls <= 2) throw new Error("UnknownError: transient VFS open failure");
          return { engineless: true } as never;
        },
        getStoreDirectoryHandle: async () => ({}),
        retryDelayMs: 0,
      },
    } as never);
    expect(calls).toBe(3);
    expect(result).toBeDefined();
  });

  it("does NOT enter the opfs branch without opfs access (idb/file/memory path unchanged)", async () => {
    // Guard: a throwing factory is injected but never reached, because no `hasOpfsSyncAccess` means the store
    // resolves to the memory backend (this test lane) — the byte-identical baseline.
    const guard = await createClientPGlite(memoryStoreForTests("guard-no-opfs"), {
      pgliteFactories: {
        createOpfsRepacked: async () => {
          throw new Error("opfs factory must not be reached");
        },
        getStoreDirectoryHandle: async () => {
          throw new Error("opfs directory must not be reached");
        },
        retryDelayMs: 0,
      },
    } as never);
    expect(guard).toBeDefined();
    await (guard as unknown as { close: () => Promise<void> }).close();
  });
});
