// Began as a copy of `@electric-sql/pglite`'s tests (taken under its PostgreSQL License option,
// © ElectricSQL — see NOTICE). Owned outright (ADR-0062); compatibility with PGlite is an anti-goal.

import { afterEach, describe, expect, it } from "bun:test";

import { cBuild } from "../../packages/pgwasm-c/src";
import type { Pgwasm } from "../../packages/pgwasm/src";
import { closeTestPgwasms, createTestPgwasm } from "./support/pgwasm";
import { persistHookBuild, releaseHookBuild } from "./support/pgwasm-build-decorators";
import { rejectionOf } from "./support/rejection";

afterEach(closeTestPgwasms);

describe("a failed statement persist", () => {
  it("latches a background (relaxed) failure for the next statement", async () => {
    const failure = new Error("forced background persist failure");
    let failNext = false;
    let observed: () => void = () => undefined;
    const failed = new Promise<void>((resolve) => {
      observed = resolve;
    });
    const build = persistHookBuild(cBuild, async (relaxed, persist) => {
      if (relaxed && failNext) {
        failNext = false;
        observed();
        throw failure;
      }
      await persist(relaxed);
    });
    const db = await createTestPgwasm({ build, relaxedDurability: true });
    failNext = true;
    await db.exec("SELECT 1");
    await failed;
    expect(await rejectionOf(db.exec("SELECT 2"))).toBe(failure);
  });

  it("does not latch an awaited failure: the caller gets it once and the storage stays reachable", async () => {
    // A storage with its own failure policy (the OPFS store poisons itself) decides what later calls see;
    // replaying the first failure would shadow that policy.
    const failure = new Error("forced awaited persist failure");
    let failNext = false;
    let persists = 0;
    const build = persistHookBuild(cBuild, async (relaxed, persist) => {
      persists++;
      if (failNext) {
        failNext = false;
        throw failure;
      }
      await persist(relaxed);
    });
    const db = await createTestPgwasm({ build });
    await db.exec("CREATE TABLE t (v int)");
    failNext = true;
    expect(await rejectionOf(db.exec("INSERT INTO t VALUES (1)"))).toBe(failure);
    const afterFailure = persists;
    await db.exec("SELECT 1");
    expect(persists).toBeGreaterThan(afterFailure);
  });

  it("recovers a background failure with the final persist on close", async () => {
    let failNext = false;
    const build = persistHookBuild(cBuild, async (relaxed, persist) => {
      if (relaxed && failNext) {
        failNext = false;
        throw new Error("background failure");
      }
      await persist(relaxed);
    });
    const db = await createTestPgwasm({ build, relaxedDurability: true });
    failNext = true;
    await db.exec("SELECT 1");
    await db.close();
    expect(db.closed).toBe(true);
  });

  it("lets a background persist settle before a failed boot releases the storage", async () => {
    const events: string[] = [];
    let holdNext = false;
    const inner = releaseHookBuild(cBuild, (afterFailedBoot) => events.push(`release:${afterFailedBoot}`));
    const build = persistHookBuild(inner, async (relaxed, persist) => {
      if (relaxed && holdNext) {
        holdNext = false;
        events.push("persist:start");
        await new Promise((resolve) => setTimeout(resolve, 50));
        await persist(relaxed);
        events.push("persist:end");
        return;
      }
      await persist(relaxed);
    });
    const failure = new Error("forced late init failure");
    const error = await rejectionOf(
      createTestPgwasm({
        build,
        relaxedDurability: true,
        extensions: {
          late: {
            name: "late",
            setup: async (pg: Pgwasm) => ({
              init: async () => {
                holdNext = true;
                await pg.exec("CREATE TABLE late_init (v int)");
                throw failure;
              },
            }),
          },
        },
      }),
    );
    expect(error).toBe(failure);
    expect(events).toEqual(["persist:start", "persist:end", "release:true"]);
  });
});
