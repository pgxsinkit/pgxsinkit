import { afterEach, describe, expect, it } from "bun:test";
// The supplied-build check (ADR-0063). A store's Postgres build is code — a `PostgresBuild` a site supplies, or
// the build an adopted instance reports as `pg.build` — and it must be the registry's declared `storage.build`
// (default "c"). Proven at every site: the `createSyncClient` boot, `createPgwasmClient` with a threaded
// declaration, the worker's provision mint and a worker `createStore` result, the adopted `pgwasmInstance` /
// `precreatedPgwasm`, plus pgwasm's own refusal of a foreign Store backup, and the OPFS open loop never retrying
// a typed refusal. The foreign builds are step 1's `foreignIdentityBuild` over the C build.

import { bigint, boolean, uuid, varchar } from "drizzle-orm/pg-core";

import { defineSyncRegistry, defineSyncTable, StorageBuildMismatchError } from "@pgxsinkit/contracts";
import { BuildMismatchError, createPgwasm } from "@pgxsinkit/pgwasm";
import { cBuild } from "@pgxsinkit/pgwasm-c";
import { live } from "@pgxsinkit/pgwasm/live";

import {
  createPgwasmClient,
  createSyncClient,
  defineSyncWorker,
  type PgwasmClient,
  provisionSyncWorker,
  type SyncClient,
  type SyncWorkerHost,
} from "../../packages/client/src/index";
import { assertStoreBuild, isStoreBuildRefusal } from "../../packages/client/src/store-build";
import { memoryStoreForTests, testStoreAcknowledgment } from "../../packages/client/src/testing";
import { foreignIdentityBuild } from "./support/pgwasm-build-decorators";

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

const DEAD = "http://127.0.0.1:1";
const foreign = foreignIdentityBuild(cBuild, { name: "foreign" });

const clients: SyncClient<TodosRegistry>[] = [];
const stores: PgwasmClient[] = [];
const hosts: SyncWorkerHost<TodosRegistry>[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.destroy().catch(() => undefined);
  for (const store of stores.splice(0)) await store.close().catch(() => undefined);
  for (const host of hosts.splice(0)) await host.close().catch(() => undefined);
});

function clientOptions(extra: Partial<Parameters<typeof createSyncClient<TodosRegistry>>[0]>) {
  return {
    registry: todosRegistry,
    controlPlaneUrl: DEAD,
    streamBaseUrl: `${DEAD}/v1/stream`,
    batchWriteUrl: `${DEAD}/api/mutations`,
    syncEnabled: false,
    ...extra,
  } as Parameters<typeof createSyncClient<TodosRegistry>>[0];
}

/** A memory store the foreign build made — what a caller would adopt, or back up. */
async function foreignStore(): Promise<PgwasmClient> {
  const pg = (await createPgwasm({ build: foreign, extensions: { live } })) as unknown as PgwasmClient;
  stores.push(pg);
  return pg;
}

/** Await a rejection and hand back the error, failing the test when the promise resolves. */
async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    const value = await promise;
    if (value != null && typeof (value as SyncClient<TodosRegistry>).destroy === "function") {
      clients.push(value as SyncClient<TodosRegistry>);
    }
  } catch (error) {
    if (!(error instanceof Error)) throw new Error(`rejected with a non-Error: ${String(error)}`);
    return error;
  }
  throw new Error("expected a rejection, but the promise resolved");
}

function expectMismatch(error: Error, fields: StorageBuildMismatchError["detail"]): void {
  expect(error).toBeInstanceOf(StorageBuildMismatchError);
  expect(error.name).toBe("StorageBuildMismatchError");
  const mismatch = error as StorageBuildMismatchError;
  expect({ declared: mismatch.declared, supplied: mismatch.supplied, site: mismatch.site }).toEqual(fields);
  // The fields ride `detail`, which the worker bridge carries alongside the stable name.
  expect(mismatch.detail).toEqual(fields);
}

describe("assertStoreBuild", () => {
  it("accepts the declared build and refuses any other, typed", () => {
    expect(() => assertStoreBuild("c", cBuild.identity, "createSyncClient")).not.toThrow();
    let thrown: unknown;
    try {
      assertStoreBuild("pgrust", cBuild.identity, "createPgwasmClient");
    } catch (error) {
      thrown = error;
    }
    expectMismatch(thrown as Error, { declared: "pgrust", supplied: "c", site: "createPgwasmClient" });
  });

  it("classes exactly the typed build refusals as non-retryable", () => {
    expect(isStoreBuildRefusal(new StorageBuildMismatchError("c", "foreign", "createStore"))).toBe(true);
    expect(isStoreBuildRefusal(new BuildMismatchError(cBuild.identity, "unmarked", "data-directory"))).toBe(true);
    for (const name of ["DataFormatMismatchError", "BuildMarkerUnreadableError"]) {
      const error = new Error("refused");
      error.name = name;
      expect(isStoreBuildRefusal(error)).toBe(true);
    }
    expect(isStoreBuildRefusal(new Error("UnknownError: transient"))).toBe(false);
    expect(isStoreBuildRefusal("BuildMismatchError")).toBe(false);
  });
});

