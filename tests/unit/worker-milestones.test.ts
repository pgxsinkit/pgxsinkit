import { afterEach, describe, expect, it } from "bun:test";
// ADR-0041 stage 2 — boot milestones over the worker bridge. Two tiers:
//   1. PROTOCOL tier (hand-driven worker port, no engine): the tab's `localReadReady`/`writeReady`/
//      `bootSettled` promises resolve off the attach-ack fold (late attach) AND off the `milestone`/
//      `milestone-error` broadcasts (attached-when-it-crosses), and a tail failure rejects the downstream
//      stages while the ALREADY-RESOLVED attach + `localReadReady` are unaffected.
//   2. REAL-ENGINE tier (defineSyncWorker over a memory PGlite, no real Worker): the attach-ack is observed
//      BEFORE the milestone broadcasts (message-order proof), and a write issued the instant attach resolves
//      — before the engine's `writeReady` — completes once the write runtime is up, with no error and no hang.

import type { PGlite } from "@electric-sql/pglite";
import { bigint, boolean, uuid, varchar } from "drizzle-orm/pg-core";
import { pgTable } from "drizzle-orm/pg-core";

import { defineSyncRegistry, defineSyncTable, type SyncTableRegistry } from "@pgxsinkit/contracts";

import {
  attachSyncClient,
  type BridgeEnvelope,
  defineSyncWorker,
  getReadModelView,
  identityCodec,
  isBridgeEnvelope,
  postBridgeMessage,
  type SyncWorkerHost,
} from "../../packages/client/src/index";
import { memoryStoreForTests } from "../../packages/client/src/testing";
import { PLACEMENT_QUERY_KEY, PLACEMENT_RESULT_KEY } from "../../packages/client/src/worker/define-sync-worker";
import { drizzleOver } from "../support/drizzle";

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

// A minimal registry for the hand-driven (no-engine) protocol tier — only its shape is used tab-side.
const todos = pgTable("todos", { id: uuid("id").primaryKey() });
const attachRegistry = {
  todos: {
    table: todos,
    mode: "readonly",
    primaryKey: { columns: ["id"] },
    shape: { tableName: "todos", shapeKey: "todos-shape" },
    clientProjection: { syncedTable: "todos" },
  },
} as unknown as SyncTableRegistry;

let openChannels: MessageChannel[] = [];
let hosts: SyncWorkerHost<never>[] = [];
afterEach(async () => {
  for (const host of hosts) await (host as unknown as SyncWorkerHost<SyncTableRegistry>).close().catch(() => undefined);
  for (const channel of openChannels) {
    channel.port1.close();
    channel.port2.close();
  }
  hosts = [];
  openChannels = [];
});

// ─── PROTOCOL tier — hand-driven worker port ───────────────────────────────────────────────────────

describe("ADR-0041 stage 2: milestones fold into a late attach's ack", () => {
  it("attach after writeReady + bootSettled crossed → both stages resolve straight from the ack", async () => {
    const channel = new MessageChannel();
    openChannels.push(channel);
    const worker = channel.port1;
    worker.addEventListener("message", (event) => {
      const data = (event as MessageEvent).data;
      // Answer the placement query (the attach flow awaits the reply before its handshake, ADR-0050).
      if (
        typeof data === "object" &&
        data !== null &&
        (data as Record<string, unknown>)[PLACEMENT_QUERY_KEY] === true
      ) {
        worker.postMessage({
          [PLACEMENT_RESULT_KEY]: { engineHome: "shared-worker", electionRequired: false, swInstanceId: "sw-fixture" },
        });
        return;
      }
      if (!isBridgeEnvelope(data)) return;
      // A LATE attach: the engine already crossed both background stages before this tab connected, so the
      // ack carries the fold — there is no milestone broadcast to catch.
      if (data.type === "attach") {
        postBridgeMessage(worker as never, identityCodec, "attach-ack", {
          alreadyBooted: true,
          engineReady: true,
          writeReady: true,
          bootSettled: true,
        });
      }
    });
    worker.start?.();

    const client = await attachSyncClient({ registry: attachRegistry, port: channel.port2 as unknown as never });
    const settled: string[] = [];
    void client.localReadReady.then(() => settled.push("localReadReady"));
    void client.writeReady.then(() => settled.push("writeReady"));
    void client.bootSettled.then(() => settled.push("bootSettled"));
    await tick();
    expect(settled.sort()).toEqual(["bootSettled", "localReadReady", "writeReady"]);
    // No throw on any stage — all resolved, none rejected.
    await Promise.all([client.localReadReady, client.writeReady, client.bootSettled]);
  });
});

