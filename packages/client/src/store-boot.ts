// Store boot resolution — assemble the boot observations and EXECUTE the classifier's verdict with real
// effects (ADR-0049 capability-driven engine placement, plan step 10a). `store-meta.ts` owns the PURE
// classifier ({@link classifyStoreBoot}, boot classification 1–6) and the meta-record IO; `store-lifecycle.ts`
// owns the PURE, effect-injected destruction/fresh-candidate machines; `opfs-effects.ts` owns the concrete
// OPFS side. This module is the WIRING that reads the meta record, observes the commitment namespace and the
// recordless idb fact, classifies, and then runs the destructive/candidate effects BEFORE returning the
// resolved `dataDir` + `storageBackend` a caller opens the store at.
//
// It also owns the OTHER browser boot arm: {@link resolveDeniedBootAuthority}, the one bounded meta read a
// probe-DENIED (no OPFS sync access) boot performs before it may mint an IDB store. That arm never runs the
// phase machine — it is record-blind by design — but it still owes the record three things: finish an
// authorized `deleting` handoff, RETIRE an unexposed `opfs-candidate` (nothing may be exposed beneath a record
// that still claims one), and REFUSE an `opfs-committed` store outright
// ({@link CommittedStoreUnreachableError}), because a home without handles cannot open it and would
// otherwise mint an empty idb sibling at the same path.
//
// It never assembles a storage URL itself — every `dataDir` comes from `store-path.ts`'s
// {@link resolveStoreDataDir}, which stays the toolkit's only URL assembler. It carries no DOM lib dependency
// and takes injectable deps (meta IO, OPFS root, the recordless idb existence check) so Bun unit tests fake the
// whole surface with no real IndexedDB / OPFS / WASM.
//
// THE COMMITMENT BARRIER IS NOT HERE. When the verdict stands up a fresh opfs CANDIDATE (`virgin-create` with
// opfs access), this function returns with the candidate's record at `opfs-candidate` and its directory created
// but UNCOMMITTED. The strict-sync → sentinel → `opfs-committed` barrier that promotes it (invariant 3 — an
// uncommitted candidate is never exposed to writes) is the mint seam's post-open work, wired in plan step
// 10b/11. The returned {@link StoreBootResolution.verdict} tells the caller a candidate is uncommitted and
// needs that barrier.

import { createOpfsEffects, type OpfsEffectsDeps } from "./opfs-effects";
import { beginFreshCandidate, resumeDeletion } from "./store-lifecycle";
import {
  classifyStoreBoot,
  deleteStoreMetaRecord,
  idbStoreExists as defaultIdbStoreExists,
  META_STORE_UNAVAILABLE,
  readStoreMetaRecord,
  type StoreBootVerdict,
  type StoreMetaDeps,
  type StoreMetaPhase,
  writeStoreMetaRecord,
} from "./store-meta";
import { resolveStoreDataDir, storeIndexedDbDatabaseName } from "./store-path";

/**
 * The resolved storage backend a boot lands on. `opfs-repacked` (the elected/SW-direct opfs engine home),
 * `idbfs` (browser, no sync-access handles), `filesystem` (Bun/Node), or `memory` (the sanctioned
 * test/ephemeral lane). Surfaced on the BootReport as an additive field under the ADR-0034 reportVersion
 * rule (additive fields keep `reportVersion: 1`); ADR-0049 named the backends.
 */
export type ResolvedStorageBackend = "opfs-repacked" | "idbfs" | "filesystem" | "memory";

/** The outcome of {@link resolveStoreBoot}: the URL to open the store at, its backend, and the boot verdict. */
export interface StoreBootResolution {
  /** The PGlite dataDir URL, always assembled by {@link resolveStoreDataDir} (the one URL assembler). */
  dataDir: string;
  /** The resolved backend, for diagnostics. */
  storageBackend: ResolvedStorageBackend;
  /**
   * The executed boot verdict — always a TERMINAL one (the record-clearing verdicts re-classify rather than
   * return). Absent on the passthrough backends (`memory` / `filesystem`), which have NO meta machinery.
   * Present on every browser classification — in particular it is the signal that an opfs CANDIDATE was stood
   * up UNCOMMITTED (`virgin-create`): the mint seam must run the commitment barrier before exposing that store
   * to writes (plan step 10b/11).
   */
  verdict?: StoreBootVerdict;
}

