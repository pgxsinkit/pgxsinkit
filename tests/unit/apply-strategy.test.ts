import { describe, expect, it } from "bun:test";

import {
  bigint,
  bigserial,
  boolean,
  doublePrecision,
  integer,
  jsonb,
  numeric,
  pgEnum,
  serial,
  smallserial,
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

const col = (name: string, sqlType: string, isArray = false, isEnum = false): SyncColumnType => ({
  name,
  sqlType,
  isArray,
  isEnum,
});

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

  it("keeps a table with a scalar enum column COPY-safe (labels round-trip through COPY text)", () => {
    // An enum's sqlType is its custom type NAME, absent from the base-type whitelist — the isEnum flag is
    // what keeps it off the insert floor. A whole-COPY-safe table with one enum stays `copy`.
    expect(classifyApplyStrategy([col("id", "uuid"), col("status", "issue_status", false, true)])).toBe("copy");
  });

  it("escalates an enum ARRAY table to json (arrays never COPY), not to the insert floor", () => {
    expect(classifyApplyStrategy([col("id", "uuid"), col("labels", "issue_status", true, true)])).toBe("json");
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
      { name: "id", sqlType: "uuid", isArray: false, isEnum: false },
      { name: "name", sqlType: "text", isArray: false, isEnum: false },
      { name: "count", sqlType: "integer", isArray: false, isEnum: false },
      { name: "big", sqlType: "bigint", isArray: false, isEnum: false },
      { name: "ratio", sqlType: "double precision", isArray: false, isEnum: false },
      { name: "active", sqlType: "boolean", isArray: false, isEnum: false },
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

  it("normalises the serial family to integer cast types (serial is not a real cast type)", () => {
    const entry = defineSyncTable({
      tableName: "serials",
      makeColumns: () => ({
        id: serial("id").primaryKey(),
        big: bigserial("big", { mode: "bigint" }).notNull(),
        small: smallserial("small").notNull(),
        label: text("label").notNull(),
      }),
    });

    // `getSQLType()` yields "serial"/"bigserial"/"smallserial", which are invalid inside a
    // `json_to_recordset(… AS x(id serial))` record definition and in a `::serial` cast. The derived
    // cast list must be valid SQL — integer/bigint/smallint — and the table must classify as COPY-safe.
    expect(deriveSyncColumnTypes(entry)).toEqual([
      { name: "id", sqlType: "integer", isArray: false, isEnum: false },
      { name: "big", sqlType: "bigint", isArray: false, isEnum: false },
      { name: "small", sqlType: "smallint", isArray: false, isEnum: false },
      { name: "label", sqlType: "text", isArray: false, isEnum: false },
    ]);
    expect(classifyTableApplyStrategy(entry)).toBe("copy" satisfies ApplyStrategy);
  });

  it("flags a pgEnum column via isEnum, carries its type name, and keeps the table COPY-safe", () => {
    const status = pgEnum("issue_status", ["backlog", "todo", "in_progress", "done"]);
    const entry = defineSyncTable({
      tableName: "issues",
      makeColumns: () => ({
        id: uuid("id").primaryKey(),
        title: text("title").notNull(),
        status: status("status").notNull(),
      }),
    });

    const derived = deriveSyncColumnTypes(entry);
    // getSQLType() on an enum column returns the enum TYPE NAME (usable as a cast type once quoted).
    expect(derived.find((c) => c.name === "status")).toEqual({
      name: "status",
      sqlType: "issue_status",
      isArray: false,
      isEnum: true,
    });
    // Non-enum columns keep isEnum false.
    expect(derived.find((c) => c.name === "title")?.isEnum).toBe(false);
    // An enum is COPY-safe (its label round-trips through COPY text), so the table stays on the copy tier.
    expect(classifyTableApplyStrategy(entry)).toBe("copy" satisfies ApplyStrategy);
  });

  it("does NOT flag text/varchar-with-enum columns as isEnum (they are base types, not pg enums)", () => {
    // Drizzle's `text("c", { enum: […] })` / varchar variants expose `enumValues` for TS narrowing, but
    // their SQL type is the BASE type — identifier-quoting `text` or `varchar(80)` as a cast type would
    // be wrong (and broken for parameterised types). The discriminator is the `PgEnum` column brand.
    const entry = defineSyncTable({
      tableName: "narrowed",
      makeColumns: () => ({
        id: uuid("id").primaryKey(),
        kind: text("kind", { enum: ["alpha", "beta"] }).notNull(),
        size: varchar("size", { length: 80, enum: ["s", "m", "l"] }).notNull(),
      }),
    });

    const derived = deriveSyncColumnTypes(entry);
    expect(derived.find((c) => c.name === "kind")).toEqual({
      name: "kind",
      sqlType: "text",
      isArray: false,
      isEnum: false,
    });
    expect(derived.find((c) => c.name === "size")).toEqual({
      name: "size",
      sqlType: "varchar(80)",
      isArray: false,
      isEnum: false,
    });
    // Both are ordinary COPY-safe base types; the table stays on the copy tier through the normal path.
    expect(classifyTableApplyStrategy(entry)).toBe("copy" satisfies ApplyStrategy);
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
