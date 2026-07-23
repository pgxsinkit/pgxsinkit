import { afterEach, describe, expect, it } from "bun:test";

// Protocol-tier tests for the ADR-0032 S3 bridge extensions: the pre-spawned (schemaless) store the spare
// flow needs (`provision` → `provision-ack`, adopted by the first `attach`), the role-selected registry
// (`config.role` → `resolveRegistry`), and the Offline toggle over the bridge (`set-online` gating the
// worker's outbound convergence). Driven over a bun `MessageChannel` — NO actual Worker — exactly like
// worker-bridge.test.ts.
import { PGlite } from "@electric-sql/pglite";
import { dataDir as prepopulatedDataDir } from "@electric-sql/pglite-prepopulatedfs";
import { live } from "@electric-sql/pglite/live";
import { bigint, boolean, uuid, varchar } from "drizzle-orm/pg-core";

import { defineSyncRegistry, defineSyncTable } from "@pgxsinkit/contracts";

import {
  attachSyncClient,
  type BridgeEnvelope,
  type ClientPGlite,
  defineSyncWorker,
  identityCodec,
  isBridgeEnvelope,
  provisionSyncWorker,
  type SyncWorkerHost,
} from "../../packages/client/src/index";
import { opfsCommitmentSentinelPath, storeIdentityComponent } from "../../packages/client/src/store-path";
import { memoryStoreForTests, testStoreAcknowledgment } from "../../packages/client/src/testing";

const todosRegistry = defineSyncRegistry({
  todos: defineSyncTable({
    tableName: "todos",
    makeColumns: () => ({
      id: uuid("id").primaryKey(),
      title: varchar("title", { length: 200 }).notNull(),
      done: boolean("done").notNull(),
      updatedAtUs: bigint("updated_at_us", { mode: "bigint" }).notNull(),
    }),
    mode: "readwrite",
    conflictPolicy: "last-write-wins",
    governance: {
      managedFields: [{ column: "updatedAtUs", applyOn: ["create", "update"], strategy: "nowMicroseconds" }],
    },
  }),
});
type TodosRegistry = typeof todosRegistry;

let hosts: SyncWorkerHost<TodosRegistry>[] = [];
let channels: MessageChannel[] = [];
const savedNavigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
const savedIndexedDbDescriptor = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
const savedSharedWorkerScopeDescriptor = Object.getOwnPropertyDescriptor(globalThis, "SharedWorkerGlobalScope");
const savedOnConnectDescriptor = Object.getOwnPropertyDescriptor(globalThis, "onconnect");

function notFound(): Error {
  const error = new Error("not found");
  error.name = "NotFoundError";
  return error;
}

class FakeOpfsDir {
  readonly dirs = new Map<string, FakeOpfsDir>();
  readonly files = new Set<string>();
  private readonly order: string[];
  constructor(order: string[]) {
    this.order = order;
  }

  async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<FakeOpfsDir> {
    const existing = this.dirs.get(name);
    if (existing) return existing;
    if (!options?.create) throw notFound();
    const created = new FakeOpfsDir(this.order);
    this.dirs.set(name, created);
    return created;
  }

  async getFileHandle(name: string, options?: { create?: boolean }): Promise<unknown> {
    const handle = {
      name,
      createSyncAccessHandle: async () => ({ close: () => undefined }),
    };
    if (this.files.has(name)) return handle;
    if (!options?.create) throw notFound();
    this.files.add(name);
    return handle;
  }

  async removeEntry(name: string): Promise<void> {
    if (this.files.delete(name)) {
      this.order.push("delete-sentinel");
      return;
    }
    if (this.dirs.delete(name)) return;
    throw notFound();
  }
}

class FakeMetaStore {
  readonly records = new Map<string, unknown>();
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
    return this.request(() => this.records.get(key));
  }

  put(value: unknown, key: string) {
    return this.request(() => {
      this.records.set(key, value);
      this.order.push(`record:${(value as { phase: string }).phase}`);
    });
  }

  delete(key: string) {
    return this.request(() => this.records.delete(key));
  }
}

class FakeMetaDatabase {
  readonly objectStoreNames = { contains: () => true };
  private readonly store: FakeMetaStore;
  constructor(store: FakeMetaStore) {
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

class FakeAuthorityIdb {
  readonly store: FakeMetaStore;
  private readonly database: FakeMetaDatabase;
  private readonly order: string[];
  constructor(order: string[]) {
    this.order = order;
    this.store = new FakeMetaStore(order);
    this.database = new FakeMetaDatabase(this.store);
  }

  open() {
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
      this.order.push(`delete-idb:${name}`);
      request.onsuccess?.();
    });
    return request;
  }
}

