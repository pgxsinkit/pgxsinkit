import { describe, expect, it, mock } from "bun:test";

import { asc, count, eq, sql } from "drizzle-orm";
import { bigint, uuid, varchar } from "drizzle-orm/pg-core";

import { getJournalTable, getOverlayTable, getReadModelView } from "@pgxsinkit/client";
import { defineSyncRegistry, defineSyncTable } from "@pgxsinkit/contracts";
import { projectsSyncRegistry } from "@pgxsinkit/schema";

import { createMutationRuntime, type MutationDb, type MutationDetail } from "../../packages/client/src/mutation";
import { generateLocalSchemaSql } from "../../packages/client/src/schema";
import { drizzleOver } from "../support/drizzle";
import { createSchemaTestPgwasm } from "../support/pgwasm-store";

// ADR-0022 C2/D — the client routing of a pessimistic write-unit to the authoritative endpoint, and the
// three per-mutation dispositions: `acked` (converges normally), `conflicted` (overlay KEPT, ADR-0015),
// and `rejected` (overlay AUTO-DISCARDED + surfaced via onReject, ADR-0022 §4).

const schemaSql = generateLocalSchemaSql(projectsSyncRegistry);
const batchWriteUrl = "http://localhost:3001/api/mutations";
const PROJECT_ID = "01963227-d4c7-72db-b858-00000000c001";
const SYNCED_VERSION = "1000";
const ACKED_VERSION = "2000";

async function seededRuntime(onReject?: (rejected: MutationDetail[]) => void, runtimeBatchWriteUrl = batchWriteUrl) {
  const db = await createSchemaTestPgwasm(schemaSql);
  await drizzleOver(db)
    .insert(projectsSyncRegistry.projects.localTable)
    .values({
      id: PROJECT_ID,
      name: "seed",
      createdAtUs: BigInt(SYNCED_VERSION),
      updatedAtUs: BigInt(SYNCED_VERSION),
    });
  return {
    db,
    runtime: createMutationRuntime({
      db,
      registry: projectsSyncRegistry,
      batchWriteUrl: runtimeBatchWriteUrl,
      ...(onReject ? { onReject } : {}),
    }),
  };
}

/** A fetch stub for the authoritative endpoint that acks every member of the unit with `ackStatus`. */
function unitFetch(ackStatus: "acked" | "conflicted" | "rejected") {
  return mock(async (_input: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
      writeUnit?: string;
      mutations: Array<{
        mutationId: string;
        tableName: string;
        mutationSeq: number;
        entityKey: Record<string, string>;
      }>;
    };
    const acks = body.mutations.map((m) => ({
      tableName: m.tableName,
      entityKey: m.entityKey,
      mutationId: m.mutationId,
      mutationSeq: m.mutationSeq,
      status: ackStatus,
      ...(ackStatus === "acked" ? { serverUpdatedAtUs: ACKED_VERSION } : {}),
      ...(ackStatus === "conflicted"
        ? { serverUpdatedAtUs: ACKED_VERSION, conflictReason: "Stale write rejected (reject-if-stale)" }
        : {}),
      ...(ackStatus === "rejected" ? { rejectionReason: "full: no remaining seats", httpStatus: 409 } : {}),
    }));
    return new Response(JSON.stringify({ acks }), { status: 200, headers: { "Content-Type": "application/json" } });
  });
}