/** Options for {@link resolveStoreBoot}. */
export interface ResolveStoreBootOptions {
  /** The placement probe's result, injected by the caller (invariant 8 — probe per boot, never cached here). */
  hasOpfsSyncAccess: boolean;
  /** The internal test-only memory backend override (ADR-0036), carried through from the mint seam. */
  backendOverride?: "memory";
  /** Injectable IO seams so Bun unit tests fake the whole browser surface. */
  deps?: {
    /** The store-meta IndexedDB seam (defaults to `globalThis.indexedDB` inside store-meta). */
    meta?: StoreMetaDeps;
    /** The OPFS root seam (defaults to `navigator.storage.getDirectory` inside opfs-effects). */
    opfs?: OpfsEffectsDeps;
    /** The recordless idb existence check (defaults to store-meta's non-creating {@link idbStoreExists}). */
    idbExists?: (storePath: string) => Promise<boolean>;
  };
}

/**
 * Bounded re-classification budget. Two verdicts re-run the loop, and both end by DELETING the meta record:
 * `resume-deletion` (the destructive lifecycle — sentinel → backend store → record) and
 * `delete-candidate-and-rebuild` (retiring an unexposed candidate — sentinel → directory → record). Each
 * leaves a RECORDLESS state whose next classification is necessarily terminal (`boot-idb-authoritative` when
 * an idb store exists at the path, otherwise `virgin-create`). One re-run is enough; the small budget is a
 * guard against an unexpected non-terminating cycle.
 */
const MAX_DELETION_RECLASSIFY = 4;

/** The minimal structural shape of the `indexedDB.deleteDatabase` surface (no DOM lib). */
interface IdbDeleteSurface {
  deleteDatabase(name: string): {
    error?: unknown;
    onsuccess: (() => void) | null;
    onerror: (() => void) | null;
    onblocked?: (() => void) | null;
  };
}

/** Resolve the `deleteDatabase` surface: injected meta deps first (tests), else structural off `globalThis`. */
function resolveDeleteSurface(meta?: StoreMetaDeps): IdbDeleteSurface | undefined {
  if (meta != null && "indexedDB" in meta) return meta.indexedDB as unknown as IdbDeleteSurface | undefined;
  return (globalThis as { indexedDB?: IdbDeleteSurface }).indexedDB;
}

/**
 * Delete-if-present the PGlite idb database for a store (`indexedDB.deleteDatabase`), backend-agnostic and
 * idempotent: absent counts as deleted, while a real failure rejects. The database name comes
 * ONLY from {@link storeIndexedDbDatabaseName} (store-path's sole owner of PGlite's `/pglite/` naming).
 */
function deleteIdbDatabase(storePath: string, meta?: StoreMetaDeps): Promise<void> {
  const idb = resolveDeleteSurface(meta);
  if (idb?.deleteDatabase == null) return Promise.resolve();
  const name = storeIndexedDbDatabaseName(storePath);
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) clearTimeout(timeout);
      if (error === undefined) resolve();
      else reject(error);
    };
    let request: {
      error?: unknown;
      onsuccess: (() => void) | null;
      onerror: (() => void) | null;
      onblocked?: (() => void) | null;
    };
    try {
      request = idb.deleteDatabase(name);
    } catch (error) {
      finish(error);
      return;
    }
    request.onsuccess = () => finish();
    request.onerror = () => finish(request.error ?? new Error(`indexedDB deletion failed for ${name}`));
    request.onblocked = () => undefined;
    timeout = setTimeout(() => finish(new Error(`indexedDB deletion timed out while blocked for ${name}`)), 5_000);
  });
}

/** Is IndexedDB present (a browser/worker scope)? Injected meta deps win so tests select the browser branch. */
function resolveHasIndexedDb(meta?: StoreMetaDeps): boolean {
  if (meta != null && "indexedDB" in meta) return meta.indexedDB != null;
  return typeof (globalThis as { indexedDB?: unknown }).indexedDB !== "undefined";
}

/** The `detail` tag {@link CommittedStoreUnreachableError} travels under across the worker bridge. */
export const COMMITTED_STORE_UNREACHABLE_CODE = "committed-store-unreachable";

/**
 * The clone-safe wire form of a {@link CommittedStoreUnreachableError}, carried in the EXISTING bridge error
 * `detail` field (the `{ message, name, detail }` shape `serializeError` produces) — no new protocol field.
 * The attach side calls {@link committedStoreUnreachableFromWire} on every bridge error `detail`, so a refusal
 * raised in an engine home reaches the tab as the CLASS, not a name-tagged plain `Error`.
 */
