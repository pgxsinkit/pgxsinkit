// Began as a port of `@electric-sql/pglite`'s web target tests (`tests/targets/web/base.js` and
// `idbfs-correctness.test.web.js`, taken under its PostgreSQL License option, © ElectricSQL — see
// NOTICE). Owned outright (ADR-0062); compatibility with PGlite is an anti-goal.

import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { continuityBuilds } from "virtual:pgwasm-continuity-builds";

import { createPgwasm, type Pgwasm } from "@pgxsinkit/pgwasm";
import { C_BUILD_IDENTITY, cBuild, createCBuild } from "@pgxsinkit/pgwasm-c";
import { prepopulatedDataDir } from "@pgxsinkit/pgwasm-c/prepopulated";
import { pgDump } from "@pgxsinkit/pgwasm-pg-dump";
import { Repl } from "@pgxsinkit/pgwasm-repl";

import { type CBuildArtefactSet, pinnedCBuildArtefacts } from "../../../packages/pgwasm-c/src/artefacts";
import { createCBuildFrom } from "../../../packages/pgwasm-c/src/build";
import type { PostgresModule } from "../../../packages/pgwasm-c/src/host/emscripten";
import { PGDATA } from "../../../packages/pgwasm-c/src/host/paths";

/**
 * The page side of the IndexedDB browser lane: pgwasm on the C build with `idb://` storage, in a real
 * browser (Bun has neither IndexedDB nor Web Locks). Each scenario runs whole in the page and returns
 * plain data for the Playwright test to assert on; the base flow keeps one database open across calls.
 */

interface ErrorShape {
  readonly name: string;
  readonly message: string;
}

interface QueryShape {
  readonly rows: unknown[];
  readonly fields: { name: string; dataTypeID: number }[];
  readonly affectedRows: number | undefined;
}

type SyncfsCallback = (error: unknown) => void;
type Syncfs = (populate: boolean, callback: SyncfsCallback) => void;

interface RemoteSetStub {
  getRemoteSet: (mount: unknown, callback: (...args: unknown[]) => void) => void;
}

const describeError = (error: unknown): ErrorShape =>
  error instanceof Error ? { name: error.name, message: error.message } : { name: "unknown", message: String(error) };

async function errorOf(operation: () => Promise<unknown>): Promise<ErrorShape | null> {
  try {
    await operation();
  } catch (error) {
    return describeError(error);
  }
  return null;
}

const idb = (name: string) => `idb://${name}`;
/** The IndexedDB database behind `idb://<name>`: named after its mount point. */
const databaseName = (name: string) => `/pglite/${name}`;
const nextMacrotask = (ms = 0) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Delete a store's IndexedDB database. `retry` waits out a `blocked` delete (a connection still closing);
 * `report` fails it, for the scenarios whose point is that nothing is left open.
 */
function deleteStore(name: string, onBlocked: "retry" | "report"): Promise<{ readonly blocked: boolean }> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(databaseName(name));
    request.onsuccess = () => resolve({ blocked: false });
    request.onerror = () => reject(request.error ?? new Error("deleting the IndexedDB database failed"));
    request.onblocked = () => {
      if (onBlocked === "report") resolve({ blocked: true });
      else void nextMacrotask(10).then(() => deleteStore(name, onBlocked).then(resolve, reject));
    };
  });
}

/** A C build that hands the test each Postgres module it mounts storage on. */
function capturingBuild(): { readonly build: ReturnType<typeof createCBuild>; readonly module: () => PostgresModule } {
  let captured: PostgresModule | undefined;
  const build = createCBuild({
    onPostgresModule: (module) => {
      captured = module;
    },
  });
  return {
    build,
    module: () => {
      if (captured === undefined) throw new Error("no Postgres module was instantiated");
      return captured;
    },
  };
}

/** Wrap the module's `FS.syncfs`, keeping the original for the wrapper to call. */
/**
 * An earlier C build (continuity-builds.ts), on its own glue and files: the host is the current one, as
 * `createCBuild` runs it, and its identity records that release, as that release's own pgwasm did.
 */
