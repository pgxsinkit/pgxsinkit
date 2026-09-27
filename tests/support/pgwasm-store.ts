import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createPgwasm,
  type Extensions,
  type Pgwasm,
  type PgwasmOptions,
  type PgwasmWithExtensions,
} from "@pgxsinkit/pgwasm";
import { cBuild } from "@pgxsinkit/pgwasm-c";
import { prepopulatedDataDir } from "@pgxsinkit/pgwasm-c/prepopulated";

// createRequire anchored to THIS file (not cwd): the unit runner spawns processes whose cwd is the
// repo root, but dependency resolution — the store factory below included — must follow this module's
// node_modules (isolated installs).
const requireFromHere = createRequire(import.meta.url);

// ── the store seam ────────────────────────────────────────────────────────────
//
// Every store these helpers hand out is built by ONE of two paths:
//
//   * unset `PGXSINKIT_TEST_STORE_FACTORY` (the default, and what CI runs) — pgwasm on the C build:
//     the `@pgxsinkit/pgwasm-c/prepopulated` base image, `createPgwasm({ build: cBuild, … })`, and the
//     two-tier schema-dump cache below;
//   * `PGXSINKIT_TEST_STORE_FACTORY=<module>` — that module builds the stores instead, so the SAME
//     unit suite can be run against another PostgreSQL-shaped engine without a line of engine-specific
//     code in the repo. Nothing here knows or names any particular engine.
//
// **The contract.** The module's default export, or the module namespace itself, must satisfy
// {@link TestStoreFactory}:
//
//   * `createFresh(options?)` — a fresh, empty store on the factory's OWN seed image, honouring what
//     it can of the create options ({@link TestPgwasmOptions}) the caller passed (`extensions` above
//     all) and ignoring what it cannot. It replaces
//     `createPgwasm({ build: cBuild, ...options, loadDataDir: <prepopulated base> })`. A pgrust lane's
//     factory is `createPgwasm({ build: pgrustBuild, … })` (ADR-0062 d9).
//   * `createFromDump(dump, options?)` — a store booted ON a datadir dump THIS factory produced (the
//     `loadDataDir` create option). Dumps are never portable between engines, which is why the
//     factory both writes (`dumpDataDir`) and reads them.
//   * `cacheKeyPrefix?` — the filename prefix for the schema-dump disk cache under `tmp/pglite-cache/`.
//     It MUST be distinct per engine (a dump one engine wrote will not boot on another), and it is the
//     one thing that keeps two engines' snapshots from colliding on one file. Default:
//     `pgwasm-c-schema-`.
//   * `cacheIdentity?` — extra fingerprint material (engine name + version). Folded into the cache key
//     so a factory upgrade invalidates its own snapshots.
//   * `closeAll?()` — teardown for anything the factory owns BEYOND the instances it handed back
//     (those are closed individually). Called from `closeOpenTestPgwasms`, possibly many times per
//     process, so it must be idempotent.
//
// **The module is loaded with `require`, not `import()`.** A computed `import()` here would make every
// test file that imports this helper *ungraphable* to the unit-test selector (ADR-0051) and so
// permanently uncacheable. The consequence for a factory author: the module and its whole static
// import graph must be require-loadable — **no top-level await** — so a factory whose engine is an
// async module must reach it with a dynamic `import()` INSIDE its own methods. The specifier is
// resolved from this file, so an absolute path (a factory living in another checkout) is the usual
// form; that module's own imports resolve from its own location.
export const TEST_STORE_FACTORY_ENV = "PGXSINKIT_TEST_STORE_FACTORY";

/** The engine-agnostic store contract; see the block above for the full description of each member. */
export interface TestStoreFactory {
  /** A fresh, empty store on the factory's own seed image. */
  createFresh(options?: TestPgwasmOptions): Promise<Pgwasm>;
  /** A store booted on a datadir dump this same factory produced. */
  createFromDump(dump: Blob | File, options?: TestPgwasmOptions): Promise<Pgwasm>;
  /** Schema-dump cache filename prefix; MUST be distinct per engine. */
  readonly cacheKeyPrefix?: string;
  /** Extra cache-fingerprint material — the engine's identity and version. */
  readonly cacheIdentity?: string;
  /** Idempotent teardown of anything the factory owns beyond the instances it handed out. */
  closeAll?(): Promise<void>;
}

/** The default lane's snapshot filename prefix: the C build's dumps. */
const DEFAULT_CACHE_KEY_PREFIX = "pgwasm-c-schema-";

// Resolution is memoized against the env var's CURRENT value rather than once per process: the seam's
// own test sets and clears it, and a stale memo would answer for the wrong lane.
let factoryMemo: { source: string; factory: TestStoreFactory | undefined } | undefined;

/**
 * The active store factory, or `undefined` for the default C-build path.
 *
 * Synchronous by construction (see the `require` note above), so every call site can stay on the code
 * path it had.
 */
