import { afterEach, describe, expect, it, spyOn } from "bun:test";
// Restore — boot a client on a store backup (ADR-0035 decision 6, refined by ADR-0046). A REAL in-memory
// PGlite. Round-trips a live `exportStore` tarball into a FRESH store via `restoreFrom` and asserts the
// restore rules: fresh-target-only, recovered journal quarantined, and the ADR-0046 sync-enable split — a
// restore whose recovered journal HAS quarantined mutations stays OFFLINE (dead network URLs prove no fetch),
// while a restore of a CLEAN-journal backup (empty journal — the server bootstrap-artifact case) boots ONLINE
// and a shape stream fetches (against dead URLs, the inverse signal). The memory test lane is fresh by
// construction (the `file://` fresh-target refusal is exercised against a real datadir under ./tmp).
import { mkdir, rm } from "node:fs/promises";

import { bigint, boolean, uuid, varchar } from "drizzle-orm/pg-core";

import { defineSyncRegistry, defineSyncTable } from "@pgxsinkit/contracts";

import {
  createSyncClient,
  RestoreTargetExistsError,
  type SyncClient,
  storeTargetExists,
} from "../../packages/client/src/index";
import { opfsStoreDirectoryPath, storeIndexedDbDatabaseName } from "../../packages/client/src/store-path";
import { memoryStoreForTests } from "../../packages/client/src/testing";

const todosRegistry = defineSyncRegistry({
  todos: defineSyncTable({
    tableName: "todos",
    makeColumns: () => ({
      id: uuid("id").primaryKey(),
      title: varchar("title", { length: 200 }).notNull(),
      done: boolean("done").notNull(),
      updatedAtUs: bigint("updated_at_us", { mode: "bigint" }).notNull(),
    }),
    mode: "readwrite",
    conflictPolicy: "last-write-wins",
    governance: {
      managedFields: [{ column: "updatedAtUs", applyOn: ["create", "update"], strategy: "nowMicroseconds" }],
    },
  }),
});
type TodosRegistry = typeof todosRegistry;

// Dead network URLs (`127.0.0.1:1` — nothing listens): if a restore boot ever started a shape stream it would
// fetch here and the error would surface on `status`/degrade — the negative signal the "boots offline" assertions rely on.
const DEAD_ELECTRIC = "http://127.0.0.1:1/v1/electric-proxy";
const DEAD_WRITE = "http://127.0.0.1:1/api/mutations";

const SYNCED_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const STAGED_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

const clients: SyncClient<TodosRegistry>[] = [];
const tmpStorePaths: string[] = [];
const savedNavigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
const savedIndexedDbDescriptor = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");

function notFound(): Error {
  const error = new Error("not found");
  error.name = "NotFoundError";
  return error;
}

class FakeRestoreDir {
  readonly dirs = new Map<string, FakeRestoreDir>();
  async getDirectoryHandle(name: string): Promise<FakeRestoreDir> {
    const child = this.dirs.get(name);
    if (!child) throw notFound();
    return child;
  }
}

function seedRestoreStore(root: FakeRestoreDir, storePath: string): void {
  let parent = root;
  for (const segment of opfsStoreDirectoryPath(storePath)) {
    let child = parent.dirs.get(segment);
    if (!child) {
      child = new FakeRestoreDir();
      parent.dirs.set(segment, child);
    }
    parent = child;
  }
}

