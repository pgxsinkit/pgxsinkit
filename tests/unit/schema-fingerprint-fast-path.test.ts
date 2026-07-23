import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

import { bigint, boolean, uuid, varchar } from "drizzle-orm/pg-core";

import { defineSyncRegistry, defineSyncTable, type SyncTableRegistry } from "@pgxsinkit/contracts";

import { createSyncClient, type LocalStoreVersionEvent, type SyncClient } from "../../packages/client/src/index";
import { computeLocalSchemaFingerprint } from "../../packages/client/src/schema";

// The DURABLE-schema fingerprint fast path. These tests boot a REAL
// filesystem-backed PGlite client, close it (the fs store persists), then re-boot on the SAME path and assert
// the boot's `warmBoot.schemaSkipped` / `schemaFingerprintMatch` outcome plus the stamped
// `local_schema_fingerprint`. The invariant: the durable schema replays only when the stored fingerprint is
// absent/stale, and every full durable exec re-stamps the fingerprint so the NEXT boot can trust the skip.

const FP_KEY = "local_schema_fingerprint";

const todos = defineSyncTable({
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
});

const notes = defineSyncTable({
  tableName: "notes",
  makeColumns: () => ({
    id: uuid("id").primaryKey(),
    body: varchar("body", { length: 200 }).notNull(),
    updatedAtUs: bigint("updated_at_us", { mode: "bigint" }).notNull(),
  }),
  mode: "readwrite",
  conflictPolicy: "last-write-wins",
  governance: {
    managedFields: [{ column: "updatedAtUs", applyOn: ["create", "update"], strategy: "nowMicroseconds" }],
  },
});

// An EPHEMERAL cluster (ADR-0021 §3) — its whole cluster is TEMP / pg_temp, always re-applied on boot even
// when the durable schema is fingerprint-skipped.
const exam = defineSyncTable({
  tableName: "exam_answer",
  makeColumns: () => ({
    id: uuid("id").primaryKey(),
    answer: varchar("answer", { length: 200 }),
    updatedAtUs: bigint("updated_at_us", { mode: "bigint" }).notNull().default(0n),
  }),
  mode: "readwrite",
  retention: "ephemeral",
  conflictPolicy: "last-write-wins",
  governance: {
    managedFields: [{ column: "updatedAtUs", applyOn: ["create", "update"], strategy: "nowMicroseconds" }],
  },
});

const todosRegistry = defineSyncRegistry({ todos });
const widerRegistry = defineSyncRegistry({ todos, notes });
const ephemeralRegistry = defineSyncRegistry({ todos, exam });

type LooseClient = SyncClient<SyncTableRegistry>;

const DEAD_ELECTRIC = "http://127.0.0.1:1/v1/electric-proxy";
const DEAD_WRITE = "http://127.0.0.1:1/api/mutations";

const TMP_ROOT = path.resolve(process.cwd(), "tmp/agents/schema-fingerprint");

const openClients: LooseClient[] = [];
const storeDirs: string[] = [];

beforeAll(async () => {
  await mkdir(TMP_ROOT, { recursive: true });
});

