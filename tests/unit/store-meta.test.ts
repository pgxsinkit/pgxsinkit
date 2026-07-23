import { describe, expect, it } from "bun:test";
// ADR-0049 (capability-driven engine placement) step 2: the STORE META RECORD phase machine and boot
// classification. This slice's unit test covers three separated concerns of `store-meta.ts`:
//   A. the PURE boot classifier (`classifyStoreBoot`) over the full phase/observation truth table — the
//      plan's boot classification 1–7 and its precedence rules (invariant 12);
//   B. the meta-record IndexedDB IO with the failed-read policy (bounded retry → fail closed, invariant 12);
//   C. the NON-CREATING idb existence check (`idbStoreExists`, invariant 14 / recordless-idb recognition).
// bun has no browser IDB, so every IO path is exercised against injected structural fakes.

import {
  classifyStoreBoot,
  deleteStoreMetaRecord,
  idbStoreExists,
  META_READ_ATTEMPTS,
  META_STORE_UNAVAILABLE,
  readStoreMetaRecord,
  STORE_META_DATABASE,
  StoreMetaUnreadableError,
  type StoreBootObservations,
  type StoreBootVerdict,
  type StoreMetaDeps,
  type StoreMetaPhase,
  type StoreMetaRecord,
  writeStoreMetaRecord,
} from "../../packages/client/src/store-meta";

// The store-meta IO surface is internal plumbing typed structurally off `globalThis`; the fakes below satisfy
// the shape store-meta actually touches, cast through this helper at the injection boundary (a browser IDB is
// not available under Bun). Localising the cast keeps every call site readable.
function metaDeps(indexedDB: unknown, delay?: (ms: number) => Promise<void>): StoreMetaDeps {
  return { indexedDB, delay } as unknown as StoreMetaDeps;
}

// The meta record is keyed by the same identity encoding store-path.ts owns; tests seed under that key.
function storeIdentityKey(storePath: string): string {
  return encodeURIComponent(storePath);
}

// ---------------------------------------------------------------------------------------------------------
// Fakes for the meta-record IO (part B). A tiny in-memory IndexedDB implementing only the surface store-meta
// touches — `open` (with an `upgradeneeded` object-store-creation hop), a `transaction` → `objectStore` →
// `get`/`put`/`delete` chain, and `close`. Every request fires its handlers on the next microtask, exactly as
// a real IDBRequest resolves asynchronously.
// ---------------------------------------------------------------------------------------------------------

class FakeObjectStore {
  data = new Map<string, unknown>();
  private readonly failWrites: boolean;
  constructor(failWrites = false) {
    this.failWrites = failWrites;
  }

  private request(op: () => unknown) {
    const req: {
      result: unknown;
      error: unknown;
      onsuccess: (() => void) | null;
      onerror: (() => void) | null;
    } = { result: undefined, error: null, onsuccess: null, onerror: null };
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
    if (this.failWrites) {
      const req = {
        result: undefined,
        error: new Error("meta put failed"),
        onsuccess: null as (() => void) | null,
        onerror: null as (() => void) | null,
      };
      queueMicrotask(() => req.onerror?.());
      return req;
    }
    return this.request(() => {
      this.data.set(key, value);
    });
  }

  delete(key: string) {
    return this.request(() => {
      this.data.delete(key);
    });
  }
}

class FakeTransaction {
  store: FakeObjectStore;
  error: unknown = null;
  oncomplete: (() => void) | null = null;
  onabort: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(store: FakeObjectStore) {
    this.store = store;
  }
  objectStore() {
    return this.store;
  }
  abort() {}
}

class FakeDatabase {
  stores = new Map<string, FakeObjectStore>();
  closed = false;
  abortWrites: boolean;
  failWrites: boolean;
  transactionOptions: Array<{ durability?: "default" | "relaxed" | "strict" } | undefined> = [];
  constructor(abortWrites = false, failWrites = false) {
    this.abortWrites = abortWrites;
    this.failWrites = failWrites;
  }
  objectStoreNames = { contains: (name: string) => this.stores.has(name) };
  createObjectStore(name: string) {
    const store = new FakeObjectStore(this.failWrites);
    this.stores.set(name, store);
    return store;
  }
  transaction(
    name: string,
    mode: "readonly" | "readwrite" = "readonly",
    options?: { durability?: "default" | "relaxed" | "strict" },
  ) {
    const store = this.stores.get(name);
    if (store == null) throw new Error(`no object store ${name}`);
    this.transactionOptions.push(options);
    const transaction = new FakeTransaction(store);
    queueMicrotask(() => {
      queueMicrotask(() => {
        if (this.abortWrites && mode === "readwrite") {
          transaction.error = new Error("quota abort after request success");
          transaction.onabort?.();
        } else {
          transaction.oncomplete?.();
        }
      });
    });
    return transaction;
  }
  close() {
    this.closed = true;
  }
}

