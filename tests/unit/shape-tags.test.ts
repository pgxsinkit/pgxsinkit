import { afterEach, describe, expect, it } from "bun:test";

import { and, count, eq } from "drizzle-orm";
import { pgSchema, pgTable, text } from "drizzle-orm/pg-core";

import {
  addShapeRowTags,
  applyShapeMoveOut,
  applyShapeTagSync,
  buildClearShapeTagsSql,
  clearShapeTags,
  serializeRowPk,
  shapeRowTagsDdl,
  splitTagComponents,
  tagMatchesPatterns,
} from "../../packages/client/src/sync/tags";
import { createTablesFromSchema, drizzleOver } from "../support/drizzle";
import { closeOpenTestPGlites, createFreshTestPGlite } from "../support/pglite";

// Derive the upstream types from the function signatures so the tests/ scope does not need to resolve
// `@electric-sql/client` (it is hoisted under packages/client) — the same trick shape-fold.test.ts uses.
type TagSyncMessage = Parameters<typeof applyShapeTagSync>[0]["messages"][number];
type ColumnTypes = NonNullable<Parameters<typeof applyShapeMoveOut>[0]["columnTypes"]>;

// ADR-0023 — the tagged-subquery move-out reconciliation. The pure matcher + the multi-grant eviction
// correctness (a row held by two grants survives losing one) — the case the single-grant board
// integration test cannot exercise.

afterEach(closeOpenTestPGlites);

describe("tag matching (ADR-0023 pure)", () => {
  it("splits composite tags on unescaped / and keeps escaped \\/ / \\\\ literal", () => {
    expect(splitTagComponents("abc")).toEqual(["abc"]);
    expect(splitTagComponents("a/b/c")).toEqual(["a", "b", "c"]);
    // The board's real two-condition tag shapes (Electric 1.7.4 wire).
    expect(splitTagComponents("hash/1//")).toEqual(["hash", "1", "", ""]);
    expect(splitTagComponents("//hash/hash")).toEqual(["", "", "hash", "hash"]);
    expect(splitTagComponents("a\\/b/c")).toEqual(["a/b", "c"]);
  });

  it("matches a single-component tag exactly (the one-condition membership case)", () => {
    expect(tagMatchesPatterns("hash1", [{ pos: 0, value: "hash1" }])).toBe(true);
    expect(tagMatchesPatterns("hash1", [{ pos: 0, value: "hash2" }])).toBe(false);
  });

  it("withdraws a tag if the revoked grant appears at ANY enumerated position (board's 2-condition shape)", () => {
    // The grant `g` sits at different columns in the two tags a row carries; the move-out enumerates
    // both positions, and a tag is withdrawn if `g` is at any of them.
    const patterns = [
      { pos: 0, value: "g" },
      { pos: 2, value: "g" },
    ];
    expect(tagMatchesPatterns("g/1//", patterns)).toBe(true); // g at pos 0
    expect(tagMatchesPatterns("//g/g", patterns)).toBe(true); // g at pos 2
    expect(tagMatchesPatterns("x/1//", patterns)).toBe(false); // g nowhere
    expect(tagMatchesPatterns("g/1//", [])).toBe(false);
  });

  it("does not withdraw a tag for an UNRELATED grant (multi-grant survival)", () => {
    expect(
      tagMatchesPatterns("other/1//", [
        { pos: 0, value: "g" },
        { pos: 2, value: "g" },
      ]),
    ).toBe(false);
  });

  it("serialises a primary key canonically (sorted columns, bigint as string)", () => {
    expect(serializeRowPk({ b: "2", a: "1" }, ["b", "a"])).toBe('{"a":"1","b":"2"}');
    expect(serializeRowPk({ id: 7n }, ["id"])).toBe('{"id":"7"}');
  });
});

const META = "pgxsinkit";
const SHAPE_TABLE = "public.items";
const COLUMN_TYPES: ColumnTypes = [
  { name: "id", sqlType: "text", isArray: false },
  { name: "body", sqlType: "text", isArray: false },
];

// The synced fixture table (the appliers under test address it by name string).
const items = pgTable("items", {
  id: text("id").primaryKey(),
  body: text("body"),
});

// Assertion-side mirror of the engine's tag store: this deliberately duplicates the `shapeRowTagsDdl`
// DDL (packages/client/src/sync/tags.ts) so any drift in the engine's table shape fails these tests.
const shapeRowTags = pgSchema(META).table("shape_row_tags", {
  shapeTable: text("shape_table").notNull(),
  pkJson: text("pk_json").notNull(),
  tag: text("tag").notNull(),
});

