import { afterEach, describe, expect, it } from "bun:test";
// Restore across the bridge (ADR-0035 decision 6). A REAL in-process engine behind `defineSyncWorker`, driven
// by `attachSyncClient` over a bun `MessageChannel` — NO actual Worker. Restore rides the FIRST (boot) attach:
// the backup is decomposed into a transferred `ArrayBuffer` + mime (`RestoreArtefactWire`) tab-side and the
// worker recomposes a Blob for `createSyncClient`. A restore attach onto an already-booted engine is refused.

import { bigint, boolean, uuid, varchar } from "drizzle-orm/pg-core";

import { defineSyncRegistry, defineSyncTable } from "@pgxsinkit/contracts";

import {
  attachSyncClient,
  createSyncClient,
  defineSyncWorker,
  type SyncClient,
  type SyncWorkerHost,
} from "../../packages/client/src/index";
import { memoryStoreForTests } from "../../packages/client/src/testing";

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

const DEAD_ELECTRIC = "http://127.0.0.1:1/v1/electric-proxy";
const DEAD_WRITE = "http://127.0.0.1:1/api/mutations";
const STAGED_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";

let hosts: SyncWorkerHost<TodosRegistry>[] = [];
let channels: MessageChannel[] = [];
let sources: SyncClient<TodosRegistry>[] = [];

afterEach(async () => {
  for (const source of sources) await source.stop().catch(() => undefined);
  for (const host of hosts) await host.close().catch(() => undefined);
  for (const channel of channels) {
    channel.port1.close();
    channel.port2.close();
  }
  hosts = [];
  channels = [];
  sources = [];
});

/** A memory-backed worker host with a memory storePath — NO precreated store, so restore owns the create. */
function makeHost(): SyncWorkerHost<TodosRegistry> {
  const host = defineSyncWorker({
    registry: todosRegistry,
    electricUrl: DEAD_ELECTRIC,
    batchWriteUrl: DEAD_WRITE,
    // Acknowledge the memory backend the attach selects (ADR-0036); the worker's own boot honours it.
    ...memoryStoreForTests("worker-restore-store"),
    syncEnabled: false,
    installGlobal: false,
    convergenceIntervalMs: 10_000_000,
  });
  hosts.push(host);
  return host;
}

/** Produce a store backup carrying one staged unflushed write (a `pending` journal/overlay row). */
async function makeBackupWithStagedWrite(): Promise<Blob> {
  const source = await createSyncClient<TodosRegistry>({
    registry: todosRegistry,
    electricUrl: DEAD_ELECTRIC,
    batchWriteUrl: DEAD_WRITE,
    syncEnabled: false,
    ...memoryStoreForTests("worker-restore-src"),
  });
  sources.push(source);
  await source.ready;
  await source.mutate.create("todos", { id: STAGED_ID, title: "staged", done: false });
  expect((await source.diagnostics()).mutation.pendingCount).toBe(1);
  const { file } = await source.exportStore();
  return file;
}

async function attach(host: SyncWorkerHost<TodosRegistry>, extra: { restoreFrom?: Blob } = {}) {
  const channel = new MessageChannel();
  channels.push(channel);
  host.connect(channel.port1 as unknown as never);
  channel.port2.start?.();
  return attachSyncClient({
    registry: todosRegistry,
    port: channel.port2 as unknown as never,
    getToken: async () => ({ accessToken: "t", expiresAt: Date.now() + 3_600_000 }),
    // A memory attach carries the storePath + memory marker over the bridge (ADR-0036).
    ...memoryStoreForTests("worker-restore-store"),
    ...(extra.restoreFrom ? { restoreFrom: extra.restoreFrom } : {}),
  });
}

describe("restore over the worker bridge (ADR-0035 decision 6)", () => {
  it("restore via the FIRST attach round-trips: boots offline, recovered journal quarantined", async () => {
    const backup = await makeBackupWithStagedWrite();
    const host = makeHost();
    const client = await attach(host, { restoreFrom: backup });
    await client.ready;

    // The recovered `pending` write was quarantined during the restore boot (over the bridge, worker-side).
    const diag = (await client.diagnostics()).mutation;
    expect(diag.quarantinedCount).toBe(1);
    expect(diag.pendingCount).toBe(0);

    // Offline: sync-disabled `ready`, no read-stream error surfaced on the mirrored status.
    expect(client.status.phase).toBe("ready");
    expect(client.status.lastError).toBeUndefined();
  });

  it("refuses a restore attach onto an ALREADY-booted engine with a typed attach error", async () => {
    const backup = await makeBackupWithStagedWrite();
    const host = makeHost();
    // First a normal attach boots the engine (no restore).
    const first = await attach(host);
    await first.ready;

    // A SECOND attach that carries a restore cannot seed a live store — the attach must reject.
    // oxlint-disable-next-line typescript/await-thenable -- bun-types gap: .resolves/.rejects matchers return a real promise typed as void
    await expect(attach(host, { restoreFrom: backup })).rejects.toThrow(/cannot restore into a running store/);
  });
});
