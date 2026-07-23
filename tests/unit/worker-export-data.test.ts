import { afterEach, describe, expect, it } from "bun:test";
// Data export across the bridge (ADR-0035): a REAL in-process engine behind `defineSyncWorker`, driven by
// `attachSyncClient` over a bun `MessageChannel` — NO actual Worker. The worker runs the drain-guarded
// `pg_dump -t` export (with the generated enum header) on its owned client and the portable SQL crosses back
// as a transferred `ArrayBuffer`, rebuilt into a `File` tab-side. WASM-heavy (`pg_dump.wasm`): FULL unit lane
// only (`test:unit`), NOT `test:unit:fast`.

import { PGlite } from "@electric-sql/pglite";
import { dataDir as prepopulatedDataDir } from "@electric-sql/pglite-prepopulatedfs";
import { live } from "@electric-sql/pglite/live";
import { bigint, boolean, pgEnum, uuid, varchar } from "drizzle-orm/pg-core";

import { defineSyncRegistry, defineSyncTable } from "@pgxsinkit/contracts";

import {
  attachSyncClient,
  type ClientPGlite,
  defineSyncWorker,
  type SyncWorkerHost,
} from "../../packages/client/src/index";
import { testStoreAcknowledgment } from "../../packages/client/src/testing";

const todoPriority = pgEnum("todo_priority", ["low", "high"]);

const todosRegistry = defineSyncRegistry({
  todos: defineSyncTable({
    tableName: "todos",
    makeColumns: () => ({
      id: uuid("id").primaryKey(),
      title: varchar("title", { length: 200 }).notNull(),
      priority: todoPriority("priority").notNull(),
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

describe("exportData RPC round trip (ADR-0035)", () => {
  it("rebuilds the portable SQL File tab-side with intact bytes and a data-export report", async () => {
    const { host, pg } = await makeHost();
    const { client } = await attach(host);
    await client.ready;

    // A synced row straight into the worker's physical synced table (no real read path under syncEnabled:false).
    await pg.exec(
      "INSERT INTO todos (id, title, priority, done, updated_at_us) VALUES " +
        "('99999999-9999-9999-9999-999999999999', 'worker-synced', 'high', false, 7)",
    );

    const { file, report } = await client.exportData();

    // The SQL crossed the bridge as a transferred ArrayBuffer and was rebuilt into a File tab-side.
    expect(file).toBeInstanceOf(File);
    expect(file.name).toMatch(/-data\.sql$/);
    expect(file.type).toBe("application/sql");
    expect(file.size).toBe(report.byteLength);
    expect(report.reportVersion).toBe(1);
    expect(report.kind).toBe("data-export");
    expect(report.scope).toBe("synced-tables");
    expect(report.escapeHatch).toBe(false);
    expect(report.tables).toEqual(["todos"]);

    // The portable artefact: the generated enum type header, the synced table, and its row — no machinery.
    const sql = await file.text();
    expect(sql).toContain("CREATE TYPE todo_priority AS ENUM");
    expect(sql).toMatch(/CREATE TABLE[^;]*\btodos\b/);
    expect(sql).toContain("worker-synced");
    expect(sql).not.toContain("todos_overlay");
    expect(sql).not.toContain("reconcile_on_sync");
  });
});
