import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { dataDir as prepopulatedDataDir } from "@electric-sql/pglite-prepopulatedfs";
import { live } from "@electric-sql/pglite/live";
import { bigint, boolean, uuid, varchar } from "drizzle-orm/pg-core";

import {
  defineSyncRegistry,
  defineSyncTable,
  type MutationSummary,
  type SyncTableRegistry,
} from "@pgxsinkit/contracts";

import {
  attachSyncClient,
  type ClientPGlite,
  createSyncClient,
  defineSyncWorker,
  getAllMutationsView,
  type SyncClient,
  type SyncWorkerHost,
} from "../../packages/client/src/index";
import { memoryStoreForTests, testStoreAcknowledgment } from "../../packages/client/src/testing";

// The registry-wide reactive mutation-status API. These tests boot a
// REAL PGlite client (fs- or memory-backed), craft journal transitions across MULTIPLE writable tables via the
// raw handle, and assert `client.mutations.summary/subscribeSummary/list/subscribe` fold the cross-journal
// `pgxsinkit_all_mutations` view correctly — including that the LIVE summary converges after a trigger-style
// delete of an acked row (the correctness win of the generated-view option over runtime state).

const todos = defineSyncTable({
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
});

const notes = defineSyncTable({
  tableName: "notes",
  makeColumns: () => ({
    id: uuid("id").primaryKey(),
    body: varchar("body", { length: 200 }).notNull(),
    updatedAtUs: bigint("updated_at_us", { mode: "bigint" }).notNull(),
  }),
  mode: "readwrite",
  conflictPolicy: "last-write-wins",
  governance: {
    managedFields: [{ column: "updatedAtUs", applyOn: ["create", "update"], strategy: "nowMicroseconds" }],
  },
});

// A readonly-only registry has NO writable journal, so the view is never emitted (zero-writable case).
const readonlyOnly = defineSyncRegistry({
  catalog: defineSyncTable({
    tableName: "catalog",
    makeColumns: () => ({ id: uuid("id").primaryKey(), label: varchar("label", { length: 200 }).notNull() }),
    mode: "readonly",
  }),
});

const multiRegistry = defineSyncRegistry({ todos, notes });

type LooseClient = SyncClient<SyncTableRegistry>;

const DEAD_ELECTRIC = "http://127.0.0.1:1/v1/electric-proxy";
const DEAD_WRITE = "http://127.0.0.1:1/api/mutations";
const TMP_ROOT = path.resolve(process.cwd(), "tmp/agents/mutation-summary");

const openClients: LooseClient[] = [];
const storeDirs: string[] = [];
const hosts: SyncWorkerHost<SyncTableRegistry>[] = [];
const channels: MessageChannel[] = [];

beforeAll(async () => {
  await mkdir(TMP_ROOT, { recursive: true });
});

