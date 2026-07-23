import { describe, expect, it } from "bun:test";
// The typed param codec + canonical key (ADR-0040 decisions 2 & 3). The guarantee under test: identical
// execution inputs share a key; anything that changes what PGlite runs (or how the diff is keyed) — SQL,
// params, param TYPE, pk columns/mode — yields a distinct key; and unknown-prototype values never dedup.

import { fingerprintLiveQuery } from "../../packages/client/src/worker/live-query-fingerprint";

const key = (sql: string, params: readonly unknown[], pk?: readonly string[]) =>
  fingerprintLiveQuery(sql, params, pk).key;

describe("live-query fingerprint codec (ADR-0040)", () => {
  it("gives the same key for the same SQL + params", () => {
    expect(key("select * from t where a = $1", ["x"])).toBe(key("select * from t where a = $1", ["x"]));
  });

  it("distinguishes a Date from its ISO string (type tags never collide)", () => {
    const date = new Date("2026-07-13T00:00:00.000Z");
    expect(key("select 1", [date])).not.toBe(key("select 1", [date.toISOString()]));
    // But two equal Dates share a key (tagged epoch-ms).
    expect(key("select 1", [date])).toBe(key("select 1", [new Date(date.getTime())]));
  });

  it("treats -0 and 0 as the same value", () => {
    expect(key("select 1", [-0])).toBe(key("select 1", [0]));
  });

  it("is insensitive to plain-object key order", () => {
    expect(key("select 1", [{ a: 1, b: 2 }])).toBe(key("select 1", [{ b: 2, a: 1 }]));
  });

  it("distinguishes a number from its numeric string, and a bool from its string", () => {
    expect(key("select 1", [1])).not.toBe(key("select 1", ["1"]));
    expect(key("select 1", [true])).not.toBe(key("select 1", ["true"]));
  });

  it("distinguishes a Uint8Array from its hex text", () => {
    const bytes = new Uint8Array([222, 173, 190, 239]);
    expect(key("select 1", [bytes])).not.toBe(key("select 1", ["deadbeef"]));
    // Equal byte contents share a key.
    expect(key("select 1", [bytes])).toBe(key("select 1", [new Uint8Array([222, 173, 190, 239])]));
  });

  it("gives two opaque (unknown-prototype) values distinct keys — they never dedup", () => {
    class Weird {
      n: number;
      constructor(n: number) {
        this.n = n;
      }
    }
    expect(key("select 1", [new Weird(1)])).not.toBe(key("select 1", [new Weird(1)]));
  });

  it("distinguishes different SQL, different params, and different pk columns / mode", () => {
    expect(key("select 1", [])).not.toBe(key("select 2", []));
    expect(key("select 1", ["a"])).not.toBe(key("select 1", ["b"]));
    // pk column identity matters (different diff key) even though both are single-column incremental mode.
    expect(key("select 1", [], ["id"])).not.toBe(key("select 1", [], ["other"]));
    // Single-column (incremental) vs composite (full) vs keyless (full) are distinct registrations.
    expect(key("select 1", [], ["id"])).not.toBe(key("select 1", [], ["id", "b"]));
    expect(key("select 1", [], ["id", "b"])).not.toBe(key("select 1", []));
  });

  it("returns a short hex digest distinct from the full key", () => {
    const fp = fingerprintLiveQuery("select 1", ["x"]);
    expect(fp.digest).toMatch(/^[0-9a-f]{8}$/);
    expect(fp.digest).not.toBe(fp.key);
    // Same inputs → same digest; different inputs → (practically) different digest.
    expect(fingerprintLiveQuery("select 1", ["x"]).digest).toBe(fp.digest);
    expect(fingerprintLiveQuery("select 2", ["x"]).digest).not.toBe(fp.digest);
  });

  it("a typed-array view is encoded through its own window, never the whole underlying buffer", () => {
    // Two different views over ONE buffer are different params and must not share a fingerprint —
    // encoding the whole backing buffer would falsely dedup them (a wrong-shared registration).
    const buffer = new ArrayBuffer(8);
    new Uint8Array(buffer).set([1, 2, 3, 4, 5, 6, 7, 8]);
    const first = new DataView(buffer, 0, 4);
    const second = new DataView(buffer, 4, 4);
    expect(fingerprintLiveQuery("select 1", [first]).key).not.toBe(fingerprintLiveQuery("select 1", [second]).key);
  });

  it("equal-content views over different buffers fingerprint identically", () => {
    const a = new DataView(new Uint8Array([9, 9, 1, 2]).buffer, 2, 2);
    const b = new DataView(new Uint8Array([1, 2, 0, 0, 0]).buffer, 0, 2);
    expect(fingerprintLiveQuery("select 1", [a]).key).toBe(fingerprintLiveQuery("select 1", [b]).key);
  });

  // ── Adversarial framing: delimiter-bearing values must NOT forge structure (the P1 collision class) ──
  it("does not collide a delimiter-bearing string with a two-element array (the demonstrated pair)", () => {
    // The old flat-string codec encoded both of these as `a:[s:x,s:y]`.
    expect(key("select $1", [["x,s:y"]])).not.toBe(key("select $1", [["x", "y"]]));
  });

  it('keeps `["x","y"]` distinct from `["x,y"]` (comma inside a member is not a separator)', () => {
    expect(key("select 1", [["x", "y"]])).not.toBe(key("select 1", [["x,y"]]));
  });

  it("does not let a string with array/object delimiters masquerade as extra members", () => {
    expect(key("select 1", [['a", "b']])).not.toBe(key("select 1", [["a", "b"]]));
    expect(key("select 1", [{ a: 'b", "c": "d' }])).not.toBe(key("select 1", [{ a: "b", c: "d" }]));
  });

  it("does not confuse a nested object key that contains `=` and `,` with separate members", () => {
    // The old codec joined object members with `,` and separated key/value with `=`.
    expect(key("select 1", [{ "a=1,b": "c" }])).not.toBe(key("select 1", [{ a: "1", b: "c" }]));
    expect(key("select 1", [{ "x=y": "z" }])).not.toBe(key("select 1", [{ x: "y=z" }]));
  });

  it("still shares a key for structurally-equal nested arrays/objects with delimiter-bearing content", () => {
    expect(key("select 1", [{ a: ["x,y", { b: "c=d" }] }])).toBe(key("select 1", [{ a: ["x,y", { b: "c=d" }] }]));
  });
});
