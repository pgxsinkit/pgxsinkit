import { afterEach, describe, expect, it } from "bun:test";
// Store backup (ADR-0035) on the in-process client: a LIVE `dumpDataDir` (CHECKPOINT → dump), no engine
// suspension. Uses a REAL in-memory PGlite with `syncEnabled: false` (no network) and a readwrite table so
// a staged-but-unflushed write can be observed travelling inside the artefact via the report's diagnostics.

import { bigint, boolean, uuid, varchar } from "drizzle-orm/pg-core";

import { defineSyncRegistry, defineSyncTable } from "@pgxsinkit/contracts";

import { createSyncClient, LifecycleBusyError, type SyncClient } from "../../packages/client/src/index";
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

let client: SyncClient<TodosRegistry> | undefined;

afterEach(async () => {
  await client?.stop();
  client = undefined;
});

async function makeClient(storePath: string): Promise<SyncClient<TodosRegistry>> {
  const active = await createSyncClient({
    registry: todosRegistry,
    electricUrl: "http://127.0.0.1:1/v1/electric-proxy",
    batchWriteUrl: "http://127.0.0.1:1/api/mutations",
    syncEnabled: false,
    ...memoryStoreForTests(storePath),
  });
  return active;
}

/** Read the first two bytes of a File — a gzip member begins `0x1f 0x8b`. */
async function magicBytes(file: File): Promise<[number, number]> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  return [bytes[0]!, bytes[1]!];
}

describe("exportStore live store backup (ADR-0035)", () => {
  it("returns a gzip File with the default name shape and a well-formed report", async () => {
    client = await makeClient("export-store-default");
    await client.ready;

    const { file, report } = await client.exportStore();

    // Default `"auto"` compression gzips where a CompressionStream exists (it does in bun) → gzip magic bytes.
    expect(await magicBytes(file)).toEqual([0x1f, 0x8b]);
    // Default name: `<storeId>-<timestamp>.pgdata.tar.gz`, storeId derived from the store path's last segment.
    expect(file.name).toMatch(/^export-store-default-.+\.pgdata\.tar\.gz$/);
    expect(file.type).toBe("application/x-gzip");
    expect(file.size).toBeGreaterThan(0);

    // A well-formed report: versioned, the right kind/scope, all phases present, byte length matches the file.
    expect(report.reportVersion).toBe(1);
    expect(report.kind).toBe("store-backup");
    expect(report.scope).toBe("whole-store");
    expect(report.compression).toBe("gzip");
    expect(report.byteLength).toBe(file.size);
    expect(typeof report.startedAt).toBe("number");
    expect(report.totalMs).toBeGreaterThanOrEqual(0);
    expect(report.phases.checkpointMs).toBeGreaterThanOrEqual(0);
    expect(report.phases.dumpMs).toBeGreaterThanOrEqual(0);
    expect(report.phases.dumpStartedAtMs).toBeGreaterThanOrEqual(report.phases.checkpointStartedAtMs);
    // The diagnostics snapshot travels in the report (a clean store here → nothing owed).
    expect(report.diagnostics.pendingCount).toBe(0);
  });

  it("honours `compression: none` and an explicit fileName", async () => {
    client = await makeClient("export-store-plain");
    await client.ready;

    const { file, report } = await client.exportStore({ compression: "none", fileName: "custom-backup.tar" });
    expect(file.name).toBe("custom-backup.tar");
    expect(file.type).toBe("application/x-tar");
    expect(report.compression).toBe("none");
    // An uncompressed tar is NOT gzip — the first bytes are the tar header, never `0x1f 0x8b`.
    expect(await magicBytes(file)).not.toEqual([0x1f, 0x8b]);
  });

  it("does NOT block on unflushed mutations — the staged write rides inside the backup", async () => {
    client = await makeClient("export-store-dirty");
    await client.ready;

    // Stage a write WITHOUT flushing (syncEnabled:false → nothing drains it) — it sits in the journal/overlay.
    await client.mutate.create("todos", {
      id: "11111111-1111-1111-1111-111111111111",
      title: "unflushed",
      done: false,
    });
    expect((await client.diagnostics()).mutation.pendingCount).toBe(1);

    // The lossless backup succeeds regardless, and its report shows the unflushed write it captured.
    const { file, report } = await client.exportStore();
    expect(file.size).toBeGreaterThan(0);
    expect(report.diagnostics.pendingCount).toBe(1);
  });

  it("rejects a concurrent export with the typed busy error (single lifecycle slot)", async () => {
    client = await makeClient("export-store-busy");
    await client.ready;

    // Two exports raced: the first claims the slot, the second is refused immediately (no queueing).
    const [a, b] = await Promise.allSettled([client.exportStore(), client.exportStore()]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual(["fulfilled", "rejected"]);
    const rejected = (a.status === "rejected" ? a : b.status === "rejected" ? b : null) as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(LifecycleBusyError);
    expect((rejected.reason as LifecycleBusyError).runningLabel).toBe("exportStore");
  });

  it("waits out the boot rather than rejecting when called before ready", async () => {
    // Call exportStore WITHOUT first awaiting `client.ready` — it must await engine-ready internally and
    // resolve once booted, not reject during boot (ADR-0035 decision 4).
    client = await makeClient("export-store-preready");
    const { file, report } = await client.exportStore();
    expect(file.size).toBeGreaterThan(0);
    expect(report.kind).toBe("store-backup");
  });
});
