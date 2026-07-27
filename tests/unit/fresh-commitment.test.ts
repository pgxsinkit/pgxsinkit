import { describe, expect, it } from "bun:test";
// ADR-0049 (capability-driven engine placement) step 11c: the FRESH/RESTORE COMMITMENT boot WIRING. Every
// browser opfs boot must go through the phase machine: a virgin/restore boot stands
// up an UNCOMMITTED opfs candidate (record BEFORE directory), and the shared commitment barrier
// (strictSync → sentinel → opfs-committed) promotes it BEFORE exposure (invariant 3 — an uncommitted candidate
// is never exposed to writes). This suite proves the two boot-path helpers `createSyncClient` composes:
//   - `resolveFreshBoot` — PRE-MINT: route an opfs-home boot through `resolveStoreBoot`, returning the resolved
//     backend + whether a candidate needs the barrier at the local-init milestone.
//   - `runFreshCommitmentBarrier` — LOCAL-INIT MILESTONE (pre-expose): run the shared barrier over the live
//     engine's `strictSync()`.
// Bun has no browser IndexedDB / OPFS / WASM, so every IO surface is faked (mirroring store-boot.test.ts) and
// no real engine is ever constructed — the barrier's `strictSync()` is an injected recording fn.

import {
  fallbackVirginCandidateToIdb,
  type FreshCommitmentSeams,
  resolveFreshBoot,
  runFreshCommitmentBarrier,
} from "../../packages/client/src/index";
import type { StoreBootResolution } from "../../packages/client/src/store-boot";
import { classifyStoreBoot } from "../../packages/client/src/store-meta";
import {
  opfsCommitmentSentinelPath,
  opfsStoreDirectoryPath,
  storeIdentityComponent,
  storeIndexedDbDatabaseName,
} from "../../packages/client/src/store-path";

// ---------------------------------------------------------------------------------------------------------
// Fake OPFS + meta IndexedDB — the same shape store-boot.test.ts fakes, with a shared ORDER log so the
// barrier's strictSync → sentinel-file → opfs-committed-record sequence can be asserted. `getFileHandle`
// (create) logs `file:<name>` (the sentinel), `getDirectoryHandle` (create) logs `mkdir:<name>`, and a record
// put logs `record:<phase>`.
// ---------------------------------------------------------------------------------------------------------

function notFound(): Error {
  const error = new Error("not found");
  error.name = "NotFoundError";
  return error;
}

class FakeDir {
  dirs = new Map<string, FakeDir>();
  files = new Set<string>();
  log: string[] | undefined;
  constructor(log?: string[]) {
    this.log = log;
  }

  async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<FakeDir> {
    const existing = this.dirs.get(name);
    if (existing != null) return existing;
    if (options?.create) {
      const dir = new FakeDir(this.log);
      this.dirs.set(name, dir);
      this.log?.push(`mkdir:${name}`);
      return dir;
    }
    throw notFound();
  }

  async getFileHandle(name: string, options?: { create?: boolean }): Promise<unknown> {
    if (this.files.has(name)) return { name };
    if (options?.create) {
      this.files.add(name);
      this.log?.push(`file:${name}`);
      return { name };
    }
    throw notFound();
  }

  async removeEntry(name: string): Promise<void> {
    if (this.dirs.delete(name)) return;
    if (this.files.delete(name)) return;
    throw notFound();
  }
}

const META_DB = "pgxsinkit-store-meta";
const META_STORE = "stores";

class FakeObjectStore {
  data = new Map<string, unknown>();
  log: string[] | undefined;
  constructor(log?: string[]) {
    this.log = log;
  }
  private request(op: () => unknown) {
    const req: { result: unknown; error: unknown; onsuccess: (() => void) | null; onerror: (() => void) | null } = {
      result: undefined,
      error: null,
      onsuccess: null,
      onerror: null,
    };
    queueMicrotask(() => {
      req.result = op();
      req.onsuccess?.();
    });
    return req;
  }
  get(key: string) {
    return this.request(() => this.data.get(key));
  }
  put(value: unknown, key: string) {
    return this.request(() => {
      this.data.set(key, value);
      const phase = (value as { phase?: string } | null)?.phase;
      if (phase != null) this.log?.push(`record:${phase}`);
    });
  }
  delete(key: string) {
    return this.request(() => {
      this.data.delete(key);
    });
  }
}

