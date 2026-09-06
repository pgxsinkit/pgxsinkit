import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type {
  BrokerOpenResult,
  BrokerReadResult,
  BrokerResult,
} from "../../packages/pglite-opfs-repacked/src/broker/client";
import {
  O_CREAT,
  O_RDWR,
  O_TRUNC,
  O_WRONLY,
  RepackedChannel,
  RepackedDoorbell,
} from "../../packages/pglite-opfs-repacked/src/broker/protocol";
import { RepackedSyncBroker } from "../../packages/pglite-opfs-repacked/src/broker/server";
import { MemoryRepackedPort } from "../../packages/pglite-opfs-repacked/src/core/memory-port";
import { RepackedVfs } from "../../packages/pglite-opfs-repacked/src/core/repacked-vfs";
import { call, startClientWorker } from "../../packages/pglite-opfs-repacked/test/support/broker-harness";
import type { RemoteClientHandle } from "../../packages/pglite-opfs-repacked/test/support/broker-harness";

// The inverse thread arrangement to the other broker suites, and deliberately so: here the BROKER is
// what a test has to introspect (which descriptors it still holds, which clients it still serves), so
// it runs `serve()` — the `Atomics.waitAsync` loop for a host that must not park — on the test thread,
// and the CLIENTS block in `Atomics.wait` inside Workers. That is also the proof that `serve()` alone
// services a client with no coordinator worker anywhere.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const detachLog: string[] = [];

describe("opfs-repacked sync broker lifecycle", () => {
  let vfs: RepackedVfs;
  let doorbell: RepackedDoorbell;
  let broker: RepackedSyncBroker;
  let channels: RepackedChannel[];
  let serving: Promise<void>;
  let clients: RemoteClientHandle[];

  beforeEach(async () => {
    detachLog.length = 0;
    vfs = await RepackedVfs.open(new MemoryRepackedPort(), { extentSize: 8192 });
    doorbell = RepackedDoorbell.create();
    broker = new RepackedSyncBroker({
      vfs,
      doorbell,
      pollIntervalMs: 25,
      log: (message) => detachLog.push(message),
    });
    channels = [1, 2].map((id) => RepackedChannel.create({ id, doorbell }));
    for (const channel of channels) broker.attach(channel);
    serving = broker.serve();
    clients = await Promise.all(channels.map((channel) => startClientWorker(channel.transfer(), 15_000)));
  });

  afterEach(async () => {
    for (const client of clients) client.stop();
    doorbell.requestStop();
    await serving;
    vfs.close();
  });

  test("the async serve() loop answers a worker client with no coordinator worker in sight", async () => {
    const remote = clients[0]!;
    const scripted = await remote.run([
      call("mkdir", "/pg", { recursive: true, mode: 0o40700 }),
      call("open", "/pg/base", O_RDWR | O_CREAT | O_TRUNC, 0o100600),
    ]);
    expect(scripted.failure).toBeUndefined();
    expect(scripted.results[0]).toEqual({ errno: 0 });
    const opened = scripted.results[1] as BrokerOpenResult;
    expect(opened.errno).toBe(0);

    const payload = encoder.encode("served from the test thread");
    const roundTrip = await remote.run([
      call("write", opened.fd, payload),
      call("fsync", opened.fd),
      call("read", opened.fd, payload.byteLength, 0n),
      call("size", "/pg/base"),
      call("readdir", "/pg"),
      call("close", opened.fd),
    ]);
    expect(roundTrip.failure).toBeUndefined();
    expect(roundTrip.results[0]).toEqual({ errno: 0, count: payload.byteLength });
    expect(roundTrip.results[1]).toEqual({ errno: 0 });
    expect(decoder.decode((roundTrip.results[2] as BrokerReadResult).bytes)).toBe("served from the test thread");
    expect(roundTrip.results[3]).toEqual({ errno: 0, size: BigInt(payload.byteLength) });
    expect(roundTrip.results[4]).toEqual({ errno: 0, entries: ["base"] });
    expect(roundTrip.results[5]).toEqual({ errno: 0 });

    // The store the test thread owns saw all of it — the broker really is the only writer.
    expect(vfs.readdir("/pg")).toEqual(["base"]);
    expect(vfs.stat("/pg/base").size).toBe(BigInt(payload.byteLength));
  });

  test("detaching a client closes every descriptor it held and leaves the other client working", async () => {
    const [dying, survivor] = clients as [RemoteClientHandle, RemoteClientHandle];

    const opened = await dying.run([
      call("open", "/a", O_WRONLY | O_CREAT | O_TRUNC),
      call("open", "/b", O_WRONLY | O_CREAT | O_TRUNC),
      call("open", "/c", O_RDWR | O_CREAT | O_TRUNC),
    ]);
    expect(opened.failure).toBeUndefined();
    expect(opened.results.map((result) => (result as BrokerOpenResult).errno)).toEqual([0, 0, 0]);
    const held = opened.results.map((result) => (result as BrokerOpenResult).fd);

    const kept = await survivor.run([call("open", "/kept", O_RDWR | O_CREAT | O_TRUNC)]);
    const keptFd = (kept.results[0] as BrokerOpenResult).fd;

    expect(broker.openFdCount(1)).toBe(3);
    expect(broker.openFdCount(2)).toBe(1);
    expect(broker.openFdCount()).toBe(4);

    // A backend that dies mid-query never gets to close anything itself; the broker does it.
    broker.detach(channels[0]!, "the backend went away");
    expect(broker.openFdCount(1)).toBe(0);
    expect(broker.openFdCount()).toBe(1);
    expect(broker.attachedIds()).toEqual([2]);
    expect(detachLog).toEqual(["repacked broker detached channel 1: the backend went away"]);

    // The store itself agrees: the descriptors are gone, so nothing can still be read through them.
    for (const fd of held) expect(() => vfs.fstat(fd)).toThrow();

    // The detached client is finished and says so rather than parking forever.
    const afterDeath = await dying.run([call("stat", "/a")]);
    expect(afterDeath.failure).toContain("RepackedBrokerTransportError");

    // The survivor never noticed: same descriptor, same store, same files.
    const stillWorking = await survivor.run([
      call("write", keptFd, encoder.encode("survivor")),
      call("read", keptFd, 8, 0n),
      call("readdir", "/"),
      call("close", keptFd),
    ]);
    expect(stillWorking.failure).toBeUndefined();
    expect(stillWorking.results[0]).toEqual({ errno: 0, count: 8 });
    expect(decoder.decode((stillWorking.results[1] as BrokerReadResult).bytes)).toBe("survivor");
    expect(stillWorking.results[2]).toEqual({ errno: 0, entries: ["a", "b", "c", "kept"] });
    expect(stillWorking.results[3] as BrokerResult).toEqual({ errno: 0 });
    expect(broker.openFdCount()).toBe(0);
  });

  test("detachAll releases every descriptor without closing the store", async () => {
    await clients[0]!.run([call("open", "/one", O_WRONLY | O_CREAT | O_TRUNC)]);
    await clients[1]!.run([call("open", "/two", O_WRONLY | O_CREAT | O_TRUNC)]);
    expect(broker.openFdCount()).toBe(2);

    broker.detachAll("the coordinator is shutting down");
    expect(broker.attachedIds()).toEqual([]);
    expect(broker.openFdCount()).toBe(0);
    // The store is untouched: only the broker's borrowing of it ended.
    expect(vfs.readdir("/")).toEqual(["one", "two"]);
    expect(detachLog).toHaveLength(2);
  });
});
