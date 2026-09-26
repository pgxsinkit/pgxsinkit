// Began as a copy of `@electric-sql/pglite`'s tests (taken under its PostgreSQL License option,
// © ElectricSQL — see NOTICE). Owned outright (ADR-0062); compatibility with PGlite is an anti-goal.

import { describe, expect, it } from "bun:test";

import { types } from "../../packages/pgwasm/src";

function serializer(oid: number): (value: unknown) => string {
  const serialize = types.serializers[oid];
  if (!serialize) throw new Error(`no serializer for ${oid}`);
  return serialize;
}

describe("parsing text values by type", () => {
  it("parses text, numbers, json, booleans", () => {
    expect(types.parseType("test", 0)).toEqual("test");
    expect(types.parseType("test", 1043)).toEqual("test");
    expect(types.parseType("1", 21)).toEqual(1);
    expect(types.parseType("1", 23)).toEqual(1);
    expect(types.parseType("1", 26)).toEqual(1);
    expect(types.parseType("1.1", 700)).toEqual(1.1);
    expect(types.parseType("1.1", 701)).toEqual(1.1);
    expect(types.parseType("1", 20)).toEqual(1);
    expect(types.parseType('{"test":1}', 114)).toEqual({ test: 1 });
    expect(types.parseType('{"test":1}', 3802)).toEqual({ test: 1 });
    expect(types.parseType("t", 16)).toEqual(true);
    expect(types.parseType(null, 23)).toBeNull();
  });

  it("parses an int8 outside the safe range as a bigint", () => {
    expect(types.parseType("9007199254740993", 20)).toEqual(9007199254740993n);
  });

  it("parses dates and timestamps", () => {
    expect(types.parseType("2021-01-01", 1082)).toEqual(new Date("2021-01-01T00:00:00.000Z"));
    const timestamp = types.parseType("2021-01-01T12:00:00", 1114) as Date;
    expect(timestamp.getUTCMilliseconds()).toEqual(new Date("2021-01-01T12:00:00.000Z").getUTCMilliseconds());
    const timestamptz = types.parseType("2021-01-01T12:00:00", 1184) as Date;
    expect(timestamptz.getUTCMilliseconds()).toEqual(new Date("2021-01-01T12:00:00.000Z").getUTCMilliseconds());
  });

  it("parses bytea", () => {
    expect(types.parseType("\\x010203", 17)).toEqual(Uint8Array.from([1, 2, 3]));
  });
});

describe("serializing values by type", () => {
  it("serializes strings and numbers", () => {
    expect(serializer(25)("test")).toEqual("test");
    expect(serializer(25)(1)).toEqual("1");
    expect(serializer(0)(1)).toEqual("1");
    expect(serializer(0)(1.1)).toEqual("1.1");
    expect(serializer(20)(1n)).toEqual("1");
  });

  it("serializes booleans as Postgres reads them", () => {
    expect(serializer(16)(true)).toEqual("t");
    expect(serializer(16)(false)).toEqual("f");
    // 1/0 is what some drivers send for a boolean column.
    expect(serializer(16)(1)).toEqual("t");
    expect(serializer(16)(0)).toEqual("f");
    for (const s of ["true", "t", "yes", "y", "on", "1", "TRUE", " t "]) expect(serializer(16)(s)).toEqual("t");
    for (const s of ["false", "f", "no", "n", "off", "0", "FALSE", " f "]) expect(serializer(16)(s)).toEqual("f");
  });

  it("refuses booleans Postgres would reject", () => {
    for (const value of [2, -1, Number.NaN, "ture", "maybe", "", {}]) {
      expect(() => serializer(16)(value)).toThrow();
    }
  });

  it("serializes dates", () => {
    expect(serializer(1184)(new Date("2021-01-01T00:00:00.000Z"))).toEqual("2021-01-01T00:00:00.000Z");
    expect(serializer(1184)(1672531200000)).toEqual("2023-01-01T00:00:00.000Z");
    expect(serializer(1184)("2021-01-01T00:00:00.000Z")).toEqual("2021-01-01T00:00:00.000Z");
    expect(() => serializer(1184)(true)).toThrow();
  });

  it("serializes json, keeping a string as it is", () => {
    expect(serializer(114)({ test: 1 })).toEqual('{"test":1}');
    expect(serializer(114)(JSON.stringify({ test: 1 }))).toEqual('{"test":1}');
    expect(serializer(114)({ big: 1n })).toEqual('{"big":"1"}');
  });

  it("serializes bytea and refuses anything else", () => {
    expect(serializer(17)(Uint8Array.from([1, 2, 3]))).toEqual("\\x010203");
    expect(() => serializer(17)(1)).toThrow();
  });
});

describe("arrays", () => {
  it("round-trips nested arrays with NULLs, quotes and backslashes", () => {
    const text = types.arraySerializer(
      [
        ["a", null],
        ['b"c', "d\\e"],
      ],
      undefined,
      1009,
    );
    expect(text).toBe('{{"a",null},{"b\\"c","d\\\\e"}}');
    expect(types.arrayParser(text, undefined, 1009)).toEqual([
      ["a", "null"],
      ['b"c', "d\\e"],
    ]);
    expect(types.arrayParser("{1,NULL,3}", (value) => Number(value), 1007)).toEqual([1, null, 3]);
  });

  it("uses ';' for box arrays", () => {
    expect(types.arraySerializer(["(1,1),(0,0)", "(2,2),(1,1)"], undefined, 1020)).toBe(
      '{"(1,1),(0,0)";"(2,2),(1,1)"}',
    );
  });
});
