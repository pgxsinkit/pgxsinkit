import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import type { PGlite } from "@electric-sql/pglite";
import { asc } from "drizzle-orm";
import { jsonb, text, uuid } from "drizzle-orm/pg-core";

import { defineSyncRegistry, defineSyncTable, type StreamEnvelope } from "@pgxsinkit/contracts";

import { envelopeToChange } from "../../packages/client/src/circuits/envelope-to-change";
import { resolveApplyTarget } from "../../packages/client/src/local-tables";
import {
  applyMessagesToTableWithCopy,
  applyMessagesToTableWithJson,
  applyMessageToTable,
  applyUpsertsToTable,
} from "../../packages/client/src/sync/apply";
import { createTablesFromSchema, drizzleOver } from "../support/drizzle";
import { createFreshTestPGlite } from "../support/pglite";

// THE WIRE CARRIES A JSON COLUMN AS TEXT. The engine's cell model is five scalars and its Postgres type
// map routes everything that is not int/float/bool through `Text`, so a `jsonb` cell arrives as a JSON
// STRING holding Postgres's own output rendering (`t.col::text` on backfill, `test_decoding`'s text
// live) — note the space after the colon below, which `JSON.stringify` never emits. Left as text, every
// apply tier encodes it a SECOND time and the local column ends up holding a JSON string scalar
// (`jsonb_typeof` = `'string'`) instead of the document — the defect these tests pin down. The decode
// runs once, in `envelopeToChange`, so every tier below it is fixed at the same root.
const WIRE_META = '{"lang.v1": {"levelOrdinal": 1}}';
const DECODED_META = { "lang.v1": { levelOrdinal: 1 } };

const goalsEntry = defineSyncTable({
  tableName: "json_goals",
  makeColumns: () => ({
    id: uuid("id").primaryKey(),
    title: text("title").notNull(),
    // Three json cells that break differently: a document, an array, and a genuine JSON string scalar
    // (whose wire text is `"abc"` WITH the quotes — decoding it must yield the string, not re-encode it).
    revisionMeta: jsonb("revision_meta"),
    criteria: jsonb("criteria"),
    label: jsonb("label"),
  }),
  primaryKey: ["id"],
  mode: "readonly",
});

// A json ARRAY column. Arrays — json arrays included — are deliberately NOT decoded: they arrive as
// Postgres `array_out` text and every tier hands that straight back to `array_in`.
const tagsEntry = defineSyncTable({
  tableName: "json_tag_sets",
  makeColumns: () => ({
    id: uuid("id").primaryKey(),
    docs: jsonb("docs").array(),
  }),
  primaryKey: ["id"],
  mode: "readonly",
});

const registry = defineSyncRegistry({ goals: goalsEntry, tagSets: tagsEntry });
const goals = goalsEntry.localTable;
const tagSets = tagsEntry.localTable;

const ID_A = "11111111-1111-4111-8111-111111111111";
const ID_B = "22222222-2222-4222-8222-222222222222";
const ID_C = "33333333-3333-4333-8333-333333333333";
const ID_D = "44444444-4444-4444-8444-444444444444";

/** One upsert envelope in the WIRE's shape: every cell as the engine sends it. */
function wireUpsert(type: string, key: string, value: Record<string, string | number | boolean | null>) {
  return { type, key, value, headers: { operation: "upsert" } } as StreamEnvelope;
}

