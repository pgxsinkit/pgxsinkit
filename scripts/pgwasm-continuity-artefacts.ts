#!/usr/bin/env bun
/**
 * Fetch and verify the earlier C builds the IndexedDB lane's continuity test boots
 * (`tests/e2e/pgwasm-idb/continuity-builds.ts`), into `tmp/pgwasm-idb-continuity/<tag>/`.
 *
 * One implementation: each build is handed to `scripts/pgwasm-artefacts.ts`' `ensureArtefacts` as a
 * package of its own, so its files are verified (a mismatching one deleted) before anything is fetched,
 * taken from `.buildcache/pgwasm-artefacts/` or downloaded into it, and checked by bytes and sha256
 * before they are used. Run by `e2e:pgwasm-idb:serve`, ahead of the lane's Vite build.
 */

import path from "node:path";

import {
  CONTINUITY_BUILDS,
  CONTINUITY_REPOSITORY,
  continuityFixtureDir,
} from "../tests/e2e/pgwasm-idb/continuity-builds";
import { type ArtefactPackage, ensureArtefacts } from "./pgwasm-artefacts";

const repoRoot = path.resolve(import.meta.dir, "..");

/** Each continuity build as an artefact package whose files live in its fixture directory. */
export const CONTINUITY_PACKAGES: readonly ArtefactPackage[] = CONTINUITY_BUILDS.map((build) => ({
  packageDir: continuityFixtureDir(build.tag),
  release: { repository: CONTINUITY_REPOSITORY, tag: build.tag },
  files: build.files,
}));

if (import.meta.main) {
  try {
    const written = await ensureArtefacts(CONTINUITY_PACKAGES, {
      dirOf: (pkg) => path.join(repoRoot, pkg.packageDir),
    });
    for (const [index, pkg] of CONTINUITY_PACKAGES.entries()) {
      const names = written[index] ?? [];
      console.log(
        names.length === 0
          ? `pgwasm-continuity-artefacts: ${pkg.packageDir}: all pinned files present and verified.`
          : `pgwasm-continuity-artefacts: ${pkg.packageDir}: fetched and verified ${names.join(", ")}.`,
      );
    }
  } catch (error) {
    console.error(`pgwasm-continuity-artefacts: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
