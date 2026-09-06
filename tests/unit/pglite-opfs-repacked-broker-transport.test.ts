import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  RepackedBrokerTransportError,
  RepackedSyncClient,
} from "../../packages/pglite-opfs-repacked/src/broker/client";
import {
  DEFAULT_PAYLOAD_BYTES,
  FAULT_PROTOCOL,
  HEADER_FAULT,
  HEADER_OPCODE,
  HEADER_REQUEST,
  HEADER_STATE,
  O_CREAT,
  O_RDONLY,
  O_RDWR,
  O_TRUNC,
  O_WRONLY,
  STATE_DETACHED,
  STATE_REQUEST,
} from "../../packages/pglite-opfs-repacked/src/broker/protocol";
import type { RepackedChannel } from "../../packages/pglite-opfs-repacked/src/broker/protocol";
import { FS_ERRNO } from "../../packages/pglite-opfs-repacked/src/core/errors";
import { startBrokerWorker } from "../../packages/pglite-opfs-repacked/test/support/broker-harness";
import type { BrokerWorkerHandle } from "../../packages/pglite-opfs-repacked/test/support/broker-harness";

// The transport contract: chunking above the payload region, errno pass-through, two independent
// clients on one store, and a protocol violation costing only the client that committed it. The store
// and the blocking `serveForever()` loop are in a Worker; the clients park on this thread.

const encoder = new TextEncoder();

/** Publish a raw request without the client, so a malformed one can be sent on purpose. */
function publishRaw(channel: RepackedChannel, opcode: number, requestBytes: number): number {
  const header = channel.header;
  Atomics.store(header, HEADER_OPCODE, opcode);
  Atomics.store(header, HEADER_REQUEST, requestBytes);
  Atomics.store(header, HEADER_STATE, STATE_REQUEST);
  channel.doorbell.ring();
  while (Atomics.load(header, HEADER_STATE) === STATE_REQUEST) {
    if (Atomics.wait(header, HEADER_STATE, STATE_REQUEST, 15_000) === "timed-out") break;
  }
  return Atomics.load(header, HEADER_STATE);
}

