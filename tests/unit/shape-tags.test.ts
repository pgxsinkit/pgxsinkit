import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { and, count, eq } from "drizzle-orm";
import { pgSchema, pgTable, text } from "drizzle-orm/pg-core";

import { migrateSubscriptionMetadataTables } from "../../packages/client/src/sync/subscription-state";
import {
  addShapeRowTags,
  applyShapeMoveOut,
  applyShapeTagSync,
  buildClearShapeTagsSql,
  clearShapeTags,
  serializeRowPk,
  splitTagComponents,
  tagMatchesPatterns,
} from "../../packages/client/src/sync/tags";
import { createTablesFromSchema, drizzleOver, makeApplyTarget } from "../support/drizzle";
import { closeOpenTestPGlites, createFreshTestPGlite } from "../support/pglite";

// Derive the upstream types from the function signatures so the tests/ scope does not need to resolve
// `@electric-sql/client` (it is hoisted under packages/client) — the same trick shape-fold.test.ts uses.
type TagSyncMessage = Parameters<typeof applyShapeTagSync>[0]["messages"][number];

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

// The synced fixture table — the move-out applier receives a resolved target built from it.
const items = pgTable("items", {
  id: text("id").primaryKey(),
  body: text("body"),
});

// Assertion-side mirror of the engine's tag store: this deliberately duplicates the `shape_row_tags`
// pgTable (packages/client/src/sync/metadata-tables.ts) so any drift in the engine's table shape fails
// these tests.
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
  // Provision the metadata store (schema + tag store) exactly as the engine boots it (ADR-0029 D3) —
  // rendered from the `metadata-tables.ts` pgTables, the subject under test.
  await migrateSubscriptionMetadataTables({ pg, metadataSchema: META });
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
      target: makeApplyTarget(items, ["id"]),
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
      target: makeApplyTarget(items, ["id"]),
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
      target: makeApplyTarget(items, ["id"]),
      patternSets: [[{ pos: 0, value: "sales" }]],
      debug: false,
    });
    expect(evicted).toBe(1);
    expect(await itemCount(pg, "keep")).toBe(1);
    expect(await itemCount(pg, "drop")).toBe(0);
  });

  it("evicts only the untagged rows when a shared grant is revoked across a multi-row candidate set", async () => {
    // Both rows are held by `shared`, so revoking it puts BOTH pk_jsons in the move-out candidate set —
    // exercising the remaining-tag probe (`pk_json = ANY(${affected})`) over a multi-element array. Only
    // `shared_drop` (no tag left) is evicted; `shared_keep` survives on its independent `extra` grant.
    const pg = await freshStore();
    await drizzleOver(pg)
      .insert(items)
      .values([
        { id: "shared_keep", body: "x" },
        { id: "shared_drop", body: "x" },
      ]);
    await applyShapeTagSync({
      pg,
      metadataSchema: META,
      shapeTable: SHAPE_TABLE,
      messages: [insertMessage("shared_keep", ["shared", "extra"]), insertMessage("shared_drop", ["shared"])],
      primaryKey: ["id"],
    });

    const evicted = await applyShapeMoveOut({
      pg,
      metadataSchema: META,
      shapeTable: SHAPE_TABLE,
      target: makeApplyTarget(items, ["id"]),
      patternSets: [[{ pos: 0, value: "shared" }]],
      debug: false,
    });
    expect(evicted).toBe(1);
    expect(await itemCount(pg, "shared_keep")).toBe(1);
    expect(await tagList(pg, "shared_keep")).toEqual(["extra"]);
    expect(await itemCount(pg, "shared_drop")).toBe(0);
    expect(await tagCount(pg, "shared_drop")).toBe(0);
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

  // ADR-0042: an ephemeral group's tags live in the SESSION (`pg_temp`) tag store. `applyShapeTagSync`/
  // `clearShapeTags` route there on `sessionScoped: true`, and the desync clear SQL is scope-blind — it
  // drops the shape's tags from the session store as well as the durable one.
  it("session-scoped tags route to pg_temp, and the desync clear SQL is scope-blind", async () => {
    const pg = await freshStore();
    await applyShapeTagSync({
      pg,
      metadataSchema: META,
      shapeTable: SHAPE_TABLE,
      messages: [insertMessage("row1", ["tagA", "tagB"])],
      primaryKey: ["id"],
      sessionScoped: true,
    });
    // The durable store stays empty; the session store carries the tags.
    expect(await tagCount(pg, "row1")).toBe(0);
    const sessionCount = async () =>
      (
        await pg.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM pg_temp.shape_row_tags WHERE shape_table = $1`, [
          SHAPE_TABLE,
        ])
      ).rows[0]?.c ?? 0;
    expect(await sessionCount()).toBe(2);

    // clearShapeTags routed to the session store empties only it.
    await clearShapeTags({ pg, metadataSchema: META, shapeTable: SHAPE_TABLE, sessionScoped: true });
    expect(await sessionCount()).toBe(0);

    // Re-seed and prove the desync clear SQL (scope-blind) drops both stores in one statement.
    await applyShapeTagSync({
      pg,
      metadataSchema: META,
      shapeTable: SHAPE_TABLE,
      messages: [insertMessage("row1", ["tagA"])],
      primaryKey: ["id"],
      sessionScoped: true,
    });
    await applyShapeTagSync({
      pg,
      metadataSchema: META,
      shapeTable: SHAPE_TABLE,
      messages: [insertMessage("row2", ["tagC"])],
      primaryKey: ["id"],
    });
    expect(await sessionCount()).toBe(1);
    expect(await tagCount(pg, "row2")).toBe(1);
    await pg.exec(buildClearShapeTagsSql(SHAPE_TABLE, META));
    expect(await sessionCount()).toBe(0);
    expect(await tagCount(pg, "row2")).toBe(0);
  });

  // ADR-0042 end-to-end tag half (plan step 6): a full ADR-0023/0024 move-out/move-in round trip on an
  // EPHEMERAL (session-scoped) group within one engine session, then a GENUINE engine restart — close the
  // fs-backed PGlite and reopen it on the SAME store — then a fresh re-activation. This is driven at the tag
  // applier seam on real PGlite (no mock Electric stream) because that is exactly how ADR-0023/0024
  // reconciliation is tested deterministically here, and a real fs close/reopen faithfully proves the
  // session (`pg_temp`) tag store DIES with the engine (probed: `to_regclass('pg_temp.shape_row_tags')` is
  // null on boot B) — the tag twin of the two-boot cursor integration test, which uses a plain (non-tagged)
  // shape. The invariant proven: an ephemeral group's tags never touch durable space, so a returning engine
  // re-streams with no stale-tag artefacts to corrupt move-out/move-in reconciliation.
  it("ephemeral tagged-subquery round trip leaves no durable artefacts and re-streams clean after an engine restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pgxsinkit-eph-tags-restart-"));
    const durableCount = async (pg: PGlite) =>
      (
        await pg.query<{ c: number }>(
          `SELECT COUNT(*)::int AS c FROM pgxsinkit.shape_row_tags WHERE shape_table = $1`,
          [SHAPE_TABLE],
        )
      ).rows[0]?.c ?? 0;
    const sessionCount = async (pg: PGlite) =>
      (
        await pg.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM pg_temp.shape_row_tags WHERE shape_table = $1`, [
          SHAPE_TABLE,
        ])
      ).rows[0]?.c ?? 0;
    const itemRows = async (pg: PGlite) =>
      (await pg.query<{ id: string }>(`SELECT id FROM items ORDER BY id`)).rows.map((r) => r.id);

    try {
      // ── Boot A — real fs store + engine. Provision durable + session metadata and the items cluster.
      const a = await PGlite.create({ dataDir: dir });
      await migrateSubscriptionMetadataTables({ pg: a, metadataSchema: META });
      await createTablesFromSchema(a, { items });
      await drizzleOver(a)
        .insert(items)
        .values([
          { id: "row1", body: "x" },
          { id: "row2", body: "x" },
        ]);
      const target = makeApplyTarget(items, ["id"]);

      // row1 held by two grants, row2 by one — all session-scoped (ephemeral).
      await applyShapeTagSync({
        pg: a,
        metadataSchema: META,
        shapeTable: SHAPE_TABLE,
        messages: [insertMessage("row1", ["tagA", "tagB"]), insertMessage("row2", ["tagC"])],
        primaryKey: ["id"],
        sessionScoped: true,
      });
      // ADR-0024 move-in: union a second grant onto row2 (must not clear its existing tag).
      await addShapeRowTags({
        pg: a,
        metadataSchema: META,
        shapeTable: SHAPE_TABLE,
        messages: [insertMessage("row2", ["tagD"])],
        primaryKey: ["id"],
        sessionScoped: true,
      });
      // ADR-0023 move-out: withdraw tagA — row1 keeps tagB, so it survives (0 evicted).
      expect(
        await applyShapeMoveOut({
          pg: a,
          metadataSchema: META,
          shapeTable: SHAPE_TABLE,
          target,
          patternSets: [[{ pos: 0, value: "tagA" }]],
          debug: false,
          sessionScoped: true,
        }),
      ).toBe(0);
      // move-out both of row2's grants — no tag remains, so the row is evicted from the items cluster.
      expect(
        await applyShapeMoveOut({
          pg: a,
          metadataSchema: META,
          shapeTable: SHAPE_TABLE,
          target,
          patternSets: [[{ pos: 0, value: "tagC" }], [{ pos: 0, value: "tagD" }]],
          debug: false,
          sessionScoped: true,
        }),
      ).toBe(1);

      // Durable tag store untouched throughout; the session store holds only row1's surviving tagB.
      expect(await durableCount(a)).toBe(0);
      expect(await sessionCount(a)).toBe(1);
      expect(await itemRows(a)).toEqual(["row1"]);
      await a.close();

      // ── Boot B — SAME fs store, NEW engine. The session tag store died with boot A's engine.
      const b = await PGlite.create({ dataDir: dir });
      const reg = await b.query<{ r: string | null }>(`SELECT to_regclass('pg_temp.shape_row_tags') AS r`);
      expect(reg.rows[0]?.r).toBeNull(); // pg_temp tables do not survive a restart
      expect(await durableCount(b)).toBe(0); // and no ephemeral tag artefact leaked into durable space

      // Engine boot re-creates the empty TEMP tables; re-activation then re-streams tags from scratch.
      await migrateSubscriptionMetadataTables({ pg: b, metadataSchema: META });
      expect(await sessionCount(b)).toBe(0);
      await applyShapeTagSync({
        pg: b,
        metadataSchema: META,
        shapeTable: SHAPE_TABLE,
        messages: [insertMessage("row1", ["tagA"])],
        primaryKey: ["id"],
        sessionScoped: true,
      });
      expect(await sessionCount(b)).toBe(1);
      expect(await durableCount(b)).toBe(0);
      await b.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);
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
