import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";

import { cBuild } from "../../packages/pgwasm-c/src";
import { createOpfsPgwasm, strictSync } from "../../packages/pgwasm/src/opfs/create";
import { OpfsRepackedFS } from "../../packages/pgwasm/src/opfs/opfs-repacked-fs";
import { MemoryOpfsDirectory } from "./support/pgwasm-opfs/memory-opfs";

afterEach(() => {
  mock.restore();
});

describe("opfs-repacked pgwasm factory sync integration", () => {
  test("the factory performs an initial strict barrier and awaited sync flushes only dirty queries", async () => {
    const directory = new MemoryOpfsDirectory();
    // Every awaited sync pgwasm asks of the store, counted as it reaches the adapter.
    const syncToFs = spyOn(OpfsRepackedFS.prototype, "syncToFs");
    const pg = await createOpfsPgwasm({
      build: cBuild,
      directory,
      durability: "strict",
      extentSize: 8192,
    });
    expect(directory.flushCount("arena.bin")).toBeGreaterThanOrEqual(2);

    await pg.exec("CREATE TABLE sync_boundaries (value integer)");
    const syncCallsBefore = syncToFs.mock.calls.length;
    await Promise.all([
      pg.exec("INSERT INTO sync_boundaries VALUES (1)"),
      pg.exec("INSERT INTO sync_boundaries VALUES (2)"),
    ]);
    const arenaAfter = directory.flushCount("arena.bin");
    const metadataAfter = directory.flushCount("metadata-a.bin") + directory.flushCount("metadata-b.bin");
    expect(syncToFs.mock.calls.length - syncCallsBefore).toBe(2);
    await Promise.all([pg.exec("SELECT value FROM sync_boundaries"), pg.exec("SELECT count(*) FROM sync_boundaries")]);
    expect(directory.flushCount("arena.bin")).toBe(arenaAfter);
    expect(directory.flushCount("metadata-a.bin") + directory.flushCount("metadata-b.bin")).toBe(metadataAfter);
    await pg.close();
    expect(directory.openHandleCount()).toBe(0);
  });

  test("the factory instance exposes the reserved strictSync operation", async () => {
    const directory = new MemoryOpfsDirectory();
    const pg = await createOpfsPgwasm({ build: cBuild, directory, durability: "relaxed", extentSize: 8192 });
    // Baseline after the factory's own post-init strict barrier.
    const metadataBefore = directory.flushCount("metadata-a.bin") + directory.flushCount("metadata-b.bin");

    await pg.exec("CREATE TABLE strict_op (value integer)");
    await strictSync(pg);
    // The appended metadata frames must have reached a metadata flush by the
    // time strictSync resolves — whether strictSync performed it or an
    // intervening repack already did (strictSync is then a legal no-op).
    expect(directory.flushCount("metadata-a.bin") + directory.flushCount("metadata-b.bin")).toBeGreaterThan(
      metadataBefore,
    );
    await pg.close();
  });
});
