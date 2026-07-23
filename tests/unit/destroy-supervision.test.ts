import { afterEach, describe, expect, it } from "bun:test";
// ADR-0049 (capability-driven engine placement) step 10b: the DESTRUCTIVE lifecycle SUPERVISION. Two surfaces:
//   - the shared `runStoreDestruction` helper (both the in-process `destroy()` and the attached facade run it):
//     the effect ORDER (set `deleting` → delete sentinel → delete backend store → delete meta record) and the
//     BOUNDED ownership-lock-lag retry on the backend-store delete (the just-detached engine's VFS lock lags).
//   - the ATTACHED facade `destroy()`: peer refusal FIRST (the SharedWorker knows the attached-tab count), then
//     — single tab — DETACH then run the destruction. Driven with a fake SW (no real worker / OPFS / engine).

import { pgTable, uuid } from "drizzle-orm/pg-core";

import type { SyncTableRegistry } from "@pgxsinkit/contracts";

import { identityCodec, isBridgeEnvelope, postBridgeMessage } from "../../packages/client/src/index";
import type { DestructionEffects } from "../../packages/client/src/store-lifecycle";
import {
  attachSyncClient,
  createStoreDestructionEffects,
  retireSyncWorkerHost,
  runStoreDestruction,
  StoreDestroyRefusedError,
} from "../../packages/client/src/worker/attach-sync-client";
import {
  bootstrapWorkerScope,
  DESTROY_QUERY_KEY,
  DESTROY_VERDICT_KEY,
  PLACEMENT_QUERY_KEY,
  PLACEMENT_RESULT_KEY,
} from "../../packages/client/src/worker/define-sync-worker";
import { ENGINE_CONTROL_ENVELOPE_KEY } from "../../packages/client/src/worker/engine-router";
import type { BridgePort } from "../../packages/client/src/worker/protocol";
import type { SwPlacementResult } from "../../packages/client/src/worker/sw-placement";

const settle = async (n = 6) => {
  for (let i = 0; i < n; i++) await new Promise((resolve) => setTimeout(resolve, 2));
};

const openChannels: MessageChannel[] = [];
afterEach(() => {
  for (const channel of openChannels.splice(0)) {
    channel.port1.close();
    channel.port2.close();
  }
});

const todos = pgTable("todos", { id: uuid("id").primaryKey() });
const registry = {
  todos: {
    table: todos,
    mode: "readonly",
    primaryKey: { columns: ["id"] },
    shape: { tableName: "todos", shapeKey: "todos-shape" },
    clientProjection: { syncedTable: "todos" },
  },
} as unknown as SyncTableRegistry;

/** A recording fake destruction effects object — asserts the machine's step order (all steps idempotent no-ops). */
function recordingEffects(overrides?: Partial<DestructionEffects>): { effects: DestructionEffects; order: string[] } {
  const order: string[] = [];
  const effects: DestructionEffects = {
    setPhase: async (phase) => {
      order.push(`setPhase:${phase}`);
    },
    deleteSentinel: async () => {
      order.push("deleteSentinel");
    },
    deleteBackendStore: async () => {
      order.push("deleteBackendStore");
    },
    deleteMetaRecord: async () => {
      order.push("deleteMetaRecord");
    },
    ...overrides,
  };
  return { effects, order };
}

/** Deterministic manual timers (the router-test pattern) so the destroy peer-count query never auto-times-out. */
function makeTimers() {
  const scheduled: { fn: () => void; handle: number }[] = [];
  let seq = 0;
  return {
    timers: {
      setTimeout(fn: () => void) {
        const handle = seq++;
        scheduled.push({ fn, handle });
        return handle;
      },
      clearTimeout(handle: unknown) {
        const i = scheduled.findIndex((s) => s.handle === handle);
        if (i >= 0) scheduled.splice(i, 1);
      },
    },
  };
}

/**
 * A fake SharedWorker-side port for the attach client: acks `attach`, drives phase "ready", auto-answers the
 * `diagnostics` rpc with zero owed, and answers the `{ [DESTROY_QUERY_KEY] }` peer-count query with `peers`.
 */
