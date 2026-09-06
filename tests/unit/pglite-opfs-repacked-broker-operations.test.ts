import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { RepackedSyncClient } from "../../packages/pglite-opfs-repacked/src/broker/client";
import {
  O_APPEND,
  O_CREAT,
  O_EXCL,
  O_RDONLY,
  O_RDWR,
  O_TRUNC,
  O_WRONLY,
} from "../../packages/pglite-opfs-repacked/src/broker/protocol";
import { FS_ERRNO } from "../../packages/pglite-opfs-repacked/src/core/errors";
import { startBrokerWorker } from "../../packages/pglite-opfs-repacked/test/support/broker-harness";
import type { BrokerWorkerHandle } from "../../packages/pglite-opfs-repacked/test/support/broker-harness";
import { ReferenceFs } from "../../packages/pglite-opfs-repacked/test/support/reference-fs";

// The full broker op matrix, driven exactly as a backend would drive it: the STORE and the blocking
// `serveForever()` loop live in a Worker, and the CLIENT blocks on this thread in `Atomics.wait`.
// That is the production shape (a coordinator worker with futex-parked backends), and bun 1.4.2
// permits `Atomics.wait` on the test thread, so no inversion was needed. Behaviour is diffed against
// `ReferenceFs`, the same independent model the core state suite uses.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** The broker's own timestamps are the wall clock, so the reference is fed the observed stat. */
function expectMatchesReference(client: RepackedSyncClient, reference: ReferenceFs): void {
  const modelled = reference.entries() as { path: string; kind: "directory" | "file"; size: bigint }[];
  for (const entry of modelled) {
    const observed = client.lstat(entry.path);
    expect({ path: entry.path, errno: observed.errno }).toEqual({ path: entry.path, errno: 0 });
    expect({ path: entry.path, kind: observed.stat?.kind, size: observed.stat?.size }).toEqual({
      path: entry.path,
      kind: entry.kind,
      size: entry.size,
    });
  }
  // Every directory's listing must match the model's children of that directory, exactly.
  for (const entry of modelled.filter((candidate) => candidate.kind === "directory")) {
    const expected = modelled
      .filter((candidate) => candidate.path !== entry.path && parentOf(candidate.path) === entry.path)
      .map((candidate) => candidate.path.slice(entry.path === "/" ? 1 : entry.path.length + 1))
      .sort();
    expect({ path: entry.path, entries: [...client.readdir(entry.path).entries] }).toEqual({
      path: entry.path,
      entries: expected,
    });
  }
}

function parentOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === 0 ? "/" : path.slice(0, slash);
}

