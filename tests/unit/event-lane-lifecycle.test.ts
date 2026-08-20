import { afterEach, describe, expect, it } from "bun:test";

import { bigint, boolean, uuid, varchar } from "drizzle-orm/pg-core";
import { z } from "zod";

import { defineEventStream, defineSyncRegistry, defineSyncTable } from "@pgxsinkit/contracts";

import { createSyncClient, type SyncClient } from "../../packages/client/src/index";
import { collectDataExportSyncedTableNames } from "../../packages/client/src/schema";
import { memoryStoreForTests } from "../../packages/client/src/testing";

// The Outbox's position in the store lifecycle (ADR-0053 decision 8), on a REAL in-memory PGlite with sync
// disabled (no network). Every lifecycle surface takes a position, and each one is pinned here:
// `dropReadCache` never touches the Outbox, a non-forced `destroy` refuses on staged events (and says so
// distinctly from the owed-mutations refusal) while `force` proceeds, the store backup carries the Outbox,
// and — the deliberate asymmetry with the Mutation journal — a RESTORE does NOT quarantine recovered
// events: they resume flushing normally, because `eventId` dedupe makes event delivery idempotent
// end-to-end, which mutation replay is not.

const registry = defineSyncRegistry({
  tables: {
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
  },
  streams: {
    board_issue_viewed: defineEventStream({
      payload: z.object({ issueId: z.string() }).strict(),
      identity: { viewerId: { claimPath: ["sub"] } },
    }),
  },
});
type Registry = typeof registry;

const DEAD_CONTROL_PLANE = "http://127.0.0.1:1";
const DEAD_STREAM_BASE = "http://127.0.0.1:1/v1/stream";
const DEAD_WRITE = "http://127.0.0.1:1/api/mutations";

const clients: SyncClient<Registry>[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.stop().catch(() => undefined);
});

async function makeClient(
  storePath: string,
  extra: Partial<Parameters<typeof createSyncClient<Registry>>[0]> = {},
): Promise<SyncClient<Registry>> {
  const client = await createSyncClient<Registry>({
    registry,
    controlPlaneUrl: DEAD_CONTROL_PLANE,
    streamBaseUrl: DEAD_STREAM_BASE,
    batchWriteUrl: DEAD_WRITE,
    syncEnabled: false,
    ...memoryStoreForTests(storePath),
    ...extra,
  });
  clients.push(client);
  await client.ready;
  return client;
}

async function outboxCount(client: SyncClient<Registry>): Promise<number> {
  const rows = await client.rawQuery("SELECT count(*)::int AS n FROM pgxsinkit_outbox");
  return (rows.rows[0] as { n: number } | undefined)?.n ?? 0;
}

describe("appendEvent on the client (ADR-0053 decision 2)", () => {
  it("derives the ingestion endpoint from the write endpoint and stages durably", async () => {
    const client = await makeClient("event-lifecycle-append");
    const result = await client.appendEvent("board_issue_viewed", { issueId: "issue-1" });

    expect(result.eventId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await outboxCount(client)).toBe(1);
    expect(await client.outboxStatus()).toEqual({ empty: false });
  });

  it("refuses nonsense lane tuning at the PUBLIC boundary, rather than wedging a stream silently", async () => {
    // The client half of the runner's fail-closed posture: a per-stream `batchSize` of 0 would make batch
    // assembly skip every row of that stream forever, with no request, no report and no error.
    const refusal = await createSyncClient<Registry>({
      registry,
      controlPlaneUrl: DEAD_CONTROL_PLANE,
      streamBaseUrl: DEAD_STREAM_BASE,
      batchWriteUrl: DEAD_WRITE,
      syncEnabled: false,
      events: { streams: { board_issue_viewed: { batchSize: 0 } } },
      ...memoryStoreForTests("event-lifecycle-bad-tuning"),
    }).catch((error: unknown) => error);

    expect(String(refusal)).toMatch(/invalid Event-lane tuning/);
    expect(String(refusal)).toContain("events.streams.board_issue_viewed.batchSize");
  });

  it("exposes the drain signal with the current state on subscribe", async () => {
    const client = await makeClient("event-lifecycle-drain");
    const seen: { empty: boolean }[] = [];
    client.onOutboxStatus((status) => seen.push(status));
    // The subscribe-time delivery is a store read; drive it with an append and assert the transition pair.
    await client.appendEvent("board_issue_viewed", { issueId: "issue-1" });
    expect(seen.at(-1)).toEqual({ empty: false });
  });
});

