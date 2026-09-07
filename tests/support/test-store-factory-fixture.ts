import type { PGliteInterface } from "@electric-sql/pglite";

import type { TestStoreFactory } from "./pglite";

// A minimal, engine-less {@link TestStoreFactory} — the module `tests/unit/test-store-factory.test.ts`
// points `PGXSINKIT_TEST_STORE_FACTORY` at to prove the seam RESOLVES. It builds no store: the
// resolution test never calls the two create methods, and a factory that could build one would drag a
// second engine into the unit suite. Kept require-loadable (no top-level await), which is the contract's
// own requirement of every factory module.
const fixture: TestStoreFactory = {
  cacheKeyPrefix: "pgxsinkit-fixture-schema-",
  cacheIdentity: "test-store-factory-fixture@1",
  createFresh(): Promise<PGliteInterface> {
    throw new Error("the resolution fixture builds no store");
  },
  createFromDump(): Promise<PGliteInterface> {
    throw new Error("the resolution fixture builds no store");
  },
};

export default fixture;
