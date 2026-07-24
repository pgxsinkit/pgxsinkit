import { afterEach, describe, expect, it } from "bun:test";
// Tab-side detach settlement + pre-handshake page cleanup (ADR-0040 P2 fix round).
//
// `detachFromWorker` (explicit `stop()` OR a terminal `pagehide`) tears down the port listener, so any tab
// operation still awaiting a worker reply would hang forever unless detach settles it. This suite pins:
//   FIX 2 — a `stop()` racing an in-flight `rpc` / an awaiting `subscribeLiveRows` rejects the caller with the
//           detach error (data-promising ops fail rather than fabricate), and new ops after `stop()` reject at
//           once; the worker-side pending subscribe is cancelled (`unsubscribe` + `detach` are posted).
//   FIX 3 — the `pagehide` listener is installed BEFORE the attach handshake, so a terminal `pagehide` DURING a
//           slow boot posts `detach` and rejects the pending `attachSyncClient` (never a silent hung boot).
//
// Driven over a raw `MessageChannel` whose worker side is a MANUAL responder (no real engine), so reply timing
// — and, for FIX 2b, deliberately withholding `live-initial` — is fully controllable.

import { pgTable, uuid } from "drizzle-orm/pg-core";

import type { SyncTableRegistry } from "@pgxsinkit/contracts";

import {
  attachSyncClient,
  ClientDisposedError,
  identityCodec,
  isBridgeEnvelope,
  postBridgeMessage,
} from "../../packages/client/src/index";
import { PLACEMENT_QUERY_KEY, PLACEMENT_RESULT_KEY } from "../../packages/client/src/worker/define-sync-worker";

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

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

/**
 * A manual worker-side responder on `port1`: acks the attach + drives phase "ready" so `client.ready`
 * resolves, records every envelope type it receives, and — for the subscribe-race case — WITHHOLDS
 * `live-initial` (never replying) so the tab stays pending until detach settles it.
 */
function manualWorker(port: MessagePort): { received: Array<{ type: string; payload: unknown }> } {
  const received: Array<{ type: string; payload: unknown }> = [];
  port.addEventListener("message", (event) => {
    const data = (event as MessageEvent).data;
    // Answer the placement query (the attach flow awaits the reply before its handshake, ADR-0050).
    if (typeof data === "object" && data !== null && (data as Record<string, unknown>)[PLACEMENT_QUERY_KEY] === true) {
      port.postMessage({
        [PLACEMENT_RESULT_KEY]: { engineHome: "shared-worker", electionRequired: false, swInstanceId: "sw-fixture" },
      });
      return;
    }
    if (!isBridgeEnvelope(data)) return;
    received.push({ type: data.type, payload: identityCodec.decode(data.payload) });
    if (data.type === "attach") {
      postBridgeMessage(port as never, identityCodec, "attach-ack", { alreadyBooted: false });
      postBridgeMessage(port as never, identityCodec, "event", {
        kind: "status",
        status: { phase: "ready", isRunning: true },
      });
    }
    // Deliberately no reply to `rpc` or `subscribe` — the detach path is what must settle those waiters.
  });
  port.start?.();
  return { received };
}

