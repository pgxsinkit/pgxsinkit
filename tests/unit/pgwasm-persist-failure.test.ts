// Began as a copy of `@electric-sql/pglite`'s tests (taken under its PostgreSQL License option,
// © ElectricSQL — see NOTICE). Owned outright (ADR-0062); compatibility with PGlite is an anti-goal.

import { afterEach, describe, expect, it } from "bun:test";

import { cBuild } from "../../packages/pgwasm-c/src";
import { closeTestPgwasms, createTestPgwasm } from "./support/pgwasm";
import { persistHookBuild } from "./support/pgwasm-build-decorators";
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
});