export interface CommittedStoreUnreachableWire {
  code: typeof COMMITTED_STORE_UNREACHABLE_CODE;
  storePath: string;
}

/**
 * Thrown when a boot whose engine home holds NO OPFS sync-access grant meets a store whose meta record says
 * `opfs-committed` — the user's real store lives in the OPFS backend, which this home cannot open. Left
 * unguarded that boot opens `idb://<storePath>` instead and MINTS AN EMPTY SIBLING at the same path: the app
 * looks wiped, and any offline writes fork into a store no OPFS-capable boot ever opens. So the boot fails
 * CLOSED, matching the ADR-0050 posture (never a silently different storage mode) and the
 * {@link NonPersistentStoreError} / `StorageDeclarationRefusedError` precedents. There is deliberately no
 * override: a committed store is only reachable from a home that can hold handles.
 *
 * A distinct type — not a bare `Error` — so a caller can `instanceof`-branch it from a genuine boot failure,
 * and it survives the worker bridge AS THAT TYPE: the instance carries the clone-safe {@link
 * CommittedStoreUnreachableWire} `detail` the bridge forwards, and the tab side reconstructs it through
 * {@link committedStoreUnreachableFromWire} (the same tagged-detail pair the execution-limit and relocation
 * errors use). `storePath` is on the instance too, because the remedy is path-addressed. The message names
 * BOTH exits, because a consumer meeting this has to choose between them.
 */
export class CommittedStoreUnreachableError extends Error {
  readonly code = COMMITTED_STORE_UNREACHABLE_CODE;
  readonly storePath: string;
  readonly detail: CommittedStoreUnreachableWire;

  constructor(storePath: string) {
    super(
      `[pgxsinkit] refusing to boot ${JSON.stringify(storePath)} here: its store meta record says the store is ` +
        "COMMITTED to the OPFS backend, and this boot's engine home holds no OPFS sync-access grant — so it " +
        "cannot open that store. Booting the IndexedDB store at the same path would mint an EMPTY sibling: the " +
        "app would look wiped and offline writes would fork into a store no OPFS-capable boot ever opens. " +
        "Either boot from an engine home that HOLDS a grant (worker mode's elected engine worker, or the " +
        "SharedWorker-direct home), or destroy the store first — call " +
        `\`destroyStoreArtifacts(${JSON.stringify(storePath)})\` (exported from \`@pgxsinkit/client\`), which is ` +
        "path-addressed and needs no grant: it deletes BOTH backends plus the commitment sentinel and the meta " +
        "record (quiesce any live worker for the path first, `quiesceStoreWorker`) — and let the next boot " +
        "rebuild it (ADR-0049 invariant 3; ADR-0050 never a silently different storage mode).",
    );
    this.name = "CommittedStoreUnreachableError";
    this.storePath = storePath;
    this.detail = { code: COMMITTED_STORE_UNREACHABLE_CODE, storePath };
  }
}

/**
 * Reconstruct a typed {@link CommittedStoreUnreachableError} from a bridge error's `detail`. STRICT shape
 * check: returns `undefined` for anything that is not exactly the `{ code: "committed-store-unreachable",
 * storePath }` wire form (a foreign/absent detail, a wrong code, a missing/non-string path, a non-object), so a
 * different failure is never misclassified as this refusal. The single source of truth for the decoding —
 * every bridge seam calls THIS, never its own shape sniff.
 */
export function committedStoreUnreachableFromWire(detail: unknown): CommittedStoreUnreachableError | undefined {
  if (typeof detail !== "object" || detail === null) return undefined;
  const candidate = detail as { code?: unknown; storePath?: unknown };
  if (candidate.code !== COMMITTED_STORE_UNREACHABLE_CODE) return undefined;
  if (typeof candidate.storePath !== "string") return undefined;
  return new CommittedStoreUnreachableError(candidate.storePath);
}