class FakeDatabase {
  stores = new Map<string, FakeObjectStore>();
  objectStoreNames = { contains: (name: string) => this.stores.has(name) };
  log: string[] | undefined;
  constructor(log?: string[]) {
    this.log = log;
  }
  createObjectStore(name: string) {
    const store = new FakeObjectStore(this.log);
    this.stores.set(name, store);
    return store;
  }
  transaction(name: string) {
    const store = this.stores.get(name);
    if (store == null) throw new Error(`no object store ${name}`);
    const transaction = {
      error: null as unknown,
      oncomplete: null as (() => void) | null,
      onabort: null as (() => void) | null,
      onerror: null as (() => void) | null,
      objectStore: () => store,
      abort: () => transaction.onabort?.(),
    };
    queueMicrotask(() => queueMicrotask(() => transaction.oncomplete?.()));
    return transaction;
  }
  close() {}
}

class FakeMetaIdb {
  dbs = new Map<string, FakeDatabase>();
  /** How many times the meta database was OPENED — proves "no meta interaction at all" on short-circuit arms. */
  opens = 0;
  log: string[] | undefined;
  constructor(log?: string[]) {
    this.log = log;
  }

  open(name: string, _version?: number) {
    if (name === META_DB) this.opens += 1;
    const req: {
      result: FakeDatabase | undefined;
      error: unknown;
      transaction: null;
      onupgradeneeded: ((event: unknown) => void) | null;
      onsuccess: (() => void) | null;
      onerror: (() => void) | null;
    } = { result: undefined, error: null, transaction: null, onupgradeneeded: null, onsuccess: null, onerror: null };
    queueMicrotask(() => {
      let db = this.dbs.get(name);
      const isNew = db == null;
      if (db == null) {
        db = new FakeDatabase(this.log);
        this.dbs.set(name, db);
      }
      req.result = db;
      if (isNew) req.onupgradeneeded?.({ target: { result: db } });
      req.onsuccess?.();
    });
    return req;
  }

  deleteDatabase(name: string) {
    const req: { onsuccess: (() => void) | null; onerror: (() => void) | null; onblocked: (() => void) | null } = {
      onsuccess: null,
      onerror: null,
      onblocked: null,
    };
    queueMicrotask(() => {
      this.dbs.delete(name);
      req.onsuccess?.();
    });
    return req;
  }

  hasDb(name: string): boolean {
    return this.dbs.has(name);
  }

  seedMeta(storePath: string, phase: string): void {
    let db = this.dbs.get(META_DB);
    if (db == null) {
      db = new FakeDatabase(this.log);
      this.dbs.set(META_DB, db);
    }
    let store = db.stores.get(META_STORE);
    if (store == null) store = db.createObjectStore(META_STORE);
    store.data.set(storeIdentityComponent(storePath), { phase, updatedAt: 1 });
  }

  seedPgliteDb(storePath: string): void {
    const name = storeIndexedDbDatabaseName(storePath);
    if (!this.dbs.has(name)) this.dbs.set(name, new FakeDatabase(this.log));
  }
}

function browserSeams(root: FakeDir, metaIdb: FakeMetaIdb): FreshCommitmentSeams {
  return {
    meta: { indexedDB: metaIdb, delay: () => Promise.resolve() } as never,
    opfs: { getRoot: async () => root },
    // The FakeMetaIdb does not model the real non-creating open→upgradeneeded→abort→onerror protocol, so the
    // recordless idb existence check reads the fake db map directly (tracks `deleteDatabase`), exactly as
    // store-boot.test.ts does.
    idbExists: async (sp: string) => metaIdb.hasDb(storeIndexedDbDatabaseName(sp)),
  };
}

async function seedStoreDir(root: FakeDir, storePath: string): Promise<void> {
  let handle = root;
  for (const segment of opfsStoreDirectoryPath(storePath))
    handle = await handle.getDirectoryHandle(segment, { create: true });
}