function makeSwPort(
  peers: number,
  options?: { swDirect?: boolean; order?: string[]; teardownError?: string },
): { port: BridgePort; received: { type: string }[] } {
  const listeners = new Set<(event: { data: unknown }) => void>();
  const received: { type: string }[] = [];
  const emit = (data: unknown) => {
    for (const l of [...listeners]) l({ data });
  };
  const emitPort: BridgePort = {
    postMessage: (message) => emit(message),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  const port: BridgePort = {
    postMessage: (message: unknown) => {
      if (
        options?.swDirect === true &&
        typeof message === "object" &&
        message !== null &&
        (message as Record<string, unknown>)[PLACEMENT_QUERY_KEY] === true
      ) {
        emit({
          [PLACEMENT_RESULT_KEY]: {
            engineHome: "shared-worker",
            electionRequired: false,
            swInstanceId: "sw-direct-test",
          },
        });
        return;
      }
      // The RAW destroy peer-count query (not a bridge envelope).
      if (
        typeof message === "object" &&
        message !== null &&
        (message as Record<string, unknown>)[DESTROY_QUERY_KEY] === true
      ) {
        emit({ [DESTROY_VERDICT_KEY]: { peers } });
        return;
      }
      const control =
        typeof message === "object" && message !== null
          ? (message as { [ENGINE_CONTROL_ENVELOPE_KEY]?: { type?: string; identity?: unknown } })[
              ENGINE_CONTROL_ENVELOPE_KEY
            ]
          : undefined;
      if (options?.swDirect === true && control?.type === "engine-teardown") {
        options.order?.push("teardown");
        emit({
          [ENGINE_CONTROL_ENVELOPE_KEY]: {
            type: "control-ack",
            identity: control.identity,
            pingId: -1,
            ...(options.teardownError ? { error: { message: options.teardownError } } : {}),
          },
        });
        return;
      }
      if (!isBridgeEnvelope(message)) return;
      received.push({ type: message.type });
      if (message.type === "detach") options?.order?.push("detach");
      if (message.type === "attach") {
        queueMicrotask(() => {
          postBridgeMessage(emitPort, identityCodec, "attach-ack", { alreadyBooted: false });
          postBridgeMessage(emitPort, identityCodec, "event", {
            kind: "status",
            status: { phase: "ready", isRunning: true },
          });
        });
      } else if (message.type === "rpc") {
        const payload = identityCodec.decode(message.payload) as { op: string };
        if (payload.op === "diagnostics") {
          postBridgeMessage(
            emitPort,
            identityCodec,
            "rpc-result",
            {
              ok: true,
              value: {
                mutation: {
                  pendingCount: 0,
                  sendingCount: 0,
                  ackedCount: 0,
                  failedCount: 0,
                  quarantinedCount: 0,
                  conflictedCount: 0,
                  rejectedCount: 0,
                },
              },
            },
            message.id,
          );
        }
      }
    },
    addEventListener: (_type, l) => listeners.add(l as (event: { data: unknown }) => void),
    removeEventListener: (_type, l) => listeners.delete(l as (event: { data: unknown }) => void),
    start: () => undefined,
    close: () => undefined,
  };
  return { port, received };
}

// ─── 1. The shared destruction helper — effect order + bounded ownership retry ───

describe("runStoreDestruction — the sequence both destroy paths run (ADR-0049 D8)", () => {
  it("runs the destructive lifecycle in order: deleting → sentinel → backend store → meta record", async () => {
    const { effects, order } = recordingEffects();
    await runStoreDestruction(effects);
    expect(order).toEqual(["setPhase:deleting", "deleteSentinel", "deleteBackendStore", "deleteMetaRecord"]);
  });

  it("VFS ownership-lock lag → bounded retry of the backend-store delete, then success", async () => {
    let attempts = 0;
    const { effects, order } = recordingEffects({
      deleteBackendStore: async () => {
        attempts += 1;
        order.push(`deleteBackendStore:${attempts}`);
        if (attempts === 1) {
          const error = new Error("the store directory is still owned by the engine's VFS handle");
          (error as Error & { name: string }).name = "NoModificationAllowedError";
          throw error;
        }
      },
    });
    await runStoreDestruction(effects, { delay: () => Promise.resolve() });
    expect(attempts).toBe(2); // threw owned-error once, retried once, succeeded
    expect(order).toEqual([
      "setPhase:deleting",
      "deleteSentinel",
      "deleteBackendStore:1",
      "deleteBackendStore:2",
      "deleteMetaRecord",
    ]);
  });

  it("a NON-ownership error is NOT retried — it propagates", async () => {
    let attempts = 0;
    const { effects } = recordingEffects({
      deleteBackendStore: async () => {
        attempts += 1;
        throw new Error("disk exploded");
      },
    });
    let caught: unknown;
    await runStoreDestruction(effects, { delay: () => Promise.resolve() }).catch((error: unknown) => {
      caught = error;
    });
    expect((caught as Error).message).toBe("disk exploded");
    expect(attempts).toBe(1);
  });
});

// ─── 2. createStoreDestructionEffects — the real wiring, faked IO ────────────────

describe("createStoreDestructionEffects — the backend-agnostic real effects (faked IO)", () => {
  it("deleteBackendStore delete-if-presents BOTH the OPFS directory and the idb database", async () => {
    let opfsRemoved = false;
    let idbDeleted = false;
    // A fake OPFS root whose store-directory removeEntry records; a fake idb whose deleteDatabase records.
    const fakeRoot = {
      getDirectoryHandle: async () => fakeRoot,
      getFileHandle: async () => ({}),
      removeEntry: async () => {
        opfsRemoved = true;
      },
    };
    const fakeIdb = {
      deleteDatabase: () => {
        const req = { onsuccess: null as (() => void) | null, onerror: null, onblocked: null };
        queueMicrotask(() => {
          idbDeleted = true;
          req.onsuccess?.();
        });
        return req;
      },
      open: () => ({}) as never,
    };
    const effects = createStoreDestructionEffects("store-x", {
      opfs: { getRoot: async () => fakeRoot as never },
      meta: { indexedDB: fakeIdb as never },
    });
    await effects.deleteBackendStore();
    expect(opfsRemoved).toBe(true);
    expect(idbDeleted).toBe(true);
  });

  it("onblocked is nonterminal: backend deletion waits for the later onsuccess", async () => {
    const fakeRoot = {
      getDirectoryHandle: async () => fakeRoot,
      getFileHandle: async () => ({}),
      removeEntry: async () => undefined,
    };
    const request = {
      error: null as unknown,
      onsuccess: null as (() => void) | null,
      onerror: null as (() => void) | null,
      onblocked: null as (() => void) | null,
    };
    const effects = createStoreDestructionEffects("store-x", {
      opfs: { getRoot: async () => fakeRoot as never },
      meta: { indexedDB: { deleteDatabase: () => request, open: () => ({}) as never } as never },
    });
    let settled = false;
    const deletion = effects.deleteBackendStore().then(() => {
      settled = true;
    });
    await settle(1);
    request.onblocked?.();
    await settle(1);
    expect(settled).toBe(false);
    request.onsuccess?.();
    await deletion;
    expect(settled).toBe(true);
  });

  it("onerror rejects so the deleting authority remains for a later resume", async () => {
    const fakeRoot = {
      getDirectoryHandle: async () => fakeRoot,
      getFileHandle: async () => ({}),
      removeEntry: async () => undefined,
    };
    const request = {
      error: new Error("idb delete failed"),
      onsuccess: null as (() => void) | null,
      onerror: null as (() => void) | null,
      onblocked: null as (() => void) | null,
    };
    const effects = createStoreDestructionEffects("store-x", {
      opfs: { getRoot: async () => fakeRoot as never },
      meta: { indexedDB: { deleteDatabase: () => request, open: () => ({}) as never } as never },
    });
    const deletion = effects.deleteBackendStore();
    await settle(1);
    request.onerror?.();
    // oxlint-disable-next-line typescript/await-thenable -- bun-types gap: .rejects returns a promise typed as void
    await expect(deletion).rejects.toThrow("idb delete failed");
  });
});

// ─── 3. Attached facade destroy — peer refusal + single-tab supervision ──────────

describe("attached destroy() — peer refusal FIRST, then detach + destruction (ADR-0049 D8)", () => {
  it("retires a provisioned SW-direct host before its construction identity changes", async () => {
    const order: string[] = [];
    const sw = makeSwPort(1, { swDirect: true, order });

    await retireSyncWorkerHost({ port: sw.port, timers: makeTimers().timers });

    expect(order).toEqual(["teardown"]);
  });

  it("refuses SW-direct host retirement while a peer tab remains attached", async () => {
    const order: string[] = [];
    const sw = makeSwPort(2, { swDirect: true, order });

    // oxlint-disable-next-line typescript/await-thenable -- bun-types gap: .rejects returns a promise typed as void
    await expect(retireSyncWorkerHost({ port: sw.port, timers: makeTimers().timers })).rejects.toThrow(
      "2 attached tabs",
    );
    expect(order).toEqual([]);
  });

  it("SW-direct teardown closes the in-scope host before acknowledging and closes the worker scope", async () => {
    const order: string[] = [];
    const scope: {
      SharedWorkerGlobalScope: unknown;
      onconnect?: (event: { ports: BridgePort[] }) => void;
      close: () => void;
    } = {
      SharedWorkerGlobalScope: class {},
      close: () => order.push("scope.close"),
    };
    const granted = (): Promise<SwPlacementResult> =>
      Promise.resolve({ engineHome: "shared-worker", swInstanceId: "sw-direct" });
    bootstrapWorkerScope({
      connect: () => undefined,
      closeHost: async () => {
        order.push("host.close");
      },
      peerCount: () => 1,
      decidePlacement: granted,
      globalScope: scope,
    });

    const channel = new MessageChannel();
    openChannels.push(channel);
    scope.onconnect?.({ ports: [channel.port2 as unknown as BridgePort] });
    channel.port1.start();
    const ack = new Promise<void>((resolve) => {
      channel.port1.addEventListener("message", (event) => {
        const envelope = (event.data as { [ENGINE_CONTROL_ENVELOPE_KEY]?: { type?: string; pingId?: number } })[
          ENGINE_CONTROL_ENVELOPE_KEY
        ];
        if (envelope?.type === "control-ack" && envelope.pingId === -1) {
          order.push("ack");
          resolve();
        }
      });
    });
    await settle(1);
    channel.port1.postMessage({
      [ENGINE_CONTROL_ENVELOPE_KEY]: {
        type: "engine-teardown",
        identity: { swInstanceId: "sw-direct", generation: 0 },
      },
    });

    await Promise.race([
      ack,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("SW-direct teardown ack timed out")), 100)),
    ]);
    await settle(1);
    expect(order).toEqual(["host.close", "ack", "scope.close"]);
  });

  it("SW-direct teardown reports close failure and still terminates the poisoned worker scope", async () => {
    const order: string[] = [];
    const scope: {
      SharedWorkerGlobalScope: unknown;
      onconnect?: (event: { ports: BridgePort[] }) => void;
      close: () => void;
    } = {
      SharedWorkerGlobalScope: class {},
      close: () => order.push("scope.close"),
    };
    bootstrapWorkerScope({
      connect: () => undefined,
      closeHost: async () => {
        order.push("host.close");
        throw new Error("host close failed");
      },
      peerCount: () => 1,
      decidePlacement: () => Promise.resolve({ engineHome: "shared-worker", swInstanceId: "sw-direct" }),
      globalScope: scope,
    });

    const channel = new MessageChannel();
    openChannels.push(channel);
    scope.onconnect?.({ ports: [channel.port2 as unknown as BridgePort] });
    channel.port1.start();
    const failure = new Promise<string>((resolve) => {
      channel.port1.addEventListener("message", (event) => {
        const envelope = (
          event.data as {
            [ENGINE_CONTROL_ENVELOPE_KEY]?: { type?: string; pingId?: number; error?: { message?: string } };
          }
        )[ENGINE_CONTROL_ENVELOPE_KEY];
        if (envelope?.type === "control-ack" && envelope.pingId === -1 && envelope.error?.message) {
          order.push("nack");
          resolve(envelope.error.message);
        }
      });
    });
    await settle(1);
    channel.port1.postMessage({
      [ENGINE_CONTROL_ENVELOPE_KEY]: {
        type: "engine-teardown",
        identity: { swInstanceId: "sw-direct", generation: 0 },
      },
    });

    expect(
      await Promise.race([
        failure,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("teardown failure ack timed out")), 100)),
      ]),
    ).toBe("host close failed");
    await settle(1);
    expect(order).toEqual(["host.close", "nack", "scope.close"]);
  });

  it("peers > 1 → StoreDestroyRefusedError and NO destruction effect ever ran", async () => {
    const sw = makeSwPort(2);
    const { effects, order } = recordingEffects();
    const client = await attachSyncClient({
      registry,
      port: sw.port as unknown as never,
      timers: makeTimers().timers,
      createDestructionEffects: () => effects,
    });
    await client.ready;
    await settle(1);

    let err: unknown;
    await client.destroy().catch((error: unknown) => {
      err = error;
    });
    expect(err).toBeInstanceOf(StoreDestroyRefusedError);
    expect((err as StoreDestroyRefusedError).peers).toBe(2);
    expect(order).toEqual([]); // the supervisor refused BEFORE detaching or running any effect
  });

  it("single tab (peers === 1) → detaches, then runs the destruction effects in order", async () => {
    const sw = makeSwPort(1);
    const { effects, order } = recordingEffects();
    const client = await attachSyncClient({
      registry,
      port: sw.port as unknown as never,
      timers: makeTimers().timers,
      createDestructionEffects: () => effects,
    });
    await client.ready;
    await settle(1);

    await client.destroy();
    // The tab detached its engine (a `detach` was sent), then the tab supervisor ran the full destruction.
    expect(sw.received.some((m) => m.type === "detach")).toBe(true);
    expect(order).toEqual(["setPhase:deleting", "deleteSentinel", "deleteBackendStore", "deleteMetaRecord"]);
  });

  it("SW-direct destroy awaits host teardown acknowledgement before detaching and deleting", async () => {
    const order: string[] = [];
    const sw = makeSwPort(1, { swDirect: true, order });
    const { effects } = recordingEffects({
      setPhase: async () => {
        order.push("setPhase:deleting");
      },
      deleteSentinel: async () => {
        order.push("deleteSentinel");
      },
      deleteBackendStore: async () => {
        order.push("deleteBackendStore");
      },
      deleteMetaRecord: async () => {
        order.push("deleteMetaRecord");
      },
    });
    const client = await attachSyncClient({
      registry,
      port: sw.port as unknown as never,
      timers: makeTimers().timers,
      createDestructionEffects: () => effects,
    });
    await client.ready;
    await settle(1);

    await client.destroy();
    expect(order).toEqual([
      "teardown",
      "detach",
      "setPhase:deleting",
      "deleteSentinel",
      "deleteBackendStore",
      "deleteMetaRecord",
    ]);
  });

  it("composed SW-direct destroy releases the host before backend deletion can succeed", async () => {
    const order: string[] = [];
    let handlesOpen = true;
    const scope: {
      SharedWorkerGlobalScope: unknown;
      onconnect?: (event: { ports: BridgePort[] }) => void;
      close: () => void;
    } = {
      SharedWorkerGlobalScope: class {},
      close: () => order.push("scope.close"),
    };
    const connect = (port: BridgePort) => {
      const reply: BridgePort = {
        postMessage: (message) => port.postMessage(message),
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      };
      port.addEventListener("message", (event) => {
        if (!isBridgeEnvelope(event.data)) return;
        if (event.data.type === "attach") {
          queueMicrotask(() => {
            postBridgeMessage(reply, identityCodec, "attach-ack", { alreadyBooted: false });
            postBridgeMessage(reply, identityCodec, "event", {
              kind: "status",
              status: { phase: "ready", isRunning: true },
            });
          });
        } else if (event.data.type === "rpc") {
          const payload = identityCodec.decode(event.data.payload) as { op: string };
          if (payload.op === "diagnostics") {
            postBridgeMessage(
              reply,
              identityCodec,
              "rpc-result",
              {
                ok: true,
                value: {
                  mutation: {
                    pendingCount: 0,
                    sendingCount: 0,
                    ackedCount: 0,
                    failedCount: 0,
                    quarantinedCount: 0,
                    conflictedCount: 0,
                    rejectedCount: 0,
                  },
                },
              },
              event.data.id,
            );
          }
        } else if (event.data.type === "detach") {
          order.push("detach");
        }
      });
      port.start?.();
    };
    bootstrapWorkerScope({
      connect,
      closeHost: async () => {
        order.push("host.close");
        handlesOpen = false;
      },
      peerCount: () => 1,
      decidePlacement: () => Promise.resolve({ engineHome: "shared-worker", swInstanceId: "sw-direct" }),
      globalScope: scope,
    });

    const channel = new MessageChannel();
    openChannels.push(channel);
    scope.onconnect?.({ ports: [channel.port2 as unknown as BridgePort] });
    const effects = recordingEffects({
      setPhase: async () => {
        order.push("setPhase:deleting");
      },
      deleteSentinel: async () => {
        order.push("deleteSentinel");
      },
      deleteBackendStore: async () => {
        order.push("deleteBackendStore");
        if (handlesOpen) {
          const error = new Error("backend still owned");
          error.name = "NoModificationAllowedError";
          throw error;
        }
      },
      deleteMetaRecord: async () => {
        order.push("deleteMetaRecord");
      },
    }).effects;
    const client = await attachSyncClient({
      registry,
      port: channel.port1 as unknown as never,
      createDestructionEffects: () => effects,
    });
    await client.ready;

    await client.destroy();
    await settle(1);
    expect(order.filter((step) => step === "deleteBackendStore")).toHaveLength(1);
    expect(order.indexOf("host.close")).toBeLessThan(order.indexOf("deleteBackendStore"));
    expect(order).toContain("detach");
    expect(order.at(-1)).toBe("scope.close");
  });

  it("SW-direct destroy propagates host-close failure without detaching or deleting", async () => {
    const order: string[] = [];
    const sw = makeSwPort(1, { swDirect: true, order, teardownError: "host close failed" });
    const { effects } = recordingEffects({
      setPhase: async () => {
        order.push("setPhase:deleting");
      },
      deleteSentinel: async () => {
        order.push("deleteSentinel");
      },
      deleteBackendStore: async () => {
        order.push("deleteBackendStore");
      },
      deleteMetaRecord: async () => {
        order.push("deleteMetaRecord");
      },
    });
    const client = await attachSyncClient({
      registry,
      port: sw.port as unknown as never,
      timers: makeTimers().timers,
      createDestructionEffects: () => effects,
    });
    await client.ready;
    await settle(1);

    // oxlint-disable-next-line typescript/await-thenable -- bun-types gap: .rejects returns a promise typed as void
    await expect(client.destroy()).rejects.toThrow("host close failed");
    expect(order).toEqual(["teardown"]);
  });

  it("single tab with owed mutations → refused unless force (the honest journal check)", async () => {
    // Override the SW to report owed mutations on the diagnostics rpc.
    const listeners = new Set<(event: { data: unknown }) => void>();
    const emit = (data: unknown) => {
      for (const l of [...listeners]) l({ data });
    };
    const emitPort: BridgePort = {
      postMessage: (message) => emit(message),
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    };
    const port: BridgePort = {
      postMessage: (message: unknown) => {
        if (
          typeof message === "object" &&
          message !== null &&
          (message as Record<string, unknown>)[DESTROY_QUERY_KEY] === true
        ) {
          emit({ [DESTROY_VERDICT_KEY]: { peers: 1 } });
          return;
        }
        if (!isBridgeEnvelope(message)) return;
        if (message.type === "attach") {
          queueMicrotask(() => {
            postBridgeMessage(emitPort, identityCodec, "attach-ack", { alreadyBooted: false });
            postBridgeMessage(emitPort, identityCodec, "event", {
              kind: "status",
              status: { phase: "ready", isRunning: true },
            });
          });
        } else if (message.type === "rpc") {
          const payload = identityCodec.decode(message.payload) as { op: string };
          if (payload.op === "diagnostics") {
            postBridgeMessage(
              emitPort,
              identityCodec,
              "rpc-result",
              {
                ok: true,
                value: {
                  mutation: {
                    pendingCount: 3,
                    sendingCount: 0,
                    ackedCount: 0,
                    failedCount: 0,
                    quarantinedCount: 0,
                    conflictedCount: 0,
                    rejectedCount: 0,
                  },
                },
              },
              message.id,
            );
          }
        }
      },
      addEventListener: (_type, l) => listeners.add(l as (event: { data: unknown }) => void),
      removeEventListener: (_type, l) => listeners.delete(l as (event: { data: unknown }) => void),
      start: () => undefined,
      close: () => undefined,
    };

    const { effects, order } = recordingEffects();
    const client = await attachSyncClient({
      registry,
      port: port as unknown as never,
      timers: makeTimers().timers,
      createDestructionEffects: () => effects,
    });
    await client.ready;
    await settle(1);

    let err: unknown;
    await client.destroy().catch((error: unknown) => {
      err = error;
    });
    expect((err as Error).message).toContain("owed to the server");
    expect(order).toEqual([]); // refused — nothing detached, nothing destroyed
  });
});