function insertMessage(id: string, tags: string[]): TagSyncMessage {
  return {
    key: `"public"."items"/"${id}"`,
    value: { id, body: "x" },
    headers: { operation: "insert", tags },
  } as unknown as TagSyncMessage;
}

async function freshStore() {
  const pg = await createFreshTestPGlite();
  await pg.exec(`CREATE SCHEMA IF NOT EXISTS ${META};`);
  // The module's own DDL product is the subject under test — exec it verbatim, never re-author it.
  await pg.exec(shapeRowTagsDdl(META));
  await createTablesFromSchema(pg, { items });
  return pg;
}

async function tagCount(pg: Awaited<ReturnType<typeof freshStore>>, id: string) {
  const rows = await drizzleOver(pg)
    .select({ c: count() })
    .from(shapeRowTags)
    .where(and(eq(shapeRowTags.shapeTable, SHAPE_TABLE), eq(shapeRowTags.pkJson, serializeRowPk({ id }, ["id"]))));
  return rows[0]?.c ?? 0;
}
async function itemCount(pg: Awaited<ReturnType<typeof freshStore>>, id: string) {
  const rows = await drizzleOver(pg).select({ c: count() }).from(items).where(eq(items.id, id));
  return rows[0]?.c ?? 0;
}

describe("move-out eviction (ADR-0023, PGlite)", () => {
  it("persists a row's tag-set from its tagged insert", async () => {
    const pg = await freshStore();
    await drizzleOver(pg).insert(items).values({ id: "row1", body: "x" });
    await applyShapeTagSync({
      pg,
      metadataSchema: META,
      shapeTable: SHAPE_TABLE,
      messages: [insertMessage("row1", ["tagA", "tagB"])],
      primaryKey: ["id"],
    });
    expect(await tagCount(pg, "row1")).toBe(2);
  });

  it("a row held by TWO grants survives losing one, and is evicted only when the last is withdrawn", async () => {
    const pg = await freshStore();
    await drizzleOver(pg).insert(items).values({ id: "row1", body: "x" });
    await applyShapeTagSync({
      pg,
      metadataSchema: META,
      shapeTable: SHAPE_TABLE,
      messages: [insertMessage("row1", ["tagA", "tagB"])],
      primaryKey: ["id"],
    });

    // Revoke tagA — the row keeps tagB, so it must NOT be evicted.
    const firstEvicted = await applyShapeMoveOut({
      pg,
      metadataSchema: META,
      shapeTable: SHAPE_TABLE,
      table: "items",
      primaryKey: ["id"],
      columnTypes: COLUMN_TYPES,
      patternSets: [[{ pos: 0, value: "tagA" }]],
      debug: false,
    });
    expect(firstEvicted).toBe(0);
    expect(await itemCount(pg, "row1")).toBe(1);
    expect(await tagCount(pg, "row1")).toBe(1);

    // Revoke tagB — now no grant remains, so the row is evicted.
    const secondEvicted = await applyShapeMoveOut({
      pg,
      metadataSchema: META,
      shapeTable: SHAPE_TABLE,
      table: "items",
      primaryKey: ["id"],
      columnTypes: COLUMN_TYPES,
      patternSets: [[{ pos: 0, value: "tagB" }]],
      debug: false,
    });
    expect(secondEvicted).toBe(1);
    expect(await itemCount(pg, "row1")).toBe(0);
    expect(await tagCount(pg, "row1")).toBe(0);
  });

  it("evicts only the rows whose grant was revoked, leaving co-tagged rows intact", async () => {
    const pg = await freshStore();
    await drizzleOver(pg)
      .insert(items)
      .values([
        { id: "keep", body: "x" },
        { id: "drop", body: "x" },
      ]);
    await applyShapeTagSync({
      pg,
      metadataSchema: META,
      shapeTable: SHAPE_TABLE,
      messages: [insertMessage("keep", ["growth"]), insertMessage("drop", ["sales"])],
      primaryKey: ["id"],
    });

    const evicted = await applyShapeMoveOut({
      pg,
      metadataSchema: META,
      shapeTable: SHAPE_TABLE,
      table: "items",
      primaryKey: ["id"],
      columnTypes: COLUMN_TYPES,
      patternSets: [[{ pos: 0, value: "sales" }]],
      debug: false,
    });
    expect(evicted).toBe(1);
    expect(await itemCount(pg, "keep")).toBe(1);
    expect(await itemCount(pg, "drop")).toBe(0);
  });

  // ADR-0023 Slice 2: a must-refetch/​rebuild (and a desync) must drop the shape's tags so a re-snapshot
  // rebuilds them, leaving no orphans.
  it("clearShapeTags drops a shape's whole tag-set (must-refetch / rebuild)", async () => {
    const pg = await freshStore();
    await applyShapeTagSync({
      pg,
      metadataSchema: META,
      shapeTable: SHAPE_TABLE,
      messages: [insertMessage("row1", ["tagA", "tagB"]), insertMessage("row2", ["tagC"])],
      primaryKey: ["id"],
    });
    expect(await tagCount(pg, "row1")).toBe(2);

    await clearShapeTags({ pg, metadataSchema: META, shapeTable: SHAPE_TABLE });
    expect(await tagCount(pg, "row1")).toBe(0);
    expect(await tagCount(pg, "row2")).toBe(0);
  });

  it("the desync tag-clear SQL drops the shape's tags, and is a no-op when the tag store is absent", async () => {
    // Present store: it deletes only this shape's tags.
    const pg = await freshStore();
    await applyShapeTagSync({
      pg,
      metadataSchema: META,
      shapeTable: SHAPE_TABLE,
      messages: [insertMessage("row1", ["tagA"])],
      primaryKey: ["id"],
    });
    await pg.exec(buildClearShapeTagsSql(SHAPE_TABLE, META));
    expect(await tagCount(pg, "row1")).toBe(0);

    // Absent store (engine never booted): the guarded statement must not error.
    const bare = await createFreshTestPGlite();
    await bare.exec(buildClearShapeTagsSql(SHAPE_TABLE, META));
  });
});

