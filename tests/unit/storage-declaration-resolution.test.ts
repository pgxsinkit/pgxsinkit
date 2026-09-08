import { describe, expect, it } from "bun:test";
// ADR-0050 (storage declaration transport): the PURE per-field resolution of a store's storage declaration
// from its two sources — the registry-attached STATIC declaration (authoritative) and the tab's WIRE
// declaration (honoured only where the registry is silent). The rules under test:
//   - An UNSET field means "no opinion" and can never conflict — it defers to the other source, else the
//     capability default (`backend: "opfs"`, `durability: "relaxed"`).
//   - An EXPLICIT field on both sources that DISAGREES is a typed refusal (never a silent old value).
//   - `assertStorageDeclarationCompatible` re-checks a LATER declaration against the already-bound
//     resolution: explicit mismatch refuses, unset/equal is idempotent.
//
// The `engine` field (ADR-0050 addendum 2026-09-08) plays by exactly those rules, on its `module` URL —
// which is also the store's ENGINE IDENTITY: a different module is a different store. Its one asymmetry is
// that it has no default value to resolve to, because "the toolkit's own store" is spelled by ABSENCE.

import {
  assertStorageDeclarationCompatible,
  isStorageEngineDeclaration,
  isStorageEngineModule,
  resolveStorageDeclaration,
  StorageDeclarationRefusedError,
} from "@pgxsinkit/contracts";

describe("resolveStorageDeclaration — per-field precedence (ADR-0050)", () => {
  it("both silent → capability defaults (opfs, relaxed)", () => {
    expect(resolveStorageDeclaration(undefined, undefined)).toEqual({ backend: "opfs", durability: "relaxed" });
    expect(resolveStorageDeclaration({}, {})).toEqual({ backend: "opfs", durability: "relaxed" });
  });

  it("wire explicit fields are honoured when the static declaration is silent", () => {
    expect(resolveStorageDeclaration(undefined, { backend: "idbfs" })).toEqual({
      backend: "idbfs",
      durability: "relaxed",
    });
    expect(resolveStorageDeclaration({}, { durability: "strict" })).toEqual({
      backend: "opfs",
      durability: "strict",
    });
  });

  it("static explicit fields are honoured when the wire declaration is silent — an empty wire {} NEVER conflicts", () => {
    // The static-declaring consumer's tab sends {} (no opinion): this must resolve to the static values,
    // never refuse — the naive "normalize {} to explicit defaults" would break every such consumer.
    expect(resolveStorageDeclaration({ backend: "idbfs", durability: "strict" }, {})).toEqual({
      backend: "idbfs",
      durability: "strict",
    });
  });

  it("equal explicit fields on both sources are idempotent", () => {
    expect(resolveStorageDeclaration({ backend: "idbfs" }, { backend: "idbfs", durability: "relaxed" })).toEqual({
      backend: "idbfs",
      durability: "relaxed",
    });
  });

  it("explicit disagreement on a field is a typed refusal, per field", () => {
    expect(() => resolveStorageDeclaration({ backend: "idbfs" }, { backend: "opfs" })).toThrow(
      StorageDeclarationRefusedError,
    );
    expect(() => resolveStorageDeclaration({ durability: "strict" }, { durability: "relaxed" })).toThrow(
      StorageDeclarationRefusedError,
    );
  });

  it("the refusal carries a stable error name (bridge-serializable, ADR-0050)", () => {
    try {
      resolveStorageDeclaration({ backend: "idbfs" }, { backend: "opfs" });
      throw new Error("expected a refusal");
    } catch (error) {
      expect((error as Error).name).toBe("StorageDeclarationRefusedError");
      expect((error as Error).message).toContain("backend");
    }
  });
});

describe("assertStorageDeclarationCompatible — a later declaration against the bound resolution", () => {
  const bound = { backend: "opfs", durability: "strict" } as const;

  it("unset fields and equal explicit fields are idempotent", () => {
    expect(() => assertStorageDeclarationCompatible(bound, undefined)).not.toThrow();
    expect(() => assertStorageDeclarationCompatible(bound, {})).not.toThrow();
    expect(() => assertStorageDeclarationCompatible(bound, { backend: "opfs" })).not.toThrow();
    expect(() => assertStorageDeclarationCompatible(bound, { durability: "strict" })).not.toThrow();
  });

  it("an explicit mismatch against the bound value is a typed refusal", () => {
    expect(() => assertStorageDeclarationCompatible(bound, { backend: "idbfs" })).toThrow(
      StorageDeclarationRefusedError,
    );
    expect(() => assertStorageDeclarationCompatible(bound, { durability: "relaxed" })).toThrow(
      StorageDeclarationRefusedError,
    );
  });
});