async function withFetch<T>(fetchMock: unknown, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = fetchMock as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

type RuntimeOf = Awaited<ReturnType<typeof seededRuntime>>["runtime"];
async function enqueuePessimisticUpdate(runtime: RuntimeOf, unitId: string, name: string) {
  await runtime.batch([{ table: "projects", kind: "update", entityKey: { id: PROJECT_ID }, patch: { name } }], {
    id: unitId,
    mode: "pessimistic",
  });
}

async function readJournalRow(db: Awaited<ReturnType<typeof createSchemaTestPgwasm>>) {
  const journal = getJournalTable(projectsSyncRegistry, "projects");
  const rows = await drizzleOver(db)
    .select({
      status: journal.status,
      writeUnit: journal.writeUnit,
      writeMode: journal.writeMode,
      serverVersion: sql<string>`${journal.serverUpdatedAtUs}::text`.as("serverVersion"),
      conflictReason: journal.conflictReason,
    })
    .from(journal)
    .orderBy(asc(journal.mutationSeq))
    .limit(1);
  return rows[0];
}

async function overlayCount(db: Awaited<ReturnType<typeof createSchemaTestPgwasm>>) {
  const overlay = getOverlayTable(projectsSyncRegistry, "projects");
  const rows = await drizzleOver(db).select({ c: count() }).from(overlay).where(eq(overlay["id"]!, PROJECT_ID));
  return rows[0]?.c;
}

async function visibleProjectName(db: Awaited<ReturnType<typeof createSchemaTestPgwasm>>) {
  const view = getReadModelView(projectsSyncRegistry, "projects");
  const [row] = await drizzleOver(db).select({ name: view.name }).from(view).where(eq(view.id, PROJECT_ID));
  return row?.name;
}

describe("pessimistic write-unit flush (ADR-0022 C2/D)", () => {
  it("a definitive HTTP 400 rolls back a foreground patch before another status change can use it", async () => {
    const rejected: MutationDetail[] = [];
    const { db, runtime } = await seededRuntime((details) => rejected.push(...details));
    try {
      await enqueuePessimisticUpdate(runtime, "u-invalid", "completed");
      await withFetch(
        async () =>
          new Response(JSON.stringify({ error: "Invalid authoritative write-unit payload" }), { status: 400 }),
        async () => expect(runtime.flushUnit("u-invalid")).rejects.toThrow("Invalid authoritative"),
      );
      expect(await visibleProjectName(db)).toBe("seed");
      expect((await readJournalRow(db))?.status).toBe("rejected");
      expect(rejected).toHaveLength(1);
      await enqueuePessimisticUpdate(runtime, "u-archive", "archived");
      await withFetch(unitFetch("rejected"), () => runtime.flushUnit("u-archive"));
      expect(await visibleProjectName(db)).toBe("seed");
    } finally {
      await db.close();
    }
  });

  it("a rejected patch restores an earlier unconfirmed edit on the same entity", async () => {
    const { db, runtime } = await seededRuntime();
    try {
      await enqueuePessimisticUpdate(runtime, "u-offline", "completed");
      await withFetch(
        async () => new Response("Temporarily unavailable", { status: 503 }),
        async () => expect(runtime.flushUnit("u-offline")).rejects.toThrow("Temporarily unavailable"),
      );
      await enqueuePessimisticUpdate(runtime, "u-rejected", "archived");
      await withFetch(unitFetch("rejected"), () => runtime.flushUnit("u-rejected"));
      expect(await visibleProjectName(db)).toBe("completed");
    } finally {
      await db.close();
    }
  });

  it("rejection keeps later independent fields without retaining the refused field", async () => {
    const { db, runtime } = await seededRuntime();
    try {
      await enqueuePessimisticUpdate(runtime, "u-declined", "archived");
      const scheduledAt = new Date("2026-11-23T00:00:00Z");
      await runtime.batch(
        [{ table: "projects", kind: "update", entityKey: { id: PROJECT_ID }, patch: { scheduledAt } }],
        { id: "u-later", mode: "pessimistic" },
      );
      await withFetch(unitFetch("rejected"), () => runtime.flushUnit("u-declined"));
      const view = getReadModelView(projectsSyncRegistry, "projects");
      const [row] = await drizzleOver(db).select().from(view).where(eq(view.id, PROJECT_ID));
      expect(row?.name).toBe("seed");
      expect(new Date(row!.scheduledAt!).toISOString()).toBe(scheduledAt.toISOString());
      expect(await overlayCount(db)).toBe(1);
    } finally {
      await db.close();
    }
  });

  it("rejection preserves a pending create's materialized local values", async () => {
    const { db, runtime } = await seededRuntime();
    const id = "01963227-d4c7-72db-b858-00000000c002";
    try {
      await runtime.batch([{ table: "projects", kind: "create", input: { id, name: "original" } }], {
        id: "u-create",
        mode: "pessimistic",
      });
      const view = getReadModelView(projectsSyncRegistry, "projects");
      const [before] = await drizzleOver(db).select().from(view).where(eq(view.id, id));
      await runtime.batch([{ table: "projects", kind: "update", entityKey: { id }, patch: { name: "refused" } }], {
        id: "u-create-edit",
        mode: "pessimistic",
      });
      await withFetch(unitFetch("rejected"), () => runtime.flushUnit("u-create-edit"));
      const [after] = await drizzleOver(db).select().from(view).where(eq(view.id, id));
      expect(after?.name).toBe("original");
      expect(after?.createdAtUs).toBe(before?.createdAtUs);
      expect(after?.updatedAtUs).toBe(before?.updatedAtUs);
    } finally {
      await db.close();
    }
  });

  it("a failed rollback cannot commit a terminal rejection with the refused overlay", async () => {
    const { db, runtime } = await seededRuntime();
    let failRead = false;
    const crashingDb: MutationDb = {
      exec: (statement) => db.exec(statement),
      query: (statement, params) => {
        if (failRead && statement.startsWith("SELECT")) {
          failRead = false;
          throw new Error("Interrupted rejection rollback");
        }
        return db.query(statement, params);
      },
    };
    const crashing = createMutationRuntime({ db: crashingDb, registry: projectsSyncRegistry, batchWriteUrl });
    try {
      await enqueuePessimisticUpdate(runtime, "u-crash", "refused");
      const decline = unitFetch("rejected");
      await withFetch(
        async (...args: Parameters<typeof fetch>) => {
          const result = await decline(...args);
          failRead = true;
          return result;
        },
        async () => expect(crashing.flushUnit("u-crash")).rejects.toThrow("Interrupted rejection rollback"),
      );
      expect((await readJournalRow(db))?.status).toBe("sending");
      const restarted = createMutationRuntime({ db, registry: projectsSyncRegistry, batchWriteUrl });
      await restarted.runBootRecovery({ ownsMetaTable: true, restore: false });
      await withFetch(unitFetch("rejected"), () => restarted.flushUnit("u-crash"));
      expect((await readJournalRow(db))?.status).toBe("rejected");
      expect(await visibleProjectName(db)).toBe("seed");
    } finally {
      await db.close();
    }
  });

  it("explicit retry repairs an older persisted HTTP 400 and rejected successor without a request", async () => {
    const { db, runtime } = await seededRuntime();
    const fetchMock = unitFetch("acked");
    try {
      await enqueuePessimisticUpdate(runtime, "u-legacy", "completed");
      const journal = getJournalTable(projectsSyncRegistry, "projects");
      await drizzleOver(db)
        .update(journal)
        .set({
          status: "failed",
          lastHttpStatus: 400,
          lastError: "Invalid authoritative write-unit payload",
          attemptCount: 1,
        })
        .where(eq(journal.writeUnit, "u-legacy"));
      await enqueuePessimisticUpdate(runtime, "u-declined", "archived");
      await withFetch(unitFetch("rejected"), () => runtime.flushUnit("u-declined"));
      // Reproduce the complete stored state from the older client, including its stale full overlay.
      const overlay = getOverlayTable(projectsSyncRegistry, "projects");
      await drizzleOver(db).update(overlay).set({ name: "archived" }).where(eq(overlay.id, PROJECT_ID));
      const reopened = createMutationRuntime({ db, registry: projectsSyncRegistry, batchWriteUrl });
      await withFetch(fetchMock, () => reopened.retryFailed("projects"));
      expect(fetchMock).not.toHaveBeenCalled();
      expect(await visibleProjectName(db)).toBe("seed");
      expect((await readJournalRow(db))?.status).toBe("rejected");
      expect(await overlayCount(db)).toBe(0);
    } finally {
      await db.close();
    }
  });

  for (const status of [401, 403, 408, 425, 429, 500, 503]) {
    it(`HTTP ${status} keeps the unconfirmed edit retryable`, async () => {
      const { db, runtime } = await seededRuntime();
      try {
        await enqueuePessimisticUpdate(runtime, "u-transient", "pending");
        await withFetch(
          async () => new Response("Retry later", { status }),
          async () => expect(runtime.flushUnit("u-transient")).rejects.toThrow("Retry later"),
        );
        expect(await visibleProjectName(db)).toBe("pending");
        expect((await readJournalRow(db))?.status).toBe("failed");
      } finally {
        await db.close();
      }
    });
  }

  it("rejects a non-canonical batchWriteUrl when the runtime is constructed", async () => {
    const db = await createSchemaTestPgwasm(schemaSql);
    try {
      for (const invalidUrl of [
        "http://localhost:3001/mutations",
        "/functions/v1/board-write/api/mutations",
        "//localhost/api/mutations",
      ]) {
        expect(() => createMutationRuntime({ db, registry: projectsSyncRegistry, batchWriteUrl: invalidUrl })).toThrow(
          'batchWriteUrl must be "/api/mutations"',
        );
      }
    } finally {
      await db.close();
    }
  });

  it("preserves an absolute deployment prefix before the canonical endpoint", async () => {
    const { db, runtime } = await seededRuntime(
      undefined,
      "https://example.supabase.co/functions/v1/board-write/api/mutations",
    );
    const fetchMock = unitFetch("acked");
    try {
      await enqueuePessimisticUpdate(runtime, "u-prefixed", "prefixed endpoint");
      await withFetch(fetchMock, () => runtime.flushUnit("u-prefixed"));
      expect(String(fetchMock.mock.calls[0]![0])).toBe(
        "https://example.supabase.co/functions/v1/board-write/api/mutations/unit",
      );
    } finally {
      await db.close();
    }
  });

  it("routes the unit to the authoritative /api/mutations/unit endpoint and acks it", async () => {
    const { db, runtime } = await seededRuntime();
    const fetchMock = unitFetch("acked");
    try {
      await enqueuePessimisticUpdate(runtime, "u-acked", "pessimistic");
      const result = await withFetch(fetchMock, () => runtime.flushUnit("u-acked"));

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const call = fetchMock.mock.calls[0]!;
      expect(String(call[0])).toBe("http://localhost:3001/api/mutations/unit");
      const sent = JSON.parse((call[1] as { body: string }).body) as { writeUnit: string; mutations: unknown[] };
      expect(sent.writeUnit).toBe("u-acked");
      expect(sent.mutations).toHaveLength(1);

      const row = await readJournalRow(db);
      expect(row?.status).toBe("acked");
      expect(row?.writeMode).toBe("pessimistic");
      expect(row?.serverVersion).toBe(ACKED_VERSION);
      expect(result.acks[0]?.status).toBe("acked");
    } finally {
      await db.close();
    }
  });

  it("rejected: marks the unit rejected, auto-discards the overlay, and surfaces it via onReject", async () => {
    const rejected: MutationDetail[] = [];
    const { db, runtime } = await seededRuntime((details) => rejected.push(...details));
    const fetchMock = unitFetch("rejected");
    try {
      await enqueuePessimisticUpdate(runtime, "u-rej", "one too many");
      expect(await overlayCount(db)).toBe(1); // the optimistic overlay is in place before the flush

      await withFetch(fetchMock, () => runtime.flushUnit("u-rej"));

      const row = await readJournalRow(db);
      expect(row?.status).toBe("rejected");
      expect(row?.conflictReason).toContain("full");
      expect(await overlayCount(db)).toBe(0); // ADR-0022 §4: overlay auto-discarded
      expect(rejected).toHaveLength(1);
      expect(rejected[0]?.status).toBe("rejected");
    } finally {
      await db.close();
    }
  });

  it("conflicted: marks the unit conflicted and KEEPS the overlay (ADR-0015 disposition)", async () => {
    const { db, runtime } = await seededRuntime();
    const fetchMock = unitFetch("conflicted");
    try {
      await enqueuePessimisticUpdate(runtime, "u-conf", "stale edit");
      await withFetch(fetchMock, () => runtime.flushUnit("u-conf"));

      const row = await readJournalRow(db);
      expect(row?.status).toBe("conflicted");
      expect(await overlayCount(db)).toBe(1); // overlay kept for re-resolution
    } finally {
      await db.close();
    }
  });

  it("the optimistic background batch skips pessimistic-tagged rows (they only go via flushUnit)", async () => {
    const { db, runtime } = await seededRuntime();
    const fetchMock = unitFetch("acked");
    try {
      await enqueuePessimisticUpdate(runtime, "u-skip", "pess");
      // A normal flush() must NOT send the pessimistic row to the batch endpoint.
      await withFetch(fetchMock, () => runtime.flush());
      expect(fetchMock).not.toHaveBeenCalled();

      const row = await readJournalRow(db);
      expect(row?.status).toBe("pending"); // still pending — owned by the authoritative path
    } finally {
      await db.close();
    }
  });
});

// A statically-`pessimistic` table: a plain `client.tables.x.create(...)` must STILL be server-authoritative,
// i.e. it foreground-routes to the authoritative endpoint. Regression guard for the review's High finding —
// before the fix such a write was tagged pessimistic but no path flushed it (the optimistic batch skips it),
// so it sat pending forever with an optimistic overlay and no server answer.
const seatsRegistry = defineSyncRegistry({
  seats: defineSyncTable({
    tableName: "seats",
    makeColumns: () => ({
      id: uuid("id").primaryKey(),
      label: varchar("label", { length: 80 }),
      updatedAtUs: bigint("updated_at_us", { mode: "bigint" }).notNull().default(0n),
    }),
    mode: "readwrite",
    writeMode: "pessimistic",
    conflictPolicy: "last-write-wins",
    governance: {
      managedFields: [{ column: "updatedAtUs", applyOn: ["create", "update"], strategy: "nowMicroseconds" }],
    },
  }),
});
const seatsSchemaSql = generateLocalSchemaSql(seatsRegistry);

it("retrying one table settles every member of a persisted refused unit without resending unrelated work", async () => {
  const registry = defineSyncRegistry({ ...projectsSyncRegistry, ...seatsRegistry });
  const db = await createSchemaTestPgwasm(generateLocalSchemaSql(registry));
  const project = registry.projects.localTable;
  const seat = registry.seats.localTable;
  await drizzleOver(db)
    .insert(project)
    .values({ id: PROJECT_ID, name: "seed", createdAtUs: 1000n, updatedAtUs: 1000n });
  await drizzleOver(db).insert(seat).values({ id: PROJECT_ID, label: "original", updatedAtUs: 1000n });
  const runtime = createMutationRuntime({ db, registry, batchWriteUrl });
  const fetchMock = unitFetch("acked");
  try {
    await runtime.batch(
      [
        { table: "projects", kind: "update", entityKey: { id: PROJECT_ID }, patch: { name: "declined" } },
        { table: "seats", kind: "update", entityKey: { id: PROJECT_ID }, patch: { label: "declined" } },
      ],
      { id: "u-mixed", mode: "pessimistic" },
    );
    for (const table of ["projects", "seats"] as const) {
      const journal = getJournalTable(registry, table);
      await drizzleOver(db)
        .update(journal)
        .set({ status: "failed", lastHttpStatus: 400, lastError: "Invalid envelope", attemptCount: 1 })
        .where(eq(journal.writeUnit, "u-mixed"));
    }
    await runtime.batch(
      [{ table: "seats", kind: "update", entityKey: { id: PROJECT_ID }, patch: { label: "unconfirmed" } }],
      { id: "u-unrelated", mode: "pessimistic" },
    );
    const seatsJournal = getJournalTable(registry, "seats");
    await drizzleOver(db)
      .update(seatsJournal)
      .set({ status: "failed", lastHttpStatus: 503, attemptCount: 1 })
      .where(eq(seatsJournal.writeUnit, "u-unrelated"));
    await withFetch(fetchMock, () => runtime.retryFailed("projects"));
    expect(fetchMock).not.toHaveBeenCalled();
    const projectsView = getReadModelView(registry, "projects");
    const seatsView = getReadModelView(registry, "seats");
    expect((await drizzleOver(db).select().from(projectsView))[0]?.name).toBe("seed");
    expect((await drizzleOver(db).select().from(seatsView))[0]?.label).toBe("unconfirmed");
    const rows = await drizzleOver(db)
      .select({ unit: seatsJournal.writeUnit, status: seatsJournal.status })
      .from(seatsJournal)
      .orderBy(asc(seatsJournal.mutationSeq));
    expect(rows).toEqual([
      { unit: "u-mixed", status: "rejected" },
      { unit: "u-unrelated", status: "failed" },
    ]);
  } finally {
    await db.close();
  }
});

describe("statically-pessimistic table foreground-routes its plain writes (ADR-0022 §2)", () => {
  it("create() on a static-pessimistic table posts the write to the authoritative endpoint", async () => {
    const db = await createSchemaTestPgwasm(seatsSchemaSql);
    const runtime = createMutationRuntime({ db, registry: seatsRegistry, batchWriteUrl });
    const fetchMock = unitFetch("acked");
    const SEAT_ID = "01963227-d4c7-72db-b858-00000000d001";
    try {
      // A plain create — NOT inside a transaction block — must still reach the server.
      await withFetch(fetchMock, () => runtime.create("seats", { id: SEAT_ID, label: "A1" }));

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(String(fetchMock.mock.calls[0]![0])).toBe("http://localhost:3001/api/mutations/unit");

      const seatsJournal = getJournalTable(seatsRegistry, "seats");
      const row = await drizzleOver(db)
        .select({ status: seatsJournal.status, writeMode: seatsJournal.writeMode })
        .from(seatsJournal)
        .where(eq(seatsJournal["id"]!, SEAT_ID));
      expect(row[0]?.status).toBe("acked");
      expect(row[0]?.writeMode).toBe("pessimistic");
    } finally {
      await db.close();
    }
  });

  it("a rejected static-pessimistic create auto-discards its overlay (no stuck optimistic state)", async () => {
    const db = await createSchemaTestPgwasm(seatsSchemaSql);
    const runtime = createMutationRuntime({ db, registry: seatsRegistry, batchWriteUrl });
    const fetchMock = unitFetch("rejected");
    const SEAT_ID = "01963227-d4c7-72db-b858-00000000d002";
    try {
      await withFetch(fetchMock, () => runtime.create("seats", { id: SEAT_ID, label: "B2" }));

      const seatsJournal = getJournalTable(seatsRegistry, "seats");
      const journal = await drizzleOver(db)
        .select({ status: seatsJournal.status })
        .from(seatsJournal)
        .where(eq(seatsJournal["id"]!, SEAT_ID));
      expect(journal[0]?.status).toBe("rejected");
      const seatsOverlay = getOverlayTable(seatsRegistry, "seats");
      const overlay = await drizzleOver(db)
        .select({ c: count() })
        .from(seatsOverlay)
        .where(eq(seatsOverlay["id"]!, SEAT_ID));
      expect(overlay[0]?.c).toBe(0); // overlay auto-discarded — the optimistic row is gone
    } finally {
      await db.close();
    }
  });
});
