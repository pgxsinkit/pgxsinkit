import { afterEach, describe, expect, it } from "bun:test";

import { eq, sql } from "drizzle-orm";
import { Cache } from "drizzle-orm/cache/core/cache";
import type { MutationOption } from "drizzle-orm/cache/core/cache";
import {
  bigint,
  boolean,
  bytea,
  date,
  integer,
  interval,
  jsonb,
  numeric,
  pgTable,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import type { PgDialect } from "drizzle-orm/pg-core/dialect";

import { drizzle } from "../../packages/pgwasm/src/drizzle";
import { jitMappersUsable } from "../../packages/pgwasm/src/drizzle/driver";
import { closeTestPgwasms, createTestPgwasm } from "./support/pgwasm";
import { rejectionOf } from "./support/rejection";

afterEach(closeTestPgwasms);

const users = pgTable("users", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  active: boolean("active").notNull().default(true),
});

const values = pgTable("typed_values", {
  id: serial("id").primaryKey(),
  big: bigint("big", { mode: "bigint" }),
  bytes: bytea("bytes"),
  day: date("day"),
  at: timestamp("at"),
  atTz: timestamp("at_tz", { withTimezone: true }),
  span: interval("span"),
  doc: jsonb("doc"),
  amounts: numeric("amounts").array(),
  counts: integer("counts").array(),
});

async function database() {
  const client = await createTestPgwasm();
  await client.exec(`
    CREATE TABLE users (id serial PRIMARY KEY, name text NOT NULL, active boolean NOT NULL DEFAULT true);
    CREATE TABLE typed_values (
      id serial PRIMARY KEY, big bigint, bytes bytea, day date, at timestamp, at_tz timestamptz, span interval,
      doc jsonb, amounts numeric[], counts integer[]
    );
  `);
  return { client, db: drizzle(client) };
}

