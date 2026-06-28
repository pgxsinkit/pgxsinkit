import { describe, expect, it, mock } from "bun:test";

import { sql } from "drizzle-orm";
import { bigint, uuid, varchar } from "drizzle-orm/pg-core";

import { defineSyncRegistry, defineSyncTable } from "@pgxsinkit/contracts";
import { projectsSyncRegistry } from "@pgxsinkit/schema";

import { createMutationRuntime, type MutationDetail } from "../../packages/client/src/mutation";
import { generateLocalSchemaSql } from "../../packages/client/src/schema";
import { createFreshTestPGlite } from "../support/pglite";

// ADR-0022 C2/D — the client routing of a pessimistic write-unit to the authoritative endpoint, and the
// three per-mutation dispositions: `acked` (converges normally), `conflicted` (overlay KEPT, ADR-0015),
// and `rejected` (overlay AUTO-DISCARDED + surfaced via onReject, ADR-0022 §4).

const schemaSql = generateLocalSchemaSql(projectsSyncRegistry);
const writeUrl = "http://localhost:3001";
const PROJECT_ID = "01963227-d4c7-72db-b858-00000000c001";
const SYNCED_VERSION = "1000";
const ACKED_VERSION = "2000";

async function seededRuntime(onReject?: (rejected: MutationDetail[]) => void) {
  const db = await createFreshTestPGlite();
  await db.exec(schemaSql);
  await db.query(
    `INSERT INTO projects (id, name, created_at_us, updated_at_us) VALUES ($1, 'seed', $2::bigint, $2::bigint)`,
    [PROJECT_ID, SYNCED_VERSION],
  );
  return {
    db,
    runtime: createMutationRuntime({ db, registry: projectsSyncRegistry, writeUrl, ...(onReject ? { onReject } : {}) }),
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

async function readJournalRow(db: Awaited<ReturnType<typeof createFreshTestPGlite>>) {
  const result = await db.query<{
    status: string;
    writeUnit: string | null;
    writeMode: string | null;
    serverVersion: string | null;
    conflictReason: string | null;
  }>(
    `SELECT status, write_unit AS "writeUnit", write_mode AS "writeMode", server_updated_at_us::text AS "serverVersion",
            conflict_reason AS "conflictReason"
     FROM projects_mutations ORDER BY mutation_seq ASC LIMIT 1`,
  );
  return result.rows[0];
}

async function overlayCount(db: Awaited<ReturnType<typeof createFreshTestPGlite>>) {
  const result = await db.query<{ c: number }>(`SELECT count(*)::int AS c FROM projects_overlay WHERE id = $1`, [
    PROJECT_ID,
  ]);
  return result.rows[0]?.c;
}

describe("pessimistic write-unit flush (ADR-0022 C2/D)", () => {
  it("routes the unit to the authoritative /mutations/unit endpoint and acks it", async () => {
    const { db, runtime } = await seededRuntime();
    const fetchMock = unitFetch("acked");
    try {
      await enqueuePessimisticUpdate(runtime, "u-acked", "pessimistic");
      const result = await withFetch(fetchMock, () => runtime.flushUnit("u-acked"));

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const call = fetchMock.mock.calls[0]!;
      expect(String(call[0])).toBe("http://localhost:3001/mutations/unit");
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
      updatedAtUs: bigint("updated_at_us", { mode: "bigint" })
        .notNull()
        .default(sql`0`),
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

describe("statically-pessimistic table foreground-routes its plain writes (ADR-0022 §2)", () => {
  it("create() on a static-pessimistic table posts the write to the authoritative endpoint", async () => {
    const db = await createFreshTestPGlite();
    await db.exec(seatsSchemaSql);
    const runtime = createMutationRuntime({ db, registry: seatsRegistry, writeUrl });
    const fetchMock = unitFetch("acked");
    const SEAT_ID = "01963227-d4c7-72db-b858-00000000d001";
    try {
      // A plain create — NOT inside a transaction block — must still reach the server.
      await withFetch(fetchMock, () => runtime.create("seats", { id: SEAT_ID, label: "A1" }));

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(String(fetchMock.mock.calls[0]![0])).toBe("http://localhost:3001/mutations/unit");

      const row = await db.query<{ status: string; writeMode: string | null }>(
        `SELECT status, write_mode AS "writeMode" FROM seats_mutations WHERE id = $1`,
        [SEAT_ID],
      );
      expect(row.rows[0]?.status).toBe("acked");
      expect(row.rows[0]?.writeMode).toBe("pessimistic");
    } finally {
      await db.close();
    }
  });

  it("a rejected static-pessimistic create auto-discards its overlay (no stuck optimistic state)", async () => {
    const db = await createFreshTestPGlite();
    await db.exec(seatsSchemaSql);
    const runtime = createMutationRuntime({ db, registry: seatsRegistry, writeUrl });
    const fetchMock = unitFetch("rejected");
    const SEAT_ID = "01963227-d4c7-72db-b858-00000000d002";
    try {
      await withFetch(fetchMock, () => runtime.create("seats", { id: SEAT_ID, label: "B2" }));

      const journal = await db.query<{ status: string }>(`SELECT status FROM seats_mutations WHERE id = $1`, [SEAT_ID]);
      expect(journal.rows[0]?.status).toBe("rejected");
      const overlay = await db.query<{ c: number }>(`SELECT count(*)::int AS c FROM seats_overlay WHERE id = $1`, [
        SEAT_ID,
      ]);
      expect(overlay.rows[0]?.c).toBe(0); // overlay auto-discarded — the optimistic row is gone
    } finally {
      await db.close();
    }
  });
});
