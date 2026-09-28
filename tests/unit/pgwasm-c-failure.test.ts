// Began as a copy of `@electric-sql/pglite`'s tests (taken under its PostgreSQL License option,
// © ElectricSQL — see NOTICE). Owned outright (ADR-0062); compatibility with PGlite is an anti-goal.

import { afterEach, describe, expect, it } from "bun:test";

import { createCBuild } from "../../packages/pgwasm-c/src";
import { ARTEFACT_FILES } from "../../packages/pgwasm-c/src/artefact-pins";
import { createPgwasm, PgwasmFailedError } from "../../packages/pgwasm/src";
import { ERRNO_CODES } from "../../packages/pgwasm/src/fs";
import { protocol, serialize } from "../../packages/pgwasm/src/protocol";
import { closeTestPgwasms, createTestPgwasm } from "./support/pgwasm";
import { MemoryVfs } from "./support/pgwasm-memory-vfs";
import { rejectionOf } from "./support/rejection";

afterEach(closeTestPgwasms);

/**
 * A filesystem whose next write to a WAL segment throws an error WITHOUT an errno code — the way a
 * storage that is not errno-aware (a DOMException from OPFS, a plain Error) reports a transient platform
 * failure.
 */
class FlakyWalVfs extends MemoryVfs {
  #walWriteFailure: { error: unknown } | undefined;
  walWriteFailed = false;

  failNextWalWrite(error: unknown): void {
    this.#walWriteFailure = { error };
  }

  protected override beforeWrite(path: string): void {
    if (this.#walWriteFailure && path.startsWith("/pg_wal/")) {
      const { error } = this.#walWriteFailure;
      this.#walWriteFailure = undefined;
      this.walWriteFailed = true;
      throw error;
    }
  }
}

describe("an exception that is not a Postgres error inside the C build's main loop", () => {
  it("fails the commit whose WAL write threw an uncoded error, then every later statement, without hanging", async () => {
    const fs = new FlakyWalVfs();
    const pg = await createTestPgwasm({ fs });
    await pg.exec("CREATE TABLE t (id int)");

    fs.failNextWalWrite(new Error("transient platform write failure"));
    const commitError = await rejectionOf(pg.query("INSERT INTO t VALUES (1)"));

    // The filesystem adapter reported the uncoded failure to Postgres as EIO...
    expect(fs.walWriteFailed).toBe(true);
    expect(fs.recentSyscallErrors).toContainEqual(
      expect.objectContaining({ op: "write", errno: ERRNO_CODES.EIO, message: "transient platform write failure" }),
    );
    // ...Postgres treats a failed WAL write as a PANIC, and the commit fails with an error that names it.
    expect(commitError).toBeInstanceOf(PgwasmFailedError);
    expect(commitError.message).toMatch(/could not write to log file .*: I\/O error/);

    // The instance is failed: every later statement throws that failure at once.
    expect(await rejectionOf(pg.query("SELECT 1"))).toBe(commitError);
    expect(await rejectionOf(pg.exec("SELECT 1"))).toBe(commitError);
    expect(pg.ready).toBe(false);

    // Close releases the filesystem and reports the failure it closed on.
    expect(await rejectionOf(pg.close())).toBe(commitError);
    expect(pg.closed).toBe(true);
    expect(fs.closed).toBe(true);
  });

  it("fails the instance when a callback throws into the running build", async () => {
    const pg = await createTestPgwasm();
    const failure = new Error("consumer callback failure");
    // Enough output that Postgres flushes its send buffer while the statement is still executing, so the
    // callback throws inside the main loop.
    const message = serialize.query("SELECT repeat('x', 100000) FROM generate_series(1, 4)");
    const streamError = await rejectionOf(
      protocol(pg).execProtocolRawStream(message, {
        onRawData: () => {
          throw failure;
        },
      }),
    );
    expect(streamError).toBeInstanceOf(PgwasmFailedError);
    expect(streamError.message).toContain("Error: consumer callback failure");
    expect((streamError as Error & { cause?: unknown }).cause).toBe(failure);
    expect(await rejectionOf(pg.query("SELECT 1"))).toBe(streamError);
    expect(await rejectionOf(pg.close())).toBe(streamError);
    expect(pg.closed).toBe(true);
  });
});

describe("a filesystem bundle of the wrong size", () => {
  // Emscripten 6's file packager swallows a throw from getPreloadedPackage (an unhandled rejection), so the
  // host checks the bundle before the glue runs; the boot must fail with this error, not a later FS one.
  it("fails the boot with the size mismatch before the glue runs", async () => {
    const build = createCBuild({ fsBundle: new Blob([new Uint8Array(1)]) });
    const error = await rejectionOf(createPgwasm({ build }));
    expect(error.message).toBe(`Invalid filesystem bundle size: 1 !== ${ARTEFACT_FILES["postgres.data"].bytes}`);
  });
});
