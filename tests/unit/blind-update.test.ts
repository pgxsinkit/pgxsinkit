import { describe, expect, it, mock } from "bun:test";

import { count, eq } from "drizzle-orm";
import { bigint, uuid, varchar } from "drizzle-orm/pg-core";

import { getJournalTable, getOverlayTable } from "@pgxsinkit/client";
import { defineSyncRegistry, defineSyncTable } from "@pgxsinkit/contracts";
import { projectsSyncRegistry } from "@pgxsinkit/schema";

import { createMutationRuntime, type MutationDetail } from "../../packages/client/src/mutation";
import { generateLocalSchemaSql } from "../../packages/client/src/schema";
import { drizzleOver } from "../support/drizzle";
import { createSchemaTestPGlite } from "../support/pglite";

// ADR-0022 addendum — a BLIND pessimistic update: an update-by-key whose target is EXCLUDED from the actor's
// read shape (its rows never stream here). It plans a journal row ONLY (no overlay, no local base-row check),
// routes to the authoritative endpoint, and — because nothing local ever converges for it — retires from the
// journal after ack WITHOUT a synced echo. The replacement for the seed-a-phantom-row workaround whose acked
// row + overlay lingered forever behind the echo barrier.

// A `lazy` never-activated readwrite entry: its local journal/overlay/synced tables are still provisioned
// (DDL is emitted for every registered writable entry; `subscription` only gates Electric streaming), so a
// blind write flushes + acks + retires cleanly with the group never activated — the write-only pattern.
const ledgerRegistry = defineSyncRegistry({
  ledger: defineSyncTable({
    tableName: "ledger",
    makeColumns: () => ({
      id: uuid("id").primaryKey(),
      note: varchar("note", { length: 200 }),
      updatedAtUs: bigint("updated_at_us", { mode: "bigint" }).notNull().default(0n),
    }),
    mode: "readwrite",
    writeMode: "pessimistic",
    subscription: "lazy",
    conflictPolicy: "last-write-wins",
    governance: {
      managedFields: [{ column: "updatedAtUs", applyOn: ["create", "update"], strategy: "nowMicroseconds" }],
    },
  }),
});
const ledgerSchemaSql = generateLocalSchemaSql(ledgerRegistry);
const LEDGER_ID = "01963227-d4c7-72db-b858-00000000e001";

const projectsSchemaSql = generateLocalSchemaSql(projectsSyncRegistry);
const batchWriteUrl = "http://localhost:3001/api/mutations";
const PROJECT_ID = "01963227-d4c7-72db-b858-00000000f001";
const ACKED_VERSION = "2000";

