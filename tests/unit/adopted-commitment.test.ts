import { afterEach, describe, expect, it } from "bun:test";
// The ADOPTED-boot commitment barrier. An adopting boot (`precreatedPglite` / `pgliteInstance` — the
// provision→adopt accelerator, ADR-0032 decision 5) skips `openOwnedStore` entirely, so the pre-mint phase
// machine (`resolveFreshBoot`) never runs and nothing flags the commitment barrier. Left alone, every
// spare-adopted OPFS store stays UNCOMMITTED for life — no sentinel, a record still at `opfs-candidate` (or
// absent) — which the NEXT client-owned boot classifies as a torn candidate (`delete-candidate-and-rebuild`)
// and DESTROYS. So an adopted opfs boot owes the SAME barrier a fresh one does, pre-expose (invariant 3).
//
// Bun has no browser IndexedDB / OPFS, so both surfaces are faked on `globalThis` (the boot's gate and barrier
// read the real defaults) exactly as worker-provision-offline.test.ts does; the adopted store is a real memory
// PGlite branded as opfs-repacked, with a recording `strictSync()`.

import { PGlite } from "@electric-sql/pglite";
import { dataDir as prepopulatedDataDir } from "@electric-sql/pglite-prepopulatedfs";
import { live } from "@electric-sql/pglite/live";
import { pgTable, text, uuid } from "drizzle-orm/pg-core";

import type { SyncTableRegistry } from "@pgxsinkit/contracts";

import {
  type ClientPGlite,
  CommittedStoreUnreachableError,
  createClientPGlite,
  createSyncClient,
  type FreshCommitmentSeams,
  resolveAdoptedCommitmentBarrier,
  type SyncClient,
} from "../../packages/client/src/index";
import {
  opfsCommitmentSentinelPath,
  storeIdentityComponent,
  storeIndexedDbDatabaseName,
} from "../../packages/client/src/store-path";
import { testStoreAcknowledgment } from "../../packages/client/src/testing";

// ---------------------------------------------------------------------------------------------------------
// Fake OPFS + meta IndexedDB — the shape fresh-commitment.test.ts fakes, with a shared ORDER log so the
// barrier's strictSync → sentinel-file → opfs-committed-record sequence can be asserted, plus an `opens`
// counter so "no meta interaction at all" is provable on the unbranded path.
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
      this.log?.push(`file:${name}`);
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
      error: null as unknown,
      oncomplete: null as (() => void) | null,
      onabort: null as (() => void) | null,
      onerror: null as (() => void) | null,
      objectStore: () => store,
      abort: () => transaction.onabort?.(),
    };
    queueMicrotask(() => queueMicrotask(() => transaction.oncomplete?.()));
    return transaction;
  }
  close() {}
}

class FakeMetaIdb {
  dbs = new Map<string, FakeDatabase>();
  log: string[] | undefined;
  /** How many times ANY database was opened — the proof that a path touched (or never touched) the meta store. */
  opens = 0;
  constructor(log?: string[]) {
    this.log = log;
  }