/**
 * The PRE-MINT meta gate every probe-denied (no OPFS sync access) browser boot passes through — one bounded
 * meta read serving both of the record's claims such a boot must honour, before any replacement IDB store is
 * created:
 *
 * - **`opfs-committed` → REFUSE** ({@link CommittedStoreUnreachableError}). This home cannot open the
 *   committed store, and minting the idb sibling at the same path would publish an empty store over a
 *   populated one. Fail closed; the remedy is a deliberate `destroy()` or a granted engine home.
 * - **`deleting` → complete the handoff.** The old cache is already explicitly destructible; the authority
 *   handoff required is to remove the OPFS commitment sentinel and the store directory, then publish
 *   `idb-authoritative` before the replacement is exposed. The directory goes NOW, with the rest: the
 *   replacement is an idb store for life (the backend is fixed at first mint), so no later OPFS candidate
 *   would ever sweep it. Returns `true`.
 * - **`opfs-candidate` → retire the candidate.** An unexposed candidate has no authority (the classifier's own
 *   rule), and this home cannot open OPFS at all — so it is retired rather than left standing over the idb
 *   store about to be minted: delete the commitment sentinel (a barrier-gap crash can have published one) and
 *   the store directory — async OPFS deletion needs no sync-access grant — then publish `idb-authoritative`.
 *   Returns `true`.
 * - **Everything else** (no record, `idb-authoritative`, or no meta store at all) → proceed untouched. A
 *   no-grant boot is otherwise record-blind by design: the opfs commitment phase machine belongs to the
 *   granted lane, and {@link META_STORE_UNAVAILABLE} (no IndexedDB — the Bun/Node filesystem lane) cannot hold
 *   a record at all, so there is nothing there to be blind to.
 *
 * An UNREADABLE record propagates ({@link StoreMetaUnreadableError}) — a failed meta read is an error, never
 * "no record" (invariant 12).
 */
export async function resolveDeniedBootAuthority(
  storePath: string,
  deps?: ResolveStoreBootOptions["deps"],
): Promise<boolean> {
  const meta = deps?.meta;
  const record = await readStoreMetaRecord(storePath, meta);
  if (record === META_STORE_UNAVAILABLE) return false;
  // The committed refusal rides THIS read — a no-grant boot never gets a second look at the record, and the
  // hazard (an empty idb sibling minted over a committed store) is decided by exactly this phase.
  const phase = record?.phase;
  if (phase === "opfs-committed") throw new CommittedStoreUnreachableError(storePath);
  if (phase !== "deleting" && phase !== "opfs-candidate") return false;

  const effects = createOpfsEffects(storePath, deps?.opfs);
  // Both arms end by publishing idb authority over the commitment namespace, so both need it OBSERVABLE: if it
  // cannot be observed, sentinel deletion cannot be confirmed. Keep the recorded phase authoritative and fail
  // closed rather than publish a conflicting replacement.
  if ((await effects.observeCommitmentNamespace()) === "unobservable") {
    throw new Error(
      `[pgxsinkit] cannot settle ${JSON.stringify(storePath)} for an IDB boot (record phase ` +
        `${JSON.stringify(phase)}): the OPFS commitment namespace is unobservable in this scope, so sentinel ` +
        "removal cannot be confirmed.",
    );
  }
  // The idb database is deleted only on the `deleting` arm — that is the destruction this boot inherited and
  // completes. A candidate's retirement destroys the CANDIDATE, never a store at the path it did not mint.
  if (phase === "deleting") await deleteIdbDatabase(storePath, meta);
  await effects.deleteSentinel();
  await effects.deleteStoreDirectory();
  await writeStoreMetaRecord(storePath, { phase: "idb-authoritative", updatedAt: Date.now() }, meta);
  return true;
}

/**
 * Resolve where a store boots and finish any destructive/candidate work the verdict demands, then return the
 * `dataDir` + `storageBackend` the mint seam opens at. The full plan boot classification 1–6, EXECUTED:
 *
 * - **memory override** → `memory://` passthrough, no classification (the sanctioned test/ephemeral lane has
 *   no meta machinery).
 * - **non-browser** (no idb, no opfs handles) → `file://` passthrough, no classification (the filesystem
 *   backend has no meta machinery either).
 * - **browser** → read the meta record ({@link readStoreMetaRecord}; {@link StoreMetaUnreadableError}
 *   propagates = fail closed, invariant 12), map {@link META_STORE_UNAVAILABLE} to a provable absence
 *   (no idb ⇒ no record and no existing idb store), observe the commitment namespace and the recordless idb fact,
 *   classify, and execute:
 *   - `resume-deletion` → complete the destructive lifecycle, then RE-CLASSIFY from the now-clean state
 *     (bounded by {@link MAX_DELETION_RECLASSIFY}).
 *   - `delete-candidate-and-rebuild` → delete the stale sentinel AND the candidate directory (a barrier-gap
 *     crash's sentinel must never survive) AND the record, then RE-CLASSIFY from the now-recordless state — so
 *     an idb store at this path is opened in place rather than shadowed by the rebuild.
 *   - `repair-record-then-open-committed` → write `opfs-committed`, then open committed.
 *   - `open-committed` → open the committed opfs store (open failures are HARD at mint time; the bounded
 *     retries for transient UnknownError-class failures live in the mint seam's factory-call wrapper). A record
 *     already at `opfs-committed` takes the WARM FAST PATH: it is classified straight off the record, so neither
 *     the commitment-namespace observation nor the recordless-idb probe runs at all (both are irrelevant to
 *     classification 2).
 *   - `boot-idb-authoritative` → write `idb-authoritative` FIRST when there is no record yet (recordless idb), then
 *     `idb://`. TERMINAL: a store's backend is fixed at first mint, so an idb store stays idb whatever this
 *     boot's capabilities are — the only route to another backend is a deliberate destroy + a fresh boot.
 *   - `virgin-create` → with opfs access, {@link beginFreshCandidate} (record `opfs-candidate` BEFORE the
 *     directory) → `opfs://` UNCOMMITTED (barrier is step 10b/11); without opfs access, `idb-authoritative` →
 *     `idb://`.
 */
