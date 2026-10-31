import { describe, expect, it } from "bun:test";

import { parseResults } from "../../packages/pgwasm/src/core/parse";
import type { RowMode } from "../../packages/pgwasm/src/interface";
import {
  CommandCompleteMessage,
  DataRowMessage,
  Field,
  RowDescriptionMessage,
} from "../../packages/pgwasm/src/protocol/wire/messages";
import { Modes } from "../../packages/pgwasm/src/protocol/wire/types";

function description(fields: readonly (readonly [string, number])[]): RowDescriptionMessage {
  return new RowDescriptionMessage(
    0,
    fields.map(([name, oid]) => new Field(name, 0, 0, oid, -1, -1, Modes.text)),
  );
}

function data(values: (string | null)[]): DataRowMessage {
  return new DataRowMessage(0, values);
}

function complete(tag: string): CommandCompleteMessage {
  return new CommandCompleteMessage(0, tag);
}

describe("query result rows", () => {
  for (const rowMode of ["object", "array"] as const) {
    it(`parses built-in, unknown and NULL values in ${rowMode} mode`, () => {
      const result = parseResults(
        [
          description([
            ["id", 23],
            ["active", 16],
            ["unknown", 999_999],
            ["empty", 25],
          ]),
          data(["42", "t", "untouched", null]),
          complete("SELECT 1"),
        ],
        {},
        { rowMode },
      )[0]!;

      expect(result.rows).toEqual(
        rowMode === "array"
          ? [[42, true, "untouched", null]]
          : [{ id: 42, active: true, unknown: "untouched", empty: null }],
      );
      expect(result.fields).toEqual([
        { name: "id", dataTypeID: 23 },
        { name: "active", dataTypeID: 16 },
        { name: "unknown", dataTypeID: 999_999 },
        { name: "empty", dataTypeID: 25 },
      ]);
    });

    it(`applies per-query parser precedence, passes OIDs and bypasses NULL in ${rowMode} mode`, () => {
      const calls: [string, number | undefined][] = [];
      const result = parseResults(
        [
          description([
            ["value", 23],
            ["empty", 23],
          ]),
          data(["7", null]),
          complete("SELECT 1"),
        ],
        { 23: () => "default" },
        {
          rowMode,
          parsers: {
            23: (value, oid) => {
              calls.push([value, oid]);
              return `custom:${value}`;
            },
          },
        },
      )[0]!;

      expect(result.rows).toEqual(rowMode === "array" ? [["custom:7", null]] : [{ value: "custom:7", empty: null }]);
      expect(calls).toEqual([["7", 23]]);
    });

    it(`retains column-index and OID-zero fallbacks with missing metadata in ${rowMode} mode`, () => {
      const result = parseResults([data(["first", null]), complete("SELECT 1")], {}, { rowMode })[0]!;
      expect(result.rows).toEqual(rowMode === "array" ? [["first", null]] : [{ 0: "first", 1: null }]);

      const short = parseResults(
        [description([["id", 23]]), data(["9", "second"]), complete("SELECT 1")],
        {},
        { rowMode, parsers: { 0: (value, oid) => `${oid}:${value}` } },
      )[0]!;
      expect(short.rows).toEqual(rowMode === "array" ? [[9, "0:second"]] : [{ id: 9, 1: "0:second" }]);
    });

    it(`keeps each statement's metadata separate in ${rowMode} mode`, () => {
      const results = parseResults(
        [
          description([["id", 23]]),
          data(["1"]),
          complete("SELECT 1"),
          description([
            ["label", 25],
            ["active", 16],
          ]),
          data(["next", "f"]),
          complete("SELECT 1"),
          data(["without metadata"]),
          complete("SELECT 1"),
        ],
        {},
        { rowMode },
      );

      expect(results.map((result) => result.rows)).toEqual(
        rowMode === "array"
          ? [[[1]], [["next", false]], [["without metadata"]]]
          : [[{ id: 1 }], [{ label: "next", active: false }], [{ 0: "without metadata" }]],
      );
      expect(results.map((result) => result.fields)).toEqual([
        [{ name: "id", dataTypeID: 23 }],
        [
          { name: "label", dataTypeID: 25 },
          { name: "active", dataTypeID: 16 },
        ],
        [],
      ]);
    });
  }

  for (const scenario of [
    { label: "text", oid: 25, value: "literal", parsed: "literal" },
    { label: "JSON object", oid: 3802, value: '{"injected":true}', parsed: { injected: true } },
    { label: "NULL", oid: 25, value: null, parsed: null },
  ]) {
    it(`returns __proto__ ${scenario.label} as an own data property without changing the row prototype`, () => {
      const result = parseResults(
        [description([["__proto__", scenario.oid]]), data([scenario.value]), complete("SELECT 1")],
        {},
      )[0]!;
      const row = result.rows[0] as Record<string, unknown>;

      expect(Object.getPrototypeOf(row)).toBe(Object.prototype);
      expect(Object.keys(row)).toEqual(["__proto__"]);
      expect(Object.getOwnPropertyDescriptor(row, "__proto__")).toEqual({
        value: scenario.parsed,
        enumerable: true,
        writable: true,
        configurable: true,
      });
      expect(row["injected"]).toBeUndefined();
    });
  }

  it("keeps last-column-wins semantics for duplicate names, including __proto__", () => {
    const fields = description([
      ["__proto__", 3802],
      ["duplicate", 23],
      ["constructor", 25],
      ["toString", 25],
      ["__proto__", 25],
      ["duplicate", 23],
    ]);
    const values = data(['{"ignored":true}', "1", "own constructor", "own toString", "last", "2"]);
    const result = parseResults([fields, values, complete("SELECT 1")], {})[0]!;
    const row = result.rows[0] as Record<string, unknown>;

    expect(Object.getPrototypeOf(row)).toBe(Object.prototype);
    expect(Object.keys(row)).toEqual(["__proto__", "duplicate", "constructor", "toString"]);
    expect(row["__proto__"]).toBe("last");
    expect(row["duplicate"]).toBe(2);
    expect(row["constructor"]).toBe("own constructor");
    expect(row["toString"]).toBe("own toString");
    expect(parseResults([fields, values, complete("SELECT 1")], {}, { rowMode: "array" })[0]!.rows).toEqual([
      [{ ignored: true }, 1, "own constructor", "own toString", "last", 2],
    ]);
  });

  it("preserves zero-column rows in both modes", () => {
    for (const rowMode of ["object", "array"] satisfies RowMode[]) {
      const result = parseResults([description([]), data([]), data([]), complete("SELECT 2")], {}, { rowMode })[0]!;
      expect(result.rows).toEqual(rowMode === "array" ? [[], []] : [{}, {}]);
      expect(result.rowCount).toBe(2);
    }
  });

  it("retains cumulative affected counts, per-statement commands and blobs", () => {
    const blob = new Blob(["copy data"]);
    const results = parseResults(
      [
        complete("INSERT 0 2"),
        complete("UPDATE 3"),
        complete("DELETE 1"),
        complete("COPY 4"),
        complete("MERGE 5"),
        complete("CREATE TABLE"),
        complete("SELECT 0"),
      ],
      {},
      undefined,
      blob,
    );

    expect(results.map(({ command, rowCount, affectedRows }) => ({ command, rowCount, affectedRows }))).toEqual([
      { command: "INSERT", rowCount: 2, affectedRows: 2 },
      { command: "UPDATE", rowCount: 3, affectedRows: 5 },
      { command: "DELETE", rowCount: 1, affectedRows: 6 },
      { command: "COPY", rowCount: 4, affectedRows: 10 },
      { command: "MERGE", rowCount: 5, affectedRows: 15 },
      { command: "CREATE", rowCount: undefined, affectedRows: 15 },
      { command: "SELECT", rowCount: 0, affectedRows: 15 },
    ]);
    expect(Object.hasOwn(results[5]!, "rowCount")).toBe(false);
    expect(results.every((result) => result.blob === blob)).toBe(true);
  });

  it("returns the empty result when no statement completed", () => {
    expect(parseResults([], {})).toEqual([{ affectedRows: 0, rows: [], fields: [] }]);
  });
});
