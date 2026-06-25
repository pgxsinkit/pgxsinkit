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
// The first call for a given schema boots once, execs the DDL, and memoizes an UNCOMPRESSED data-dir
// dump; every later call just loads that dump (faster than the gzip base snapshot, and it skips the
// exec). Each instance is still a separate store, so per-test isolation is unchanged. Use this instead
// of `createFreshTestPGlite()` + `db.exec(schemaSql)` in a file that boots the same schema many times.
const schemaDumpCache = new Map<string, Promise<Blob | File>>();

export async function createSchemaTestPGlite(schemaSql: string): Promise<PGlite> {
  let dump = schemaDumpCache.get(schemaSql);
  if (!dump) {
    dump = (async () => {
      const seed = await PGlite.create({ loadDataDir: await prepopulatedDataDir() });
      await seed.exec(schemaSql);
      const snapshot = await seed.dumpDataDir("none"); // uncompressed = fastest reload
      await seed.close();
      return snapshot;
    })();
    schemaDumpCache.set(schemaSql, dump);
  }
  const pg = await PGlite.create({ loadDataDir: await dump });
  openInstances.add(pg);
  return pg;
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
