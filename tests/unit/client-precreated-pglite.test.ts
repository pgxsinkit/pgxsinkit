import { afterEach, describe, expect, it, spyOn } from "bun:test";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import type { SyncTableRegistry } from "@pgxsinkit/contracts";

import {
  buildCopyFromBlobStatement,
  createClientPGlite,
  createSyncClient,
  type SyncClient,
} from "../../packages/client/src/index";
import { getLocalMetaTable } from "../../packages/client/src/local-tables";
import { REGISTRY_FINGERPRINT_KEY } from "../../packages/client/src/schema";
import { memoryStoreForTests, testStoreAcknowledgment } from "../../packages/client/src/testing";
import { drizzleOver } from "../support/drizzle";

// Engine-level test of the `precreatedPglite` seam (board cold-boot optimisation B): a caller creates the
// raw store via `createClientPGlite`, but the client STILL owns schema exec + store-version reconcile
// (unlike `pgliteInstance`, which skips them). Uses a REAL in-memory PGlite with `syncEnabled: false` so
// no network is needed, and reads back through Drizzle (tier-①/②) rather than raw SQL strings.

const profileTable = pgTable("profile", { id: uuid("id").primaryKey(), name: text("name") });

// A LOCAL-ONLY table the "consumer" owns — pgxsinkit models no such relation (it is absent from the
// registry below), which is exactly the audience of the raw seam's COPY bulk load (ADR-0061). Declared as a
// real Drizzle table (bare, no schema) so `buildCopyFromBlobStatement` reads its identifier off the object;
// created TEMP, so the bare name resolves through `search_path` to `pg_temp` — the applier's ephemeral case.
const definitionCacheTable = pgTable("definition_cache", {
  id: integer("id").primaryKey(),
  headword: text("headword").notNull(),
  entry: jsonb("entry").notNull(),
  fetchedAt: timestamp("fetched_at", { withTimezone: true, mode: "string" }).notNull(),
});
const DEFINITION_CACHE_COLUMNS = ["id", "headword", "entry", "fetched_at"] as const;
const DEFINITION_CACHE_UDTS = { entry: "jsonb", fetched_at: "timestamptz" } as const;
const CREATE_DEFINITION_CACHE =
  "create temp table definition_cache (id int primary key, headword text not null, " +
  "entry jsonb not null, fetched_at timestamptz not null)";

/** Two rows whose jsonb is a real object and whose text carries a tab + a newline (COPY TEXT escaping). */
function definitionCacheRows(): Record<string, unknown>[] {
  return [
    {
      id: 1,
      headword: "\u4e2d\u6587",
      entry: { pinyin: "zh\u014dngw\u00e9n", senses: ["Chinese"], nested: { note: "tab\there" } },
      fetched_at: "2026-09-12 01:02:03+00",
    },
    {
      id: 2,
      headword: "line\nbreak\tand\\slash",
      entry: { pinyin: null, senses: [] },
      fetched_at: "2026-01-01 00:00:00+00",
    },
  ];
}

function bootRegistry(): SyncTableRegistry {
  return {
    profile: {
      table: profileTable,
      mode: "readonly",
      primaryKey: { columns: ["id"] },
      shape: { tableName: "profile", shapeKey: "schema.profile" },
      clientProjection: { syncedTable: "profile" },
    },
  } as unknown as SyncTableRegistry;
}

let client: SyncClient<SyncTableRegistry> | undefined;

afterEach(async () => {
  // `createClientPGlite` instances are not tracked by the support-helper cleanup, so close them here (the
  // client owns and closes `client.pglite`, which IS the precreated instance on the success path).
  await client?.stop();
  client = undefined;
});

async function assertProvisioned(active: SyncClient<SyncTableRegistry>): Promise<void> {
  const db = drizzleOver(active.pglite as unknown as PGlite);
  // The registry's synced read table exists → schema exec ran.
  expect(await db.select().from(profileTable)).toEqual([]);
  // The store-version reconcile stamped the registry fingerprint into the local-meta table.
  const meta = getLocalMetaTable(bootRegistry());
  const rows = await db.select({ value: meta.value }).from(meta).where(eq(meta.key, REGISTRY_FINGERPRINT_KEY));
  expect(rows.length).toBe(1);
}

