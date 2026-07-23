import { afterEach, describe, expect, it } from "bun:test";
// The remaining ADR-0035 implementation PROBES, pinned as tests (the ADR's "implementation probes, not
// design blockers"). Three questions the design left to measurement:
//   (a) do ephemeral (pg_temp) row bytes spill into a LIVE store-backup tarball?
//   (b) is a live datadir dump taken UNDER write activity crash-consistent (boots clean, coherent journal)?
//   (c) does a data export's row set equal the live store's synced-table row set (clone fidelity)?
// All three use a REAL in-memory PGlite (`syncEnabled: false`, no network); (c) is WASM-heavy (`pg_dump.wasm`)
// so this file is FULL unit lane only (`test:unit`), never `test:unit:fast`. Fresh stores are booted straight
// from the artefact via `loadDataDir` through the same resolution module the toolkit uses (ADR-0036).

import { PGlite } from "@electric-sql/pglite";
import { bigint, boolean, uuid, varchar } from "drizzle-orm/pg-core";

import { defineSyncRegistry, defineSyncTable } from "@pgxsinkit/contracts";

import { createSyncClient, type SyncClient } from "../../packages/client/src/index";
import { resolveStoreDataDir } from "../../packages/client/src/store-path";
import { memoryStoreForTests } from "../../packages/client/src/testing";

// A distinctive marker unlikely to occur incidentally anywhere in a datadir tarball — the needle probe (a)
// scans the raw bytes for.
const EPHEMERAL_SENTINEL = "ZZZ_EPHEMERAL_SENTINEL_9f3a1c7b4e2d_ZZZ";

// A persistent readwrite table + a lazy/ephemeral one whose cluster is emitted as `pg_temp` TEMP objects
// (ADR-0021 §3) — the ephemeral retention a consumer would reach for to keep sensitive rows off disk.
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
    governance: {
      managedFields: [{ column: "updatedAtUs", applyOn: ["create", "update"], strategy: "nowMicroseconds" }],
    },
  }),
  secret_window: defineSyncTable({
    tableName: "secret_window",
    makeColumns: () => ({
      id: uuid("id").primaryKey(),
      answer: varchar("answer", { length: 200 }).notNull(),
      updatedAtUs: bigint("updated_at_us", { mode: "bigint" }).notNull().default(0n),
    }),
    mode: "readwrite",
    subscription: "lazy",
    retention: "ephemeral",
    conflictPolicy: "last-write-wins",
    governance: {
      managedFields: [{ column: "updatedAtUs", applyOn: ["create", "update"], strategy: "nowMicroseconds" }],
    },
  }),
});
type Registry = typeof registry;

let client: SyncClient<Registry> | undefined;
const freshStores: PGlite[] = [];

afterEach(async () => {
  await client?.stop().catch(() => undefined);
  client = undefined;
  for (const store of freshStores.splice(0)) await store.close().catch(() => undefined);
});

async function makeClient(storePath: string): Promise<SyncClient<Registry>> {
  return createSyncClient<Registry>({
    registry,
    electricUrl: "http://127.0.0.1:1/v1/electric-proxy",
    batchWriteUrl: "http://127.0.0.1:1/api/mutations",
    syncEnabled: false,
    ...memoryStoreForTests(storePath),
  });
}

/** Boot a bare, engine-less PGlite straight from a store-backup artefact via `loadDataDir` (a restore/boot). */
async function bootFromBackup(storePath: string, backup: File | Blob): Promise<PGlite> {
  const fresh = await PGlite.create({ dataDir: resolveStoreDataDir(storePath, "memory"), loadDataDir: backup });
  freshStores.push(fresh);
  return fresh;
}

