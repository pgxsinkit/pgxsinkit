import type {
  BootRequest,
  BuildCapabilities,
  BuildIdentity,
  DataDirEntry,
  MountedDataDirectory,
  PostgresBuild,
  RunningPostgres,
} from "../../../packages/pgwasm/src/build";

/**
 * A Postgres build that runs no Postgres: it records every seam call and answers `readFile` from a
 * fixed data directory. For the shared-code paths that must refuse, or must not write, before anything
 * starts.
 */
export interface SpyBuild extends PostgresBuild {
  readonly calls: string[];
  readonly bootRequests: BootRequest[];
  readonly writtenEntries: DataDirEntry[][];
}

export interface SpyBuildOptions {
  readonly identity?: Partial<BuildIdentity>;
  readonly capabilities?: Partial<BuildCapabilities>;
  /** The data directory the "mounted" storage holds, by path (`/PG_VERSION`, `/PGWASM_BUILD`). */
  readonly files?: Readonly<Record<string, Uint8Array>>;
}

export class SpyStartReachedError extends Error {
  override name = "SpyStartReachedError";
}

export function createSpyBuild(options: SpyBuildOptions = {}): SpyBuild {
  const calls: string[] = [];
  const bootRequests: BootRequest[] = [];
  const writtenEntries: DataDirEntry[][] = [];
  const files = new Map(Object.entries(options.files ?? {}));
  const identity: BuildIdentity = {
    name: "spy",
    dataFormat: 1,
    claimsUnmarkedDirectories: false,
    release: "spy",
    ...options.identity,
  };
  const capabilities: BuildCapabilities = {
    sessions: 1,
    requiresCrossOriginIsolation: false,
    filesystems: ["memory", "idb", "file", "vfs"],
    synchronousExchange: true,
    blobDevice: true,
    ...options.capabilities,
  };
  const mounted: MountedDataDirectory = {
    readFile: async (path) => {
      calls.push(`readFile ${path}`);
      return files.get(path);
    },
    createCluster: async () => {
      calls.push("createCluster");
    },
    writeEntries: async (entries) => {
      calls.push("writeEntries");
      writtenEntries.push([...entries]);
    },
    writeFile: async (path) => {
      calls.push(`writeFile ${path}`);
    },
    persist: async () => {
      calls.push("persist");
    },
    start: async (): Promise<RunningPostgres> => {
      calls.push("start");
      // The spy stops here: a test that reaches start has passed every pre-start check.
      throw new SpyStartReachedError("the spy build does not run Postgres");
    },
    release: async () => {
      calls.push("release");
    },
  };
  return {
    identity,
    capabilities,
    calls,
    bootRequests,
    writtenEntries,
    boot: async (request) => {
      calls.push(`boot ${request.storage.kind}`);
      bootRequests.push(request);
      return mounted;
    },
  };
}
