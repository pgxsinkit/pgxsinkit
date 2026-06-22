import { describe, expect, it } from "bun:test";

import {
  bigint,
  boolean,
  doublePrecision,
  integer,
  jsonb,
  numeric,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import {
  type ApplyStrategy,
  classifyApplyStrategy,
  classifyTableApplyStrategy,
  defineSyncTable,
  deriveSyncColumnTypes,
  type SyncColumnType,
} from "@pgxsinkit/contracts";

// The static apply ladder (ADR-0009 decision 3): the bulk-insert strategy for a synced table is
// chosen once, from column types, never by probing information_schema. This pins the classifier's
// tier boundaries and the registry derivation that feeds it.

const col = (name: string, sqlType: string, isArray = false): SyncColumnType => ({ name, sqlType, isArray });

describe("classifyApplyStrategy", () => {
  it("returns insert for an empty column list (always-correct floor)", () => {
    expect(classifyApplyStrategy([])).toBe("insert");
  });

  it("returns copy when every column is a COPY-safe scalar", () => {
    const columns = [
      col("id", "uuid"),
      col("name", "text"),
      col("title", "varchar(120)"),
      col("count", "integer"),
      col("big", "bigint"),
      col("ratio", "double precision"),
      col("active", "boolean"),
    ];
    expect(classifyApplyStrategy(columns)).toBe("copy");
  });

  it("normalises spelling/whitespace/args when matching the COPY-safe set", () => {
    const columns = [col("a", "character varying(255)"), col("b", "CHARACTER VARYING"), col("c", "  uuid  ")];
    expect(classifyApplyStrategy(columns)).toBe("copy");
  });

  it("escalates to json when any column is jsonb (rest COPY-safe)", () => {
    expect(classifyApplyStrategy([col("id", "uuid"), col("meta", "jsonb")])).toBe("json");
  });

  it("escalates to json when any column is an array (rest COPY-safe)", () => {
    expect(classifyApplyStrategy([col("id", "uuid"), col("tags", "text", true)])).toBe("json");
  });

  it("treats a bigint[] + jsonb table as json (the ADR-named round-trip case)", () => {
    expect(classifyApplyStrategy([col("id", "uuid"), col("nums", "bigint", true), col("doc", "jsonb")])).toBe("json");
  });

  it("falls to the insert floor when a column is neither COPY-safe nor json-extension", () => {
    // timestamptz and numeric are deliberately excluded from the conservative COPY-safe set and are
    // not part of the json extension (arrays/json/jsonb), so they pull the whole table to insert.
    expect(classifyApplyStrategy([col("id", "uuid"), col("at", "timestamp with time zone")])).toBe("insert");
    expect(classifyApplyStrategy([col("id", "uuid"), col("amount", "numeric(10, 2)")])).toBe("insert");
  });

  it("an array of a non-COPY-safe element is still json-representable", () => {
    expect(classifyApplyStrategy([col("id", "uuid"), col("times", "timestamp with time zone", true)])).toBe("json");
  });
});

describe("deriveSyncColumnTypes + classifyTableApplyStrategy", () => {
  it("derives names/types/array-ness from a Drizzle entry and classifies it", () => {
    const entry = defineSyncTable({
      tableName: "scalars",
      makeColumns: () => ({
        id: uuid("id").primaryKey(),
        name: text("name").notNull(),
        count: integer("count").notNull(),
        big: bigint("big", { mode: "bigint" }).notNull(),
        ratio: doublePrecision("ratio").notNull(),
        active: boolean("active").notNull(),
      }),
    });

    expect(deriveSyncColumnTypes(entry)).toEqual([
      { name: "id", sqlType: "uuid", isArray: false },
      { name: "name", sqlType: "text", isArray: false },
      { name: "count", sqlType: "integer", isArray: false },
      { name: "big", sqlType: "bigint", isArray: false },
      { name: "ratio", sqlType: "double precision", isArray: false },
      { name: "active", sqlType: "boolean", isArray: false },
    ]);
    expect(classifyTableApplyStrategy(entry)).toBe("copy");
  });

  it("classifies a jsonb/array table as json and reports array-ness", () => {
    const entry = defineSyncTable({
      tableName: "rich",
      makeColumns: () => ({
        id: uuid("id").primaryKey(),
        tags: text("tags").array().notNull(),
        meta: jsonb("meta").notNull(),
      }),
    });

    const derived = deriveSyncColumnTypes(entry);
    expect(derived.find((c) => c.name === "tags")?.isArray).toBe(true);
    expect(derived.find((c) => c.name === "meta")?.sqlType).toBe("jsonb");
    expect(classifyTableApplyStrategy(entry)).toBe("json");
  });

  it("classifies a timestamped table as insert (timestamptz is below the ladder)", () => {
    const entry = defineSyncTable({
      tableName: "events",
      makeColumns: () => ({
        id: uuid("id").primaryKey(),
        label: varchar("label", { length: 80 }).notNull(),
        at: timestamp("at", { withTimezone: true }).notNull(),
        amount: numeric("amount", { precision: 10, scale: 2 }).notNull(),
      }),
    });

    expect(classifyTableApplyStrategy(entry)).toBe("insert" satisfies ApplyStrategy);
  });
});