describe("isStorageEngineModule — what a declared engine module URL may be", () => {
  it("accepts an absolute URL and an origin-relative path", () => {
    expect(isStorageEngineModule("https://engine.example/factory.js")).toBe(true);
    expect(isStorageEngineModule("http://localhost:5173/store-engine/factory.js")).toBe(true);
    expect(isStorageEngineModule("/store-engine/factory.js")).toBe(true);
  });

  it("rejects a DOCUMENT-relative specifier — it would resolve differently in a worker scope", () => {
    // The declaration crosses the bridge into a scope whose base URL is the worker chunk's, not the tab's,
    // so "./factory.js" names two different files on the two sides of the wire.
    expect(isStorageEngineModule("./factory.js")).toBe(false);
    expect(isStorageEngineModule("../engine/factory.js")).toBe(false);
    expect(isStorageEngineModule("factory.js")).toBe(false);
  });

  it("rejects blanks and non-strings", () => {
    expect(isStorageEngineModule("")).toBe(false);
    expect(isStorageEngineModule("   ")).toBe(false);
    expect(isStorageEngineModule(undefined)).toBe(false);
    expect(isStorageEngineModule({ module: "/x.js" })).toBe(false);
  });

  it("isStorageEngineDeclaration wraps it: `{ module }` and nothing less", () => {
    expect(isStorageEngineDeclaration({ module: "/store-engine/factory.js" })).toBe(true);
    expect(isStorageEngineDeclaration({ module: "./factory.js" })).toBe(false);
    expect(isStorageEngineDeclaration({})).toBe(false);
    expect(isStorageEngineDeclaration("/store-engine/factory.js")).toBe(false);
    expect(isStorageEngineDeclaration(null)).toBe(false);
  });
});

describe("the engine field participates in the declaration exactly as backend/durability do", () => {
  const ENGINE = "/store-engine/factory.js";
  const OTHER = "/store-engine/other-factory.js";

  it("both silent → NO engine: absence is how the toolkit's own store is spelled", () => {
    expect(resolveStorageDeclaration(undefined, undefined).engine).toBeUndefined();
    expect(resolveStorageDeclaration({}, {})).toEqual({ backend: "opfs", durability: "relaxed" });
  });

  it("a wire engine is honoured when the registry is silent (the dynamic-preference path)", () => {
    expect(resolveStorageDeclaration({}, { engine: { module: ENGINE } })).toEqual({
      backend: "opfs",
      durability: "relaxed",
      engine: { module: ENGINE },
    });
  });

  it("a static engine is honoured when the wire is silent — an empty wire {} NEVER conflicts", () => {
    expect(resolveStorageDeclaration({ engine: { module: ENGINE } }, {})).toEqual({
      backend: "opfs",
      durability: "relaxed",
      engine: { module: ENGINE },
    });
  });

  it("the same module on both sources is idempotent; a DIFFERENT module refuses typed", () => {
    expect(resolveStorageDeclaration({ engine: { module: ENGINE } }, { engine: { module: ENGINE } }).engine).toEqual({
      module: ENGINE,
    });
    expect(() => resolveStorageDeclaration({ engine: { module: ENGINE } }, { engine: { module: OTHER } })).toThrow(
      StorageDeclarationRefusedError,
    );
  });

  it("a later declaration naming a DIFFERENT engine than the bound one is refused — identity, not preference", () => {
    // A store's datadir belongs to the engine that wrote it, so this is the same immutability the other
    // fields have: an engine change mints a fresh store under a fresh path, it never rehomes this one.
    const bound = { backend: "opfs", durability: "relaxed", engine: { module: ENGINE } } as const;
    expect(() => assertStorageDeclarationCompatible(bound, { engine: { module: ENGINE } })).not.toThrow();
    expect(() => assertStorageDeclarationCompatible(bound, { engine: { module: OTHER } })).toThrow(
      StorageDeclarationRefusedError,
    );
    // A store bound to the BUILT-IN engine, handed a module: still a refusal, naming what it is bound to.
    expect(() =>
      assertStorageDeclarationCompatible({ backend: "opfs", durability: "relaxed" }, { engine: { module: ENGINE } }),
    ).toThrow(/built-in store engine/);
  });

  it("an incoming declaration with NO engine is 'no opinion', never an assertion of the built-in engine", () => {
    // Absence is the built-in engine's spelling, so it cannot double as an explicit contradiction — the
    // consumer that switches back mints a fresh store rather than redeclaring this one.
    const bound = { backend: "opfs", durability: "relaxed", engine: { module: ENGINE } } as const;
    expect(() => assertStorageDeclarationCompatible(bound, {})).not.toThrow();
    expect(() => assertStorageDeclarationCompatible(bound, { durability: "relaxed" })).not.toThrow();
  });
});
