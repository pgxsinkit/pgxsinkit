// Store meta record — the first-use authority for browser-side engine placement (ADR-0049 decision 6,
// invariants 12 & 14; CONTEXT.md § "Language — engine placement", entries "Store meta record" and
// "Commitment marker"). Written at store CREATION for every backend and completed before the backend is
// exposed, the meta record is a TOTAL phase machine — one of
// `idb-authoritative | opfs-candidate | adopting | opfs-committed | deleting` — with `deleting` taking
// precedence over EVERYTHING (a committed store mid-destruction resumes deletion, never the committed
// verdict) and `adopting` over ordinary idb boot. It lives in a small dedicated IndexedDB database so it is
// readable in every engine home (SharedWorker-direct or elected worker).
//
// This module SEPARATES the pure boot decision (part A — `classifyStoreBoot`, total and unit-testable) from
// the IndexedDB IO (part B — the record's own database) and the recordless-idb detection (part C — a non-creating
// idb existence check). It deliberately carries NO DOM lib dependency: like `store-path.ts`, it reads the
// IndexedDB surface STRUCTURALLY off `globalThis` and accepts an injectable deps object so Bun unit tests
// (no browser IDB) can fake the whole surface. The store identity encoding and PGlite's idb database naming
// are consumed from `store-path.ts` — this module never re-derives either.

import { storeIdentityComponent, storeIndexedDbDatabaseName } from "./store-path";

// =========================================================================================================
// A. Types + pure boot classifier
// =========================================================================================================

/**
 * The one total phase of the store meta record (invariant 12). `deleting` has precedence over everything;
 * `adopting` over ordinary idb boot. There is deliberately NO boolean cross-product (`committed` +
 * `deletionIntent`) — that left precedence ambiguous; the phase is total (CONTEXT § "Store meta record").
 */
export type StoreMetaPhase = "idb-authoritative" | "opfs-candidate" | "adopting" | "opfs-committed" | "deleting";

/** One store's meta record: its total {@link StoreMetaPhase} plus a last-write timestamp. */
export interface StoreMetaRecord {
  phase: StoreMetaPhase;
  updatedAt: number;
}

/**
 * The boot observations the classifier decides on — a PLAIN object so {@link classifyStoreBoot} is total and
 * unit-testable without any IO. Callers assemble it from {@link readStoreMetaRecord}, an OPFS commitment
 * namespace observation, and {@link idbStoreExists}.
 */
export interface StoreBootObservations {
  /**
   * The meta record, `undefined` when absent. Callers MUST have already applied the failed-read policy: an
   * UNREADABLE record never reaches the classifier as `undefined` (invariant 12) — it is a fail-closed error
   * ({@link StoreMetaUnreadableError}) the caller handles before classifying. Only a proven absence is
   * `undefined` here.
   */
  record: StoreMetaRecord | undefined;
  /**
   * The OPFS commitment-namespace observation: `"unobservable"` when the OPFS root threw or the API is absent
   * (present absence is NOT historical proof), otherwise what was actually seen — whether the commitment
   * sentinel and/or the store directory are present.
   */
  opfs: { sentinelPresent: boolean; storeDirectoryPresent: boolean } | "unobservable";
  /** The non-creating idb existence check result (invariant 14 — an existing idb store's data is never overwritten; {@link idbStoreExists}). */
  idbStoreExists: boolean;
}

/**
 * The exhaustive set of boot verdicts. One discriminated union so every branch of {@link classifyStoreBoot}
 * is named and reachable; downstream wiring (plan step 10) switches on `action`.
 */
export type StoreBootVerdict =
  // phase `deleting` — highest precedence; resume the destructive lifecycle.
  | { action: "resume-deletion" }
  // phase `adopting` — the adoption crash-recovery table (plan) owns the next steps.
  | { action: "adoption-recovery" }
  // phase `opfs-committed`, or the sentinel repair path — open the committed store (hard-open handles failure).
  | { action: "open-committed" }
  // no/older record but a commitment sentinel is present — repair the record, then open committed.
  | { action: "repair-record-then-open-committed" }
  // phase `opfs-candidate`, or a recordless candidate directory — an unexposed candidate has no authority.
  | { action: "delete-candidate-and-rebuild" }
  // phase `idb-authoritative`, or an existing recordless idb store detected — boot idb (the caller writes the record).
  | { action: "boot-idb-authoritative" }
  // nothing anywhere — create per placement, record first.
  | { action: "virgin-create" };

