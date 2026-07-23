import { afterEach, describe, expect, it } from "bun:test";
// Store backup across the bridge (ADR-0035): a REAL in-process engine behind `defineSyncWorker`, driven by
// `attachSyncClient` over a bun `MessageChannel` — NO actual Worker. The worker runs the LIVE export on its
// owned client and the dump crosses back as a transferred `ArrayBuffer`, rebuilt into a `File` tab-side.

import { PGlite } from "@electric-sql/pglite";
import { dataDir as prepopulatedDataDir } from "@electric-sql/pglite-prepopulatedfs";
import { live } from "@electric-sql/pglite/live";
import { bigint, boolean, uuid, varchar } from "drizzle-orm/pg-core";

import { defineSyncRegistry, defineSyncTable } from "@pgxsinkit/contracts";

import {
  attachSyncClient,
  type ClientPGlite,
  defineSyncWorker,
  type SyncWorkerHost,
} from "../../packages/client/src/index";
import { testStoreAcknowledgment } from "../../packages/client/src/testing";

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

async function makeHost(): Promise<SyncWorkerHost<TodosRegistry>> {
  const pg = await PGlite.create({ loadDataDir: await prepopulatedDataDir(), extensions: { live } });
  const host = defineSyncWorker({
    registry: todosRegistry,
    electricUrl: "http://127.0.0.1:1/v1/electric-proxy",
    batchWriteUrl: "http://127.0.0.1:1/api/mutations",
    // The precreated store is a prepopulated MEMORY PGlite (test only) — acknowledge it past the BYO
    // refusal the worker's `createSyncClient` boot would otherwise raise (ADR-0036).
    ...testStoreAcknowledgment(),
    precreatedPglite: Promise.resolve(pg as unknown as ClientPGlite),
    syncEnabled: false,
    installGlobal: false,
    convergenceIntervalMs: 10_000_000,
  });
  hosts.push(host);
  return host;
}

async function attach(host: SyncWorkerHost<TodosRegistry>) {
  const channel = new MessageChannel();
  channels.push(channel);
  host.connect(channel.port1 as unknown as never);
  channel.port2.start?.();
  const client = await attachSyncClient({
    registry: todosRegistry,
    port: channel.port2 as unknown as never,
    getToken: async () => ({ accessToken: "t", expiresAt: Date.now() + 3_600_000 }),
  });
  return { client };
}

afterEach(async () => {
  for (const host of hosts) await host.close().catch(() => undefined);
  for (const channel of channels) {
    channel.port1.close();
    channel.port2.close();
  }
  hosts = [];
  channels = [];
});

describe("exportStore RPC round trip (ADR-0035)", () => {
  it("rebuilds the store-backup File tab-side with intact bytes and a well-formed report", async () => {
    const host = await makeHost();
    const { client } = await attach(host);
    await client.ready;

    const { file, report } = await client.exportStore();

    // The dump crossed the bridge as a transferred ArrayBuffer and was rebuilt into a File tab-side.
    expect(file).toBeInstanceOf(File);
    expect(file.name).toMatch(/\.pgdata\.tar\.gz$/);
    expect(file.type).toBe("application/x-gzip");
    // Bytes are intact through the transfer: gzip magic + the size the worker measured pre-transfer.
    const magic = new Uint8Array(await file.arrayBuffer());
    expect([magic[0], magic[1]]).toEqual([0x1f, 0x8b]);
    expect(file.size).toBe(report.byteLength);
    expect(report.reportVersion).toBe(1);
    expect(report.kind).toBe("store-backup");
  });

  it("captures an unflushed write in the backup taken over the bridge", async () => {
    const host = await makeHost();
    const { client } = await attach(host);
    await client.ready;

    // Stage a write via the attach client (RPC to the worker's journal). The worker's convergence tries to
    // flush it to the (dead) write endpoint, so it sits as `sending` — still un-drained, still owed, and
    // still living in the journal/overlay the backup captures. Sum the owed states rather than assuming a
    // specific one.
    await client.tables.todos.create({ id: "22222222-2222-2222-2222-222222222222", title: "unflushed", done: false });
    const owed = (d: { pendingCount: number; sendingCount: number; failedCount: number }) =>
      d.pendingCount + d.sendingCount + d.failedCount;
    expect(owed((await client.diagnostics()).mutation)).toBeGreaterThanOrEqual(1);

    // The export does NOT block on the owed write, and its report captures the same owed state.
    const { report } = await client.exportStore();
    expect(owed(report.diagnostics)).toBeGreaterThanOrEqual(1);
  });
});