describe("json columns arrive as Postgres text and are decoded once, at the wire boundary", () => {
  let pg: PGlite;

  beforeAll(async () => {
    pg = await createFreshTestPGlite();
    await createTablesFromSchema(pg, { goals, tagSets });
  });

  afterAll(async () => {
    await pg.close();
  });

  it("decodes a scalar json column's wire text into a JS value, leaving every other cell alone", () => {
    const target = resolveApplyTarget(registry, "goals");
    expect(target.jsonColumns.sort()).toEqual(["criteria", "label", "revision_meta"]);

    const change = envelopeToChange(
      target,
      wireUpsert("json_goals", ID_A, {
        id: ID_A,
        title: "read a book",
        revision_meta: WIRE_META,
        criteria: "[1, 2, 3]",
        label: '"abc"',
      }),
    );

    // Keyed by DB COLUMN NAME — the re-keying to Drizzle property keys happens in the applier.
    expect(change.value).toEqual({
      id: ID_A,
      title: "read a book",
      revision_meta: DECODED_META,
      criteria: [1, 2, 3],
      // A genuine JSON string scalar decodes to the STRING — re-encoding it is what the applier does
      // next, and doing it twice is the whole defect.
      label: "abc",
    } as never);
  });

  it("passes a NULL json cell and an already-decoded value through untouched (the decode is idempotent)", () => {
    const target = resolveApplyTarget(registry, "goals");
    const change = envelopeToChange(
      target,
      wireUpsert("json_goals", ID_A, { id: ID_A, title: "t", revision_meta: null }),
    );
    expect(change.value["revision_meta"]).toBeNull();

    const alreadyDecoded = envelopeToChange(target, {
      type: "json_goals",
      key: ID_A,
      value: { id: ID_A, title: "t", revision_meta: DECODED_META } as never,
      headers: { operation: "upsert" },
    });
    expect(alreadyDecoded.value["revision_meta"]).toEqual(DECODED_META);
  });

  it("refuses a json cell that is not JSON text, naming the column", () => {
    const target = resolveApplyTarget(registry, "goals");
    expect(() =>
      envelopeToChange(target, wireUpsert("json_goals", ID_A, { id: ID_A, title: "t", revision_meta: "not json" })),
    ).toThrow(/json column "revision_meta"/);
  });

  it("stores a jsonb DOCUMENT through the json_to_recordset tier (initial load)", async () => {
    const target = resolveApplyTarget(registry, "goals");
    const messages = [
      envelopeToChange(
        target,
        wireUpsert("json_goals", ID_A, {
          id: ID_A,
          title: "recordset",
          revision_meta: WIRE_META,
          criteria: "[1, 2, 3]",
          label: '"abc"',
        }),
      ),
    ];

    await applyMessagesToTableWithJson({ pg, target, messages: messages as never, debug: false });

    const typed = await pg.query<{ meta: string; criteria: string; label: string }>(
      `select jsonb_typeof(revision_meta) as meta, jsonb_typeof(criteria) as criteria, jsonb_typeof(label) as label
       from json_goals where id = $1`,
      [ID_A],
    );
    expect(typed.rows[0]).toEqual({ meta: "object", criteria: "array", label: "string" });

    // The read a live query performs: PGlite's own decode, unmapped — an object, not a string.
    const raw = await pg.query<{ revision_meta: unknown; criteria: unknown; label: unknown }>(
      `select revision_meta, criteria, label from json_goals where id = $1`,
      [ID_A],
    );
    expect(raw.rows[0]).toEqual({ revision_meta: DECODED_META, criteria: [1, 2, 3], label: "abc" });

    const mapped = await drizzleOver(pg).select().from(goals).orderBy(asc(goals.id));
    expect(mapped[0]).toEqual({
      id: ID_A,
      title: "recordset",
      revisionMeta: DECODED_META,
      criteria: [1, 2, 3],
      label: "abc",
    } as never);
  });

  it("stores a jsonb DOCUMENT through the param-bound upsert tier (steady state)", async () => {
    const target = resolveApplyTarget(registry, "goals");
    const messages = [
      envelopeToChange(
        target,
        wireUpsert("json_goals", ID_B, {
          id: ID_B,
          title: "upsert",
          revision_meta: WIRE_META,
          criteria: null,
          label: null,
        }),
      ),
    ];

    await applyUpsertsToTable({ pg, target, messages: messages as never, debug: false });

    const typed = await pg.query<{ ty: string; value: unknown }>(
      `select jsonb_typeof(revision_meta) as ty, revision_meta as value from json_goals where id = $1`,
      [ID_B],
    );
    expect(typed.rows[0]).toEqual({ ty: "object", value: DECODED_META });
  });

  it("stores a jsonb DOCUMENT through the per-message tier", async () => {
    const target = resolveApplyTarget(registry, "goals");
    const change = envelopeToChange(
      target,
      wireUpsert("json_goals", ID_C, {
        id: ID_C,
        title: "per-message",
        revision_meta: WIRE_META,
        criteria: null,
        label: null,
      }),
    );

    await applyMessageToTable({ pg, target, message: change as never, debug: false });

    const typed = await pg.query<{ ty: string; value: unknown }>(
      `select jsonb_typeof(revision_meta) as ty, revision_meta as value from json_goals where id = $1`,
      [ID_C],
    );
    expect(typed.rows[0]).toEqual({ ty: "object", value: DECODED_META });
  });

  it("stores a jsonb DOCUMENT through the COPY tier", async () => {
    const target = resolveApplyTarget(registry, "goals");
    const messages = [
      envelopeToChange(
        target,
        wireUpsert("json_goals", ID_D, {
          id: ID_D,
          title: "copy",
          revision_meta: WIRE_META,
          criteria: null,
          label: null,
        }),
      ),
    ];

    await applyMessagesToTableWithCopy({ pg, target, messages: messages as never, debug: false });

    const typed = await pg.query<{ ty: string; value: unknown }>(
      `select jsonb_typeof(revision_meta) as ty, revision_meta as value from json_goals where id = $1`,
      [ID_D],
    );
    expect(typed.rows[0]).toEqual({ ty: "object", value: DECODED_META });
  });

  it("keeps a json ARRAY column in its array_out text and still stores real json elements", async () => {
    const target = resolveApplyTarget(registry, "tagSets");
    // No json column is decoded here: `docs` is `jsonb[]`, so its cell stays the array literal.
    expect(target.jsonColumns).toEqual([]);

    const change = envelopeToChange(
      target,
      wireUpsert("json_tag_sets", ID_A, { id: ID_A, docs: '{"{\\"a\\": 1}","{\\"b\\": 2}"}' }),
    );
    expect(change.value["docs"]).toBe('{"{\\"a\\": 1}","{\\"b\\": 2}"}');

    await applyMessagesToTableWithJson({ pg, target, messages: [change] as never, debug: false });

    const typed = await pg.query<{ first: string; docs: unknown }>(
      `select jsonb_typeof(docs[1]) as first, docs from json_tag_sets where id = $1`,
      [ID_A],
    );
    expect(typed.rows[0]?.first).toBe("object");
    expect(typed.rows[0]?.docs).toEqual([{ a: 1 }, { b: 2 }] as never);
  });
});
