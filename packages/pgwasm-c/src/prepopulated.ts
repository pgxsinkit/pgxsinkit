/**
 * The C build's prepopulated data directory: a Store backup of a freshly initialised database, to start
 * from instead of running initdb.
 *
 * This entry point is emitted at its own depth (`dist/prepopulated.js`), so its relative reference to the
 * artefact stays valid once bundled; the `new URL` stays a literal so bundlers copy and fingerprint the
 * file.
 */

const prepopulatedUrl = new URL("../artefacts/prepopulated.tar.gz", import.meta.url);

/**
 * The prepopulated data directory, as a gzipped Store backup, for `createPgwasm({ build, loadDataDir })`:
 *
 * ```ts
 * import { createPgwasm } from "@pgxsinkit/pgwasm";
 * import { cBuild } from "@pgxsinkit/pgwasm-c";
 * import { prepopulatedDataDir } from "@pgxsinkit/pgwasm-c/prepopulated";
 *
 * const pg = await createPgwasm({ build: cBuild, loadDataDir: await prepopulatedDataDir() });
 * ```
 *
 * It is fetched by URL, like the build's other files, in Bun and in browsers. It is an asset of the pinned
 * pgwasm-postgres release, made deterministically by that release's own initdb; it is left unmarked, and
 * `createPgwasm` adds the marker whenever it restores an unmarked backup, so every data directory created
 * from it is marked as the C build's. Its directories are 0750 and its files 0640; a restore does not
 * carry a mode into the data directory. Like any backup of a running database it holds `/postmaster.pid`,
 * recording the engine's own process id: the C build treats it as stale and writes its own on start.
 */
export async function prepopulatedDataDir(): Promise<Blob> {
  const response = await fetch(prepopulatedUrl);
  if (!response.ok) {
    throw new Error(
      `Could not load the prepopulated data directory ${prepopulatedUrl.href}: HTTP ${response.status} ${response.statusText}`,
    );
  }
  return await response.blob();
}
