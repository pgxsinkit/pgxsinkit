import { afterEach, describe, expect, it } from "bun:test";

import { cBuild } from "../../packages/pgwasm-c/src";
import { UnsupportedFeatureError, type Results } from "../../packages/pgwasm/src";
import { live } from "../../packages/pgwasm/src/live";
import { protocol, serialize } from "../../packages/pgwasm/src/protocol";
import { closeTestPgwasms, createTestPgwasm } from "./support/pgwasm";
import { asyncExchangeBuild, noBlobDeviceBuild, outOfBandNotifyBuild } from "./support/pgwasm-build-decorators";
import { Recorder } from "./support/pgwasm-live";
import { rejectionOf } from "./support/rejection";

// The seam carries builds shaped unlike the C build: a wire whose replies arrive later and in pieces,
// and notifications that arrive between exchanges (a multi-session build's). pgwasm's shared code has
// no branch for either; these run it over the C build wrapped into each shape.

afterEach(closeTestPgwasms);

for (const [label, build] of [
  ["an asynchronous wire", asyncExchangeBuild(cBuild)],
  ["notifications between exchanges", outOfBandNotifyBuild(cBuild)],
] as const) {
  describe(`pgwasm over ${label}`, () => {
    it("reports the build's capabilities", async () => {
      const db = await createTestPgwasm({ build });
      expect(protocol(db).capabilities.synchronousExchange).toBe(false);
    });

    it("queries, executes and reports SQL errors", async () => {
      const db = await createTestPgwasm({ build });
      await db.exec("CREATE TABLE t (id serial primary key, name text); INSERT INTO t (name) VALUES ('a'), ('b');");
      expect((await db.query("SELECT name FROM t WHERE id > $1 ORDER BY id", [0])).rows).toEqual([
        { name: "a" },
        { name: "b" },
      ]);
      expect((await rejectionOf(db.query("SELECT * FROM missing"))).message).toBe('relation "missing" does not exist');
      expect((await db.query<{ one: number }>("SELECT 1 AS one")).rows).toEqual([{ one: 1 }]);
    });

    it("runs transactions", async () => {
      const db = await createTestPgwasm({ build });
      await db.exec("CREATE TABLE t (id int)");
      await db.transaction(async (tx) => {
        await tx.query("INSERT INTO t VALUES (1)");
        await tx.rollback();
      });
      await db.transaction(async (tx) => {
        await tx.query("INSERT INTO t VALUES (2)");
      });
      expect((await db.query("SELECT id FROM t")).rows).toEqual([{ id: 2 }]);
    });

    it("streams the wire", async () => {
      const db = await createTestPgwasm({ build });
      const chunks: Uint8Array[] = [];
      await protocol(db).execProtocolRawStream(serialize.query("SELECT 1"), {
        onRawData: (chunk) => chunks.push(chunk.slice()),
      });
      expect(chunks.length).toBeGreaterThan(0);
    });

    it("delivers notifications to listeners and to live queries", async () => {
      const db = await createTestPgwasm({ build, extensions: { live } });
      const payloads: string[] = [];
      await db.listen("seam", (payload) => payloads.push(payload));
      await db.exec("NOTIFY seam, 'hello'");
      const deadline = Date.now() + 2000;
      while (payloads.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
      expect(payloads).toEqual(["hello"]);

      await db.exec("CREATE TABLE items (id serial primary key, n int); INSERT INTO items (n) VALUES (1);");
      const recorder = new Recorder<Results<{ id: number; n: number }>>();
      const { initialResults, unsubscribe } = await db.live.incrementalQuery<{ id: number; n: number }>(
        "SELECT * FROM items ORDER BY n",
        [],
        "id",
        recorder.callback,
      );
      expect(initialResults.rows).toEqual([{ id: 1, n: 1 }]);
      const next = recorder.next();
      await db.exec("INSERT INTO items (n) VALUES (2);");
      expect((await next).rows).toEqual([
        { id: 1, n: 1 },
        { id: 2, n: 2 },
      ]);
      await unsubscribe();
    });

    it("dumps and restores", async () => {
      const db = await createTestPgwasm({ build });
      await db.exec("CREATE TABLE t (id int); INSERT INTO t VALUES (7);");
      const restored = await createTestPgwasm({ build, loadDataDir: await db.dumpDataDir() });
      expect((await restored.query("SELECT id FROM t")).rows).toEqual([{ id: 7 }]);
    });
  });
}

describe("pgwasm over a build without /dev/blob", () => {
  it("refuses the blob query option with UnsupportedFeatureError, and keeps working", async () => {
    const db = await createTestPgwasm({ build: noBlobDeviceBuild(cBuild) });
    expect(protocol(db).capabilities.blobDevice).toBe(false);
    await db.exec("CREATE TABLE t (v int)");
    const blob = new Blob(["1\n2\n"]);
    const viaQuery = await rejectionOf(db.query("COPY t FROM '/dev/blob'", [], { blob }));
    expect(viaQuery).toBeInstanceOf(UnsupportedFeatureError);
    expect(viaQuery.message).toContain('The "c" Postgres build has no /dev/blob device');
    expect(await rejectionOf(db.exec("COPY t FROM '/dev/blob'", { blob }))).toBeInstanceOf(UnsupportedFeatureError);
    expect((await db.query<{ n: number }>("SELECT count(*)::int AS n FROM t")).rows).toEqual([{ n: 0 }]);
  });
});