class FakeIndexedDb {
  dbs = new Map<string, FakeDatabase>();
  abortWrites: boolean;
  failWrites: boolean;
  constructor(abortWrites = false, failWrites = false) {
    this.abortWrites = abortWrites;
    this.failWrites = failWrites;
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
        db = new FakeDatabase(this.abortWrites, this.failWrites);
        this.dbs.set(name, db);
      }
      req.result = db;
      if (isNew) req.onupgradeneeded?.({ target: { result: db } });
      req.onsuccess?.();
    });
    return req;
  }

  /** Directly seed a stored value (bypassing `writeStoreMetaRecord`) so malformed shapes can be tested. */
  seed(dbName: string, storeName: string, key: string, value: unknown) {
    let db = this.dbs.get(dbName);
    if (db == null) {
      db = new FakeDatabase();
      this.dbs.set(dbName, db);
    }
    let store = db.stores.get(storeName);
    if (store == null) store = db.createObjectStore(storeName);
    store.data.set(key, value);
  }
}

/** An IndexedDB whose first `failCount` `open` calls fail (fire `onerror`); later opens delegate to `inner`. */
class FlakyIndexedDb {
  attempts = 0;
  inner: FakeIndexedDb;
  failCount: number;
  constructor(inner: FakeIndexedDb, failCount: number) {
    this.inner = inner;
    this.failCount = failCount;
  }

  open(name: string, version?: number) {
    this.attempts += 1;
    if (this.attempts <= this.failCount) {
      const req: {
        result: undefined;
        error: unknown;
        transaction: null;
        onupgradeneeded: ((event: unknown) => void) | null;
        onsuccess: (() => void) | null;
        onerror: (() => void) | null;
      } = { result: undefined, error: null, transaction: null, onupgradeneeded: null, onsuccess: null, onerror: null };
      queueMicrotask(() => {
        req.error = new Error("simulated open failure");
        req.onerror?.();
      });
      return req;
    }
    return this.inner.open(name, version);
  }
}

// A fake dedicated to `idbStoreExists`: models the `upgradeneeded`→abort→`onerror` (non-exist) and the
// `onsuccess` (exist) protocols, recording whether `abort()` and `close()` were called.
class FakeExistsIndexedDb {
  aborted = false;
  closed = false;
  exists: boolean;
  constructor(exists: boolean) {
    this.exists = exists;
  }

  open(_name: string, _version?: number) {
    const tx = {
      abort: () => {
        this.aborted = true;
      },
    };
    const db = {
      close: () => {
        this.closed = true;
      },
    };
    const req: {
      result: unknown;
      error: unknown;
      transaction: unknown;
      onupgradeneeded: ((event: unknown) => void) | null;
      onsuccess: (() => void) | null;
      onerror: (() => void) | null;
    } = { result: db, error: null, transaction: tx, onupgradeneeded: null, onsuccess: null, onerror: null };
    queueMicrotask(() => {
      if (this.exists) {
        req.onsuccess?.();
      } else {
        // Database did NOT exist: `upgradeneeded` fires, the handler aborts the versionchange transaction so
        // nothing persists, and the open then completes via `onerror` (the AbortError).
        req.onupgradeneeded?.({ target: { transaction: tx } });
        req.error = new Error("AbortError");
        req.onerror?.();
      }
    });
    return req;
  }
}

// ---------------------------------------------------------------------------------------------------------
// A. Pure boot classifier
// ---------------------------------------------------------------------------------------------------------

const ALL_PHASES: readonly StoreMetaPhase[] = [
  "idb-authoritative",
  "opfs-candidate",
  "adopting",
  "opfs-committed",
  "deleting",
];

function obs(over: Partial<StoreBootObservations> = {}): StoreBootObservations {
  return {
    record: undefined,
    opfs: "unobservable",
    idbStoreExists: false,
    ...over,
  };
}

function record(phase: StoreMetaPhase): StoreMetaRecord {
  return { phase, updatedAt: 1 };
}

