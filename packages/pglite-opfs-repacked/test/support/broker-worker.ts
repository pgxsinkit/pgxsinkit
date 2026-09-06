/**
 * The worker roles the broker and WASI suites need, in one module so the unit-test selector sees a
 * real import edge to it (`new Worker(new URL(...))` is invisible to an import graph).
 *
 * - `broker-boot`: owns a `MemoryRepackedPort`-backed store and parks the worker thread in
 *   `serveForever()`. Once the loop is entered the thread never reaches its event loop again, so no
 *   further message is ever processed — that is the documented cost of the blocking shape, and
 *   `doorbell.requestStop()` is the only way out.
 * - `client-boot`: holds a `RepackedSyncClient` and runs batches of calls synchronously, blocking in
 *   `Atomics.wait` inside the worker. Used when the BROKER is the thing on the test thread.
 * - `wasi-boot`: the same inversion for the WASI preview1 adapter — the adapter (and its own guest
 *   memory) live in the worker so the BROKER can be introspected from the test thread, which is the
 *   only way to watch `openFdCount` fall as `closeAll()` runs.
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
import {
  OFLAGS_CREAT,
  OFLAGS_TRUNC,
  RIGHTS_FD_READ,
  RIGHTS_FD_WRITE,
  WASI_ERRNO,
  createWasiPreview1Fs,
} from "../../src/wasi/preview1";
import type { WasiPreview1Fs } from "../../src/wasi/preview1";
import { GuestMemory } from "./wasi-guest";

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

/** Boot a WASI preview1 adapter inside the worker over a channel the test thread's broker serves. */
export interface WasiWorkerBoot {
  readonly kind: "wasi-boot";
  readonly channel: RepackedChannelTransfer;
  readonly requestTimeoutMs?: number;
}

/** Open each path through `path_open`, creating it, and keep every descriptor. */
export interface WasiOpenRun {
  readonly kind: "wasi-open";
  readonly paths: readonly string[];
}

/** Release every descriptor the adapter holds, the way a thread does on its way out. */
export interface WasiCloseAllRun {
  readonly kind: "wasi-close-all";
}

export type BrokerWorkerMessage =
  | BrokerWorkerBoot
  | ClientWorkerBoot
  | RemoteRun
  | WasiWorkerBoot
  | WasiOpenRun
  | WasiCloseAllRun;

export interface WorkerReady {
  readonly kind: "ready";
}

export interface RemoteResults {
  readonly kind: "results";
  readonly results: readonly unknown[];
  /** `undefined` unless a call threw — a transport failure, never a file rejection. */
  readonly failure: string | undefined;
}

/** What the WASI worker reports after an open batch or a `closeAll()`. */
export interface WasiResults {
  readonly kind: "wasi-results";
  readonly errnos: readonly number[];
  readonly fds: readonly number[];
  /** Descriptors `closeAll()` released, and what the adapter still holds afterwards. */
  readonly released: number;
  readonly openFdCount: number;
}

export type BrokerWorkerReply = WorkerReady | RemoteResults | WasiResults;

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
  let wasi: WasiPreview1Fs | undefined;
  let guest: GuestMemory | undefined;
  self.onmessage = (event: MessageEvent<BrokerWorkerMessage>) => {
    const message = event.data;
    if (message.kind === "run") {
      if (client === undefined) throw new Error("the client worker was not booted");
      self.postMessage(runCalls(client, message.calls));
      return;
    }
    if (message.kind === "wasi-open") {
      if (wasi === undefined || guest === undefined) throw new Error("the WASI worker was not booted");
      const errnos: number[] = [];
      const fds: number[] = [];
      const rights = RIGHTS_FD_READ | RIGHTS_FD_WRITE;
      for (const path of message.paths) {
        const encoded = guest.string(path);
        const out = guest.alloc(4);
        const errno = wasi.path_open(
          3,
          0,
          encoded.ptr,
          encoded.len,
          OFLAGS_CREAT | OFLAGS_TRUNC,
          rights,
          rights,
          0,
          out,
        );
        errnos.push(errno);
        fds.push(errno === WASI_ERRNO.SUCCESS ? guest.u32(out) : -1);
      }
      self.postMessage({
        kind: "wasi-results",
        errnos,
        fds,
        released: 0,
        openFdCount: wasi.openFdCount(),
      } satisfies WasiResults);
      return;
    }
    if (message.kind === "wasi-close-all") {
      if (wasi === undefined) throw new Error("the WASI worker was not booted");
      const released = wasi.closeAll();
      self.postMessage({
        kind: "wasi-results",
        errnos: [],
        fds: [],
        released,
        openFdCount: wasi.openFdCount(),
      } satisfies WasiResults);
      return;
    }
    if (message.kind === "wasi-boot") {
      const wasiClient = new RepackedSyncClient(RepackedChannel.attach(message.channel), {
        ...(message.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: message.requestTimeoutMs }),
      });
      guest = new GuestMemory({ pages: 4 });
      wasi = createWasiPreview1Fs({ client: wasiClient, memory: guest.resolver });
      self.postMessage({ kind: "ready" } satisfies WorkerReady);
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