function continuityBuild(tag: string, onPostgresModule: (module: PostgresModule) => void) {
  const files = continuityBuilds.find((build) => build.tag === tag);
  if (files === undefined) throw new Error(`no continuity build ${tag}; see continuity-builds.ts`);
  const artefacts: CBuildArtefactSet = {
    // The default exports of that release's pglite.js and initdb.js: the same factories as the pinned glue's.
    createPostgresModule: files.createPostgresModule as CBuildArtefactSet["createPostgresModule"],
    createInitdbModule: files.createInitdbModule as CBuildArtefactSet["createInitdbModule"],
    postgresWasm: new URL(files.postgresWasm, location.href),
    initdbWasm: new URL(files.initdbWasm, location.href),
    fsBundle: new URL(files.fsBundle, location.href),
    fsBundleBytes: files.fsBundleBytes,
  };
  return createCBuildFrom(
    { ...C_BUILD_IDENTITY, dataFormat: files.dataFormat, release: `pgwasm-postgres ${tag}` },
    artefacts,
    { onPostgresModule },
  );
}

const BUILD_MARKER = `${PGDATA}/PGWASM_BUILD`;
const readMarker = (module: PostgresModule): string | null =>
  module.FS.analyzePath(BUILD_MARKER).exists ? new TextDecoder().decode(module.FS.readFile(BUILD_MARKER)) : null;

type Row = Record<string, unknown>;

function sameValue(a: unknown, b: unknown): boolean {
  if (a instanceof Uint8Array && b instanceof Uint8Array) {
    return a.length === b.length && a.every((byte, index) => byte === b[index]);
  }
  return a === b;
}

/** Whether two result sets hold the same values, bytea compared byte for byte. */
function sameRows(a: readonly Row[], b: readonly Row[]): boolean {
  return (
    a.length === b.length &&
    a.every((row, index) => {
      const other = b[index];
      return (
        other !== undefined &&
        Object.keys(row).length === Object.keys(other).length &&
        Object.entries(row).every(([column, value]) => sameValue(value, other[column]))
      );
    })
  );
}

async function versionOf(pg: Pgwasm): Promise<string> {
  const [row] = (await pg.query<{ version: string }>("SELECT version()")).rows;
  if (row === undefined) throw new Error("version() returned no row");
  return row.version;
}

const CONTINUITY_ROWS = "SELECT id, label, payload, body FROM continuity ORDER BY id";
/** What Postgres itself says of each row: sizes and digests, compared across the two builds. */
const CONTINUITY_SUMMARY = `SELECT id, label, octet_length(payload) AS payload_bytes, md5(payload) AS payload_md5,
  length(body) AS body_chars, md5(body) AS body_md5 FROM continuity ORDER BY id`;

function wrapSyncfs(module: PostgresModule, wrap: (original: Syncfs) => Syncfs): void {
  const fs = module.FS;
  const original: Syncfs = fs.syncfs.bind(fs);
  fs.syncfs = wrap(original);
}

function shapeOf(result: Awaited<ReturnType<Pgwasm["query"]>>): QueryShape {
  return {
    rows: result.rows,
    fields: result.fields.map(({ name, dataTypeID }) => ({ name, dataTypeID })),
    affectedRows: result.affectedRows,
  };
}

// ─── the base flow: one database across calls ──────────────────────────────────

let base: Pgwasm | undefined;
let repl: { readonly pg: Pgwasm; readonly root: Root; readonly container: HTMLElement } | undefined;

function openBase(): Pgwasm {
  if (base === undefined) throw new Error("no database is open; call open() first");
  return base;
}