export async function resolveStoreBoot(storePath: string, opts: ResolveStoreBootOptions): Promise<StoreBootResolution> {
  const meta = opts.deps?.meta;

  // Memory override: the sanctioned test/ephemeral lane. No meta machinery — a memory store lives only for the
  // instance about to be created (documented in store-path's `storeTargetExists`).
  if (opts.backendOverride === "memory") {
    return { dataDir: resolveStoreDataDir(storePath, "memory"), storageBackend: "memory" };
  }

  // Non-browser (no IndexedDB, no opfs handles): the filesystem backend has no meta machinery. Passthrough.
  const hasIndexedDb = resolveHasIndexedDb(meta);
  if (!hasIndexedDb && !opts.hasOpfsSyncAccess) {
    return {
      dataDir: resolveStoreDataDir(storePath, undefined, { hasIndexedDb: false }),
      storageBackend: "filesystem",
    };
  }

  const effects = createOpfsEffects(storePath, opts.deps?.opfs);
  const idbExists = opts.deps?.idbExists ?? ((sp: string) => defaultIdbStoreExists(sp, meta));

  // The two browser dataDir forms — always via store-path (the one URL assembler). A COMMITTED opfs store
  // opens on opfs regardless of THIS boot's probe result (the committed store is opfs by construction); an
  // open failure in a scope without handles is a hard mint-time failure, not a re-derivation.
  const opfsDataDir = resolveStoreDataDir(storePath, undefined, { hasIndexedDb: true, hasOpfsSyncAccess: true });
  const idbDataDir = resolveStoreDataDir(storePath, undefined, { hasIndexedDb: true, hasOpfsSyncAccess: false });

  const writePhase = (phase: StoreMetaPhase): Promise<void> =>
    writeStoreMetaRecord(storePath, { phase, updatedAt: Date.now() }, meta);

  // The virgin creation path — the one place this module mints a store (a retired candidate's rebuild reaches
  // it through re-classification, like any other virgin state).
  const finishVirginCreate = async (verdict: StoreBootVerdict): Promise<StoreBootResolution> => {
    if (opts.hasOpfsSyncAccess) {
      // Record-first authority (invariant 12): the `opfs-candidate` record is written BEFORE the directory, so
      // a crash between them leaves a candidate a later boot deletes and rebuilds. Returned UNCOMMITTED — the
      // commitment barrier is the mint seam's post-open work (plan step 10b/11).
      await beginFreshCandidate({
        writeCandidateRecord: () => writePhase("opfs-candidate"),
        createStoreDirectory: async () => {
          await effects.getStoreDirectoryHandle();
        },
      });
      return { dataDir: opfsDataDir, storageBackend: "opfs-repacked", verdict };
    }
    // No opfs handles in this scope: create an idb store instead (classification 7). Record first.
    await writePhase("idb-authoritative");
    return { dataDir: idbDataDir, storageBackend: "idbfs", verdict };
  };

  // The two record-clearing verdicts loop; every other verdict returns. Cleared record → a terminal verdict.
  for (let iteration = 0; iteration < MAX_DELETION_RECLASSIFY; iteration += 1) {
    // A failed meta read is an ERROR, never "no record" (invariant 12): StoreMetaUnreadableError propagates
    // here and fails the boot closed.
    const metaResult = await readStoreMetaRecord(storePath, meta);
    // META_STORE_UNAVAILABLE means IndexedDB is entirely absent — a no-idb scope cannot hold a record, so
    // absence is PROVABLE (record undefined) and there can be no existing idb store either (idbStoreExists
    // false). Faithful to store-meta's documented mapping.
    const metaUnavailable = metaResult === META_STORE_UNAVAILABLE;
    const record = metaUnavailable ? undefined : metaResult;

    // WARM COMMITTED FAST PATH. A record at `opfs-committed` DETERMINES the verdict: classification 2 says the
    // OPFS observations are IRRELEVANT on that arm (a committed store never re-derives its verdict from OPFS),
    // and the classifier consults `idbStoreExists` only on the recordless arm (classification 6). So on the
    // warmest and by far most frequent boot, NEITHER of the two remaining probes is a boot dependency: the
    // ~8-handle commitment-namespace observation and the IndexedDB open→onupgradeneeded→abort existence cycle
    // both come OFF the critical path. The verdict is still derived by the classifier — store-meta owns
    // classification, this module never hardcodes one — with the observations it documents as irrelevant here;
    // if it ever answered anything but `open-committed` for this phase, the guard below falls through to the
    // full observe-then-classify path unchanged.
    const committedFastVerdict =
      record?.phase === "opfs-committed"
        ? classifyStoreBoot({ record, opfs: "unobservable", idbStoreExists: false })
        : undefined;
    if (committedFastVerdict?.action === "open-committed") {
      return { dataDir: opfsDataDir, storageBackend: "opfs-repacked", verdict: committedFastVerdict };
    }

    const opfsObservation = await effects.observeCommitmentNamespace();
    const idbPresent = metaUnavailable ? false : await idbExists(storePath);
    const verdict = classifyStoreBoot({ record, opfs: opfsObservation, idbStoreExists: idbPresent });

    switch (verdict.action) {
      case "resume-deletion":
        // Complete the destructive lifecycle. `deleteBackendStore` is backend-agnostic: a `deleting` record
        // does not say which backend, so we delete-if-present BOTH the opfs directory and the idb database
        // (idempotent). Then re-classify from the now-clean state.
        await resumeDeletion({
          setPhase: writePhase,
          deleteSentinel: () => effects.deleteSentinel(),
          deleteBackendStore: async () => {
            await effects.deleteStoreDirectory();
            await deleteIdbDatabase(storePath, meta);
          },
          deleteMetaRecord: () => deleteStoreMetaRecord(storePath, meta),
        });
        continue;

      case "delete-candidate-and-rebuild":
        // An unexposed candidate has no authority, so RETIRE it: the stale sentinel MUST go alongside the
        // directory — a barrier-gap crash's published sentinel must never survive into the rebuilt candidate's
        // lifetime (plan fresh/restore crash table) — and the record goes with them. Then re-classify from the
        // now-recordless state, exactly as `resume-deletion` does. That re-read is what keeps the rebuild
        // honest: a store's backend is fixed at first mint, so an existing idb store at this path lands on
        // classification 6 and is opened IN PLACE, never shadowed by a fresh opfs mint. A truly clean state
        // reaches `virgin-create` and rebuilds.
        await effects.deleteSentinel();
        await effects.deleteStoreDirectory();
        await deleteStoreMetaRecord(storePath, meta);
        continue;

      case "repair-record-then-open-committed":
        // Sentinel present without a record (record loss): the sentinel is committed authority. Repair the
        // record, then open committed.
        await writePhase("opfs-committed");
        return { dataDir: opfsDataDir, storageBackend: "opfs-repacked", verdict };

      case "open-committed":
        // The record is already the authority for a committed store: open it, write nothing, touch nothing.
        return { dataDir: opfsDataDir, storageBackend: "opfs-repacked", verdict };

      case "boot-idb-authoritative":
        // Recordless idb store (no record yet, an existing idb store): write the record FIRST (invariant 14). A
        // present `idb-authoritative` record is left as-is. TERMINAL — the backend is fixed at first mint.
        if (record == null) await writePhase("idb-authoritative");
        return { dataDir: idbDataDir, storageBackend: "idbfs", verdict };

      case "virgin-create":
        return finishVirginCreate(verdict);

      default: {
        // Exhaustiveness guard: a new verdict MUST be wired explicitly, never silently ignored.
        const unreachable: never = verdict;
        throw new Error(`[pgxsinkit] unhandled store boot verdict: ${JSON.stringify(unreachable)}`);
      }
    }
  }

  // Only reachable if deletion never leaves a clean, terminal state — a guard against a non-terminating cycle.
  throw new Error(
    "[pgxsinkit] store boot did not settle after resuming a deletion (bounded re-classification exhausted).",
  );
}
