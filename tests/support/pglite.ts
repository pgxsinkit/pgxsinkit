import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite, type PGliteOptions, type PGliteInterfaceExtensions } from "@electric-sql/pglite";
import { dataDir as prepopulatedDataDir } from "@electric-sql/pglite-prepopulatedfs";

// Every PGlite instance this helper hands out is tracked so a test file can close them all in one
// `afterEach(closeOpenTestPGlites)`. This matters for more than tidiness: an un-closed instance keeps
// its (multi-MB) WASM heap alive, so a file that boots one per test and never closes them accumulates
// memory across the run — later tests then boot and operate **progressively slower** under the growing
// heap (and bun force-exits with code 99 on the leaked handles). Closing each test's instance keeps
// every boot cheap and the run flat.
const openInstances = new Set<PGlite>();

export async function createFreshTestPGlite<TOptions extends PGliteOptions>(options?: TOptions) {
  const pg = await PGlite.create({
    ...options,
    loadDataDir: await prepopulatedDataDir(),
  });
  openInstances.add(pg);
  return pg as PGlite &
    PGliteInterfaceExtensions<TOptions extends { extensions: infer TExtensions } ? TExtensions : Record<string, never>>;
}

// A fresh, isolated PGlite that already has `schemaSql` applied, WITHOUT re-running the DDL each time.
// The dump (prepopulatedfs base → `exec(schemaSql)` → uncompressed `dumpDataDir("none")`) is memoized
// across TWO tiers so neither this process nor a sibling shard rebuilds it:
//
//   1. In-process memo (`schemaDumpCache`) — same-process callers share one dump promise.
//   2. Fingerprint-keyed disk cache under `tmp/pglite-cache/` — the sharded unit runner
//      (`scripts/run-unit-tests.ts`) spawns ~10 independent `bun test` PROCESSES; without this each
//      shard rebuilds the dump (boot + DDL exec + dump). The disk tar lets every shard, and every
//      later run, load an already-built snapshot and skip the exec.
//
// The fingerprint (sha256, 16 hex chars) covers everything that determines the snapshot's bytes: this
// support file's own source (it decides HOW the dump is built), the exact `schemaSql` (the callers'
// `generateLocalSchemaSql(...)` output — the seed schema itself), and the resolved `version` of
// `@electric-sql/pglite` + `@electric-sql/pglite-prepopulatedfs` (the base image + engine). Any of
// those changing yields a new key, so a stale tar is never loaded.
//
// The disk cache is strictly a best-effort accelerator: EVERY disk failure (unresolvable fingerprint,
// read/write error, or a corrupt/truncated tar that fails to boot) degrades silently to the in-memory
// build path. A broken cache must never fail a test run. Each instance is still a separate store, so
// per-test isolation is unchanged. Use this instead of `createFreshTestPGlite()` + `db.exec(schemaSql)`
// in a file that boots the same schema many times.
const schemaDumpCache = new Map<string, Promise<Blob | File>>();

// createRequire anchored to THIS file (not cwd): the unit runner spawns processes whose cwd is the
// repo root, but dependency resolution must follow this module's node_modules (isolated installs).
const requireFromHere = createRequire(import.meta.url);
// This file lives at `<repoRoot>/tests/support/pglite.ts`, so the repo root is two levels up.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cacheDir = path.join(repoRoot, "tmp", "pglite-cache");
const cacheFileFor = (fingerprint: string) => path.join(cacheDir, `pgxsinkit-schema-${fingerprint}.tar`);
const cacheFileNamePattern = /^pgxsinkit-schema-.*\.tar$/;

export async function createSchemaTestPGlite(schemaSql: string): Promise<PGlite> {
  let dump = schemaDumpCache.get(schemaSql);
  if (!dump) {
    dump = resolveSchemaDump(schemaSql);
    schemaDumpCache.set(schemaSql, dump);
  }
  const pg = await PGlite.create({ loadDataDir: await dump });
  openInstances.add(pg);
  return pg;
}

// Two-tier resolution: try the disk cache, else build and best-effort persist it. Never throws for a
// cache reason — only a genuine build failure (a bad `schemaSql`) propagates.
async function resolveSchemaDump(schemaSql: string): Promise<Blob | File> {
  const fingerprint = await computeFingerprint(schemaSql);
  if (fingerprint) {
    const hit = await readDiskCache(fingerprint);
    if (hit) return hit;
  }
  const built = await buildSchemaDump(schemaSql);
  if (fingerprint) await writeDiskCache(fingerprint, built);
  return built;
}

// The original in-memory build: prepopulatedfs base → apply the DDL → uncompressed dump (fastest reload).
async function buildSchemaDump(schemaSql: string): Promise<Blob | File> {
  const seed = await PGlite.create({ loadDataDir: await prepopulatedDataDir() });
  await seed.exec(schemaSql);
  const snapshot = await seed.dumpDataDir("none"); // uncompressed = fastest reload
  await seed.close();
  return snapshot;
}