async function seedSentinel(root: FakeDir, storePath: string): Promise<void> {
  const path = opfsCommitmentSentinelPath(storePath);
  let handle = root;
  for (let i = 0; i < path.length - 1; i += 1) handle = await handle.getDirectoryHandle(path[i]!, { create: true });
  await handle.getFileHandle(path[path.length - 1]!, { create: true });
}

async function observe(root: FakeDir, storePath: string) {
  const { createOpfsEffects } = await import("../../packages/client/src/opfs-effects");
  return createOpfsEffects(storePath, { getRoot: async () => root }).observeCommitmentNamespace();
}

function metaPhase(metaIdb: FakeMetaIdb, storePath: string): string | undefined {
  const db = metaIdb.dbs.get(META_DB);
  const record = db?.stores.get(META_STORE)?.data.get(storeIdentityComponent(storePath)) as
    | { phase?: string }
    | undefined;
  return record?.phase;
}

// =========================================================================================================
// A. resolveFreshBoot — the PRE-MINT phase machine + barrier-need decision
// =========================================================================================================

describe("resolveFreshBoot — every opfs boot goes through the phase machine (ADR-0049 step 11c)", () => {
  it("virgin + probe granted → candidate stood up (record BEFORE directory), barrier owed, backend opfs-repacked", async () => {
    const log: string[] = [];
    const metaIdb = new FakeMetaIdb(log);
    const root = new FakeDir(log);
    const fresh = await resolveFreshBoot("virgin-x", true, undefined, browserSeams(root, metaIdb));

    expect(fresh.bootHasOpfs).toBe(true);
    expect(fresh.storageBackend).toBe("opfs-repacked");
    expect(fresh.verdict?.action).toBe("virgin-create");
    expect(fresh.needsCommitmentBarrier).toBe(true);
    // Record-first authority (invariant 12): the opfs-candidate record precedes the store-directory create,
    // and the candidate is UNCOMMITTED (no sentinel yet — the barrier is the milestone's work).
    const identity = storeIdentityComponent("virgin-x");
    expect(log.indexOf("record:opfs-candidate")).toBeGreaterThanOrEqual(0);
    expect(log.indexOf("record:opfs-candidate")).toBeLessThan(log.indexOf(`mkdir:${identity}`));
    expect(metaPhase(metaIdb, "virgin-x")).toBe("opfs-candidate");
    expect(await observe(root, "virgin-x")).toEqual({ sentinelPresent: false, storeDirectoryPresent: true });
  });

  it("committed store → open-committed, NO barrier re-run, opfs backend (zero new record/sentinel writes)", async () => {
    const log: string[] = [];
    const metaIdb = new FakeMetaIdb(log);
    const root = new FakeDir(log);
    metaIdb.seedMeta("committed-x", "opfs-committed");
    await seedStoreDir(root, "committed-x");
    await seedSentinel(root, "committed-x");
    log.length = 0; // drop the seed writes; only post-boot effects matter.

    const fresh = await resolveFreshBoot("committed-x", true, undefined, browserSeams(root, metaIdb));

    expect(fresh.bootHasOpfs).toBe(true);
    expect(fresh.verdict?.action).toBe("open-committed");
    expect(fresh.needsCommitmentBarrier).toBe(false);
    // open-committed touches nothing: no record write, no sentinel create/delete, no directory create.
    expect(
      log.filter((entry) => entry.startsWith("record:") || entry.startsWith("file:") || entry.startsWith("mkdir:")),
    ).toEqual([]);
    expect(metaPhase(metaIdb, "committed-x")).toBe("opfs-committed");
  });

  it("probe DENIED → the phase machine is never run; idb path untouched (guard)", async () => {
    let resolveCalls = 0;
    const seams: FreshCommitmentSeams = {
      resolveStoreBoot: () => {
        resolveCalls += 1;
        return Promise.resolve({ dataDir: "opfs://x", storageBackend: "opfs-repacked" } satisfies StoreBootResolution);
      },
    };
    const fresh = await resolveFreshBoot("denied-x", false, undefined, seams);

    expect(resolveCalls).toBe(0);
    expect(fresh.bootHasOpfs).toBe(false);
    expect(fresh.needsCommitmentBarrier).toBe(false);
    expect(fresh.verdict).toBeUndefined();
  });

  it("existing recordless idb store → downgrades to idb; no barrier (invariant 14)", async () => {
    const metaIdb = new FakeMetaIdb();
    metaIdb.seedPgliteDb("recordless-x");
    const root = new FakeDir();
    const fresh = await resolveFreshBoot("recordless-x", true, undefined, browserSeams(root, metaIdb));

    expect(fresh.verdict?.action).toBe("boot-idb-authoritative");
    expect(fresh.storageBackend).toBe("idbfs");
    // A store's backend is fixed at first mint: an existing idb store opens on idb even under an opfs grant —
    // never a fresh opfs mint over the top of the existing data, and never a migration.
    expect(fresh.bootHasOpfs).toBe(false);
    expect(fresh.needsCommitmentBarrier).toBe(false);
  });
});