async function seedSentinel(root: FakeOpfsDir, storePath: string): Promise<void> {
  const path = opfsCommitmentSentinelPath(storePath);
  let parent = root;
  for (const segment of path.slice(0, -1)) parent = await parent.getDirectoryHandle(segment, { create: true });
  await parent.getFileHandle(path.at(-1)!, { create: true });
}

async function sentinelPresent(root: FakeOpfsDir, storePath: string): Promise<boolean> {
  const path = opfsCommitmentSentinelPath(storePath);
  let parent = root;
  try {
    for (const segment of path.slice(0, -1)) parent = await parent.getDirectoryHandle(segment);
    return parent.files.has(path.at(-1)!);
  } catch {
    return false;
  }
}

/** A fresh prepopulated memory PGlite (skips the ~2s initdb) as the raw store the worker would `create`. */
async function makePglite(): Promise<ClientPGlite> {
  const pg = await PGlite.create({ loadDataDir: await prepopulatedDataDir(), extensions: { live } });
  return pg as unknown as ClientPGlite;
}

function connectRaw(host: SyncWorkerHost<TodosRegistry>): {
  port2: MessagePort;
  seen: BridgeEnvelope[];
} {
  const channel = new MessageChannel();
  channels.push(channel);
  host.connect(channel.port1 as unknown as never);
  const seen: BridgeEnvelope[] = [];
  channel.port2.addEventListener("message", (event) => {
    if (isBridgeEnvelope((event as MessageEvent).data)) seen.push((event as MessageEvent).data as BridgeEnvelope);
  });
  channel.port2.start?.();
  return { port2: channel.port2, seen };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

afterEach(async () => {
  for (const host of hosts) await host.close().catch(() => undefined);
  for (const channel of channels) {
    channel.port1.close();
    channel.port2.close();
  }
  hosts = [];
  channels = [];
  if (savedNavigatorDescriptor === undefined) delete (globalThis as { navigator?: unknown }).navigator;
  else Object.defineProperty(globalThis, "navigator", savedNavigatorDescriptor);
  if (savedIndexedDbDescriptor === undefined) delete (globalThis as { indexedDB?: unknown }).indexedDB;
  else Object.defineProperty(globalThis, "indexedDB", savedIndexedDbDescriptor);
  if (savedSharedWorkerScopeDescriptor === undefined) {
    delete (globalThis as { SharedWorkerGlobalScope?: unknown }).SharedWorkerGlobalScope;
  } else Object.defineProperty(globalThis, "SharedWorkerGlobalScope", savedSharedWorkerScopeDescriptor);
  if (savedOnConnectDescriptor === undefined) delete (globalThis as { onconnect?: unknown }).onconnect;
  else Object.defineProperty(globalThis, "onconnect", savedOnConnectDescriptor);
});

describe("provision → adopt (ADR-0032 decision 5)", () => {
  it("declines a granted-lane provision while deletion authority is live", async () => {
    const storePath = "granted-provision-over-deleting";
    const order: string[] = [];
    const idb = new FakeAuthorityIdb(order);
    idb.store.records.set(storeIdentityComponent(storePath), { phase: "deleting", updatedAt: 1 });
    const root = new FakeOpfsDir(order);
    await seedSentinel(root, storePath);
    Object.defineProperty(globalThis, "indexedDB", { value: idb, configurable: true, writable: true });
    Object.defineProperty(globalThis, "navigator", {
      value: { storage: { getDirectory: async () => root } },
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, "SharedWorkerGlobalScope", {
      value: class {},
      configurable: true,
      writable: true,
    });

    let creates = 0;
    const host = defineSyncWorker({
      registry: todosRegistry,
      electricUrl: "http://127.0.0.1:1/v1/electric-proxy",
      batchWriteUrl: "http://127.0.0.1:1/api/mutations",
      syncEnabled: false,
      convergenceIntervalMs: 10_000_000,
      createPglite: async () => {
        creates += 1;
        return makePglite();
      },
    });
    hosts.push(host);

    const channel = new MessageChannel();
    channels.push(channel);
    const onconnect = (globalThis as { onconnect?: (event: { ports: MessagePort[] }) => void }).onconnect;
    expect(onconnect).toBeFunction();
    onconnect!({ ports: [channel.port1] });
    await provisionSyncWorker({ port: channel.port2 as unknown as never, storePath });

    // Provision is only an accelerator. It must not mint a replacement beneath live deletion authority;
    // the subsequent attach owns the ordinary phase-machine recovery.
    expect(creates).toBe(0);
    expect(idb.store.records.get(storeIdentityComponent(storePath))).toMatchObject({ phase: "deleting" });
    expect(order.some((step) => step.startsWith("delete-idb:"))).toBeFalse();
    expect(await sentinelPresent(root, storePath)).toBeTrue();
  });

  it("declines a denied-lane provision while deletion authority is live", async () => {
    const storePath = "provision-over-deleting";
    const order: string[] = [];
    const idb = new FakeAuthorityIdb(order);
    idb.store.records.set(storeIdentityComponent(storePath), { phase: "deleting", updatedAt: 1 });
    const root = new FakeOpfsDir(order);
    await seedSentinel(root, storePath);
    Object.defineProperty(globalThis, "indexedDB", { value: idb, configurable: true, writable: true });
    Object.defineProperty(globalThis, "navigator", {
      value: { storage: { getDirectory: async () => root } },
      configurable: true,
      writable: true,
    });

    const host = defineSyncWorker({
      registry: todosRegistry,
      electricUrl: "http://127.0.0.1:1/v1/electric-proxy",
      batchWriteUrl: "http://127.0.0.1:1/api/mutations",
      syncEnabled: false,
      installGlobal: false,
      convergenceIntervalMs: 10_000_000,
      ...testStoreAcknowledgment(),
      createPglite: async () => {
        order.push("create-replacement");
        return makePglite();
      },
    });
    hosts.push(host);

    const { port2 } = connectRaw(host);
    await provisionSyncWorker({ port: port2 as unknown as never, storePath });

    expect(order).toEqual([]);
    expect(idb.store.records.get(storeIdentityComponent(storePath))).toMatchObject({ phase: "deleting" });
    expect(await sentinelPresent(root, storePath)).toBeTrue();
  });

  it("pre-creates the store on `provision` and the first `attach` adopts it (no second create)", async () => {
    const created: string[] = [];
    let instance: ClientPGlite | null = null;
    const host = defineSyncWorker({
      registry: todosRegistry,
      electricUrl: "http://127.0.0.1:1/v1/electric-proxy",
      batchWriteUrl: "http://127.0.0.1:1/api/mutations",
      syncEnabled: false,
      installGlobal: false,
      convergenceIntervalMs: 10_000_000,
      createPglite: async (storePath) => {
        created.push(storePath);
        instance = await makePglite();
        return instance;
      },
    });
    hosts.push(host);

    const { port2 } = connectRaw(host);
    await provisionSyncWorker({ port: port2 as unknown as never, ...memoryStoreForTests("spare-1") });
    expect(created).toEqual(["spare-1"]); // initdb ran once, at provision time

    const client = await attachSyncClient({
      registry: todosRegistry,
      port: port2 as unknown as never,
      ...memoryStoreForTests("spare-1"),
      getToken: async () => ({ accessToken: "t", expiresAt: Date.now() + 3_600_000 }),
    });
    await client.ready;

    // The booted engine adopted the provisioned instance — createPglite was NOT called a second time.
    expect(created).toEqual(["spare-1"]);
    const booted = await host.whenBooted();
    expect(booted.pglite).toBe(instance!);
  });

  it("treats a rejected provision as a pure accelerator failure and boots on attach", async () => {
    const host = defineSyncWorker({
      registry: todosRegistry,
      electricUrl: "http://127.0.0.1:1/v1/electric-proxy",
      batchWriteUrl: "http://127.0.0.1:1/api/mutations",
      syncEnabled: false,
      installGlobal: false,
      convergenceIntervalMs: 10_000_000,
      createPglite: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        throw new Error("warm-up failed");
      },
    });
    hosts.push(host);

    const { port2 } = connectRaw(host);
    const provision = provisionSyncWorker({
      port: port2 as unknown as never,
      ...memoryStoreForTests("rejected-spare"),
    });
    const attaching = attachSyncClient({
      registry: todosRegistry,
      port: port2 as unknown as never,
      ...memoryStoreForTests("rejected-spare"),
      getToken: async () => ({ accessToken: "t", expiresAt: Date.now() + 3_600_000 }),
    });
    const provisionError = await provision.then(
      () => null,
      (error: unknown) => error,
    );
    expect(provisionError).toBeInstanceOf(Error);
    expect((provisionError as Error).message).toContain("warm-up failed");
    const client = await attaching;
    await client.ready;
    expect((await host.whenBooted()).pglite).toBeDefined();
  });

  it("adopts on the store's storePath even when the attach also carries a distinct bare storeId (board shape)", async () => {
    // The board sends BOTH a bare `storeId` (SharedWorker naming) AND the real `storePath`
    // (`pgxsinkit-board-<id>`); provision carried only the storePath. The worker must adopt on the
    // storePath, not the storeId — otherwise it boots a SECOND store and the pre-paid initdb is wasted.
    const created: string[] = [];
    let instance: ClientPGlite | null = null;
    const host = defineSyncWorker({
      registry: todosRegistry,
      electricUrl: "http://127.0.0.1:1/v1/electric-proxy",
      batchWriteUrl: "http://127.0.0.1:1/api/mutations",
      syncEnabled: false,
      installGlobal: false,
      convergenceIntervalMs: 10_000_000,
      createPglite: async (storePath) => {
        created.push(storePath);
        instance = await makePglite();
        return instance;
      },
    });
    hosts.push(host);

    const { port2 } = connectRaw(host);
    await provisionSyncWorker({ port: port2 as unknown as never, ...memoryStoreForTests("pgxsinkit-board-abc") });
    expect(created).toEqual(["pgxsinkit-board-abc"]);

    const client = await attachSyncClient({
      registry: todosRegistry,
      port: port2 as unknown as never,
      storeId: "abc", // the bare id (naming); distinct from the store path
      ...memoryStoreForTests("pgxsinkit-board-abc"), // the real store path provision used
      getToken: async () => ({ accessToken: "t", expiresAt: Date.now() + 3_600_000 }),
    });
    await client.ready;

    // Still one create, and the booted engine adopted the provisioned instance.
    expect(created).toEqual(["pgxsinkit-board-abc"]);
    const booted = await host.whenBooted();
    expect(booted.pglite).toBe(instance!);
  });
});

describe("role-selected registry (ADR-0032 S3, config.role → resolveRegistry)", () => {
  it("passes the attach role to resolveRegistry and boots the resolved variant", async () => {
    const memberRegistry = todosRegistry; // same TS shape stands in for the member projection
    const roles: Array<string | undefined> = [];
    const host = defineSyncWorker({
      registry: todosRegistry,
      resolveRegistry: (role) => {
        roles.push(role);
        return role === "member" ? memberRegistry : todosRegistry;
      },
      electricUrl: "http://127.0.0.1:1/v1/electric-proxy",
      batchWriteUrl: "http://127.0.0.1:1/api/mutations",
      // A memory precreated store (test only) — acknowledge it past the BYO refusal (ADR-0036).
      ...testStoreAcknowledgment(),
      precreatedPglite: makePglite(),
      syncEnabled: false,
      installGlobal: false,
      convergenceIntervalMs: 10_000_000,
    });
    hosts.push(host);

    const { port2 } = connectRaw(host);
    const client = await attachSyncClient({
      registry: todosRegistry,
      port: port2 as unknown as never,
      role: "member",
      getToken: async () => ({ accessToken: "t", expiresAt: Date.now() + 3_600_000 }),
    });
    await client.ready;
    expect(roles).toEqual(["member"]);
  });
});

describe("Offline toggle over the bridge (ADR-0032 S3, set-online)", () => {
  it("flips the worker's convergence gate and emits the gate debug both ways", async () => {
    const host = defineSyncWorker({
      registry: todosRegistry,
      electricUrl: "http://127.0.0.1:1/v1/electric-proxy",
      batchWriteUrl: "http://127.0.0.1:1/api/mutations",
      // A memory precreated store (test only) — acknowledge it past the BYO refusal (ADR-0036).
      ...testStoreAcknowledgment(),
      precreatedPglite: makePglite(),
      syncEnabled: false,
      installGlobal: false,
      convergenceIntervalMs: 10_000_000,
    });
    hosts.push(host);

    const { port2, seen } = connectRaw(host);
    // __pgxsinkitDebug gates the tab's re-print, but the worker always BROADCASTS the debug event; assert
    // on the raw envelopes so the test does not depend on the global flag.
    const client = await attachSyncClient({
      registry: todosRegistry,
      port: port2 as unknown as never,
      getToken: async () => ({ accessToken: "t", expiresAt: Date.now() + 3_600_000 }),
    });
    await client.ready;

    const gateEvents = () =>
      seen
        .filter((e) => e.type === "event")
        .map((e) => identityCodec.decode(e.payload) as { kind: string; line?: string; data?: { online?: boolean } })
        .filter((ev) => ev.kind === "debug" && ev.line === "worker convergence gate");

    client.setOnline(false);
    await tick();
    client.setOnline(true);
    await tick();

    const online = gateEvents().map((ev) => ev.data?.online);
    expect(online).toContain(false);
    expect(online).toContain(true);
  });
});