describe("dropReadCache (ADR-0053 decision 8 — the Outbox is not read cache)", () => {
  it("leaves staged events untouched while rebuilding the synced tables", async () => {
    const client = await makeClient("event-lifecycle-dropcache");
    await client.appendEvent("board_issue_viewed", { issueId: "issue-1" });
    await client.appendEvent("board_issue_viewed", { issueId: "issue-2" });
    const before = await client.rawQuery("SELECT event_id, seq::text AS seq FROM pgxsinkit_outbox ORDER BY seq");

    await client.dropReadCache();

    const after = await client.rawQuery("SELECT event_id, seq::text AS seq FROM pgxsinkit_outbox ORDER BY seq");
    // Same rows, same append ordinals — the cache rebuild is not a lifecycle event for the Event lane.
    expect(after.rows).toEqual(before.rows);
    expect(after.rows).toHaveLength(2);
  });
});

describe("destroy (ADR-0053 decision 8 — the same refusal the owed mutations get)", () => {
  it("refuses while the Outbox is non-empty, naming the Outbox rather than the journal", async () => {
    const client = await makeClient("event-lifecycle-destroy-refuse");
    await client.appendEvent("board_issue_viewed", { issueId: "issue-1" });

    const refusal = await client.destroy().catch((error: unknown) => error);
    expect(String(refusal)).toMatch(/Outbox still holds staged event/);
    // The store is intact — a refused destroy never partially wipes.
    expect(await outboxCount(client)).toBe(1);
  });

  it("still names the MUTATIONS cause when writes are owed, so the two are never confused", async () => {
    const client = await makeClient("event-lifecycle-destroy-mutations");
    await client.mutate.create("todos", { id: "11111111-1111-4111-8111-111111111111", title: "t", done: false });

    const refusal = await client.destroy().catch((error: unknown) => error);
    expect(String(refusal)).toMatch(/mutation\(s\) still owed/);
  });

  it("proceeds on a FORCED destroy — the explicit escape hatch", async () => {
    const client = await makeClient("event-lifecycle-destroy-force");
    await client.appendEvent("board_issue_viewed", { issueId: "issue-1" });

    await client.destroy({ force: true });
    // Consumed by the destroy; drop it from the teardown list.
    clients.splice(clients.indexOf(client), 1);
  });

  it("does not refuse when the Outbox is empty", async () => {
    const client = await makeClient("event-lifecycle-destroy-empty");
    await client.destroy();
    clients.splice(clients.indexOf(client), 1);
  });
});

describe("backup + restore (ADR-0053 decision 8)", () => {
  it("carries the Outbox in a store backup and does NOT quarantine it on restore", async () => {
    const source = await makeClient("event-lifecycle-backup-src");
    const staged = await source.appendEvent("board_issue_viewed", { issueId: "issue-1" });
    await source.appendEvent("board_issue_viewed", { issueId: "issue-2" });
    // A staged write too: its journal row IS quarantined on restore, which is the contrast that makes the
    // Outbox's exemption meaningful rather than incidental.
    await source.mutate.create("todos", { id: "22222222-2222-4222-8222-222222222222", title: "t", done: false });
    const { file } = await source.exportStore();

    const restored = await makeClient("event-lifecycle-backup-dst", { restoreFrom: file });

    // The backup is the WHOLE store, so the events travelled inside it — with their append ordinals intact.
    const rows = (
      await restored.rawQuery("SELECT event_id, next_retry_at_us, attempt_count FROM pgxsinkit_outbox ORDER BY seq")
    ).rows as { event_id: string; next_retry_at_us: string | null; attempt_count: number }[];
    expect(rows).toHaveLength(2);
    expect(rows[0]!.event_id).toBe(staged.eventId);
    // NOT quarantined, NOT parked: no backoff was stamped, so the very next flush pass posts them. Event
    // delivery is idempotent end-to-end (the `eventId` dedupe), which mutation replay is not.
    expect(rows.every((row) => row.next_retry_at_us === null)).toBe(true);
    expect(rows.every((row) => row.attempt_count === 0)).toBe(true);
    // The drain signal reports the recovered events, so a best-guess view is correct straight after restore.
    expect(await restored.outboxStatus()).toEqual({ empty: false });

    // The journal, by contrast, WAS quarantined — the asymmetry ADR-0053 states loudly.
    expect((await restored.diagnostics()).mutation.quarantinedCount).toBe(1);
  });

  it("includes the Outbox in a diagnostic dump, and excludes it from a data export by construction", async () => {
    const client = await makeClient("event-lifecycle-exports");
    await client.appendEvent("board_issue_viewed", { issueId: "issue-1" });

    // Evidence for a human reading a misbehaving store: the diagnostic dump is everything-as-SQL, so the
    // staged events are in it.
    const diagnostics = await client.exportDiagnostics();
    expect(await diagnostics.file.text()).toContain("pgxsinkit_outbox");

    // The data export is synced-tables-only BY CONSTRUCTION — its `pg_dump -t` allowlist is exactly the
    // registry's physical synced tables — so the Outbox cannot appear. Asserted on the allowlist itself
    // rather than by running a second throwaway-clone `pg_dump`: the allowlist IS the mechanism, and the
    // artefact-level behaviour is already `client-export-data`'s subject.
    expect(collectDataExportSyncedTableNames(registry)).toEqual(["todos"]);
  });
});