export function resolveTestStoreFactory(): TestStoreFactory | undefined {
  const source = process.env[TEST_STORE_FACTORY_ENV]?.trim() ?? "";
  if (factoryMemo?.source === source) return factoryMemo.factory;
  const factory = source === "" ? undefined : loadTestStoreFactory(source);
  factoryMemo = { source, factory };
  return factory;
}

// A misconfigured factory FAILS LOUDLY (unlike the disk cache, which degrades silently): the whole
// point of setting the variable is to run against that engine, so silently falling back to the C build
// would report a green suite for a lane that never ran.
function loadTestStoreFactory(source: string): TestStoreFactory {
  let loaded: Record<string, unknown>;
  try {
    loaded = requireFromHere(source) as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      `${TEST_STORE_FACTORY_ENV}=${source} could not be loaded. It must be require-loadable from ` +
        `tests/support/pgwasm-store.ts — an absolute path, and no top-level await anywhere in its import graph.`,
      { cause: error },
    );
  }
  const candidate = (loaded["default"] ?? loaded) as Partial<TestStoreFactory>;
  for (const method of ["createFresh", "createFromDump"] as const) {
    if (typeof candidate[method] !== "function") {
      throw new Error(`${TEST_STORE_FACTORY_ENV}=${source} exports no \`${method}\` function (see TestStoreFactory).`);
    }
  }
  const prefix = candidate.cacheKeyPrefix;
  if (prefix !== undefined && (prefix === "" || /[/\\]/.test(prefix))) {
    throw new Error(
      `${TEST_STORE_FACTORY_ENV}=${source} has an unusable \`cacheKeyPrefix\`: ${JSON.stringify(prefix)}`,
    );
  }
  return candidate as TestStoreFactory;
}

/** The create options a test passes: pgwasm's own, minus `build`, which the active lane supplies. */
export type TestPgwasmOptions<E extends Extensions = Extensions> = Omit<PgwasmOptions<E>, "build">;

/** A fresh, empty store: the factory's when one is set, the prepopulated C-build store otherwise. */
async function createStore(options?: TestPgwasmOptions): Promise<Pgwasm> {
  const factory = resolveTestStoreFactory();
  if (factory) return await factory.createFresh(options);
  return await createPgwasm({ build: cBuild, ...options, loadDataDir: await prepopulatedDataDir() });
}

/** A store booted on a dump the ACTIVE lane produced — the `loadDataDir` half of the same seam. */
async function createStoreFromDump(dump: Blob | File, options?: TestPgwasmOptions): Promise<Pgwasm> {
  const factory = resolveTestStoreFactory();
  if (factory) return await factory.createFromDump(dump, options);
  return await createPgwasm({ build: cBuild, ...options, loadDataDir: dump });
}

// Every instance these helpers hand out is tracked so a test file can close them all in one
// `afterEach(closeOpenTestPgwasms)`. This matters for more than tidiness: an un-closed PGlite keeps its
// (multi-MB) WASM heap alive, so a file that boots one per test and never closes them accumulates
// memory across the run — later tests then boot and operate **progressively slower** under the growing
// heap (and bun force-exits with code 99 on the leaked handles). A factory's instance can be a whole
// engine (processes, worker threads), where a leak does not merely slow the run down but hangs it.
// Closing each test's instance keeps every boot cheap and the run flat.
const openInstances = new Set<Pgwasm>();

export async function createFreshTestPgwasm<E extends Extensions = Record<never, never>>(
  options?: TestPgwasmOptions<E>,
): Promise<PgwasmWithExtensions<E>> {
  const pg = await createStore(options);
  openInstances.add(pg);
  // The declared type carries the requested extensions' namespaces: a factory's instance is required to
  // honour `extensions`. This cast is the seam's single point of untruth.
  return pg as PgwasmWithExtensions<E>;
}

// A fresh, isolated store that already has `schemaSql` applied, WITHOUT re-running the DDL each time.
// The dump (the lane's own base → `exec(schemaSql)` → uncompressed `dumpDataDir("none")`) is memoized
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
// `generateLocalSchemaSql(...)` output — the seed schema itself), a hash of the C build's artefact pins
// (`packages/pgwasm-c/src/artefact-pins.ts`: the base image + engine), and the
// active factory's `cacheIdentity`. Any of those changing yields a new key, so a stale tar is never
// loaded. The FILENAME carries the lane's `cacheKeyPrefix` on top of that, because a dump is only ever
// readable by the engine that wrote it: two engines must never so much as consider each other's file.
//
// The disk cache is strictly a best-effort accelerator: EVERY disk failure (unresolvable fingerprint,
// read/write error, or a corrupt/truncated tar that fails to boot) degrades silently to the in-memory
// build path. A broken cache must never fail a test run. Each instance is still a separate store, so
// per-test isolation is unchanged. Use this instead of `createFreshTestPgwasm()` + `db.exec(schemaSql)`
// in a file that boots the same schema many times.
const schemaDumpCache = new Map<string, Promise<Blob | File>>();