describe("the pgwasm Drizzle driver", () => {
  it("inserts, selects, updates and deletes", async () => {
    const { db } = await database();
    const inserted = await db
      .insert(users)
      .values([{ name: "ada" }, { name: "grace" }])
      .returning();
    expect(inserted.map((row) => row.name)).toEqual(["ada", "grace"]);
    await db.update(users).set({ active: false }).where(eq(users.name, "grace"));
    expect(await db.select().from(users).orderBy(users.id)).toEqual([
      { id: 1, name: "ada", active: true },
      { id: 2, name: "grace", active: false },
    ]);
    await db.delete(users).where(eq(users.id, 1));
    expect(await db.select({ name: users.name }).from(users)).toEqual([{ name: "grace" }]);
    expect(await db.execute(sql`select count(*)::int as n from ${users}`)).toMatchObject({ rows: [{ n: 1 }] });
  });

  it("commits a transaction and rolls one back on a throw", async () => {
    const { db } = await database();
    await db.transaction(async (tx) => {
      await tx.insert(users).values({ name: "kept" });
    });
    const error = await rejectionOf(
      db.transaction(async (tx) => {
        await tx.insert(users).values({ name: "discarded" });
        throw new Error("abort");
      }),
    );
    expect(error.message).toBe("abort");
    expect(await db.select({ name: users.name }).from(users)).toEqual([{ name: "kept" }]);
  });

  it("nests transactions as savepoints", async () => {
    const { db } = await database();
    await db.transaction(async (tx) => {
      await tx.insert(users).values({ name: "outer" });
      await rejectionOf(
        tx.transaction(async (inner) => {
          await inner.insert(users).values({ name: "inner" });
          throw new Error("undo inner");
        }),
      );
      await tx.transaction(async (inner) => {
        await inner.insert(users).values({ name: "inner kept" });
      });
    });
    expect((await db.select({ name: users.name }).from(users).orderBy(users.id)).map((row) => row.name)).toEqual([
      "outer",
      "inner kept",
    ]);
  });

  it("round-trips values through its codecs", async () => {
    const { db } = await database();
    const at = new Date("2024-03-01T10:20:30.000Z");
    await db.insert(values).values({
      big: 9223372036854775807n,
      bytes: Buffer.from([1, 2, 3]),
      day: "2024-03-01",
      at,
      atTz: at,
      span: "1 day 02:00:00",
      doc: { nested: [1, "two"] },
      amounts: ["1.50", "2.25"],
      counts: [1, 2, 3],
    });
    const [row] = await db.select().from(values);
    expect(row?.big).toBe(9223372036854775807n);
    expect([...(row?.bytes ?? [])]).toEqual([1, 2, 3]);
    expect(row?.day).toBe("2024-03-01");
    expect(row?.at?.toISOString()).toBe(at.toISOString());
    expect(row?.atTz?.toISOString()).toBe(at.toISOString());
    expect(row?.span).toBe("1 day 02:00:00");
    expect(row?.doc).toEqual({ nested: [1, "two"] });
    expect(row?.amounts).toEqual(["1.50", "2.25"]);
    expect(row?.counts).toEqual([1, 2, 3]);
  });

  it("builds SQL without a database through drizzle.mock", () => {
    const db = drizzle.mock();
    expect(db.select().from(users).where(eq(users.id, 7)).toSQL()).toEqual({
      sql: 'select "id", "name", "active" from "users" where "users"."id" = $1',
      params: [7],
    });
    expect(db.$client).toBe("$client is not available on drizzle.mock()");
  });

  it("exposes the pgwasm database as $client", async () => {
    const { client, db } = await database();
    expect(db.$client).toBe(client);
  });

  it("invalidates through the configured cache: $cache.invalidate and every mutation", async () => {
    const mutations: MutationOption[] = [];
    // A real cache (drizzle skips a NoopCache and its subclasses) that records invalidations.
    class RecordingCache extends Cache {
      strategy(): "all" {
        return "all";
      }
      async get(): Promise<undefined> {
        return undefined;
      }
      async put(): Promise<void> {}
      async onMutate(params: MutationOption): Promise<void> {
        mutations.push(params);
      }
    }
    const client = await createTestPgwasm();
    await client.exec(
      "CREATE TABLE users (id serial PRIMARY KEY, name text NOT NULL, active boolean NOT NULL DEFAULT true)",
    );
    const cache = new RecordingCache();
    const db = drizzle(client, { cache });
    await db.$cache.invalidate({ tables: "users" });
    await db.insert(users).values({ name: "ada" });
    expect(mutations).toEqual([{ tables: "users" }, { tables: ["users"] }]);
    // The caller's cache object is not changed.
    expect(Object.keys(cache)).toEqual([]);
  });

  it("keeps a callable no-op $cache.invalidate when no cache is configured", async () => {
    const db = drizzle(await createTestPgwasm());
    expect(await db.$cache.invalidate({ tables: "users" })).toBeUndefined();
  });

  describe("JIT row mappers", () => {
    const mappers = (db: object) => (db as { dialect: PgDialect }).dialect.mapperGenerators.rows.name;

    it("are used only when asked for and `new Function` works", async () => {
      const client = await createTestPgwasm();
      expect(mappers(drizzle(client))).toBe("makeDefaultQueryMapper");
      expect(mappers(drizzle(client, { jit: true }))).toBe("makeJitQueryMapper");
      expect(jitMappersUsable(undefined)).toBe(false);
      expect(jitMappersUsable(true)).toBe(true);
    });

    it("fall back to the premade mappers where `new Function` throws (a strict CSP)", async () => {
      const { client } = await database();
      const realFunction = globalThis.Function;
      // What an MV3 extension page's CSP does to the Function constructor.
      globalThis.Function = function forbidden(): never {
        throw new EvalError("Refused to evaluate a string as JavaScript: 'unsafe-eval' is not allowed");
      } as unknown as FunctionConstructor;
      let db: ReturnType<typeof drizzle>;
      try {
        expect(jitMappersUsable(true)).toBe(false);
        db = drizzle(client, { jit: true });
      } finally {
        globalThis.Function = realFunction;
      }
      expect(mappers(db)).toBe("makeDefaultQueryMapper");
      await db.insert(users).values({ name: "ada" });
      expect(await db.select({ name: users.name }).from(users)).toEqual([{ name: "ada" }]);
    });
  });
});
