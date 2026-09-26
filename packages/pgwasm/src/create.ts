import type { DataDirEntry, PostgresBuild, ServerExtension } from "./build/seam";
import { readDataDirArchive } from "./core/data-dir-archive";
import { BUILD_MARKER_PATH, checkBuildMarker, encodeBuildMarker, findEntry, PG_VERSION_PATH } from "./core/marker";
import { PgwasmInstance } from "./core/pgwasm";
import { resolveStorage } from "./core/storage";
import {
  BackupFormatError,
  CrossOriginIsolationRequiredError,
  ExtensionBuildMismatchError,
  UnsupportedFilesystemError,
} from "./errors";
import type { Extension, Extensions, PgwasmOptions, PgwasmWithExtensions } from "./interface";

function isServerExtension(extension: Extension | ServerExtension): extension is ServerExtension {
  return "kind" in extension && extension.kind === "server";
}

function assertBuild(build: unknown): asserts build is PostgresBuild {
  const candidate = build as Partial<PostgresBuild> | null | undefined;
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    typeof candidate.boot !== "function" ||
    typeof candidate.identity?.name !== "string" ||
    !Array.isArray(candidate.capabilities?.filesystems)
  ) {
    throw new TypeError("createPgwasm needs a Postgres build in `build`, e.g. `cBuild` from @pgxsinkit/pgwasm-c.");
  }
}

/** Merge the server extensions' preload libraries into the settings. */
function mergeSettings(
  settings: Readonly<Record<string, string>> | undefined,
  serverExtensions: readonly ServerExtension[],
): Record<string, string> {
  const merged: Record<string, string> = { ...settings };
  const preload = serverExtensions.flatMap((extension) => extension.sharedPreloadLibraries ?? []);
  if (preload.length > 0) {
    const existing = (merged["shared_preload_libraries"] ?? "")
      .split(",")
      .map((library) => library.trim())
      .filter((library) => library !== "");
    merged["shared_preload_libraries"] = [...new Set([...existing, ...preload])].join(",");
  }
  return merged;
}

/**
 * A Store backup's entries, checked against the build before anything is booted, with the build
 * marker added when the backup has none (it predates marking and is the C build's).
 */
async function restoreEntries(build: PostgresBuild, loadDataDir: Blob | File): Promise<readonly DataDirEntry[]> {
  const entries = await readDataDirArchive(loadDataDir);
  if (findEntry(entries, PG_VERSION_PATH) === undefined) {
    throw new BackupFormatError("The Store backup holds no data directory (it has no PG_VERSION).");
  }
  const marker = findEntry(entries, BUILD_MARKER_PATH);
  checkBuildMarker(build.identity, marker?.data, true, "backup");
  if (marker !== undefined) return entries;
  return [
    ...entries,
    {
      path: BUILD_MARKER_PATH,
      type: "file",
      mode: 0o600,
      mtimeSeconds: Math.floor(Date.now() / 1000),
      data: encodeBuildMarker(build.identity),
    },
  ];
}

/**
 * Start a database on a Postgres build. Resolves once it is ready.
 *
 * Everything that can be checked before booting is: the `dataDir` scheme, the build's supported
 * storage and cross-origin isolation, each server extension's build, and a Store backup's recorded
 * build (ADR-0063). The booted data directory's recorded build is checked before anything is written.
 */
export async function createPgwasm<E extends Extensions = Record<never, never>>(
  options: PgwasmOptions<E>,
): Promise<PgwasmWithExtensions<E>> {
  const build: unknown = options.build;
  assertBuild(build);
  const identity = build.identity;
  const capabilities = build.capabilities;

  const storage = resolveStorage(options.dataDir, options.fs);
  if (!capabilities.filesystems.includes(storage.kind)) {
    throw new UnsupportedFilesystemError(storage.kind, identity, capabilities.filesystems);
  }
  if (
    capabilities.requiresCrossOriginIsolation &&
    (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === false
  ) {
    throw new CrossOriginIsolationRequiredError(identity);
  }

  const serverExtensions: ServerExtension[] = [];
  const clientExtensions: [string, Extension][] = [];
  for (const [key, extension] of Object.entries(options.extensions ?? {})) {
    if (isServerExtension(extension)) {
      if (extension.build !== identity.name) {
        throw new ExtensionBuildMismatchError(extension.name, extension.build, identity);
      }
      serverExtensions.push(extension);
    } else {
      clientExtensions.push([key, extension]);
    }
  }

  const restore = options.loadDataDir === undefined ? undefined : await restoreEntries(build, options.loadDataDir);
  const plan = {
    build,
    storage,
    serverExtensions,
    clientExtensions,
    restore,
    settings: mergeSettings(options.settings, serverExtensions),
    user: options.username ?? "postgres",
    database: options.database ?? "postgres",
    username: options.username,
    debug: options.debug ?? 0,
    relaxedDurability: options.relaxedDurability ?? false,
    parsers: options.parsers,
    serializers: options.serializers,
  } as const;
  const instance = new PgwasmInstance(plan);
  await instance.boot(plan);
  // The namespaces were attached under their keys during boot.
  return instance as PgwasmInstance & PgwasmWithExtensions<E>;
}
