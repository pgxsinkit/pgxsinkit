// Began as a copy of `@electric-sql/pglite-tools` (taken under PGlite's PostgreSQL License option,
// © ElectricSQL — see NOTICE). Owned outright (ADR-0062); compatibility with PGlite is an anti-goal.

import type { Pgwasm } from "@pgxsinkit/pgwasm";
import { PgwasmClosedError, PgwasmFailedError } from "@pgxsinkit/pgwasm";
import { protocol, type PgwasmProtocol } from "@pgxsinkit/pgwasm/protocol";

import { createPgDumpModule, pgDumpWasm } from "./artefacts";
import { PgDumpError, PgDumpSessionError, PgDumpUnsupportedBuildError } from "./errors";
import { ByteQueue, FrontendFramer } from "./framing";
import { dumpFile } from "./output";
import { readSession, restoreSession, transactionStatus, type SessionState } from "./session";
import { compileModule } from "./wasm";

export interface PgDumpOptions {
  /** The database to dump. Its Postgres build must reply synchronously (`capabilities.synchronousExchange`). */
  readonly pg: Pgwasm;
  /**
   * More pg_dump arguments (https://www.postgresql.org/docs/current/app-pgdump.html), placed before the
   * fixed ones, which win: `-U postgres --inserts -j 1 -f <output>`.
   */
  readonly args?: readonly string[];
  /** The returned file's name. Defaults to `dump.sql`. */
  readonly fileName?: string;
}

/** Where pg_dump's own filesystem has it; `argv[0]`, which pg_dump resolves to find itself. */
const PG_DUMP_PATH = "/bin/pg_dump";
/** The output file, in pg_dump's own filesystem, read back once it exits. */
const OUTPUT_PATH = "/tmp/out.sql";

const FIXED_ARGS: readonly string[] = [
  // The user named in the startup packet; the session already runs as the database's own role.
  "-U",
  "postgres",
  // INSERT statements rather than COPY … FROM stdin, so `exec()` can run the dump back.
  "--inserts",
  // One job: there is one session and no second connection.
  "-j",
  "1",
  // A file in pg_dump's filesystem, which pgDump returns.
  "-f",
  OUTPUT_PATH,
];

interface PgDumpRun {
  /** pg_dump's exit status; null when it crashed. */
  readonly exitCode: number | null;
  readonly crash: unknown;
  readonly stderr: string;
  /** The output file, when pg_dump exited 0 and wrote one. */
  readonly output: Uint8Array | undefined;
  /** The first failure of the database's wire, which pg_dump only saw as a closed connection. */
  readonly wireFailure: { readonly error: unknown } | undefined;
}

/**
 * Run pg_dump once, in a fresh module over the compiled WebAssembly, its socket bridged to the database's
 * wire. pg_dump's WebAssembly calls the write and read callbacks synchronously: a whole frontend message
 * goes out on the build's synchronous exchange, whose reply is queued before the write callback returns,
 * for the read callback to hand back.
 */
async function runPgDump(wire: PgwasmProtocol, wasm: WebAssembly.Module, args: readonly string[]): Promise<PgDumpRun> {
  let stderr = "";
  let rejectInstantiation: (error: unknown) => void = () => undefined;
  const instantiationFailed = new Promise<never>((_, reject) => {
    rejectInstantiation = reject;
  });
  const module = await Promise.race([
    createPgDumpModule({
      thisProgram: PG_DUMP_PATH,
      noExitRuntime: false,
      // A stdin that is always at EOF, so a browser never prompts.
      stdin: () => null,
      print: () => undefined,
      printErr: (text) => {
        stderr += `${text}\n`;
      },
      instantiateWasm: (imports, successCallback) => {
        // A throw from `successCallback` (the module's own start-up) must settle the race too, or pgDump
        // would wait forever while holding the session.
        WebAssembly.instantiate(wasm, imports)
          .then((instance) => successCallback(instance, wasm))
          .catch(rejectInstantiation);
        return {};
      },
      preRun: [
        (mod) => {
          mod.ENV["HOME"] = "/home/postgres";
          mod.ENV["USER"] = "postgres";
          mod.ENV["LOGNAME"] = "postgres";
          // pg_dump looks for its own executable when it starts, and warns when it finds none.
          mod.FS.mkdirTree(PG_DUMP_PATH.slice(0, PG_DUMP_PATH.lastIndexOf("/")));
          mod.FS.writeFile(PG_DUMP_PATH, "");
          mod.FS.chmod(PG_DUMP_PATH, 0o555);
        },
      ],
    }),
    instantiationFailed,
  ]);

  const framer = new FrontendFramer();
  const replies = new ByteQueue();
  const exchanges: Promise<void>[] = [];
  let wireFailure: { error: unknown } | undefined;
  const write = module.addFunction((pointer, length) => {
    for (const message of framer.push(module.HEAPU8.subarray(pointer, pointer + length))) {
      // pg_dump only reads: nothing to persist. The build's synchronous exchange has queued the whole
      // reply before this returns; a rejection is kept for after pg_dump exits.
      const exchange = wire.execProtocolRawStream(message, {
        persist: false,
        onRawData: (chunk) => replies.push(chunk),
      });
      exchanges.push(
        exchange.catch((error: unknown) => {
          wireFailure ??= { error };
        }),
      );
    }
    return length;
  }, "iii");
  const read = module.addFunction(
    (pointer, maxLength) => replies.read(module.HEAPU8.subarray(pointer, pointer + maxLength)),
    "iii",
  );
  module._pgl_set_rw_cbs(read, write);

  let exitCode: number | null;
  let crash: unknown;
  try {
    exitCode = module.callMain([...args, ...FIXED_ARGS]);
  } catch (error) {
    exitCode = null;
    crash = error;
  }
  await Promise.all(exchanges);

  let output: Uint8Array | undefined;
  if (exitCode === 0 && module.FS.analyzePath(OUTPUT_PATH).exists) {
    try {
      output = module.FS.readFile(OUTPUT_PATH);
    } catch (error) {
      crash = error;
    }
  }
  return { exitCode, crash, stderr, output, wireFailure };
}

