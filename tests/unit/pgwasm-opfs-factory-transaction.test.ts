/* oxlint-disable typescript/await-thenable -- bun-types gap: .resolves/.rejects matchers return real promises typed as void */
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";

import { cBuild } from "../../packages/pgwasm-c/src";
import { prepopulatedDataDir } from "../../packages/pgwasm-c/src/prepopulated";
import { createOpfsPgwasm } from "../../packages/pgwasm/src/opfs/create";
import { OpfsRepackedFS } from "../../packages/pgwasm/src/opfs/opfs-repacked-fs";
import { MemoryOpfsDirectory } from "./support/pgwasm-opfs/memory-opfs";

async function createObservedPgwasm(directory: MemoryOpfsDirectory, counter: { readonly calls: number }) {
  // Every awaited sync pgwasm asks of the store, counted as it reaches the adapter (the spy calls
  // through): `counter.calls` reads the spy's call count.
  const syncToFs = spyOn(OpfsRepackedFS.prototype, "syncToFs");
  Object.defineProperty(counter, "calls", { get: () => syncToFs.mock.calls.length });
  return createOpfsPgwasm({
    build: cBuild,
    directory,
    durability: "strict",
    extentSize: 8192,
    pgwasm: { loadDataDir: await prepopulatedDataDir() },
  });
}

// Host-conformance suite: transaction-end synchronization is a HOST obligation (the host must not run
// its terminal COMMIT/ROLLBACK under the in-transaction sync suppression). pgwasm owns that obligation
// (see pgwasm-transaction-persist); the explicit-rollback-then-throw and failing-COMMIT cases cover the
// closed-transaction sync too. The store deliberately ships NO local workaround — if this suite fails,
// fix pgwasm, never the factory.
afterEach(() => {
  mock.restore();
});

describe("opfs-repacked pgwasm factory transaction boundaries", () => {
  test("a resolved transaction has performed an awaited sync at or after its COMMIT", async () => {
    const directory = new MemoryOpfsDirectory();
    const counter = { calls: 0 };
    const pg = await createObservedPgwasm(directory, counter);
    await pg.exec("CREATE TABLE tx_sync (value integer)");

    let syncCallsAtCallbackEnd = -1;
    await pg.transaction(async (tx) => {
      await tx.exec("INSERT INTO tx_sync VALUES (1)");
      syncCallsAtCallbackEnd = counter.calls;
    });
    // The host suppresses per-statement syncs inside a transaction; the
    // strict contract requires the resolved transaction to have reached an
    // awaited sync boundary covering its COMMIT.
    expect(counter.calls).toBeGreaterThan(syncCallsAtCallbackEnd);

    const metadataFlushes = directory.flushCount("metadata-a.bin") + directory.flushCount("metadata-b.bin");
    expect(metadataFlushes).toBeGreaterThan(0);
    await pg.close();
  });

  test("a throwing transaction still ends at an awaited sync boundary without masking its cause", async () => {
    const directory = new MemoryOpfsDirectory();
    const counter = { calls: 0 };
    const pg = await createObservedPgwasm(directory, counter);
    await pg.exec("CREATE TABLE tx_sync (value integer)");

    let syncCallsAtCallbackEnd = -1;
    await expect(
      pg.transaction(async (tx) => {
        await tx.exec("INSERT INTO tx_sync VALUES (1)");
        syncCallsAtCallbackEnd = counter.calls;
        throw new Error("force rollback");
      }),
    ).rejects.toThrow("force rollback");
    expect(counter.calls).toBeGreaterThan(syncCallsAtCallbackEnd);
    await pg.close();
  });

  test("an explicit tx.rollback() followed by a normal return ends at an awaited sync boundary", async () => {
    const directory = new MemoryOpfsDirectory();
    const counter = { calls: 0 };
    const pg = await createObservedPgwasm(directory, counter);
    await pg.exec("CREATE TABLE tx_sync (value integer)");

    let syncCallsAtRollback = -1;
    await pg.transaction(async (tx) => {
      await tx.exec("INSERT INTO tx_sync VALUES (1)");
      await tx.rollback();
      syncCallsAtRollback = counter.calls;
    });
    expect(counter.calls).toBeGreaterThan(syncCallsAtRollback);
    await pg.close();
  });

  test("an explicit tx.rollback() followed by a throw still ends at an awaited sync boundary", async () => {
    const directory = new MemoryOpfsDirectory();
    const counter = { calls: 0 };
    const pg = await createObservedPgwasm(directory, counter);
    await pg.exec("CREATE TABLE tx_sync (value integer)");

    let syncCallsAtRollback = -1;
    await expect(
      pg.transaction(async (tx) => {
        await tx.exec("INSERT INTO tx_sync VALUES (1)");
        await tx.rollback();
        syncCallsAtRollback = counter.calls;
        throw new Error("after explicit rollback");
      }),
    ).rejects.toThrow("after explicit rollback");
    expect(counter.calls).toBeGreaterThan(syncCallsAtRollback);
    await pg.close();
  });

  test("a failing terminal COMMIT still ends at an awaited sync boundary", async () => {
    const directory = new MemoryOpfsDirectory();
    const counter = { calls: 0 };
    const pg = await createObservedPgwasm(directory, counter);
    await pg.exec(`
      CREATE TABLE tx_parent (id integer PRIMARY KEY);
      CREATE TABLE tx_child (
        pid integer REFERENCES tx_parent (id) DEFERRABLE INITIALLY DEFERRED
      );
    `);

    let syncCallsAtCallbackEnd = -1;
    await expect(
      pg.transaction(async (tx) => {
        await tx.exec("INSERT INTO tx_child VALUES (42)");
        syncCallsAtCallbackEnd = counter.calls;
      }),
    ).rejects.toThrow(/violates foreign key constraint/);
    expect(counter.calls).toBeGreaterThan(syncCallsAtCallbackEnd);
    await pg.close();
  });
});