describe("attach-client detach settles pending operations (ADR-0040 P2 FIX 2)", () => {
  it("rejects an in-flight rpc with the detach error when stop() races it", async () => {
    const channel = new MessageChannel();
    openChannels.push(channel);
    manualWorker(channel.port1);

    const client = await attachSyncClient({ registry: attachRegistry, port: channel.port2 as unknown as never });
    await client.ready;

    // Issue an rpc the worker never answers, then stop() while it is pending.
    let rejected = "";
    const inFlight = client.flush().catch((error: Error) => {
      rejected = error.message;
    });
    await tick();
    await client.stop();
    await inFlight;
    expect(rejected).toContain("client detached");
  });

  it("rejects an awaiting subscribeLiveRows and cancels the worker-side subscribe (unsubscribe + detach posted)", async () => {
    const channel = new MessageChannel();
    openChannels.push(channel);
    const worker = manualWorker(channel.port1);

    const client = await attachSyncClient({ registry: attachRegistry, port: channel.port2 as unknown as never });
    await client.ready;

    // subscribeLiveRows awaits `live-initial`, which the manual worker never sends — so it stays pending.
    let rejected = "";
    const subbing = client
      .subscribeLiveRows({ sql: `select * from "todos"`, params: [], pkColumns: ["id"] }, () => undefined)
      .catch((error: Error) => {
        rejected = error.message;
      });
    await tick();
    // A subscribe was sent to the worker but not yet answered.
    expect(worker.received.some((m) => m.type === "subscribe")).toBe(true);

    await client.stop();
    await subbing;
    await tick(); // let the detach-time unsubscribe/detach envelopes reach the worker port
    expect(rejected).toContain("client detached");

    // Detach cancels the worker-side pending subscribe: it posts an `unsubscribe` for the queryId (so a real
    // worker tears the mid-await subscribe down, no orphan registration) followed by `detach`.
    const subscribeMsg = worker.received.find((m) => m.type === "subscribe");
    const queryId = (subscribeMsg!.payload as { queryId: string }).queryId;
    const unsub = worker.received.find(
      (m) => m.type === "unsubscribe" && (m.payload as { queryId: string }).queryId === queryId,
    );
    expect(unsub).toBeDefined();
    expect(worker.received.some((m) => m.type === "detach")).toBe(true);
  });

  it("rejects any new rpc issued after stop() immediately", async () => {
    const channel = new MessageChannel();
    openChannels.push(channel);
    manualWorker(channel.port1);

    const client = await attachSyncClient({ registry: attachRegistry, port: channel.port2 as unknown as never });
    await client.ready;
    await client.stop();

    let rejected = "";
    await client.flush().catch((error: Error) => {
      rejected = error.message;
    });
    expect(rejected).toContain("client detached");

    // A live-rows subscribe after stop() likewise rejects at once (never registers a forever-pending waiter).
    let subRejected = "";
    await client
      .subscribeLiveRows({ sql: `select * from "todos"`, params: [], pkColumns: ["id"] }, () => undefined)
      .catch((error: Error) => {
        subRejected = error.message;
      });
    expect(subRejected).toContain("client detached");
  });

  it("FIX 2/A: a detach before the write milestone rejects ready, start(), writeReady AND bootSettled with instanceof ClientDisposedError", async () => {
    const channel = new MessageChannel();
    openChannels.push(channel);
    // A worker that ACKS the attach (so `attachSyncClient` resolves) but NEVER drives phase "ready" NOR the
    // `writeReady`/`bootSettled` milestones — so every downstream stage stays pending at detach.
    const port = channel.port1;
    port.addEventListener("message", (event) => {
      const data = (event as MessageEvent).data;
      // Answer the placement query (the attach flow awaits the reply before its handshake, ADR-0050).
      if (
        typeof data === "object" &&
        data !== null &&
        (data as Record<string, unknown>)[PLACEMENT_QUERY_KEY] === true
      ) {
        port.postMessage({
          [PLACEMENT_RESULT_KEY]: { engineHome: "shared-worker", electionRequired: false, swInstanceId: "sw-fixture" },
        });
        return;
      }
      if (!isBridgeEnvelope(data)) return;
      if (data.type === "attach") {
        postBridgeMessage(port as never, identityCodec, "attach-ack", { alreadyBooted: false });
      }
    });
    port.start?.();

    const client = await attachSyncClient({ registry: attachRegistry, port: channel.port2 as unknown as never });

    // Park an awaiter on every pending stage (each guarded so an unconsumed rejection is never unhandled).
    let readyError: unknown = null;
    let startError: unknown = null;
    let writeReadyError: unknown = null;
    let bootSettledError: unknown = null;
    const readyPromise = client.ready.then(
      () => undefined,
      (error: unknown) => {
        readyError = error;
      },
    );
    const startPromise = client.start().then(
      () => undefined,
      (error: unknown) => {
        startError = error;
      },
    );
    const writeReadyPromise = client.writeReady.then(
      () => undefined,
      (error: unknown) => {
        writeReadyError = error;
      },
    );
    const bootSettledPromise = client.bootSettled.then(
      () => undefined,
      (error: unknown) => {
        bootSettledError = error;
      },
    );
    await tick();

    // Detach before initial sync AND before the write milestone → every pending stage settles with the SAME
    // typed disposed error (FIX A — `instanceof ClientDisposedError` is now mode-independent), no hang.
    await client.stop();
    await Promise.all([readyPromise, startPromise, writeReadyPromise, bootSettledPromise]);
    expect(readyError).toBeInstanceOf(ClientDisposedError);
    expect(startError).toBeInstanceOf(ClientDisposedError);
    expect(writeReadyError).toBeInstanceOf(ClientDisposedError);
    expect(bootSettledError).toBeInstanceOf(ClientDisposedError);
  });
});

describe("attach-client installs page cleanup BEFORE the handshake (ADR-0040 P2 FIX 3)", () => {
  it("a terminal pagehide during boot posts detach and rejects the pending attachSyncClient", async () => {
    const channel = new MessageChannel();
    openChannels.push(channel);
    // The worker records envelopes but NEVER acks the attach — the boot handshake hangs until pagehide fires.
    const received: string[] = [];
    channel.port1.addEventListener("message", (event) => {
      const data = (event as MessageEvent).data;
      // Answer the placement query (the attach flow awaits the reply before its handshake, ADR-0050).
      if (
        typeof data === "object" &&
        data !== null &&
        (data as Record<string, unknown>)[PLACEMENT_QUERY_KEY] === true
      ) {
        channel.port1.postMessage({
          [PLACEMENT_RESULT_KEY]: { engineHome: "shared-worker", electionRequired: false, swInstanceId: "sw-fixture" },
        });
        return;
      }
      if (isBridgeEnvelope(data)) received.push(data.type);
    });
    channel.port1.start?.();

    // Install a window stub that captures the pagehide handler BEFORE attachSyncClient runs — the listener is
    // now installed pre-handshake, so it must exist even though the ack never arrives.
    const captured: Array<(event: { persisted: boolean }) => void> = [];
    const windowStub = {
      addEventListener: (type: string, handler: (event: { persisted: boolean }) => void) => {
        if (type === "pagehide") captured.push(handler);
      },
      removeEventListener: () => undefined,
    };
    (globalThis as { window?: unknown }).window = windowStub;
    try {
      let rejected = "";
      const attaching = attachSyncClient({
        registry: attachRegistry,
        port: channel.port2 as unknown as never,
      }).catch((error: Error) => {
        rejected = error.message;
      });
      await tick();
      // The pagehide listener was installed pre-ack (FIX 3) — fire a terminal (non-bfcache) pagehide.
      expect(captured).toHaveLength(1);
      captured[0]!({ persisted: false });
      await attaching;
      await tick(); // let the detach envelope reach the worker port

      expect(rejected).toContain("client detached");
      // Detach was sent to the worker even though the boot never completed (no stranded port bookkeeping).
      expect(received).toContain("detach");
    } finally {
      delete (globalThis as { window?: unknown }).window;
    }
  });
});
