/* oxlint-disable typescript/await-thenable -- bun-types gap: .resolves/.rejects matchers return real promises typed as void */
import { describe, expect, test } from "bun:test";

import { cBuild } from "../../packages/pgwasm-c/src";
import { createOpfsPgwasm } from "../../packages/pgwasm/src/opfs/create";
import { MemoryOpfsDirectory } from "./support/pgwasm-opfs/memory-opfs";

describe("opfs-repacked pgwasm init rejection cleanup", () => {
  test("the retained adapter releases every handle when pgwasm initialization rejects", async () => {
    const directory = new MemoryOpfsDirectory();

    await expect(
      createOpfsPgwasm({
        build: cBuild,
        directory,
        extentSize: 8192,
        pgwasm: { username: "role_that_does_not_exist" },
      }),
    ).rejects.toThrow();
    expect(directory.openHandleCount()).toBe(0);
    // 90s, not the runner's default 30s: a full real-WASM initdb-and-reject runs ~18s alone and has been
    // measured past 31s under whole-suite CPU contention — the deadline covers contention, not the code.
  }, 90_000);
});
