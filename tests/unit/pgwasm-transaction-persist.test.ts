// Began as a copy of `@electric-sql/pglite`'s tests (taken under its PostgreSQL License option,
// © ElectricSQL — see NOTICE). Owned outright (ADR-0062); compatibility with PGlite is an anti-goal.

import { afterEach, describe, expect, it } from "bun:test";

import { cBuild } from "../../packages/pgwasm-c/src";
import { closeTestPgwasms, createTestPgwasm } from "./support/pgwasm";
import { persistHookBuild } from "./support/pgwasm-build-decorators";
import { rejectionOf } from "./support/rejection";

afterEach(closeTestPgwasms);

/** A database whose statement persists are counted and can be made to fail. */
async function counted() {
  const state = { persists: 0, fail: false };
  const build = persistHookBuild(cBuild, async (relaxed, persist) => {
    state.persists++;
    if (state.fail) throw new Error("persist failed");
    await persist(relaxed);
  });
  const db = await createTestPgwasm({ build });
  return { db, state };
}

// A transaction's end is a statement boundary like any other: it persists before transaction()
// resolves, however the transaction ends. Without that, a committed transaction is not durable until
// some later, unrelated statement runs.
describe("persisting at the end of a transaction", () => {
  it("persists after COMMIT, before transaction() resolves", async () => {
    const { db, state } = await counted();
    await db.exec("CREATE TABLE t (v int)");
    let atCallbackEnd = -1;
    await db.transaction(async (tx) => {
      await tx.exec("INSERT INTO t VALUES (1)");
      atCallbackEnd = state.persists;
    });
    expect(state.persists).toBeGreaterThan(atCallbackEnd);
  });

  it("persists after an explicit rollback", async () => {
    const { db, state } = await counted();
    await db.exec("CREATE TABLE t (v int)");
    let atCallbackEnd = -1;
    await db.transaction(async (tx) => {
      await tx.exec("INSERT INTO t VALUES (1)");
      await tx.rollback();
      atCallbackEnd = state.persists;
    });
    expect(state.persists).toBeGreaterThan(atCallbackEnd);
  });

  it("persists after the ROLLBACK for a throwing callback", async () => {
    const { db, state } = await counted();
    await db.exec("CREATE TABLE t (v int)");
    let atCallbackEnd = -1;
    const error = await rejectionOf(
      db.transaction(async (tx) => {
        await tx.exec("INSERT INTO t VALUES (1)");
        atCallbackEnd = state.persists;
        throw new Error("force rollback");
      }),
    );
    expect(error.message).toBe("force rollback");
    expect(state.persists).toBeGreaterThan(atCallbackEnd);
  });

  it("persists after an explicit rollback followed by a throwing callback", async () => {
    const { db, state } = await counted();
    await db.exec("CREATE TABLE t (v int)");
    let atCallbackEnd = -1;
    const error = await rejectionOf(
      db.transaction(async (tx) => {
        await tx.exec("INSERT INTO t VALUES (1)");
        await tx.rollback();
        atCallbackEnd = state.persists;
        throw new Error("after explicit rollback");
      }),
    );
    expect(error.message).toBe("after explicit rollback");
    expect(state.persists).toBeGreaterThan(atCallbackEnd);
  });

  it("persists when the COMMIT itself fails", async () => {
    const { db, state } = await counted();
    await db.exec(`
      CREATE TABLE parent (id int PRIMARY KEY);
      CREATE TABLE child (pid int REFERENCES parent (id) DEFERRABLE INITIALLY DEFERRED);
    `);
    let atCallbackEnd = -1;
    const error = await rejectionOf(
      db.transaction(async (tx) => {
        // Violates the deferred constraint only at COMMIT, which then fails and rolls back.
        await tx.exec("INSERT INTO child VALUES (42)");
        atCallbackEnd = state.persists;
      }),
    );
    expect(error.message).toMatch(/violates foreign key constraint/);
    expect(state.persists).toBeGreaterThan(atCallbackEnd);
  });

  it("does not mask the callback's error when that persist fails", async () => {
    const { db, state } = await counted();
    await db.exec("CREATE TABLE t (v int)");
    const error = await rejectionOf(
      db.transaction(async (tx) => {
        await tx.rollback();
        state.fail = true;
        throw new Error("callback cause");
      }),
    );
    expect(error.message).toBe("callback cause");
    // The persist failure surfaces on the next statement instead.
    expect((await rejectionOf(db.query("SELECT 1"))).message).toBe("persist failed");
    state.fail = false;
  });
});
