import { afterEach, describe, expect, it } from "bun:test";
// Per-group readiness (ADR-0032 decision 6 / S2 §5) at two levels:
//   1. `startConfiguredSync` surfaces a per-group `groupReady` promise + `isGroupReady`, while the all-eager
//      `onInitialSync` gate still waits for EVERY eager group — driven here by a fake electric namespace.
//   2. The worker-attached client's `client.groupReady(table)` resolves off the bridge `groupReady` event.

import { pgTable, uuid } from "drizzle-orm/pg-core";

import type { SyncConfigInput, SyncTableRegistry } from "@pgxsinkit/contracts";

import { attachSyncClient, identityCodec, isBridgeEnvelope, postBridgeMessage } from "../../packages/client/src/index";
import { startConfiguredSync } from "../../packages/client/src/shape-sync";
import { PLACEMENT_QUERY_KEY, PLACEMENT_RESULT_KEY } from "../../packages/client/src/worker/define-sync-worker";

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

const syncConfig: SyncConfigInput = {
  electricUrl: "http://127.0.0.1:1/v1/shape",
  localSchema: "public",
  tables: {
    a: {
      mode: "readonly",
      primaryKey: { columns: ["id"] },
      shape: { tableName: "a", shapeKey: "a-shape" },
      consistencyGroup: "groupA",
      clientProjection: { syncedTable: "a" },
    },
    b: {
      mode: "readonly",
      primaryKey: { columns: ["id"] },
      shape: { tableName: "b", shapeKey: "b-shape" },
      consistencyGroup: "groupB",
      clientProjection: { syncedTable: "b" },
    },
    c: {
      mode: "readonly",
      primaryKey: { columns: ["id"] },
      shape: { tableName: "c", shapeKey: "c-shape" },
      consistencyGroup: "groupC",
      subscription: "lazy",
      clientProjection: { syncedTable: "c" },
    },
  },
};

describe("startConfiguredSync per-group readiness (ADR-0032 decision 6)", () => {
  it("resolves groupReady per group while `ready` still awaits every eager group; a lazy group waits for activation", async () => {
    const groupInitial = new Map<string, () => void>();
    const fakePg = {
      electric: {
        initMetadataTables: async () => undefined,
        syncShapesToTables: async (opts: { key: string; onInitialSync?: () => void }) => {
          if (opts.onInitialSync) groupInitial.set(opts.key, opts.onInitialSync);
          return { unsubscribe: () => undefined, isUpToDate: false, streams: {} };
        },
      },
    };

    let bootReady = false;
    const result = await startConfiguredSync(fakePg as never, {
      syncConfig,
      registry: {} as SyncTableRegistry,
      onInitialSync: () => {
        bootReady = true;
      },
    });

    expect(result.groupKeys().sort()).toEqual(["groupA", "groupB", "groupC"]);
    expect(result.isGroupReady("groupA")).toBe(false);
    expect(bootReady).toBe(false);

    // groupA catches up → its groupReady resolves, but the boot gate still awaits groupB.
    groupInitial.get("groupA")!();
    await result.groupReady("groupA");
    expect(result.isGroupReady("groupA")).toBe(true);
    expect(bootReady).toBe(false);

    // groupB catches up → all eager groups ready → the boot gate fires.
    groupInitial.get("groupB")!();
    await result.groupReady("groupB");
    expect(bootReady).toBe(true);

    // The lazy groupC's readiness stays pending until it is activated on demand.
    let cReady = false;
    void result.groupReady("groupC").then(() => {
      cReady = true;
    });
    await tick();
    expect(cReady).toBe(false);
    expect(result.isGroupReady("groupC")).toBe(false);

    await result.ensureGroupStarted("groupC");
    groupInitial.get("groupC")!();
    await result.groupReady("groupC");
    expect(cReady).toBe(true);
  });
});

// ─── Attach-client groupReady over a raw channel (no real worker) ────────────────────────────────────

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
afterEach(() => {
  for (const channel of openChannels) {
    channel.port1.close();
    channel.port2.close();
  }
  openChannels = [];
});

describe("attach client groupReady over the bridge (ADR-0032 decision 6/7)", () => {
  it("resolves client.groupReady(table) when the worker broadcasts the group's readiness", async () => {
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
        postBridgeMessage(worker as never, identityCodec, "event", {
          kind: "status",
          status: { phase: "ready", isRunning: true },
        });
      }
    });
    worker.start?.();

    const client = await attachSyncClient({ registry: attachRegistry, port: channel.port2 as unknown as never });
    await client.ready;

    let ready = false;
    void client.groupReady("todos").then(() => {
      ready = true;
    });
    await tick();
    expect(ready).toBe(false);

    // The group key for `todos` is its shapeKey (no consistencyGroup) — the worker broadcasts readiness for it.
    postBridgeMessage(worker as never, identityCodec, "event", { kind: "groupReady", groupKey: "todos-shape" });
    await tick();
    expect(ready).toBe(true);
  });
});

// ─── `ready` matches the in-process contract (ADR-0032 FIX 3) ────────────────────────────────────────

