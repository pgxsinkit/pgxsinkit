import { describe, expect, it } from "bun:test";
// ADR-0050 (path-addressed store-worker quiescence): `quiesceStoreWorker` closes the SharedWorker HOSTING a
// store so its backend connection is released BEFORE a path-addressed `destroyStoreArtifacts`. This is the
// idbfs (SW-direct) wipe fix — an `extendedLifetime` worker survives a reload still holding its IndexedDB
// connection, so the delete blocks forever until the worker is actively torn down. These tests drive the
// primitive with a FAKE worker port (no real SharedWorker) that emulates the bootstrap's replies:
//   - shared-worker home: answer the placement query, then ack the engine-teardown (pingId -1) → toreDown
//   - elected-worker home: answer the placement query → resolves toreDown:false, sends NO teardown
//   - a declaration refusal in place of the placement reply → rejects typed
//   - no reply within the deadline → rejects (a timeout is NOT proof of teardown)

import { quiesceStoreWorker } from "../../packages/client/src/index";
import {
  DECLARATION_KEY,
  DECLARATION_REFUSED_KEY,
  PLACEMENT_QUERY_KEY,
  PLACEMENT_RESULT_KEY,
} from "../../packages/client/src/worker/define-sync-worker";
import { wrapControlEnvelope } from "../../packages/client/src/worker/engine-control";
import type { BridgePort } from "../../packages/client/src/worker/protocol";

type Listener = (event: { data: unknown }) => void;

/** Deterministic injectable timers: `fire()` runs the one scheduled callback (the deadline). */
function makeTimers() {
  let scheduled: (() => void) | undefined;
  return {
    timers: {
      setTimeout: (fn: () => void) => {
        scheduled = fn;
        return 1 as unknown;
      },
      clearTimeout: () => {
        scheduled = undefined;
      },
    },
    fire: () => scheduled?.(),
  };
}

/**
 * A fake SharedWorker port emulating the ADR-0050 bootstrap. `onDeclaration` decides how it answers the
 * placement query; `engine-teardown` triggers `onTeardown`. Records every message posted TO the worker.
 */
function makeFakeWorkerPort(config: {
  placement: { engineHome: "shared-worker" | "elected-worker"; swInstanceId: string };
  /** Replace the placement reply with a declaration refusal (message text). */
  refuseWith?: string;
  /** How the SW-direct host acks the teardown; default acks success with the matching identity. */
  ackTeardown?: (identity: { swInstanceId: string; generation: number }) => unknown;
  /** Never answer anything (drives the timeout path). */
  silent?: boolean;
}) {
  const listeners = new Set<Listener>();
  const sent: unknown[] = [];
  const emit = (data: unknown) => {
    for (const l of [...listeners]) l({ data });
  };
  const port = {
    postMessage: (message: unknown) => {
      sent.push(message);
      if (config.silent === true) return;
      const record = message as Record<string, unknown>;
      if (record[PLACEMENT_QUERY_KEY] !== undefined) {
        queueMicrotask(() => {
          if (config.refuseWith !== undefined) {
            emit({ [DECLARATION_REFUSED_KEY]: { message: config.refuseWith, name: "StorageDeclarationRefusedError" } });
          } else {
            emit({
              [PLACEMENT_RESULT_KEY]: {
                engineHome: config.placement.engineHome,
                electionRequired: config.placement.engineHome === "elected-worker",
                swInstanceId: config.placement.swInstanceId,
              },
            });
          }
        });
        return;
      }
      const envelope = record["pgx0049"] as
        | { type?: string; identity?: { swInstanceId: string; generation: number } }
        | undefined;
      if (envelope?.type === "engine-teardown" && envelope.identity !== undefined) {
        const ack =
          config.ackTeardown?.(envelope.identity) ??
          wrapControlEnvelope({ type: "control-ack", identity: envelope.identity, pingId: -1 });
        queueMicrotask(() => emit(ack));
      }
    },
    addEventListener: (_type: string, l: unknown) => listeners.add(l as Listener),
    removeEventListener: (_type: string, l: unknown) => listeners.delete(l as Listener),
    start: () => undefined,
    close: () => undefined,
  } as unknown as BridgePort;
  return { port, sent };
}