// =========================================================================================================
// A2. The no-grant arm's committed-store REFUSAL — a home without sync access cannot open an OPFS-committed
// store, so it fails closed instead of minting an empty idb sibling at the same path (ADR-0050 posture: never
// a silently different storage mode). The remedy is `destroyStoreArtifacts(storePath)` (path-addressed: it
// deletes both backends, the sentinel and the meta record without the grant) or booting from a worker home
// that holds one.
// =========================================================================================================

describe("resolveFreshBoot — a no-grant home REFUSES an opfs-committed store (typed, fail closed)", () => {
  it("committed record + no grant → typed refusal naming the remedy; nothing minted, record untouched", async () => {
    const storePath = "no-grant-committed";
    const log: string[] = [];
    const metaIdb = new FakeMetaIdb(log);
    const root = new FakeDir(log);
    metaIdb.seedMeta(storePath, "opfs-committed");
    await seedStoreDir(root, storePath);
    await seedSentinel(root, storePath);
    log.length = 0; // drop the seed writes; only post-gate effects matter.

    const refusal = await resolveFreshBoot(storePath, false, undefined, browserSeams(root, metaIdb)).then(
      () => null,
      (error: unknown) => error,
    );

    expect(refusal).toBeInstanceOf(Error);
    expect((refusal as Error).name).toBe("CommittedStoreUnreachableError");
    expect((refusal as Error).message).toContain(JSON.stringify(storePath));
    // The message must name BOTH the situation and the two exits, so a consumer is never left guessing — and
    // the destroy exit must be a CALLABLE api (the caller's boot failed; they hold no client to `destroy()`).
    expect((refusal as Error).message).toContain(`destroyStoreArtifacts(${JSON.stringify(storePath)})`);
    // Fail CLOSED: no idb sibling minted at the same path, the record and the sentinel untouched.
    expect(metaIdb.hasDb(storeIndexedDbDatabaseName(storePath))).toBe(false);
    expect(metaPhase(metaIdb, storePath)).toBe("opfs-committed");
    expect(await observe(root, storePath)).toEqual({ sentinelPresent: true, storeDirectoryPresent: true });
    expect(log).toEqual([]);
  });

  it("no grant + record ABSENT or `idb-authoritative` → today's idbfs resolution, untouched", async () => {
    const metaIdb = new FakeMetaIdb();
    const root = new FakeDir();
    metaIdb.seedMeta("no-grant-idb", "idb-authoritative");

    for (const storePath of ["no-grant-recordless", "no-grant-idb"]) {
      const fresh = await resolveFreshBoot(storePath, false, undefined, browserSeams(root, metaIdb));
      expect(fresh.bootHasOpfs).toBe(false);
      expect(fresh.storageBackend).toBe("idbfs");
      expect(fresh.needsCommitmentBarrier).toBe(false);
      expect(fresh.verdict).toBeUndefined();
    }
    expect(metaPhase(metaIdb, "no-grant-idb")).toBe("idb-authoritative");
    expect(metaPhase(metaIdb, "no-grant-recordless")).toBeUndefined();
  });

  it("no grant + `deleting` → the deletion handoff still runs (idb authority published)", async () => {
    const storePath = "no-grant-deleting";
    const metaIdb = new FakeMetaIdb();
    const root = new FakeDir();
    metaIdb.seedMeta(storePath, "deleting");
    metaIdb.seedPgliteDb(storePath);
    await seedStoreDir(root, storePath);
    await seedSentinel(root, storePath);

    const fresh = await resolveFreshBoot(storePath, false, undefined, browserSeams(root, metaIdb));

    expect(fresh.storageBackend).toBe("idbfs");
    // The old cache is explicitly destructible, and the handoff finishes the whole of it: sentinel removed,
    // OPFS store directory removed, idb store dropped, idb authority published.
    expect(metaPhase(metaIdb, storePath)).toBe("idb-authoritative");
    expect(metaIdb.hasDb(storeIndexedDbDatabaseName(storePath))).toBe(false);
    expect(await observe(root, storePath)).toEqual({ sentinelPresent: false, storeDirectoryPresent: false });
  });

  it("no grant + `opfs-candidate` → the candidate is RETIRED before the idb store is minted", async () => {
    // An unexposed candidate has no authority, and this home cannot open OPFS at all. Left standing, the
    // record would claim an opfs candidate while a writable idb store was exposed underneath it.
    const storePath = "no-grant-candidate";
    const metaIdb = new FakeMetaIdb();
    const root = new FakeDir();
    metaIdb.seedMeta(storePath, "opfs-candidate");
    await seedStoreDir(root, storePath);

    const fresh = await resolveFreshBoot(storePath, false, undefined, browserSeams(root, metaIdb));

    expect(fresh.storageBackend).toBe("idbfs");
    expect(fresh.needsCommitmentBarrier).toBe(false);
    expect(metaPhase(metaIdb, storePath)).toBe("idb-authoritative");
    expect(await observe(root, storePath)).toEqual({ sentinelPresent: false, storeDirectoryPresent: false });
  });

  it("no meta store at all (META_STORE_UNAVAILABLE — the Node/Bun lane) → NO refusal", async () => {
    // A scope with no IndexedDB cannot hold a record, so absence is provable and there is no committed OPFS
    // store to be blind to. The filesystem/idb lanes must stay exactly as they are.
    const fresh = await resolveFreshBoot("no-meta-store", false, undefined, {
      meta: { indexedDB: undefined } as never,
      opfs: { getRoot: async () => new FakeDir() },
    });

    expect(fresh.bootHasOpfs).toBe(false);
    expect(fresh.storageBackend).toBe("idbfs");
    expect(fresh.needsCommitmentBarrier).toBe(false);
  });

  it("memory test lane short-circuits BEFORE the gate (no meta read at all)", async () => {
    const metaIdb = new FakeMetaIdb();
    metaIdb.seedMeta("memory-committed", "opfs-committed");
    const fresh = await resolveFreshBoot("memory-committed", false, "memory", browserSeams(new FakeDir(), metaIdb));

    expect(fresh.storageBackend).toBe("memory");
    expect(fresh.bootHasOpfs).toBe(false);
    expect(metaIdb.opens).toBe(0);
  });
});

