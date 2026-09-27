/* oxlint-disable typescript/await-thenable -- bun-types gap: .resolves/.rejects matchers return real promises typed as void */
import { describe, expect, test } from "bun:test";

import { cBuild } from "../../packages/pgwasm-c/src";
import { prepopulatedDataDir } from "../../packages/pgwasm-c/src/prepopulated";
import { createOpfsPgwasm } from "../../packages/pgwasm/src/opfs/create";
import { MemoryOpfsDirectory } from "./support/pgwasm-opfs/memory-opfs";

describe("opfs-repacked pgwasm post-startup rejection cleanup", () => {
  test("the retained adapter releases every handle when host startup rejects after engine initialization", async () => {
    const directory = new MemoryOpfsDirectory();
    const failure = new Error("forced post-engine initialization failure");

    await expect(
      createOpfsPgwasm({
        build: cBuild,
        directory,
        extentSize: 8192,
        pgwasm: {
          loadDataDir: await prepopulatedDataDir(),
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
