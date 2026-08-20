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

const registry = defineSyncRegistry({ tables: { notes, readState } });
const noteTarget = resolveApplyTarget(registry, "notes");
const readTarget = resolveApplyTarget(registry, "readState");

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

  it("refuses a non-delete envelope with no row body", () => {
    expect(() => envelopeToChange(noteTarget, envelope({ key: "n1", headers: { operation: "upsert" } }))).toThrow(
      /carries no row body/,
    );
  });
});
