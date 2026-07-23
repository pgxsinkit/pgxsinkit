import { describe, expect, test } from "bun:test";

import { createOpfsRepackedPGlite } from "../../packages/pglite-opfs-repacked/src/pglite-factory";
import { MemoryOpfsDirectory } from "../../packages/pglite-opfs-repacked/test/support/memory-opfs";

describe("opfs-repacked PGlite factory sync integration", () => {
  test("the factory performs an initial strict barrier and awaited sync flushes only dirty queries", async () => {
    const directory = new MemoryOpfsDirectory();
    let awaitedSyncCalls = 0;
    const pg = await createOpfsRepackedPGlite({
      directory,
      durability: "strict",
      extentSize: 8192,
      pglite: {
        extensions: {
          observeAwaitedSync: {
            name: "observe-awaited-sync",
            setup: async (host) => {
              const fs = (
                host as unknown as {
                  fs: { syncToFs(relaxedDurability?: boolean): Promise<void> };
                }
              ).fs;
              const syncToFs = fs.syncToFs.bind(fs);
              fs.syncToFs = async (relaxedDurability) => {
                awaitedSyncCalls += 1;
                await syncToFs(relaxedDurability);
              };
              return {};
            },
          },
        },
      },
    });
    expect(directory.flushCount("arena.bin")).toBeGreaterThanOrEqual(2);

    await pg.exec("CREATE TABLE sync_boundaries (value integer)");
    const syncCallsBefore = awaitedSyncCalls;
    await Promise.all([
      pg.exec("INSERT INTO sync_boundaries VALUES (1)"),
      pg.exec("INSERT INTO sync_boundaries VALUES (2)"),
    ]);
    const arenaAfter = directory.flushCount("arena.bin");
    const metadataAfter = directory.flushCount("metadata-a.bin") + directory.flushCount("metadata-b.bin");
    expect(awaitedSyncCalls - syncCallsBefore).toBe(2);
    await Promise.all([pg.exec("SELECT value FROM sync_boundaries"), pg.exec("SELECT count(*) FROM sync_boundaries")]);
    expect(directory.flushCount("arena.bin")).toBe(arenaAfter);
    expect(directory.flushCount("metadata-a.bin") + directory.flushCount("metadata-b.bin")).toBe(metadataAfter);
    await pg.close();
    expect(directory.openHandleCount()).toBe(0);
  });

  test("the factory instance exposes the reserved strictSync operation", async () => {
    const directory = new MemoryOpfsDirectory();
    const pg = await createOpfsRepackedPGlite({ directory, durability: "relaxed", extentSize: 8192 });
    // Baseline after the factory's own post-init strict barrier.
    const metadataBefore = directory.flushCount("metadata-a.bin") + directory.flushCount("metadata-b.bin");

    await pg.exec("CREATE TABLE strict_op (value integer)");
    await pg.strictSync();
    // The appended metadata frames must have reached a metadata flush by the
    // time strictSync resolves — whether strictSync performed it or an
    // intervening repack already did (strictSync is then a legal no-op).
    expect(directory.flushCount("metadata-a.bin") + directory.flushCount("metadata-b.bin")).toBeGreaterThan(
      metadataBefore,
    );
    await pg.close();
  });
});