// A miss (no file, unreadable, or a tar that won't boot) returns undefined so the caller rebuilds. We
// validate by booting a throwaway store: a truncated/corrupt tar throws here rather than at the real
// call site, and we delete it so the next process re-persists a good one.
async function readDiskCache(fingerprint: string): Promise<Blob | undefined> {
  const file = cacheFileFor(fingerprint);
  let bytes: Uint8Array;
  try {
    bytes = await readFile(file);
  } catch {
    return undefined; // absent/unreadable — a normal miss.
  }
  const blob = new Blob([bytes], { type: "application/x-tar" });
  try {
    const probe = await PGlite.create({ loadDataDir: blob });
    await probe.close();
  } catch {
    await rm(file, { force: true }).catch(() => {});
    return undefined;
  }
  // Freshen the mtime so age-based pruning keeps actively-used snapshots alive.
  const now = new Date();
  await utimes(file, now, now).catch(() => {});
  return blob;
}

// Atomic publish (`<target>.<pid>.tmp` + rename) so a concurrently-reading shard never sees a partial
// file, then best-effort age-based pruning. Any failure is swallowed — the worst case is that the next
// process rebuilds.
async function writeDiskCache(fingerprint: string, dump: Blob | File): Promise<void> {
  try {
    await mkdir(cacheDir, { recursive: true });
    const file = cacheFileFor(fingerprint);
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, new Uint8Array(await dump.arrayBuffer()));
    await rename(tmp, file);
    await pruneStaleCache();
  } catch {
    // Best-effort accelerator: a write failure just means the next process rebuilds.
  }
}

// Several DISTINCT schemas legitimately coexist (one snapshot per schemaSql fingerprint), so pruning
// must never evict a sibling fingerprint — it removes only tars unused for 7+ days (hits freshen the
// mtime above; superseded fingerprints stop being touched and age out) and orphaned `.tmp` partials
// from crashed writers.
const PRUNE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const PRUNE_TMP_MAX_AGE_MS = 60 * 60 * 1000;

async function pruneStaleCache(): Promise<void> {
  try {
    const now = Date.now();
    const entries = await readdir(cacheDir);
    await Promise.all(
      entries
        .filter((name) => cacheFileNamePattern.test(name) || name.endsWith(".tmp"))
        .map(async (name) => {
          const file = path.join(cacheDir, name);
          const maxAge = name.endsWith(".tmp") ? PRUNE_TMP_MAX_AGE_MS : PRUNE_MAX_AGE_MS;
          const { mtimeMs } = await stat(file);
          if (now - mtimeMs > maxAge) {
            await rm(file, { force: true });
          }
        })
        .map((promise) => promise.catch(() => {})),
    );
  } catch {
    // Pruning is cosmetic; ignore any failure.
  }
}

// sha256 over the snapshot's determinants; 16 hex chars is ample for a per-schema cache key. Returns
// undefined (→ skip the disk cache entirely) if any input can't be resolved, so we never key on a
// partial fingerprint.
async function computeFingerprint(schemaSql: string): Promise<string | undefined> {
  try {
    const supportSource = await readFile(fileURLToPath(import.meta.url), "utf8");
    const pgliteVersion = await resolvePackageVersion("@electric-sql/pglite");
    const prepopulatedVersion = await resolvePackageVersion("@electric-sql/pglite-prepopulatedfs");
    if (!pgliteVersion || !prepopulatedVersion) return undefined;
    const hash = createHash("sha256");
    hash.update("pgxsinkit-schema-cache-v1\0");
    hash.update(supportSource);
    hash.update("\0");
    hash.update(schemaSql);
    hash.update("\0");
    hash.update(`@electric-sql/pglite@${pgliteVersion}\0`);
    hash.update(`@electric-sql/pglite-prepopulatedfs@${prepopulatedVersion}\0`);
    return hash.digest("hex").slice(0, 16);
  } catch {
    return undefined;
  }
}

// Read a dependency's `version` without depending on it exporting `./package.json` (pglite does not):
// resolve the package entry, then walk up to the nearest `package.json` whose `name` matches.
async function resolvePackageVersion(name: string): Promise<string | undefined> {
  let dir: string;
  try {
    dir = path.dirname(requireFromHere.resolve(name));
  } catch {
    return undefined;
  }
  for (let depth = 0; depth < 12; depth++) {
    try {
      const parsed = JSON.parse(await readFile(path.join(dir, "package.json"), "utf8")) as {
        name?: string;
        version?: string;
      };
      if (parsed.name === name && typeof parsed.version === "string") return parsed.version;
    } catch {
      // Not this directory — keep walking up.
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

// Instances that existed when the current test started — i.e. ones a `beforeAll`/module-scope setup
// opened to share ACROSS tests. They must survive per-test cleanup, or the next test queries a closed
// handle. Refreshed at each test start (tests/support/setup.ts `beforeEach`).
let scopeMarker: ReadonlySet<PGlite> = new Set();

/** Snapshot the currently-open instances as "shared, do not close per-test". For `beforeEach`. */
export function markTestScope(): void {
  scopeMarker = new Set(openInstances);
}

/** Close only the instances opened DURING the current test (not the shared ones). For `afterEach`. */
export async function closeTestScopedPGlites(): Promise<void> {
  for (const pg of [...openInstances]) {
    if (scopeMarker.has(pg)) continue;
    openInstances.delete(pg);
    try {
      await pg.close();
    } catch {
      // Already closed by the test itself — fine.
    }
  }
}

/** Close every remaining instance (including shared ones). For `afterAll` / explicit teardown. */
export async function closeOpenTestPGlites(): Promise<void> {
  const instances = [...openInstances];
  openInstances.clear();
  scopeMarker = new Set();
  for (const pg of instances) {
    try {
      await pg.close();
    } catch {
      // Already closed/unsubscribed by the test itself — fine.
    }
  }
}