describe("attach client `ready` contract over the bridge (ADR-0032 FIX 3)", () => {
  it("resolves `ready` ONLY on phase 'ready' — not on 'auth-needed'/'degraded'", async () => {
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
      // Ack the attach but send NO status yet — the test drives status phases by hand below.
      if (data.type === "attach") {
        postBridgeMessage(worker as never, identityCodec, "attach-ack", { alreadyBooted: false });
      }
    });
    worker.start?.();

    const client = await attachSyncClient({ registry: attachRegistry, port: channel.port2 as unknown as never });
    let resolved = false;
    void client.ready.then(() => {
      resolved = true;
    });
    await tick();
    expect(resolved).toBe(false); // ack alone does not resolve ready

    // auth-needed must NOT resolve ready (an engine stuck retrying auth keeps ready pending, as in-process).
    postBridgeMessage(worker as never, identityCodec, "event", {
      kind: "status",
      status: { phase: "auth-needed", isRunning: true },
    });
    await tick();
    expect(resolved).toBe(false);

    // phase "ready" resolves it.
    postBridgeMessage(worker as never, identityCodec, "event", {
      kind: "status",
      status: { phase: "ready", isRunning: true },
    });
    await tick();
    expect(resolved).toBe(true);
  });

  it("a late attach acked with engineReady:true resolves `ready` even if the next status is 'degraded'", async () => {
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
      // A late attach: the engine's monotonic `ready` had already fired, so the ack carries engineReady.
      if (data.type === "attach") {
        postBridgeMessage(worker as never, identityCodec, "attach-ack", { alreadyBooted: true, engineReady: true });
      }
    });
    worker.start?.();

    const client = await attachSyncClient({ registry: attachRegistry, port: channel.port2 as unknown as never });
    let resolved = false;
    void client.ready.then(() => {
      resolved = true;
    });
    await tick();
    expect(resolved).toBe(true); // resolved straight from the ack's engineReady

    // A later degraded status must not un-resolve the monotonic ready.
    postBridgeMessage(worker as never, identityCodec, "event", {
      kind: "status",
      status: { phase: "degraded", isRunning: true },
    });
    await tick();
    expect(resolved).toBe(true);
  });
});

describe("failed subscribe rejects the tab waiter (ADR-0032 FIX 2)", () => {
  it("rejects subscribeLiveRows on a failed subscribe and leaves no orphaned diff handler", async () => {
    const channel = new MessageChannel();
    openChannels.push(channel);
    const worker = channel.port1;
    let capturedQueryId: string | undefined;
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
        postBridgeMessage(worker as never, identityCodec, "event", {
          kind: "status",
          status: { phase: "ready", isRunning: true },
        });
        return;
      }
      if (data.type === "subscribe") {
        const sub = identityCodec.decode(data.payload) as { queryId: string };
        capturedQueryId = sub.queryId;
        // The worker reports a FAILED subscribe as an `rpc-result` correlated by the subscribe's envelope
        // id (it has no client to hand an initial snapshot) — exactly what `handleSubscribe`'s catch posts.
        postBridgeMessage(
          worker as never,
          identityCodec,
          "rpc-result",
          { ok: false, error: { message: "invalid sql xyz" } },
          data.id,
        );
      }
    });
    worker.start?.();

    const client = await attachSyncClient({ registry: attachRegistry, port: channel.port2 as unknown as never });
    await client.ready;

    let calls = 0;
    // try/catch rather than `expect().rejects` — a `MessageChannel`-driven rejection does not settle a
    // bun `expect(...).rejects` matcher here, but a plain await/catch observes it correctly.
    let rejectedMessage = "";
    try {
      await client.subscribeLiveRows({ sql: "SELECT bad", params: [], pkColumns: ["id"] }, () => {
        calls++;
      });
    } catch (error) {
      rejectedMessage = (error as Error).message;
    }
    expect(rejectedMessage).toContain("invalid sql xyz");

    // No orphaned diff handler survived the rejection: a late live-diff for that queryId is a no-op.
    postBridgeMessage(worker as never, identityCodec, "live-diff", {
      queryId: capturedQueryId,
      order: [],
      added: [],
      changed: [],
      removed: [],
    });
    await tick();
    expect(calls).toBe(0);
  });
});

describe("late tab merges status.groups from the attach snapshot (ADR-0032 FIX 4)", () => {
  it("resolves client.groupReady off the merged snapshot with NO discrete groupReady event", async () => {
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
        // A LATE attach: the engine already fired ready and the group already reached its floor BEFORE this
        // tab connected, so only the status SNAPSHOT (`status.groups`) carries the edge — no discrete
        // `groupReady` event is ever sent for it.
        postBridgeMessage(worker as never, identityCodec, "attach-ack", { alreadyBooted: true, engineReady: true });
        postBridgeMessage(worker as never, identityCodec, "event", {
          kind: "status",
          status: { phase: "ready", isRunning: true, groups: { "todos-shape": true } },
        });
      }
    });
    worker.start?.();

    const client = await attachSyncClient({ registry: attachRegistry, port: channel.port2 as unknown as never });
    await client.ready; // resolves via the ack's engineReady + the phase-"ready" status

    let groupResolved = false;
    void client.groupReady("todos").then(() => {
      groupResolved = true;
    });
    await tick();
    expect(groupResolved).toBe(true); // merged from status.groups, not from a groupReady edge
  });
});
