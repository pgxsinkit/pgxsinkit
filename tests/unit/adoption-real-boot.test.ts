import { afterEach, describe, expect, it } from "bun:test";

import { PGlite } from "@electric-sql/pglite";
import { dataDir as prepopulatedDataDir } from "@electric-sql/pglite-prepopulatedfs";
import { live } from "@electric-sql/pglite/live";

import type { SyncTableRegistry } from "@pgxsinkit/contracts";

import { adoptStore, type ClientPGlite, createClientPGlite } from "../../packages/client/src/index";
import { storeIdentityComponent, storeIndexedDbDatabaseName } from "../../packages/client/src/store-path";

function notFound(): Error {
  const error = new Error("not found");
  error.name = "NotFoundError";
  return error;
}

class FakeDir {
  readonly dirs = new Map<string, FakeDir>();
  readonly files = new Set<string>();
  private readonly order: string[];
  constructor(order: string[]) {
    this.order = order;
  }
  async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<FakeDir> {
    const existing = this.dirs.get(name);
    if (existing) return existing;
    if (!options?.create) throw notFound();
    const created = new FakeDir(this.order);
    this.dirs.set(name, created);
    return created;
  }
  async getFileHandle(name: string, options?: { create?: boolean }): Promise<unknown> {
    if (this.files.has(name)) return { name };
    if (!options?.create) throw notFound();
    this.files.add(name);
    this.order.push("publish-sentinel");
    return { name };
  }
  async removeEntry(name: string): Promise<void> {
    if (this.files.delete(name) || this.dirs.delete(name)) return;
    throw notFound();
  }
}

class FakeObjectStore {
  readonly data = new Map<string, unknown>();
  private readonly order: string[];
  constructor(order: string[]) {
    this.order = order;
  }
  private request(run: () => unknown) {
    const request = {
      result: undefined as unknown,
      error: null as unknown,
      onsuccess: null as (() => void) | null,
      onerror: null as (() => void) | null,
    };
    queueMicrotask(() => {
      request.result = run();
      request.onsuccess?.();
    });
    return request;
  }
  get(key: string) {
    return this.request(() => this.data.get(key));
  }
  put(value: unknown, key: string) {
    return this.request(() => {
      this.data.set(key, value);
      this.order.push(`phase:${(value as { phase: string }).phase}`);
    });
  }
  delete(key: string) {
    return this.request(() => this.data.delete(key));
  }
}

class FakeDatabase {
  readonly objectStoreNames = { contains: () => true };
  private readonly store: FakeObjectStore;
  constructor(store: FakeObjectStore) {
    this.store = store;
  }
  createObjectStore() {
    return this.store;
  }
  transaction() {
    const transaction = {
      objectStore: () => this.store,
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
  readonly store: FakeObjectStore;
  private readonly database: FakeDatabase;
  private readonly order: string[];
  constructor(order: string[]) {
    this.order = order;
    this.store = new FakeObjectStore(order);
    this.database = new FakeDatabase(this.store);
  }
  open(_name: string) {
    const request = {
      result: this.database,
      error: null as unknown,
      transaction: null,
      onupgradeneeded: null as ((event: unknown) => void) | null,
      onsuccess: null as (() => void) | null,
      onerror: null as (() => void) | null,
    };
    queueMicrotask(() => request.onsuccess?.());
    return request;
  }
  deleteDatabase(name: string) {
    const request = {
      error: null as unknown,
      onsuccess: null as (() => void) | null,
      onerror: null as (() => void) | null,
      onblocked: null as (() => void) | null,
    };
    queueMicrotask(() => {
      this.order.push(`delete-predecessor:${name}`);
      request.onsuccess?.();
    });
    return request;
  }
}

const savedNavigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
const savedIndexedDbDescriptor = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
const clients: ClientPGlite[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => undefined);
  if (savedNavigatorDescriptor === undefined) delete (globalThis as { navigator?: unknown }).navigator;
  else Object.defineProperty(globalThis, "navigator", savedNavigatorDescriptor);
  if (savedIndexedDbDescriptor === undefined) delete (globalThis as { indexedDB?: unknown }).indexedDB;
  else Object.defineProperty(globalThis, "indexedDB", savedIndexedDbDescriptor);
});

async function makePglite(strictSync?: () => Promise<void>): Promise<ClientPGlite> {
  const pglite = (await PGlite.create({
    loadDataDir: await prepopulatedDataDir(),
    extensions: { live },
  })) as unknown as ClientPGlite;
  if (strictSync) Object.defineProperty(pglite, "strictSync", { value: strictSync, configurable: true });
  clients.push(pglite);
  return pglite;
}

describe("real adoption boot recursion", () => {
  it("opens the predecessor once, builds the candidate through createSyncClient, then commits before deletion", async () => {
    const storePath = "adoption-real-boot";
    const order: string[] = [];
    const root = new FakeDir(order);
    Object.defineProperty(globalThis, "navigator", {
      value: { storage: { getDirectory: async () => root } },
      configurable: true,
      writable: true,
    });
    const meta = new FakeMetaIdb(order);
    Object.defineProperty(globalThis, "indexedDB", { value: meta, configurable: true, writable: true });
    meta.store.data.set(storeIdentityComponent(storePath), { phase: "idb-authoritative", updatedAt: 1 });
    let opens = 0;
    let candidate: ClientPGlite | undefined;

    const outcome = await adoptStore({
      registry: {} as SyncTableRegistry,
      electricUrl: "http://127.0.0.1:1/v1/electric-proxy",
      batchWriteUrl: "http://127.0.0.1:1/api/mutations",
      storePath,
      syncEnabled: true,
      seams: {
        meta: { indexedDB: meta as never },
        opfs: { getRoot: async () => root },
        isStoreLive: () => false,
        createPglite: async (_path, options) => {
          opens += 1;
          order.push(options?.hasOpfsSyncAccess ? "open:candidate" : "open:predecessor");
          if (!options?.hasOpfsSyncAccess) return makePglite();
          return createClientPGlite(_path, {
            ...options,
            pgliteFactories: {
              createOpfsRepacked: async () => {
                order.push("open:opfs-factory");
                candidate = await makePglite(async () => {
                  order.push("strict-sync");
                });
                return candidate as never;
              },
              getStoreDirectoryHandle: async () => ({ kind: "fake-opfs-directory" }),
              retryDelayMs: 0,
            },
          });
        },
      },
    });

    expect(outcome).toEqual({ adopted: true });
    expect(opens).toBe(2);
    expect(order.filter((step) => step === "open:predecessor")).toHaveLength(1);
    expect(order.filter((step) => step === "open:opfs-factory")).toHaveLength(1);
    expect((candidate as unknown as Record<symbol, unknown>)[Symbol.for("pgxsinkit.opfsRepackedPersistent")]).toBe(
      true,
    );
    expect(order).toContain(`delete-predecessor:${storeIndexedDbDatabaseName(storePath)}`);
    expect(order.indexOf("strict-sync")).toBeLessThan(order.indexOf("publish-sentinel"));
    expect(order.indexOf("phase:opfs-committed")).toBeLessThan(
      order.indexOf(`delete-predecessor:${storeIndexedDbDatabaseName(storePath)}`),
    );
    expect(meta.store.data.get(storeIdentityComponent(storePath))).toMatchObject({ phase: "opfs-committed" });
  });
});