/**
 * The PURE boot classifier — plan boot classification 1–7 EXACTLY (invariant 12). Total over every phase and
 * every observation combination; no IO. Precedence, in order:
 *
 * 1. `deleting` → `resume-deletion` (precedence over EVERYTHING, including a committed-looking OPFS).
 * 2. `adopting` → `adoption-recovery` (precedence over ordinary idb boot).
 * 3. `opfs-committed` → `open-committed` (opfs observations are IRRELEVANT here — the hard-open path handles
 *    any failure, including an unreachable root; a committed store never re-derives its verdict from OPFS).
 * 4. `opfs-candidate` → `delete-candidate-and-rebuild` (an unexposed candidate has no authority).
 * 5. `idb-authoritative` → `boot-idb-authoritative`.
 * 6. record `undefined`, OPFS observable: `sentinelPresent` → `repair-record-then-open-committed` (sentinel
 *    authority — a sentinel-without-record is a real crash state that reads as committed); else a candidate
 *    directory without a sentinel → `delete-candidate-and-rebuild`; neither → fall through to 7.
 * 7. record `undefined` and (OPFS unobservable OR nothing present): the RECORDLESS-IDB CHECK —
 *    `idbStoreExists` → `boot-idb-authoritative` (an existing recordless idb store — NEVER virgin; this arm
 *    is the entry point of the forward idbfs→opfs transition); else `virgin-create`.
 *
 * NOTE (the caller's nuance, not the classifier's): when OPFS is unobservable and the verdict is
 * `virgin-create`, the caller creates an IDB store (a main thread / no-handle scope cannot hold sync-access
 * handles). The double-loss residual — the meta record independently wiped AND OPFS simultaneously
 * unobservable over a committed store — is accepted-risk register item 1: it is outside the browser
 * termination model, and a later sentinel/record conflict surfaces as a hard error, never silently resolved.
 */
export function classifyStoreBoot(obs: StoreBootObservations): StoreBootVerdict {
  const { record, opfs, idbStoreExists } = obs;

  if (record != null) {
    switch (record.phase) {
      case "deleting":
        return { action: "resume-deletion" };
      case "adopting":
        return { action: "adoption-recovery" };
      case "opfs-committed":
        return { action: "open-committed" };
      case "opfs-candidate":
        return { action: "delete-candidate-and-rebuild" };
      case "idb-authoritative":
        return { action: "boot-idb-authoritative" };
      default: {
        // Exhaustiveness guard: a new phase MUST be classified explicitly, never silently fall through.
        const unreachable: never = record.phase;
        throw new Error(`[pgxsinkit] unclassified store meta phase: ${String(unreachable)}`);
      }
    }
  }

  // No record. Classification 6: OPFS observable → decide from the commitment namespace.
  if (opfs !== "unobservable") {
    if (opfs.sentinelPresent) return { action: "repair-record-then-open-committed" };
    if (opfs.storeDirectoryPresent) return { action: "delete-candidate-and-rebuild" };
    // Nothing present in OPFS → fall through to the recordless-idb check.
  }

  // Classification 7 (also when OPFS is NOT observable): the recordless-idb check.
  return idbStoreExists ? { action: "boot-idb-authoritative" } : { action: "virgin-create" };
}

// =========================================================================================================
// B. Meta record IO (small dedicated IndexedDB database)
// =========================================================================================================

/** The dedicated IndexedDB database holding every store's meta record — SEPARATE from PGlite's own idb stores. */
export const STORE_META_DATABASE = "pgxsinkit-store-meta";

/** The single object store inside {@link STORE_META_DATABASE}; keyed by {@link storeIdentityComponent}. */
const META_OBJECT_STORE = "stores";

/** The bounded read-retry budget before a failed read fails closed (invariant 12). */
export const META_READ_ATTEMPTS = 3;

/** The delay between failed read attempts (ms); injectable in tests via {@link StoreMetaDeps.delay}. */
const META_READ_RETRY_DELAY_MS = 25;

