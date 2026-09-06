import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { RepackedSyncClient } from "../../packages/pglite-opfs-repacked/src/broker/client";
import { RepackedChannel, RepackedDoorbell } from "../../packages/pglite-opfs-repacked/src/broker/protocol";
import { RepackedSyncBroker } from "../../packages/pglite-opfs-repacked/src/broker/server";
import { MemoryRepackedPort } from "../../packages/pglite-opfs-repacked/src/core/memory-port";
import { RepackedVfs } from "../../packages/pglite-opfs-repacked/src/core/repacked-vfs";
import {
  OFLAGS_CREAT,
  OFLAGS_TRUNC,
  RIGHTS_FD_READ,
  RIGHTS_FD_WRITE,
  WASI_ERRNO,
  createWasiPreview1Fs,
} from "../../packages/pglite-opfs-repacked/src/wasi/preview1";
import { startBrokerWorker, startWasiWorker } from "../../packages/pglite-opfs-repacked/test/support/broker-harness";
import type {
  BrokerWorkerHandle,
  RemoteWasiHandle,
} from "../../packages/pglite-opfs-repacked/test/support/broker-harness";
import { GuestMemory } from "../../packages/pglite-opfs-repacked/test/support/wasi-guest";

// Composition is the whole reason the adapter publishes `owns()`: a host already has a WASI object
// with its stdio, its clock, its `poll_oneoff` and its `proc_exit`, and the ONLY thing that should
// change is where a file call for an adapter-owned fd lands.

const RW = RIGHTS_FD_READ | RIGHTS_FD_WRITE;

describe("opfs-repacked WASI preview1 composition", () => {
  let broker: BrokerWorkerHandle;

  beforeEach(async () => {
    broker = await startBrokerWorker({ channelCount: 1 });
  });

  afterEach(async () => {
    await broker.stop();
  });

  test("compose routes stdio to the base host and every adapter fd to the adapter", () => {
    const memory = new GuestMemory({ pages: 4 });
    const client = new RepackedSyncClient(broker.channels[0]!, { requestTimeoutMs: 15_000 });
    const wasi = createWasiPreview1Fs({ client, memory: memory.resolver });

    const seen: string[] = [];
    const base = {
      // The host's own stdio: fd 0/1/2 must keep landing here, byte for byte.
      fd_write: (fd: number) => {
        seen.push(`base fd_write ${fd}`);
        return WASI_ERRNO.SUCCESS;
      },
      fd_read: (fd: number) => {
        seen.push(`base fd_read ${fd}`);
        return WASI_ERRNO.SUCCESS;
      },
      fd_close: (fd: number) => {
        seen.push(`base fd_close ${fd}`);
        return WASI_ERRNO.SUCCESS;
      },
      fd_prestat_get: (fd: number) => {
        seen.push(`base fd_prestat_get ${fd}`);
        return WASI_ERRNO.BADF;
      },
      path_open: (dirfd: number) => {
        seen.push(`base path_open ${dirfd}`);
        return WASI_ERRNO.BADF;
      },
      // Nothing about these is a filesystem concern, so `compose` must leave them exactly as they are.
      clock_time_get: () => WASI_ERRNO.SUCCESS,
      poll_oneoff: () => WASI_ERRNO.SUCCESS,
      proc_exit: () => {
        throw new Error("guest exited");
      },
      random_get: () => WASI_ERRNO.SUCCESS,
    };

    const merged = wasi.compose(base) as Record<string, (...args: unknown[]) => number>;

    // The non-filesystem imports are carried through by IDENTITY, not by a wrapper.
    expect(merged["clock_time_get"]).toBe(base.clock_time_get);
    expect(merged["poll_oneoff"]).toBe(base.poll_oneoff);
    expect(merged["proc_exit"]).toBe(base.proc_exit);
    expect(merged["random_get"]).toBe(base.random_get);

    // fds 0-2 belong to the base host and the adapter never claims them.
    expect(wasi.owns(0)).toBe(false);
    expect(wasi.owns(1)).toBe(false);
    expect(wasi.owns(2)).toBe(false);
    expect(wasi.owns(3)).toBe(true);
    expect(wasi.owns(4)).toBe(true);
    expect(wasi.owns(4096)).toBe(true);

    const iovs = memory.iovecs([{ ptr: memory.buffer(new Uint8Array([65])), len: 1 }]);
    const out = memory.alloc(4);
    expect(merged["fd_write"]!(1, iovs, 1, out)).toBe(WASI_ERRNO.SUCCESS);
    expect(merged["fd_read"]!(0, iovs, 1, out)).toBe(WASI_ERRNO.SUCCESS);
    expect(merged["fd_close"]!(2)).toBe(WASI_ERRNO.SUCCESS);
    expect(seen).toEqual(["base fd_write 1", "base fd_read 0", "base fd_close 2"]);

    // The preopen and everything the adapter hands out go the other way — the base host is never
    // consulted, so its own preopen table cannot answer for a store path.
    const prestat = memory.alloc(8);
    expect(merged["fd_prestat_get"]!(3, prestat)).toBe(WASI_ERRNO.SUCCESS);
    const path = memory.string("/composed.txt");
    const openOut = memory.alloc(4);
    expect(merged["path_open"]!(3, 0, path.ptr, path.len, OFLAGS_CREAT | OFLAGS_TRUNC, RW, RW, 0, openOut)).toBe(
      WASI_ERRNO.SUCCESS,
    );
    const fd = memory.u32(openOut);
    expect(fd).toBeGreaterThanOrEqual(4);
    expect(merged["fd_write"]!(fd, iovs, 1, out)).toBe(WASI_ERRNO.SUCCESS);
    expect(memory.u32(out)).toBe(1);
    expect(merged["fd_close"]!(fd)).toBe(WASI_ERRNO.SUCCESS);
    // Still only the three base calls: nothing the adapter owns ever reached the host.
    expect(seen).toEqual(["base fd_write 1", "base fd_read 0", "base fd_close 2"]);

    // A call the base host does not implement at all (this module imports 33 of the 46 preview1
    // functions, and `fd_tell` is not one of them) is answered for adapter fds and EBADF elsewhere.
    expect(typeof merged["fd_tell"]).toBe("function");
    const tellOut = memory.alloc(8);
    expect(merged["fd_tell"]!(1, tellOut)).toBe(WASI_ERRNO.BADF);
    expect(merged["fd_tell"]!(9999, tellOut)).toBe(WASI_ERRNO.BADF); // owned range, but never opened
  });
});