describe("createSyncClient refuses a supplied build that is not the declared one", () => {
  it("a foreign build against the default declaration", async () => {
    const error = await rejection(
      createSyncClient(clientOptions({ ...memoryStoreForTests("build-client-foreign"), build: foreign })),
    );
    expectMismatch(error, { declared: "c", supplied: "foreign", site: "createSyncClient" });
  });

  it("a declared pgrust with no build supplied: the default cBuild is the mismatch", async () => {
    const error = await rejection(
      createSyncClient(clientOptions({ ...memoryStoreForTests("build-client-pgrust"), storage: { build: "pgrust" } })),
    );
    expectMismatch(error, { declared: "pgrust", supplied: "c", site: "createSyncClient" });
  });

  it("boots when the supplied build is the declared one", async () => {
    const client = await createSyncClient(
      clientOptions({ ...memoryStoreForTests("build-client-ok"), build: cBuild, storage: { build: "c" } }),
    );
    clients.push(client);
    expect(client).toBeDefined();
  });
});

describe("an adopted instance is checked against its own pg.build", () => {
  it("pgwasmInstance", async () => {
    const pg = await foreignStore();
    const error = await rejection(
      createSyncClient(
        clientOptions({ storePath: "build-adopt-instance", ...testStoreAcknowledgment(), pgwasmInstance: pg }),
      ),
    );
    expectMismatch(error, { declared: "c", supplied: "foreign", site: "pgwasmInstance" });
  });

  it("precreatedPgwasm — the refusal propagates, never swallowed as a rejected create", async () => {
    const pg = await foreignStore();
    const error = await rejection(
      createSyncClient(
        clientOptions({
          storePath: "build-adopt-precreated",
          ...testStoreAcknowledgment(),
          precreatedPgwasm: Promise.resolve(pg),
        }),
      ),
    );
    expectMismatch(error, { declared: "c", supplied: "foreign", site: "precreatedPgwasm" });
  });
});

describe("a Store backup of another build", () => {
  it("restoring it refuses with pgwasm's typed BuildMismatchError", async () => {
    const pg = await foreignStore();
    await pg.exec("CREATE TABLE marker_probe (id int)");
    const backup = await pg.dumpDataDir();
    const error = await rejection(
      createSyncClient(clientOptions({ ...memoryStoreForTests("build-restore-foreign"), restoreFrom: backup })),
    );
    expect(error.name).toBe("BuildMismatchError");
    expect((error as BuildMismatchError).source).toBe("backup");
    expect((error as BuildMismatchError).found).toEqual({ build: "foreign", dataFormat: 1 });
  });
});

describe("createPgwasmClient with a threaded declaration", () => {
  it("refuses a foreign build before the mint", async () => {
    const error = await rejection(
      createPgwasmClient(memoryStoreForTests("build-pgwasm-client"), { build: foreign, declaredBuild: "c" }),
    );
    expectMismatch(error, { declared: "c", supplied: "foreign", site: "createPgwasmClient" });
  });

  it("the OPFS open loop never retries a typed refusal, and still retries a transient error", async () => {
    const refusedOpens = { count: 0 };
    const refusal = await rejection(
      createPgwasmClient("build-opfs-refusal", {
        hasOpfsSyncAccess: true,
        opfsFactories: {
          getStoreDirectoryHandle: async () => ({}),
          retryDelayMs: 0,
          createOpfsPgwasm: async () => {
            refusedOpens.count += 1;
            throw new BuildMismatchError(cBuild.identity, { build: "foreign", dataFormat: 1 }, "data-directory");
          },
        },
      }),
    );
    expect(refusal.name).toBe("BuildMismatchError");
    expect(refusedOpens.count).toBe(1);

    const transientOpens = { count: 0 };
    const transient = await rejection(
      createPgwasmClient("build-opfs-transient", {
        hasOpfsSyncAccess: true,
        opfsFactories: {
          getStoreDirectoryHandle: async () => ({}),
          retryDelayMs: 0,
          createOpfsPgwasm: async () => {
            transientOpens.count += 1;
            throw new Error("UnknownError: transient");
          },
        },
      }),
    );
    expect(transient.message).toBe("UnknownError: transient");
    expect(transientOpens.count).toBeGreaterThan(1);
  });
});

describe("defineSyncWorker", () => {
  function workerHost(extra: Partial<Parameters<typeof defineSyncWorker<TodosRegistry>>[0]>) {
    const host = defineSyncWorker<TodosRegistry>({
      registry: todosRegistry,
      controlPlaneUrl: DEAD,
      streamBaseUrl: `${DEAD}/v1/stream`,
      batchWriteUrl: `${DEAD}/api/mutations`,
      syncEnabled: false,
      installGlobal: false,
      convergenceIntervalMs: 10_000_000,
      ...extra,
    });
    hosts.push(host);
    const channel = new MessageChannel();
    host.connect(channel.port1 as unknown as never);
    return { host, port: channel.port2 };
  }

  it("the provision mint refuses the worker's build when it is not the declared one", async () => {
    const { port } = workerHost({ build: foreign });
    const error = await rejection(
      provisionSyncWorker({ port: port as unknown as never, ...memoryStoreForTests("build-worker") }),
    );
    expect(error.name).toBe("StorageBuildMismatchError");
    expect((error as Error & { detail?: unknown }).detail).toEqual({
      declared: "c",
      supplied: "foreign",
      site: "defineSyncWorker",
    });
  });

  it("a createStore result of another build is refused and closed", async () => {
    let made: PgwasmClient | undefined;
    const { port } = workerHost({
      createStore: async () => {
        made = (await createPgwasm({ build: foreign, extensions: { live } })) as unknown as PgwasmClient;
        return made;
      },
    });
    const error = await rejection(
      provisionSyncWorker({ port: port as unknown as never, ...memoryStoreForTests("build-worker-store") }),
    );
    expect(error.name).toBe("StorageBuildMismatchError");
    expect((error as Error & { detail?: unknown }).detail).toEqual({
      declared: "c",
      supplied: "foreign",
      site: "createStore",
    });
    expect(made?.closed).toBe(true);
  });
});