const harness = {
  deleteStore,

  async open(name: string): Promise<void> {
    base = await createPgwasm({ build: cBuild, dataDir: idb(name) });
  },

  async query(sql: string, params?: unknown[]): Promise<QueryShape> {
    return shapeOf(await openBase().query(sql, params));
  },

  async exec(sql: string): Promise<void> {
    await openBase().exec(sql);
  },

  /** Dump the open database gzipped and load the dump into an in-memory database. */
  async dumpAndLoad(sql: string): Promise<{ readonly rows: unknown[]; readonly fileName: string }> {
    const file = await openBase().dumpDataDir("gzip");
    const loaded = await createPgwasm({ build: cBuild, loadDataDir: file });
    try {
      return { rows: (await loaded.query(sql)).rows, fileName: file.name };
    } finally {
      await loaded.close();
    }
  },

  async close(): Promise<ErrorShape | null> {
    const db = openBase();
    base = undefined;
    return errorOf(() => db.close());
  },

  // ─── IDBFS correctness ────────────────────────────────────────────────────────

  // ─── cross-build continuity ─────────────────────────────────────────────────────

  /**
   * An earlier build (continuity-builds.ts) creates a store and writes rows to it, a bytea and a large
   * text among them; `unmarked` then removes its build marker, as a store made before markers (pgxsinkit
   * ≤0.3.x, PGlite 0.5.8's wasm) has none. The current build opens the store, reads the rows back, writes
   * a row, and reopens it. A build that does not claim unmarked directories must refuse the unmarked one.
   */
  async continuity(
    tag: string,
    name: string,
    marker: "marked" | "unmarked",
  ): Promise<{
    readonly earlierVersion: string;
    readonly currentVersion: string;
    readonly written: unknown[];
    readonly read: unknown[];
    readonly identical: boolean;
    readonly markerWritten: string | null;
    readonly markerRead: string | null;
    readonly refusedWithoutClaim: ErrorShape | null;
    readonly afterWrite: unknown[];
    readonly markerAfterWrite: string | null;
    readonly blocked: boolean;
  }> {
    await deleteStore(name, "retry");
    let earlierModule: PostgresModule | undefined;
    const earlier = await createPgwasm({
      build: continuityBuild(tag, (module) => {
        earlierModule = module;
      }),
      dataDir: idb(name),
    });
    await earlier.exec(`
      CREATE TABLE continuity (id serial PRIMARY KEY, label text NOT NULL, payload bytea, body text);
      INSERT INTO continuity (label) VALUES ('plain');
      INSERT INTO continuity (label, payload, body) VALUES ('bytes', '\\x00ff7f80deadbeef'::bytea, 'ünïcødé ✓');
      INSERT INTO continuity (label, payload, body)
        SELECT 'large', decode(string_agg(md5(i::text), ''), 'hex'), string_agg(md5((-i)::text), '')
        FROM generate_series(1, 20000) AS i;
    `);
    const earlierVersion = await versionOf(earlier);
    const writtenRows = (await earlier.query<Row>(CONTINUITY_ROWS)).rows;
    const written = (await earlier.query(CONTINUITY_SUMMARY)).rows;
    if (earlierModule === undefined) throw new Error("the earlier build instantiated no Postgres module");
    const markerWritten = readMarker(earlierModule);
    if (marker === "unmarked") earlierModule.FS.unlink(BUILD_MARKER);
    await earlier.close();

    const refusedWithoutClaim =
      marker === "unmarked"
        ? await errorOf(async () => {
            const refusing = createCBuildFrom(
              { ...C_BUILD_IDENTITY, claimsUnmarkedDirectories: false },
              pinnedCBuildArtefacts,
            );
            const opened = await createPgwasm({ build: refusing, dataDir: idb(name) });
            await opened.close();
          })
        : null;

    const { build, module } = capturingBuild();
    const current = await createPgwasm({ build, dataDir: idb(name) });
    const markerRead = readMarker(module());
    const currentVersion = await versionOf(current);
    const identical = sameRows(writtenRows, (await current.query<Row>(CONTINUITY_ROWS)).rows);
    const read = (await current.query(CONTINUITY_SUMMARY)).rows;
    await current.exec("INSERT INTO continuity (label, body) VALUES ('after', 'written by the current build')");
    await current.close();

    const reopenedBuild = capturingBuild();
    const reopened = await createPgwasm({ build: reopenedBuild.build, dataDir: idb(name) });
    const markerAfterWrite = readMarker(reopenedBuild.module());
    const afterWrite = (
      await reopened.query("SELECT id, label, length(body) AS body_chars FROM continuity ORDER BY id")
    ).rows;
    await reopened.close();
    return {
      earlierVersion,
      currentVersion,
      written,
      read,
      identical,
      markerWritten,
      markerRead,
      refusedWithoutClaim,
      afterWrite,
      markerAfterWrite,
      ...(await deleteStore(name, "report")),
    };
  },

  /** A second open of the same store, in this page, is refused while the first is open. */
  async secondOwner(name: string): Promise<{ readonly contender: ErrorShape | null; readonly blocked: boolean }> {
    const owner = await createPgwasm({ build: cBuild, dataDir: idb(name) });
    const contender = await errorOf(async () => {
      const second = await createPgwasm({ build: cBuild, dataDir: idb(name) });
      await second.close();
    });
    await owner.close();
    const next = await createPgwasm({ build: cBuild, dataDir: idb(name) });
    await next.close();
    return { contender, ...(await deleteStore(name, "report")) };
  },

  /** Open a store and keep it open, for another page to contend for. */
  async hold(name: string): Promise<void> {
    base = await createPgwasm({ build: cBuild, dataDir: idb(name) });
  },

  /** Try to open a store another page holds. */
  async contend(name: string): Promise<ErrorShape | null> {
    return errorOf(async () => {
      const second = await createPgwasm({ build: cBuild, dataDir: idb(name) });
      await second.close();
    });
  },

  /** A boot that fails before Postgres exists (a bad filesystem bundle) releases the store's lock. */
  async failedBootReleases(
    name: string,
  ): Promise<{ readonly bootError: ErrorShape | null; readonly blocked: boolean }> {
    const failing = createCBuild({ fsBundle: new Blob([new Uint8Array(1)]) });
    const bootError = await errorOf(() => createPgwasm({ build: failing, dataDir: idb(name) }));
    const next = await createPgwasm({ build: cBuild, dataDir: idb(name) });
    await next.close();
    return { bootError, ...(await deleteStore(name, "report")) };
  },

  /**
   * A boot that fails after starting, with a background persist in flight (an extension's init ran a
   * statement under relaxed durability, and its IndexedDB sync is slowed), closes the IndexedDB
   * connection and releases the lock once that persist settles.
   */
  async lateBootFailure(name: string): Promise<{ readonly bootError: ErrorShape | null; readonly blocked: boolean }> {
    const { build, module } = capturingBuild();
    const bootError = await errorOf(() =>
      createPgwasm({
        build,
        dataDir: idb(name),
        relaxedDurability: true,
        extensions: {
          failing: {
            name: "failing",
            setup: async (pg) => ({
              init: async () => {
                wrapSyncfs(module(), (original) => {
                  let delayNext = true;
                  return (populate, callback) =>
                    original(populate, (error) => {
                      if (!populate && delayNext) {
                        delayNext = false;
                        setTimeout(() => callback(error), 50);
                      } else callback(error);
                    });
                });
                await pg.exec("CREATE TABLE late (value integer)");
                throw new Error("forced late initialization failure");
              },
            }),
          },
        },
      }),
    );
    const next = await createPgwasm({ build: cBuild, dataDir: idb(name) });
    await next.close();
    return { bootError, ...(await deleteStore(name, "report")) };
  },

  /**
   * Relaxed durability does not hold statements behind an in-flight snapshot: the next statement
   * completes while the previous statement's IndexedDB sync waits on its remote set.
   */
  async relaxedRunsBesideSnapshot(name: string): Promise<{ readonly completedBeforeRelease: boolean }> {
    const setup = await createPgwasm({ build: cBuild, dataDir: idb(name) });
    await setup.exec("CREATE TABLE test (value integer)");
    await setup.close();

    const { build, module } = capturingBuild();
    const db = await createPgwasm({ build, dataDir: idb(name), relaxedDurability: true });
    const idbfs = module().FS.filesystems.IDBFS as unknown as RemoteSetStub;
    const originalGetRemoteSet = idbfs.getRemoteSet;
    let remoteSetRequested!: () => void;
    const requested = new Promise<void>((resolve) => {
      remoteSetRequested = resolve;
    });
    let releaseRemoteSet!: () => void;
    const released = new Promise<void>((resolve) => {
      releaseRemoteSet = resolve;
    });
    idbfs.getRemoteSet = (mount, callback) => {
      idbfs.getRemoteSet = originalGetRemoteSet;
      remoteSetRequested();
      void released.then(() => originalGetRemoteSet.call(idbfs, mount, callback));
    };

    await db.exec("INSERT INTO test VALUES (1)");
    await requested;
    let secondFinished = false;
    const second = db.exec("INSERT INTO test VALUES (2)").then(() => {
      secondFinished = true;
    });
    await nextMacrotask(50);
    const completedBeforeRelease = secondFinished;
    releaseRemoteSet();
    await second;
    await db.close();
    await deleteStore(name, "report");
    return { completedBeforeRelease };
  },

  /**
   * A strict statement does not complete until the clock has moved past its sync: IDBFS compares
   * millisecond mtimes, so a later write in the same millisecond could be skipped by the next sync.
   */
  async strictWaitsForClock(
    name: string,
  ): Promise<{ readonly completedBeforeClockAdvance: boolean; readonly persisted: unknown[] }> {
    const { build, module } = capturingBuild();
    const db = await createPgwasm({ build, dataDir: idb(name) });
    await db.exec("CREATE TABLE test (value integer)");

    let syncCompleted!: () => void;
    const completed = new Promise<void>((resolve) => {
      syncCompleted = resolve;
    });
    wrapSyncfs(module(), (original) => {
      let intercept = true;
      return (populate, callback) =>
        original(populate, (error) => {
          if (!populate && intercept) {
            intercept = false;
            syncCompleted();
          }
          callback(error);
        });
    });

    const realNow = Date.now;
    let now = realNow();
    Date.now = () => now;
    let completedBeforeClockAdvance: boolean;
    try {
      let finished = false;
      const statement = db.exec("INSERT INTO test VALUES (1)").then(() => {
        finished = true;
      });
      await completed;
      await nextMacrotask();
      completedBeforeClockAdvance = finished;
      now += 1;
      await statement;
    } finally {
      // A frozen clock would outlive a failure here and break every later scenario in the page.
      Date.now = realNow;
    }
    await db.close();

    const reopened = await createPgwasm({ build: cBuild, dataDir: idb(name) });
    const persisted = (await reopened.query("SELECT value FROM test")).rows;
    await reopened.close();
    await deleteStore(name, "report");
    return { completedBeforeClockAdvance, persisted };
  },

  /**
   * A background persist failure reaches the next statement; the final persist on close recovers it,
   * releases the lock, and the store reopens with the write.
   */
  async relaxedFailureRecoveredOnClose(name: string): Promise<{
    readonly statementError: ErrorShape | null;
    readonly closeError: ErrorShape | null;
    readonly persisted: unknown[];
  }> {
    const { build, module } = capturingBuild();
    const db = await createPgwasm({ build, dataDir: idb(name), relaxedDurability: true });
    await db.exec("CREATE TABLE test (value integer)");

    let failureDelivered!: () => void;
    const delivered = new Promise<void>((resolve) => {
      failureDelivered = resolve;
    });
    wrapSyncfs(module(), (original) => {
      let failNext = true;
      return (populate, callback) => {
        if (!populate && failNext) {
          failNext = false;
          queueMicrotask(() => {
            callback(new Error("forced sync failure"));
            failureDelivered();
          });
        } else original(populate, callback);
      };
    });

    await db.exec("INSERT INTO test VALUES (1)");
    // The failing persist runs in the background (possibly behind an earlier one); wait for its
    // rejection to settle before the statement that should report it.
    await delivered;
    await nextMacrotask();
    const statementError = await errorOf(() => db.exec("SELECT * FROM test"));
    const closeError = await errorOf(() => db.close());

    const next = await createPgwasm({ build: cBuild, dataDir: idb(name) });
    const persisted = (await next.query("SELECT value FROM test")).rows;
    await next.close();
    await deleteStore(name, "report");
    return { statementError, closeError, persisted };
  },

  /**
   * An extension whose close hook throws does not stop the shutdown: Postgres runs its exit hooks, the
   * final persist runs, the lock is released, and the close reports the hook's error.
   */
  async extensionCloseFailure(name: string): Promise<{
    readonly closeError: ErrorShape | null;
    readonly finalPersistRequested: boolean;
    readonly exitHooksRan: boolean;
    readonly queryWhileClosing: ErrorShape | null;
    readonly queryAfterClose: ErrorShape | null;
    readonly blocked: boolean;
  }> {
    const { build, module } = capturingBuild();
    let finalPersistRequested = false;
    let exitHooksRan = false;
    let queryWhileClosing: ErrorShape | null = null;
    const db = await createPgwasm({
      build,
      dataDir: idb(name),
      relaxedDurability: true,
      extensions: {
        failing: {
          name: "failing",
          setup: async (pg) => ({
            close: async () => {
              queryWhileClosing = await errorOf(() => pg.query("SELECT 1"));
              const mod = module();
              wrapSyncfs(mod, (original) => (populate, callback) => {
                if (!populate) finalPersistRequested = true;
                original(populate, callback);
              });
              const runExitHooks = mod._pgl_run_atexit_funcs.bind(mod);
              mod._pgl_run_atexit_funcs = () => {
                exitHooksRan = true;
                runExitHooks();
              };
              throw new Error("forced extension close failure");
            },
          }),
        },
      },
    });

    // A background persist still in flight when the close starts: the close waits for it.
    wrapSyncfs(module(), (original) => {
      let delayNext = true;
      return (populate, callback) =>
        original(populate, (error) => {
          if (!populate && delayNext) {
            delayNext = false;
            setTimeout(() => callback(error), 50);
          } else callback(error);
        });
    });
    await db.exec("SELECT 1");

    const closeError = await errorOf(() => db.close());
    const queryAfterClose = await errorOf(() => db.query("SELECT 1"));
    const next = await createPgwasm({ build: cBuild, dataDir: idb(name) });
    await next.close();
    return {
      closeError,
      finalPersistRequested,
      exitHooksRan,
      queryWhileClosing,
      queryAfterClose,
      ...(await deleteStore(name, "report")),
    };
  },

  /** When both the final persist and an extension's close hook fail, the close reports the persist. */
  async finalPersistFailureFirst(name: string): Promise<{ readonly closeError: ErrorShape | null }> {
    const { build, module } = capturingBuild();
    const db = await createPgwasm({
      build,
      dataDir: idb(name),
      extensions: {
        failing: {
          name: "failing",
          setup: async () => ({
            close: async () => {
              module().FS.syncfs = (populate, callback) => {
                if (populate) callback(null);
                else queueMicrotask(() => callback(new Error("forced final sync failure")));
              };
              throw new Error("forced extension close failure");
            },
          }),
        },
      },
    });
    const closeError = await errorOf(() => db.close());
    const next = await createPgwasm({ build: cBuild, dataDir: idb(name) });
    await next.close();
    await deleteStore(name, "report");
    return { closeError };
  },

  /**
   * A clean close shuts Postgres down, so the next open does not run crash recovery; a close whose
   * shutdown writes never reach IndexedDB (every persist dropped) does — the control that proves the
   * detection works — and keeps every statement's persisted write.
   */
  async cleanShutdown(name: string): Promise<{
    readonly cleanRecovery: boolean;
    readonly crashRecovery: boolean;
    readonly persistedAfterCrash: unknown[];
  }> {
    const recovery = /not properly shut down|automatic recovery/;
    // With debug on, Postgres's stderr goes to console.error, where crash recovery announces itself.
    const reopenCollectingStderr = async () => {
      const messages: string[] = [];
      const consoleError = console.error;
      console.error = (...args: unknown[]) => {
        messages.push(args.map(String).join(" "));
      };
      try {
        const reopened = await createPgwasm({ build: cBuild, dataDir: idb(name), debug: 1 });
        const rows = (await reopened.query("SELECT value FROM test ORDER BY value")).rows;
        await reopened.close();
        return { messages, rows };
      } finally {
        console.error = consoleError;
      }
    };

    const db = await createPgwasm({ build: cBuild, dataDir: idb(name) });
    await db.exec("CREATE TABLE test (value integer)");
    await db.exec("INSERT INTO test VALUES (1)");
    await db.close();
    const clean = await reopenCollectingStderr();

    const { build, module } = capturingBuild();
    const crashing = await createPgwasm({ build, dataDir: idb(name) });
    await crashing.exec("INSERT INTO test VALUES (2)");
    module().FS.syncfs = (_populate, callback) => queueMicrotask(() => callback(null));
    await crashing.close();
    const crash = await reopenCollectingStderr();

    await deleteStore(name, "report");
    return {
      cleanRecovery: clean.messages.some((message) => recovery.test(message)),
      crashRecovery: crash.messages.some((message) => recovery.test(message)),
      persistedAfterCrash: crash.rows,
    };
  },
};