// This file lives at `<repoRoot>/tests/support/pgwasm-store.ts`, so the repo root is two levels up.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cacheDir = path.join(repoRoot, "tmp", "pglite-cache");
const cacheKeyPrefix = () => resolveTestStoreFactory()?.cacheKeyPrefix ?? DEFAULT_CACHE_KEY_PREFIX;
const cacheFileFor = (fingerprint: string) => path.join(cacheDir, `${cacheKeyPrefix()}${fingerprint}.tar`);
// Pruning is scoped to the ACTIVE lane's prefix so one engine's run never ages out another's snapshots.
// The fingerprint is matched exactly (16 hex chars) rather than `.*`, so a longer prefix cannot be read
// as this one's name plus a fingerprint — two lanes are disjoint on the strength of a differing prefix
// alone.
const cacheFileNamePattern = () =>
  new RegExp(`^${cacheKeyPrefix().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[0-9a-f]{16}\\.tar$`);

export async function createSchemaTestPgwasm(schemaSql: string): Promise<Pgwasm> {
  let dump = schemaDumpCache.get(schemaSql);
  if (!dump) {
    dump = resolveSchemaDump(schemaSql);
    schemaDumpCache.set(schemaSql, dump);
  }
  const pg = await createStoreFromDump(await dump);
  openInstances.add(pg);
  return pg as Pgwasm;
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

// The original in-memory build: the lane's own base → apply the DDL → uncompressed dump (fastest
// reload). The seed is deliberately NOT tracked in `openInstances` — it is closed here, on the failure
// path too, because a factory's seed can be a whole engine that would otherwise outlive the run.
async function buildSchemaDump(schemaSql: string): Promise<Blob | File> {
  const seed = await createStore();
  try {
    await seed.exec(schemaSql);
    return await seed.dumpDataDir("none"); // uncompressed = fastest reload
  } finally {
    await seed.close().catch(() => {});
  }
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
    const probe = await createStoreFromDump(blob);
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
    const pattern = cacheFileNamePattern();
    await Promise.all(
      entries
        .filter((name) => pattern.test(name) || name.endsWith(".tmp"))
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
    const engine = await engineIdentity();
    if (engine === undefined) return undefined;
    const hash = createHash("sha256");
    hash.update("pgxsinkit-schema-cache-v1\0");
    hash.update(supportSource);
    hash.update("\0");
    hash.update(schemaSql);
    hash.update("\0");
    hash.update(engine);
    return hash.digest("hex").slice(0, 16);
  } catch {
    return undefined;
  }
}

// The base image + engine, as the ACTIVE lane names it. On the default path that is a hash of the C
// build's artefact pins (every artefact's sha256, the prepopulated image's included), and an unreadable
// pin file still disables the disk cache (never key on a partial fingerprint). Under a factory the C build
// determines no byte of the snapshot, so the factory's own identity stands in its place.
async function engineIdentity(): Promise<string | undefined> {
  const factory = resolveTestStoreFactory();
  if (factory) {
    return `${factory.cacheIdentity ?? factory.cacheKeyPrefix ?? process.env[TEST_STORE_FACTORY_ENV] ?? "factory"}\0`;
  }
  let pins: string;
  try {
    pins = await readFile(path.join(repoRoot, "packages", "pgwasm-c", "src", "artefact-pins.ts"), "utf8");
  } catch {
    return undefined;
  }
  return `pgwasm-c-artefact-pins@${createHash("sha256").update(pins).digest("hex")}\0`;
}

// Instances that existed when the current test started — i.e. ones a `beforeAll`/module-scope setup
// opened to share ACROSS tests. They must survive per-test cleanup, or the next test queries a closed
// handle. Refreshed at each test start (tests/support/setup.ts `beforeEach`).
let scopeMarker: ReadonlySet<Pgwasm> = new Set();

/** Snapshot the currently-open instances as "shared, do not close per-test". For `beforeEach`. */
export function markTestScope(): void {
  scopeMarker = new Set(openInstances);
}

/** Close only the instances opened DURING the current test (not the shared ones). For `afterEach`. */
export async function closeTestScopedPgwasms(): Promise<void> {
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
export async function closeOpenTestPgwasms(): Promise<void> {
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
  // Whatever the factory owns beyond those instances goes too: a leaked engine does not merely slow
  // the run down, it keeps the process alive. Declared idempotent, and never fatal here.
  try {
    await resolveTestStoreFactory()?.closeAll?.();
  } catch {
    // Teardown is best-effort: a factory that cannot close must not fail a green file.
  }
}