/**
 * A failed meta read is an ERROR, never "no record" (invariant 12). After {@link META_READ_ATTEMPTS} bounded
 * retries a read that could not be completed fails closed with this distinct type; a stored value of the
 * wrong shape / an unknown phase raises it too (corruption is not absence). A distinct type — not a bare
 * `Error` — so the boot caller can `instanceof`-branch fail-closed from a proven absence.
 */
export class StoreMetaUnreadableError extends Error {
  constructor(storePath: string, cause?: unknown) {
    super(
      `[pgxsinkit] the store meta record for ${JSON.stringify(storePath)} could not be read after ` +
        `${META_READ_ATTEMPTS} attempts (or was malformed). A failed meta read is an ERROR, never "no ` +
        'record" — booting fails closed rather than treating an unreadable/corrupt record as absence (ADR-0049 ' +
        "invariant 12).",
      cause == null ? undefined : { cause },
    );
    this.name = "StoreMetaUnreadableError";
  }
}

/**
 * Returned by {@link readStoreMetaRecord} when the `indexedDB` API is ENTIRELY ABSENT — distinct from both a
 * proven absence (`undefined`) and an unreadable record (an error). A no-IDB environment cannot hold a
 * record at all, so absence IS provable there; the caller (plan step 10) maps this into the
 * "OPFS unobservable"-style path. It is emphatically NOT the same as a THROWING IDB, whose outcome is
 * ambiguous → {@link StoreMetaUnreadableError}.
 */
export const META_STORE_UNAVAILABLE: unique symbol = Symbol("pgxsinkit.storeMeta.unavailable");

/** The injectable IO seam so Bun unit tests fake IndexedDB (there is no browser IDB there). */
export interface StoreMetaDeps {
  /** The IndexedDB surface; defaults to `globalThis.indexedDB`. Explicit `undefined` selects the no-IDB path. */
  indexedDB?: IndexedDbLike | undefined;
  /** The between-retries delay; defaults to a real timer. Injected in tests to prove the retry count. */
  delay?: (ms: number) => Promise<void>;
}

// --- Structural IndexedDB typing (no DOM lib), mirroring store-path.ts's globalThis-structural stance. ----

interface IdbRequestLike {
  result: unknown;
  error: unknown;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
}

interface IdbObjectStoreLike {
  get(key: string): IdbRequestLike;
  put(value: unknown, key: string): IdbRequestLike;
  delete(key: string): IdbRequestLike;
}

interface IdbTransactionLike {
  objectStore(name: string): IdbObjectStoreLike;
  abort(): void;
  commit?(): void;
  error?: unknown;
  oncomplete: (() => void) | null;
  onabort: (() => void) | null;
  onerror: (() => void) | null;
}

interface IdbDatabaseLike {
  transaction(
    store: string,
    mode: "readonly" | "readwrite",
    options?: { durability?: "default" | "relaxed" | "strict" },
  ): IdbTransactionLike;
  objectStoreNames: { contains(name: string): boolean };
  createObjectStore(name: string): IdbObjectStoreLike;
  close(): void;
}

interface IdbVersionChangeEventLike {
  target: { transaction?: IdbTransactionLike | null } | null;
}

interface IdbOpenDbRequestLike {
  result: IdbDatabaseLike;
  error: unknown;
  transaction: IdbTransactionLike | null;
  onupgradeneeded: ((event: IdbVersionChangeEventLike) => void) | null;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
}

interface IndexedDbLike {
  open(name: string, version?: number): IdbOpenDbRequestLike;
}

/** Resolve the IndexedDB surface: injected deps first, else structural off `globalThis`. */
function resolveIndexedDb(deps?: StoreMetaDeps): IndexedDbLike | undefined {
  if (deps != null && "indexedDB" in deps) return deps.indexedDB;
  return (globalThis as { indexedDB?: IndexedDbLike }).indexedDB;
}

function defaultDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const VALID_PHASES: ReadonlySet<string> = new Set<StoreMetaPhase>([
  "idb-authoritative",
  "opfs-candidate",
  "adopting",
  "opfs-committed",
  "deleting",
]);

function isStoreMetaRecord(value: unknown): value is StoreMetaRecord {
  if (value == null || typeof value !== "object") return false;
  const record = value as { phase?: unknown; updatedAt?: unknown };
  return typeof record.updatedAt === "number" && typeof record.phase === "string" && VALID_PHASES.has(record.phase);
}