// =========================================================================================================
// B. runFreshCommitmentBarrier — the LOCAL-INIT MILESTONE barrier (pre-expose)
// =========================================================================================================

describe("runFreshCommitmentBarrier — strict data-before-authority, pre-expose (ADR-0049 step 11c)", () => {
  it("virgin candidate → barrier runs strictSync → sentinel → opfs-committed, all BEFORE exposure", async () => {
    const log: string[] = [];
    const metaIdb = new FakeMetaIdb(log);
    const root = new FakeDir(log);
    const seams = browserSeams(root, metaIdb);

    // Phase 1: stand up the uncommitted candidate (as createSyncClient does pre-mint).
    await resolveFreshBoot("commit-x", true, undefined, seams);
    // [mint would happen here — no WASM in Bun].
    // Phase 2: at the local-init milestone, run the barrier over a recording strictSync.
    await runFreshCommitmentBarrier("commit-x", () => Promise.resolve(void log.push("strictSync")), seams);
    // The caller exposes the store ONLY after the barrier resolves.
    log.push("expose");

    const identity = storeIdentityComponent("commit-x");
    const iStrict = log.indexOf("strictSync");
    const iSentinel = log.indexOf(`file:${identity}`);
    const iCommitted = log.indexOf("record:opfs-committed");
    const iExpose = log.indexOf("expose");
    // Order is load-bearing: durable sync returns, THEN the sentinel, THEN the committed phase — then expose.
    expect(iStrict).toBeGreaterThanOrEqual(0);
    expect(iStrict).toBeLessThan(iSentinel);
    expect(iSentinel).toBeLessThan(iCommitted);
    expect(iCommitted).toBeLessThan(iExpose);
    // The store is now committed: sentinel present + record opfs-committed.
    expect(await observe(root, "commit-x")).toEqual({ sentinelPresent: true, storeDirectoryPresent: true });
    expect(metaPhase(metaIdb, "commit-x")).toBe("opfs-committed");
  });

  it("barrier failure (strictSync throws) → boot rejects; nothing published; next boot tears down + rebuilds", async () => {
    const metaIdb = new FakeMetaIdb();
    const root = new FakeDir();
    const seams = browserSeams(root, metaIdb);

    await resolveFreshBoot("fail-x", true, undefined, seams);
    let rejected: unknown;
    await runFreshCommitmentBarrier("fail-x", () => Promise.reject(new Error("strict-sync-failure")), seams).catch(
      (error: unknown) => {
        rejected = error;
      },
    );

    expect(rejected).toBeInstanceOf(Error);
    expect((rejected as Error).message).toContain("strict-sync-failure");
    // Nothing published: the sentinel was never created and the record is STILL opfs-candidate.
    const observation = await observe(root, "fail-x");
    expect(observation).toEqual({ sentinelPresent: false, storeDirectoryPresent: true });
    expect(metaPhase(metaIdb, "fail-x")).toBe("opfs-candidate");
    // The next boot's classifier tears the candidate down and rebuilds (an unexposed candidate has no authority).
    const verdict = classifyStoreBoot({
      record: { phase: "opfs-candidate", updatedAt: 1 },
      opfs: observation,
      idbStoreExists: false,
    });
    expect(verdict.action).toBe("delete-candidate-and-rebuild");
  });
});

