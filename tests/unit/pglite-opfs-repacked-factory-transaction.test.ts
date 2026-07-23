/* oxlint-disable typescript/await-thenable -- bun-types gap: .resolves/.rejects matchers return real promises typed as void */
import { describe, expect, test } from "bun:test";

import { createOpfsRepackedPGlite } from "../../packages/pglite-opfs-repacked/src/pglite-factory";
import { MemoryOpfsDirectory } from "../../packages/pglite-opfs-repacked/test/support/memory-opfs";

interface ObservedFs {
  fs: { syncToFs(relaxedDurability?: boolean): Promise<void> };
}

async function createObservedPglite(directory: MemoryOpfsDirectory, counter: { calls: number }) {
  return createOpfsRepackedPGlite({
    directory,
    durability: "strict",
    extentSize: 8192,
    pglite: {
      extensions: {
        observeAwaitedSync: {
          name: "observe-awaited-sync",
          setup: async (host) => {
            const fs = (host as unknown as ObservedFs).fs;
            const syncToFs = fs.syncToFs.bind(fs);
            fs.syncToFs = async (relaxedDurability) => {
              counter.calls += 1;
              await syncToFs(relaxedDurability);
            };
            return {};
          },
        },
      },
    },
  });
}

// Host-conformance suite: transaction-end synchronization is a HOST
// obligation (the host must not run its terminal COMMIT/ROLLBACK under the
// in-transaction sync suppression). The installed pinned `@electric-sql/pglite`
// must carry the transaction-end sync fix (fork branch fix/transaction-end-sync,
// released in @pgxsinkit/pglite 0.5.4-pgx.7; open upstream PR). The
// explicit-rollback-then-throw and failing-COMMIT cases additionally need the
// closed-transaction sync fix (released in 0.5.4-pgx.9). The package
// deliberately ships NO local workaround — if this suite fails, fix the pin,
// never the factory.
describe("opfs-repacked PGlite factory transaction boundaries", () => {
  test("a resolved transaction has performed an awaited sync at or after its COMMIT", async () => {
    const directory = new MemoryOpfsDirectory();
    const counter = { calls: 0 };
    const pg = await createObservedPglite(directory, counter);
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
    const pg = await createObservedPglite(directory, counter);
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
    const pg = await createObservedPglite(directory, counter);
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
    const pg = await createObservedPglite(directory, counter);
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
    const pg = await createObservedPglite(directory, counter);
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
