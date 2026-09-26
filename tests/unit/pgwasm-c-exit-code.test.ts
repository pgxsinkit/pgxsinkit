// Began as a copy of `@electric-sql/pglite`'s tests (taken under its PostgreSQL License option,
// © ElectricSQL — see NOTICE). Owned outright (ADR-0062); compatibility with PGlite is an anti-goal.

import { afterEach, describe, expect, it } from "bun:test";

import { closeTestPgwasms, createTestPgwasm } from "./support/pgwasm";

afterEach(closeTestPgwasms);

// Postgres' single-user mode reports a successful start by exiting with 99, which the Emscripten runtime
// writes onto `process.exitCode`; under Bun that would fail an otherwise green process. (Bun ignores an
// assignment of `undefined`, so an unset exit code compares as 0.)
describe("the host's exit code", () => {
  it("is untouched by a boot, statements and a close", async () => {
    const before = process.exitCode ?? 0;
    const db = await createTestPgwasm({ fresh: true });
    expect(process.exitCode ?? 0).toEqual(before);
    await db.exec("CREATE TABLE IF NOT EXISTS test (id SERIAL PRIMARY KEY, name TEXT);");
    expect(process.exitCode ?? 0).toEqual(before);
    await db.close();
    expect(process.exitCode ?? 0).toEqual(before);
  });

  it("keeps a value the host set", async () => {
    const before = process.exitCode ?? 0;
    process.exitCode = 42;
    try {
      const db = await createTestPgwasm();
      await db.close();
      expect(process.exitCode).toBe(42);
    } finally {
      process.exitCode = before;
    }
  });
});
