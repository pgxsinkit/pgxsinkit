import { afterAll, afterEach, beforeEach } from "bun:test";

import { closeOpenTestPGlites, closeTestScopedPGlites, markTestScope } from "./pglite";

// Global test setup (bunfig `[test].preload`). `bun test` runs files sequentially in one process and
// never frees an un-closed PGlite's (multi-MB) WASM heap — so across a many-file run the heaps pile up
// and every later boot/query slows down (and bun force-exits rc=99 on the leak). These hooks close each
// instance the support helpers hand out, keeping the whole run flat without a per-file `afterEach`.
//
// Cleanup is test-SCOPED: a `beforeAll`/module-scope store shared across a file's tests must outlive
// any single test, so we snapshot what's open at each test start and close only what that test opened;
// shared stores are closed once at `afterAll`.
beforeEach(markTestScope);
afterEach(closeTestScopedPGlites);
afterAll(closeOpenTestPGlites);