describe("createSyncClient precreatedPglite", () => {
  it("applies schema + stamps the store version on a caller-precreated instance", async () => {
    const precreated = createClientPGlite(memoryStoreForTests("precreated-success"));
    client = await createSyncClient({
      registry: bootRegistry(),
      controlPlaneUrl: "http://127.0.0.1:3101",
      streamBaseUrl: "http://127.0.0.1:3101/v1/stream",
      batchWriteUrl: "http://127.0.0.1:3101/api/mutations",
      syncEnabled: false,
      // The precreated store is a memory store (test only) — acknowledge it past the BYO refusal (ADR-0036).
      ...testStoreAcknowledgment(),
      precreatedPglite: precreated,
    });
    await client.ready;
    await assertProvisioned(client);
  });

  it("falls back to the storePath create path when the precreated promise REJECTS", async () => {
    client = await createSyncClient({
      registry: bootRegistry(),
      controlPlaneUrl: "http://127.0.0.1:3101",
      streamBaseUrl: "http://127.0.0.1:3101/v1/stream",
      batchWriteUrl: "http://127.0.0.1:3101/api/mutations",
      syncEnabled: false,
      precreatedPglite: Promise.reject(new Error("eager create failed")),
      ...memoryStoreForTests("precreated-fallback"),
    });
    // The rejected pre-create is caught and the normal storePath create path still provisions the store.
    await client.ready;
    await assertProvisioned(client);
  });
});

describe("createSyncClient raw inspection surface", () => {
  it("rawQuery returns rows + fields for a parameterised select", async () => {
    client = await createSyncClient({
      registry: bootRegistry(),
      controlPlaneUrl: "http://127.0.0.1:3101",
      streamBaseUrl: "http://127.0.0.1:3101/v1/stream",
      batchWriteUrl: "http://127.0.0.1:3101/api/mutations",
      syncEnabled: false,
      ...testStoreAcknowledgment(),
      precreatedPglite: createClientPGlite(memoryStoreForTests("raw-query")),
    });
    await client.ready;
    // Seed straight into the synced read table (inspection surface bypasses the journal/overlay), then read
    // it back through `rawQuery` with a bound param.
    await client.rawExec("insert into profile (id, name) values ('11111111-1111-1111-1111-111111111111', 'Ada')");
    const result = await client.rawQuery("select id, name from profile where name = $1", ["Ada"]);
    expect(result.rows).toEqual([{ id: "11111111-1111-1111-1111-111111111111", name: "Ada" }]);
    expect(result.fields.map((field) => field.name)).toEqual(["id", "name"]);

    // `rowMode: "array"` passes straight through to PGlite — the REPL's exec mode.
    const arrayResult = await client.rawQuery("select id, name from profile where name = $1", ["Ada"], {
      rowMode: "array",
    });
    expect(Array.isArray(arrayResult.rows[0])).toBe(true);
    expect((arrayResult.rows[0] as unknown[])[1]).toBe("Ada");
  });

  it("rawExec runs a multi-statement script and returns one Results per statement", async () => {
    client = await createSyncClient({
      registry: bootRegistry(),
      controlPlaneUrl: "http://127.0.0.1:3101",
      streamBaseUrl: "http://127.0.0.1:3101/v1/stream",
      batchWriteUrl: "http://127.0.0.1:3101/api/mutations",
      syncEnabled: false,
      ...testStoreAcknowledgment(),
      precreatedPglite: createClientPGlite(memoryStoreForTests("raw-exec")),
    });
    await client.ready;
    const results = await client.rawExec(
      "insert into profile (id, name) values ('22222222-2222-2222-2222-222222222222', 'Grace'); select count(*)::int as n from profile;",
    );
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBe(2);
    expect((results[1]?.rows[0] as { n?: number })?.n).toBe(1);
  });
});

