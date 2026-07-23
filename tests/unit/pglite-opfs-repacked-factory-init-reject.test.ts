/* oxlint-disable typescript/await-thenable -- bun-types gap: .resolves/.rejects matchers return real promises typed as void */
import { describe, expect, test } from "bun:test";

import { createOpfsRepackedPGlite } from "../../packages/pglite-opfs-repacked/src/pglite-factory";
import { MemoryOpfsDirectory } from "../../packages/pglite-opfs-repacked/test/support/memory-opfs";

describe("opfs-repacked PGlite init rejection cleanup", () => {
  test("the retained adapter releases every handle when PGlite initialization rejects", async () => {
    const directory = new MemoryOpfsDirectory();

    await expect(
      createOpfsRepackedPGlite({
        directory,
        extentSize: 8192,
        pglite: { username: "role_that_does_not_exist" },
      }),
    ).rejects.toThrow();
    expect(directory.openHandleCount()).toBe(0);
    // 90s, not the runner's default 30s: a full real-WASM initdb-and-reject runs ~18s alone and has been
    // measured past 31s under whole-suite CPU contention — the deadline covers contention, not the code.
  }, 90_000);
});
