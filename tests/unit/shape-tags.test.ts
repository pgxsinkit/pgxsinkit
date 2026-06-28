import { afterEach, describe, expect, it } from "bun:test";

import {
  applyShapeMoveOut,
  applyShapeTagSync,
  serializeRowPk,
  shapeRowTagsDdl,
  splitTagComponents,
  tagMatchesPatterns,
} from "../../packages/client/src/sync/tags";
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
  await pg.exec(shapeRowTagsDdl(META));
  await pg.exec(`CREATE TABLE items (id TEXT PRIMARY KEY, body TEXT);`);
  return pg;
}

async function tagCount(pg: Awaited<ReturnType<typeof freshStore>>, id: string) {
  const result = await pg.query<{ c: number }>(
    `SELECT count(*)::int AS c FROM ${META}.shape_row_tags WHERE shape_table = $1 AND pk_json = $2`,
    [SHAPE_TABLE, serializeRowPk({ id }, ["id"])],
  );
  return result.rows[0]?.c ?? 0;
}
async function itemCount(pg: Awaited<ReturnType<typeof freshStore>>, id: string) {
  const result = await pg.query<{ c: number }>(`SELECT count(*)::int AS c FROM items WHERE id = $1`, [id]);
  return result.rows[0]?.c ?? 0;
}

describe("move-out eviction (ADR-0023, PGlite)", () => {
  it("persists a row's tag-set from its tagged insert", async () => {
    const pg = await freshStore();
    await pg.query(`INSERT INTO items (id, body) VALUES ('row1', 'x')`);
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
    await pg.query(`INSERT INTO items (id, body) VALUES ('row1', 'x')`);
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
    await pg.query(`INSERT INTO items (id, body) VALUES ('keep', 'x'), ('drop', 'x')`);
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
});
