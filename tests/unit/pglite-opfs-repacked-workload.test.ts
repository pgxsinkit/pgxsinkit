import { describe, expect, test } from "bun:test";

import { createOpfsRepackedPGlite } from "../../packages/pglite-opfs-repacked/src/pglite-factory";
import { MemoryOpfsDirectory } from "../../packages/pglite-opfs-repacked/test/support/memory-opfs";

describe("opfs-repacked real PGlite workload stress", () => {
  test(
    "repeated transactions and concurrently submitted reads reopen exactly with four handles",
    async () => {
      const directory = new MemoryOpfsDirectory();
      const pg = await createOpfsRepackedPGlite({ directory, durability: "strict", extentSize: 8192 });
      expect(directory.openHandleCount()).toBe(4);
      await pg.exec("CREATE TABLE stress_values (id integer PRIMARY KEY, value integer NOT NULL)");

      for (let batch = 0; batch < 20; batch += 1) {
        await pg.transaction(async (tx) => {
          for (let within = 0; within < 10; within += 1) {
            const id = batch * 10 + within;
            await tx.query("INSERT INTO stress_values (id, value) VALUES ($1, $2)", [id, id * 3]);
          }
        });
        expect(directory.openHandleCount()).toBe(4);
      }

      await pg.exec("UPDATE stress_values SET value = value + 7 WHERE id % 3 = 0");
      await pg.exec("DELETE FROM stress_values WHERE id % 5 = 0");
      const reads = await Promise.all(
        Array.from({ length: 24 }, (_, index) =>
          pg.query<{ value: number }>("SELECT value FROM stress_values WHERE id = $1", [index + 1]),
        ),
      );
      expect(reads.filter((result) => result.rows.length === 1).length).toBe(20);
      expect(directory.openHandleCount()).toBe(4);

      const before = await pg.query<{ count: string; total: string }>(
        "SELECT count(*)::text AS count, sum(value)::text AS total FROM stress_values",
      );
      expect(before.rows).toEqual([{ count: "160", total: "48371" }]);
      await pg.close();
      expect(directory.openHandleCount()).toBe(0);

      const reopened = await createOpfsRepackedPGlite({ directory, durability: "strict" });
      expect(directory.openHandleCount()).toBe(4);
      const after = await reopened.query<{ count: string; total: string }>(
        "SELECT count(*)::text AS count, sum(value)::text AS total FROM stress_values",
      );
      expect(after.rows).toEqual(before.rows);
      await reopened.close();
      expect(directory.openHandleCount()).toBe(0);
    },
    2 * 60_000,
  );
});
