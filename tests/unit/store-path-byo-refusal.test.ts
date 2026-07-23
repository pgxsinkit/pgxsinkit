import { afterEach, describe, expect, it } from "bun:test";
// The BYO-instance refusal (ADR-0036 decision 4): `createSyncClient` refuses a caller-owned PGlite that is
// PROVABLY non-persistent (a `new PGlite()` default, or an explicit memory store), unless a testing
// acknowledgment is spread into the options. Anything else present — including a real filesystem store —
// passes (the guard is not a storage-backend whitelist). Uses REAL PGlite instances so the `.dataDir` the
// guard inspects is the genuine one.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { pgTable, text, uuid } from "drizzle-orm/pg-core";

import type { SyncTableRegistry } from "@pgxsinkit/contracts";

import {
  type ClientPGlite,
  createClientPGlite,
  createSyncClient,
  NonPersistentStoreError,
  type SyncClient,
} from "../../packages/client/src/index";
import { memoryStoreForTests, testStoreAcknowledgment } from "../../packages/client/src/testing";

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

const commonOptions = {
  registry: bootRegistry(),
  electricUrl: "http://127.0.0.1:3101/v1/electric-proxy",
  batchWriteUrl: "http://127.0.0.1:3101/api/mutations",
  syncEnabled: false,
} as const;

let client: SyncClient<SyncTableRegistry> | undefined;
const looseInstances: PGlite[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  await client?.stop().catch(() => undefined);
  client = undefined;
  for (const instance of looseInstances.splice(0)) await instance.close().catch(() => undefined);
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

describe("BYO refusal (ADR-0036 decision 4)", () => {
  it("refuses a bare `new PGlite()` (in-memory default) supplied as pgliteInstance", async () => {
    const bare = new PGlite();
    looseInstances.push(bare);
    // oxlint-disable-next-line typescript/await-thenable -- bun-types gap: .resolves/.rejects matchers return a real promise typed as void
    await expect(
      createSyncClient({ ...commonOptions, pgliteInstance: bare as unknown as ClientPGlite }),
    ).rejects.toBeInstanceOf(NonPersistentStoreError);
  });

  it("refuses an explicit memory store supplied as pgliteInstance", async () => {
    const memory = await createClientPGlite(memoryStoreForTests("byo-refuse-instance"));
    looseInstances.push(memory as unknown as PGlite);
    // oxlint-disable-next-line typescript/await-thenable -- bun-types gap: .resolves/.rejects matchers return a real promise typed as void
    await expect(createSyncClient({ ...commonOptions, pgliteInstance: memory })).rejects.toBeInstanceOf(
      NonPersistentStoreError,
    );
  });

  it("PROPAGATES the refusal through the precreatedPglite path — never swallowed by the reject-fallback", async () => {
    // The precreated path falls back to a fresh create ONLY when the promise REJECTS. A SUCCESSFULLY
    // resolved-but-non-persistent instance must raise NonPersistentStoreError, not silently boot a fresh store.
    const memory = await createClientPGlite(memoryStoreForTests("byo-refuse-precreated"));
    looseInstances.push(memory as unknown as PGlite);
    // oxlint-disable-next-line typescript/await-thenable -- bun-types gap: .resolves/.rejects matchers return a real promise typed as void
    await expect(
      createSyncClient({ ...commonOptions, precreatedPglite: Promise.resolve(memory) }),
    ).rejects.toBeInstanceOf(NonPersistentStoreError);
  });

  it("PASSES a real filesystem-backed instance (not a whitelist — anything else present is allowed)", async () => {
    // A genuine on-disk store under the repo-local tmp tree — its dataDir is `file://…`, which the guard
    // passes. Proves the predicate catches only the two accidental non-persistent shapes.
    const dir = await mkdtemp(join(tmpdir(), "pgxsinkit-byo-file-"));
    tempDirs.push(dir);
    const fileStore = await createClientPGlite(join(dir, "store"));
    client = await createSyncClient({ ...commonOptions, precreatedPglite: Promise.resolve(fileStore) });
    await client.ready;
    // Schema exec ran on the file store (the readonly synced table exists).
    const result = await client.rawQuery("select count(*)::int as n from profile");
    expect((result.rows[0] as { n: number }).n).toBe(0);
  });

  it("an acknowledgment UNLOCKS a deliberate memory store", async () => {
    client = await createSyncClient({
      ...commonOptions,
      ...testStoreAcknowledgment(),
      precreatedPglite: createClientPGlite(memoryStoreForTests("byo-ack")),
    });
    await client.ready;
    const result = await client.rawQuery("select count(*)::int as n from profile");
    expect((result.rows[0] as { n: number }).n).toBe(0);
  });
});
