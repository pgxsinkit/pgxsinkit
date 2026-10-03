import { afterEach, describe, expect, it } from "bun:test";

import { defineRelations, eq, sql } from "drizzle-orm";
import { Cache } from "drizzle-orm/cache/core/cache";
import type { MutationOption } from "drizzle-orm/cache/core/cache";
import { CodecsCollection } from "drizzle-orm/codecs";
import {
  bigint,
  bigserial,
  boolean,
  bytea,
  date,
  geometry,
  halfvec,
  integer,
  interval,
  jsonb,
  numeric,
  pgTable,
  serial,
  sparsevec,
  text,
  timestamp,
  vector,
} from "drizzle-orm/pg-core";
import type { PgDialect } from "drizzle-orm/pg-core/dialect";
import { seed } from "drizzle-seed";

import { drizzle, type PgwasmDatabase, UnsupportedDrizzleConfigError } from "../../packages/pgwasm/src/drizzle";
import { drizzleParsers, pgwasmCodecs } from "../../packages/pgwasm/src/drizzle/codecs";
import { jitMappersUsable } from "../../packages/pgwasm/src/drizzle/driver";
import { createTablesFromSchema } from "../support/drizzle";
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
  it("keeps array dimensions separate from vector and sparse-vector text delimiters", () => {
    const arrays = pgTable("codec_arrays", {
      vectors: vector("vectors", { dimensions: 2 }).array(),
      halves: halfvec("halves", { dimensions: 2 }).array("[][]"),
      sparse: sparsevec("sparse", { dimensions: 3 }).array("[][]"),
    });
    const codecs = new CodecsCollection((type) => type, pgwasmCodecs);
    expect(codecs.apply(arrays.vectors, "normalizeParamArray", ["[1,2]", "[3,4]"])).toBe('{"[1,2]","[3,4]"}');
    expect(codecs.apply(arrays.halves, "normalizeParamArray", [["[1,2]", "[3,4]"]])).toBe('{{"[1,2]","[3,4]"}}');
    const sparse = [["{1:0.5}/3", "{2:0.25}/3"]];
    const sparseText = '{{"{1:0.5}/3","{2:0.25}/3"}}';
    expect(codecs.apply(arrays.sparse, "normalizeParamArray", sparse)).toBe(sparseText);
    expect(codecs.apply(arrays.sparse, "normalizeArray", sparseText)).toEqual(sparse);
  });

  it("uses the PostGIS colon array delimiter for both geometry modes and nested arrays", () => {
    const arrays = pgTable("geometry_codec_arrays", {
      points: geometry("points", { mode: "xy" }).array(),
      tuples: geometry("tuples").array("[][]"),
    });
    const codecs = new CodecsCollection((type) => type, pgwasmCodecs);
    expect(codecs.apply(arrays.points, "normalizeParamArray", ["point(1 2)", "point(3 4)"])).toBe(
      '{"point(1 2)":"point(3 4)"}',
    );
    expect(codecs.apply(arrays.tuples, "normalizeParamArray", [["point(1 2)", "point(3 4)"]])).toBe(
      '{{"point(1 2)":"point(3 4)"}}',
    );
    const point12 = "0101000000000000000000F03F0000000000000040";
    const point34 = "010100000000000000000008400000000000001040";
    expect(codecs.apply(arrays.points, "normalizeArray", `{${point12}:${point34}}`)).toEqual([
      { x: 1, y: 2 },
      { x: 3, y: 4 },
    ]);
    expect(codecs.apply(arrays.tuples, "normalizeArray", `{{${point12}:${point34}}}`)).toEqual([
      [
        [1, 2],
        [3, 4],
      ],
    ]);
  });

  it("maps rc5 numeric modes and nullable nested arrays through the real text protocol", async () => {
    const columns = pgTable("codec_values", {
      bigNumber: bigint("big_number", { mode: "number" }),
      serialNumber: bigserial("serial_number", { mode: "number" }),
      bigNumbers: bigint("big_numbers", { mode: "number" }).$type<number | null>().array(),
      amountNumber: numeric("amount_number", { mode: "number" }),
      amountBig: numeric("amount_big", { mode: "bigint" }),
      amounts: numeric("amounts").$type<string | null>().array(),
      amountNumbers: numeric("amount_numbers", { mode: "number" }).$type<number | null>().array(),
      amountBigs: numeric("amount_bigs", { mode: "bigint" }).$type<bigint | null>().array(),
      days: date("days", { mode: "date" }).$type<Date | null>().array(),
      dayStrings: date("day_strings", { mode: "string" }).$type<string | null>().array(),
      ats: timestamp("ats").$type<Date | null>().array(),
      atTzs: timestamp("at_tzs", { withTimezone: true }).$type<Date | null>().array(),
      spans: interval("spans").$type<string | null>().array(),
    });
    const client = await createTestPgwasm();
    await createTablesFromSchema(client, { codecValues: columns });
    const db = drizzle(client);
    await seed(db, { codecValues: columns }, { count: 1 }).refine((f) => ({
      codecValues: {
        columns: {
          bigNumber: f.valuesFromArray({ values: [1] }),
          serialNumber: f.valuesFromArray({ values: [2] }),
          bigNumbers: f.default({ defaultValue: [1, null, 2, 3] }),
          amountNumber: f.valuesFromArray({ values: [1.25] }),
          amountBig: f.valuesFromArray({ values: [9007199254740993n] }),
          amounts: f.default({ defaultValue: ["9007199254740993.125", null, "1.50", "2.25"] }),
          amountNumbers: f.default({ defaultValue: [1.5, null, 2.25, 3] }),
          amountBigs: f.default({ defaultValue: [9007199254740993n, null] }),
          days: f.default({ defaultValue: [new Date("2024-03-01T00:00:00.000Z"), null] }),
          dayStrings: f.default({ defaultValue: ["2024-03-01", null] }),
          ats: f.default({ defaultValue: [new Date("2024-03-01T10:20:30.000Z"), null] }),
          atTzs: f.default({ defaultValue: [new Date("2024-03-01T02:20:30.000Z"), null] }),
          spans: f.default({ defaultValue: ["1 day", null] }),
        },
      },
    }));
    const [row] = await db.select().from(columns);
    expect(row).toEqual({
      bigNumber: 1,
      serialNumber: 2,
      bigNumbers: [1, null, 2, 3],
      amountNumber: 1.25,
      amountBig: 9007199254740993n,
      amounts: ["9007199254740993.125", null, "1.50", "2.25"],
      amountNumbers: [1.5, null, 2.25, 3],
      amountBigs: [9007199254740993n, null],
      days: [new Date("2024-03-01T00:00:00.000Z"), null],
      dayStrings: ["2024-03-01", null],
      ats: [new Date("2024-03-01T10:20:30.000Z"), null],
      atTzs: [new Date("2024-03-01T02:20:30.000Z"), null],
      spans: ["1 day", null],
    });
    // ARRAY constructors need typed SQL interpolation; Drizzle has no object operator for them.
    // Nest the supported one-dimensional seeded arrays without another write or a seed bypass.
    const query = drizzle
      .mock({ codecs: {} })
      .select({
        days: sql`ARRAY[${columns.days}, ${columns.days}]`.as("days"),
        ats: sql`ARRAY[${columns.ats}, ${columns.ats}]`.as("ats"),
        at_tzs: sql`ARRAY[${columns.atTzs}, ${columns.atTzs}]`.as("at_tzs"),
        spans: sql`ARRAY[${columns.spans}, ${columns.spans}]`.as("spans"),
      })
      .from(columns)
      .toSQL();
    const raw = await client.query(query.sql, query.params, {
      parsers: drizzleParsers,
    });
    expect(raw.rows).toEqual([
      {
        days: [
          ["2024-03-01", null],
          ["2024-03-01", null],
        ],
        ats: [
          ["2024-03-01 10:20:30", null],
          ["2024-03-01 10:20:30", null],
        ],
        at_tzs: [
          ["2024-03-01 02:20:30+00", null],
          ["2024-03-01 02:20:30+00", null],
        ],
        spans: [
          ["1 day", null],
          ["1 day", null],
        ],
      },
    ]);
    const nested = pgTable("nested_codec_values", {
      days: date("days", { mode: "date" }).array("[][]"),
      ats: timestamp("ats").array("[][]"),
      atTzs: timestamp("at_tzs", { withTimezone: true }).array("[][]"),
    });
    const codecs = new CodecsCollection((type) => type, pgwasmCodecs);
    expect(codecs.apply(nested.days, "normalizeArray", raw.rows[0]?.["days"])).toEqual([
      [new Date("2024-03-01T00:00:00.000Z"), null],
      [new Date("2024-03-01T00:00:00.000Z"), null],
    ]);
    expect(codecs.apply(nested.ats, "normalizeArray", raw.rows[0]?.["ats"])).toEqual([
      [new Date("2024-03-01T10:20:30.000Z"), null],
      [new Date("2024-03-01T10:20:30.000Z"), null],
    ]);
    expect(codecs.apply(nested.atTzs, "normalizeArray", raw.rows[0]?.["at_tzs"])).toEqual([
      [new Date("2024-03-01T02:20:30.000Z"), null],
      [new Date("2024-03-01T02:20:30.000Z"), null],
    ]);
  });

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

  describe("drizzle's object form, drizzle({ client, ...config })", () => {
    const mappers = (db: object) => (db as { dialect: PgDialect }).dialect.mapperGenerators.rows.name;

    it("is drizzle(client, config): the same $client, config and queries", async () => {
      const { client } = await database();
      const relations = defineRelations({ users });
      const db = drizzle({ client, relations, jit: true });
      // The type matches the positional form's.
      const typed: PgwasmDatabase<typeof relations> & { $client: typeof client } = db;
      expect(typed.$client).toBe(client);
      expect(mappers(db)).toBe(mappers(drizzle(client, { relations, jit: true })));
      expect(mappers(db)).toBe("makeJitQueryMapper");
      await db.transaction(async (tx) => {
        await tx.insert(users).values([{ name: "ada" }, { name: "grace" }]);
      });
      expect((await db.query.users.findMany({ orderBy: { id: "asc" } })).map((row) => row.name)).toEqual([
        "ada",
        "grace",
      ]);
      expect(mappers(drizzle({ client }))).toBe("makeDefaultQueryMapper");
    });

    it("rejects, with a typed error, the forms that would open their own database", () => {
      const attempts: [() => unknown, string][] = [
        // @ts-expect-error -- the driver never opens its own database
        [() => drizzle({ connection: "idb://app" }), "connection"],
        // @ts-expect-error -- the driver never opens its own database
        [() => drizzle({ connection: { dataDir: "idb://app" }, logger: true }), "connection"],
        // @ts-expect-error -- the driver never opens its own database
        [() => drizzle("idb://app"), "connection string"],
        // @ts-expect-error -- the driver never opens its own database
        [() => drizzle("idb://app", { logger: true }), "connection string"],
        // @ts-expect-error -- the driver never opens its own database
        [() => drizzle(), "no client"],
        // @ts-expect-error -- a client that is not a pgwasm database
        [() => drizzle({ client: { exec: async () => [] } }), "no client"],
      ];
      for (const [attempt, form] of attempts) {
        let error: unknown;
        try {
          attempt();
        } catch (caught) {
          error = caught;
        }
        expect(error).toBeInstanceOf(UnsupportedDrizzleConfigError);
        expect(error).toMatchObject({ name: "UnsupportedDrizzleConfigError", form });
        expect((error as Error).message).toContain("drizzle({ client: pg, ...config })");
      }
    });
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