function installBrowserRestoreTargets(root: FakeRestoreDir, idbNames: string[]): void {
  Object.defineProperty(globalThis, "navigator", {
    value: { storage: { getDirectory: async () => root } },
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, "indexedDB", {
    value: { databases: async () => idbNames.map((name) => ({ name })) },
    configurable: true,
    writable: true,
  });
}

afterEach(async () => {
  for (const client of clients.splice(0)) await client.stop().catch(() => undefined);
  // Clean up any real filesystem datadirs the fresh-target lane created under ./tmp.
  for (const path of tmpStorePaths.splice(0)) await rm(path, { recursive: true, force: true }).catch(() => undefined);
  if (savedNavigatorDescriptor === undefined) delete (globalThis as { navigator?: unknown }).navigator;
  else Object.defineProperty(globalThis, "navigator", savedNavigatorDescriptor);
  if (savedIndexedDbDescriptor === undefined) delete (globalThis as { indexedDB?: unknown }).indexedDB;
  else Object.defineProperty(globalThis, "indexedDB", savedIndexedDbDescriptor);
});

/** A memory-backed, sync-disabled client on the dead URLs, tracked for teardown. */
async function makeMemoryClient(
  storePath: string,
  extra: Partial<Parameters<typeof createSyncClient<TodosRegistry>>[0]> = {},
): Promise<SyncClient<TodosRegistry>> {
  const client = await createSyncClient<TodosRegistry>({
    registry: todosRegistry,
    electricUrl: DEAD_ELECTRIC,
    batchWriteUrl: DEAD_WRITE,
    syncEnabled: false,
    ...memoryStoreForTests(storePath),
    ...extra,
  });
  clients.push(client);
  return client;
}

/**
 * Build a store-backup tarball whose datadir carries one "synced" row (inserted straight into the base synced
 * table, as the read path would) AND one staged-but-unflushed write (a `pending` journal + overlay row).
 */
async function makeBackupWithSyncedRowAndStagedWrite(): Promise<Blob> {
  const source = await makeMemoryClient("restore-src");
  await source.ready;
  // A "synced" row: write it directly into the base synced table (`todos`), exactly where the read path lands
  // server rows — no overlay, no journal. It must reappear in the restored store's read model.
  await source.rawExec(
    `INSERT INTO todos (id, title, done, updated_at_us) VALUES ('${SYNCED_ID}', 'synced-row', false, 1);`,
  );
  // A staged unflushed write: goes to the overlay + journal as `pending` (syncEnabled:false → nothing drains it).
  await source.mutate.create("todos", { id: STAGED_ID, title: "staged", done: false });
  expect((await source.diagnostics()).mutation.pendingCount).toBe(1);

  const { file } = await source.exportStore();
  return file;
}

/**
 * Build a store-backup tarball whose datadir carries one "synced" row but an EMPTY journal — no staged write,
 * nothing to recover/quarantine. This is the shape of a server-generated bootstrap artifact, the case ADR-0046
 * brings online on restore.
 */
async function makeCleanBackup(): Promise<Blob> {
  const source = await makeMemoryClient("restore-src-clean");
  await source.ready;
  await source.rawExec(
    `INSERT INTO todos (id, title, done, updated_at_us) VALUES ('${SYNCED_ID}', 'synced-row', false, 1);`,
  );
  // No staged write → the journal is empty (nothing to quarantine on restore).
  expect((await source.diagnostics()).mutation.pendingCount).toBe(0);
  const { file } = await source.exportStore();
  return file;
}

/** Poll `predicate` until true, bounded — used to await the background sync tail's first fetch attempt. */
async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("waitUntil timed out");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("restore — boot a client from a store backup (ADR-0035 decision 6)", () => {
  it("round-trips into a FRESH store: synced rows present, overlay intact, journal quarantined, offline", async () => {
    const backup = await makeBackupWithSyncedRowAndStagedWrite();

    // No fetch may be attempted on a restore boot — spy across the whole restore to prove the read path stayed dark.
    const fetchSpy = spyOn(globalThis, "fetch");
    const restored = await makeMemoryClient("restore-dst-roundtrip", { restoreFrom: backup });
    await restored.ready;

    // Synced row survived the round trip and reads back through the merged read model.
    const syncedRows = await restored.rawQuery("SELECT id FROM todos WHERE id = $1", [SYNCED_ID]);
    expect(syncedRows.rows).toHaveLength(1);
    const readModel = await restored.rawQuery("SELECT id FROM todos_read_model WHERE id = $1", [SYNCED_ID]);
    expect(readModel.rows).toHaveLength(1);

    // The staged write's overlay row is intact — the optimistic edit is not lost.
    const overlay = await restored.rawQuery("SELECT count(*)::int AS n FROM todos_overlay");
    expect((overlay.rows[0] as { n: number } | undefined)?.n).toBe(1);

    // The recovered journal row was quarantined (nothing recovered auto-flushes) — no `pending` remains.
    const diag = (await restored.diagnostics()).mutation;
    expect(diag.quarantinedCount).toBe(1);
    expect(diag.pendingCount).toBe(0);
    expect(diag.sendingCount).toBe(0);
    expect(diag.failedCount).toBe(0);

    // Offline: sync-disabled `ready` phase, never a degraded/syncing read stream, and — decisively — no fetch.
    expect(restored.status.phase).toBe("ready");
    expect(restored.status.lastError).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("stamps the BootReport storeKind='restored' and visits the writable journal during recovery (ADR-0034)", async () => {
    const backup = await makeBackupWithSyncedRowAndStagedWrite();
    const restored = await makeMemoryClient("restore-dst-bootreport", { restoreFrom: backup });
    await restored.ready;

    // A restore boot seeds a brand-new store from the backup — never "fresh"/"warm" — and finalizes the
    // report at `ready` (offline boot).
    const r = (await restored.bootReport())!;
    expect(r.storeKind).toBe("restored");
    expect(r.freshStore).toBe(false);

    // The boot-time recoverSending pass visits every writable journal; this registry has one readwrite table.
    expect(r.warmBoot.journalTablesVisited).toBe(1);
    // A restore ignores the recovery marker: the unconditional recovery pass always runs and is treated as
    // required, and the count is not instrumented on that path.
    expect(r.warmBoot.journalRecoverySkipped).toBe(false);
    expect(r.warmBoot.journalRecoveryRequired).toBe(true);
    expect(r.warmBoot.journalRowsRecovered).toBeNull();
    // Slice 3: the backup carries the durable schema AND its stamped `local_schema_fingerprint`, so the
    // restore boot's freshly-generated durable-schema hash MATCHES and the durable replay is correctly SKIPPED
    // (the schema arrived with the backup; the ephemeral cluster is still re-applied). A backup from an older
    // registry would instead mismatch and replay — the ADR-0006 reconcile then owns the evolution.
    expect(r.warmBoot.schemaSkipped).toBe(true);
    expect(r.warmBoot.schemaFingerprintMatch).toBe(true);
  });

  it("release path: discardQuarantined drops a restore-quarantined row so the entity accepts new writes", async () => {
    const backup = await makeBackupWithSyncedRowAndStagedWrite();
    const restored = await makeMemoryClient("restore-dst-release", { restoreFrom: backup });
    await restored.ready;
    expect((await restored.diagnostics()).mutation.quarantinedCount).toBe(1);

    // The existing quarantine-drop API (there is no requeue-from-quarantine — `quarantined` is terminal) clears
    // the kept overlay + journal row, so the entity is unblocked.
    await restored.discardQuarantined("todos", { id: STAGED_ID });
    const diag = (await restored.diagnostics()).mutation;
    expect(diag.quarantinedCount).toBe(0);

    // The phantom optimistic row is gone, so a brand-new write on the same entity now enqueues cleanly (no
    // longer blocked behind the quarantined head).
    await restored.mutate.create("todos", { id: STAGED_ID, title: "re-authored", done: true });
    expect((await restored.diagnostics()).mutation.pendingCount).toBe(1);
  });

  it("offline wins: an explicit online option alongside restoreFrom still boots offline (no fetch)", async () => {
    const backup = await makeBackupWithSyncedRowAndStagedWrite();

    const fetchSpy = spyOn(globalThis, "fetch");
    // syncEnabled:true is the explicit online option; restore must override it and start no shape streams.
    const restored = await makeMemoryClient("restore-dst-offlinewins", { restoreFrom: backup, syncEnabled: true });
    await restored.ready;

    expect(restored.status.phase).toBe("ready");
    expect(restored.status.lastError).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
    // Still quarantined — the offline override does not change the recovery rule.
    expect((await restored.diagnostics()).mutation.quarantinedCount).toBe(1);
    fetchSpy.mockRestore();
  });

  it("clean-journal restore boots ONLINE — a shape stream starts and fetches (ADR-0046)", async () => {
    const backup = await makeCleanBackup();

    const fetchSpy = spyOn(globalThis, "fetch");
    // No `syncEnabled: false` (so it defaults on) — a clean-journal restore comes online. Dead URLs make the
    // stream's fetch attempt observable: the INVERSE of the offline tests' "never fetches" negative signal.
    const restored = await createSyncClient<TodosRegistry>({
      registry: todosRegistry,
      electricUrl: DEAD_ELECTRIC,
      batchWriteUrl: DEAD_WRITE,
      ...memoryStoreForTests("restore-dst-clean-online"),
      restoreFrom: backup,
    });
    clients.push(restored);

    // `createSyncClient` resolves at localReadReady; the sync tail starts shape streams in the BACKGROUND. A
    // restore that stayed offline would never fetch, so a fetch attempt cleanly proves the ADR-0046 online path
    // ran (the dead URL then surfaces as a fetch error / degraded status — expected, not asserted).
    await waitUntil(() => fetchSpy.mock.calls.length > 0);
    expect(fetchSpy).toHaveBeenCalled();
    // The recovered journal was clean — nothing quarantined — which is exactly the condition that gated online.
    expect((await restored.diagnostics()).mutation.quarantinedCount).toBe(0);
    fetchSpy.mockRestore();
  });

  it("clean-journal restore with syncEnabled:false stays OFFLINE (explicit opt-out honoured)", async () => {
    const backup = await makeCleanBackup();

    const fetchSpy = spyOn(globalThis, "fetch");
    // `makeMemoryClient` sets `syncEnabled: false` — an explicit opt-out overrides the clean-journal online path.
    const restored = await makeMemoryClient("restore-dst-clean-optout", { restoreFrom: backup });
    await restored.ready;

    expect(restored.status.phase).toBe("ready");
    expect(restored.status.lastError).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("refuses restore onto an EXISTING file:// store with the typed error", async () => {
    // A real filesystem datadir under ./tmp: create a normal store there first (Bun → `file://`), then attempt a
    // restore onto the same path. The fresh-target gate must refuse it before touching the datadir.
    const storePath = "tmp/agents/restore-existing-store";
    tmpStorePaths.push(storePath);
    // tmp/ is gitignored, so the parent does not exist on a fresh checkout (CI) — PGlite's NodeFS
    // throws at construction on a missing parent rather than creating it.
    await mkdir("tmp/agents", { recursive: true });
    const first = await createSyncClient<TodosRegistry>({
      registry: todosRegistry,
      electricUrl: DEAD_ELECTRIC,
      batchWriteUrl: DEAD_WRITE,
      syncEnabled: false,
      storePath,
    });
    clients.push(first);
    await first.ready;
    // The datadir now exists on disk.
    expect(await storeTargetExists(storePath)).toBe(true);

    // Any Blob suffices — the refusal fires BEFORE the create/loadDataDir, so its contents never matter.
    // oxlint-disable-next-line typescript/await-thenable -- bun-types gap: .resolves/.rejects matchers return a real promise typed as void
    await expect(
      createSyncClient<TodosRegistry>({
        registry: todosRegistry,
        electricUrl: DEAD_ELECTRIC,
        batchWriteUrl: DEAD_WRITE,
        storePath,
        restoreFrom: new Blob([new Uint8Array([1, 2, 3])]),
      }),
    ).rejects.toBeInstanceOf(RestoreTargetExistsError);
  });

  it("refuses a granted restore when the OPFS target is already committed", async () => {
    const storePath = "restore-existing-opfs";
    const root = new FakeRestoreDir();
    seedRestoreStore(root, storePath);
    installBrowserRestoreTargets(root, []);

    // oxlint-disable-next-line typescript/await-thenable -- bun-types gap: .rejects returns a promise typed as void
    await expect(
      createSyncClient<TodosRegistry>({
        registry: todosRegistry,
        electricUrl: DEAD_ELECTRIC,
        batchWriteUrl: DEAD_WRITE,
        storePath,
        hasOpfsSyncAccess: true,
        restoreFrom: new Blob([new Uint8Array([1, 2, 3])]),
      }),
    ).rejects.toBeInstanceOf(RestoreTargetExistsError);
  });

  it("refuses a granted restore when only an IDB predecessor exists", async () => {
    const storePath = "restore-existing-idb";
    installBrowserRestoreTargets(new FakeRestoreDir(), [storeIndexedDbDatabaseName(storePath)]);

    // oxlint-disable-next-line typescript/await-thenable -- bun-types gap: .rejects returns a promise typed as void
    await expect(
      createSyncClient<TodosRegistry>({
        registry: todosRegistry,
        electricUrl: DEAD_ELECTRIC,
        batchWriteUrl: DEAD_WRITE,
        storePath,
        hasOpfsSyncAccess: true,
        restoreFrom: new Blob([new Uint8Array([1, 2, 3])]),
      }),
    ).rejects.toBeInstanceOf(RestoreTargetExistsError);
  });

  it("throws when restoreFrom is combined with pgliteInstance or precreatedPglite", async () => {
    const backup = new Blob([new Uint8Array([1, 2, 3])]);
    // A dummy instance/promise is enough — the mutual-exclusion guard runs before either is dereferenced.
    const fakeInstance = {} as never;
    // oxlint-disable-next-line typescript/await-thenable -- bun-types gap: .resolves/.rejects matchers return a real promise typed as void
    await expect(
      createSyncClient<TodosRegistry>({
        registry: todosRegistry,
        electricUrl: DEAD_ELECTRIC,
        batchWriteUrl: DEAD_WRITE,
        restoreFrom: backup,
        pgliteInstance: fakeInstance,
      }),
    ).rejects.toThrow(/mutually exclusive/);
    // oxlint-disable-next-line typescript/await-thenable -- bun-types gap: .resolves/.rejects matchers return a real promise typed as void
    await expect(
      createSyncClient<TodosRegistry>({
        registry: todosRegistry,
        electricUrl: DEAD_ELECTRIC,
        batchWriteUrl: DEAD_WRITE,
        restoreFrom: backup,
        precreatedPglite: Promise.resolve(fakeInstance),
      }),
    ).rejects.toThrow(/mutually exclusive/);
  });

  it("fails loudly on a corrupt/garbage backup blob (memory lane — no store debris to survive)", async () => {
    // Garbage bytes are not a valid PGlite datadir tarball → `loadDataDir` throws during create, and the boot
    // rejects rather than half-creating a store. A memory store leaves nothing behind, so a retry is fresh.
    const garbage = new Blob([new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x00, 0x01, 0x02, 0x03])]);
    // oxlint-disable-next-line typescript/await-thenable -- bun-types gap: .resolves/.rejects matchers return a real promise typed as void
    await expect(makeMemoryClient("restore-dst-corrupt", { restoreFrom: garbage })).rejects.toBeDefined();
    // PGlite 0.5.4's Emscripten runtime sets `process.exitCode = 1` when the create ABORTS on the corrupt
    // tarball — even though the rejection above is caught and asserted (probed; recorded in the upstream
    // report draft in tmp/agents/). Left in place, bun test exits 1 with every test passing. Clear exactly
    // the poisoned code here: a genuine test failure still sets bun's own failure exit afterwards.
    process.exitCode = 0;
  });
});
