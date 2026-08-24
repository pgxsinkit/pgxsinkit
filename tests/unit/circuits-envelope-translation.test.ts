import { describe, expect, it } from "bun:test";

import { boolean, integer, text, uuid } from "drizzle-orm/pg-core";

import { envelopeToChange, primaryKeyFromStreamKey } from "@pgxsinkit/client";
import { defineSyncRegistry, defineSyncTable, type StreamEnvelope } from "@pgxsinkit/contracts";

import { resolveApplyTarget } from "../../packages/client/src/local-tables";

// Translating a Circuits envelope into what the applier consumes (ADR-0055). Two differences from
// Electric's wire format have teeth, and both fail quietly if got wrong: a delete carries only its
// KEY (no row body at all), and a composite key is one string joined by U+001F in primary-key
// declaration order. A mis-split produces a WHERE over part of the key — a delete that removes more
// rows than it should, which is data loss rather than a stale row.

const notes = defineSyncTable({
  tableName: "notes",
  makeColumns: () => ({ id: uuid("id").primaryKey(), body: text("body") }),
  primaryKey: ["id"],
  mode: "readonly",
});

const readState = defineSyncTable({
  tableName: "read_state",
  makeColumns: () => ({
    personId: uuid("person_id"),
    itemId: integer("item_id"),
    seen: boolean("seen"),
  }),
  primaryKey: ["personId", "itemId"],
  mode: "readonly",
});

// The userday-shaped narrowing: server identity (id, owner_id), local identity (id), the owner
// omitted from the projection and pinned by the shape's predicate (subscribe-time compile refuses
// the narrowing otherwise). The engine still keys the stream by the FULL server identity and
// force-includes every server pk component in the emitted row, so the translator carries the
// server->local projection for both directions.
const narrowed = defineSyncTable({
  tableName: "narrowed_rows",
  makeColumns: () => ({
    id: uuid("id").notNull(),
    ownerId: uuid("owner_id").notNull(),
    body: text("body"),
  }),
  primaryKey: ["id", "ownerId"],
  mode: "readonly",
  clientProjection: {
    omitColumns: ["ownerId"],
    localPrimaryKey: { columns: ["id"] },
  },
});

const registry = defineSyncRegistry({ tables: { notes, readState, narrowed } });
const noteTarget = resolveApplyTarget(registry, "notes");
const readTarget = resolveApplyTarget(registry, "readState");
const narrowedTarget = resolveApplyTarget(registry, "narrowed");

const UNIT_SEPARATOR = "\u001f";

function envelope(partial: Partial<StreamEnvelope> & { key: string }): StreamEnvelope {
  return {
    type: "notes",
    headers: { operation: "insert" },
    ...partial,
  } as StreamEnvelope;
}

describe("primary key from a stream key", () => {
  it("splits a composite key in declaration order and re-types each column", () => {
    const key = ["person-1", "42"].join(UNIT_SEPARATOR);
    expect(primaryKeyFromStreamKey(readTarget, key)).toEqual({ person_id: "person-1", item_id: 42 });
  });

  // A single-column key is taken whole — a text pk legitimately containing the separator must not be
  // torn apart by a split that was never needed.
  it("takes a single-column key whole", () => {
    expect(primaryKeyFromStreamKey(noteTarget, `a${UNIT_SEPARATOR}b`)).toEqual({ id: `a${UNIT_SEPARATOR}b` });
  });

  it("refuses a key whose part count does not match the primary key", () => {
    expect(() => primaryKeyFromStreamKey(readTarget, "person-1")).toThrow(/2-column primary key/);
  });

  // A localPrimaryKey narrowing: the key still carries the FULL server identity, split by the server
  // key and projected onto the local one — the pinned owner component is dropped, not bound.
  it("projects a narrowed local key out of the full server key", () => {
    const key = ["row-1", "owner-1"].join(UNIT_SEPARATOR);
    expect(primaryKeyFromStreamKey(narrowedTarget, key)).toEqual({ id: "row-1" });
  });

  it("still refuses a narrowed-target key that does not carry the full server identity", () => {
    expect(() => primaryKeyFromStreamKey(narrowedTarget, "row-1")).toThrow(/2-column primary key/);
  });

  // Composite components are ESCAPED by the engine (`escape_key_component`): a literal backslash
  // rides as `\\` and a literal U+001F as `\x1f`, which is what keeps the joined string injective.
  // The split must decode them or a pk containing either never matches its own row.
  it("unescapes composite key components", () => {
    expect(primaryKeyFromStreamKey(readTarget, [`a\\\\b`, "42"].join(UNIT_SEPARATOR))).toEqual({
      person_id: "a\\b",
      item_id: 42,
    });
    expect(primaryKeyFromStreamKey(readTarget, [`x\\x1fy`, "42"].join(UNIT_SEPARATOR))).toEqual({
      person_id: `x${UNIT_SEPARATOR}y`,
      item_id: 42,
    });
  });
});

describe("envelope translation", () => {
  // The engine's delete_envelopes carries no value at all — structurally, not incidentally.
  it("reconstructs the primary key of a body-less delete", () => {
    const change = envelopeToChange(readTarget, {
      type: "read_state",
      key: ["person-1", "42"].join(UNIT_SEPARATOR),
      headers: { operation: "delete", txid: "739" },
    });

    expect(change).toEqual({
      key: ["person-1", "42"].join(UNIT_SEPARATOR),
      value: { person_id: "person-1", item_id: 42 },
      headers: { operation: "delete" },
    });
  });

  // Every row change arrives as `upsert` — backfill and live alike — and is carried through as one.
  // The translator used to map it to `insert`, on a comment claiming `upsert` meant "backfill row";
  // a live UPDATE in its own transaction arrives as `upsert` too, so every change after a key's
  // first became a colliding INSERT.
  it("carries an upsert through as an upsert", () => {
    const value = { id: "n1", body: "hello" };
    expect(
      envelopeToChange(noteTarget, envelope({ key: "n1", value, headers: { operation: "upsert" } })).headers,
    ).toEqual({ operation: "upsert" });
  });

  // The engine's `resolve_columns` force-includes every server pk component in the projection, so
  // the pinned owner arrives on every upsert; the translator projects exactly that column off and
  // nothing else (an unknown column must still fail loudly downstream).
  it("projects the dropped, predicate-pinned key component off an upsert row", () => {
    const change = envelopeToChange(narrowedTarget, {
      type: "narrowed_rows",
      key: ["row-1", "owner-1"].join(UNIT_SEPARATOR),
      value: { id: "row-1", owner_id: "owner-1", body: "hello" },
      headers: { operation: "upsert" },
    });
    expect(change.value).toEqual({ id: "row-1", body: "hello" });
  });

  it("translates a narrowed delete to the local identity", () => {
    const change = envelopeToChange(narrowedTarget, {
      type: "narrowed_rows",
      key: ["row-1", "owner-1"].join(UNIT_SEPARATOR),
      headers: { operation: "delete" },
    });
    expect(change.value).toEqual({ id: "row-1" });
  });

  it("refuses a non-delete envelope with no row body", () => {
    expect(() => envelopeToChange(noteTarget, envelope({ key: "n1", headers: { operation: "upsert" } }))).toThrow(
      /carries no row body/,
    );
  });
});
