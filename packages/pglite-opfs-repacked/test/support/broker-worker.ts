/**
 * The two worker roles the broker suite needs, in one module so the unit-test selector sees a real
 * import edge to it (`new Worker(new URL(...))` is invisible to an import graph).
 *
 * - `broker-boot`: owns a `MemoryRepackedPort`-backed store and parks the worker thread in
 *   `serveForever()`. Once the loop is entered the thread never reaches its event loop again, so no
 *   further message is ever processed — that is the documented cost of the blocking shape, and
 *   `doorbell.requestStop()` is the only way out.
 * - `client-boot`: holds a `RepackedSyncClient` and runs batches of calls synchronously, blocking in
 *   `Atomics.wait` inside the worker. Used when the BROKER is the thing on the test thread.
 *
 * Nothing here runs on import: the handler is registered only in a worker.
 */

import { isMainThread } from "node:worker_threads";

import { RepackedSyncClient } from "../../src/broker/client";
import { RepackedChannel, RepackedDoorbell } from "../../src/broker/protocol";
import type { RepackedChannelTransfer } from "../../src/broker/protocol";
import { RepackedSyncBroker } from "../../src/broker/server";
import { MemoryRepackedPort } from "../../src/core/memory-port";
import { RepackedVfs } from "../../src/core/repacked-vfs";

/** Boot a store + broker inside the worker and park it in the blocking loop. */
export interface BrokerWorkerBoot {
  readonly kind: "broker-boot";
  readonly doorbell: SharedArrayBuffer;
  readonly channels: readonly RepackedChannelTransfer[];
  readonly extentSize: number;
}

/** Boot a synchronous client inside the worker; the broker lives elsewhere. */
export interface ClientWorkerBoot {
  readonly kind: "client-boot";
  readonly channel: RepackedChannelTransfer;
  readonly requestTimeoutMs?: number;
}

/** One client call, named exactly as `RepackedSyncClient` names it. */
export interface RemoteCall {
  readonly method: string;
  readonly args: readonly unknown[];
}

export interface RemoteRun {
  readonly kind: "run";
  readonly calls: readonly RemoteCall[];
}

export type BrokerWorkerMessage = BrokerWorkerBoot | ClientWorkerBoot | RemoteRun;

export interface WorkerReady {
  readonly kind: "ready";
}

export interface RemoteResults {
  readonly kind: "results";
  readonly results: readonly unknown[];
  /** `undefined` unless a call threw — a transport failure, never a file rejection. */
  readonly failure: string | undefined;
}

export type BrokerWorkerReply = WorkerReady | RemoteResults;

type ClientMethod = (...args: unknown[]) => unknown;

/** The worker global. bun provides the web worker API; the repo's `lib` deliberately excludes DOM. */
declare const self: {
  onmessage: ((event: MessageEvent<BrokerWorkerMessage>) => void) | null;
  postMessage: (message: unknown) => void;
};

function runCalls(client: RepackedSyncClient, calls: readonly RemoteCall[]): RemoteResults {
  const results: unknown[] = [];
  const table = client as unknown as Record<string, ClientMethod | undefined>;
  try {
    for (const call of calls) {
      const method = table[call.method];
      if (typeof method !== "function") throw new TypeError(`unknown client method ${call.method}`);
      results.push(method.apply(client, [...call.args]));
    }
  } catch (cause) {
    const failure = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
    return { kind: "results", results, failure };
  }
  return { kind: "results", results, failure: undefined };
}

async function bootBroker(boot: BrokerWorkerBoot): Promise<void> {
  const doorbell = RepackedDoorbell.attach(boot.doorbell);
  const vfs = await RepackedVfs.open(new MemoryRepackedPort(), { extentSize: boot.extentSize });
  const broker = new RepackedSyncBroker({ vfs, doorbell, log: () => {} });
  for (const transfer of boot.channels) broker.attach(RepackedChannel.attach(transfer));
  self.postMessage({ kind: "ready" } satisfies WorkerReady);
  // Turn the event loop once so the ready message is actually flushed: the very next statement parks
  // this thread in `Atomics.wait` and it never reaches its event loop again.
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  broker.serveForever();
  vfs.close();
}

if (!isMainThread) {
  let client: RepackedSyncClient | undefined;
  self.onmessage = (event: MessageEvent<BrokerWorkerMessage>) => {
    const message = event.data;
    if (message.kind === "run") {
      if (client === undefined) throw new Error("the client worker was not booted");
      self.postMessage(runCalls(client, message.calls));
      return;
    }
    if (message.kind === "client-boot") {
      client = new RepackedSyncClient(RepackedChannel.attach(message.channel), {
        ...(message.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: message.requestTimeoutMs }),
      });
      self.postMessage({ kind: "ready" } satisfies WorkerReady);
      return;
    }
    void bootBroker(message);
  };
}
