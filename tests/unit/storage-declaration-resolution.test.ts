import { describe, expect, it } from "bun:test";
// ADR-0050 (storage declaration transport): the PURE per-field resolution of a store's storage declaration
// from its two sources — the registry-attached STATIC declaration (authoritative) and the tab's WIRE
// declaration (honoured only where the registry is silent). The rules under test:
//   - An UNSET field means "no opinion" and can never conflict — it defers to the other source, else the
//     capability default (`backend: "opfs"`, `durability: "relaxed"`).
//   - An EXPLICIT field on both sources that DISAGREES is a typed refusal (never a silent old value).
//   - `assertStorageDeclarationCompatible` re-checks a LATER declaration against the already-bound
//     resolution: explicit mismatch refuses, unset/equal is idempotent.

import {
  assertStorageDeclarationCompatible,
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
