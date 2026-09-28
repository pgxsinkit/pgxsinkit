// Began as a copy of `@electric-sql/pglite` (taken under its PostgreSQL License option, © ElectricSQL
// — see NOTICE). Owned outright (ADR-0062); compatibility with PGlite is an anti-goal — evolve freely.

import type {
  BlobDevice,
  BootRequest,
  BuildCapabilities,
  BuildIdentity,
  DataDirEntry,
  MountedDataDirectory,
  PostgresBuild,
  RunningPostgres,
  StartOptions,
  TarEntry,
  WireSession,
} from "@pgxsinkit/pgwasm/build";

import { ARTEFACT_RELEASE } from "./artefact-pins";
import { type CBuildArtefactSet, pinnedCBuildArtefacts } from "./artefacts";
import { bytesOf, compileModule, loadBundle, prefetch } from "./host/artefact-loader";
import { readDataDirEntries, readDataDirFile, writeDataDirEntries, writeDataDirFile } from "./host/data-dir";
import type { PostgresModule } from "./host/emscripten";
import { fetchExtensionBundle, installExtensionFiles } from "./host/extensions";
import { runInitdb } from "./host/initdb";
import { mountFor, type StorageMount } from "./host/mounts";
import { DEFAULT_START_PARAMS, PostgresInstance } from "./host/postgres-instance";

/**
 * The C build's identity, recorded in every data directory it creates (ADR-0063). Its release and data
 * format are the pinned pgwasm-postgres release's (`bun run pgwasm:pin` writes both; ADR-0064): the
 * release is the build's name in version(), and `pgwasm:pin` refuses a release of another data format.
 */
export const C_BUILD_IDENTITY: BuildIdentity = {
  name: "c",
  dataFormat: ARTEFACT_RELEASE.dataFormat,
  // Every data directory made before builds were recorded was made by this build.
  claimsUnmarkedDirectories: true,
  release: ARTEFACT_RELEASE.name,
};

const C_BUILD_CAPABILITIES: BuildCapabilities = {
  sessions: 1,
  requiresCrossOriginIsolation: false,
  filesystems: ["memory", "idb", "file", "vfs"],
  synchronousExchange: true,
  blobDevice: true,
};

/**
 * The C build's artefacts, fetched and compiled ahead of a boot (e.g. by an app's warm module on an earlier
 * screen, from the URLs in `cBuildArtefacts`). A field left out is loaded by the build itself.
 */
export interface CBuildAssets {
  readonly postgresWasmModule?: WebAssembly.Module;
  readonly initdbWasmModule?: WebAssembly.Module;
  readonly fsBundle?: Blob;
}

export interface CBuildOptions {
  /** The Postgres module, compiled ahead (e.g. on an earlier screen). */
  readonly postgresWasmModule?: WebAssembly.Module | Promise<WebAssembly.Module>;
  /** The initdb module, compiled ahead; used only when a data directory is created. */
  readonly initdbWasmModule?: WebAssembly.Module | Promise<WebAssembly.Module>;
  /** The filesystem bundle, fetched ahead. */
  readonly fsBundle?: Blob | Promise<Blob>;
  /**
   * The artefacts being warmed ahead. A boot waits for the promise to settle and uses each asset it
   * resolves with in place of that artefact's own load. The warm-up is only an accelerator: a rejected
   * promise never fails a boot, the build loads the artefacts itself instead. An explicit
   * `postgresWasmModule`, `initdbWasmModule` or `fsBundle` wins over the same asset.
   */
  readonly assets?: Promise<CBuildAssets>;
  /** @internal A test's view of each Postgres module the build instantiates. */
  readonly onPostgresModule?: (module: PostgresModule) => void;
  /** @internal Every command line initdb runs through the host. */
  readonly onInitdbCommand?: (command: string) => void;
}

interface Resolved {
  readonly artefacts: CBuildArtefactSet;
  readonly postgresWasm: () => Promise<WebAssembly.Module>;
  readonly initdbWasm: () => Promise<WebAssembly.Module>;
  readonly fsBundle: () => Promise<ArrayBuffer>;
  readonly options: CBuildOptions;
}

class CRunningPostgres implements RunningPostgres {
  readonly #instance: PostgresInstance;
  readonly #mount: StorageMount;
  #sessionOpened = false;
  readonly blob: BlobDevice;