afterEach(async () => {
  for (const client of openClients.splice(0)) await client.stop().catch(() => undefined);
  for (const host of hosts.splice(0)) await host.close().catch(() => undefined);
  for (const channel of channels.splice(0)) {
    channel.port1.close();
    channel.port2.close();
  }
  for (const dir of storeDirs.splice(0)) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

async function freshStorePath(label: string): Promise<string> {
  const dir = path.join(TMP_ROOT, `${label}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  storeDirs.push(dir);
  await mkdir(dir, { recursive: true });
  return path.join(dir, "store");
}

async function bootFsClient(registry: SyncTableRegistry, storePath: string): Promise<LooseClient> {
  const client = (await createSyncClient({
    registry,
    electricUrl: DEAD_ELECTRIC,
    batchWriteUrl: DEAD_WRITE,
    syncEnabled: false,
    storePath,
  })) as LooseClient;
  openClients.push(client);
  await client.ready;
  return client;
}

async function bootMemoryClient(registry: SyncTableRegistry, label: string): Promise<LooseClient> {
  const client = (await createSyncClient({
    registry,
    electricUrl: DEAD_ELECTRIC,
    batchWriteUrl: DEAD_WRITE,
    syncEnabled: false,
    ...memoryStoreForTests(label),
  })) as LooseClient;
  openClients.push(client);
  await client.ready;
  return client;
}

const ID = (n: number) =>
  `${n}${n}${n}${n}${n}${n}${n}${n}-${n}${n}${n}${n}-${n}${n}${n}${n}-${n}${n}${n}${n}-${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}`;

/** Poll `read()` until `predicate` holds or the deadline; live-query diffs land asynchronously. */
async function waitUntil<T>(read: () => T, predicate: (value: T) => boolean, label: string): Promise<T> {
  const deadline = Date.now() + 3000;
  for (;;) {
    const value = read();
    if (predicate(value)) return value;
    if (Date.now() > deadline) throw new Error(`waitUntil timed out: ${label} — last ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

/** Force one journal row (by table + entity id) into a status via the raw handle. */
async function setStatus(client: LooseClient, journal: string, id: string, status: string): Promise<void> {
  await client.rawExec(`UPDATE ${journal} SET status = '${status}' WHERE entity_key_json = '{"id":"${id}"}';`);
}

describe("registry-wide mutation-status API (slice 4)", () => {
  it("1. the all-mutations view is a runtime object over every writable journal", async () => {
    const storePath = await freshStorePath("view");
    const client = await bootFsClient(multiRegistry, storePath);
    const view = getAllMutationsView(multiRegistry);
    // Both writable journals contribute; a fresh store has zero rows.
    const result = await client.rawQuery("SELECT count(*)::int AS n FROM pgxsinkit_all_mutations");
    expect((result.rows[0] as { n: number }).n).toBe(0);
    // The factory is schema-independent (always TEMP → bare) — one memoized instance.
    expect(getAllMutationsView(multiRegistry)).toBe(view);
  });

  it("2. a global summary subscription observes transitions across MULTIPLE writable tables", async () => {
    const storePath = await freshStorePath("summary");
    const client = await bootFsClient(multiRegistry, storePath);

    let latest: MutationSummary = {
      pendingCount: 0,
      sendingCount: 0,
      ackedCount: 0,
      failedCount: 0,
      rejectedCount: 0,
      conflictedCount: 0,
      quarantinedCount: 0,
      unsettledCount: 0,
      settledCount: 0,
    };
    const sub = await client.mutations.subscribeSummary((summary) => {
      latest = summary;
    });
    latest = sub.initial;
    expect(sub.initial.pendingCount).toBe(0);

    // Two writes on `todos`, one on `notes` → three pending across two tables.
    await client.mutate.create("todos", { id: ID(1), title: "a", done: false });
    await client.mutate.create("todos", { id: ID(2), title: "b", done: false });
    await client.mutate.create("notes", { id: ID(3), body: "c" });
    await waitUntil(
      () => latest,
      (s) => s.pendingCount === 3,
      "3 pending",
    );
    expect(latest.unsettledCount).toBe(3);

    // Drive one of each terminal/in-flight status, spanning both tables' journals.
    await setStatus(client, "todos_mutations", ID(1), "sending");
    await setStatus(client, "todos_mutations", ID(2), "failed");
    await setStatus(client, "notes_mutations", ID(3), "conflicted");
    await waitUntil(
      () => latest,
      (s) => s.sendingCount === 1 && s.failedCount === 1 && s.conflictedCount === 1 && s.pendingCount === 0,
      "one sending/failed/conflicted",
    );
    // pending(0)+sending(1)+failed(1)+conflicted(1)+quarantined(0) unsettled; nothing settled yet.
    expect(latest.unsettledCount).toBe(3);
    expect(latest.settledCount).toBe(0);

    // acked / rejected are the SETTLED complement; quarantined stays UNSETTLED (FIX 3 — owed, user must act).
    await setStatus(client, "todos_mutations", ID(1), "acked");
    await setStatus(client, "todos_mutations", ID(2), "rejected");
    await setStatus(client, "notes_mutations", ID(3), "quarantined");
    await waitUntil(
      () => latest,
      (s) => s.ackedCount === 1 && s.rejectedCount === 1 && s.quarantinedCount === 1,
      "one acked/rejected/quarantined",
    );
    // The one quarantined row bumps `unsettledCount` (it is an owed local edit needing user action), and
    // ONLY acked + rejected are settled.
    expect(latest.unsettledCount).toBe(1);
    expect(latest.settledCount).toBe(2);

    // The reconcile trigger DELETEs acked rows on the synced echo — the LIVE summary must follow that delete
    // (the correctness win of the generated view over runtime state). Simulate the trigger's delete.
    await client.rawExec(`DELETE FROM todos_mutations WHERE status = 'acked';`);
    await waitUntil(
      () => latest,
      (s) => s.ackedCount === 0,
      "acked reconciled away",
    );
    // acked gone → only the rejected row is settled; the quarantined row is still unsettled.
    expect(latest.settledCount).toBe(1);
    expect(latest.unsettledCount).toBe(1);

    sub.unsubscribe();
  });

  it("3. list + normalized details are correct, and filters (table/entityKey/statuses/limit) work", async () => {
    const storePath = await freshStorePath("list");
    const client = await bootFsClient(multiRegistry, storePath);

    await client.mutate.create("todos", { id: ID(1), title: "a", done: false });
    await client.mutate.create("notes", { id: ID(2), body: "b" });
    await setStatus(client, "notes_mutations", ID(2), "failed");

    const all = await client.mutations.list();
    expect(all.length).toBe(2);
    const todosRow = all.find((row) => row.tableName === "todos")!;
    expect(todosRow.entityKey).toEqual({ id: ID(1) });
    expect(todosRow.mutationKind).toBe("create");
    expect(todosRow.status).toBe("pending");
    expect(typeof todosRow.mutationId).toBe("string");

    // Filter: by table.
    expect((await client.mutations.list({ table: "notes" })).map((r) => r.tableName)).toEqual(["notes"]);
    // Filter: by status.
    expect((await client.mutations.list({ statuses: ["failed"] })).map((r) => r.tableName)).toEqual(["notes"]);
    // Filter: by entityKey.
    const byEntity = await client.mutations.list({ entityKey: { id: ID(1) } });
    expect(byEntity.map((r) => r.tableName)).toEqual(["todos"]);
    // Filter: limit.
    expect((await client.mutations.list({ limit: 1 })).length).toBe(1);
  });

  it("4. subscription teardown obeys the live-query manager contract (unsubscribe → no leak)", async () => {
    const storePath = await freshStorePath("teardown");
    const client = await bootFsClient(multiRegistry, storePath);

    const summarySub = await client.mutations.subscribeSummary(() => {});
    const listSub = await client.mutations.subscribe({}, () => {});
    expect((await client.liveQueryDiagnostics()).length).toBeGreaterThan(0);

    summarySub.unsubscribe();
    listSub.unsubscribe();
    // keepAliveMs default 0 → immediate teardown; the manager drains to empty (poll the async snapshot).
    const deadline = Date.now() + 3000;
    let remaining = (await client.liveQueryDiagnostics()).length;
    while (remaining > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 15));
      remaining = (await client.liveQueryDiagnostics()).length;
    }
    expect(remaining).toBe(0);
  });

  it("5. the view exists after a warm fingerprint-skipped boot (ephemeral, always re-applied)", async () => {
    const storePath = await freshStorePath("warm");

    const bootA = await bootFsClient(multiRegistry, storePath);
    await bootA.mutate.create("todos", { id: ID(1), title: "persisted", done: false });
    const indexA = openClients.indexOf(bootA);
    if (indexA >= 0) openClients.splice(indexA, 1);
    await bootA.stop();

    const bootB = await bootFsClient(multiRegistry, storePath);
    const reportB = (await bootB.bootReport())!;
    expect(reportB.warmBoot.schemaSkipped).toBe(true);
    // The TEMP view was recreated by the always-applied ephemeral schema on this fresh engine — the summary
    // reads the persisted pending write straight away.
    const summary = await bootB.mutations.summary();
    expect(summary.pendingCount).toBe(1);
  });

  it("6. a registry with no writable table returns empty shapes without touching the (absent) view", async () => {
    const client = await bootMemoryClient(readonlyOnly, "readonly-only");
    const summary = await client.mutations.summary();
    expect(summary).toEqual({
      pendingCount: 0,
      sendingCount: 0,
      ackedCount: 0,
      failedCount: 0,
      rejectedCount: 0,
      conflictedCount: 0,
      quarantinedCount: 0,
      unsettledCount: 0,
      settledCount: 0,
    });
    expect(await client.mutations.list()).toEqual([]);
    const sub = await client.mutations.subscribeSummary(() => {});
    expect(sub.initial.unsettledCount).toBe(0);
    sub.unsubscribe();
    // The view genuinely does not exist — a raw probe fails, proving the API short-circuited by the registry.
    let probeThrew = false;
    try {
      await client.rawQuery("SELECT 1 FROM pgxsinkit_all_mutations");
    } catch {
      probeThrew = true;
    }
    expect(probeThrew).toBe(true);
  });
});

describe("registry-wide mutation-status API — worker parity (slice 4)", () => {
  async function makeHost(): Promise<SyncWorkerHost<SyncTableRegistry>> {
    const pg = await PGlite.create({ loadDataDir: await prepopulatedDataDir(), extensions: { live } });
    const host = defineSyncWorker({
      registry: multiRegistry,
      electricUrl: DEAD_ELECTRIC,
      batchWriteUrl: DEAD_WRITE,
      ...testStoreAcknowledgment(),
      precreatedPglite: Promise.resolve(pg as unknown as ClientPGlite),
      syncEnabled: false,
      installGlobal: false,
      convergenceIntervalMs: 10_000_000,
    }) as unknown as SyncWorkerHost<SyncTableRegistry>;
    hosts.push(host);
    return host;
  }

  async function attach(host: SyncWorkerHost<SyncTableRegistry>): Promise<LooseClient> {
    const channel = new MessageChannel();
    channels.push(channel);
    host.connect(channel.port1 as unknown as never);
    channel.port2.start?.();
    const client = (await attachSyncClient({
      registry: multiRegistry,
      port: channel.port2 as unknown as never,
      getToken: async () => ({ accessToken: "t", expiresAt: Date.now() + 3_600_000 }),
    })) as LooseClient;
    await client.ready;
    return client;
  }

  it("7. worker-attached client mutations behave identically (summary + live + list over the bridge)", async () => {
    const host = await makeHost();
    const client = await attach(host);

    let latest: MutationSummary | null = null;
    const sub = await client.mutations.subscribeSummary((summary) => {
      latest = summary;
    });
    latest = sub.initial;

    // The worker auto-flushes on enqueue; against the dead write URL the two writes settle to an unsettled
    // status (pending/sending/failed), so assert on the status-agnostic `unsettledCount` for parity.
    await client.mutate.create("todos", { id: ID(1), title: "a", done: false });
    await client.mutate.create("notes", { id: ID(2), body: "b" });
    await waitUntil(
      () => latest,
      (s): boolean => s != null && s.unsettledCount === 2,
      "worker: 2 unsettled",
    );

    // One-shot summary and list route over the same `rawQuery` RPC — no new bridge message.
    const oneShot = await client.mutations.summary();
    expect(oneShot.unsettledCount).toBe(2);
    const details = await client.mutations.list({ table: "todos" });
    expect(details.map((r) => r.tableName)).toEqual(["todos"]);

    // Craft a deterministic transition via the worker's rawExec RPC; the live summary converges over the bridge.
    await client.rawExec(
      `UPDATE notes_mutations SET status = 'quarantined' WHERE entity_key_json = '{"id":"${ID(2)}"}';`,
    );
    await waitUntil(
      () => latest,
      (s): boolean => s != null && s.quarantinedCount === 1,
      "worker: 1 quarantined",
    );
    // FIX 3: quarantining does NOT reduce `unsettledCount` — a quarantined write is an owed local edit still
    // needing user action, so both writes remain unsettled and nothing is settled.
    expect(latest!.unsettledCount).toBe(2);
    expect(latest!.settledCount).toBe(0);

    sub.unsubscribe();
  });
});
