import { PgwasmError, UnsupportedFeatureError } from "@pgxsinkit/pgwasm";

/**
 * The database's Postgres build cannot run pg_dump: its wire does not deliver a reply inside the call
 * that sends the message (`capabilities.synchronousExchange` is false). pg_dump's WebAssembly calls its
 * socket callbacks synchronously and needs each reply before the callback returns. Nothing was loaded
 * or run.
 */
export class PgDumpUnsupportedBuildError extends UnsupportedFeatureError {
  override name = "PgDumpUnsupportedBuildError";
  /** The build's name. */
  readonly build: string;

  constructor(build: string) {
    super(
      `pg_dump needs a Postgres build whose wire replies synchronously (capabilities.synchronousExchange); the ` +
        `"${build}" build does not.`,
    );
    this.build = build;
  }
}

/** pg_dump exited with a failure, or crashed (`exitCode` null). */
export class PgDumpError extends PgwasmError {
  override name = "PgDumpError";
  /** pg_dump's exit status; `null` when it crashed instead of exiting. */
  readonly exitCode: number | null;
  /** Everything pg_dump wrote to standard error. */
  readonly stderr: string;

  constructor(message: string, exitCode: number | null, stderr: string, options?: ErrorOptions) {
    super(message, options);
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

/**
 * The database session was not in a state to dump from, or could not be put back as it was after the
 * dump. pg_dump runs on the database's own session: before it, the session must be outside any
 * transaction block (pg_dump opens and ends its own); after it, pg_dump's transaction is ended and every
 * session setting it changed is restored. `unrestored` names the settings that still differ.
 */
export class PgDumpSessionError extends PgwasmError {
  override name = "PgDumpSessionError";
  readonly unrestored: readonly string[];

  constructor(message: string, unrestored: readonly string[] = [], options?: ErrorOptions) {
    super(message, options);
    this.unrestored = unrestored;
  }
}