const settle = async (n = 4) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

/** Await a promise expected to reject and return its error (avoids oxlint's await-thenable on `.rejects`). */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the promise to reject, but it resolved");
}

describe("quiesceStoreWorker (ADR-0050)", () => {
  it("SW-direct: declares, queries placement, tears down the engine, resolves toreDown", async () => {
    const timers = makeTimers();
    const { port, sent } = makeFakeWorkerPort({
      placement: { engineHome: "shared-worker", swInstanceId: "sw-1" },
    });
    const outcome = await quiesceStoreWorker(port as unknown as never, { timers: timers.timers });

    expect(outcome).toEqual({ engineHome: "shared-worker", toreDown: true });
    // Declaration went FIRST (ADR-0050), then the placement query, then the engine-teardown.
    const declarationIndex = sent.findIndex((m) => (m as Record<string, unknown>)[DECLARATION_KEY] !== undefined);
    const queryIndex = sent.findIndex((m) => (m as Record<string, unknown>)[PLACEMENT_QUERY_KEY] !== undefined);
    const teardownIndex = sent.findIndex(
      (m) => (m as { pgx0049?: { type?: string } }).pgx0049?.type === "engine-teardown",
    );
    expect(declarationIndex).toBe(0);
    expect(queryIndex).toBeGreaterThan(declarationIndex);
    expect(teardownIndex).toBeGreaterThan(queryIndex);
  });

  it("elected-worker: resolves toreDown:false and sends NO teardown (nothing to close from a router-only port)", async () => {
    const timers = makeTimers();
    const { port, sent } = makeFakeWorkerPort({
      placement: { engineHome: "elected-worker", swInstanceId: "sw-2" },
    });
    const outcome = await quiesceStoreWorker(port as unknown as never, { timers: timers.timers });

    expect(outcome).toEqual({ engineHome: "elected-worker", toreDown: false });
    expect(sent.some((m) => (m as { pgx0049?: { type?: string } }).pgx0049?.type === "engine-teardown")).toBe(false);
  });

  it("a teardown ack carrying an error rejects", async () => {
    const timers = makeTimers();
    const { port } = makeFakeWorkerPort({
      placement: { engineHome: "shared-worker", swInstanceId: "sw-3" },
      ackTeardown: (identity) =>
        wrapControlEnvelope({
          type: "control-ack",
          identity,
          pingId: -1,
          error: { name: "E", message: "close failed" },
        }),
    });
    const error = await rejection(quiesceStoreWorker(port as unknown as never, { timers: timers.timers }));
    expect((error as Error).message).toMatch(/close failed/);
  });

  it("a declaration refusal in place of the placement reply rejects typed", async () => {
    const timers = makeTimers();
    const { port } = makeFakeWorkerPort({
      placement: { engineHome: "shared-worker", swInstanceId: "sw-4" },
      refuseWith: "storage declaration conflicts on backend",
    });
    const error = await rejection(quiesceStoreWorker(port as unknown as never, { timers: timers.timers }));
    expect((error as Error).message).toMatch(/backend/);
  });

  it("a silent worker rejects at the deadline (a timeout is not proof of teardown)", async () => {
    const timers = makeTimers();
    const { port } = makeFakeWorkerPort({
      placement: { engineHome: "shared-worker", swInstanceId: "sw-5" },
      silent: true,
    });
    const pending = quiesceStoreWorker(port as unknown as never, { timers: timers.timers, timeoutMs: 1000 });
    await settle();
    timers.fire();
    const error = await rejection(pending);
    expect((error as Error).message).toMatch(/timed out/);
  });

  it("accepts a factory (the attachSyncClient `worker` shape), constructing the port lazily", async () => {
    const timers = makeTimers();
    const { port } = makeFakeWorkerPort({
      placement: { engineHome: "shared-worker", swInstanceId: "sw-6" },
    });
    let built = 0;
    const factory = () => {
      built++;
      return { port } as unknown as never;
    };
    const outcome = await quiesceStoreWorker(factory, { timers: timers.timers });
    expect(built).toBe(1);
    expect(outcome.toreDown).toBe(true);
  });
});
