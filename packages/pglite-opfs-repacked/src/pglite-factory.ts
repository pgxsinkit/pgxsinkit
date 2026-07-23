import { PGlite } from "@electric-sql/pglite";
import type { Extensions, PGliteInterfaceExtensions, PGliteOptions } from "@electric-sql/pglite";

import { OpfsRepackedPort } from "./opfs-port";
import type { OpfsDirectoryHandle } from "./opfs-port";
import { openOpfsRepackedFsForPort } from "./opfs-repacked-fs";
import type { OpfsRepackedFS, RepackedFilesystemOptions } from "./opfs-repacked-fs";

type HostOptions<TExtensions extends Extensions> = Omit<
  PGliteOptions<TExtensions>,
  "dataDir" | "fs" | "relaxedDurability"
>;

export interface CreateOpfsRepackedPGliteOptions<
  TExtensions extends Extensions = Extensions,
> extends RepackedFilesystemOptions {
  /** Dedicated directory owned in full by this store. */
  readonly directory: OpfsDirectoryHandle;
  /** PGlite options other than the factory-owned dataDir, fs, and relaxedDurability fields. */
  readonly pglite?: HostOptions<TExtensions>;
}

/**
 * The factory-owned PGlite instance: a plain PGlite plus the one explicit
 * strict operation reserved for the sync layer above the VFS.
 */
export type OpfsRepackedPGlite<TExtensions extends Extensions = Extensions> = PGlite &
  PGliteInterfaceExtensions<TExtensions> & {
    /**
     * Stabilize every preceding data and metadata operation in strict order,
     * serialized against query execution.
     */
    strictSync(): Promise<void>;
  };

/**
 * Construct the only supported OPFS-repacked/PGlite pairing.
 *
 * PGlite always awaits the filesystem sync. Physical durability is selected
 * once, here, by the VFS option and is never delegated to the host boolean.
 * A strict sync completes successful database initialization before return.
 */
export async function createOpfsRepackedPGlite<TExtensions extends Extensions = Extensions>(
  options: CreateOpfsRepackedPGliteOptions<TExtensions>,
): Promise<OpfsRepackedPGlite<TExtensions>> {
  assertHostOptions(options.pglite);
  const adapter = await openOpfsRepackedFsForPort(new OpfsRepackedPort(options.directory), filesystemOptions(options));

  try {
    const pg = new FactoryOwnedPGlite(
      {
        ...(options.pglite ?? {}),
        fs: adapter,
        relaxedDurability: false,
      },
      adapter,
    );
    await pg.waitReady;
    adapter.strictSync();
    return pg as FactoryOwnedPGlite & PGliteInterfaceExtensions<TExtensions>;
  } catch (cause) {
    try {
      await adapter.cleanupFailedInit();
    } catch {
      // Initialization is already unusable. Preserve its first cause after
      // cleanup has attempted every owned handle.
    }
    throw cause;
  }
}

class FactoryOwnedPGlite extends PGlite {
  readonly #adapter: OpfsRepackedFS;
  #ownedClose: Promise<void> | undefined;

  constructor(options: PGliteOptions, adapter: OpfsRepackedFS) {
    super(options);
    this.#adapter = adapter;
  }

  /** Stabilize every preceding operation, serialized against queries. */
  async strictSync(): Promise<void> {
    await this.runExclusive(async () => {
      this.#adapter.strictSync();
    });
  }

  override close(): Promise<void> {
    this.#ownedClose ??= this.#closeOwned();
    return this.#ownedClose;
  }

  async #closeOwned(): Promise<void> {
    let firstError: unknown;
    try {
      await super.close();
    } catch (cause) {
      firstError = cause;
    }

    try {
      await this.#adapter.closeFs();
    } catch (cause) {
      firstError ??= cause;
    }

    if (firstError !== undefined) throw firstError;
  }
}

function filesystemOptions(options: CreateOpfsRepackedPGliteOptions): RepackedFilesystemOptions {
  return {
    ...(options.extentSize === undefined ? {} : { extentSize: options.extentSize }),
    ...(options.durability === undefined ? {} : { durability: options.durability }),
  };
}

function assertHostOptions(options: object | undefined): void {
  if (options === undefined) return;
  for (const reserved of ["dataDir", "fs", "relaxedDurability"] as const) {
    if (reserved in options) {
      throw new TypeError(`pglite.${reserved} is owned by the OPFS repacked factory`);
    }
  }
}