function failureOf(run: PgDumpRun): Error | undefined {
  if (run.wireFailure !== undefined) {
    const { error } = run.wireFailure;
    return error instanceof Error ? error : new Error(String(error));
  }
  if (run.exitCode === null) {
    return new PgDumpError(
      `pg_dump crashed: ${run.crash instanceof Error ? run.crash.message : String(run.crash)}`,
      null,
      run.stderr,
      { cause: run.crash },
    );
  }
  if (run.exitCode !== 0) {
    return new PgDumpError(
      `pg_dump failed with exit code ${run.exitCode}${run.stderr === "" ? "" : `: ${run.stderr.trim()}`}`,
      run.exitCode,
      run.stderr,
    );
  }
  if (run.output === undefined) {
    return new PgDumpError(
      "pg_dump exited without writing a single output file (the directory format writes several, which " +
        "pgDump does not return)",
      0,
      run.stderr,
      run.crash === undefined ? undefined : { cause: run.crash },
    );
  }
  return undefined;
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * What to throw when the session could not be restored after pg_dump. When pg_dump had failed as well,
 * its failure is not dropped: it is the cause of the error thrown.
 */
function restoreError(restoreFailure: unknown, dumpFailure: { readonly error: unknown } | undefined): unknown {
  // A failed or closed database fails every exchange; that is the error to report.
  if (restoreFailure instanceof PgwasmFailedError || restoreFailure instanceof PgwasmClosedError) {
    return restoreFailure;
  }
  const sessionError = restoreFailure instanceof PgDumpSessionError ? restoreFailure : undefined;
  if (dumpFailure === undefined) {
    return (
      sessionError ??
      new PgDumpSessionError("The database's session could not be restored after pg_dump.", [], {
        cause: restoreFailure,
      })
    );
  }
  const message =
    sessionError?.message ??
    `The database's session could not be restored after pg_dump (${messageOf(restoreFailure)}).`;
  return new PgDumpSessionError(
    `${message} pg_dump itself had failed: ${messageOf(dumpFailure.error)}`,
    sessionError?.unrestored ?? [],
    { cause: dumpFailure.error },
  );
}

/**
 * Dump a database with pg_dump, as a `File`: by default a plain SQL script of INSERT statements, which
 * `exec()` runs back into an empty database.
 *
 * pg_dump runs on the database's own session, which it holds for the whole dump: no query, transaction
 * or other dump of this database runs until it is done, and none can be running inside a transaction
 * block when it starts ({@link PgDumpSessionError}). Afterwards the session is as it was: pg_dump's
 * transaction ended, its prepared statements gone, every setting it changed restored. It must not be
 * called inside a `pg.transaction()` callback: it would wait forever for the session that transaction
 * holds.
 *
 * @throws {PgDumpUnsupportedBuildError} the database's build cannot run pg_dump (checked first).
 * @throws {PgDumpError} pg_dump failed; it carries the exit code and standard error.
 * @throws {PgDumpSessionError} the session was inside a transaction block, or could not be restored
 *   (then, when pg_dump had failed too, its failure is the cause).
 */
export async function pgDump({ pg, args = [], fileName = "dump.sql" }: PgDumpOptions): Promise<File> {
  const wire = protocol(pg);
  if (!wire.capabilities.synchronousExchange) throw new PgDumpUnsupportedBuildError(pg.build.name);
  const wasm = compileModule(pgDumpWasm);

  return await wire.runExclusiveSession(async () => {
    if ((await transactionStatus(wire)) !== "I") {
      throw new PgDumpSessionError(
        "The database's session is inside a transaction block; pg_dump opens and ends its own transaction, " +
          "so it runs only between transactions.",
      );
    }
    const before: SessionState = await readSession(wire);

    let outcome: { readonly run: PgDumpRun } | { readonly failure: unknown };
    try {
      outcome = { run: await runPgDump(wire, await wasm, args) };
    } catch (failure) {
      outcome = { failure };
    }

    try {
      await restoreSession(wire, before);
    } catch (restoreFailure) {
      const dumpFailure = "failure" in outcome ? { error: outcome.failure } : failureOf(outcome.run);
      throw restoreError(restoreFailure, dumpFailure instanceof Error ? { error: dumpFailure } : dumpFailure);
    }

    if ("failure" in outcome) throw outcome.failure;
    const failure = failureOf(outcome.run);
    if (failure !== undefined) throw failure;
    return dumpFile(outcome.run.output ?? new Uint8Array(), fileName);
  });
}