describe("opfs-repacked sync broker transport", () => {
  let harness: BrokerWorkerHandle;

  afterEach(async () => {
    await harness.stop();
  });

  describe("one client", () => {
    let client: RepackedSyncClient;

    beforeEach(async () => {
      harness = await startBrokerWorker({ channelCount: 1, extentSize: 65_536 });
      client = new RepackedSyncClient(harness.channels[0]!, { requestTimeoutMs: 30_000 });
    });

    test("a 1 MiB write and read-back through a 64 KiB channel is byte-exact", () => {
      expect(harness.channels[0]!.payloadBytes).toBe(DEFAULT_PAYLOAD_BYTES);
      expect(client.maxTransferBytes).toBeLessThan(DEFAULT_PAYLOAD_BYTES);

      const megabyte = new Uint8Array(1024 * 1024);
      for (let index = 0; index < megabyte.byteLength; index += 1) megabyte[index] = (index * 31 + 7) % 251;

      const opened = client.open("/big", O_RDWR | O_CREAT | O_TRUNC);
      expect(opened.errno).toBe(0);
      // 1 MiB does not fit one 64 KiB payload — the client splits it and the caller never sees that.
      expect(client.write(opened.fd, megabyte)).toEqual({ errno: 0, count: megabyte.byteLength });
      expect(client.fsync(opened.fd).errno).toBe(0);
      expect(client.size("/big")).toEqual({ errno: 0, size: BigInt(megabyte.byteLength) });

      const readBack = client.read(opened.fd, megabyte.byteLength, 0n);
      expect(readBack.errno).toBe(0);
      expect(readBack.count).toBe(megabyte.byteLength);
      expect(readBack.bytes).toEqual(megabyte);

      // A cursor read of the whole file after the write must be at end-of-file, then a rewound pread
      // still spans every chunk boundary correctly.
      expect(client.read(opened.fd, 16).count).toBe(0);
      const straddling = client.read(opened.fd, 64, BigInt(client.maxTransferBytes - 32));
      expect(straddling.bytes).toEqual(megabyte.subarray(client.maxTransferBytes - 32, client.maxTransferBytes + 32));

      // Reading past the end returns only what exists rather than erroring or padding.
      const tail = client.read(opened.fd, 4096, BigInt(megabyte.byteLength - 10));
      expect(tail).toMatchObject({ errno: 0, count: 10 });
      expect(client.close(opened.fd).errno).toBe(0);
    });

    test("file rejections arrive as errno values and never as throws", () => {
      expect(client.stat("/missing").errno).toBe(FS_ERRNO.ENOENT);
      expect(client.open("/missing", O_RDONLY).errno).toBe(FS_ERRNO.ENOENT);
      expect(client.unlink("/missing").errno).toBe(FS_ERRNO.ENOENT);
      expect(client.size("/missing").errno).toBe(FS_ERRNO.ENOENT);

      expect(client.read(4242, 8, 0n).errno).toBe(FS_ERRNO.EBADF);
      expect(client.write(4242, encoder.encode("x"), 0n).errno).toBe(FS_ERRNO.EBADF);
      expect(client.fstat(4242).errno).toBe(FS_ERRNO.EBADF);
      expect(client.close(4242).errno).toBe(FS_ERRNO.EBADF);
      expect(client.fsync(4242).errno).toBe(FS_ERRNO.EBADF);

      expect(client.mkdir("/dir").errno).toBe(0);
      expect(client.mkdir("/dir").errno).toBe(FS_ERRNO.EEXIST);
      const held = client.open("/dir/file", O_WRONLY | O_CREAT | O_TRUNC);
      expect(held.errno).toBe(0);
      expect(client.close(held.fd).errno).toBe(0);
      expect(client.rmdir("/dir").errno).toBe(FS_ERRNO.ENOTEMPTY);

      // Renaming a file over a directory cannot be a replacement, and says so.
      expect(client.mkdir("/target").errno).toBe(0);
      expect(client.rename("/dir/file", "/target").errno).toBe(FS_ERRNO.EISDIR);
      // …and a directory over a NON-EMPTY directory is ENOTEMPTY.
      expect(client.rename("/target", "/dir").errno).toBe(FS_ERRNO.ENOTEMPTY);
      // The store is untouched by every one of those rejections.
      expect(client.readdir("/")).toEqual({ errno: 0, entries: ["dir", "target"] });
      expect(client.readdir("/dir")).toEqual({ errno: 0, entries: ["file"] });
    });
  });

  describe("two clients", () => {
    let first: RepackedSyncClient;
    let second: RepackedSyncClient;

    beforeEach(async () => {
      harness = await startBrokerWorker({ channelCount: 2, extentSize: 8192 });
      first = new RepackedSyncClient(harness.channels[0]!, { requestTimeoutMs: 15_000 });
      second = new RepackedSyncClient(harness.channels[1]!, { requestTimeoutMs: 15_000 });
    });

    test("interleaved clients share one store and keep separate descriptor tables", () => {
      expect(first.mkdir("/shared").errno).toBe(0);
      // The second client sees the first client's directory immediately — one store, one owner.
      expect(second.stat("/shared").stat?.kind).toBe("directory");

      const written = first.open("/shared/note", O_RDWR | O_CREAT | O_TRUNC);
      expect(written.errno).toBe(0);
      expect(first.write(written.fd, encoder.encode("written by one")).count).toBe(14);
      expect(first.fsync(written.fd).errno).toBe(0);

      // The reader is a different client with its own fds, reading what the other just wrote.
      const reading = second.open("/shared/note", O_RDONLY);
      expect(reading.errno).toBe(0);
      expect(new TextDecoder().decode(second.read(reading.fd, 14, 0n).bytes)).toBe("written by one");

      // A descriptor belongs to the client that opened it. Fd numbers come from one store-wide
      // sequence, so `written.fd` is a real descriptor — just not this client's.
      expect(reading.fd).not.toBe(written.fd);
      expect(second.read(written.fd, 4, 0n).errno).toBe(FS_ERRNO.EBADF);
      expect(second.close(written.fd).errno).toBe(FS_ERRNO.EBADF);
      expect(first.fstat(written.fd).errno).toBe(0);

      // Interleaving both directions: each write is visible to the other client's next read.
      for (let round = 0; round < 8; round += 1) {
        const author = round % 2 === 0 ? first : second;
        const reader = round % 2 === 0 ? second : first;
        const bytes = encoder.encode(`round-${round}`);
        expect(author.write(round % 2 === 0 ? written.fd : reading.fd, bytes, 0n).errno).toBe(
          round % 2 === 0 ? 0 : FS_ERRNO.EBADF,
        );
        if (round % 2 !== 0) continue;
        expect(new TextDecoder().decode(reader.read(reading.fd, bytes.byteLength, 0n).bytes)).toBe(`round-${round}`);
      }

      expect(first.close(written.fd).errno).toBe(0);
      expect(second.close(reading.fd).errno).toBe(0);
    });

    test("a bad opcode detaches only the client that sent it", () => {
      expect(first.mkdir("/before").errno).toBe(0);
      const survivor = second.open("/keep", O_WRONLY | O_CREAT | O_TRUNC);
      expect(survivor.errno).toBe(0);

      // A raw request with an opcode the server does not speak: a protocol violation, not a file error.
      expect(publishRaw(harness.channels[0]!, 0x7fff, 0)).toBe(STATE_DETACHED);
      expect(Atomics.load(harness.channels[0]!.header, HEADER_FAULT)).toBe(FAULT_PROTOCOL);

      // The offending client is finished: every later call throws instead of blocking forever.
      expect(() => first.stat("/before")).toThrow(RepackedBrokerTransportError);
      try {
        first.stat("/before");
        expect.unreachable();
      } catch (cause) {
        expect(cause).toBeInstanceOf(RepackedBrokerTransportError);
        expect((cause as RepackedBrokerTransportError).brokerCode).toBe("detached");
      }

      // The other client never noticed, keeps its descriptor, and keeps the store.
      expect(second.write(survivor.fd, encoder.encode("still here")).count).toBe(10);
      expect(second.stat("/before").stat?.kind).toBe("directory");
      expect(second.readdir("/")).toEqual({ errno: 0, entries: ["before", "keep"] });
      expect(second.close(survivor.fd).errno).toBe(0);
    });
  });
});