// =========================================================================================================
// D. fallbackVirginCandidateToIdb — the VIRGIN-UNCREATABLE session idbfs fallback (ADR-0049 D6; plan step 13
//    gap). When the opfs mint CANNOT OPEN a virgin/candidate store after openWithBoundedRetries exhausts, tear
//    the never-committed candidate down and re-mint on idbfs FOR THIS SESSION. Applies ONLY to the
//    positive-absence virgin/candidate path (needsCommitmentBarrier true, phase opfs-candidate, NO sentinel ever
//    published); a COMMITTED store (record committed OR sentinel present) owes NO barrier, so createSyncClient's
//    `commitmentBarrierPending` gate never enters the fallback and the open failure stays HARD (guards below).
// =========================================================================================================

/** A representative opfs open failure (a `createSyncAccessHandle` denial), carrying a `Name: message` pair. */
function openFailure(): Error {
  const error = new Error("createSyncAccessHandle denied");
  error.name = "NotAllowedError";
  return error;
}

describe("fallbackVirginCandidateToIdb — virgin/candidate opfs open failure → session idbfs (ADR-0049 D6)", () => {
  it("tears the uncommitted candidate down (record→idb-authoritative, directory deleted) and returns the verbatim open failure", async () => {
    const metaIdb = new FakeMetaIdb();
    const root = new FakeDir();
    const seams = browserSeams(root, metaIdb);

    // Phase 1: stand up the uncommitted candidate exactly as createSyncClient does pre-mint.
    const fresh = await resolveFreshBoot("uncreatable-x", true, undefined, seams);
    expect(fresh.needsCommitmentBarrier).toBe(true);
    expect(metaPhase(metaIdb, "uncreatable-x")).toBe("opfs-candidate");
    expect(await observe(root, "uncreatable-x")).toEqual({ sentinelPresent: false, storeDirectoryPresent: true });

    // The mint's openWithBoundedRetries exhausted its attempts — fall back FOR THIS SESSION.
    const reason = await fallbackVirginCandidateToIdb("uncreatable-x", openFailure(), seams);

    // storageFallbackReason carries the VERBATIM open failure (Name: message) — the step-13 seam's value.
    expect(reason).toContain("NotAllowedError: createSyncAccessHandle denied");
    // The candidate directory is gone and the record is now the session's idb authority (NOT deleted — an idb
    // fallback store is a RECORDED idb store, classification 6's caution / invariant 14).
    expect(await observe(root, "uncreatable-x")).toEqual({ sentinelPresent: false, storeDirectoryPresent: false });
    expect(metaPhase(metaIdb, "uncreatable-x")).toBe("idb-authoritative");
  });

  it("STICKINESS: the idb-authoritative record makes the NEXT boot an idb boot (classification 4), never a re-virgin", async () => {
    const metaIdb = new FakeMetaIdb();
    const root = new FakeDir();
    const seams = browserSeams(root, metaIdb);
    await resolveFreshBoot("sticky-x", true, undefined, seams);
    await fallbackVirginCandidateToIdb("sticky-x", openFailure(), seams);

    // The next boot re-probes with an opfs grant, but the RECORDED idb-authoritative store is opened in place
    // (classification 4 → boot-idb-authoritative) — it does NOT loop through virgin re-creation each boot, and
    // it never re-probes destructively: the backend is fixed at first mint, and the only route to another one
    // is a deliberate destroy + a fresh boot.
    const next = await resolveFreshBoot("sticky-x", true, undefined, seams);
    expect(next.verdict?.action).toBe("boot-idb-authoritative");
    expect(next.bootHasOpfs).toBe(false);
    expect(next.needsCommitmentBarrier).toBe(false);
  });

  it("SYMMETRY: the teardown delete-if-presents the sentinel even though a candidate never has one (no throw)", async () => {
    const metaIdb = new FakeMetaIdb();
    const root = new FakeDir();
    const seams = browserSeams(root, metaIdb);
    await resolveFreshBoot("sym-x", true, undefined, seams);
    // No sentinel exists (a candidate is torn down PRE-barrier); the delete-if-present must be a silent no-op.
    const reason = await fallbackVirginCandidateToIdb("sym-x", openFailure(), seams);
    expect(reason).toContain("NotAllowedError");
    expect(await observe(root, "sym-x")).toEqual({ sentinelPresent: false, storeDirectoryPresent: false });
  });
});

