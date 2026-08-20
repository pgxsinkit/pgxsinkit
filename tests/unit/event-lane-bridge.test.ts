import { afterEach, describe, expect, it } from "bun:test";

import { PGlite } from "@electric-sql/pglite";
import { dataDir as prepopulatedDataDir } from "@electric-sql/pglite-prepopulatedfs";
import { live } from "@electric-sql/pglite/live";
import { bigint, boolean, uuid, varchar } from "drizzle-orm/pg-core";
import { z } from "zod";

import { defineEventStream, defineSyncRegistry, defineSyncTable } from "@pgxsinkit/contracts";

import {
  attachSyncClient,
  type ClientPGlite,
  defineSyncWorker,
  type EventLaneReport,
  type OutboxStatus,
  type SyncWorkerHost,
} from "../../packages/client/src/index";
import { testStoreAcknowledgment } from "../../packages/client/src/testing";

// The Event lane across the worker bridge (ADR-0053 decision 2): ONE Outbox in the worker, appended over a
// single RPC round trip, and both observation surfaces re-exposed tab-side. Driven over a bun
// `MessageChannel` with a REAL in-process engine behind `defineSyncWorker` — no actual Worker, exactly the
// protocol-tier arrangement `worker-bridge.test.ts` uses.

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
      payload: z.object({ issueId: z.uuid() }).strict(),
      identity: { viewerId: { claimPath: ["sub"] } },
    }),
  },
});
type Registry = typeof registry;

const ISSUE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

let hosts: SyncWorkerHost<Registry>[] = [];
let channels: MessageChannel[] = [];

async function makeHost(): Promise<SyncWorkerHost<Registry>> {
  const pg = await PGlite.create({ loadDataDir: await prepopulatedDataDir(), extensions: { live } });
  const host = defineSyncWorker<Registry>({
    registry,
    controlPlaneUrl: "http://127.0.0.1:1",
    streamBaseUrl: "http://127.0.0.1:1/v1/stream",
    batchWriteUrl: "http://127.0.0.1:1/api/mutations",
    ...testStoreAcknowledgment(),
    precreatedPglite: Promise.resolve(pg as unknown as ClientPGlite),
    syncEnabled: false,
    installGlobal: false,
    convergenceIntervalMs: 10_000_000,
    // The Event lane's fallback interval is separate from convergence's; park it too so only the explicit
    // `flushEvents` (and the append nudge) drive a pass during a test.
    events: { intervalMs: 10_000_000 },
  });
  hosts.push(host);
  return host;
}