// ─── pg_dump and the REPL, in memory ──────────────────────────────────────────

const toolsHarness = {
  /**
   * pg_dump on a database created from the prepopulated data directory, and its script run into
   * another such database.
   */
  async pgDumpRoundTrip(): Promise<{
    readonly name: string;
    readonly type: string;
    readonly insert: boolean;
    readonly restored: unknown[];
  }> {
    const seeded = await createPgwasm({ build: cBuild, loadDataDir: await prepopulatedDataDir() });
    try {
      await seeded.exec(
        "CREATE TABLE dumped (id int PRIMARY KEY, note text); INSERT INTO dumped VALUES (1, 'in a browser');",
      );
      const dump = await pgDump({ pg: seeded });
      const script = await dump.text();
      const copy = await createPgwasm({ build: cBuild, loadDataDir: await prepopulatedDataDir() });
      try {
        await copy.exec(script);
        return {
          name: dump.name,
          type: dump.type,
          insert: script.includes("INSERT INTO public.dumped VALUES (1, 'in a browser');"),
          restored: (await copy.query("SELECT * FROM public.dumped")).rows,
        };
      } finally {
        await copy.close();
      }
    } finally {
      await seeded.close();
    }
  },

  /** Mount two REPLs on one database created from the prepopulated data directory. */
  async mountRepl(): Promise<void> {
    const pg = await createPgwasm({ build: cBuild, loadDataDir: await prepopulatedDataDir() });
    const container = document.createElement("div");
    container.id = "repl";
    document.body.append(container);
    const root = createRoot(container);
    root.render([
      createElement("div", { key: "first", id: "first-repl", style: { height: "300px" } }, createElement(Repl, { pg })),
      createElement(
        "div",
        { key: "second", id: "second-repl", style: { height: "300px" } },
        createElement(Repl, { pg }),
      ),
    ]);
    repl = { pg, root, container };
  },

  async unmountRepl(): Promise<void> {
    const mounted = repl;
    repl = undefined;
    mounted?.root.unmount();
    mounted?.container.remove();
    await mounted?.pg.close();
  },
};

export type PgwasmIdbHarness = typeof harness & typeof toolsHarness;

declare global {
  interface Window {
    pgwasmIdb: PgwasmIdbHarness;
  }
}

window.pgwasmIdb = { ...harness, ...toolsHarness };