describe("ADR-0041 stage 2: milestone broadcasts resolve the stages after attach", () => {
  it("localReadReady at ack; writeReady then bootSettled resolve as their milestones arrive", async () => {
    const channel = new MessageChannel();
    openChannels.push(channel);
    const worker = channel.port1;
    worker.addEventListener("message", (event) => {
      const data = (event as MessageEvent).data;
      // Answer the placement query (the attach flow awaits the reply before its handshake, ADR-0050).
      if (
        typeof data === "object" &&
        data !== null &&
        (data as Record<string, unknown>)[PLACEMENT_QUERY_KEY] === true
      ) {
        worker.postMessage({
          [PLACEMENT_RESULT_KEY]: { engineHome: "shared-worker", electionRequired: false, swInstanceId: "sw-fixture" },
        });
        return;
      }
      if (!isBridgeEnvelope(data)) return;
      // The FIRST (booting) attach: ack at localReadReady, NO milestone fold — they broadcast as the tail crosses.
      if (data.type === "attach") {
        postBridgeMessage(worker as never, identityCodec, "attach-ack", { alreadyBooted: false });
      }
    });
    worker.start?.();

    const client = await attachSyncClient({ registry: attachRegistry, port: channel.port2 as unknown as never });
    const stages = { local: false, write: false, boot: false };
    void client.localReadReady.then(() => (stages.local = true));
    void client.writeReady.then(() => (stages.write = true));
    void client.bootSettled.then(() => (stages.boot = true));
    await tick();
    // The ack resolved localReadReady; the background stages are still pending.
    expect(stages).toEqual({ local: true, write: false, boot: false });

    postBridgeMessage(worker as never, identityCodec, "event", { kind: "milestone", stage: "writeReady" });
    await tick();
    expect(stages).toEqual({ local: true, write: true, boot: false });

    postBridgeMessage(worker as never, identityCodec, "event", { kind: "milestone", stage: "bootSettled" });
    await tick();
    expect(stages).toEqual({ local: true, write: true, boot: true });
  });
});

describe("ADR-0041 stage 2: a tail failure rejects the downstream stages, not the attach", () => {
  it("milestone-error rejects writeReady + bootSettled; localReadReady + the resolved attach are unaffected", async () => {
    const channel = new MessageChannel();
    openChannels.push(channel);
    const worker = channel.port1;
    worker.addEventListener("message", (event) => {
      const data = (event as MessageEvent).data;
      // Answer the placement query (the attach flow awaits the reply before its handshake, ADR-0050).
      if (
        typeof data === "object" &&
        data !== null &&
        (data as Record<string, unknown>)[PLACEMENT_QUERY_KEY] === true
      ) {
        worker.postMessage({
          [PLACEMENT_RESULT_KEY]: { engineHome: "shared-worker", electionRequired: false, swInstanceId: "sw-fixture" },
        });
        return;
      }
      if (!isBridgeEnvelope(data)) return;
      if (data.type === "attach") {
        postBridgeMessage(worker as never, identityCodec, "attach-ack", { alreadyBooted: false });
      }
    });
    worker.start?.();

    // The attach itself RESOLVED (the engine reached localReadReady) — this must not throw.
    const client = await attachSyncClient({ registry: attachRegistry, port: channel.port2 as unknown as never });
    let localReadResolved = false;
    void client.localReadReady.then(() => (localReadResolved = true));
    await tick();
    expect(localReadResolved).toBe(true);

    // The engine's background write/sync tail fails → both downstream stages fail over the bridge.
    postBridgeMessage(worker as never, identityCodec, "event", {
      kind: "milestone-error",
      stage: "writeReady",
      error: { message: "boot tail failed: recovery blew up" },
    });
    postBridgeMessage(worker as never, identityCodec, "event", {
      kind: "milestone-error",
      stage: "bootSettled",
      error: { message: "boot tail failed: recovery blew up" },
    });
    await tick();

    let writeErr = "";
    let bootErr = "";
    await client.writeReady.catch((e: unknown) => (writeErr = (e as Error).message));
    await client.bootSettled.catch((e: unknown) => (bootErr = (e as Error).message));
    expect(writeErr).toContain("recovery blew up");
    expect(bootErr).toContain("recovery blew up");
    // localReadReady stayed resolved — the read facade is usable even though the tail failed.
    expect(localReadResolved).toBe(true);
  });
});