describe("ADR-0035 probe (a): ephemeral (pg_temp) bytes in a LIVE store-backup tarball", () => {
  it("does NOT spill ephemeral row data into the tarball, and the ephemeral table is absent after restore", async () => {
    client = await makeClient("probe-ephemeral-bytes");
    await client.ready;

    // The ephemeral cluster is a `pg_temp` TEMP table created at boot (ADR-0021 §3); its group is lazy but
    // an ephemeral cluster with sync disabled is present and writable from boot, so a direct insert lands a
    // real row carrying the sentinel. CHECKPOINT to give any temp-relation bytes their best chance to reach
    // the datadir the dump reads — the probe is deliberately generous to the "it might spill" hypothesis.
    await client.rawExec(
      `INSERT INTO secret_window (id, answer, updated_at_us) VALUES ('77777777-7777-7777-7777-777777777777', '${EPHEMERAL_SENTINEL}', 0)`,
    );
    await client.rawExec("CHECKPOINT");
    expect((await client.rawQuery("SELECT count(*)::int AS n FROM secret_window")).rows[0]).toEqual({ n: 1 });

    // Uncompressed backup so a raw byte scan can look for the sentinel plainly (gzip would hide it behind
    // compression, defeating the probe).
    const { file } = await client.exportStore({ compression: "none" });

    // (i) Restore/boot a fresh store from the tarball: the ephemeral table must not exist there. A TEMP
    // relation is session-scoped, so even if catalog traces survive, a fresh session cannot resolve it.
    const fresh = await bootFromBackup("probe-ephemeral-fresh", file);
    const regBare = (await fresh.query<{ r: string | null }>("SELECT to_regclass('secret_window') AS r")).rows[0]?.r;
    const regPublic = (await fresh.query<{ r: string | null }>("SELECT to_regclass('public.secret_window') AS r"))
      .rows[0]?.r;
    expect(regBare).toBeNull();
    expect(regPublic).toBeNull();

    // (ii) Scan the RAW tarball bytes for the sentinel. OBSERVED on PGlite 0.5.4 (bun): the sentinel is
    // ABSENT — ephemeral (pg_temp) ROW DATA does not reach the datadir dump, so a store backup does not leak
    // it. (The table's NAME can appear elsewhere as a bare identifier in durable metadata / a reconcile
    // function body — that is not row content and is not what this asserts.) This is the reassuring outcome
    // for a consumer using ephemeral retention to keep sensitive rows out of on-disk backups. Were this ever
    // to flip on a future PGlite, this assertion fails loudly and the finding must be re-reported to
    // consumers rather than silently accepted.
    const bytes = new Uint8Array(await file.arrayBuffer());
    // Decode byte-for-byte (latin1: every byte → one code point) so the raw tarball is searchable as text
    // without a codec dropping/merging bytes — `Buffer` avoids the DOM `TextDecoder` label typing.
    const asLatin1 = Buffer.from(bytes).toString("latin1");
    expect(asLatin1.includes(EPHEMERAL_SENTINEL)).toBe(false);
  });
});

