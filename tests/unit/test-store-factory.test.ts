import { afterEach, describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";

import { resolveTestStoreFactory, TEST_STORE_FACTORY_ENV } from "../support/pglite";

// The store seam's resolution logic (see `tests/support/pglite.ts`): unset means PGlite, exactly as
// before; set means that module builds the suite's stores instead. Only the RESOLUTION is under test —
// no store is built here, and the fixture the variable points at cannot build one.

const fixtureModule = fileURLToPath(new URL("../support/test-store-factory-fixture.ts", import.meta.url));

// This file drives the variable itself, so it must leave the process exactly as it found it — the same
// suite is run end to end with the variable already set, and that lane must not be disturbed.
const original = process.env[TEST_STORE_FACTORY_ENV];

afterEach(() => {
  if (original === undefined) delete process.env[TEST_STORE_FACTORY_ENV];
  else process.env[TEST_STORE_FACTORY_ENV] = original;
});

describe("test store factory resolution", () => {
  it("resolves to the default PGlite path when the variable is unset", () => {
    delete process.env[TEST_STORE_FACTORY_ENV];
    expect(resolveTestStoreFactory()).toBeUndefined();
  });

  it("resolves the module the variable names", () => {
    process.env[TEST_STORE_FACTORY_ENV] = fixtureModule;
    const factory = resolveTestStoreFactory();
    expect(factory).toBeDefined();
    expect(typeof factory?.createFresh).toBe("function");
    expect(typeof factory?.createFromDump).toBe("function");
    // The cache-key prefix is what keeps two engines' schema snapshots off one filename.
    expect(factory?.cacheKeyPrefix).toBe("pgxsinkit-fixture-schema-");
    expect(factory?.cacheIdentity).toBe("test-store-factory-fixture@1");
  });

  it("fails loudly when the named module is not a factory", () => {
    process.env[TEST_STORE_FACTORY_ENV] = fileURLToPath(new URL("../support/claims.ts", import.meta.url));
    expect(() => resolveTestStoreFactory()).toThrow(/createFresh/);
  });
});
