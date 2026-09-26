import type { BuildIdentity, FilesystemKind } from "./build/seam";
import type { QueryOptions } from "./interface";
import type { DatabaseError } from "./protocol/wire/messages";

/** The base of every error pgwasm itself raises (SQL errors are {@link DatabaseError}). */
export class PgwasmError extends Error {
  override name = "PgwasmError";
}

/** A `dataDir` pgwasm does not accept: an unknown scheme, a bare path, or `dataDir` with `fs`. */
export class UnsupportedDataDirError extends PgwasmError {
  override name = "UnsupportedDataDirError";
  readonly dataDir: string;

  constructor(dataDir: string, reason: string) {
    super(`Unsupported dataDir "${dataDir}": ${reason}`);
    this.dataDir = dataDir;
  }
}

/** An `opfs-ahp://` dataDir: that filesystem is gone (ADR-0062 decision 6). */
export class OpfsAhpRemovedError extends UnsupportedDataDirError {
  override name = "OpfsAhpRemovedError";
  /** Where the OPFS store lives now. */
  readonly replacement = "@pgxsinkit/pgwasm/opfs";

  constructor(dataDir: string) {
    super(
      dataDir,
      "the opfs-ahp filesystem has been removed; the OPFS store is @pgxsinkit/pgwasm/opfs, passed in " +
        "explicitly as the `fs` option",
    );
  }
}

/** The build does not mount the requested kind of storage. */
export class UnsupportedFilesystemError extends PgwasmError {
  override name = "UnsupportedFilesystemError";
  readonly kind: FilesystemKind;
  readonly build: string;

  constructor(kind: FilesystemKind, build: BuildIdentity, supported: readonly FilesystemKind[]) {
    super(
      `The "${build.name}" Postgres build does not support ${kind} storage (it supports: ${supported.join(", ")}).`,
    );
    this.kind = kind;
    this.build = build.name;
  }
}

/** The build needs a cross-origin-isolated context, and this one is not. */
export class CrossOriginIsolationRequiredError extends PgwasmError {
  override name = "CrossOriginIsolationRequiredError";

  constructor(build: BuildIdentity) {
    super(
      `The "${build.name}" Postgres build needs a cross-origin-isolated context (SharedArrayBuffer); serve the ` +
        "page with Cross-Origin-Opener-Policy: same-origin and Cross-Origin-Embedder-Policy: require-corp.",
    );
  }
}

/** A server extension compiled for another build. */
export class ExtensionBuildMismatchError extends PgwasmError {
  override name = "ExtensionBuildMismatchError";

  constructor(extension: string, extensionBuild: string, build: BuildIdentity) {
    super(
      `The "${extension}" extension was compiled for the "${extensionBuild}" Postgres build and cannot load into ` +
        `the "${build.name}" build.`,
    );
  }
}

/** The build a data directory (or a Store backup) records. `"unmarked"` predates build markers. */
export type RecordedBuild = { readonly build: string; readonly dataFormat: number } | "unmarked";

function describeRecorded(recorded: RecordedBuild): string {
  return recorded === "unmarked"
    ? "an unmarked data directory (created before builds were recorded, by the C build)"
    : `the "${recorded.build}" Postgres build (data format ${recorded.dataFormat})`;
}

/**
 * A data directory or Store backup made by another Postgres build. A store's build is fixed when it is
 * created (ADR-0063 build permanence); nothing was written.
 */
export class BuildMismatchError extends PgwasmError {
  override name = "BuildMismatchError";
  readonly expected: { readonly build: string; readonly dataFormat: number };
  readonly found: RecordedBuild;
  readonly source: "data-directory" | "backup";

  constructor(build: BuildIdentity, found: RecordedBuild, source: "data-directory" | "backup") {
    const what = source === "backup" ? "This Store backup" : "This data directory";
    super(
      `${what} was created by ${describeRecorded(found)} and cannot be opened with the "${build.name}" build. A ` +
        "store's Postgres build is fixed when it is created: open it with that build, or destroy the store and " +
        "re-sync it.",
    );
    this.expected = { build: build.name, dataFormat: build.dataFormat };
    this.found = found;
    this.source = source;
  }
}

/** A data directory or backup of the same build in a data format this release does not read. */
export class DataFormatMismatchError extends PgwasmError {
  override name = "DataFormatMismatchError";
  readonly expected: number;
  readonly found: number;
  readonly source: "data-directory" | "backup";

  constructor(build: BuildIdentity, found: number, source: "data-directory" | "backup") {
    super(
      `This ${source === "backup" ? "Store backup" : "data directory"} is in data format ${found} of the ` +
        `"${build.name}" Postgres build; this release of the build reads format ${build.dataFormat}.`,
    );
    this.expected = build.dataFormat;
    this.found = found;
    this.source = source;
  }
}

/** A build marker that cannot be read: corrupt, or written by a newer pgwasm. Nothing was written. */
export class BuildMarkerUnreadableError extends PgwasmError {
  override name = "BuildMarkerUnreadableError";
  readonly raw: string;

  constructor(raw: string, reason: string) {
    super(`The data directory's build marker cannot be read (${reason}): ${JSON.stringify(raw)}`);
    this.raw = raw;
  }
}

/** `loadDataDir` was given for a data directory that already holds a database. */
export class DataDirExistsError extends PgwasmError {
  override name = "DataDirExistsError";

  constructor() {
    super("The data directory already holds a database; a Store backup restores only into an empty one.");
  }
}

/** A Store backup that cannot be restored: not a tarball, or a member outside the data directory. */
export class BackupFormatError extends PgwasmError {
  override name = "BackupFormatError";
}

/** The storage is held by another open database (an IndexedDB store open in another context). */
export class StorageInUseError extends PgwasmError {
  override name = "StorageInUseError";

  constructor(message: string) {
    super(message);
  }
}

/** The database is closing or closed. */
export class PgwasmClosedError extends PgwasmError {
  override name = "PgwasmClosedError";

  constructor(state: "closing" | "closed") {
    super(`pgwasm is ${state}`);
  }
}

/**
 * The Postgres build failed underneath a statement (an exception that is not an SQL error: a storage
 * failure thrown into the engine, a PANIC's abort). The instance is failed: every later statement
 * throws this same error, and `close()` releases resources and rejects with it.
 */
export class PgwasmFailedError extends PgwasmError {
  override name = "PgwasmFailedError";
}

/** A feature the build does not have (see its capabilities). */
export class UnsupportedFeatureError extends PgwasmError {
  override name = "UnsupportedFeatureError";
}

/** An SQL error from a query, with the query that raised it. */
export interface QueryError extends DatabaseError {
  query: string | undefined;
  params: readonly unknown[] | undefined;
  queryOptions: QueryOptions | undefined;
}

/** Attach the query to the SQL error it raised. */
export function makeQueryError(data: {
  error: DatabaseError;
  query: string;
  params: readonly unknown[] | undefined;
  options: QueryOptions | undefined;
}): QueryError {
  return Object.assign(data.error, { query: data.query, params: data.params, queryOptions: data.options });
}
