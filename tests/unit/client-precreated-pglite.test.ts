import { afterEach, describe, expect, it } from "bun:test";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { pgTable, text, uuid } from "drizzle-orm/pg-core";

import type { SyncTableRegistry } from "@pgxsinkit/contracts";

import { createClientPGlite, createSyncClient, type SyncClient } from "../../packages/client/src/index";
import { getLocalMetaTable } from "../../packages/client/src/local-tables";
import { REGISTRY_FINGERPRINT_KEY } from "../../packages/client/src/schema";
import { memoryStoreForTests, testStoreAcknowledgment } from "../../packages/client/src/testing";
import { drizzleOver } from "../support/drizzle";

// Engine-level test of the `precreatedPglite` seam (board cold-boot optimisation B): a caller creates the
// raw store via `createClientPGlite`, but the client STILL owns schema exec + store-version reconcile
// (unlike `pgliteInstance`, which skips them). Uses a REAL in-memory PGlite with `syncEnabled: false` so
// no network is needed, and reads back through Drizzle (tier-①/②) rather than raw SQL strings.

const profileTable = pgTable("profile", { id: uuid("id").primaryKey(), name: text("name") });

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
      electricUrl: "http://127.0.0.1:3101/v1/electric-proxy",
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
      electricUrl: "http://127.0.0.1:3101/v1/electric-proxy",
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
      electricUrl: "http://127.0.0.1:3101/v1/electric-proxy",
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
      electricUrl: "http://127.0.0.1:3101/v1/electric-proxy",
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