describe("classifyStoreBoot — phase precedence (classification 1–5)", () => {
  const expectations: ReadonlyArray<[StoreMetaPhase, StoreBootVerdict["action"]]> = [
    ["deleting", "resume-deletion"],
    ["adopting", "adoption-recovery"],
    ["opfs-committed", "open-committed"],
    ["opfs-candidate", "delete-candidate-and-rebuild"],
    ["idb-authoritative", "boot-idb-authoritative"],
  ];

  for (const [phase, action] of expectations) {
    it(`phase ${phase} → ${action}, regardless of opfs/idb observations`, () => {
      // A present phase is authoritative: opfs and idb observations must not change the verdict.
      for (const opfs of [
        "unobservable" as const,
        { sentinelPresent: true, storeDirectoryPresent: true },
        { sentinelPresent: false, storeDirectoryPresent: false },
      ]) {
        for (const idbStoreExists of [true, false]) {
          expect(classifyStoreBoot(obs({ record: record(phase), opfs, idbStoreExists })).action).toBe(action);
        }
      }
    });
  }

  it("every phase maps to some verdict (exhaustive — no phase left unclassified)", () => {
    for (const phase of ALL_PHASES) {
      expect(classifyStoreBoot(obs({ record: record(phase) })).action).toBeDefined();
    }
  });

  it("deleting beats a committed-looking OPFS (precedence over EVERYTHING)", () => {
    expect(
      classifyStoreBoot(
        obs({ record: record("deleting"), opfs: { sentinelPresent: true, storeDirectoryPresent: true } }),
      ).action,
    ).toBe("resume-deletion");
  });

  it("adopting beats a recordless idb store (precedence over ordinary idb boot)", () => {
    expect(classifyStoreBoot(obs({ record: record("adopting"), idbStoreExists: true })).action).toBe(
      "adoption-recovery",
    );
  });
});

describe("classifyStoreBoot — recordless, OPFS observable (classification 6)", () => {
  it("sentinel present → repair record then open committed (sentinel authority)", () => {
    expect(classifyStoreBoot(obs({ opfs: { sentinelPresent: true, storeDirectoryPresent: true } })).action).toBe(
      "repair-record-then-open-committed",
    );
    // even with no directory observed, a sentinel is authority
    expect(classifyStoreBoot(obs({ opfs: { sentinelPresent: true, storeDirectoryPresent: false } })).action).toBe(
      "repair-record-then-open-committed",
    );
  });

  it("no sentinel but a candidate directory → delete + rebuild fresh", () => {
    expect(classifyStoreBoot(obs({ opfs: { sentinelPresent: false, storeDirectoryPresent: true } })).action).toBe(
      "delete-candidate-and-rebuild",
    );
  });

  it("neither sentinel nor directory → falls through to the recordless-idb check", () => {
    // existing recordless idb store → boot-idb-authoritative
    expect(
      classifyStoreBoot(obs({ opfs: { sentinelPresent: false, storeDirectoryPresent: false }, idbStoreExists: true }))
        .action,
    ).toBe("boot-idb-authoritative");
    // nothing anywhere → virgin
    expect(
      classifyStoreBoot(obs({ opfs: { sentinelPresent: false, storeDirectoryPresent: false }, idbStoreExists: false }))
        .action,
    ).toBe("virgin-create");
  });
});

describe("classifyStoreBoot — recordless, OPFS unobservable (classification 7 / recordless-idb check)", () => {
  it("existing idb store → boot-idb-authoritative (NEVER virgin)", () => {
    expect(classifyStoreBoot(obs({ opfs: "unobservable", idbStoreExists: true })).action).toBe(
      "boot-idb-authoritative",
    );
  });

  it("no idb store → virgin-create", () => {
    expect(classifyStoreBoot(obs({ opfs: "unobservable", idbStoreExists: false })).action).toBe("virgin-create");
  });
});

// ---------------------------------------------------------------------------------------------------------
// B. Meta record IO
// ---------------------------------------------------------------------------------------------------------