async function tagList(pg: Awaited<ReturnType<typeof freshStore>>, id: string) {
  const rows = await drizzleOver(pg)
    .select({ tag: shapeRowTags.tag })
    .from(shapeRowTags)
    .where(and(eq(shapeRowTags.shapeTable, SHAPE_TABLE), eq(shapeRowTags.pkJson, serializeRowPk({ id }, ["id"]))))
    .orderBy(shapeRowTags.tag);
  return rows.map((row) => row.tag);
}

// ADR-0024 — a move-in ADDS a reason the row is in the shape, so its tags are UNIONED, never replaced.
// This is what keeps move-out eviction correct under multi-grant after a move-in, regardless of whether
// Electric sends the row's full reason-set or just the new grant on a move-in.
describe("move-in tag union (ADR-0024, PGlite)", () => {
  it("adds a move-in's tags without clearing an independent grant the row already holds", async () => {
    const pg = await freshStore();
    // Row already in the shape via grant A (e.g. a prior membership).
    await applyShapeTagSync({
      pg,
      metadataSchema: META,
      shapeTable: SHAPE_TABLE,
      messages: [insertMessage("row1", ["grantA"])],
      primaryKey: ["id"],
    });
    expect(await tagList(pg, "row1")).toEqual(["grantA"]);

    // A move-in via grant B must UNION — the row now has both reasons.
    await addShapeRowTags({
      pg,
      metadataSchema: META,
      shapeTable: SHAPE_TABLE,
      messages: [insertMessage("row1", ["grantB"])],
      primaryKey: ["id"],
    });
    expect(await tagList(pg, "row1")).toEqual(["grantA", "grantB"]);
  });

  it("is idempotent — re-applying the same move-in tags does not duplicate or error", async () => {
    const pg = await freshStore();
    const moveIn = [insertMessage("row1", ["grantA", "grantB"])];

    await addShapeRowTags({ pg, metadataSchema: META, shapeTable: SHAPE_TABLE, messages: moveIn, primaryKey: ["id"] });
    await addShapeRowTags({ pg, metadataSchema: META, shapeTable: SHAPE_TABLE, messages: moveIn, primaryKey: ["id"] });

    expect(await tagList(pg, "row1")).toEqual(["grantA", "grantB"]);
  });

  it("records nothing for a row carrying no tags (a non-subquery shape)", async () => {
    const pg = await freshStore();
    await addShapeRowTags({
      pg,
      metadataSchema: META,
      shapeTable: SHAPE_TABLE,
      messages: [insertMessage("row1", [])],
      primaryKey: ["id"],
    });
    expect(await tagCount(pg, "row1")).toBe(0);
  });
});
