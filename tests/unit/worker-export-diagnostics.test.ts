import { afterEach, describe, expect, it } from "bun:test";
// Diagnostic dump across the bridge (ADR-0035): a REAL in-process engine behind `defineSyncWorker`, driven
// by `attachSyncClient` over a bun `MessageChannel` — NO actual Worker. The worker runs the throwaway-clone
// dump on its owned client and the SQL crosses back as a transferred `ArrayBuffer`, rebuilt into a `File`
// tab-side. WASM-heavy (`pg_dump.wasm`): FULL unit lane only (`test:unit`), NOT `test:unit:fast`.

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
import { migrateSubscriptionMetadataTables } from "../../packages/client/src/sync/subscription-state";
import { DEFAULT_METADATA_SCHEMA } from "../../packages/client/src/sync/tags";
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

async function makeHost(): Promise<{ host: SyncWorkerHost<TodosRegistry>; pg: PGlite }> {
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
  return { host, pg };
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

describe("exportDiagnostics RPC round trip (ADR-0035)", () => {
  it("rebuilds the SQL File tab-side with intact bytes and a diagnostic-dump report", async () => {
    const { host, pg } = await makeHost();
    const { client } = await attach(host);
    await client.ready;

    // Stage a write via the attach client (RPC to the worker's journal) so the dump carries journal
    // evidence, and provision the metadata schema worker-side exactly as first sync would.
    await client.tables.todos.create({
      id: "44444444-4444-4444-4444-444444444444",
      title: "worker-unflushed",
      done: false,
    });
    await migrateSubscriptionMetadataTables({ pg, metadataSchema: DEFAULT_METADATA_SCHEMA });

    const { file, report } = await client.exportDiagnostics();

    // The SQL crossed the bridge as a transferred ArrayBuffer and was rebuilt into a File tab-side.
    expect(file).toBeInstanceOf(File);
    expect(file.name).toMatch(/-diagnostics\.sql$/);
    expect(file.type).toBe("application/sql");
    // Bytes are intact through the transfer, and the size matches what the worker measured pre-transfer.
    const sql = await file.text();
    expect(file.size).toBe(report.byteLength);
    expect(report.reportVersion).toBe(1);
    expect(report.kind).toBe("diagnostic-dump");
    expect(report.scope).toBe("everything");

    // The dump is the real store's SQL: the synced table, its journal, the staged write, and the metadata.
    expect(sql).toMatch(/CREATE TABLE[^;]*\btodos\b/);
    expect(sql).toContain("todos_mutations");
    expect(sql).toContain("worker-unflushed");
    expect(sql).toContain("subscriptions_metadata");
  });
});