describe("meta record IO", () => {
  const storePath = "meta-store";

  it("write → read round-trip", async () => {
    const indexedDB = new FakeIndexedDb();
    const rec: StoreMetaRecord = { phase: "opfs-committed", updatedAt: 42 };
    await writeStoreMetaRecord(storePath, rec, metaDeps(indexedDB));
    const read = await readStoreMetaRecord(storePath, metaDeps(indexedDB));
    expect(read).toEqual(rec);
  });

  it("waits for strict transaction completion and rejects an abort after request success", async () => {
    const indexedDB = new FakeIndexedDb(true);
    // oxlint-disable-next-line typescript/await-thenable -- bun-types gap: .rejects returns a promise typed as void
    await expect(
      writeStoreMetaRecord(storePath, { phase: "opfs-candidate", updatedAt: 9 }, metaDeps(indexedDB)),
    ).rejects.toThrow("quota abort after request success");
    const database = indexedDB.dbs.get(STORE_META_DATABASE);
    expect(database?.transactionOptions).toContainEqual({ durability: "strict" });
  });

  it("observes transaction abort after the put request already rejected", async () => {
    const indexedDB = new FakeIndexedDb(true, true);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      // oxlint-disable-next-line typescript/await-thenable -- bun-types gap: .rejects returns a promise typed as void
      await expect(
        writeStoreMetaRecord(storePath, { phase: "opfs-candidate", updatedAt: 9 }, metaDeps(indexedDB)),
      ).rejects.toThrow("meta put failed");
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("read of an absent record → undefined", async () => {
    const indexedDB = new FakeIndexedDb();
    expect(await readStoreMetaRecord(storePath, metaDeps(indexedDB))).toBeUndefined();
  });

  it("read after delete → undefined", async () => {
    const indexedDB = new FakeIndexedDb();
    await writeStoreMetaRecord(storePath, { phase: "adopting", updatedAt: 1 }, metaDeps(indexedDB));
    await deleteStoreMetaRecord(storePath, metaDeps(indexedDB));
    expect(await readStoreMetaRecord(storePath, metaDeps(indexedDB))).toBeUndefined();
  });

  it("uses the dedicated meta database name and stays per-store", async () => {
    const indexedDB = new FakeIndexedDb();
    await writeStoreMetaRecord("store-a", { phase: "idb-authoritative", updatedAt: 1 }, metaDeps(indexedDB));
    await writeStoreMetaRecord("store-b", { phase: "opfs-committed", updatedAt: 2 }, metaDeps(indexedDB));
    expect(indexedDB.dbs.has(STORE_META_DATABASE)).toBe(true);
    const a = (await readStoreMetaRecord("store-a", metaDeps(indexedDB))) as StoreMetaRecord | undefined;
    const b = (await readStoreMetaRecord("store-b", metaDeps(indexedDB))) as StoreMetaRecord | undefined;
    expect(a?.phase).toBe("idb-authoritative");
    expect(b?.phase).toBe("opfs-committed");
  });

  it("retries a failing read and succeeds (bounded retry, injected delay)", async () => {
    const inner = new FakeIndexedDb();
    await writeStoreMetaRecord(storePath, { phase: "opfs-committed", updatedAt: 7 }, metaDeps(inner));
    const flaky = new FlakyIndexedDb(inner, META_READ_ATTEMPTS - 1);
    let delays = 0;
    const read = await readStoreMetaRecord(
      storePath,
      metaDeps(flaky, async () => {
        delays += 1;
      }),
    );
    expect(read).toEqual({ phase: "opfs-committed", updatedAt: 7 });
    // one delay between each of the failed attempts (META_READ_ATTEMPTS - 1 failures → that many delays)
    expect(delays).toBe(META_READ_ATTEMPTS - 1);
    expect(flaky.attempts).toBe(META_READ_ATTEMPTS);
  });

  it("throws StoreMetaUnreadableError when every attempt fails (fail closed, never 'no record')", async () => {
    const inner = new FakeIndexedDb();
    const flaky = new FlakyIndexedDb(inner, META_READ_ATTEMPTS);
    let delays = 0;
    // oxlint-disable-next-line typescript/await-thenable -- bun-types gap: .resolves/.rejects matchers return a real promise typed as void
    await expect(
      readStoreMetaRecord(
        storePath,
        metaDeps(flaky, async () => {
          delays += 1;
        }),
      ),
    ).rejects.toThrow(StoreMetaUnreadableError);
    expect(flaky.attempts).toBe(META_READ_ATTEMPTS);
    expect(delays).toBe(META_READ_ATTEMPTS - 1);
  });

  it("rejects a malformed stored value as StoreMetaUnreadableError (corruption is not absence)", async () => {
    const indexedDB = new FakeIndexedDb();
    indexedDB.seed(STORE_META_DATABASE, "stores", storeIdentityKey(storePath), { phase: "bogus", updatedAt: 1 });
    // oxlint-disable-next-line typescript/await-thenable -- bun-types gap: .resolves/.rejects matchers return a real promise typed as void
    await expect(readStoreMetaRecord(storePath, metaDeps(indexedDB))).rejects.toThrow(StoreMetaUnreadableError);
  });

  it("returns META_STORE_UNAVAILABLE when indexedDB is entirely absent", async () => {
    expect(await readStoreMetaRecord(storePath, metaDeps(undefined))).toBe(META_STORE_UNAVAILABLE);
  });
});

// ---------------------------------------------------------------------------------------------------------
// C. Non-creating idb existence check
// ---------------------------------------------------------------------------------------------------------

describe("idbStoreExists — non-creating existence check (invariant 14)", () => {
  it("existing database → true, and the handle is closed", async () => {
    const indexedDB = new FakeExistsIndexedDb(true);
    expect(await idbStoreExists("recordless-store", metaDeps(indexedDB))).toBe(true);
    expect(indexedDB.closed).toBe(true);
  });

  it("missing database → false, and the versionchange transaction is aborted (nothing persists)", async () => {
    const indexedDB = new FakeExistsIndexedDb(false);
    expect(await idbStoreExists("never-existed", metaDeps(indexedDB))).toBe(false);
    expect(indexedDB.aborted).toBe(true);
  });

  it("indexedDB absent → false (no idb store can exist)", async () => {
    expect(await idbStoreExists("x", metaDeps(undefined))).toBe(false);
  });
});
