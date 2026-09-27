import { afterEach, describe, expect, it } from "bun:test";

import { cBuild } from "../../packages/pgwasm-c/src";
import {
  pgDump,
  PgDumpError,
  PgDumpSessionError,
  PgDumpUnsupportedBuildError,
} from "../../packages/pgwasm-pg-dump/src";
import { PgwasmFailedError, UnsupportedFeatureError, type Pgwasm } from "../../packages/pgwasm/src";
import { live } from "../../packages/pgwasm/src/live";
import { serialize } from "../../packages/pgwasm/src/protocol";
import { closeTestPgwasms, createTestPgwasm } from "./support/pgwasm";
import { asyncExchangeBuild, wireHookBuild } from "./support/pgwasm-build-decorators";
import { Recorder } from "./support/pgwasm-live";
import { rejectionOf } from "./support/rejection";

// pg_dump runs on the database's own session, which it expects to have to itself and leaves in a state
// only a disconnect would clean up. These tests hold pgDump to the opposite: it takes the session
// exclusively, and gives it back exactly as it found it.

afterEach(closeTestPgwasms);

const nextMacrotask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function latch(): { readonly promise: Promise<void>; readonly open: () => void } {
  let open: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

async function setting(pg: Pgwasm, name: string): Promise<string> {
  return (await pg.query<{ value: string }>("SELECT current_setting($1) AS value", [name])).rows[0]?.value ?? "";
}

const encoder = new TextEncoder();
const containsText = (message: Uint8Array, text: string) => {
  const needle = encoder.encode(text);
  outer: for (let at = 0; at + needle.length <= message.length; at++) {
    for (let index = 0; index < needle.length; index++) {
      if (message[at + index] !== needle[index]) continue outer;
    }
    return true;
  }
  return false;
};

describe("pgDump refuses", () => {
  it("a build whose wire is asynchronous, before anything reaches the database", async () => {
    let exchanges = 0;
    const pg = await createTestPgwasm({
      build: asyncExchangeBuild(
        wireHookBuild(cBuild, () => {
          exchanges++;
        }),
      ),
    });
    const before = exchanges;
    const refusal = await rejectionOf(pgDump({ pg }));
    expect(refusal).toBeInstanceOf(PgDumpUnsupportedBuildError);
    expect(refusal).toBeInstanceOf(UnsupportedFeatureError);
    expect((refusal as PgDumpUnsupportedBuildError).build).toBe("c");
    expect(exchanges).toBe(before);
  });

  it("a session inside a transaction block, which it leaves alone", async () => {
    const pg = await createTestPgwasm();
    await pg.exec("CREATE TABLE pending (id int); BEGIN; INSERT INTO pending VALUES (1);");
    expect(await rejectionOf(pgDump({ pg }))).toBeInstanceOf(PgDumpSessionError);
    await pg.exec("COMMIT");
    expect((await pg.query("SELECT id FROM pending")).rows).toEqual([{ id: 1 }]);
  });
});

describe("pgDump holds the session", () => {
  it("until a transaction in progress commits, and dumps what it committed", async () => {
    const pg = await createTestPgwasm();
    await pg.exec("CREATE TABLE t (id int)");
    const entered = latch();
    const gate = latch();
    const transaction = pg.transaction(async (tx) => {
      await tx.exec("INSERT INTO t VALUES (1)");
      entered.open();
      await gate.promise;
      await tx.exec("INSERT INTO t VALUES (2)");
    });
    await entered.promise;
    let dumped = false;
    const dump = pgDump({ pg }).then((file) => {
      dumped = true;
      return file;
    });
    await nextMacrotask();
    await nextMacrotask();
    expect(dumped).toBe(false);
    gate.open();
    await transaction;
    const content = await (await dump).text();
    expect(content).toContain("INSERT INTO public.t VALUES (1);");
    expect(content).toContain("INSERT INTO public.t VALUES (2);");
  });

  it("and a transaction started during the dump runs after it", async () => {
    const pg = await createTestPgwasm();
    await pg.exec("CREATE TABLE t (id int)");
    const order: string[] = [];
    const dump = pgDump({ pg }).then(async (file) => {
      order.push("dump");
      return await file.text();
    });
    const transaction = pg.transaction(async (tx) => {
      order.push("transaction");
      await tx.exec("INSERT INTO t VALUES (1)");
    });
    await Promise.all([dump, transaction]);
    expect(order).toEqual(["dump", "transaction"]);
    expect(await dump).not.toContain("INSERT INTO public.t");
  });
});

describe("pgDump gives the session back as it found it", () => {
  it("ends pg_dump's transaction, so the database writes again", async () => {
    const pg = await createTestPgwasm();
    await pgDump({ pg });
    await pg.exec("CREATE TABLE after_dump (id int); INSERT INTO after_dump VALUES (1);");
    expect(await setting(pg, "transaction_read_only")).toBe("off");
    expect((await pg.query("SELECT id FROM after_dump")).rows).toEqual([{ id: 1 }]);
  });

  it("restores search_path, whatever its value", async () => {
    const pg = await createTestPgwasm();
    for (const value of [`"My Schema", public`, `"with,comma", "quo""te", pg_catalog`, `''`, `amigo`]) {
      await pg.exec(`SET search_path TO ${value}`);
      const before = await setting(pg, "search_path");
      await pgDump({ pg });
      expect(await setting(pg, "search_path")).toBe(before);
    }
  });

  it("restores every other setting pg_dump changes", async () => {
    const pg = await createTestPgwasm();
    await pg.exec(`
      CREATE TABLE secrets (owner text, note text);
      INSERT INTO secrets VALUES ('a', 'x');
      CREATE VIEW secret_notes AS SELECT note FROM secrets;
      SET statement_timeout = '1min';
      SET "myapp.tenant" = 'acme';
    `);
    const names = ["row_security", "restrict_nonsystem_relation_kind", "extra_float_digits", "statement_timeout"];
    const before = await Promise.all(names.map((name) => setting(pg, name)));
    await pgDump({ pg });
    expect(await Promise.all(names.map((name) => setting(pg, name)))).toEqual(before);
    expect(await setting(pg, "myapp.tenant")).toBe("acme");
    // pg_dump forbids reading through views while it dumps; the database's own queries still may.
    expect((await pg.query("SELECT note FROM secret_notes")).rows).toEqual([{ note: "x" }]);
  });

  it("deallocates its prepared statements, and keeps the database's own and a live changes feed", async () => {
    const pg = await createTestPgwasm({ extensions: { live } });
    await pg.exec(`
      CREATE TABLE items (id serial PRIMARY KEY, name text);
      INSERT INTO items (name) VALUES ('one');
      PREPARE mine AS SELECT count(*)::int AS n FROM items;
    `);
    const recorder = new Recorder<unknown>();
    const feed = await pg.live.changes("SELECT * FROM items ORDER BY id", [], "id", recorder.callback);
    const statements = async () =>
      (await pg.query<{ name: string }>("SELECT name FROM pg_prepared_statements ORDER BY name")).rows.map(
        (row) => row.name,
      );
    const before = await statements();
    expect(before).toContain("mine");

    await pgDump({ pg });

    expect(await statements()).toEqual(before);
    expect((await pg.query("EXECUTE mine")).rows).toEqual([{ n: 1 }]);
    const next = recorder.next();
    await pg.exec("INSERT INTO items (name) VALUES ('two')");
    expect(JSON.stringify(await next)).toContain('"name":"two"');
    await feed.unsubscribe();
  });
});

describe("pgDump fails", () => {
  it("with pg_dump's exit code and standard error, leaving the session as it found it", async () => {
    const pg = await createTestPgwasm();
    await pg.exec("SET search_path TO amigo, public");
    const exitCode = process.exitCode;

    const noTable = await rejectionOf(pgDump({ pg, args: ["--table=does_not_exist"] }));
    expect(noTable).toBeInstanceOf(PgDumpError);
    expect((noTable as PgDumpError).exitCode).toBe(1);
    expect((noTable as PgDumpError).stderr).toContain("no matching tables were found");
    // It failed inside its own transaction: that transaction is over, and nothing else changed.
    await pg.exec("CREATE TABLE after_failure (id int)");
    expect(await setting(pg, "search_path")).toBe("amigo, public");

    const badOption = await rejectionOf(pgDump({ pg, args: ["--no-such-option"] }));
    expect(badOption).toBeInstanceOf(PgDumpError);
    expect((badOption as PgDumpError).exitCode).toBe(1);
    expect((badOption as PgDumpError).stderr).toMatch(/unrecognized option|invalid option/);

    expect(process.exitCode).toBe(exitCode);
  });

  it("to deallocate its statements, and still restores every setting, naming the statements it left", async () => {
    let deallocations = 0;
    const pg = await createTestPgwasm({
      build: wireHookBuild(cBuild, (message) => {
        if (!containsText(message, 'DEALLOCATE "')) return undefined;
        deallocations++;
        return serialize.query("SELECT 1/0");
      }),
    });
    await pg.exec(`
      CREATE FUNCTION answer() RETURNS int LANGUAGE sql AS 'SELECT 42';
      CREATE TABLE t (id int);
      SET search_path TO amigo, public;
    `);

    const failure = await rejectionOf(pgDump({ pg }));
    expect(deallocations).toBeGreaterThan(0);
    expect(failure).toBeInstanceOf(PgDumpSessionError);
    expect(failure.message).toContain("statements it prepared: ");
    expect((failure as PgDumpSessionError).unrestored).toEqual([]);
    expect(await setting(pg, "search_path")).toBe("amigo, public");
    await pg.exec("CREATE TABLE after_failure (id int)");
  });

  it("with pg_dump's own failure as the cause when the session could not be restored either", async () => {
    const rollback = serialize.query("ROLLBACK");
    let rollbacks = 0;
    const pg = await createTestPgwasm({
      build: wireHookBuild(cBuild, (message) => {
        if (message.length !== rollback.length || !message.every((byte, index) => byte === rollback[index])) {
          return undefined;
        }
        rollbacks++;
        return serialize.query("SELECT 1/0");
      }),
    });

    const failure = await rejectionOf(pgDump({ pg, args: ["--table=does_not_exist"] }));
    expect(rollbacks).toBe(1);
    expect(failure).toBeInstanceOf(PgDumpSessionError);
    expect(failure.message).toContain("pg_dump's transaction is still open");
    expect(failure.message).toContain("no matching tables were found");
    expect(failure.cause).toBeInstanceOf(PgDumpError);
    expect((failure.cause as PgDumpError).exitCode).toBe(1);
  });

  it("with the database's failure when the wire fails under it, never an unhandled rejection", async () => {
    let failing = false;
    const pg = await createTestPgwasm({
      build: wireHookBuild(cBuild, (message) => {
        if (failing && containsText(message, "SET DATESTYLE")) throw new Error("the wire broke");
      }),
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      failing = true;
      const failure = await rejectionOf(pgDump({ pg }));
      expect(failure).toBeInstanceOf(PgwasmFailedError);
      expect(failure.message).toContain("the wire broke");
      await nextMacrotask();
      await nextMacrotask();
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