// ─── REAL-ENGINE tier — defineSyncWorker over a memory PGlite (no real Worker) ───────────────────────

const engineRegistry = defineSyncRegistry({
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
type EngineRegistry = typeof engineRegistry;

function makeEngineHost(): SyncWorkerHost<EngineRegistry> {
  const host = defineSyncWorker({
    registry: engineRegistry,
    electricUrl: "http://127.0.0.1:1/v1/electric-proxy",
    batchWriteUrl: "http://127.0.0.1:1/api/mutations",
    syncEnabled: false,
    installGlobal: false,
    convergenceIntervalMs: 10_000_000,
  });
  hosts.push(host as unknown as SyncWorkerHost<never>);
  return host;
}

describe("ADR-0041 stage 2: real engine — attach-ack precedes the milestone broadcasts", () => {
  it("the attach-ack is observed before any writeReady/bootSettled milestone (message-order proof)", async () => {
    const host = makeEngineHost();
    const channel = new MessageChannel();
    openChannels.push(channel);
    host.connect(channel.port1 as unknown as never);
    const seen: BridgeEnvelope[] = [];
    channel.port2.addEventListener("message", (event) => {
      const data = (event as MessageEvent).data;
      if (isBridgeEnvelope(data)) seen.push(data as BridgeEnvelope);
    });
    channel.port2.start?.();

    const client = await attachSyncClient({
      registry: engineRegistry,
      port: channel.port2 as unknown as never,
      ...memoryStoreForTests("milestones-order"),
      getToken: async () => ({ accessToken: "t", expiresAt: Date.now() + 3_600_000 }),
    });
    // Both background stages cross once the engine's tail runs (syncEnabled:false → no catch-up wait).
    await client.writeReady;
    await client.bootSettled;
    await tick();

    const ackIndex = seen.findIndex((e) => e.type === "attach-ack");
    const milestoneIndices = seen
      .map((e, i) => ({ e, i }))
      .filter(
        ({ e }) => e.type === "event" && (identityCodec.decode(e.payload) as { kind: string }).kind === "milestone",
      )
      .map(({ i }) => i);
    expect(ackIndex).toBeGreaterThanOrEqual(0);
    expect(milestoneIndices.length).toBeGreaterThan(0);
    // The ack (local-read readiness) is delivered strictly before any background-stage milestone.
    for (const mi of milestoneIndices) expect(ackIndex).toBeLessThan(mi);
  });
});

describe("ADR-0041 stage 2: real engine — a write issued the instant attach resolves completes", () => {
  it("a worker write posted before the engine's writeReady completes with no error and no hang", async () => {
    const host = makeEngineHost();
    const channel = new MessageChannel();
    openChannels.push(channel);
    host.connect(channel.port1 as unknown as never);
    channel.port2.start?.();

    const client = await attachSyncClient({
      registry: engineRegistry,
      port: channel.port2 as unknown as never,
      ...memoryStoreForTests("milestones-write"),
      getToken: async () => ({ accessToken: "t", expiresAt: Date.now() + 3_600_000 }),
    });
    // The instant attach resolves (= localReadReady), issue a write. The engine's write method awaits its
    // OWN writeReady internally, so this must complete once the write runtime is up — never throw, never hang.
    // Guard "no hang" with a bound: the write must settle well within it.
    const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("write hung")), 10_000));
    await Promise.race([
      client.tables.todos.create({
        id: "11111111-1111-1111-1111-111111111111",
        title: "written before writeReady",
        done: false,
      }),
      timeout,
    ]);
    // The row landed in the engine's real (memory) store, proving the write actually ran (not a silent no-op).
    const readModel = getReadModelView(engineRegistry, "todos");
    const workerClient = await host.whenBooted();
    const rows = await drizzleOver(workerClient.pglite as unknown as PGlite)
      .select({ id: readModel.id })
      .from(readModel);
    expect(rows.map((r) => r.id)).toContain("11111111-1111-1111-1111-111111111111");
  });
});
