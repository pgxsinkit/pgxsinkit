// `@pgxsinkit/client/testing` — the ONLY sanctioned door to a memory-backed store (ADR-0036 decision 3).
//
// pgxsinkit's durability semantics assume a persisted store, so the production API surface cannot express a
// memory store: `createSyncClient`/`createClientPGlite` take a plain `storePath` whose backend is derived
// (IndexedDB / filesystem), and the BYO seam refuses a provably non-persistent instance. Genuine memory
// stores are needed in exactly two of OUR places — the unit-test lane (speed + isolation) and the export
// machinery's throwaway clone — and this subpath serves the first: an import whose NAME says what it is, so
// reaching a memory store is always a visible, deliberate act. App bundles never import it, so the whole
// module (and any mention of memory) tree-shakes away.
//
// The helpers mint plain options objects that ALSO carry the module-internal {@link TEST_STORE_BACKEND}
// marker at runtime — invisible in the public return type. Consumers SPREAD them into the client options:
//
//   createSyncClient({ ...memoryStoreForTests("my-test"), registry, electricUrl, batchWriteUrl })
//   createSyncClient({ ...testStoreAcknowledgment(), pgliteInstance, registry, electricUrl, batchWriteUrl })

import { TEST_STORE_BACKEND } from "./store-path";

/**
 * The public shape of {@link memoryStoreForTests}'s output: just a `storePath`. The internal backend marker
 * rides alongside at runtime but is deliberately absent from this type, so no production type mentions memory.
 */
export interface MemoryStoreForTests {
  storePath: string;
}

/**
 * Mint client store options that resolve to a scheme-selected in-memory store — the unit-test / ephemeral
 * lane (ADR-0036 decision 3). Spread the result into `createSyncClient` (or `defineSyncWorker` where its
 * options accept `storePath`): the client reads the internal marker and selects the memory backend.
 *
 * DURABILITY CAVEAT: a memory store is session-scoped, so pgxsinkit's persistent-retention guarantee and the
 * optimistic Mutation journal's durability window are BOTH void on it — everything is lost when the instance
 * closes. Use it only for tests and throwaway/ephemeral flows, never for anything a user expects to persist.
 */
export function memoryStoreForTests(storePath: string): MemoryStoreForTests {
  // The marker is a symbol-keyed property, so it survives an object spread but is invisible to the public
  // type and to `Object.keys`. Cast because the return TYPE deliberately hides it (ADR-0036 decision 3).
  return { storePath, [TEST_STORE_BACKEND]: "memory" } as MemoryStoreForTests;
}

/**
 * Mint an options fragment that ACKNOWLEDGES a caller-owned test store, bypassing the BYO refusal
 * (ADR-0036 decision 4) WITHOUT selecting a backend — for when the test supplies its own non-persistent
 * PGlite via `pgliteInstance` / `precreatedPglite`. Spread it alongside that option.
 *
 * Same DURABILITY CAVEAT as {@link memoryStoreForTests}: only for tests / throwaway flows; a non-persistent
 * store voids the retention + journal durability guarantees.
 */
export function testStoreAcknowledgment(): Record<never, never> {
  // An empty public shape carrying only the internal marker — nothing for a consumer to configure.
  return { [TEST_STORE_BACKEND]: "acknowledged" } as Record<never, never>;
}
