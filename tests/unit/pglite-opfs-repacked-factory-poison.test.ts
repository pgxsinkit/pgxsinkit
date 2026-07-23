/* oxlint-disable typescript/await-thenable -- bun-types gap: .resolves/.rejects matchers return real promises typed as void */
import { describe, expect, test } from "bun:test";

import { PGlite } from "@electric-sql/pglite";

import { StoreFailedError } from "../../packages/pglite-opfs-repacked/src/core/errors";
import { OpfsRepackedPort } from "../../packages/pglite-opfs-repacked/src/opfs-port";
import { openOpfsRepackedFsForPort } from "../../packages/pglite-opfs-repacked/src/opfs-repacked-fs";
import { createOpfsRepackedPGlite } from "../../packages/pglite-opfs-repacked/src/pglite-factory";
import { MemoryOpfsDirectory } from "../../packages/pglite-opfs-repacked/test/support/memory-opfs";

describe("opfs-repacked PGlite poison delivery", () => {
  test("an awaited durability failure rejects its query, poisons cache-only queries, and still closes every handle", async () => {
    const directory = new MemoryOpfsDirectory();
    const pg = await createOpfsRepackedPGlite({ directory, durability: "strict", extentSize: 8192 });
    await pg.exec("CREATE TABLE values_to_flush (value integer)");
    const activeMetadata =
      directory.flushCount("metadata-a.bin") >= directory.flushCount("metadata-b.bin")
        ? "metadata-a.bin"
        : "metadata-b.bin";
    const failure = new Error("forced awaited metadata flush failure");
    directory.failNextFlush(activeMetadata, failure);

    await expect(pg.exec("INSERT INTO values_to_flush VALUES (1)")).rejects.toBe(failure);
    await expect(pg.exec("SELECT value FROM values_to_flush")).rejects.toBeInstanceOf(StoreFailedError);
    const flushesBeforeClose =
      directory.flushCount("arena.bin") +
      directory.flushCount("metadata-a.bin") +
      directory.flushCount("metadata-b.bin") +
      directory.flushCount("activation.bin");
    await expect(pg.close()).rejects.toBeInstanceOf(StoreFailedError);
    expect(
      directory.flushCount("arena.bin") +
        directory.flushCount("metadata-a.bin") +
        directory.flushCount("metadata-b.bin") +
        directory.flushCount("activation.bin"),
    ).toBe(flushesBeforeClose);
    expect(directory.openHandleCount()).toBe(0);
  });

  test("a due deferred repack failure poisons the triggering sync and the next cache-only query", async () => {
    const directory = new MemoryOpfsDirectory();
    const fs = await openOpfsRepackedFsForPort(new OpfsRepackedPort(directory), {
      durability: "relaxed",
      extentSize: 8192,
    });
    const pg = new PGlite({ fs, relaxedDurability: false });
    await pg.waitReady;
    fs.strictSync();

    fs.writeFile("/deferred-pressure", new Uint8Array(8192));
    fs.strictSync();
    fs.unlink("/deferred-pressure");
    const failure = new Error("forced deferred repack activation flush failure");
    directory.failNextFlush("activation.bin", failure);

    await expect(pg.exec("SELECT 1")).rejects.toBe(failure);
    await expect(pg.exec("SELECT 2")).rejects.toBeInstanceOf(StoreFailedError);
    await expect(pg.close()).rejects.toBeInstanceOf(StoreFailedError);
    // Host-generation-agnostic: upstream close() aborts before closeFs (a direct
    // closeFs then rejects on the still-open poisoned store), while PR #1063's
    // close always releases the filesystem first (a second closeFs is a no-op).
    // The invariant is the same either way: no handle survives.
    await fs.closeFs().catch((error: unknown) => {
      expect(error).toBeInstanceOf(StoreFailedError);
    });
    expect(directory.openHandleCount()).toBe(0);
  });
});