describe("opfs-repacked WASI preview1 descriptor release", () => {
  // The inverse arrangement: the BROKER runs its `Atomics.waitAsync` loop here so the test can watch
  // `openFdCount`, and the ADAPTER blocks inside a worker — which is where a real backend's would.
  let vfs: RepackedVfs;
  let doorbell: RepackedDoorbell;
  let server: RepackedSyncBroker;
  let channel: RepackedChannel;
  let serving: Promise<void>;
  let remote: RemoteWasiHandle;

  beforeEach(async () => {
    vfs = await RepackedVfs.open(new MemoryRepackedPort(), { extentSize: 8192 });
    doorbell = RepackedDoorbell.create();
    server = new RepackedSyncBroker({ vfs, doorbell, pollIntervalMs: 25, log: () => {} });
    channel = RepackedChannel.create({ id: 1, doorbell });
    server.attach(channel);
    serving = server.serve();
    remote = await startWasiWorker(channel.transfer(), 15_000);
  });

  afterEach(async () => {
    remote.stop();
    doorbell.requestStop();
    await serving;
    vfs.close();
  });

  test("closeAll releases every store descriptor the thread held", async () => {
    const opened = await remote.open(["/one.dat", "/two.dat", "/three.dat"]);
    expect(opened.errnos).toEqual([0, 0, 0]);
    expect(opened.fds).toEqual([4, 5, 6]);
    expect(opened.openFdCount).toBe(3);
    // Every one of them is a real descriptor the coordinator holds open on the one store.
    expect(server.openFdCount(1)).toBe(3);

    const released = await remote.closeAll();
    expect(released.released).toBe(3);
    expect(released.openFdCount).toBe(0);
    // This is the assertion that matters for thread exit: without closeAll the coordinator would sit
    // on those descriptors until the whole channel detached.
    expect(server.openFdCount(1)).toBe(0);
    expect(server.attachedIds()).toEqual([1]);

    // The adapter is reusable afterwards, and its fd numbering restarts from the base.
    const again = await remote.open(["/four.dat"]);
    expect(again.errnos).toEqual([0]);
    expect(again.fds).toEqual([4]);
    expect(server.openFdCount(1)).toBe(1);
    expect(vfs.readdir("/").sort()).toEqual(["four.dat", "one.dat", "three.dat", "two.dat"]);
  });
});