// The TRANSACTIONAL raw seam (the consumer's atomic LOCAL-ONLY write): several statements, one PGlite
// transaction, all-or-nothing. Raw SQL strings are the surface under test here (tier ③ by definition — the
// seam exists precisely to carry SQL pgxsinkit does not model), but the ASSERTIONS read back through
// Drizzle, so the rollback proof is a typed one.
describe("createSyncClient rawTransaction", () => {
  async function bootClient(storeName: string): Promise<SyncClient<SyncTableRegistry>> {
    const booted = await createSyncClient({
      registry: bootRegistry(),
      controlPlaneUrl: "http://127.0.0.1:3101",
      streamBaseUrl: "http://127.0.0.1:3101/v1/stream",
      batchWriteUrl: "http://127.0.0.1:3101/api/mutations",
      syncEnabled: false,
      ...testStoreAcknowledgment(),
      precreatedPglite: createClientPGlite(memoryStoreForTests(storeName)),
    });
    await booted.ready;
    return booted;
  }

  it("runs the statements in ONE transaction and returns one Results per statement", async () => {
    client = await bootClient("raw-transaction-commit");
    const results = await client.rawTransaction([
      {
        sql: "insert into profile (id, name) values ($1, $2)",
        params: ["33333333-3333-3333-3333-333333333333", "Grace"],
      },
      { sql: "select id, name from profile order by name" },
    ]);

    expect(results.length).toBe(2);
    expect(results[1]?.rows).toEqual([{ id: "33333333-3333-3333-3333-333333333333", name: "Grace" }]);
    // Committed: the row survives the transaction.
    const db = drizzleOver(client.pglite as unknown as PGlite);
    expect(await db.select().from(profileTable)).toEqual([
      { id: "33333333-3333-3333-3333-333333333333", name: "Grace" },
    ]);
  });

  it("ROLLS BACK the whole list when a later statement fails, and rejects", async () => {
    client = await bootClient("raw-transaction-rollback");
    let rejected = "";
    try {
      await client.rawTransaction([
        {
          sql: "insert into profile (id, name) values ($1, $2)",
          params: ["44444444-4444-4444-4444-444444444444", "Ada"],
        },
        // Fails at execution (invalid uuid text), AFTER the first statement has run.
        { sql: "insert into profile (id, name) values ('not-a-uuid', 'Boom')" },
      ]);
    } catch (error) {
      rejected = (error as Error).message;
    }
    expect(rejected.length).toBeGreaterThan(0);

    // All-or-nothing: the FIRST statement's row is gone too.
    const db = drizzleOver(client.pglite as unknown as PGlite);
    expect(await db.select().from(profileTable)).toEqual([]);
  });

  it("resolves [] for an empty list WITHOUT opening a transaction", async () => {
    client = await bootClient("raw-transaction-empty");
    const transaction = spyOn(client.pglite as unknown as PGlite, "transaction");
    try {
      expect(await client.rawTransaction([])).toEqual([]);
      expect(transaction).not.toHaveBeenCalled();
    } finally {
      transaction.mockRestore();
    }
  });

  // ADR-0061: a statement may carry the COPY TEXT body of a `COPY … FROM '/dev/blob'`, so a chunk of rows
  // lands in ONE statement instead of one INSERT per row — inside the same all-or-nothing list as whatever
  // must land with it (here the CREATE). jsonb and timestamptz are in the table on purpose: they are the
  // two types the serializer has to be told about / has to format, and the ones an app-owned cache carries.
  it("BULK-LOADS a local-only table from a statement blob, inside the transaction", async () => {
    client = await bootClient("raw-transaction-copy-blob");
    const rows = definitionCacheRows();
    const copy = buildCopyFromBlobStatement({
      table: definitionCacheTable,
      columns: DEFINITION_CACHE_COLUMNS,
      rows,
      udtNames: DEFINITION_CACHE_UDTS,
    });
    // The renderer names the table + columns off the REAL Drizzle objects — never a hand-written string.
    expect(copy.sql).toBe(
      `COPY "definition_cache" ("id", "headword", "entry", "fetched_at") FROM '/dev/blob' WITH (FORMAT text)`,
    );
    expect(copy.blob.byteLength).toBeGreaterThan(0);

    const results = await client.rawTransaction([
      { sql: CREATE_DEFINITION_CACHE },
      copy,
      { sql: "select id, headword, entry, fetched_at from definition_cache order by id" },
    ]);
    expect(results.length).toBe(3);

    const loaded = results[2]?.rows as {
      id: number;
      headword: string;
      entry: unknown;
      fetched_at: Date;
    }[];
    expect(loaded.length).toBe(2);
    // jsonb round-trips as a PARSED object (it was given parsed, per the serializer contract).
    expect(loaded[0]).toMatchObject({ id: 1, headword: "\u4e2d\u6587" });
    expect(loaded[0]?.entry).toEqual({
      pinyin: "zh\u014dngw\u00e9n",
      senses: ["Chinese"],
      nested: { note: "tab\there" },
    });
    const fetchedAt = loaded[0]?.fetched_at;
    expect(fetchedAt instanceof Date).toBe(true);
    expect((fetchedAt as Date).toISOString()).toBe("2026-09-12T01:02:03.000Z");
    // Tabs, newlines and backslashes survive COPY TEXT framing rather than tearing the row.
    expect(loaded[1]?.headword).toBe("line\nbreak\tand\\slash");
    expect(loaded[1]?.entry).toEqual({ pinyin: null, senses: [] });

    // In-process, nothing is transferred: the caller's buffer is still intact after the call.
    expect(copy.blob.byteLength).toBeGreaterThan(0);
  });

  // The same bulk load with NO surrounding transaction — the single-statement form, on `rawQuery`'s options.
  it("BULK-LOADS through rawQuery's options.blob (no transaction)", async () => {
    client = await bootClient("raw-query-copy-blob");
    await client.rawExec(`${CREATE_DEFINITION_CACHE};`);

    const rows = definitionCacheRows();
    const copy = buildCopyFromBlobStatement({
      table: definitionCacheTable,
      columns: DEFINITION_CACHE_COLUMNS,
      rows,
      udtNames: DEFINITION_CACHE_UDTS,
    });
    await client.rawQuery(copy.sql, [], { blob: copy.blob });

    const counted = await client.rawQuery("select count(*)::int as n from definition_cache");
    expect((counted.rows[0] as { n?: number })?.n).toBe(2);
    const read = await client.rawQuery("select entry from definition_cache where id = 1");
    expect((read.rows[0] as { entry?: { senses?: string[] } })?.entry?.senses).toEqual(["Chinese"]);
  });
});
