import { describe, expect, it } from "bun:test";

import { demoSyncRegistry } from "@pgxsinkit/schema";

import {
  readStoredRegistryFingerprint,
  reconcileLocalStoreVersion,
  writeStoredRegistryFingerprint,
} from "../../packages/client/src/local-store";
import { createMutationRuntime } from "../../packages/client/src/mutation";
import {
  buildDropReadCacheSql,
  buildWipeLocalStoreSql,
  generateLocalSchemaSql,
} from "../../packages/client/src/schema";
import { createFreshTestPGlite } from "../support/pglite";

// ADR-0006: the fingerprint-keyed local store + drain-then-drop read-cache rebuild.

const schemaSql = generateLocalSchemaSql(demoSyncRegistry);
const writeUrl = "http://localhost:3001";

async function provisioned() {
  const db = await createFreshTestPGlite();
  await db.exec(schemaSql);
  const runtime = createMutationRuntime({ db, registry: demoSyncRegistry, writeUrl });
  return { db, runtime };
}

async function tableExists(db: Awaited<ReturnType<typeof createFreshTestPGlite>>, name: string): Promise<boolean> {
  const result = await db.query<{ exists: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = $1) AS "exists"`,
    [name],
  );
  return result.rows[0]?.exists ?? false;
}

async function rowCount(db: Awaited<ReturnType<typeof createFreshTestPGlite>>, table: string): Promise<number> {
  const result = await db.query<{ count: number }>(`SELECT COUNT(*)::int AS "count" FROM ${table}`);
  return result.rows[0]?.count ?? 0;
}

describe("local-meta fingerprint store (ADR-0006)", () => {
  it("round-trips the stored registry fingerprint", async () => {
    const { db } = await provisioned();

    expect(await readStoredRegistryFingerprint(db, demoSyncRegistry)).toBeNull();

    await writeStoredRegistryFingerprint(db, demoSyncRegistry, "fp-1");
    expect(await readStoredRegistryFingerprint(db, demoSyncRegistry)).toBe("fp-1");

    await writeStoredRegistryFingerprint(db, demoSyncRegistry, "fp-2");
    expect(await readStoredRegistryFingerprint(db, demoSyncRegistry)).toBe("fp-2");
  });
});

describe("dropReadCache / wipe (ADR-0005 + ADR-0006)", () => {
  it("dropReadCache removes the synced read cache but preserves overlay + journal", async () => {
    const { db, runtime } = await provisioned();

    // A pending (un-flushed) write: overlay + journal rows are authority and must survive.
    await runtime.create("authors", { id: "01963227-d4c7-72db-b858-f89f6af8a001", name: "Keep me" });
    expect(await rowCount(db, "authors_mutations")).toBe(1);
    expect(await rowCount(db, "authors_overlay")).toBe(1);

    await db.exec(buildDropReadCacheSql(demoSyncRegistry));

    // Synced read cache + its view are gone; authority tables remain with their data.
    expect(await tableExists(db, "authors")).toBe(false);
    expect(await tableExists(db, "todos")).toBe(false);
    expect(await tableExists(db, "authors_overlay")).toBe(true);
    expect(await tableExists(db, "authors_mutations")).toBe(true);
    expect(await rowCount(db, "authors_mutations")).toBe(1);

    // Re-applying the schema rebuilds the synced cache empty, ready to re-sync.
    await db.exec(schemaSql);
    expect(await tableExists(db, "authors")).toBe(true);
    expect(await rowCount(db, "authors")).toBe(0);
    expect(await rowCount(db, "authors_mutations")).toBe(1);
  });

  it("wipe removes the entire local store including overlay, journal, and meta", async () => {
    const { db, runtime } = await provisioned();
    await runtime.create("authors", { id: "01963227-d4c7-72db-b858-f89f6af8a002", name: "Gone" });
    await writeStoredRegistryFingerprint(db, demoSyncRegistry, "fp-x");

    await db.exec(buildWipeLocalStoreSql(demoSyncRegistry));

    for (const name of ["authors", "todos", "authors_overlay", "authors_mutations", "pgxsinkit_local_meta"]) {
      expect(await tableExists(db, name)).toBe(false);
    }
  });
});

describe("reconcileLocalStoreVersion (ADR-0006 drain-then-drop)", () => {
  it("stamps a fresh (unstamped) store with the current fingerprint", async () => {
    const { db, runtime } = await provisioned();

    await reconcileLocalStoreVersion({ db, registry: demoSyncRegistry, runtime });

    expect(await readStoredRegistryFingerprint(db, demoSyncRegistry)).toBe(runtime.registryVersion);
  });

  it("is a no-op when the stored fingerprint already matches", async () => {
    const { db, runtime } = await provisioned();
    await writeStoredRegistryFingerprint(db, demoSyncRegistry, runtime.registryVersion);

    const events: string[] = [];
    await reconcileLocalStoreVersion({
      db,
      registry: demoSyncRegistry,
      runtime,
      onSchemaChange: (event) => {
        events.push(event.status);
      },
    });

    expect(events).toEqual([]);
  });

  it("rebuilds the read cache on a clean (nothing-owed) registry change", async () => {
    const { db, runtime } = await provisioned();
    await writeStoredRegistryFingerprint(db, demoSyncRegistry, "old-fingerprint");

    const events: string[] = [];
    await reconcileLocalStoreVersion({
      db,
      registry: demoSyncRegistry,
      runtime,
      onSchemaChange: (event) => {
        events.push(event.status);
      },
    });

    expect(events).toEqual(["rebuilt"]);
    expect(await readStoredRegistryFingerprint(db, demoSyncRegistry)).toBe(runtime.registryVersion);
    expect(await tableExists(db, "authors")).toBe(true);
  });

  it("defers the rebuild while writes are still owed, never dropping them", async () => {
    const { db, runtime } = await provisioned();
    await writeStoredRegistryFingerprint(db, demoSyncRegistry, "old-fingerprint");

    // An un-flushed write is owed; the upgrade must not wipe it.
    await runtime.create("authors", { id: "01963227-d4c7-72db-b858-f89f6af8a003", name: "Owed" });

    const events: { status: string; owed: number }[] = [];
    await reconcileLocalStoreVersion({
      db,
      registry: demoSyncRegistry,
      runtime,
      onSchemaChange: (event) => {
        events.push({ status: event.status, owed: event.owedMutations });
      },
    });

    expect(events).toEqual([{ status: "deferred", owed: 1 }]);
    // The journal row survived and the fingerprint was NOT advanced (retried next boot).
    expect(await rowCount(db, "authors_mutations")).toBe(1);
    expect(await readStoredRegistryFingerprint(db, demoSyncRegistry)).toBe("old-fingerprint");
  });
});