async function attach(host: SyncWorkerHost<Registry>) {
  const channel = new MessageChannel();
  channels.push(channel);
  host.connect(channel.port1 as unknown as never);
  channel.port2.start?.();
  const client = await attachSyncClient<Registry>({
    registry,
    port: channel.port2 as unknown as never,
    getToken: async () => ({ accessToken: "t", expiresAt: Date.now() + 3_600_000 }),
  });
  // An append nudges the worker's flush driver, which posts to the DEAD write URL these tests use and
  // enters backoff — a real report. Subscribe a sink so the no-subscriber warn (correct, but noise here)
  // stays out of the suite's output; the tests that assert on reports add their own listener alongside.
  client.onEventLaneReport(() => undefined);
  return client;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

afterEach(async () => {
  for (const host of hosts) await host.close().catch(() => undefined);
  for (const channel of channels) {
    channel.port1.close();
    channel.port2.close();
  }
  hosts = [];
  channels = [];
});

describe("appendEvent over the bridge (ADR-0053 decision 2)", () => {
  it("stages into the WORKER's Outbox in one round trip, stamps included", async () => {
    const host = await makeHost();
    const client = await attach(host);
    await client.ready;

    const result = await client.appendEvent("board_issue_viewed", { issueId: ISSUE });
    expect(result.eventId).toMatch(/^[0-9a-f-]{36}$/);

    // The row lives in the worker's store — the tab has no Outbox of its own, exactly as it has no journal.
    const worker = await host.whenBooted();
    const rows = await worker.rawQuery("SELECT event_id, stream FROM pgxsinkit_outbox");
    expect(rows.rows).toEqual([{ event_id: result.eventId, stream: "board_issue_viewed" }]);
  });

  it("rejects with the SAME typed refusals as the in-process client (name-tagged across the bridge)", async () => {
    const host = await makeHost();
    const client = await attach(host);
    await client.ready;

    const unknownStream = await client
      .appendEvent("board_issue_hovered", { issueId: ISSUE })
      .catch((error: unknown) => error);
    expect(String(unknownStream)).toContain("unknown Event stream");
    const invalidPayload = await client
      .appendEvent("board_issue_viewed", { issueId: "nope" })
      .catch((error: unknown) => error);
    expect(String(invalidPayload)).toContain("failed its registered schema");
    const worker = await host.whenBooted();
    expect((await worker.rawQuery("SELECT 1 FROM pgxsinkit_outbox")).rows).toHaveLength(0);
  });
});

describe("the observation surfaces over the bridge (ADR-0053 decision 2)", () => {
  it("fans the drain signal out to EVERY attached tab, and serves a late subscriber from the pull", async () => {
    const host = await makeHost();
    const tabA = await attach(host);
    const tabB = await attach(host);
    await tabA.ready;
    await tabB.ready;

    const seenA: OutboxStatus[] = [];
    const seenB: OutboxStatus[] = [];
    tabA.onOutboxStatus((status) => seenA.push(status));
    tabB.onOutboxStatus((status) => seenB.push(status));
    await tick();
    // Current state on subscribe, on both tabs — the engine has one Outbox and it is empty.
    expect(seenA.at(-1)).toEqual({ empty: true });
    expect(seenB.at(-1)).toEqual({ empty: true });

    // One tab's append is the OTHER tab's transition: the Outbox is engine-wide.
    await tabA.appendEvent("board_issue_viewed", { issueId: ISSUE });
    await tick();
    expect(seenA.at(-1)).toEqual({ empty: false });
    expect(seenB.at(-1)).toEqual({ empty: false });

    // A tab subscribing AFTER the last transition has no broadcast to fold — it pulls the current state.
    const late: OutboxStatus[] = [];
    tabB.onOutboxStatus((status) => late.push(status));
    await tick();
    expect(late).toEqual([{ empty: false }]);
  });

  it("delivers the flush report to subscribed tabs", async () => {
    const host = await makeHost();
    const client = await attach(host);
    await client.ready;

    const reports: EventLaneReport[] = [];
    client.onEventLaneReport((report) => reports.push(report));

    // The mock goes up BEFORE the append: an append nudges the worker's flush driver, so the very next pass
    // may be the driver's rather than the explicit one below — either is a real pass and must report.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: unknown, init?: { body?: unknown }) => {
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
        events: { eventId: string }[];
      };
      return new Response(
        JSON.stringify({
          acks: body.events.map((event) => ({ eventId: event.eventId, status: "refused", reason: "gated" })),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;
    try {
      await client.appendEvent("board_issue_viewed", { issueId: ISSUE });
      await client.flushEvents();
      await tick();
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(reports.flatMap((report) => report.terminal)).toEqual([
      { eventId: expect.any(String), stream: "board_issue_viewed", status: "refused", reason: "gated" },
    ]);
    // Terminal, so the row is gone and the lane drained.
    expect(await client.outboxStatus()).toEqual({ empty: true });
  });

  it("reports the Outbox on `diagnostics`, which is what the attached destroy refuses on", async () => {
    const host = await makeHost();
    const client = await attach(host);
    await client.ready;

    expect((await client.diagnostics()).outbox).toEqual({ empty: true });
    await client.appendEvent("board_issue_viewed", { issueId: ISSUE });
    // The attached `destroy()` refuses on exactly this field, riding the SAME diagnostics round trip it
    // already takes for the owed-mutations check (the destroy sequence itself — peer verdict, teardown
    // handshake, destruction effects — is exercised in `destroy-supervision.test.ts`).
    expect((await client.diagnostics()).outbox).toEqual({ empty: false });
  });
});