  constructor(instance: PostgresInstance, mount: StorageMount) {
    this.#instance = instance;
    this.#mount = mount;
    this.blob = {
      setReadSource: (data) => instance.setBlobReadSource(data),
      takeWritten: () => instance.takeBlobWritten(),
    };
  }

  async openSession(): Promise<WireSession> {
    if (this.#sessionOpened) throw new Error("The C build holds a single session, and it is open.");
    this.#sessionOpened = true;
    const instance = this.#instance;
    return {
      exchange: (message, onData) => instance.exchange(message, onData),
      onUnsolicited: undefined,
      close: async () => {},
    };
  }

  async persist(relaxed: boolean): Promise<void> {
    await this.#mount.persist(this.#instance.module, relaxed);
  }

  async readEntries(): Promise<DataDirEntry[]> {
    return readDataDirEntries(this.#instance.module.FS);
  }

  async shutdown(): Promise<void> {
    this.#instance.shutdown();
  }

  async release(options: { readonly afterFailedBoot?: boolean } = {}): Promise<void> {
    try {
      if (options.afterFailedBoot) await this.#mount.cleanupFailedInit(this.#instance.module);
      else await this.#mount.close(this.#instance.module);
    } finally {
      this.#instance.dispose(options.afterFailedBoot ? 1 : 0);
    }
  }
}

class CMountedDataDirectory implements MountedDataDirectory {
  readonly #instance: PostgresInstance;
  readonly #mount: StorageMount;
  readonly #request: BootRequest;
  readonly #resolved: Resolved;
  readonly #extensionBundles: Promise<TarEntry[][]>;

  constructor(
    instance: PostgresInstance,
    mount: StorageMount,
    request: BootRequest,
    resolved: Resolved,
    extensionBundles: Promise<TarEntry[][]>,
  ) {
    this.#instance = instance;
    this.#mount = mount;
    this.#request = request;
    this.#resolved = resolved;
    this.#extensionBundles = extensionBundles;
  }

  get #FS() {
    return this.#instance.module.FS;
  }

  async readFile(path: string): Promise<Uint8Array | undefined> {
    return readDataDirFile(this.#FS, path);
  }

  async createCluster(): Promise<void> {
    // initdb runs on a scratch instance of its own, never on the mounted storage: its backend
    // invocations reset the instance's heap between runs, and a filesystem holding exclusive resources
    // (an OPFS store's handles) must not be initialised twice.
    const scratch = await PostgresInstance.create({
      glue: this.#resolved.artefacts,
      wasmModule: this.#resolved.postgresWasm(),
      fsBundle: this.#resolved.fsBundle(),
      user: this.#request.user,
      database: this.#request.database,
      debug: this.#request.debug,
    });
    try {
      const result = await runInitdb({
        createInitdbModule: this.#resolved.artefacts.createInitdbModule,
        postgres: scratch,
        initdbWasm: await this.#resolved.initdbWasm(),
        debug: this.#request.debug,
        ...(this.#resolved.options.onInitdbCommand ? { onCommand: this.#resolved.options.onInitdbCommand } : {}),
      });
      if (result.exitCode !== 0 && !result.stderr.includes("exists but is not empty")) {
        throw new Error(`initdb failed to create the data directory (exit ${result.exitCode}): ${result.stderr}`);
      }
      writeDataDirEntries(this.#FS, readDataDirEntries(scratch.module.FS));
    } finally {
      scratch.dispose(0);
    }
  }

  async writeEntries(entries: readonly DataDirEntry[]): Promise<void> {
    writeDataDirEntries(this.#FS, entries);
  }

  async writeFile(path: string, data: Uint8Array): Promise<void> {
    writeDataDirFile(this.#FS, path, data);
  }

  async persist(): Promise<void> {
    await this.#mount.persist(this.#instance.module, false);
  }

  async start(options: StartOptions): Promise<RunningPostgres> {
    const log = (...args: unknown[]) => {
      if (this.#request.debug > 0) console.log(...args);
    };
    await installExtensionFiles(this.#instance.module, await this.#extensionBundles, log);
    this.#instance.startSingleMode([
      ...DEFAULT_START_PARAMS,
      ...(this.#request.debug > 0 ? ["-d", String(this.#request.debug)] : []),
      ...Object.entries(options.settings).flatMap(([name, value]) => ["-c", `${name}=${value}`]),
    ]);
    return new CRunningPostgres(this.#instance, this.#mount);
  }

  async release(): Promise<void> {
    try {
      await this.#mount.cleanupFailedInit(this.#instance.module);
    } finally {
      this.#instance.dispose(1);
    }
  }
}

/**
 * A C build, optionally with its artefacts fetched and compiled ahead. `cBuild` is the build with
 * defaults; a build object can boot any number of databases.
 */
export function createCBuild(options: CBuildOptions = {}): PostgresBuild {
  return createCBuildFrom(C_BUILD_IDENTITY, pinnedCBuildArtefacts, options);
}

/**
 * @internal A C build on the given artefacts, recording the given identity: what {@link createCBuild}
 * builds on the pinned release's. Not exported from the package; the IndexedDB browser lane reaches it
 * from source to boot an earlier release's glue and files, so the stores that release wrote can be opened
 * by the current build (tests/e2e/pgwasm-idb/continuity-builds.ts). That list starts empty at 18.6.2: its
 * filesystem root changed, so no earlier release's stores open under it; 18.6.2 is the first entry.
 */
export function createCBuildFrom(
  identity: BuildIdentity,
  artefacts: CBuildArtefactSet,
  options: CBuildOptions = {},
): PostgresBuild {
  // Settled once, and handled here: a failed warm-up means the lazy load, never an unhandled rejection.
  const warmed: Promise<CBuildAssets | undefined> =
    options.assets === undefined
      ? Promise.resolve(undefined)
      : options.assets.then(
          (assets) => assets,
          () => undefined,
        );
  const resolved: Resolved = {
    artefacts,
    postgresWasm: async () => {
      const module = options.postgresWasmModule ?? (await warmed)?.postgresWasmModule;
      return module === undefined ? compileModule(artefacts.postgresWasm) : module;
    },
    initdbWasm: async () => {
      const module = options.initdbWasmModule ?? (await warmed)?.initdbWasmModule;
      return module === undefined ? compileModule(artefacts.initdbWasm) : module;
    },
    fsBundle: async () => {
      const bundle = options.fsBundle ?? (await warmed)?.fsBundle;
      return bundle === undefined ? loadBundle(artefacts.fsBundle) : bytesOf(bundle);
    },
    options,
  };

  // Everything a boot waits on before its own work: the warm-up, and the explicit Postgres module and
  // filesystem bundle when given as promises. Settled, never rejected: a rejected one fails (or falls back in)
  // the boot itself, which is where that belongs.
  const prepared: Promise<void> = Promise.allSettled([warmed, options.postgresWasmModule, options.fsBundle]).then(
    () => undefined,
  );

  return {
    identity,
    capabilities: C_BUILD_CAPABILITIES,
    prepare: () => prepared,
    async boot(request: BootRequest): Promise<MountedDataDirectory> {
      const extensionBundles = Promise.all(request.extensions.map((extension) => fetchExtensionBundle(extension)));
      // Awaited in start(); a failure before then must not surface as unhandled.
      extensionBundles.catch(() => undefined);
      // Start the downloads the warm-up did not cover now; the boot needs them in turn.
      const assets = await warmed;
      if (options.postgresWasmModule === undefined && assets?.postgresWasmModule === undefined) {
        prefetch(artefacts.postgresWasm);
      }
      if (options.initdbWasmModule === undefined && assets?.initdbWasmModule === undefined) {
        prefetch(artefacts.initdbWasm);
      }

      const mount = mountFor(request.storage);
      await mount.acquire();
      let instance: PostgresInstance | undefined;
      try {
        instance = await PostgresInstance.create({
          glue: artefacts,
          wasmModule: resolved.postgresWasm(),
          fsBundle: resolved.fsBundle(),
          user: request.user,
          database: request.database,
          debug: request.debug,
          ...(mount.preRun ? { mountPreRun: mount.preRun } : {}),
          ...(options.onPostgresModule ? { onModule: options.onPostgresModule } : {}),
        });
        await mount.initialSync(instance.module);
      } catch (error) {
        try {
          await mount.cleanupFailedInit(instance?.module);
        } catch {
          // The boot already failed; keep its cause.
        }
        instance?.dispose(1);
        throw error;
      }
      return new CMountedDataDirectory(instance, mount, request, resolved, extensionBundles);
    },
  };
}

/** The C build with its defaults: the artefacts load from next to this module when first booted. */
export const cBuild: PostgresBuild = createCBuild();