describe("ADR-0035 probe (b): live-dump integrity under write activity", () => {
  it("produces a crash-consistent snapshot that boots clean with a coherent synced table + journal", async () => {
    client = await makeClient("probe-integrity");
    await client.ready;

    // A committed synced row (written where the read path lands server rows) — DETERMINISTICALLY present in
    // any checkpointed snapshot.
    await client.rawExec(
      "INSERT INTO todos (id, title, done, updated_at_us) VALUES ('11111111-1111-1111-1111-111111111111', 'synced', false, 1)",
    );
    // A batch of FULLY-AWAITED optimistic writes: each commits one journal + one overlay row (syncEnabled:false
    // → nothing drains them), so all ten are settled before the export and are captured whole.
    for (let i = 0; i < 10; i++) {
      await client.mutate.create("todos", { id: globalThis.crypto.randomUUID(), title: `settled-${i}`, done: false });
    }
    // A loop of IN-FLIGHT optimistic writes NOT awaited before the export — the "write activity" the dump runs
    // amid. Some or all may be absent from the crash-consistent snapshot; that is expected and fine.
    const inFlight: Promise<void>[] = [];
    for (let i = 0; i < 30; i++) {
      inFlight.push(
        client.mutate.create("todos", { id: globalThis.crypto.randomUUID(), title: `inflight-${i}`, done: false }),
      );
    }

    // Dump MID-ACTIVITY (before draining `inFlight`) — a live `dumpDataDir` through the checkpoint seam.
    const { file } = await client.exportStore({ compression: "none" });
    await Promise.allSettled(inFlight); // settle the stragglers so teardown is clean

    // Boot a fresh store from the snapshot: it must stand up clean and be internally coherent.
    const fresh = await bootFromBackup("probe-integrity-fresh", file);

    // Synced table queryable, and the committed synced row survived.
    const syncedPresent = (
      await fresh.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM todos WHERE id = '11111111-1111-1111-1111-111111111111'",
      )
    ).rows[0]?.n;
    expect(syncedPresent).toBe(1);

    // Journal + overlay queryable and MUTUALLY CONSISTENT: an optimistic create writes its journal and overlay
    // rows in ONE transaction, so a checkpointed snapshot never captures a torn half. Every overlay row has a
    // matching journal row (zero orphans), and — the ten settled writes being whole — the counts are equal and
    // at least ten.
    const overlayCount =
      (await fresh.query<{ n: number }>("SELECT count(*)::int AS n FROM todos_overlay")).rows[0]?.n ?? 0;
    const journalCount =
      (await fresh.query<{ n: number }>("SELECT count(*)::int AS n FROM todos_mutations")).rows[0]?.n ?? 0;
    const orphanOverlay = (
      await fresh.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM todos_overlay ov WHERE NOT EXISTS (SELECT 1 FROM todos_mutations mu WHERE mu.id = ov.id)",
      )
    ).rows[0]?.n;
    expect(orphanOverlay).toBe(0);
    expect(overlayCount).toBe(journalCount);
    expect(overlayCount).toBeGreaterThanOrEqual(10);

    // The read model (overlay unioned over synced) is queryable and reflects synced + optimistic rows.
    const readModelCount =
      (await fresh.query<{ n: number }>("SELECT count(*)::int AS n FROM todos_read_model")).rows[0]?.n ?? 0;
    expect(readModelCount).toBe(overlayCount + 1);
  });
});

describe("ADR-0035 probe (c): data-export clone fidelity", () => {
  it("a data export's row set equals the live store's synced-table row set at export time", async () => {
    client = await makeClient("probe-clone-fidelity");
    await client.ready;

    // Synced rows straight into the physical synced table (no read path under syncEnabled:false).
    await client.rawExec(
      "INSERT INTO todos (id, title, done, updated_at_us) VALUES " +
        "('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'alpha', false, 10), " +
        "('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'bravo', true, 20), " +
        "('cccccccc-cccc-cccc-cccc-cccccccccccc', 'charlie', false, 30)",
    );

    // The LIVE store's synced-table row set at export time. `rawQuery` is untyped (returns generic rows), so
    // cast to the same shape the fresh-store `query` returns, giving the two row sets a comparable type.
    const liveRows = (await client.rawQuery("SELECT id, title, done FROM todos ORDER BY id")).rows as Array<{
      id: string;
      title: string;
      done: boolean;
    }>;

    // The data export (its drain guard is a no-op here — a clean journal) is SQL, not a datadir tarball, so it
    // is EXECed into a plain fresh store (never `loadDataDir`) — exactly as a `psql -f` load into a vanilla
    // Postgres would apply it.
    const { file } = await client.exportData();
    const target = await PGlite.create({ dataDir: resolveStoreDataDir("probe-clone-fidelity-target", "memory") });
    freshStores.push(target);
    await target.exec(await file.text());

    const clonedRows = (
      await target.query<{ id: string; title: string; done: boolean }>(
        "SELECT id, title, done FROM public.todos ORDER BY id",
      )
    ).rows;

    // The matrix's "backup -> throwaway -> pg_dump equals the live store's synced content": exact row-set parity.
    expect(clonedRows).toEqual(liveRows);
    expect(clonedRows).toHaveLength(3);
  });
});
