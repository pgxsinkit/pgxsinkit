import { describe, expect, it } from "bun:test";

import { count } from "drizzle-orm";
import { bigint, uuid, varchar } from "drizzle-orm/pg-core";

import { getJournalTable } from "@pgxsinkit/client";
import { defineSyncRegistry, defineSyncTable } from "@pgxsinkit/contracts";

import { createMutationRuntime } from "../../packages/client/src/mutation";
import { generateLocalSchemaSql } from "../../packages/client/src/schema";
import { drizzleOver } from "../support/drizzle";
import { createSchemaTestPGlite } from "../support/pglite";

// ADR-0039 — the mutation runtime reports the DISTINCT non-blind table keys of every enqueue through
// `onOrdinaryEnqueue`, so the client can fire-and-forget activate each target's lazy consistency group.
// A blind update (write-only pattern) is never reported; a hook throw never fails the enqueue.

// `notes` is a plain optimistic readwrite; `ledger` is statically pessimistic so it can carry a blind
// write (an optimistic blind write is rejected at enqueue — see blind-update.test.ts).
const registry = defineSyncRegistry({
  notes: defineSyncTable({
    tableName: "notes",
    makeColumns: () => ({
      id: uuid("id").primaryKey(),
      body: varchar("body", { length: 200 }),
      updatedAtUs: bigint("updated_at_us", { mode: "bigint" }).notNull().default(0n),
    }),
    mode: "readwrite",
    subscription: "lazy",
    conflictPolicy: "last-write-wins",
    governance: {
      managedFields: [{ column: "updatedAtUs", applyOn: ["create", "update"], strategy: "nowMicroseconds" }],
    },
  }),
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
const schemaSql = generateLocalSchemaSql(registry);
const batchWriteUrl = "http://localhost:3001/api/mutations";
const NOTE_ID = "01963227-d4c7-72db-b858-00000000e101";
const LEDGER_ID = "01963227-d4c7-72db-b858-00000000e001";

type Db = Awaited<ReturnType<typeof createSchemaTestPGlite>>;

async function seedNote(db: Db) {
  await drizzleOver(db).insert(registry.notes.localTable).values({ id: NOTE_ID, body: "seed", updatedAtUs: 1000n });
}

async function journalCount(db: Db, table: "notes" | "ledger") {
  const journal = getJournalTable(registry, table);
  const rows = await drizzleOver(db).select({ c: count() }).from(journal);
  return rows[0]?.c ?? 0;
}

describe("ordinary-enqueue activation hook (ADR-0039)", () => {
  it("an ordinary create reports its table exactly once", async () => {
    const db = await createSchemaTestPGlite(schemaSql);
    const reported: string[][] = [];
    const runtime = createMutationRuntime({
      db,
      registry,
      batchWriteUrl,
      onOrdinaryEnqueue: (tables) => reported.push([...tables]),
    });
    try {
      await runtime.create("notes", { id: NOTE_ID, body: "x" });
      expect(reported).toEqual([["notes"]]);
    } finally {
      await db.close();
    }
  });

  it("an ordinary update and delete each report their table", async () => {
    const db = await createSchemaTestPGlite(schemaSql);
    const reported: string[][] = [];
    const runtime = createMutationRuntime({
      db,
      registry,
      batchWriteUrl,
      onOrdinaryEnqueue: (tables) => reported.push([...tables]),
    });
    try {
      await seedNote(db);
      await runtime.update("notes", { id: NOTE_ID }, { body: "y" });
      await runtime.delete("notes", { id: NOTE_ID });
      expect(reported).toEqual([["notes"], ["notes"]]);
    } finally {
      await db.close();
    }
  });

  it("a purely-blind batch reports nothing (the hook is not invoked)", async () => {
    const db = await createSchemaTestPGlite(schemaSql);
    const reported: string[][] = [];
    const runtime = createMutationRuntime({
      db,
      registry,
      batchWriteUrl,
      onOrdinaryEnqueue: (tables) => reported.push([...tables]),
    });
    try {
      await runtime.batch(
        [{ table: "ledger", kind: "update", entityKey: { id: LEDGER_ID }, patch: { note: "blind" }, blind: true }],
        { id: "u-blind", mode: "pessimistic" },
      );
      expect(reported).toEqual([]);
    } finally {
      await db.close();
    }
  });

  it("a mixed batch reports only the ordinary items' tables, never the blind one", async () => {
    const db = await createSchemaTestPGlite(schemaSql);
    const reported: string[][] = [];
    const runtime = createMutationRuntime({
      db,
      registry,
      batchWriteUrl,
      onOrdinaryEnqueue: (tables) => reported.push([...tables]),
    });
    try {
      await runtime.batch(
        [
          { table: "notes", kind: "create", input: { id: NOTE_ID, body: "n" } },
          { table: "ledger", kind: "update", entityKey: { id: LEDGER_ID }, patch: { note: "blind" }, blind: true },
        ],
        { id: "u-mixed", mode: "pessimistic" },
      );
      expect(reported).toEqual([["notes"]]);
    } finally {
      await db.close();
    }
  });

  it("a throwing hook never fails the enqueue — the write still lands", async () => {
    const db = await createSchemaTestPGlite(schemaSql);
    const runtime = createMutationRuntime({
      db,
      registry,
      batchWriteUrl,
      onOrdinaryEnqueue: () => {
        throw new Error("boom");
      },
    });
    try {
      await runtime.create("notes", { id: NOTE_ID, body: "x" });
      expect(await journalCount(db, "notes")).toBe(1);
    } finally {
      await db.close();
    }
  });
});
