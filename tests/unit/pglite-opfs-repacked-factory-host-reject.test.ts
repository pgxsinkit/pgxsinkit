/* oxlint-disable typescript/await-thenable -- bun-types gap: .resolves/.rejects matchers return real promises typed as void */
import { describe, expect, test } from "bun:test";

import { createOpfsRepackedPGlite } from "../../packages/pglite-opfs-repacked/src/pglite-factory";
import { MemoryOpfsDirectory } from "../../packages/pglite-opfs-repacked/test/support/memory-opfs";

describe("opfs-repacked PGlite post-startup rejection cleanup", () => {
  test("the retained adapter releases every handle when host startup rejects after engine initialization", async () => {
    const directory = new MemoryOpfsDirectory();
    const failure = new Error("forced post-engine initialization failure");

    await expect(
      createOpfsRepackedPGlite({
        directory,
        extentSize: 8192,
        pglite: {
          extensions: {
            failAfterStartup: {
              name: "fail-after-startup",
              setup: () => Promise.resolve({ init: () => Promise.reject(failure) }),
            },
          },
        },
      }),
    ).rejects.toBe(failure);
    expect(directory.openHandleCount()).toBe(0);
  }, 30_000);
});
