/* oxlint-disable typescript/await-thenable -- bun-types gap: .resolves/.rejects matchers return real promises typed as void */
import { describe, expect, test } from "bun:test";

import { cBuild } from "../../packages/pgwasm-c/src";
import { prepopulatedDataDir } from "../../packages/pgwasm-c/src/prepopulated";
import { createPgwasm } from "../../packages/pgwasm/src";
import { StoreFailedError } from "../../packages/pgwasm/src/opfs/core/errors";
import { createOpfsPgwasm } from "../../packages/pgwasm/src/opfs/create";
import { OpfsRepackedPort } from "../../packages/pgwasm/src/opfs/opfs-port";
import { openOpfsRepackedFsForPort } from "../../packages/pgwasm/src/opfs/opfs-repacked-fs";
import { MemoryOpfsDirectory } from "./support/pgwasm-opfs/memory-opfs";

describe("opfs-repacked pgwasm poison delivery", () => {
  test("an awaited durability failure rejects its query, poisons cache-only queries, and still closes every handle", async () => {
    const directory = new MemoryOpfsDirectory();
    const pg = await createOpfsPgwasm({
      build: cBuild,
      directory,
      durability: "strict",
      extentSize: 8192,
      pgwasm: { loadDataDir: await prepopulatedDataDir() },
    });
    await pg.exec("CREATE TABLE values_to_flush (value integer)");
    const activeMetadata =
      directory.flushCount("metadata-a.bin") >= directory.flushCount("metadata-b.bin")
        ? "metadata-a.bin"
        : "metadata-b.bin";
    const failure = new Error("forced awaited metadata flush failure");
    directory.failNextFlush(activeMetadata, failure);

    await expect(pg.exec("INSERT INTO values_to_flush VALUES (1)")).rejects.toBe(failure);
    // Planning the scan sizes the relation, which reaches the poisoned store: its `StoreFailedError`
    // carries `code` EIO, so the engine reports Postgres's own I/O error (SQLSTATE 58030) rather than
    // having the store's exception unwind through it.
    const scanError = await pg.exec("SELECT value FROM values_to_flush").then(
      () => undefined,
      (cause: unknown) => cause,
    );
    expect(scanError).toMatchObject({ code: "58030" });
    expect((scanError as Error).message).toMatch(/I\/O error$/);
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
    const pg = await createPgwasm({
      build: cBuild,
      fs,
      relaxedDurability: false,
      loadDataDir: await prepopulatedDataDir(),
    });
    fs.strictSync();

    fs.writeFile("/deferred-pressure", new Uint8Array(8192));
    fs.strictSync();
    fs.unlink("/deferred-pressure");
    const failure = new Error("forced deferred repack activation flush failure");
    directory.failNextFlush("activation.bin", failure);

    await expect(pg.exec("SELECT 1")).rejects.toBe(failure);
    await expect(pg.exec("SELECT 2")).rejects.toBeInstanceOf(StoreFailedError);
    await expect(pg.close()).rejects.toBeInstanceOf(StoreFailedError);
    // pgwasm's close always releases the filesystem (a second closeFs is a no-op, or rejects on a
    // still-open poisoned store). The invariant either way: no handle survives.
    await fs.closeFs().catch((error: unknown) => {
      expect(error).toBeInstanceOf(StoreFailedError);
    });
    expect(directory.openHandleCount()).toBe(0);
  });
});