afterEach(async () => {
  for (const client of openClients.splice(0)) await client.stop().catch(() => undefined);
  for (const dir of storeDirs.splice(0)) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

async function freshStorePath(label: string): Promise<string> {
  const dir = path.join(TMP_ROOT, `${label}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  storeDirs.push(dir);
  await mkdir(dir, { recursive: true });
  return path.join(dir, "store");
}

interface BootHooks {
  prepareLocalDbBeforeSchema?: () => Promise<void>;
  prepareLocalDbAfterSchema?: () => Promise<void>;
  onSchemaChange?: (event: LocalStoreVersionEvent) => void;
}

async function bootFsClient(
  registry: SyncTableRegistry,
  storePath: string,
  hooks: BootHooks = {},
): Promise<LooseClient> {
  const client = (await createSyncClient({
    registry,
    electricUrl: DEAD_ELECTRIC,
    batchWriteUrl: DEAD_WRITE,
    syncEnabled: false,
    storePath,
    ...hooks,
  })) as LooseClient;
  openClients.push(client);
  await client.ready;
  return client;
}

async function readFingerprint(client: LooseClient): Promise<string | null> {
  const result = await client.rawQuery("SELECT value FROM pgxsinkit_local_meta WHERE key = $1", [FP_KEY]);
  return (result.rows[0] as { value: string } | undefined)?.value ?? null;
}

async function stopClient(client: LooseClient): Promise<void> {
  const index = openClients.indexOf(client);
  if (index >= 0) openClients.splice(index, 1);
  await client.stop();
}

const ID_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const ID_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

describe("durable-schema fingerprint fast path (slice 3)", () => {
  it("1. matching fingerprint skips the durable replay, and the warm store still reads + writes", async () => {
    const storePath = await freshStorePath("match");

    // Boot A — fresh store: durable replay runs (no stored fingerprint), the fingerprint is stamped, and an
    // optimistic write is enqueued so the warm store has real rows to prove out.
    const bootA = await bootFsClient(todosRegistry, storePath);
    const reportA = (await bootA.bootReport())!;
    expect(reportA.warmBoot.schemaSkipped).toBe(false);
    expect(reportA.warmBoot.schemaFingerprintMatch).toBe(false);
    expect(await readFingerprint(bootA)).toBe(computeLocalSchemaFingerprint(todosRegistry));
    await bootA.mutate.create("todos", { id: ID_A, title: "persisted", done: false });
    await stopClient(bootA);

    // Boot B — warm store, matching fingerprint: the durable replay is SKIPPED.
    const bootB = await bootFsClient(todosRegistry, storePath);
    const reportB = (await bootB.bootReport())!;
    expect(reportB.warmBoot.schemaSkipped).toBe(true);
    expect(reportB.warmBoot.schemaFingerprintMatch).toBe(true);

    // Everything still works: the read model returns the persisted optimistic row, and a fresh write lands.
    const readModel = await bootB.rawQuery("SELECT count(*)::int AS n FROM todos_read_model");
    expect((readModel.rows[0] as { n: number }).n).toBe(1);
    await bootB.mutate.create("todos", { id: ID_B, title: "warm-write", done: true });
    const journal = await bootB.rawQuery("SELECT count(*)::int AS n FROM todos_mutations");
    expect((journal.rows[0] as { n: number }).n).toBeGreaterThanOrEqual(2);
  });

  it("2. registry change → fingerprint mismatch → evolution runs and restamps → third boot skips again", async () => {
    const storePath = await freshStorePath("evolve");

    const bootA = await bootFsClient(todosRegistry, storePath);
    await stopClient(bootA);

    // Boot B — WIDER registry (adds the `notes` cluster) on the same store: the durable fingerprint no longer
    // matches, so the durable schema replays and the new fingerprint is stamped (the ADR-0006 read-cache
    // reconcile also rebuilds since nothing is owed).
    const bootB = await bootFsClient(widerRegistry, storePath);
    const reportB = (await bootB.bootReport())!;
    expect(reportB.warmBoot.schemaSkipped).toBe(false);
    expect(reportB.warmBoot.schemaFingerprintMatch).toBe(false);
    expect(await readFingerprint(bootB)).toBe(computeLocalSchemaFingerprint(widerRegistry));
    // The added table is real: a write to it lands.
    await bootB.mutate.create("notes", { id: ID_A, body: "new-table" });
    await stopClient(bootB);

    // Boot C — same wider registry: the stamped fingerprint now matches, so the durable replay is skipped.
    const bootC = await bootFsClient(widerRegistry, storePath);
    const reportC = (await bootC.bootReport())!;
    expect(reportC.warmBoot.schemaSkipped).toBe(true);
    expect(reportC.warmBoot.schemaFingerprintMatch).toBe(true);
  });

  it("3. a stale stored fingerprint (simulated generator change) forces a full durable replay + restamp", async () => {
    const storePath = await freshStorePath("stale");

    const bootA = await bootFsClient(todosRegistry, storePath);
    // Simulate a generator/codegen change WITHOUT changing the registry: overwrite the stored fingerprint with
    // a value that cannot match the freshly-generated durable SQL's hash.
    await bootA.rawExec(`UPDATE pgxsinkit_local_meta SET value = 'lsf1:staaaaaaaaaaale' WHERE key = '${FP_KEY}';`);
    await stopClient(bootA);

    const bootB = await bootFsClient(todosRegistry, storePath);
    const reportB = (await bootB.bootReport())!;
    expect(reportB.warmBoot.schemaSkipped).toBe(false);
    expect(reportB.warmBoot.schemaFingerprintMatch).toBe(false);
    // The full durable replay restamped the correct fingerprint, so the NEXT boot would skip again.
    expect(await readFingerprint(bootB)).toBe(computeLocalSchemaFingerprint(todosRegistry));
  });

  it("4. ephemeral relations exist after a skipped warm boot (durable skipped, ephemeral always applied)", async () => {
    const storePath = await freshStorePath("ephemeral");

    const bootA = await bootFsClient(ephemeralRegistry, storePath);
    await stopClient(bootA);

    const bootB = await bootFsClient(ephemeralRegistry, storePath);
    const reportB = (await bootB.bootReport())!;
    // Durable replay skipped, yet the ephemeral (TEMP / pg_temp) cluster was recreated by the always-applied
    // ephemeral schema — its read-model view exists and is queryable on this fresh engine.
    expect(reportB.warmBoot.schemaSkipped).toBe(true);
    expect(reportB.warmBoot.schemaFingerprintMatch).toBe(true);
    const examView = await bootB.rawQuery("SELECT count(*)::int AS n FROM exam_answer_read_model");
    expect((examView.rows[0] as { n: number }).n).toBe(0);
  });

  it("5. both prepare hooks run on a skipped warm boot (the fast path gates only the durable exec)", async () => {
    const storePath = await freshStorePath("hooks");

    let beforeSchema = 0;
    let localDb = 0;
    const hooks: BootHooks = {
      prepareLocalDbBeforeSchema: async () => {
        beforeSchema += 1;
      },
      prepareLocalDbAfterSchema: async () => {
        localDb += 1;
      },
    };

    const bootA = await bootFsClient(todosRegistry, storePath, hooks);
    expect(beforeSchema).toBe(1);
    expect(localDb).toBe(1);
    await stopClient(bootA);

    const bootB = await bootFsClient(todosRegistry, storePath, hooks);
    const reportB = (await bootB.bootReport())!;
    expect(reportB.warmBoot.schemaSkipped).toBe(true);
    // Hooks are per-boot regardless of the fast path — both ran again on the skipped boot.
    expect(beforeSchema).toBe(2);
    expect(localDb).toBe(2);
  });

  it("7. the reconcile rebuild path stamps the new durable fingerprint", async () => {
    const storePath = await freshStorePath("rebuild");

    const bootA = await bootFsClient(todosRegistry, storePath);
    await stopClient(bootA);

    // Boot B — wider registry, nothing owed → the ADR-0006 reconcile REBUILDS the read cache. Capture the
    // schema-change event and assert the meta now carries the wider registry's durable fingerprint.
    let event: LocalStoreVersionEvent | null = null;
    const bootB = await bootFsClient(widerRegistry, storePath, {
      onSchemaChange: (e) => {
        event = e;
      },
    });
    expect(event).not.toBeNull();
    expect(event!.status).toBe("rebuilt");
    expect(await readFingerprint(bootB)).toBe(computeLocalSchemaFingerprint(widerRegistry));
  });
});