/** Open (or create) the dedicated meta database, ensuring the single object store exists. */
function openMetaDatabase(indexedDB: IndexedDbLike): Promise<IdbDatabaseLike> {
  return new Promise((resolve, reject) => {
    let request: IdbOpenDbRequestLike;
    try {
      request = indexedDB.open(STORE_META_DATABASE, 1);
    } catch (error) {
      reject(error);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(META_OBJECT_STORE)) db.createObjectStore(META_OBJECT_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("indexedDB open failed"));
  });
}

/** Promise-wrap a get/put/delete request. */
function awaitRequest(request: IdbRequestLike): Promise<unknown> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("indexedDB request failed"));
  });
}

/** A write is durable authority only once its transaction completes; request success alone is not commit. */
function awaitTransaction(transaction: IdbTransactionLike): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("indexedDB transaction aborted"));
    transaction.onerror = () => reject(transaction.error ?? new Error("indexedDB transaction failed"));
  });
}

/** Queue one authority mutation and observe BOTH its request and transaction settlement on every error path. */
async function awaitAuthorityMutation(transaction: IdbTransactionLike, request: IdbRequestLike): Promise<void> {
  const requestSettlement = awaitRequest(request);
  const transactionSettlement = awaitTransaction(transaction);
  let commitError: unknown;
  try {
    transaction.commit?.();
  } catch (error) {
    commitError = error;
  }
  const [requestResult, transactionResult] = await Promise.allSettled([requestSettlement, transactionSettlement]);
  if (commitError !== undefined) throw commitError;
  if (requestResult.status === "rejected") throw requestResult.reason;
  if (transactionResult.status === "rejected") throw transactionResult.reason;
}

/**
 * One read attempt. Resolves the stored value (`unknown`) — validation happens in {@link readStoreMetaRecord}
 * so a malformed value can be treated as non-retryable corruption while an IO failure retries.
 */
async function readAttempt(indexedDB: IndexedDbLike, key: string): Promise<unknown> {
  const db = await openMetaDatabase(indexedDB);
  try {
    const store = db.transaction(META_OBJECT_STORE, "readonly").objectStore(META_OBJECT_STORE);
    return await awaitRequest(store.get(key));
  } finally {
    db.close();
  }
}

/**
 * Read a store's meta record, applying the FAILED-READ POLICY (invariant 12):
 * - `indexedDB` entirely absent → {@link META_STORE_UNAVAILABLE} (a no-IDB environment cannot hold a record,
 *   so absence is provable; the caller maps this into the "OPFS unobservable"-style path).
 * - A successful read that finds nothing → `undefined` (a proven absence).
 * - An open/get that fails is retried up to {@link META_READ_ATTEMPTS} times (an injectable delay between);
 *   if every attempt fails, throws {@link StoreMetaUnreadableError} (fail closed, NEVER "no record").
 * - A stored value of the wrong shape / unknown phase → {@link StoreMetaUnreadableError} immediately
 *   (deterministic corruption; retrying cannot help, and it must not classify as absent).
 */
export async function readStoreMetaRecord(
  storePath: string,
  deps?: StoreMetaDeps,
): Promise<StoreMetaRecord | undefined | typeof META_STORE_UNAVAILABLE> {
  const indexedDB = resolveIndexedDb(deps);
  if (indexedDB == null) return META_STORE_UNAVAILABLE;
  const key = storeIdentityComponent(storePath);
  const delay = deps?.delay ?? defaultDelay;

  let lastError: unknown;
  for (let attempt = 1; attempt <= META_READ_ATTEMPTS; attempt += 1) {
    try {
      const value = await readAttempt(indexedDB, key);
      if (value === undefined) return undefined;
      if (isStoreMetaRecord(value)) return value;
      // A present-but-malformed value is deterministic corruption — fail closed now, do not retry.
      throw new StoreMetaUnreadableError(storePath, new Error("stored meta record has an invalid shape"));
    } catch (error) {
      if (error instanceof StoreMetaUnreadableError) throw error;
      lastError = error;
      if (attempt < META_READ_ATTEMPTS) await delay(META_READ_RETRY_DELAY_MS);
    }
  }
  throw new StoreMetaUnreadableError(storePath, lastError);
}