describe("opfs-repacked sync broker operations", () => {
  let harness: BrokerWorkerHandle;
  let client: RepackedSyncClient;

  beforeEach(async () => {
    harness = await startBrokerWorker({ channelCount: 1, extentSize: 8192 });
    client = new RepackedSyncClient(harness.channels[0]!, { requestTimeoutMs: 15_000 });
  });

  afterEach(async () => {
    await harness.stop();
  });

  test("the whole op set round-trips and agrees with the independent reference filesystem", () => {
    const reference = new ReferenceFs();

    expect(client.mkdir("/data", { mode: 0o40700 }).errno).toBe(0);
    reference.mkdir("/data", 0o40700, 0n);
    expect(client.mkdir("/data/nested/deep", { recursive: true, mode: 0o40711 }).errno).toBe(0);
    reference.mkdir("/data/nested", 0o40711, 0n);
    reference.mkdir("/data/nested/deep", 0o40711, 0n);

    const created = client.open("/data/file", O_RDWR | O_CREAT | O_TRUNC, 0o100640);
    expect(created.errno).toBe(0);
    reference.createFile("/data/file", 0o100640, 0n, 0n);

    const payload = encoder.encode("the coordinator owns the store");
    expect(client.write(created.fd, payload)).toEqual({ errno: 0, count: payload.byteLength });
    reference.resize("/data/file", BigInt(payload.byteLength), 0n);

    // A cursor read starts where the write left off — end of file, so nothing comes back.
    expect(client.read(created.fd, 8)).toMatchObject({ errno: 0, count: 0 });
    // An explicit position leaves the cursor alone (the `fd_pread` shape).
    const head = client.read(created.fd, 3, 0n);
    expect(head.errno).toBe(0);
    expect(decoder.decode(head.bytes)).toBe("the");

    expect(client.fstat(created.fd).stat).toMatchObject({
      kind: "file",
      mode: 0o100640,
      size: BigInt(payload.byteLength),
    });
    expect(client.size("/data/file")).toEqual({ errno: 0, size: BigInt(payload.byteLength) });
    expect(client.stat("/data/file").stat?.size).toBe(BigInt(payload.byteLength));
    expect(client.lstat("/data/file").stat?.size).toBe(BigInt(payload.byteLength));

    expect(client.fsync(created.fd).errno).toBe(0);
    expect(client.close(created.fd).errno).toBe(0);

    expect(client.truncate("/data/file", 3n).errno).toBe(0);
    reference.resize("/data/file", 3n, 0n);
    expect(client.size("/data/file").size).toBe(3n);

    // Truncating UP zero-fills, which is the store's contract, not the broker's.
    expect(client.truncate("/data/file", 6n).errno).toBe(0);
    reference.resize("/data/file", 6n, 0n);
    const grown = client.open("/data/file", O_RDONLY);
    expect(client.read(grown.fd, 6, 0n).bytes).toEqual(Uint8Array.from([116, 104, 101, 0, 0, 0]));
    expect(client.close(grown.fd).errno).toBe(0);

    expect(client.rename("/data/file", "/data/nested/moved").errno).toBe(0);
    reference.rename("/data/file", "/data/nested/moved", 0n);

    expect(client.rmdir("/data/nested/deep").errno).toBe(0);
    reference.rmdir("/data/nested/deep", 0n);

    expectMatchesReference(client, reference);

    expect(client.unlink("/data/nested/moved").errno).toBe(0);
    reference.unlink("/data/nested/moved", 0n);
    expect(client.rmdir("/data/nested").errno).toBe(0);
    reference.rmdir("/data/nested", 0n);
    expect(client.rmdir("/data").errno).toBe(0);
    reference.rmdir("/data", 0n);

    expectMatchesReference(client, reference);
    expect(client.readdir("/")).toEqual({ errno: 0, entries: [] });
  });

  test("the POSIX open bits map onto the core's flag vocabulary", () => {
    // O_CREAT|O_EXCL is exclusive creation, and repeating it is EEXIST.
    const exclusive = client.open("/exclusive", O_WRONLY | O_CREAT | O_EXCL);
    expect(exclusive.errno).toBe(0);
    expect(client.write(exclusive.fd, encoder.encode("one")).count).toBe(3);
    expect(client.close(exclusive.fd).errno).toBe(0);
    expect(client.open("/exclusive", O_WRONLY | O_CREAT | O_EXCL).errno).toBe(FS_ERRNO.EEXIST);

    // O_CREAT WITHOUT O_TRUNC keeps the existing bytes — the two-step the core cannot express alone.
    const reopened = client.open("/exclusive", O_RDWR | O_CREAT);
    expect(reopened.errno).toBe(0);
    expect(client.size("/exclusive").size).toBe(3n);
    expect(client.close(reopened.fd).errno).toBe(0);

    // …and on a path that does not exist it creates an empty file.
    const fresh = client.open("/fresh", O_RDWR | O_CREAT);
    expect(fresh.errno).toBe(0);
    expect(client.size("/fresh").size).toBe(0n);
    expect(client.close(fresh.fd).errno).toBe(0);

    // O_TRUNC WITHOUT O_CREAT truncates an existing file and refuses a missing one.
    const truncating = client.open("/exclusive", O_RDWR | O_TRUNC);
    expect(truncating.errno).toBe(0);
    expect(client.size("/exclusive").size).toBe(0n);
    expect(client.close(truncating.fd).errno).toBe(0);
    expect(client.open("/absent", O_RDWR | O_TRUNC).errno).toBe(FS_ERRNO.ENOENT);

    // O_APPEND WITHOUT O_CREAT must not create; with it, writes land at end-of-file.
    expect(client.open("/absent", O_WRONLY | O_APPEND).errno).toBe(FS_ERRNO.ENOENT);
    const appending = client.open("/appended", O_WRONLY | O_CREAT | O_APPEND);
    expect(client.write(appending.fd, encoder.encode("aa")).count).toBe(2);
    expect(client.write(appending.fd, encoder.encode("bb")).count).toBe(2);
    expect(client.close(appending.fd).errno).toBe(0);
    const verify = client.open("/appended", O_RDONLY);
    expect(decoder.decode(client.read(verify.fd, 4, 0n).bytes)).toBe("aabb");
    expect(client.close(verify.fd).errno).toBe(0);

    // Access is enforced by the BROKER, not only by the core descriptor it widened to get here.
    const readOnly = client.open("/appended", O_RDONLY);
    expect(client.write(readOnly.fd, encoder.encode("x")).errno).toBe(FS_ERRNO.EBADF);
    expect(client.close(readOnly.fd).errno).toBe(0);
    const writeOnly = client.open("/appended", O_WRONLY | O_CREAT);
    expect(client.read(writeOnly.fd, 1, 0n).errno).toBe(FS_ERRNO.EBADF);
    expect(client.close(writeOnly.fd).errno).toBe(0);

    // Combinations with no meaning are rejected before the store is touched.
    expect(client.open("/appended", O_RDONLY | O_CREAT).errno).toBe(FS_ERRNO.EINVAL);
    expect(client.open("/appended", O_WRONLY | O_EXCL).errno).toBe(FS_ERRNO.EINVAL);
    expect(client.open("/appended", O_WRONLY | O_CREAT | O_TRUNC | O_APPEND).errno).toBe(FS_ERRNO.EINVAL);
  });

  test("a readdir larger than one payload page is stitched from cursor pages", async () => {
    // A 1 KiB payload holds only a handful of 40-byte names, so the listing has to page.
    await harness.stop();
    harness = await startBrokerWorker({ channelCount: 1, payloadBytes: 1024, extentSize: 8192 });
    client = new RepackedSyncClient(harness.channels[0]!, { requestTimeoutMs: 15_000 });

    const names = Array.from({ length: 64 }, (_unused, index) => `entry-${String(index).padStart(30, "0")}`);
    for (const name of names) {
      const opened = client.open(`/${name}`, O_WRONLY | O_CREAT | O_TRUNC);
      expect(opened.errno).toBe(0);
      expect(client.close(opened.fd).errno).toBe(0);
    }

    const firstPage = client.readdirPage("/", 0);
    expect(firstPage.errno).toBe(0);
    expect(firstPage.entries.length).toBeGreaterThan(0);
    expect(firstPage.entries.length).toBeLessThan(names.length);
    expect(firstPage.nextCursor).toBe(firstPage.entries.length);

    expect(client.readdir("/")).toEqual({ errno: 0, entries: [...names].sort() });
  });
});