  open(name: string, _version?: number) {
    this.opens += 1;
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

  /** Was a database of this name ever opened/created? Proves an idb DATA store was (not) minted at a path. */
  hasDb(name: string): boolean {
    return this.dbs.has(name);
  }
}

function metaPhase(metaIdb: FakeMetaIdb, storePath: string): string | undefined {
  const record = metaIdb.dbs.get(META_DB)?.stores.get(META_STORE)?.data.get(storeIdentityComponent(storePath)) as
    | { phase?: string }
    | undefined;
  return record?.phase;
}

function sentinelPresent(root: FakeDir, storePath: string): boolean {
  const path = opfsCommitmentSentinelPath(storePath);
  let dir: FakeDir | undefined = root;
  for (const segment of path.slice(0, -1)) dir = dir?.dirs.get(segment);
  return dir?.files.has(path.at(-1)!) === true;
}

// ---------------------------------------------------------------------------------------------------------
// Globals + the adopted instance
// ---------------------------------------------------------------------------------------------------------

const savedNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
const savedIndexedDb = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");

function installBrowserGlobals(root: FakeDir, metaIdb: FakeMetaIdb): void {
  Object.defineProperty(globalThis, "indexedDB", { value: metaIdb, configurable: true, writable: true });
  Object.defineProperty(globalThis, "navigator", {
    value: { storage: { getDirectory: async () => root } },
    configurable: true,
    writable: true,
  });
}

const OPFS_REPACKED_PERSISTENT = Symbol.for("pgxsinkit.opfsRepackedPersistent");

const openInstances: ClientPGlite[] = [];

/**
 * A real (memory) PGlite standing in for a provisioned store. `branded` stamps the opfs-repacked brand the
 * gate keys on — the only proof an adopted instance carries — and installs a recording `strictSync()` the
 * commitment barrier drives.
 */
async function makeAdoptedPglite(options: {
  branded: boolean;
  log?: string[];
  strictSyncFails?: boolean;
}): Promise<ClientPGlite> {
  const pg = (await PGlite.create({
    loadDataDir: await prepopulatedDataDir(),
    extensions: { live },
  })) as unknown as ClientPGlite;
  openInstances.push(pg);
  Object.defineProperty(pg, "strictSync", {
    value: async () => {
      options.log?.push("strictSync");
      if (options.strictSyncFails) throw new Error("strict-sync-failure");
    },
    configurable: true,
  });
  if (options.branded) {
    Object.defineProperty(pg, OPFS_REPACKED_PERSISTENT, { value: true, enumerable: false, configurable: true });
  }
  return pg;
}

const profileTable = pgTable("profile", { id: uuid("id").primaryKey(), name: text("name") });

function bootRegistry(): SyncTableRegistry {
  return {
    profile: {
      table: profileTable,
      mode: "readonly",
      primaryKey: { columns: ["id"] },
      shape: { tableName: "profile", shapeKey: "schema.profile" },
      clientProjection: { syncedTable: "profile" },
    },
  } as unknown as SyncTableRegistry;
}

/** Boot `createSyncClient` over an ADOPTED instance, exactly as the worker's provision-adopt path does. */
function bootAdopting(storePath: string, instance: ClientPGlite): Promise<SyncClient<SyncTableRegistry>> {
  return createSyncClient({
    registry: bootRegistry(),
    electricUrl: "http://127.0.0.1:1/v1/electric-proxy",
    batchWriteUrl: "http://127.0.0.1:1/api/mutations",
    syncEnabled: false,
    storePath,
    // The adopted instance is a memory store (test only) — acknowledge it past the BYO refusal (ADR-0036)
    // WITHOUT selecting the memory backend, so the boot keeps the persistent lane's gate.
    ...testStoreAcknowledgment(),
    precreatedPglite: Promise.resolve(instance),
  });
}

let client: SyncClient<SyncTableRegistry> | undefined;

afterEach(async () => {
  await client?.stop().catch(() => undefined);
  client = undefined;
  for (const instance of openInstances) await instance.close().catch(() => undefined);
  openInstances.length = 0;
  if (savedIndexedDb === undefined) delete (globalThis as { indexedDB?: unknown }).indexedDB;
  else Object.defineProperty(globalThis, "indexedDB", savedIndexedDb);
  if (savedNavigator === undefined) delete (globalThis as { navigator?: unknown }).navigator;
  else Object.defineProperty(globalThis, "navigator", savedNavigator);
});

// =========================================================================================================
// A. The boot seam — an adopted opfs store is COMMITTED before it is exposed
// =========================================================================================================

describe("adopted boot commitment barrier — createSyncClient's adopt paths (invariant 3)", () => {
  it("record `opfs-candidate` (the provision mint's state) → the barrier runs BEFORE the client is exposed", async () => {
    const storePath = "adopt-candidate";
    const log: string[] = [];
    const metaIdb = new FakeMetaIdb(log);
    const root = new FakeDir(log);
    metaIdb.seedMeta(storePath, "opfs-candidate");
    installBrowserGlobals(root, metaIdb);

    client = await bootAdopting(storePath, await makeAdoptedPglite({ branded: true, log }));
    log.push("expose");

    const identity = storeIdentityComponent(storePath);
    const iStrict = log.indexOf("strictSync");
    const iSentinel = log.indexOf(`file:${identity}`);
    const iCommitted = log.indexOf("record:opfs-committed");
    const iExpose = log.indexOf("expose");
    // Data before authority, and all of it before exposure: strictSync → sentinel → committed phase → expose.
    expect(iStrict).toBeGreaterThanOrEqual(0);
    expect(iStrict).toBeLessThan(iSentinel);
    expect(iSentinel).toBeLessThan(iCommitted);
    expect(iCommitted).toBeLessThan(iExpose);
    expect(sentinelPresent(root, storePath)).toBe(true);
    expect(metaPhase(metaIdb, storePath)).toBe("opfs-committed");
  });

  it("RECORDLESS store → the barrier runs and CREATES the record (write is create-or-update)", async () => {
    const storePath = "adopt-recordless";
    const log: string[] = [];
    const metaIdb = new FakeMetaIdb(log);
    const root = new FakeDir(log);
    installBrowserGlobals(root, metaIdb);

    client = await bootAdopting(storePath, await makeAdoptedPglite({ branded: true, log }));

    expect(log).toContain("strictSync");
    expect(sentinelPresent(root, storePath)).toBe(true);
    expect(metaPhase(metaIdb, storePath)).toBe("opfs-committed");
  });

  it("record already `opfs-committed` (the warm reopen) → the barrier does NOT re-run", async () => {
    const storePath = "adopt-committed";
    const log: string[] = [];
    const metaIdb = new FakeMetaIdb(log);
    const root = new FakeDir(log);
    metaIdb.seedMeta(storePath, "opfs-committed");
    installBrowserGlobals(root, metaIdb);

    client = await bootAdopting(storePath, await makeAdoptedPglite({ branded: true, log }));

    // No strictSync, no sentinel publish, no record write — a committed store owes nothing.
    expect(log).not.toContain("strictSync");
    expect(sentinelPresent(root, storePath)).toBe(false);
    expect(log.filter((entry) => entry.startsWith("record:"))).toEqual([]);
    expect(metaPhase(metaIdb, storePath)).toBe("opfs-committed");
  });

  it("UNBRANDED (plain idb/BYO) instance → no barrier and NO meta interaction at all", async () => {
    const storePath = "adopt-unbranded";
    const log: string[] = [];
    const metaIdb = new FakeMetaIdb(log);
    const root = new FakeDir(log);
    installBrowserGlobals(root, metaIdb);

    client = await bootAdopting(storePath, await makeAdoptedPglite({ branded: false, log }));

    // An idb/file BYO instance has no opfs commitment machinery: the gate never even reads the meta store.
    expect(metaIdb.opens).toBe(0);
    expect(log).not.toContain("strictSync");
    expect(sentinelPresent(root, storePath)).toBe(false);
  });

  it("barrier failure (strictSync throws) → the boot REJECTS, nothing is published, the candidate record survives", async () => {
    const storePath = "adopt-barrier-fails";
    const log: string[] = [];
    const metaIdb = new FakeMetaIdb(log);
    const root = new FakeDir(log);
    metaIdb.seedMeta(storePath, "opfs-candidate");
    installBrowserGlobals(root, metaIdb);

    const rejection = await bootAdopting(
      storePath,
      await makeAdoptedPglite({ branded: true, log, strictSyncFails: true }),
    ).then(
      () => null,
      (error: unknown) => error,
    );

    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toContain("strict-sync-failure");
    // The barrier is all-or-nothing: no sentinel, the record stays `opfs-candidate`, and no client was exposed
    // (the next boot's classifier tears the candidate down and rebuilds).
    expect(sentinelPresent(root, storePath)).toBe(false);
    expect(metaPhase(metaIdb, storePath)).toBe("opfs-candidate");
  });
});

// =========================================================================================================
// B. The gate itself — which phases an adopted boot may commit
// =========================================================================================================

function seams(metaIdb: FakeMetaIdb): FreshCommitmentSeams {
  return { meta: { indexedDB: metaIdb, delay: () => Promise.resolve() } as never, log: () => undefined };
}

describe("resolveAdoptedCommitmentBarrier — only the ownable states owe the barrier", () => {
  it("owes the barrier when recordless or `opfs-candidate`", async () => {
    const metaIdb = new FakeMetaIdb();
    expect(await resolveAdoptedCommitmentBarrier("gate-recordless", seams(metaIdb))).toBe(true);
    metaIdb.seedMeta("gate-candidate", "opfs-candidate");
    expect(await resolveAdoptedCommitmentBarrier("gate-candidate", seams(metaIdb))).toBe(true);
  });

  it("owes nothing on `opfs-committed`, nor on a phase another authority owns", async () => {
    const metaIdb = new FakeMetaIdb();
    for (const phase of ["opfs-committed", "deleting", "idb-authoritative"]) {
      metaIdb.seedMeta(`gate-${phase}`, phase);
      expect(await resolveAdoptedCommitmentBarrier(`gate-${phase}`, seams(metaIdb))).toBe(false);
    }
  });

  it("declines when the meta store is entirely absent (nowhere to record commitment)", async () => {
    // An explicit `undefined` indexedDB selects store-meta's no-IDB path → META_STORE_UNAVAILABLE.
    expect(await resolveAdoptedCommitmentBarrier("gate-no-meta", { meta: { indexedDB: undefined } })).toBe(false);
  });

  it("PROPAGATES an unreadable record — a failed meta read is an error, never `no record` (invariant 12)", async () => {
    const metaIdb = new FakeMetaIdb();
    metaIdb.seedMeta("gate-corrupt", "opfs-candidate");
    metaIdb.dbs.get(META_DB)!.stores.get(META_STORE)!.data.set(storeIdentityComponent("gate-corrupt"), {
      phase: "nonsense",
      updatedAt: 1,
    });
    const failure = await resolveAdoptedCommitmentBarrier("gate-corrupt", seams(metaIdb)).then(
      () => null,
      (error: unknown) => error,
    );
    expect((failure as Error | null)?.name).toBe("StoreMetaUnreadableError");
  });
});

// =========================================================================================================
// C. The NO-GRANT boot over an OPFS-COMMITTED store — typed refusal, end to end
//
// A client-owned boot with no OPFS sync-access grant (a tab realm, the in-process fallback) is record-blind
// apart from deletion authority: left alone it opens `idb://<path>` directly, which over a store whose record
// says `opfs-committed` MINTS AN EMPTY SIBLING at the same path — the app looks wiped and offline writes fork
// into a store no worker-mode boot ever opens. Both client-owned mint seams (`createSyncClient`'s own open and
// the eager `createClientPGlite`) must fail closed instead. Proven end to end here, against real boots.
// =========================================================================================================

/** Boot `createSyncClient` CLIENT-OWNED (no adopted instance) — the in-process fallback's own mint path. */
function bootOwned(storePath: string): Promise<SyncClient<SyncTableRegistry>> {
  return createSyncClient({
    registry: bootRegistry(),
    electricUrl: "http://127.0.0.1:1/v1/electric-proxy",
    batchWriteUrl: "http://127.0.0.1:1/api/mutations",
    syncEnabled: false,
    storePath,
  });
}

describe("no-grant boot over an opfs-committed store — typed refusal, never an empty idb sibling", () => {
  it("client-owned `createSyncClient` boot → REJECTS typed; the idb data store is never created", async () => {
    const storePath = "no-grant-owned-committed";
    const log: string[] = [];
    const metaIdb = new FakeMetaIdb(log);
    const root = new FakeDir(log);
    metaIdb.seedMeta(storePath, "opfs-committed");
    installBrowserGlobals(root, metaIdb);

    const refusal = await bootOwned(storePath).then(
      (booted) => {
        client = booted;
        return null;
      },
      (error: unknown) => error,
    );

    // The CLASS, not just the name: a consumer branches on `instanceof` to offer the destroy-then-rebuild exit.
    expect(refusal).toBeInstanceOf(CommittedStoreUnreachableError);
    expect((refusal as CommittedStoreUnreachableError).storePath).toBe(storePath);
    // The remedy must name a CALLABLE api — the caller's boot just failed, so they hold no client to `destroy()`.
    expect((refusal as Error).message).toContain(`destroyStoreArtifacts(${JSON.stringify(storePath)})`);
    // No sibling was minted (PGlite's `/pglite/<path>` database was never opened) and the record is untouched.
    expect(metaIdb.hasDb(storeIndexedDbDatabaseName(storePath))).toBe(false);
    expect(metaPhase(metaIdb, storePath)).toBe("opfs-committed");
    expect(log.filter((entry) => entry.startsWith("record:"))).toEqual([]);
  });

  it("eager `createClientPGlite` → REJECTS typed, and as a `precreatedPglite` the boot surfaces THAT refusal", async () => {
    const storePath = "no-grant-precreate-committed";
    const metaIdb = new FakeMetaIdb();
    const root = new FakeDir();
    metaIdb.seedMeta(storePath, "opfs-committed");
    installBrowserGlobals(root, metaIdb);

    // The eager precreate is itself a store mint, so it carries the same gate.
    const eager = createClientPGlite(storePath);
    const eagerRefusal = await eager.then(
      (instance) => {
        openInstances.push(instance);
        return null;
      },
      (error: unknown) => error,
    );
    expect(eagerRefusal).toBeInstanceOf(CommittedStoreUnreachableError);

    // Handed to the boot, the reject-fallback re-enters `openOwnedStore` — which hits the same gate. The
    // accelerator's failure must NOT be swallowed into a silent empty-sibling boot: ONE typed refusal surfaces.
    const bootRefusal = await createSyncClient({
      registry: bootRegistry(),
      electricUrl: "http://127.0.0.1:1/v1/electric-proxy",
      batchWriteUrl: "http://127.0.0.1:1/api/mutations",
      syncEnabled: false,
      storePath,
      precreatedPglite: eager,
    }).then(
      (booted) => {
        client = booted;
        return null;
      },
      (error: unknown) => error,
    );

    expect(bootRefusal).toBeInstanceOf(CommittedStoreUnreachableError);
    expect(metaIdb.hasDb(storeIndexedDbDatabaseName(storePath))).toBe(false);
    expect(metaPhase(metaIdb, storePath)).toBe("opfs-committed");
  });
});
