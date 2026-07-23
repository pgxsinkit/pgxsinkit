/* oxlint-disable typescript/await-thenable -- bun-types gap: .resolves/.rejects matchers return real promises typed as void */
import { describe, expect, test } from "bun:test";

import {
  DurabilityModeMismatchError,
  StoreFailedError,
  StoreOwnedError,
  UnexpectedStoreEntryError,
} from "../../packages/pglite-opfs-repacked/src/core/errors";
import { OpfsRepackedPort } from "../../packages/pglite-opfs-repacked/src/opfs-port";
import { openOpfsRepackedFsForPort } from "../../packages/pglite-opfs-repacked/src/opfs-repacked-fs";
import { createOpfsRepackedPGlite } from "../../packages/pglite-opfs-repacked/src/pglite-factory";
import { MemoryOpfsDirectory } from "../../packages/pglite-opfs-repacked/test/support/memory-opfs";
import { MemoryRepackedPort } from "../../packages/pglite-opfs-repacked/test/support/memory-port";

describe("opfs-repacked PGlite filesystem adapter", () => {
  test("awaited relaxed sync asserts health without flushing ordinary writes", async () => {
    const port = new MemoryRepackedPort();
    const fs = await openOpfsRepackedFsForPort(port, { durability: "relaxed", extentSize: 8192 });
    const durableBefore = port.durableBytes("metadata-a.bin");

    fs.writeFile("/value", "relaxed", { mode: 0o100600 });
    await fs.syncToFs(false);
    expect(port.durableBytes("metadata-a.bin")).toEqual(durableBefore);

    fs.strictSync();
    expect(port.durableBytes("metadata-a.bin")).not.toEqual(durableBefore);
    await fs.closeFs();
  });

  test("fractional-millisecond host timestamps are floored, not rejected", async () => {
    // Emscripten's utime path can produce sub-millisecond floats
    // (microsecond-precision utimensat converted to milliseconds).
    const port = new MemoryRepackedPort();
    const fs = await openOpfsRepackedFsForPort(port, { durability: "relaxed", extentSize: 8192 });
    fs.writeFile("/value", "timed", { mode: 0o100600 });

    fs.utimes("/value", 1752_999_123.75, 1752_999_456.25);
    const stats = fs.lstat("/value");
    expect(stats.atime).toBe(1752_999_123);
    expect(stats.mtime).toBe(1752_999_456);
    await fs.closeFs();
  });

  test("a non-awaited host sync poisons on first observation", async () => {
    const port = new MemoryRepackedPort();
    const fs = await openOpfsRepackedFsForPort(port, { durability: "strict", extentSize: 8192 });

    await expect(fs.syncToFs(true)).rejects.toBeInstanceOf(DurabilityModeMismatchError);
    expect(() => fs.readdir("/")).toThrow(StoreFailedError);
    await expect(fs.closeFs()).rejects.toThrow(StoreFailedError);
    expect(port.openHandleCount()).toBe(0);
  });

  test("the production port rejects extra entries before creating or acquiring owned files", async () => {
    const directory = new MemoryOpfsDirectory();
    directory.injectDirectory("unexpected");

    await expect(
      openOpfsRepackedFsForPort(new OpfsRepackedPort(directory), { extentSize: 8192 }),
    ).rejects.toBeInstanceOf(UnexpectedStoreEntryError);
    expect(directory.openHandleCount()).toBe(0);
  });

  test("the production port owns exactly four handles regardless of virtual file count", async () => {
    const directory = new MemoryOpfsDirectory();
    const first = await openOpfsRepackedFsForPort(new OpfsRepackedPort(directory), { extentSize: 8192 });
    expect(directory.openHandleCount()).toBe(4);
    for (let index = 0; index < 40; index += 1) {
      first.writeFile(`/value-${index}`, `value-${index}`);
    }
    expect(directory.openHandleCount()).toBe(4);

    await expect(
      openOpfsRepackedFsForPort(new OpfsRepackedPort(directory), { extentSize: 8192 }),
    ).rejects.toBeInstanceOf(StoreOwnedError);
    expect(directory.openHandleCount()).toBe(4);
    await first.closeFs();
    expect(directory.openHandleCount()).toBe(0);
  });

  test("ownership errors retain the underlying OPFS cause", async () => {
    const directory = new MemoryOpfsDirectory();
    const ownershipFailure = new DOMException("already held", "NoModificationAllowedError");
    directory.failNextAcquire("activation.bin", ownershipFailure);

    let openingError: unknown;
    try {
      await openOpfsRepackedFsForPort(new OpfsRepackedPort(directory), { extentSize: 8192 });
    } catch (cause) {
      openingError = cause;
    }

    expect(openingError).toBeInstanceOf(StoreOwnedError);
    expect((openingError as Error).cause).toBe(ownershipFailure);
    expect(directory.openHandleCount()).toBe(0);
  });

  test("every partial production-port acquisition failure releases the handles already acquired", async () => {
    for (const name of ["activation.bin", "arena.bin", "metadata-a.bin", "metadata-b.bin"] as const) {
      const directory = new MemoryOpfsDirectory();
      const failure = new Error(`forced ${name} acquisition failure`);
      directory.failNextAcquire(name, failure);

      await expect(openOpfsRepackedFsForPort(new OpfsRepackedPort(directory), { extentSize: 8192 })).rejects.toBe(
        failure,
      );
      expect(directory.openHandleCount()).toBe(0);
    }
  });

  test("failed-init cleanup attempts every close, preserves its first cause, and is idempotent", async () => {
    const directory = new MemoryOpfsDirectory();
    const fs = await openOpfsRepackedFsForPort(new OpfsRepackedPort(directory), { extentSize: 8192 });
    const first = new Error("forced metadata-b close failure");
    directory.failNextClose("metadata-b.bin", first);
    directory.failNextClose("metadata-a.bin", new Error("forced metadata-a close failure"));
    directory.failNextClose("arena.bin", new Error("forced arena close failure"));
    directory.failNextClose("activation.bin", new Error("forced activation close failure"));

    await expect(fs.cleanupFailedInit()).rejects.toBe(first);
    expect(directory.openHandleCount()).toBe(0);
    for (const name of ["activation.bin", "arena.bin", "metadata-a.bin", "metadata-b.bin"] as const) {
      expect(directory.closeAttemptCount(name)).toBe(1);
    }
    await expect(fs.cleanupFailedInit()).resolves.toBeUndefined();
  });

  test("relaxed close forces a strict barrier, attempts every close, and preserves the first flush cause", async () => {
    const directory = new MemoryOpfsDirectory();
    const fs = await openOpfsRepackedFsForPort(new OpfsRepackedPort(directory), {
      durability: "relaxed",
      extentSize: 8192,
    });
    fs.writeFile("/dirty", new Uint8Array(8192));
    const first = new Error("forced close arena flush failure");
    directory.failNextFlush("arena.bin", first);
    for (const name of ["metadata-b.bin", "metadata-a.bin", "arena.bin", "activation.bin"] as const) {
      directory.failNextClose(name, new Error(`forced ${name} close failure`));
    }

    await expect(fs.closeFs()).rejects.toBe(first);
    expect(directory.openHandleCount()).toBe(0);
    for (const name of ["activation.bin", "arena.bin", "metadata-a.bin", "metadata-b.bin"] as const) {
      expect(directory.closeAttemptCount(name)).toBe(1);
    }
  });

  test("the retained adapter releases every handle when extension setup rejects after BaseFilesystem.init", async () => {
    const directory = new MemoryOpfsDirectory();
    const failure = new Error("forced post-BaseFilesystem.init failure");

    await expect(
      createOpfsRepackedPGlite({
        directory,
        extentSize: 8192,
        pglite: {
          extensions: {
            failAfterFilesystemInit: {
              name: "fail-after-filesystem-init",
              setup: async () => {
                throw failure;
              },
            },
          },
        },
      }),
    ).rejects.toBe(failure);
    expect(directory.openHandleCount()).toBe(0);
  }, 30_000);

  test("the retained adapter releases every handle when WASM startup rejects", async () => {
    const directory = new MemoryOpfsDirectory();
    const failure = new Error("forced WASM instantiation failure");

    await expect(
      createOpfsRepackedPGlite({
        directory,
        extentSize: 8192,
        pglite: {
          extensions: {
            failWasmStartup: {
              name: "fail-wasm-startup",
              setup: async (_pg, emscriptenOpts) => ({
                emscriptenOpts: {
                  ...emscriptenOpts,
                  instantiateWasm: () => {
                    throw failure;
                  },
                },
              }),
            },
          },
        },
      }),
    ).rejects.toBe(failure);
    expect(directory.openHandleCount()).toBe(0);
  }, 30_000);

  test("the retained adapter releases every handle when initialSyncFs observes poison", async () => {
    const directory = new MemoryOpfsDirectory();

    await expect(
      createOpfsRepackedPGlite({
        directory,
        extentSize: 8192,
        pglite: {
          extensions: {
            poisonBeforeInitialSync: {
              name: "poison-before-initial-sync",
              setup: async (pg, emscriptenOpts) => ({
                emscriptenOpts: {
                  ...emscriptenOpts,
                  postRun: [
                    ...(emscriptenOpts.postRun ?? []),
                    () => {
                      const hostFs = (pg as unknown as { fs: { syncToFs(relaxed: boolean): Promise<void> } }).fs;
                      void hostFs.syncToFs(true).catch(() => undefined);
                    },
                  ],
                },
              }),
            },
          },
        },
      }),
    ).rejects.toBeInstanceOf(StoreFailedError);
    expect(directory.openHandleCount()).toBe(0);
  }, 30_000);

  test("the retained adapter releases every handle when initdb rejects", async () => {
    const directory = new MemoryOpfsDirectory();

    await expect(
      createOpfsRepackedPGlite({
        directory,
        extentSize: 8192,
        pglite: { initDbStartParams: ["--definitely-not-an-initdb-option"] },
      }),
    ).rejects.toThrow();
    expect(directory.openHandleCount()).toBe(0);
    // PGlite's Emscripten initdb runtime sets `process.exitCode = 1` for the deliberately invalid
    // option even though the rejection is caught and asserted. Clear only that runtime side effect;
    // a genuine Bun test failure still sets the runner's failure status after this test returns.
    process.exitCode = 0;
  }, 30_000);
});