describe("virgin-uncreatable fallback — the HARD committed paths never fall back (ADR-0049 D6 guards)", () => {
  it("record committed → open-committed owes NO barrier: the gate never enters the fallback (open failure stays HARD)", async () => {
    const metaIdb = new FakeMetaIdb();
    const root = new FakeDir();
    metaIdb.seedMeta("hard-committed-x", "opfs-committed");
    await seedStoreDir(root, "hard-committed-x");
    await seedSentinel(root, "hard-committed-x");
    const fresh = await resolveFreshBoot("hard-committed-x", true, undefined, browserSeams(root, metaIdb));

    expect(fresh.verdict?.action).toBe("open-committed");
    // needsCommitmentBarrier false ⇒ createSyncClient's `if (commitmentBarrierPending)` is false ⇒ an opfs open
    // failure PROPAGATES hard, never the session idbfs fallback (CONTEXT § Commitment marker: "once committed,
    // any opfs boot failure is a hard failure").
    expect(fresh.needsCommitmentBarrier).toBe(false);
  });

  it("sentinel present, NO record → repair-record-then-open-committed owes NO barrier: the HARD path, never the fallback", async () => {
    const metaIdb = new FakeMetaIdb();
    const root = new FakeDir();
    await seedStoreDir(root, "hard-sentinel-x");
    await seedSentinel(root, "hard-sentinel-x");
    const fresh = await resolveFreshBoot("hard-sentinel-x", true, undefined, browserSeams(root, metaIdb));

    // A present sentinel reads as committed (sentinel authority, record absent) — likewise no barrier, so the
    // gate excludes it and its open failure is HARD.
    expect(fresh.verdict?.action).toBe("repair-record-then-open-committed");
    expect(fresh.needsCommitmentBarrier).toBe(false);
  });
});
