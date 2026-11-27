import { afterEach, describe, expect, it } from "bun:test";

import { DatabaseError, TransactionAbortedError, type Transaction } from "../../packages/pgwasm/src";
import { closeTestPgwasms, createTestPgwasm } from "./support/pgwasm";
import { rejectionOf } from "./support/rejection";

afterEach(closeTestPgwasms);

describe("transaction outcomes", () => {
  it("rejects when a caught statement error leaves COMMIT rolling the transaction back", async () => {
    const db = await createTestPgwasm();
    await db.exec("CREATE TABLE outcomes (id integer PRIMARY KEY)");
    let failed: Transaction | undefined;
    const error = await rejectionOf(
      db.transaction(async (tx) => {
        failed = tx;
        await tx.query("INSERT INTO outcomes VALUES (1)");
        expect(await rejectionOf(tx.query("INSERT INTO outcomes VALUES (1)"))).toMatchObject({ code: "23505" });
        return "success";
      }),
    );
    expect(error).toBeInstanceOf(TransactionAbortedError);
    expect(error).toBeInstanceOf(DatabaseError);
    expect(error).toMatchObject({ severity: "ERROR", code: "25P02", query: "COMMIT" });
    expect(failed?.closed).toBe(true);
    expect((await rejectionOf(failed!.query("SELECT 1"))).message).toBe("Transaction is closed");
    expect((await db.query("SELECT id FROM outcomes")).rows).toEqual([]);

    expect(
      await db.transaction(async (tx) => {
        await tx.query("INSERT INTO outcomes VALUES (2)");
        return "committed";
      }),
    ).toBe("committed");
    expect((await db.query("SELECT id FROM outcomes")).rows).toEqual([{ id: 2 }]);
  });

  it("commits after recovering from a statement error with a savepoint", async () => {
    const db = await createTestPgwasm();
    await db.exec("CREATE TABLE outcomes (id integer PRIMARY KEY)");
    const result = await db.transaction(async (tx) => {
      await tx.query("INSERT INTO outcomes VALUES (1)");
      await tx.exec("SAVEPOINT recover");
      expect(await rejectionOf(tx.query("INSERT INTO outcomes VALUES (1)"))).toMatchObject({ code: "23505" });
      await tx.exec("ROLLBACK TO SAVEPOINT recover");
      await tx.query("INSERT INTO outcomes VALUES (2)");
      return "committed";
    });
    expect(result).toBe("committed");
    expect((await db.query("SELECT id FROM outcomes ORDER BY id")).rows).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it("preserves the original deferred-constraint error raised at COMMIT", async () => {
    const db = await createTestPgwasm();
    await db.exec(`
      CREATE TABLE parent (id integer PRIMARY KEY);
      CREATE TABLE child (parent_id integer REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED);
    `);
    const error = await rejectionOf(
      db.transaction(async (tx) => {
        await tx.query("INSERT INTO child VALUES (1)");
      }),
    );
    expect(error).toBeInstanceOf(DatabaseError);
    expect(error).not.toBeInstanceOf(TransactionAbortedError);
    expect(error).toMatchObject({ code: "23503", query: "COMMIT" });
    expect((await db.query("SELECT parent_id FROM child")).rows).toEqual([]);

    await db.transaction(async (tx) => {
      await tx.query("INSERT INTO parent VALUES (1)");
      await tx.query("INSERT INTO child VALUES (1)");
    });
    expect((await db.query("SELECT parent_id FROM child")).rows).toEqual([{ parent_id: 1 }]);
  });

  it("returns the callback value after an explicit rollback", async () => {
    const db = await createTestPgwasm();
    await db.exec("CREATE TABLE outcomes (id integer PRIMARY KEY)");
    expect(
      await db.transaction(async (tx) => {
        await tx.query("INSERT INTO outcomes VALUES (1)");
        await tx.rollback();
        return "rolled back intentionally";
      }),
    ).toBe("rolled back intentionally");
    expect((await db.query("SELECT id FROM outcomes")).rows).toEqual([]);
  });
});
