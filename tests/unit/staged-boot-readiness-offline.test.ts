import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

import { bigint, boolean, uuid, varchar } from "drizzle-orm/pg-core";

import { defineSyncRegistry, defineSyncTable } from "@pgxsinkit/contracts";

import { createSyncClient, type LocalStoreVersionEvent, type SyncClient } from "../../packages/client/src/index";
import { writeStoredRegistryFingerprint } from "../../packages/client/src/local-store";

// ADR-0041 staged boot readiness (stage 1) — REAL PGlite (filesystem store under ./tmp), no mocks. Covers the
// two invariants that only a real store proves: (1) an OFFLINE boot with `syncEnabled: true` and unreachable
// endpoints resolves `localReadReady` + `writeReady` with ZERO network while `ready` stays pending, and a
// cached row still reads; (2) a stale-fingerprint boot that OWES mutations DEFERS the read-cache rebuild yet
// still resolves `localReadReady` (the deferred event fires, the pre-rebuild rows survive).

const registry = defineSyncRegistry({
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
    // An eager shape so a `syncEnabled: true` boot actually starts a stream against the (unreachable) endpoint.
    shape: { shapeKey: "todos" },
    governance: {
      managedFields: [{ column: "updatedAtUs", applyOn: ["create", "update"], strategy: "nowMicroseconds" }],
    },
  }),
});
type TodosRegistry = typeof registry;

// Unreachable / blackholed endpoints — a boot must not dial them on the localReadReady/writeReady path.
const UNREACHABLE_ELECTRIC = "http://10.255.255.1:81/v1/shape";
const UNREACHABLE_WRITE = "http://10.255.255.1:81/api/mutations";

const TMP_ROOT = path.resolve(process.cwd(), "tmp/staged-boot-offline");
const clients: SyncClient<TodosRegistry>[] = [];
const tmpDirs: string[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.stop().catch(() => undefined);
  for (const dir of tmpDirs.splice(0)) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

async function freshStoreDir(label: string): Promise<string> {
  const dir = path.join(TMP_ROOT, `${label}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  tmpDirs.push(dir);
  return path.join(dir, "store");
}

/** Resolves `true` if `promise` settles within `ms`, `false` otherwise — a bounded, sleep-free readiness probe. */
function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  return Promise.race([
    promise.then(
      () => true,
      () => true,
    ),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms)),
  ]);
}

describe("ADR-0041 staged boot readiness (stage 1) — real PGlite", () => {
  it("offline warm boot: localReadReady + writeReady resolve with zero network, cached read works, ready stays pending", async () => {
    const storePath = await freshStoreDir("offline");

    // Boot A — create the warm store (sync OFF) and seed a cached synced row directly into the base table.
    const seed = await createSyncClient<TodosRegistry>({
      registry,
      electricUrl: UNREACHABLE_ELECTRIC,
      batchWriteUrl: UNREACHABLE_WRITE,
      syncEnabled: false,
      storePath,
    });
    await seed.ready;
    await seed.rawExec(
      `INSERT INTO todos (id, title, done, updated_at_us) VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'cached', false, 1);`,
    );
    await seed.stop(); // persists the store on disk; the next boot is a genuine cold-engine warm-store boot.

    // Boot B — the OFFLINE warm boot with sync ENABLED and unreachable endpoints.
    let fetchCalls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
      fetchCalls += 1;
      return originalFetch(...args);
    }) as typeof fetch;

    try {
      const client = await createSyncClient<TodosRegistry>({
        registry,
        electricUrl: UNREACHABLE_ELECTRIC,
        batchWriteUrl: UNREACHABLE_WRITE,
        syncEnabled: true,
        storePath,
      });
      // createSyncClient resolves AT `localReadReady` (Option B). Capture the fetch count synchronously here,
      // before the background write/sync tail can reach sync-start: the local-read core made ZERO network calls.
      const fetchesAtLocalReady = fetchCalls;
      clients.push(client);

      expect(fetchesAtLocalReady).toBe(0);

      // The staged promises resolve promptly — bounded, with no dependency on the (dead) network.
      expect(await settlesWithin(client.localReadReady, 15_000)).toBe(true);
      expect(await settlesWithin(client.writeReady, 15_000)).toBe(true);

      // A cached read succeeds at this point — the seeded row is queryable with the network down.
      const rows = await client.rawQuery("SELECT id FROM todos WHERE id = $1", [
        "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      ]);
      expect(rows.rows).toHaveLength(1);

      // `ready` (whole-client initial sync) stays PENDING offline — that is correct and unchanged.
      expect(await settlesWithin(client.ready, 500)).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }, 60_000);

  it("deferred reconcile: stale fingerprint + owed mutations → deferred event fires, localReadReady resolves, no rebuild", async () => {
    const storePath = await freshStoreDir("deferred");

    // Boot A — seed a cached synced row + an OWED (pending, undrained) mutation, then poison the stored
    // registry fingerprint so the next boot sees a mismatch.
    const seed = await createSyncClient<TodosRegistry>({
      registry,
      electricUrl: UNREACHABLE_ELECTRIC,
      batchWriteUrl: UNREACHABLE_WRITE,
      syncEnabled: false,
      storePath,
    });
    await seed.ready;
    await seed.rawExec(
      `INSERT INTO todos (id, title, done, updated_at_us) VALUES ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'kept', false, 1);`,
    );
    // An owed write (syncEnabled: false → nothing drains it): pendingCount becomes 1.
    await seed.mutate.create("todos", { id: "cccccccc-cccc-cccc-cccc-cccccccccccc", title: "owed", done: false });
    expect((await seed.diagnostics()).mutation.pendingCount).toBe(1);
    // Poison the stored registry fingerprint so boot B's reconcile detects a mismatch.
    await writeStoredRegistryFingerprint(seed.pglite, registry, "lsf1:stale-registry-fingerprint");
    await seed.stop();

    // Boot B — the mismatch + owed mutations must DEFER the rebuild (not drop the owed write), while still
    // resolving `localReadReady`. Capture the schema-change event.
    const events: LocalStoreVersionEvent[] = [];
    const client = await createSyncClient<TodosRegistry>({
      registry,
      electricUrl: UNREACHABLE_ELECTRIC,
      batchWriteUrl: UNREACHABLE_WRITE,
      syncEnabled: false,
      storePath,
      onSchemaChange: (event) => {
        events.push(event);
      },
    });
    clients.push(client);

    // localReadReady resolves despite the deferral.
    expect(await settlesWithin(client.localReadReady, 15_000)).toBe(true);

    // The deferred event fired (rebuild deferred because the store owes work — the owed count includes the
    // pending write), and NO rebuild happened.
    const deferred = events.find((event) => event.status === "deferred");
    expect(deferred).toBeDefined();
    expect(deferred?.owedMutations).toBeGreaterThan(0);
    expect(events.some((event) => event.status === "rebuilt")).toBe(false);

    // The pre-rebuild cached row survived (no rebuild dropped it) and the owed write is still owed.
    const rows = await client.rawQuery("SELECT id FROM todos WHERE id = $1", ["bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"]);
    expect(rows.rows).toHaveLength(1);
    expect((await client.diagnostics()).mutation.pendingCount).toBe(1);
  }, 60_000);
});
