// Began as a copy of `@electric-sql/pglite` (taken under its PostgreSQL License option, © ElectricSQL
// — see NOTICE). Owned outright (ADR-0062); compatibility with PGlite is an anti-goal — evolve freely.

import { gunzipIfCompressed, readTar, type ServerExtension, type TarEntry } from "@pgxsinkit/pgwasm/build";

import type { EmscriptenFS, PostgresModule } from "./emscripten";
import { PG_ROOT } from "./paths";

/**
 * An extension bundle's files, fetched now so the download overlaps the boot. The bundle is a gzipped
 * tar; a server that already decompressed it (Content-Encoding) hands over the plain tar, which is
 * recognised by its missing gzip magic.
 */
export async function fetchExtensionBundle(extension: ServerExtension): Promise<TarEntry[]> {
  const response = await fetch(extension.bundle);
  if (!response.ok) {
    throw new Error(
      `Could not load the "${extension.name}" extension bundle ${extension.bundle.href}: HTTP ${response.status}`,
    );
  }
  const bytes = await gunzipIfCompressed(new Uint8Array(await response.arrayBuffer()));
  return readTar(bytes);
}

function writeFile(FS: EmscriptenFS, path: string, data: Uint8Array): void {
  const directory = path.slice(0, path.lastIndexOf("/"));
  if (!FS.analyzePath(directory).exists) FS.mkdirTree(directory);
  FS.writeFile(path, data);
}

/**
 * Install extension files under `/pgwasm` (`lib/postgresql/*.so`, `share/postgresql/extension/*`).
 * Shared objects go through the runtime's preload plugin, which compiles them ahead of `dlopen`; a
 * preload that fails leaves the plain file, and `dlopen` compiles it when it is first needed.
 */
export async function installExtensionFiles(
  module: PostgresModule,
  bundles: readonly TarEntry[][],
  log: (...args: unknown[]) => void,
): Promise<void> {
  const FS = module.FS;
  const preloads: Promise<void>[] = [];
  for (const bundle of bundles) {
    // Sorted so a library preloads before the ones that link against it (e.g. postgis-3.so before
    // postgis_topology-3.so).
    const entries = [...bundle].sort((a, b) => (a.name > b.name ? 1 : a.name < b.name ? -1 : 0));
    for (const entry of entries) {
      const path = `${PG_ROOT}/${entry.name}`.replace(/\/+$/, "");
      if (entry.type === "directory") {
        if (!FS.analyzePath(path).exists) FS.mkdirTree(path);
        continue;
      }
      if (entry.name.startsWith(".")) continue;
      if (entry.name.endsWith(".so")) {
        const directory = path.slice(0, path.lastIndexOf("/"));
        const soName = path.slice(path.lastIndexOf("/") + 1);
        if (!FS.analyzePath(directory).exists) FS.mkdirTree(directory);
        log(`pgwasm-c: preloading ${path}`);
        preloads.push(
          new Promise<void>((resolve) => {
            FS.createPreloadedFile(
              directory,
              soName,
              entry.data,
              true,
              true,
              () => resolve(),
              () => {
                log(`pgwasm-c: preloading ${path} failed; installing the plain file`);
                writeFile(FS, path, entry.data);
                resolve();
              },
              false,
            );
          }),
        );
      } else {
        writeFile(FS, path, entry.data);
      }
    }
  }
  await Promise.all(preloads);
}