/**
 * Write (create or overwrite) a store's meta record — done at CREATION for every backend, before exposure,
 * and at each phase transition (invariant 12). A no-IDB environment cannot hold a record, so this is a
 * best-effort no-op there (consistent with {@link readStoreMetaRecord} returning {@link META_STORE_UNAVAILABLE}).
 */
export async function writeStoreMetaRecord(
  storePath: string,
  record: StoreMetaRecord,
  deps?: StoreMetaDeps,
): Promise<void> {
  const indexedDB = resolveIndexedDb(deps);
  if (indexedDB == null) return;
  const key = storeIdentityComponent(storePath);
  const db = await openMetaDatabase(indexedDB);
  try {
    const transaction = db.transaction(META_OBJECT_STORE, "readwrite", { durability: "strict" });
    const store = transaction.objectStore(META_OBJECT_STORE);
    await awaitAuthorityMutation(transaction, store.put(record, key));
  } finally {
    db.close();
  }
}

/** Delete a store's meta record — the terminal step of the destructive lifecycle (invariant 12/13). */
export async function deleteStoreMetaRecord(storePath: string, deps?: StoreMetaDeps): Promise<void> {
  const indexedDB = resolveIndexedDb(deps);
  if (indexedDB == null) return;
  const key = storeIdentityComponent(storePath);
  const db = await openMetaDatabase(indexedDB);
  try {
    const transaction = db.transaction(META_OBJECT_STORE, "readwrite", { durability: "strict" });
    const store = transaction.objectStore(META_OBJECT_STORE);
    await awaitAuthorityMutation(transaction, store.delete(key));
  } finally {
    db.close();
  }
}

// =========================================================================================================
// C. Non-creating idb existence check (invariant 14 — an existing idb store's data is never overwritten)
// =========================================================================================================

/**
 * Does PGlite's idb database for this store ALREADY exist, WITHOUT creating it? The recordless-idb recognition
 * check (invariant 14): no meta record + an existing idb store → `idb-authoritative`, never virgin. This is
 * the entry point of the forward idbfs→opfs transition — an existing idb store's data is never overwritten by
 * a fresh opfs mint; it is opened in place (fixed/denied home) or migrated forward via adoption.
 *
 * Technique (per ADR-0049 D6 — NEVER `indexedDB.databases()`, which is absent on some engines): open the
 * database with NO version. If `onupgradeneeded` fires, the database did NOT exist — flag it and ABORT the
 * versionchange transaction (`event.target.transaction.abort()`) so the freshly-created empty database does
 * not persist, then resolve `false`. On `onsuccess` WITHOUT an upgrade the database already existed — close
 * the handle and resolve `true`. The `onerror` that follows an abort is the EXPECTED completion of the
 * non-exist path (the AbortError), not a failure — it resolves `false`. `indexedDB` absent → `false`
 * (no idb store can exist). The database name comes from `store-path.ts`'s {@link storeIndexedDbDatabaseName}
 * (the sole owner of PGlite's `/pglite/` naming) — never re-derived here.
 */
export function idbStoreExists(storePath: string, deps?: StoreMetaDeps): Promise<boolean> {
  const indexedDB = resolveIndexedDb(deps);
  if (indexedDB == null) return Promise.resolve(false);
  const name = storeIndexedDbDatabaseName(storePath);

  return new Promise((resolve, reject) => {
    let existed = true;
    let request: IdbOpenDbRequestLike;
    try {
      // No version → never triggers an upgrade on an existing database; a MISSING one upgrades from nothing.
      request = indexedDB.open(name);
    } catch (error) {
      reject(error);
      return;
    }
    request.onupgradeneeded = (event) => {
      // The database did not exist. Abort the versionchange transaction so nothing is persisted.
      existed = false;
      const transaction = event?.target?.transaction ?? request.transaction;
      transaction?.abort();
    };
    request.onsuccess = () => {
      request.result.close();
      resolve(true);
    };
    request.onerror = () => {
      // After an abort, `onerror` is the expected completion of the non-exist path — resolve `false`, do not
      // misreport it as a failure. A genuine open failure (upgrade never fired) is a real error.
      if (!existed) {
        resolve(false);
        return;
      }
      reject(request.error ?? new Error("indexedDB open failed"));
    };
  });
}
