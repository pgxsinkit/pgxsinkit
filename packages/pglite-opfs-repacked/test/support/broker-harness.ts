/**
 * Test-thread helpers for standing up a broker/client pair across two threads.
 *
 * Two shapes, and which thread parks matters:
 *
 * - `startBrokerWorker` puts the store and `serveForever()` in a Worker and leaves the CLIENT on the
 *   test thread, blocking in `Atomics.wait`. This is the production shape (a coordinator worker with
 *   futex-parked backends), and bun 1.4.2 permits `Atomics.wait` on the test thread, so it is the
 *   default here.
 * - `startClientWorker` does the reverse for the cases where the SERVER is what the test needs to
 *   introspect: the broker runs `serve()` on the test thread (which must therefore never block) and
 *   the client parks inside a Worker.
 */

import { RepackedChannel, RepackedDoorbell } from "../../src/broker/protocol";
import type { RepackedChannelTransfer } from "../../src/broker/protocol";
import type { BrokerWorkerReply, RemoteCall, RemoteResults } from "./broker-worker";

const WORKER_URL = new URL("./broker-worker.ts", import.meta.url);

function spawn(): Worker {
  return new Worker(WORKER_URL, { type: "module" });
}

function nextReply(worker: Worker): Promise<BrokerWorkerReply> {
  return new Promise<BrokerWorkerReply>((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<BrokerWorkerReply>) => resolve(event.data);
    worker.onerror = (event) => reject(new Error(`broker worker failed: ${String(event.message ?? event)}`));
  });
}

export interface BrokerWorkerHandle {
  readonly doorbell: RepackedDoorbell;
  readonly channels: readonly RepackedChannel[];
  stop(): Promise<void>;
}

/** Boot a blocking broker worker owning a fresh in-memory store, with `channelCount` channels ready. */
export async function startBrokerWorker(
  options: { channelCount?: number; payloadBytes?: number; extentSize?: number } = {},
): Promise<BrokerWorkerHandle> {
  const doorbell = RepackedDoorbell.create();
  const channels = Array.from({ length: options.channelCount ?? 1 }, (_unused, index) =>
    RepackedChannel.create({
      id: index + 1,
      doorbell,
      ...(options.payloadBytes === undefined ? {} : { payloadBytes: options.payloadBytes }),
    }),
  );
  const worker = spawn();
  const ready = nextReply(worker);
  worker.postMessage({
    kind: "broker-boot",
    doorbell: doorbell.buffer,
    channels: channels.map((channel) => channel.transfer()),
    extentSize: options.extentSize ?? 8192,
  });
  const reply = await ready;
  if (reply.kind !== "ready") throw new Error("the broker worker did not report ready");
  return {
    doorbell,
    channels,
    async stop() {
      doorbell.requestStop();
      // Give the parked loop a turn to notice the stop before the thread is torn down.
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      worker.terminate();
    },
  };
}

export interface RemoteClientHandle {
  run(calls: readonly RemoteCall[]): Promise<RemoteResults>;
  stop(): void;
}

/** Boot a client worker over an already-created channel; the broker stays on the test thread. */
export async function startClientWorker(
  transfer: RepackedChannelTransfer,
  requestTimeoutMs?: number,
): Promise<RemoteClientHandle> {
  const worker = spawn();
  const ready = nextReply(worker);
  worker.postMessage({
    kind: "client-boot",
    channel: transfer,
    ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }),
  });
  const reply = await ready;
  if (reply.kind !== "ready") throw new Error("the client worker did not report ready");
  return {
    async run(calls) {
      const answer = nextReply(worker);
      worker.postMessage({ kind: "run", calls });
      const result = await answer;
      if (result.kind !== "results") throw new Error("the client worker did not report results");
      return result;
    },
    stop() {
      worker.terminate();
    },
  };
}

/** A named client call, for the scripted worker client. */
export function call(method: string, ...args: readonly unknown[]): RemoteCall {
  return { method, args };
}
