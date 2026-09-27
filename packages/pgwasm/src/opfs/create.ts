import type { PostgresBuild } from "../build/seam";
import { registerStrictSync, strictSyncOf } from "../core/internals";
import { createPgwasm } from "../create";
import { UnsupportedFeatureError } from "../errors";
import type { Extensions, Pgwasm, PgwasmOptions, PgwasmWithExtensions } from "../interface";
import { OpfsRepackedPort } from "./opfs-port";
import type { OpfsDirectoryHandle } from "./opfs-port";
import { openOpfsRepackedFsForPort } from "./opfs-repacked-fs";
import type { RepackedFilesystemOptions } from "./opfs-repacked-fs";

/** The database options `createOpfsPgwasm` passes through: all but the ones the store owns. */
export type OpfsPgwasmHostOptions<E extends Extensions = Record<never, never>> = Omit<
  PgwasmOptions<E>,
  "build" | "dataDir" | "fs" | "relaxedDurability"
>;

export interface CreateOpfsPgwasmOptions<
  E extends Extensions = Record<never, never>,
> extends RepackedFilesystemOptions {
  /** The Postgres build to run, e.g. `cBuild` from `@pgxsinkit/pgwasm-c`. */
  readonly build: PostgresBuild;
  /** Dedicated directory owned in full by this store. */
  readonly directory: OpfsDirectoryHandle;
  /** Database options other than the store-owned `build`, `dataDir`, `fs` and `relaxedDurability`. */
  readonly pgwasm?: OpfsPgwasmHostOptions<E>;
  /**
   * Optional progress callback for the two long, otherwise-invisible steps of an OPFS-repacked create.
   * Called once per phase, in order, and only on the success path:
   *
   * - `"store-opened"` — the store's sync access handles are acquired and the repacked filesystem is open.
   *   Everything before this is handle acquisition, which is where a create that never returns stalls.
   * - `"pgwasm-ready"` — the database's own boot (WASM instantiation, initdb or catalog open) has completed.
   *
   * Diagnosability only: it carries no policy, must not throw, and a create's outcome never depends on it.
   * The host uses it to stamp a boot rail, so a stalled create is attributable to a phase rather than
   * silent.
   */
  readonly onPhase?: (phase: OpfsCreatePhase) => void;
}

/** The create phases {@link CreateOpfsPgwasmOptions.onPhase} reports, in the order they occur. */
export type OpfsCreatePhase = "store-opened" | "pgwasm-ready";

/**
 * A database on an OPFS-repacked store: a plain pgwasm database. Its one strict operation, reserved for
 * the sync layer above the store, is {@link strictSync}.
 */
export type OpfsPgwasm<E extends Extensions = Record<never, never>> = PgwasmWithExtensions<E>;

/**
 * Construct the only supported OPFS-repacked/pgwasm pairing.
 *
 * pgwasm always awaits the filesystem sync (`relaxedDurability: false`). Physical durability is selected
 * once, here, by the store's `durability` option and is never delegated to the database option. A
 * strict sync completes successful database initialization before return. Closing the database closes
 * the store: its build releases the filesystem (`closeFs`) on every close, a failed one included.
 */
export async function createOpfsPgwasm<E extends Extensions = Record<never, never>>(
  options: CreateOpfsPgwasmOptions<E>,
): Promise<OpfsPgwasm<E>> {
  assertHostOptions(options.pgwasm);
  const store = await openOpfsRepackedFsForPort(new OpfsRepackedPort(options.directory), filesystemOptions(options));
  options.onPhase?.("store-opened");

  let pg: OpfsPgwasm<E> | undefined;
  try {
    pg = await createPgwasm<E>({
      ...options.pgwasm,
      build: options.build,
      fs: store,
      relaxedDurability: false,
    });
    registerStrictSync(pg, () => store.strictSync());
    options.onPhase?.("pgwasm-ready");
    store.strictSync();
    return pg;
  } catch (cause) {
    try {
      // The database is unusable once its first strict sync failed: close it, which releases the store.
      await pg?.close();
    } catch {
      // Preserve the first cause.
    }
    try {
      await store.cleanupFailedInit();
    } catch {
      // Initialization is already unusable. Preserve its first cause after
      // cleanup has attempted every owned handle.
    }
    throw cause;
  }
}

/**
 * Stabilize every preceding data and metadata operation of a database on an OPFS-repacked store, in
 * strict order, serialized against its queries. Throws {@link UnsupportedFeatureError} for a database
 * that `createOpfsPgwasm` did not create.
 */
export async function strictSync(pg: Pgwasm): Promise<void> {
  const sync = strictSyncOf(pg);
  if (sync === undefined) {
    throw new UnsupportedFeatureError(
      "strictSync needs a database on an OPFS-repacked store (created by createOpfsPgwasm).",
    );
  }
  await pg.runExclusive(async () => {
    sync();
  });
}

function filesystemOptions(options: CreateOpfsPgwasmOptions<Extensions>): RepackedFilesystemOptions {
  return {
    ...(options.extentSize === undefined ? {} : { extentSize: options.extentSize }),
    ...(options.durability === undefined ? {} : { durability: options.durability }),
  };
}

function assertHostOptions(options: object | undefined): void {
  if (options === undefined) return;
  for (const reserved of ["build", "dataDir", "fs", "relaxedDurability"] as const) {
    if (reserved in options) {
      throw new TypeError(`pgwasm.${reserved} is owned by createOpfsPgwasm`);
    }
  }
}