/** A fetch stub for the authoritative endpoint that acks (or conflicts/rejects) every unit member. */
function unitFetch(ackStatus: "acked" | "conflicted" | "rejected") {
  return mock(async (_input: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
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
      ...(ackStatus === "rejected" ? { rejectionReason: "not permitted", httpStatus: 403 } : {}),
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

type Db = Awaited<ReturnType<typeof createSchemaTestPGlite>>;

async function journalCount(db: Db, registry: typeof ledgerRegistry | typeof projectsSyncRegistry, table: string) {
  const journal = getJournalTable(registry as never, table as never);
  const rows = await drizzleOver(db).select({ c: count() }).from(journal);
  return rows[0]?.c ?? 0;
}

async function overlayCount(
  db: Db,
  registry: typeof ledgerRegistry | typeof projectsSyncRegistry,
  table: string,
  id: string,
) {
  const overlay = getOverlayTable(registry as never, table as never);
  const rows = await drizzleOver(db).select({ c: count() }).from(overlay).where(eq(overlay["id"]!, id));
  return rows[0]?.c ?? 0;
}

async function journalStatus(db: Db, registry: typeof ledgerRegistry | typeof projectsSyncRegistry, table: string) {
  const journal = getJournalTable(registry as never, table as never);
  const rows = await drizzleOver(db)
    .select({ status: journal.status, writeMode: journal.writeMode, writeUnit: journal.writeUnit })
    .from(journal)
    .limit(1);
  return rows[0];
}

describe("blind pessimistic update (ADR-0022 addendum)", () => {
  it("flushes an entity absent from the read model, acks, writes NO overlay, and retires with no echo", async () => {
    const db = await createSchemaTestPGlite(ledgerSchemaSql);
    const runtime = createMutationRuntime({ db, registry: ledgerRegistry, batchWriteUrl });
    const fetchMock = unitFetch("acked");
    try {
      // LEDGER_ID is NOT seeded and the lazy group is never activated: no local base row exists.
      await runtime.batch(
        [{ table: "ledger", kind: "update", entityKey: { id: LEDGER_ID }, patch: { note: "blind-1" }, blind: true }],
        { id: "u-blind-acked", mode: "pessimistic" },
      );

      // (a) no overlay was ever planned.
      expect(await overlayCount(db, ledgerRegistry, "ledger", LEDGER_ID)).toBe(0);
      // The pending row carries the persistent marker + its unit.
      const pending = await journalStatus(db, ledgerRegistry, "ledger");
      expect(pending?.status).toBe("pending");
      expect(pending?.writeMode).toBe("pessimistic-blind");
      expect(pending?.writeUnit).toBe("u-blind-acked");

      const result = await withFetch(fetchMock, () => runtime.flushUnit("u-blind-acked"));
      expect(result.acks[0]?.status).toBe("acked");
      expect(String(fetchMock.mock.calls[0]![0])).toBe("http://localhost:3001/api/mutations/unit");

      // (b) after reconcile (run inside flushUnit) the journal is EMPTY — the acked blind row retired with no
      // synced echo — and still no overlay ever existed.
      expect(await journalCount(db, ledgerRegistry, "ledger")).toBe(0);
      expect(await overlayCount(db, ledgerRegistry, "ledger", LEDGER_ID)).toBe(0);

      // (c) a subsequent blind update on the same entity is accepted (nothing blocks behind a retired row).
      await runtime.batch(
        [{ table: "ledger", kind: "update", entityKey: { id: LEDGER_ID }, patch: { note: "blind-2" }, blind: true }],
        { id: "u-blind-acked-2", mode: "pessimistic" },
      );
      expect(await journalCount(db, ledgerRegistry, "ledger")).toBe(1);
    } finally {
      await db.close();
    }
  });

  it("throws at enqueue for an optimistic-routed blind write (nothing enqueued)", async () => {
    const db = await createSchemaTestPGlite(projectsSchemaSql);
    const runtime = createMutationRuntime({ db, registry: projectsSyncRegistry, batchWriteUrl });
    try {
      // oxlint-disable-next-line typescript/await-thenable -- bun-types gap: .rejects matchers return a real promise typed as void
      await expect(
        runtime.batch(
          [{ table: "projects", kind: "update", entityKey: { id: PROJECT_ID }, patch: { name: "x" }, blind: true }],
          { id: "u-opt", mode: "optimistic" },
        ),
      ).rejects.toThrow(/pessimistic/);
      // Nothing was enqueued (the whole batch transaction rolled back).
      expect(await journalCount(db, projectsSyncRegistry, "projects")).toBe(0);
    } finally {
      await db.close();
    }
  });

  it("does NOT weaken the presence check: a plain (non-blind) update on an absent entity still throws", async () => {
    const db = await createSchemaTestPGlite(projectsSchemaSql);
    const runtime = createMutationRuntime({ db, registry: projectsSyncRegistry, batchWriteUrl });
    try {
      // oxlint-disable-next-line typescript/await-thenable -- bun-types gap: .rejects matchers return a real promise typed as void
      await expect(
        runtime.batch([{ table: "projects", kind: "update", entityKey: { id: PROJECT_ID }, patch: { name: "x" } }], {
          id: "u-plain",
          mode: "pessimistic",
        }),
      ).rejects.toThrow(/not found in local read model/);
    } finally {
      await db.close();
    }
  });

  it("the optimistic background flusher does NOT pick up a pending pessimistic-blind row", async () => {
    const db = await createSchemaTestPGlite(ledgerSchemaSql);
    const runtime = createMutationRuntime({ db, registry: ledgerRegistry, batchWriteUrl });
    const fetchMock = unitFetch("acked");
    try {
      await runtime.batch(
        [{ table: "ledger", kind: "update", entityKey: { id: LEDGER_ID }, patch: { note: "skip" }, blind: true }],
        { id: "u-skip", mode: "pessimistic" },
      );
      await withFetch(fetchMock, () => runtime.flush());
      expect(fetchMock).not.toHaveBeenCalled(); // owned by the authoritative path only
      expect((await journalStatus(db, ledgerRegistry, "ledger"))?.status).toBe("pending");
    } finally {
      await db.close();
    }
  });

  it("rejected blind: journal row kept as rejected, onReject fires, no overlay side-effects", async () => {
    const rejected: MutationDetail[] = [];
    const db = await createSchemaTestPGlite(ledgerSchemaSql);
    const runtime = createMutationRuntime({
      db,
      registry: ledgerRegistry,
      batchWriteUrl,
      onReject: (details) => {
        rejected.push(...details);
      },
    });
    const fetchMock = unitFetch("rejected");
    try {
      await runtime.batch(
        [{ table: "ledger", kind: "update", entityKey: { id: LEDGER_ID }, patch: { note: "nope" }, blind: true }],
        { id: "u-rej", mode: "pessimistic" },
      );
      await withFetch(fetchMock, () => runtime.flushUnit("u-rej"));

      const row = await journalStatus(db, ledgerRegistry, "ledger");
      expect(row?.status).toBe("rejected"); // kept for diagnostics
      expect(await overlayCount(db, ledgerRegistry, "ledger", LEDGER_ID)).toBe(0); // never had an overlay
      expect(rejected).toHaveLength(1);
      expect(rejected[0]?.status).toBe("rejected");
    } finally {
      await db.close();
    }
  });

  it("statically-pessimistic table: a blind update in a pessimistic unit flushes + acks + retires", async () => {
    const db = await createSchemaTestPGlite(ledgerSchemaSql); // ledger is statically writeMode: "pessimistic"
    const runtime = createMutationRuntime({ db, registry: ledgerRegistry, batchWriteUrl });
    const fetchMock = unitFetch("acked");
    try {
      await runtime.batch(
        [{ table: "ledger", kind: "update", entityKey: { id: LEDGER_ID }, patch: { note: "static" }, blind: true }],
        { id: "u-static", mode: "pessimistic" },
      );
      const result = await withFetch(fetchMock, () => runtime.flushUnit("u-static"));
      expect(result.acks[0]?.status).toBe("acked");
      expect(await journalCount(db, ledgerRegistry, "ledger")).toBe(0);
    } finally {
      await db.close();
    }
  });
});
