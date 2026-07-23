// The tab facade (ADR-0032 S2, decisions 3/4/6/7). `attachSyncClient` returns the SAME client shape as
// `createSyncClient` wherever semantics allow — the write API (RPC-backed), per-group readiness, the
// live-rows seam, `ready`/`status`/`stop` — transparently proxied to the one shared worker engine. The tab
// stays the single auth owner: it pushes its token at attach and on `notifyAuthChanged`, and answers the
// worker's expiry pull-requests via `getToken`.
//
// One-shot Drizzle reads (`query`/`queryRow`/`queryRaw`/`queryRawRow`) ARE proxied (ADR-0032 decision 4):
// `drizzle`/`views` here are a real Drizzle database over a bridge executor whose `query` routes each read to
// the worker's `guardedQuery` RPC, so awaiting a builder runs the ADR-0041 read gate + the ADR-0021
// lazy-group guard worker-side and Drizzle's own result mapping (relational/nested included) runs on the tab.
// `ensureSynced` (async lazy-activation) is a plain RPC to the shared engine. The only members that stay
// unsupported are the genuinely tab-local ones — `pglite` (no local store), `destroy`/`dropReadCache` (store
// lifecycle the worker owns), and `isSynced` (a SYNCHRONOUS activation-STARTED peek the tab's cached per-group
// catch-up readiness cannot answer, and a sync method cannot be an RPC) — each throwing a clear error saying why.

import type { Results } from "@electric-sql/pglite";

import type {
  MutationDiagnostics,
  SyncRuntimeStatus,
  SyncTableName,
  SyncTableRegistry,
  WriteMode,
} from "@pgxsinkit/contracts";

import type { BootReport } from "../boot-report";
import type { DataExportOptions, DataExportResult } from "../export-data";
import type { DiagnosticExportOptions, DiagnosticExportResult } from "../export-dump";
import type { StoreExportOptions, StoreExportResult } from "../export-store";
import {
  buildRegistryReadHandles,
  type ClientPGlite,
  ClientDisposedError,
  createMutationsApi,
  type LiveQueryDiagnostics,
  type LiveRowsSubscription,
  type MutationBatchItem,
  type MutationDetail,
  type SubscribeLiveRowsInput,
  type SyncClient,
  type SyncTransaction,
  type SyncTransactionResult,
} from "../index";
import type { LocalStoreVersionEvent } from "../local-store";
import { createOpfsEffects, type OpfsEffectsDeps } from "../opfs-effects";
import { type DestructionEffects, runDestruction } from "../store-lifecycle";
import { deleteStoreMetaRecord, type StoreMetaDeps, writeStoreMetaRecord } from "../store-meta";
import { storeIndexedDbDatabaseName } from "../store-path";
import { readTestStoreMarker } from "../store-path";
import {
  CONTROL_PORT_DELIVERY_KEY,
  DESTROY_QUERY_KEY,
  DESTROY_VERDICT_KEY,
  PLACEMENT_RESULT_KEY,
  type PlacementQueryResult,
  PLACEMENT_QUERY_KEY,
} from "./define-sync-worker";
import {
  type CoordinatorDeps,
  createElectionCoordinator,
  type ElectionCoordinator,
  type SwBridgePort,
} from "./election-coordinator";
import {
  type EngineControlMessage,
  engineIdentityEquals,
  type EngineIdentity,
  EngineRelocatedError,
  engineRelocatedFromWire,
  executionLimitMismatchFromWire,
  type ExecutionLimitConfig,
  isStaleIdentity,
  readControlEnvelope,
  wrapControlEnvelope,
} from "./engine-control";
import { LiveRowsMaterializer } from "./live-diff";
import {
  type AttachAckPayload,
  type AttachPayload,
  type AuthTokenSnapshot,
  type BridgeCodec,
  type BridgeEvent,
  type BridgePort,
  type BridgeTransferable,
  type ExportArtefactWire,
  type GuardedQueryWireArgs,
  identityCodec,
  type BridgeErrorWire,
  isBridgeEnvelope,
  type LiveDiffPayload,
  type LiveHydratedPayload,
  type LiveInitialPayload,
  postBridgeMessage,
  type ProvisionAckPayload,
  type RestoreArtefactWire,
  type RpcOp,
  type RpcResultPayload,
  type TokenRequestPayload,
} from "./protocol";

/** A `Worker`/`SharedWorker`-shaped handle: a dedicated `Worker` IS the port; a `SharedWorker` carries `.port`. */
interface WorkerLike {
  port?: BridgePort;
  postMessage?: (message: unknown, transfer?: BridgeTransferable[]) => void;
  addEventListener?: (
    type: "message" | "error",
    listener: (event: { data?: unknown; message?: unknown }) => void,
  ) => void;
  removeEventListener?: (
    type: "message" | "error",
    listener: (event: { data?: unknown; message?: unknown }) => void,
  ) => void;
  terminate?: () => void;
}

/**
 * The elected engine worker handle the election coordinator drives (ADR-0049 D5, step 8): `terminate()` (a
 * deliberate teardown / respawn), `onError` (a reported worker death → immediate respawn), and
 * `deliverControlPort` (post the engine end of the announce control channel — `{ [CONTROL_PORT_DELIVERY_KEY]:
 * true }` with the port transferred — so the elected worker's step-9 control plane starts on it). The consumer
 * supplies a factory that constructs their own `defineSyncWorker` entry as a dedicated `Worker`; wrap it with
 * {@link wrapEngineWorker}.
 */
export interface ElectedEngineWorker {
  terminate(): void;
  onError(listener: (message: string) => void): void;
  deliverControlPort(port: unknown): void;
}

/**
 * Wrap a dedicated `Worker` (a consumer's `defineSyncWorker` engine entry) into the {@link ElectedEngineWorker}
 * the coordinator drives (ADR-0049 step 10b). `deliverControlPort` posts `{ [CONTROL_PORT_DELIVERY_KEY]: true }`
 * on the worker's implicit port with the control-channel end TRANSFERRED — exactly the delivery message the
 * step-9 engine control plane listens for. `onError` subscribes to the worker's `error` event; `terminate`
 * forwards to `worker.terminate()`.
 */
/**
 * The default {@link AttachSyncClientOptions.awaitOwnershipRelease} — a documented NO-OP (ADR-0049 step 11b
 * follow-up 1). The OPFS-repacked VFS enforces single-owner access with EXCLUSIVE OPFS sync-access handles
 * (`StoreOwnedError`), not a Web Lock, so there is no ownership lock to await from here without importing the
 * VFS. The bounded wait for the dead worker's agent to release the handle lives entirely in the SUCCESSOR'S OPEN
 * PATH: the respawned engine's `createOpfsRepacked` open retries on the owned-store contention error until it
 * clears (the `openWithBoundedRetries` wrapper) — the fault-matrix "successor open retries on contention" row.
 * So the coordinator can respawn immediately after a deliberate terminate; its VFS open is the real gate.
 */
export function resolvedOwnershipRelease(): Promise<void> {
  return Promise.resolve();
}

export function wrapEngineWorker(worker: WorkerLike): ElectedEngineWorker {
  const post = (message: unknown, transfer: BridgeTransferable[]): void => {
    if (worker.postMessage) worker.postMessage(message, transfer);
    else worker.port?.postMessage(message, transfer);
  };
  return {
    terminate: () => worker.terminate?.(),
    onError: (listener) => {
      worker.addEventListener?.("error", (event) => {
        const message = (event as { message?: unknown }).message;
        listener(typeof message === "string" ? message : "elected engine worker error");
      });
    },
    deliverControlPort: (port) => post({ [CONTROL_PORT_DELIVERY_KEY]: true }, [port as BridgeTransferable]),
  };
}

/**
 * `destroy()` on an attached facade REFUSES when other tabs still hold the store (ADR-0049 D8, plan fault row
 * "`destroy()` with peers attached → refused with a typed error — close peers first"). The SharedWorker — the
 * only role that knows the attached-tab count — answers a peer-count query; more than one attached tab (this
 * one plus at least one other) raises this. `peers` is the total attached-tab count, this tab included.
 */
export class StoreDestroyRefusedError extends Error {
  readonly peers: number;
  constructor(peers: number) {
    super(
      `[pgxsinkit] destroy() refused: ${Math.max(0, peers - 1)} other tab(s) are still attached to this store. ` +
        "Close the peer tabs first, then destroy — the store is shared and destroying it under a live peer would " +
        "strand that tab's engine.",
    );
    this.name = "StoreDestroyRefusedError";
    this.peers = peers;
  }
}

/**
 * Attach WIRING failure (ADR-0049 D1/D5): the SharedWorker requires election (a router-only, handle-denied home)
 * but the elected engine worker CANNOT be constructed — neither a `createEngineWorker` override was supplied NOR is
 * the SharedWorker's own script URL derivable (a plain scope that cannot report `self.location.href`, or a
 * non-module entry). Capability absence FALLS BACK (idbfs); a wiring failure ERRORS — the capability was present and
 * the configuration was wrong, and silently downgrading storage would hide the defect. `[pgxsinkit]`-prefixed like
 * the repo's other typed errors so a consumer can `instanceof`-branch it.
 */
export class ElectedEngineUnconstructibleError extends Error {
  constructor(detail: string) {
    super(
      `[pgxsinkit] cannot attach: this SharedWorker is router-only (election required) but the elected engine ` +
        `worker cannot be constructed — ${detail}. Pass a \`createEngineWorker\` override for entries that cannot ` +
        `be reconstructed from their URL as a module worker (classic-script / blob: / data: / CSP-constrained), ` +
        `or use a SharedWorker whose script URL is derivable (ADR-0049 D5). This is a wiring defect, not a ` +
        `capability fallback — the platform can hold sync-access handles here.`,
    );
    this.name = "ElectedEngineUnconstructibleError";
  }
}

/** The minimal `indexedDB.deleteDatabase` surface (no DOM lib) — mirrors `store-boot.ts`'s idb delete seam. */
interface IdbDeleteSurface {
  deleteDatabase(name: string): {
    error?: unknown;
    onsuccess: (() => void) | null;
    onerror: (() => void) | null;
    onblocked?: (() => void) | null;
  };
}

/** Resolve the `deleteDatabase` surface: injected meta deps first (tests), else structural off `globalThis`. */
function resolveIdbDeleteSurface(meta?: StoreMetaDeps): IdbDeleteSurface | undefined {
  if (meta != null && "indexedDB" in meta) return meta.indexedDB as unknown as IdbDeleteSurface | undefined;
  return (globalThis as { indexedDB?: IdbDeleteSurface }).indexedDB;
}

/** Delete-if-present the store's PGlite idb database; only `onsuccess` proves completion. */
function deleteStoreIdbDatabase(storePath: string, meta?: StoreMetaDeps): Promise<void> {
  const idb = resolveIdbDeleteSurface(meta);
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

/**
 * Build the REAL {@link DestructionEffects} for a store — the OPFS commitment sentinel + store directory
 * (`opfs-effects.ts`), the meta record (`store-meta.ts`), and the PGlite idb database. The destruction machine is
 * backend-agnostic (`store-lifecycle.ts`): `deleteBackendStore` delete-if-presents BOTH the OPFS directory and
 * the idb database, so it works whichever backend the store used. Injectable IO (`opfs`/`meta`) so the wiring is
 * unit-testable with fakes.
 */
export function createStoreDestructionEffects(
  storePath: string,
  deps?: { opfs?: OpfsEffectsDeps; meta?: StoreMetaDeps },
): DestructionEffects {
  const opfs = createOpfsEffects(storePath, deps?.opfs);
  const meta = deps?.meta;
  return {
    setPhase: (phase) => writeStoreMetaRecord(storePath, { phase, updatedAt: Date.now() }, meta),
    deleteSentinel: () => opfs.deleteSentinel(),
    deleteBackendStore: async () => {
      await opfs.deleteStoreDirectory();
      await deleteStoreIdbDatabase(storePath, meta);
    },
    deleteMetaRecord: () => deleteStoreMetaRecord(storePath, meta),
  };
}

/** The bounded ownership-retry options for {@link runStoreDestruction} (the VFS-lock-lag guard, D8/fault row). */
export interface StoreDestructionRetryOptions {
  /** Max retries of `deleteBackendStore` on an ownership-lock-lag error before giving up (default 5). */
  maxOwnershipRetries?: number;
  /** Classify an error as VFS-ownership-lock lag (retryable). Default: OPFS `NoModificationAllowedError`-class. */
  isOwnershipError?: (error: unknown) => boolean;
  /** Between-retries delay; defaults to a real timer. Injected in tests. */
  delay?: (ms: number) => Promise<void>;
  /** The between-retries delay (ms); default 50. */
  retryDelayMs?: number;
}

/** Default ownership-lag classifier: OPFS raises `NoModificationAllowedError`/`InvalidStateError` while a sync-access handle is open. */
function defaultIsOwnershipError(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name;
  if (name === "NoModificationAllowedError" || name === "InvalidStateError") return true;
  const message = (error as { message?: unknown } | null)?.message;
  const text = (typeof message === "string" ? message : "").toLowerCase();
  return text.includes("owned") || text.includes("ownership") || text.includes("locked") || text.includes("in use");
}

/**
 * Run the destructive lifecycle (ADR-0049 D8) with a BOUNDED ownership-lock-lag retry around the backend-store
 * delete. The engine was just detached, so its VFS ownership lock may not have cleared yet — the fault row
 * "VFS ownership-lock release lag → successor retries until clear, bounded" applies to destroy too. The other
 * steps (set `deleting`, delete sentinel, delete the meta record) are idempotent and not retried here. Shared by
 * the attached-facade supervisor (this module) and the in-process `destroy()` (index.ts).
 */
export async function runStoreDestruction(
  effects: DestructionEffects,
  opts?: StoreDestructionRetryOptions,
): Promise<void> {
  const maxRetries = opts?.maxOwnershipRetries ?? 5;
  const isOwnershipError = opts?.isOwnershipError ?? defaultIsOwnershipError;
  const delay = opts?.delay ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const retryDelayMs = opts?.retryDelayMs ?? 50;
  const guarded: DestructionEffects = {
    setPhase: (phase) => effects.setPhase(phase),
    deleteSentinel: () => effects.deleteSentinel(),
    deleteMetaRecord: () => effects.deleteMetaRecord(),
    deleteBackendStore: async () => {
      for (let attempt = 0; ; attempt += 1) {
        try {
          await effects.deleteBackendStore();
          return;
        } catch (error) {
          if (attempt >= maxRetries || !isOwnershipError(error)) throw error;
          await delay(retryDelayMs);
        }
      }
    },
  };
  await runDestruction(guarded);
}

/** Narrow a raw SharedWorker placement reply (`{ [PLACEMENT_RESULT_KEY]: … }`), or `undefined` for foreign traffic. */
function readPlacementResult(data: unknown): PlacementQueryResult | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const result = (data as { [PLACEMENT_RESULT_KEY]?: unknown })[PLACEMENT_RESULT_KEY];
  if (typeof result !== "object" || result === null) return undefined;
  return result as PlacementQueryResult;
}

/** Narrow a raw SharedWorker destroy peer-count verdict (`{ [DESTROY_VERDICT_KEY]: { peers } }`), or `undefined`. */
function readDestroyVerdict(data: unknown): number | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const verdict = (data as { [DESTROY_VERDICT_KEY]?: unknown })[DESTROY_VERDICT_KEY];
  if (typeof verdict !== "object" || verdict === null) return undefined;
  const peers = (verdict as { peers?: unknown }).peers;
  return typeof peers === "number" ? peers : undefined;
}

/**
 * The `setTimeout`/`clearTimeout` pair the handoff-queue deadline and the bridge-silence reconnect schedule on
 * (ADR-0049 step 7) — injectable for deterministic tests, exactly the discipline `engine-router.ts` follows so
 * the whole placement seam is unit-testable with no real timers.
 */
export interface AttachClientTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/**
 * The RPC ops that MUTATE the store/journal or push to the server — the ones whose lost response after a
 * relocation is `outcome: "unknown"` (a journal update may already exist, there is no dedup key; ADR-0049 D10,
 * invariant 5). Everything NOT in this set is a READ (or an idempotent activation) that is safe to repeat, so it
 * settles `outcome: "not-dispatched"`. `ensureSynced` is deliberately a read here: activation is additive and
 * idempotent (starting an already-active group is a no-op), so repeating it can never double-apply. The
 * `export*` ops read the store into an artefact (no mutation) and are likewise safe to repeat.
 */
const MUTATION_RPC_OPS: ReadonlySet<RpcOp> = new Set<RpcOp>([
  "create",
  "update",
  "delete",
  "batch",
  "transaction",
  "flush",
  "reconcile",
  "retryFailed",
  "recoverSending",
  "discardConflict",
  "discardQuarantined",
  "desync",
  "discardEphemeral",
  // `rawExec` is WRITE-CAPABLE (its docstring: any write it issues stays local and will NOT converge), so a
  // dispatched rawExec with a lost response is `"unknown"` — retrying could double-apply a local write.
  "rawExec",
]);

export interface AttachSyncClientOptions<TRegistry extends SyncTableRegistry> {
  registry: TRegistry;
  /**
   * The worker input — PRIMARILY a FACTORY `() => SharedWorker` (ADR-0049 D5). A `SharedWorker` object cannot be
   * reconstructed from itself, so the factory is what makes SharedWorker-death recovery (the keepalive
   * reconstruction, and the {@link bridgeSilenceMs} bridge-silence reconnect) a GUARANTEE rather than an option:
   * both re-invoke it for a fresh SharedWorker. A bare instance (a native `Worker`/`SharedWorker`, or anything
   * port-shaped) is ALSO accepted for tests and exotic hosts — reconstruction is then structurally unavailable
   * (diagnostics say so). Provide this OR {@link port}.
   */
  worker?: (() => WorkerLike) | WorkerLike;
  /** A raw transport port (a `MessageChannel` port in tests, a `SharedWorker.port` in a browser). */
  port?: BridgePort;
  /**
   * The tab's token provider (ADR-0032 decision 3). Richer than `createSyncClient`'s string form: the
   * worker needs the EXPIRY to apply its pull margin, so this yields `{accessToken, expiresAt}` (or null
   * when unauthenticated). Pushed at attach and answered on every worker pull-request.
   */
  getToken?: () => Promise<AuthTokenSnapshot | null>;
  /** The bound store id (resolved tab-side before attach — SharedWorker naming, ADR-0032 decision 5). */
  storeId?: string;
  /**
   * The plain store PATH (ADR-0036) the worker opens if it must create its own store — a name, not a
   * storage URL. Spread `memoryStoreForTests(...)` from `@pgxsinkit/client/testing` here for a memory store
   * in tests (it also carries the internal marker forwarded to the worker as the memory-backend override).
   */
  storePath?: string;
  syncEnabled?: boolean;
  /**
   * Which baked registry the worker boots (ADR-0032 S3) — forwarded in the attach `config.role`. A worker
   * file that bakes multiple role variants (the board's admin/member) picks by this; single-registry
   * workers ignore it.
   */
  role?: string;
  /**
   * Fresh-store prefetch-overlap hint (ADR-0032 S4), forwarded in the attach `config.freshStore`. Set true
   * ONLY when the tab knows the store is a claimed schemaless spare (never for a mapped/returning store);
   * the worker's `createSyncClient` then overlaps the shape catch-up with its local boot phases.
   */
  freshStore?: boolean;
  /**
   * Restore the worker's store from a backup on attach (ADR-0035 decision 6) — the worker-mode `restoreFrom`.
   * A `File`/`Blob` as produced by {@link SyncClient.exportStore}; the facade decomposes it into a transferred
   * `ArrayBuffer` + name/mime ({@link RestoreArtefactWire}) and the worker recomposes it for `createSyncClient`.
   * Restore rides the one handshake that reaches the ENGINE HOME: a restore-bearing attach awaits the
   * placement reply, then carries the artifact on the SW-port handshake when the in-scope host is the engine
   * (SW-direct / declared-idbfs) or on the first per-tab PIPE handshake when the engine is elected — the
   * router-only SharedWorker is payload-blind, so a restore posted there would be dropped and destroyed.
   * Passing it when the engine has ALREADY booted rejects the attach with a typed error
   * (`RestoreIntoRunningStoreError` by name — you cannot restore into a running store). The restored engine
   * boots offline and its recovered journal is quarantined, exactly as in-process — see `restoreFrom` on
   * `createSyncClient`.
   */
  restoreFrom?: File | Blob;
  codec?: BridgeCodec;
  onStatusChange?: (status: SyncRuntimeStatus) => void;
  onConflict?: (details: MutationDetail[]) => void;
  onQuarantine?: (details: MutationDetail[]) => void;
  onReject?: (details: MutationDetail[]) => void;
  onSchemaChange?: (event: LocalStoreVersionEvent) => void;
  onSyncError?: (error: Error) => void;
  /**
   * Boot observability (ADR-0034): invoked once with the worker engine's finalized {@link BootReport} if the
   * engine's boot finalizes WHILE this tab is attached (the one-shot `boot-report` broadcast). A tab that
   * attaches AFTER the boot never receives the push — it reads the report via {@link SyncClient.bootReport}.
   */
  onBootReport?: (report: BootReport) => void;
  /**
   * The bridge-silence deadline (ms) for non-leader reconnection (ADR-0049 D5). DISABLED when undefined (the
   * default); the election coordinator (step 8) sets it. When set: a pending op left with NO bridge traffic
   * since it was posted, past this deadline, triggers ONE reconnect attempt via the {@link worker} FACTORY (if the
   * input is a factory) — construct a fresh SharedWorker, resolve its port, re-attach, flush the queue,
   * re-subscribe. With a bare-instance input reconstruction is structurally unavailable, so no reconnect is armed.
   * Scheduled on {@link timers}.
   */
  bridgeSilenceMs?: number;
  /**
   * The bounded handoff queue (ADR-0049 invariant 9). While the handoff window is open — after a relocation
   * notice, before the replacement pipe's handshake completes — new data-path ops are QUEUED, not posted.
   * `cap` overflow or `deadlineMs` expiry fails queued ops with `EngineRelocatedError("not-dispatched")` (they
   * never left the tab, so they are safe to retry). Defaults: `cap` 256, `deadlineMs` 15000. The deadline is
   * scheduled on {@link timers}.
   */
  handoffQueue?: { cap?: number; deadlineMs?: number };
  /**
   * Injectable timers for the handoff-queue deadline and the bridge-silence reconnect (ADR-0049 step 7) — the
   * same deterministic-test seam `engine-router.ts` exposes. Defaults to `globalThis.setTimeout`/`clearTimeout`.
   */
  timers?: AttachClientTimers;
  /**
   * The elected engine worker OVERRIDE (ADR-0049 D5). In `elected-worker` placement (a router-only SharedWorker)
   * the tab's election coordinator spawns the real engine as a dedicated `Worker`. NORMALLY NO WIRING IS NEEDED:
   * the worker entry is dual-scope (one file serves both homes), the SharedWorker reports its own script URL in the
   * placement reply, and the winning tab constructs the engine as `new Worker(swScriptUrl, { type: "module" })`
   * itself. Supply this override ONLY for entries that cannot be reconstructed from their URL as a module worker
   * (classic-script workers, `blob:`/`data:` URLs, CSP constraints); wrap the constructed worker with
   * {@link wrapEngineWorker}. When election is required but NEITHER a derivable URL NOR this override is available,
   * attach fails with the typed {@link ElectedEngineUnconstructibleError} — never a silent no-engine attach.
   */
  createEngineWorker?: () => ElectedEngineWorker;
  /**
   * The opt-in engine-construction EXECUTION LIMIT (ADR-0049 D5) as this tab carries it — every tab attaching to a
   * store MUST carry the SAME value the worker was constructed with (`ExecutionLimitMismatchError` on a mismatch).
   * DISABLED by default (`undefined` / absent `maxDispatchMs`) — no finite worst-case query duration exists, so
   * enabling the limit (which converts slow to terminated by policy) is a deliberate consumer choice. When
   * `maxDispatchMs` is set AND this tab is on an elected per-tab pipe, a dispatched RPC still outstanding past the
   * limit is reported to the router as an `overdue-dispatch` (the router then probes the engine's control channel;
   * a WASM-blocked engine cannot answer → the leader retires + respawns it). ELECTED PLACEMENT ONLY — on SW-direct
   * the option is rejected as unsupported during attach rather than silently ignored.
   */
  executionLimit?: ExecutionLimitConfig;
  /**
   * The leader-keepalive ping cadence (ms) the election coordinator uses (ADR-0049 step 8). Default 20000. The
   * keepalive is the ONE standing timer that detects SharedWorker death (unanswered pings) → reconstruct via the
   * {@link worker} factory + re-announce the still-live engine. Lower it to detect SW death faster.
   */
  keepaliveIntervalMs?: number;
  /** Consecutive unanswered keepalive pings before SharedWorker reconstruction (ADR-0049 step 8). Default 2. */
  keepaliveMissThreshold?: number;
  /**
   * Await the VFS ownership release after a deliberate engine termination (ADR-0049 step 8). Defaults to the
   * documented no-op {@link resolvedOwnershipRelease} — the HONEST MINIMUM (step 11b follow-up 1): the
   * OPFS-repacked VFS enforces ownership with EXCLUSIVE OPFS sync-access handles (`StoreOwnedError` /
   * `STORE_OWNED`), NOT a Web Lock, so there is no lock name to `navigator.locks.request(..., { ifAvailable })`
   * against here. The bounded wait therefore lives in the SUCCESSOR'S OPEN PATH: the respawned elected engine
   * worker's own `createOpfsRepacked` open throws the owned-store contention error and is retried with backoff
   * (the `openWithBoundedRetries` wrapper in `createClientPGlite`) until the dead worker's agent releases the
   * handle — exactly the fault-matrix row "VFS ownership-lock release lag → successor open retries on contention
   * until clear, bounded, then boot failure". Supply a custom async wait only to inject a real probe (tests do).
   */
  awaitOwnershipRelease?: () => Promise<void>;
  /**
   * @internal test seam (ADR-0049 step 10b): override the election coordinator's IO — the Web Locks surface and
   * the page-lifecycle subscription. Production reads `navigator.locks` structurally and subscribes to real
   * `pagehide`/`pageshow`. Injected so the election wiring is unit-testable with a fake locks (no real
   * `navigator.locks` under Bun).
   */
  electionIo?: {
    locks?: CoordinatorDeps["locks"];
    pageLifecycle?: CoordinatorDeps["pageLifecycle"];
  };
  /**
   * @internal test seam (ADR-0049 step 10b): override the destruction effects the ATTACHED `destroy()` runs
   * after it detaches. Production builds real OPFS + meta-record + idb effects from the store path
   * ({@link createStoreDestructionEffects}); injected so the supervised-destroy path is unit-testable with fake
   * effects (effect-order assertions, ownership-lock-lag retry).
   */
  createDestructionEffects?: (storePath: string) => DestructionEffects;
}

/**
 * The worker-attached client: `SyncClient`'s shape, worker-proxied, plus `notifyAuthChanged` (re-push the
 * token after an app auth-state change, ADR-0032 decision 3). One-shot Drizzle reads
 * (`query`/`queryRow`/`queryRaw`/`queryRawRow`) and `ensureSynced` ARE proxied to the worker; the members
 * that throw are the structurally unproxiable ones — `pglite`, `destroy`, `dropReadCache`, `isSynced`, and
 * `drizzle.transaction()`.
 */
export type AttachedSyncClient<TRegistry extends SyncTableRegistry> = SyncClient<TRegistry> & {
  notifyAuthChanged: () => void;
  /**
   * Forward the app's Offline toggle to the worker (ADR-0032 S3). The worker owns convergence, so the
   * tab cannot gate a local trigger; this sends `set-online`, which suppresses/resumes the worker's flush
   * passes (resuming fires one immediate pass). The in-process client gates its own `autoSync` instead.
   */
  setOnline: (online: boolean) => void;
};

/**
 * The IO a shared election coordinator is built from (ADR-0049 step 8) — the subset both {@link attachSyncClient}
 * and the elected {@link provisionSyncWorker} pass so ONE coordinator serves a tab's whole (provision + attach)
 * lifecycle per store (invariant 2 — never self-queued). A module-level builder (not a per-call closure) so both
 * entry points construct the identical coordinator.
 */
interface ElectedCoordinatorParams {
  storePath: string;
  /** The SW control port the coordinator posts announce/keepalive on (the FIRST creator's connection). */
  controlPort: BridgePort;
  createEngineWorker: () => ElectedEngineWorker;
  /** The SharedWorker reconstruction factory (ADR-0049 D5) — drives the keepalive SW-death recovery. Absent for a
      bare-instance input, where reconstruction is structurally unavailable. */
  swFactory?: () => WorkerLike;
  electionIo?: AttachSyncClientOptions<SyncTableRegistry>["electionIo"];
  awaitOwnershipRelease?: () => Promise<void>;
  timers: AttachClientTimers;
  pageLifecycle?: CoordinatorDeps["pageLifecycle"];
  keepaliveIntervalMs?: number;
  keepaliveMissThreshold?: number;
}

/**
 * Build the tab's election coordinator over a SW control port. The spawn adapter mints the announce control
 * channel and delivers its ENGINE end to the freshly-spawned worker; `createControlChannel` yields the SAME
 * channel so `announce` transfers the ROUTER end to the SharedWorker; a re-announce WITHOUT a respawn (keepalive
 * SW reconstruction) re-delivers a fresh engine-end to the retained live engine (step 11b follow-up 2).
 */
function buildElectedCoordinator(params: ElectedCoordinatorParams): ElectionCoordinator {
  const factory = params.createEngineWorker;
  let pendingChannel: MessageChannel | undefined;
  let liveEngine: ElectedEngineWorker | undefined;
  const locks = params.electionIo?.locks ??
    (globalThis as { navigator?: { locks?: CoordinatorDeps["locks"] } }).navigator?.locks ?? {
      request: () => Promise.resolve(),
    };
  const deps: CoordinatorDeps = {
    locks,
    spawnEngineWorker: () => {
      const engine = factory();
      liveEngine = engine;
      const channel = new MessageChannel();
      pendingChannel = channel;
      engine.deliverControlPort(channel.port2);
      return { terminate: () => engine.terminate(), onError: (listener) => engine.onError(listener) };
    },
    createControlChannel: () => {
      if (pendingChannel !== undefined) {
        const channel = pendingChannel;
        pendingChannel = undefined;
        return { port1: channel.port1, port2: channel.port2 };
      }
      const channel = new MessageChannel();
      liveEngine?.deliverControlPort(channel.port2);
      return { port1: channel.port1, port2: channel.port2 };
    },
    swPort: params.controlPort as unknown as SwBridgePort,
    ...(params.swFactory
      ? { reconstructSw: () => resolvePort({ worker: params.swFactory! }) as unknown as SwBridgePort }
      : {}),
    awaitOwnershipRelease: params.awaitOwnershipRelease ?? resolvedOwnershipRelease,
    timers: params.timers,
    ...(params.pageLifecycle ? { pageLifecycle: params.pageLifecycle } : {}),
  };
  return createElectionCoordinator(deps, {
    storePath: params.storePath,
    ...(params.keepaliveIntervalMs != null ? { keepaliveIntervalMs: params.keepaliveIntervalMs } : {}),
    ...(params.keepaliveMissThreshold != null ? { keepaliveMissThreshold: params.keepaliveMissThreshold } : {}),
  });
}

/**
 * Per-store SHARED election coordinators (ADR-0049 step 8 — "one coordinator per tab per store; provision and
 * attach share it"). Populated ONLY by an elected {@link provisionSyncWorker}; a later {@link attachSyncClient}
 * on the SAME store (same page realm) ADOPTS it (`claimForAttach` — no second lock request, no second engine,
 * invariant 2). Empty when no provision ran, so attach-only flows never touch it (no shared coordinator to adopt). Keyed
 * by store path; ref-counted so it clears once every provision claim + adopting attach has released.
 */
const sharedCoordinators = new Map<
  string,
  {
    coordinator: ElectionCoordinator;
    refs: number;
    /**
     * The provision's live engine pipe, held for HANDOVER (ADR-0049 step 8). The router mints exactly ONE proxy
     * pipe per SW connection; when provision and attach share one port (the documented ordered-messages contract,
     * e.g. the board), that pipe is delivered during provisioning — so the adopting attach must receive THIS pipe
     * rather than wait for a `connect-port` that will never be re-sent. Cleared on take; closed if never taken.
     */
    provisionPipe?: { pipe: BridgePort; identity: EngineIdentity };
  }
>();

/** Adopt an existing per-store coordinator (incrementing its ref), or register a freshly-built one. */
function adoptOrRegisterCoordinator(storePath: string, build: () => ElectionCoordinator): ElectionCoordinator {
  let entry = sharedCoordinators.get(storePath);
  if (entry === undefined) {
    entry = { coordinator: build(), refs: 0 };
    sharedCoordinators.set(storePath, entry);
  }
  entry.refs += 1;
  return entry.coordinator;
}

/** Look up an already-registered per-store coordinator WITHOUT registering one (attach's adopt-if-present probe). */
function lookupSharedCoordinator(storePath: string): ElectionCoordinator | undefined {
  return sharedCoordinators.get(storePath)?.coordinator;
}

/** Increment the ref of an already-registered coordinator (an adopting attach); no-op if none is registered. */
function retainSharedCoordinator(storePath: string): void {
  const entry = sharedCoordinators.get(storePath);
  if (entry !== undefined) entry.refs += 1;
}

/** Release one ref; the entry clears at zero so a later provision/attach starts a fresh coordinator. */
function releaseSharedCoordinator(storePath: string): void {
  const entry = sharedCoordinators.get(storePath);
  if (entry === undefined) return;
  entry.refs -= 1;
  if (entry.refs <= 0) {
    entry.provisionPipe?.pipe.close?.();
    sharedCoordinators.delete(storePath);
  }
}

/** Stash the provision's engine pipe for the adopting attach's handover; no-op when no entry is registered. */
function stashProvisionPipe(storePath: string, pipe: BridgePort, identity: EngineIdentity): void {
  const entry = sharedCoordinators.get(storePath);
  if (entry !== undefined) entry.provisionPipe = { pipe, identity };
}

/** Take (and clear) the stashed provision pipe — exactly one adopting attach may consume it. */
function takeProvisionPipe(storePath: string): { pipe: BridgePort; identity: EngineIdentity } | undefined {
  const entry = sharedCoordinators.get(storePath);
  const stashed = entry?.provisionPipe;
  if (entry !== undefined) delete entry.provisionPipe;
  return stashed;
}

export async function attachSyncClient<const TRegistry extends SyncTableRegistry>(
  options: AttachSyncClientOptions<TRegistry>,
): Promise<AttachedSyncClient<TRegistry>> {
  const codec = options.codec ?? identityCodec;
  const port = resolvePort(options);
  // The SharedWorker reconstruction factory (ADR-0049 D5), or undefined for a bare-instance/port input. Drives the
  // bridge-silence reconnect and the coordinator's keepalive SW-reconstruction; both re-invoke it for a fresh
  // SharedWorker. Absent → reconstruction is structurally unavailable and those recovery paths are simply not armed.
  const workerFactory = workerFactoryOf(options.worker);

  // ─── ADR-0049 placement seams (data-port indirection, handoff window, reconnect) ──────────────────
  // `controlPort` permanently carries the `{ pgx0049 }` control plane (relocation notices + `connect-port`);
  // `dataPort` starts AS the control port (SW-direct / declared-idbfs / no-pgx0049: the data path never leaves the SW port) and SWAPS to a
  // transferred pipe on `connect-port`. Every data-path send goes through `currentDataPort()` so the pending
  // maps stay in place across a swap (invariant 6 — one direct pipe per tab; the router never sees payloads).
  let controlPort: BridgePort = port;
  let dataPort: BridgePort = port;
  const currentDataPort = (): BridgePort => dataPort;
  const timers: AttachClientTimers = options.timers ?? {
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
  };
  // The current engine identity (invariant 7 — the pair), set on each accepted `connect-port`; `hasPipe` marks
  // that the data path has left the control port. The handoff window (`windowOpen`) queues new ops.
  let currentEngineIdentity: EngineIdentity | undefined;
  let hasPipe = false;
  let windowOpen = false;
  // Bounded handoff queue (invariant 9): thunks deferred while the window is open, each carrying a `reject` so
  // cap-overflow / deadline-expiry can fail the caller with `EngineRelocatedError("not-dispatched")`.
  const handoffQueue: Array<{ dispatch: () => void; reject: (error: Error) => void }> = [];
  const queueCap = options.handoffQueue?.cap ?? 256;
  const queueDeadlineMs = options.handoffQueue?.deadlineMs ?? 15000;
  let queueDeadlineHandle: unknown;
  // Bridge-silence reconnect (D5): armed on each dispatch when `bridgeSilenceMs` + a factory are set; ONE
  // attempt. `bridgeSeenSinceArm` distinguishes a live-but-slow engine from true silence.
  let silenceHandle: unknown;
  let bridgeSeenSinceArm = false;
  let reconnecting = false;
  // ─── ADR-0049 election + supervised-destroy state ─────────────────────────────────────────────────
  // The tab's election coordinator (created lazily on a router-only `electionRequired` placement reply — the
  // elected engine factory is the `createEngineWorker` override or the URL-derived default) + its released-on-detach
  // claim; and the pending destroy peer-count verdict resolver (the SharedWorker answers a `{ [DESTROY_QUERY_KEY] }`
  // query with the attached-tab count).
  let electionCoordinator: ElectionCoordinator | undefined;
  let releaseElectionClaim: (() => void) | undefined;
  let destroyVerdictResolver: ((peers: number) => void) | undefined;
  let placementResult: PlacementQueryResult | undefined;
  let swTeardownAckResolver: ((error?: BridgeErrorWire) => void) | undefined;
  let swTeardownIdentity: EngineIdentity | undefined;
  // Set to the store path when this attach ADOPTED a shared (provision-registered) coordinator — so detach
  // releases the shared ref (ref-counted registry cleanup). Undefined when this tab built its own coordinator.
  let adoptedSharedCoordinatorStore: string | undefined;
  // The placement decision is single-shot: once we act on the first `electionRequired` reply we ignore any repeat.
  let placementDecided = false;
  // Settles when the FIRST placement reply arrives (the bootstrap meta listener answers the query in BOTH SW
  // modes). Restore-bearing boots await it before the first handshake — see the send site for why.
  let resolvePlacementKnown: (() => void) | undefined;
  const placementKnown = new Promise<void>((resolve) => {
    resolvePlacementKnown = resolve;
  });
  // The restore artifact rides EXACTLY ONE handshake — its ArrayBuffer detaches on first post, so a resend
  // would carry an empty buffer. Set the moment a handshake actually carries it (see `runAttachHandshake`).
  let restoreConsumed = false;

  // ─── ADR-0049 first-attach gate (placement-query-FIRST ordering — elected-mode ack routing) ───────
  // `attachSyncClient` no longer gates on the SW-port attach ack: a router-only SharedWorker (elected-worker home)
  // is payload-blind and DROPS the bridge `attach`, so that ack would never come there. Instead the attach resolves
  // when the FIRST attach ack lands from EITHER home — the in-scope SW engine (SW-direct / declared-idbfs / no-SW
  // baseline) OR the elected engine over the per-tab pipe (`onConnectPort`, after election delivers `connect-port`).
  // It REJECTS on a boot-failure ack, on detach, or — when election is required but the engine worker cannot be
  // constructed — with the typed {@link ElectedEngineUnconstructibleError} (a WIRING failure, never a hang). With a
  // constructible engine, the coordinator's own election spawns it and delivers the pipe, so no attach deadline exists.
  let firstAttachSettled = false;
  let resolveFirstAttach!: () => void;
  let rejectFirstAttach!: (error: Error) => void;
  const firstAttachReady = new Promise<void>((resolve, reject) => {
    resolveFirstAttach = resolve;
    rejectFirstAttach = reject;
  });
  void firstAttachReady.catch(() => undefined);
  const settleFirstAttach = (): void => {
    if (firstAttachSettled) return;
    firstAttachSettled = true;
    resolveFirstAttach();
  };
  const failFirstAttach = (error: Error): void => {
    if (firstAttachSettled) return;
    firstAttachSettled = true;
    rejectFirstAttach(error);
  };

  // ─── Correlation + subscription bookkeeping ──────────────────────────────────────────────────────
  let nextId = 0;
  const newId = (prefix: string) => `${prefix}-${++nextId}`;
  // `kind` (ADR-0049 invariant 5): a lost response on a MUTATION settles `outcome: "unknown"`, on a READ
  // `outcome: "not-dispatched"` (safe to repeat). Stamped at every `rpc` call site from {@link MUTATION_RPC_OPS}.
  const rpcPending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; kind: "read" | "mutation" }
  >();
  const initialPending = new Map<
    string,
    { resolve: (payload: LiveInitialPayload) => void; reject: (error: Error) => void }
  >();
  const diffHandlers = new Map<string, (diff: Omit<LiveDiffPayload, "queryId">) => void>();
  // Live subscriptions that have completed their initial snapshot (keyed by queryId) — re-issued through the
  // same subscribe machinery on a pipe swap so live queries re-establish (invariant 5; ADR-0041 re-attach).
  const activeSubscriptions = new Map<string, { resubscribe: () => void }>();
  // Resolvers for per-subscription `hydrated` promises, keyed by queryId. The worker posts
  // `live-hydrated` on the same port as the diff stream, strictly after the catch-up rows — so
  // resolution here guarantees the rows have already been applied by the materializer.
  const hydratedPending = new Map<string, () => void>();
  // Set once this tab detaches (explicit `stop()` OR a terminal `pagehide`). Guards NEW operations (they
  // reject at once) and lets `detachFromWorker` settle every outstanding promise — the port listener is torn
  // down on detach, so an unsettled `rpc`/`live-initial` waiter would otherwise hang forever (ADR-0040 P2).
  let detached = false;
  const detachError = () => new Error("[pgxsinkit] client detached — the tab released its worker attachment");

  // ─── Status + readiness ──────────────────────────────────────────────────────────────────────────
  const status: SyncRuntimeStatus = { phase: "booting", isRunning: false };
  let resolveReady!: () => void;
  // FIX 2: `ready` gains a reject path so a detach BEFORE initial sync settles it (an attached client stopped
  // pre-ready would otherwise leave `client.ready` / `client.start()` pending forever). Guarded below.
  let rejectReady!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  void ready.catch(() => undefined);
  let readyResolved = false;
  const readyGroups = new Set<string>();
  const groupWaiters = new Map<string, Array<() => void>>();

  // ─── Auth: push at attach + on notifyAuthChanged, answer pull-requests ────────────────────────────
  const pushToken = async () => {
    const token = options.getToken ? await options.getToken() : null;
    postBridgeMessage(currentDataPort(), codec, "token-push", token);
  };
  const answerPull = async (requestId: string) => {
    const token = options.getToken ? await options.getToken() : null;
    postBridgeMessage(currentDataPort(), codec, "token-response", { requestId, token });
  };

  // ─── Inbound message routing ─────────────────────────────────────────────────────────────────────
  const markReady = () => {
    if (readyResolved) return;
    readyResolved = true;
    resolveReady();
  };
  // Record a group as ready and settle any waiters — shared by the discrete `groupReady` edge and the
  // status snapshot's `status.groups` merge (ADR-0032 FIX 4), so a tab attaching after the edge fired
  // still resolves `client.groupReady(table)` off the snapshot it gets at attach.
  const markGroupReady = (groupKey: string) => {
    readyGroups.add(groupKey);
    const waiters = groupWaiters.get(groupKey);
    if (waiters) {
      groupWaiters.delete(groupKey);
      for (const resolve of waiters) resolve();
    }
  };
  const onEvent = (event: BridgeEvent) => {
    switch (event.kind) {
      case "status": {
        Object.assign(status, event.status);
        options.onStatusChange?.(event.status);
        // Match the in-process contract EXACTLY (ADR-0032 FIX 3): `ready` resolves ONLY from phase
        // "ready" (all eager groups caught up, or the syncEnabled:false path). `auth-needed`/`degraded`
        // do NOT resolve it — an engine stuck retrying auth keeps `ready` pending, as in-process.
        if (event.status.phase === "ready") markReady();
        // Late-attach group merge (ADR-0032 FIX 4): fold every already-ready group from the snapshot.
        for (const [groupKey, ready] of Object.entries(event.status.groups ?? {})) {
          if (ready) markGroupReady(groupKey);
        }
        break;
      }
      case "groupReady": {
        markGroupReady(event.groupKey);
        break;
      }
      case "milestone": {
        // Staged boot readiness (ADR-0041 stage 2): the engine crossed a background stage while this tab was
        // attached. Idempotent with the ack's late-attach fold — whichever observes it first wins.
        if (event.stage === "writeReady") settleWriteReady();
        else if (event.stage === "bootSettled") settleBootSettled();
        break;
      }
      case "milestone-error": {
        // The background write/sync tail rejected a downstream stage (ADR-0041): fail the matching stage so a
        // gated write / `bootSettled` awaiter fails loudly. `localReadReady` and the resolved attach are
        // unaffected — the engine reached local-read readiness before the tail failed.
        if (event.stage === "writeReady") failWriteReady(rebuildError(event.error));
        else if (event.stage === "bootSettled") failBootSettled(rebuildError(event.error));
        break;
      }
      case "conflict":
        options.onConflict?.(event.details as MutationDetail[]);
        break;
      case "quarantine":
        options.onQuarantine?.(event.details as MutationDetail[]);
        break;
      case "reject":
        options.onReject?.(event.details as MutationDetail[]);
        break;
      case "schema-change":
        options.onSchemaChange?.(event.event as LocalStoreVersionEvent);
        break;
      case "sync-error":
        options.onSyncError?.(new Error(event.message));
        break;
      case "boot-report":
        // Boot observability (ADR-0034): the one-shot push for a tab attached at finalize. A late tab never
        // gets this event and pulls the report via `client.bootReport()` instead.
        options.onBootReport?.(event.report);
        break;
      case "debug": {
        // Re-print the worker's rail line gated on THIS tab's own flag, origin-tagged with the worker's
        // monotonic stamp (ADR-0032 decision 7) — a SharedWorker's own console is otherwise invisible.
        if ((globalThis as { __pgxsinkitDebug?: boolean }).__pgxsinkitDebug === true) {
          const line = `[pgxsinkit·w ${event.stamp.toFixed(0)}ms] ${event.line}`;
          if (event.data) console.debug(line, event.data);
          else console.debug(line);
        }
        break;
      }
      case "timing":
        break;
      default:
        break;
    }
  };

  const listener = (message: { data: unknown }) => {
    if (!isBridgeEnvelope(message.data)) return;
    // Any bridge traffic on the data port proves the engine is answering — clears the bridge-silence suspicion
    // (ADR-0049 D5), so a live-but-slow engine is never mistaken for a dead SharedWorker.
    bridgeSeenSinceArm = true;
    const envelope = message.data;
    const payload = codec.decode(envelope.payload);
    switch (envelope.type) {
      case "attach-ack": {
        const ack = payload as AttachAckPayload;
        // A LOCAL-READ-CORE boot failure crosses in the ack's `error` (ADR-0032 FIX 1): reject the handshake
        // so `attachSyncClient` rejects instead of hanging forever. On success, the engine reached
        // `localReadReady` — resolve that stage now (the ack fires AT localReadReady, ADR-0041 Option B) and
        // fold any downstream milestones/failures the tail already crossed (a late attach). `engineReady`
        // covers a LATE attach whose engine already fired its monotonic `ready` before this ack (FIX 3).
        if (ack.error) {
          const settle = pendingAttachAck;
          pendingAttachAck = null;
          const bootError = rebuildError(ack.error);
          settle?.reject(bootError);
          // A boot-failure ack on the FIRST attach (SW-direct) fails `attachSyncClient` (invariant: never hand out
          // a client whose engine failed to boot); a no-op once the first attach already settled (a re-attack ack).
          failFirstAttach(bootError);
        } else {
          if (ack.engineReady) markReady();
          resolveLocalReadReady();
          // Late-attach milestone fold: the stage may have already crossed (or failed) before this tab
          // attached, in which case there is no broadcast to catch — settle it straight from the ack.
          if (ack.writeReady) settleWriteReady();
          if (ack.writeReadyError) failWriteReady(rebuildError(ack.writeReadyError));
          if (ack.bootSettled) settleBootSettled();
          if (ack.bootSettledError) failBootSettled(rebuildError(ack.bootSettledError));
          const settle = pendingAttachAck;
          pendingAttachAck = null;
          settle?.resolve(ack);
          // The first attach ack from EITHER home (SW-direct engine, or the elected engine over the pipe) resolves
          // `attachSyncClient`. Idempotent — a re-attach ack (pipe swap / reconnect) is a no-op here.
          settleFirstAttach();
        }
        break;
      }
      case "token-request":
        void answerPull((payload as TokenRequestPayload).requestId);
        break;
      case "rpc-result": {
        const id = envelope.id;
        if (id == null) break;
        const result = payload as RpcResultPayload;
        const pending = rpcPending.get(id);
        if (pending) {
          rpcPending.delete(id);
          clearOverdue(id);
          if (result.ok) pending.resolve(result.value);
          else pending.reject(rebuildRpcError(result.error));
          break;
        }
        // A failed `subscribe` is reported as an `rpc-result` correlated by the subscribe's envelope id
        // (the worker has no client to hand an initial snapshot), so route the miss to the initial waiter
        // (ADR-0032 FIX 2). A successful subscribe never lands here — it resolves via `live-initial`.
        const initial = initialPending.get(id);
        if (initial && !result.ok) {
          initialPending.delete(id);
          initial.reject(rebuildRpcError(result.error));
        }
        break;
      }
      case "live-initial": {
        const id = envelope.id;
        const initial = payload as LiveInitialPayload;
        if (id != null) {
          const pending = initialPending.get(id);
          if (pending) {
            initialPending.delete(id);
            pending.resolve(initial);
          }
        }
        break;
      }
      case "live-diff": {
        const diff = payload as LiveDiffPayload;
        diffHandlers.get(diff.queryId)?.(diff);
        break;
      }
      case "live-hydrated": {
        const { queryId } = payload as LiveHydratedPayload;
        hydratedPending.get(queryId)?.();
        hydratedPending.delete(queryId);
        break;
      }
      case "event":
        onEvent(payload as BridgeEvent);
        break;
      default:
        break;
    }
  };
  // ─── ADR-0049 control-plane listener (the `{ pgx0049 }` envelope) ─────────────────────────────────
  // Lives on the CONTROL port for this tab's whole lifetime. It reacts to exactly the placement messages: a
  // `connect-port` (with a transferred pipe) swaps the data path; a `leader-granted`/`engine-retiring` notice
  // opens the handoff window. Foreign traffic (data-path bridge envelopes, anything else) is untouched — the
  // control plane is INERT until pgx0049 traffic arrives, so a plain SW-port attach is pure data-path passthrough.
  const controlListener = (event: { data: unknown; ports?: readonly BridgePort[] }) => {
    // ADR-0049 step 10b: the SharedWorker's RAW placement reply + destroy peer-count verdict (distinct envelope
    // keys, NOT `pgx0049` control messages). Handle those first, then fall through to the control envelope.
    const placementResult = readPlacementResult(event.data);
    if (placementResult !== undefined) {
      onPlacementResult(placementResult);
      return;
    }
    const destroyPeers = readDestroyVerdict(event.data);
    if (destroyPeers !== undefined) {
      destroyVerdictResolver?.(destroyPeers);
      return;
    }
    const control = readControlEnvelope(event.data);
    if (control === undefined) return;
    switch (control.type) {
      case "connect-port":
        void onConnectPort(control.identity, event.ports?.[0]);
        break;
      case "control-ack":
        if (
          control.pingId === -1 &&
          swTeardownIdentity !== undefined &&
          engineIdentityEquals(control.identity, swTeardownIdentity)
        ) {
          swTeardownAckResolver?.(control.error);
        }
        break;
      case "leader-granted":
      case "engine-retiring":
        onRelocationNotice(control);
        break;
      default:
        break;
    }
  };

  // The bridge listener starts on the data port (initially === the control port); the control listener stays on
  // the control port. In the no-pgx0049 case both sit on the one `port` and coexist (each ignores the other's
  // traffic), so the data path is unchanged.
  dataPort.addEventListener("message", listener);
  dataPort.start?.();
  controlPort.addEventListener("message", controlListener);
  controlPort.start?.();

  // ─── Data-port swap + handoff-queue + reconnect machinery (ADR-0049) ──────────────────────────────
  /** Move the bridge listener onto `next`; close the previous pipe when replacing one (never the control port). */
  const swapDataPort = (next: BridgePort, closePrev: boolean): void => {
    const prev = dataPort;
    if (prev === next) return;
    next.addEventListener("message", listener);
    next.start?.();
    prev.removeEventListener("message", listener);
    // The control port keeps carrying `{ pgx0049 }` and MUST NOT be closed on the first swap; a replaced pipe is
    // dead and IS closed (invariant 5 — old-pipe pendings settled, the pipe closed, never replayed).
    if (closePrev && prev !== controlPort) prev.close?.();
    dataPort = next;
  };

  /**
   * Settle EVERY in-flight pending op by outcome (ADR-0049 invariant 5) — used on a relocation notice, a pipe
   * replacement, and a reconnect. A MUTATION whose response is lost is `"unknown"` (its journal update may
   * exist; inspect/reconcile, never auto-retry); a dispatched READ is `"not-dispatched"` — the name means
   * "safe to retry" (a read cannot double-apply; ADR-0049 D10: "dispatched reads are safe to repeat — caller
   * policy"). Live-query initial pendings are reads → `"not-dispatched"`; `hydrated` promises are doneness
   * signals with no reject path, so they RESOLVE (the file's existing convention on teardown), and re-subscribe
   * re-hydrates. Nothing is ever auto-retried here.
   */
  const settleInFlight = (): void => {
    for (const [id, pending] of rpcPending) {
      rpcPending.delete(id);
      clearOverdue(id);
      pending.reject(new EngineRelocatedError(pending.kind === "mutation" ? "unknown" : "not-dispatched"));
    }
    for (const [id, pending] of initialPending) {
      initialPending.delete(id);
      pending.reject(new EngineRelocatedError("not-dispatched"));
    }
    for (const resolve of hydratedPending.values()) resolve();
    hydratedPending.clear();
  };

  const clearQueueDeadline = (): void => {
    if (queueDeadlineHandle !== undefined) {
      timers.clearTimeout(queueDeadlineHandle);
      queueDeadlineHandle = undefined;
    }
  };
  const armQueueDeadline = (): void => {
    if (queueDeadlineHandle !== undefined) return;
    queueDeadlineHandle = timers.setTimeout(() => {
      queueDeadlineHandle = undefined;
      // The window outlived the deadline — the queued work never left the tab, so fail it "not-dispatched".
      const items = handoffQueue.splice(0);
      for (const item of items) item.reject(new EngineRelocatedError("not-dispatched"));
    }, queueDeadlineMs);
  };
  /** Enqueue a deferred data-path op while the window is open; cap overflow fails it "not-dispatched" at once. */
  const enqueue = (dispatch: () => void, reject: (error: Error) => void): void => {
    if (handoffQueue.length >= queueCap) {
      reject(new EngineRelocatedError("not-dispatched"));
      return;
    }
    handoffQueue.push({ dispatch, reject });
    armQueueDeadline();
  };
  /** Flush the queue in order after a successful re-attach; clears the deadline. */
  const flushQueue = (): void => {
    clearQueueDeadline();
    const items = handoffQueue.splice(0);
    for (const item of items) item.dispatch();
  };

  const resubscribeAll = (): void => {
    for (const sub of activeSubscriptions.values()) sub.resubscribe();
  };

  /** A relocation notice opens the handoff window: settle in-flight per invariant 5, then QUEUE new calls. */
  function onRelocationNotice(control: EngineControlMessage): void {
    if (detached) return;
    // `engine-retiring` is identity-tagged: ignore a STALE one (a superseded engine) once we have an identity;
    // `leader-granted` is untagged and always applies (it precedes any engine).
    if (
      control.type === "engine-retiring" &&
      currentEngineIdentity !== undefined &&
      isStaleIdentity(currentEngineIdentity, control.identity)
    ) {
      return;
    }
    if (windowOpen) return;
    windowOpen = true;
    settleInFlight();
    armQueueDeadline();
  }

  /**
   * A `connect-port` delivers a transferred pipe (invariant 6). The FIRST one swaps the data path off the
   * control port and re-attaches over the pipe. A SUBSEQUENT one under a NEWER identity is a pipe REPLACEMENT
   * (a new SharedWorker handing fresh pipes): settle old-pipe in-flight, close the old pipe, swap, re-attach,
   * flush the queue, and re-subscribe every live query.
   */
  async function onConnectPort(identity: EngineIdentity, pipe: BridgePort | undefined): Promise<void> {
    if (detached || pipe === undefined) return;
    // A duplicate for the SAME identity we already piped is a no-op (never re-pipe the same engine).
    if (currentEngineIdentity !== undefined && engineIdentityEquals(currentEngineIdentity, identity)) return;
    const replacing = hasPipe;
    // Hold the window open across the swap+handshake so calls issued mid-flight queue rather than race.
    windowOpen = true;
    if (replacing) settleInFlight();
    currentEngineIdentity = identity;
    swapDataPort(pipe, replacing);
    hasPipe = true;
    try {
      // `includeRestore: true` — in elected mode THIS is the engine's boot attach, so the restore artifact
      // (withheld from the router-dropped SW-port handshake) rides here, over the direct tab↔engine pipe.
      // The `restoreConsumed` guard makes it first-carry-only: a pipe REPLACEMENT re-attach never re-sends.
      await runAttachHandshake(pipe, true);
    } catch {
      // A failed re-attach leaves the window open; a later notice / connect-port can retry. Never auto-retried.
      return;
    }
    windowOpen = false;
    flushQueue();
    resubscribeAll();
  }

  /** Arm the bridge-silence timer after a dispatch (D5) — only when a deadline AND a SharedWorker factory exist. */
  const armSilence = (): void => {
    if (options.bridgeSilenceMs === undefined || workerFactory === undefined) return;
    if (silenceHandle !== undefined || detached) return;
    bridgeSeenSinceArm = false;
    silenceHandle = timers.setTimeout(() => {
      silenceHandle = undefined;
      if (detached) return;
      // A pending op survived the deadline with NO bridge traffic since it was posted → the transport looks
      // dead. Reconnect ONCE. If traffic WAS seen but ops are still pending, re-arm (a slow-but-live engine).
      if (!bridgeSeenSinceArm && rpcPending.size > 0) void reconnect();
      else if (rpcPending.size > 0) armSilence();
    }, options.bridgeSilenceMs);
  };

  /**
   * ONE bridge-silence reconnect attempt (ADR-0049 D5): construct a fresh SharedWorker via the worker FACTORY, move
   * both listeners to its port, settle the presumed-dead transport's in-flight per invariant 5, re-run the attach
   * handshake, then flush + re-subscribe. With a bare-instance input (no factory) this is unreachable — reconstruction
   * is structurally unavailable. Never more than one concurrent attempt.
   */
  async function reconnect(): Promise<void> {
    if (reconnecting || detached || workerFactory === undefined) return;
    reconnecting = true;
    let newPort: BridgePort;
    try {
      newPort = resolvePort({ worker: workerFactory });
    } catch {
      reconnecting = false;
      return;
    }
    settleInFlight();
    dataPort.removeEventListener("message", listener);
    controlPort.removeEventListener("message", controlListener);
    controlPort = newPort;
    dataPort = newPort;
    hasPipe = false;
    currentEngineIdentity = undefined;
    windowOpen = true;
    newPort.addEventListener("message", listener);
    newPort.addEventListener("message", controlListener);
    newPort.start?.();
    try {
      await runAttachHandshake(newPort, false);
    } catch {
      reconnecting = false;
      return;
    }
    windowOpen = false;
    flushQueue();
    resubscribeAll();
    reconnecting = false;
  }

  // ─── ADR-0049 election wiring + supervised destroy ────────────────────────────────────────────────
  /** The store PATH this tab owns — the identity every store-IO surface (OPFS namespaces, meta record, idb db, leader lock) derives from. */
  const resolveDestroyStorePath = (): string => options.storePath ?? options.storeId ?? "pgxsinkit-overlay-v1";
  // The elected engine worker factory for THIS attach (ADR-0049 D5): the `createEngineWorker` OVERRIDE, else the
  // default derived from the SharedWorker's reported script URL (`new Worker(url, { type: "module" })`). Resolved on
  // the `electionRequired` reply; `undefined` means neither is available — a WIRING failure, not a fallback.
  let electedEngineFactory: (() => ElectedEngineWorker) | undefined;

  /**
   * The SharedWorker reported the engine home. In `elected-worker` (router-only) mode this tab must elect its own
   * engine: resolve the engine factory (the `createEngineWorker` override, else the URL-derived default), build the
   * coordinator (once), and take one attach claim. When NEITHER a derivable URL NOR an override is available the
   * engine is genuinely unconstructible on a handle-denied home — a WIRING failure, so the attach fails with the
   * typed {@link ElectedEngineUnconstructibleError} (never a silent no-engine attach). `shared-worker` (SW-direct /
   * declared-idbfs) needs no election.
   */
  function onPlacementResult(result: PlacementQueryResult): void {
    if (detached || placementDecided) return;
    placementDecided = true;
    placementResult = result;
    resolvePlacementKnown?.();
    // SW-direct / declared-idbfs (or a non-placement transport that never replies): the SW-port attach ack gates the flow.
    if (!result.electionRequired) return;
    // Elected-worker (router-only): resolve the engine factory. Auto-derivation from the reported script URL is the
    // default (dual-scope entry); the `createEngineWorker` override wins where an entry is not URL-reconstructible.
    electedEngineFactory = options.createEngineWorker ?? deriveEngineWorkerFactory(result.swScriptUrl);
    if (electedEngineFactory === undefined) {
      // The capability is PRESENT (this home requires election) but the engine cannot be constructed — a wiring
      // defect. Fail the attach typed; never a silent no-engine attach and never a storage downgrade (ADR-0049 D1).
      failFirstAttach(
        new ElectedEngineUnconstructibleError(
          result.swScriptUrl === undefined
            ? "the SharedWorker reported no derivable script URL and no `createEngineWorker` override was supplied"
            : "no `Worker` constructor is available in this scope to derive the module engine and no override was supplied",
        ),
      );
      return;
    }
    // ADOPT an existing PROVISION grant for this store if one is registered (ADR-0049 step 8, fault row
    // "provision then attach, same tab → attach adopts the provision grant; never self-queued"): reuse the same
    // coordinator + its already-granted lock + already-spawned engine — `claimForAttach` adds NO second lock
    // request and spawns NO second engine (invariant 2). The router pipes this tab's OWN connection to that engine
    // and the boot adopts the provisioned store (no double initdb). Absent → build this tab's own coordinator.
    const storePath = resolveDestroyStorePath();
    const adopted = lookupSharedCoordinator(storePath);
    if (adopted !== undefined) {
      retainSharedCoordinator(storePath);
      adoptedSharedCoordinatorStore = storePath;
      electionCoordinator = adopted;
    } else {
      electionCoordinator = buildElectionCoordinator();
    }
    releaseElectionClaim = electionCoordinator.claimForAttach();
    // Provision-pipe HANDOVER (ADR-0049 step 8): when this attach shares its SW port with the provision that
    // registered the adopted coordinator, the router's one-and-only pipe for this connection was already
    // delivered during provisioning — feed it into the normal connect-port path instead of waiting for a
    // re-send that never comes. On a fresh (non-shared) port the stash is empty and the router's ordinary
    // late-joiner `connect-port` drives the handshake as usual.
    if (adopted !== undefined) {
      const stashed = takeProvisionPipe(storePath);
      if (stashed !== undefined) void onConnectPort(stashed.identity, stashed.pipe);
    }
  }

  /**
   * SW-direct stores are owned by the in-scope host, not an elected coordinator. Ask that host to quiesce and
   * close, then await its reserved teardown ack before detaching this tab and deleting the store. A timeout is
   * deliberately not treated as proof of worker death: destruction still runs and its bounded ownership retry
   * reports an honest failure while the durable `deleting` phase remains recoverable.
   */
  const awaitSharedHostTeardown = async (): Promise<void> => {
    const placement = placementResult;
    if (placement?.engineHome !== "shared-worker") return;
    const identity: EngineIdentity = { swInstanceId: placement.swInstanceId, generation: 0 };
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timeout = timers.setTimeout(() => {
        if (settled) return;
        settled = true;
        swTeardownAckResolver = undefined;
        swTeardownIdentity = undefined;
        resolve();
      }, 5_000);
      swTeardownIdentity = identity;
      swTeardownAckResolver = (error) => {
        if (settled) return;
        settled = true;
        timers.clearTimeout(timeout);
        swTeardownAckResolver = undefined;
        swTeardownIdentity = undefined;
        if (error) reject(new Error(`[pgxsinkit] SW-direct host teardown failed: ${error.message}`));
        else resolve();
      };
      controlPort.postMessage(wrapControlEnvelope({ type: "engine-teardown", identity }));
    });
  };

  /**
   * Construct the tab's election coordinator over the SW control port. The spawn adapter creates the announce
   * control channel and delivers its ENGINE end (`port2`) to the freshly-spawned worker (fixing step-8's
   * "port2 went nowhere"); `createControlChannel` then returns the SAME channel so the coordinator's `announce`
   * transfers the ROUTER end (`port1`) to the SharedWorker. `navigator.locks` is read structurally (injectable
   * for tests); the page-lifecycle subscription is the real `pagehide`/`pageshow` (also injectable).
   */
  function buildElectionCoordinator(): ElectionCoordinator {
    return buildElectedCoordinator({
      storePath: resolveDestroyStorePath(),
      controlPort,
      createEngineWorker: electedEngineFactory!,
      ...(workerFactory ? { swFactory: workerFactory } : {}),
      ...(options.electionIo ? { electionIo: options.electionIo } : {}),
      ...(options.awaitOwnershipRelease ? { awaitOwnershipRelease: options.awaitOwnershipRelease } : {}),
      timers,
      ...(pageLifecycle ? { pageLifecycle } : {}),
      ...(options.keepaliveIntervalMs != null ? { keepaliveIntervalMs: options.keepaliveIntervalMs } : {}),
      ...(options.keepaliveMissThreshold != null ? { keepaliveMissThreshold: options.keepaliveMissThreshold } : {}),
    });
  }

  /** Ask the SharedWorker how many tabs are attached (this one included) — the destroy peer-refusal gate. */
  const queryDestroyPeers = (): Promise<number> =>
    new Promise<number>((resolve, reject) => {
      const timeout = timers.setTimeout(() => {
        destroyVerdictResolver = undefined;
        reject(new Error("[pgxsinkit] destroy() timed out waiting for the SharedWorker peer-count verdict."));
      }, options.handoffQueue?.deadlineMs ?? 15000);
      destroyVerdictResolver = (peers) => {
        timers.clearTimeout(timeout);
        destroyVerdictResolver = undefined;
        resolve(peers);
      };
      controlPort.postMessage({ [DESTROY_QUERY_KEY]: true });
    });

  // ─── ADR-0049 D5: execution-limit OVERDUE-DISPATCH reporting (tab side) ────────────────────────────
  // When `executionLimit.maxDispatchMs` is set and this tab holds a per-tab pipe (elected engine), a dispatched
  // RPC still pending past the limit is reported ONCE to the router as an identity-tagged `overdue-dispatch`. The
  // router then probes the engine control channel; a WASM-blocked engine cannot answer on its event loop, so the
  // router (past its probe threshold) fans `engine-retiring` and the leader terminates + respawns it. The router
  // NEVER treats slow-below-threshold as death (a long query under the limit runs to completion). Per-id timers,
  // cleared on settlement; reported on the CONTROL port (where the router listens), stamped with the current
  // engine identity so the router discards a stale report. SW-direct has no pipe/identity, so it never arms.
  const overdueMs = options.executionLimit?.maxDispatchMs;
  const overdueTimers = new Map<string, unknown>();
  const clearOverdue = (id: string): void => {
    const handle = overdueTimers.get(id);
    if (handle !== undefined) {
      timers.clearTimeout(handle);
      overdueTimers.delete(id);
    }
  };
  const clearAllOverdue = (): void => {
    for (const handle of overdueTimers.values()) timers.clearTimeout(handle);
    overdueTimers.clear();
  };
  const armOverdue = (id: string): void => {
    if (overdueMs === undefined) return;
    overdueTimers.set(
      id,
      timers.setTimeout(() => {
        overdueTimers.delete(id);
        // Report only while the op is genuinely still outstanding on a live pipe (we know the engine identity).
        if (detached || !rpcPending.has(id) || currentEngineIdentity === undefined) return;
        controlPort.postMessage(
          wrapControlEnvelope({
            type: "overdue-dispatch",
            identity: currentEngineIdentity,
            elapsedMs: overdueMs,
          }),
        );
      }, overdueMs),
    );
  };

  // ─── RPC helper ──────────────────────────────────────────────────────────────────────────────────
  const rpc = <T>(op: RpcOp, args: unknown[]): Promise<T> => {
    // A detached client has no live port listener, so a worker reply could never resolve this — reject at
    // once rather than register a forever-pending waiter (ADR-0040 P2).
    if (detached) return Promise.reject(detachError());
    const kind: "read" | "mutation" = MUTATION_RPC_OPS.has(op) ? "mutation" : "read";
    return new Promise<T>((resolve, reject) => {
      const dispatch = () => {
        const id = newId("rpc");
        rpcPending.set(id, { resolve: resolve as (value: unknown) => void, reject, kind });
        postBridgeMessage(currentDataPort(), codec, "rpc", { op, args }, id);
        armSilence();
        armOverdue(id);
      };
      // While the handoff window is open, QUEUE rather than post (invariant 9); otherwise dispatch immediately.
      if (windowOpen) enqueue(dispatch, reject);
      else dispatch();
    });
  };

  // ─── Attach handshake ────────────────────────────────────────────────────────────────────────────
  // Re-entrant (ADR-0049): the SAME handshake runs for the FIRST attach and for every re-attach (pipe swap,
  // reconnect). `pendingAttachAck` holds whichever handshake is currently awaiting its `attach-ack`; the bridge
  // listener settles it. `runAttachHandshake` posts `attach` over a target port and awaits the ack.
  let pendingAttachAck: { resolve: (ack: AttachAckPayload) => void; reject: (error: Error) => void } | null = null;
  const runAttachHandshake = (target: BridgePort, includeRestore: boolean): Promise<AttachAckPayload> =>
    new Promise<AttachAckPayload>((resolve, reject) => {
      // The restore artifact rides at most ONE handshake ever (`restoreConsumed`): posting transfers (detaches)
      // its ArrayBuffer, so any later handshake would carry an empty husk. The caller chooses the target that
      // actually reaches the engine home; this guard makes a second carry structurally impossible.
      const carryRestore = includeRestore && restoreWire !== undefined && !restoreConsumed;
      if (carryRestore) restoreConsumed = true;
      pendingAttachAck = { resolve, reject };
      postBridgeMessage(
        target,
        codec,
        "attach",
        buildAttachPayload(carryRestore),
        undefined,
        carryRestore && restoreWire ? [restoreWire.buffer] : undefined,
      );
    });

  // ADR-0041 stage 2 — staged boot readiness on the worker-attached client. The `attach-ack` fires AT the
  // engine's `localReadReady` (the Option B contract), so this client resolves `attachSyncClient` there and
  // `localReadReady` is settled off the ack. `writeReady`/`bootSettled` cross in the engine's background tail:
  // they resolve off the `milestone` broadcast when this tab is attached as the stage fires, OR off the ack's
  // late-attach fold when the stage had already fired before this tab attached — one engine crosses each stage
  // once, so both routes observe the same monotonic sequence. A tail failure rejects the matching stage via
  // the `milestone-error` broadcast / the ack's stage-error fold, so a gated write or a `bootSettled` awaiter
  // fails loudly rather than hanging. All guarded so a rejection on an unconsumed stage is never unhandled.
  let resolveLocalReadReady!: () => void;
  const localReadReady = new Promise<void>((resolve) => {
    resolveLocalReadReady = resolve;
  });
  let resolveWriteReady!: () => void;
  let rejectWriteReady!: (error: unknown) => void;
  const writeReady = new Promise<void>((resolve, reject) => {
    resolveWriteReady = resolve;
    rejectWriteReady = reject;
  });
  let resolveBootSettled!: () => void;
  let rejectBootSettled!: (error: unknown) => void;
  const bootSettled = new Promise<void>((resolve, reject) => {
    resolveBootSettled = resolve;
    rejectBootSettled = reject;
  });
  void localReadReady.catch(() => undefined);
  void writeReady.catch(() => undefined);
  void bootSettled.catch(() => undefined);
  // Idempotent settlers — a stage may be signalled by BOTH the ack fold and a milestone event (or by a
  // detach), and must settle exactly once. `localReadReady` never rejects (a local-read-core failure rejects
  // the attach handshake instead, so this client is never handed out).
  let writeReadySettled = false;
  let bootSettledSettled = false;
  const settleWriteReady = () => {
    if (writeReadySettled) return;
    writeReadySettled = true;
    resolveWriteReady();
  };
  const failWriteReady = (error: unknown) => {
    if (writeReadySettled) return;
    writeReadySettled = true;
    rejectWriteReady(error);
  };
  const settleBootSettled = () => {
    if (bootSettledSettled) return;
    bootSettledSettled = true;
    resolveBootSettled();
  };
  const failBootSettled = (error: unknown) => {
    if (bootSettledSettled) return;
    bootSettledSettled = true;
    rejectBootSettled(error);
  };

  // ─── Detach (explicit stop AND page teardown) ──────────────────────────────────────────────────────
  // The platform fires NO close event on a SharedWorker port — a tab that simply closes would leave its
  // subscriptions (and their per-write rerun cost) alive in the worker for the worker's whole lifetime
  // (ADR-0040 decision 1; surfaced by the two-tab board e2e). So the same detach runs from `stop()` AND from
  // `pagehide` with `persisted === false` — the terminal signal of a real close/navigate-away. A
  // bfcache-parked page (`persisted === true`) keeps its attachment: its port survives parking and resumes
  // on restore, so detaching there would strand the restored page. Idempotent — pagehide then stop is safe.
  //
  // Installed BEFORE the attach handshake is posted/awaited (ADR-0040 P2): a tab that closes DURING a slow
  // worker boot must still send `detach` and reject the pending attach-ack, rather than leaving the worker
  // holding stale port/token bookkeeping for a page that is already gone. Pre-ack every pending map below is
  // empty, so the settlement loops are no-ops except for the attach-ack rejection.
  const detachFromWorker = (): void => {
    if (detached) return;
    detached = true;
    status.isRunning = false;
    // Detach THIS tab; the worker engine keeps running for other tabs (ADR-0032 decision 2). Sent on the
    // CURRENT data port (ADR-0049: the pipe once swapped, else the control port).
    for (const queryId of diffHandlers.keys()) postBridgeMessage(currentDataPort(), codec, "unsubscribe", { queryId });
    diffHandlers.clear();
    activeSubscriptions.clear();
    postBridgeMessage(currentDataPort(), codec, "detach", null);
    // ADR-0049 D8: tell the SharedWorker ROUTER this tab is gone, on the CONTROL port — the `detach` above rode
    // the per-tab PIPE, which the router never sees, so its `tabCount` (the destroy peer-refusal input) would
    // otherwise never fall. A `pgx0049` control envelope (the router stays payload-blind); harmless on a
    // non-placement transport (ignored) and when the control port IS the data port (SW-direct).
    controlPort.postMessage(wrapControlEnvelope({ type: "tab-detach" }));
    // Settle every tab-side promise now the port listener is about to go (ADR-0040 P2) — otherwise an
    // operation still awaiting a worker reply hangs forever. RPCs and initial subscribes promise DATA, so
    // REJECT them (fabricating a value is worse than a clear failure); hydration and group-ready waiters are
    // DONENESS signals, so RESOLVE them (their awaiters are void-chained hook code that should settle, not
    // throw). The attach-ack is rejected too so a detach DURING boot rejects `attachSyncClient` (a no-op once
    // it has already settled).
    const settleAttachAck = pendingAttachAck;
    pendingAttachAck = null;
    settleAttachAck?.reject(detachError());
    // ADR-0041 (FIX A): reject EVERY still-pending readiness STAGE with ONE typed `ClientDisposedError`, so
    // `instanceof ClientDisposedError` behaves identically in worker and in-process mode (the class doc + the
    // in-process client already promise the typed error on disposal). `detachError()` stays for RPC/subscription
    // rejections below, where the more specific "client detached" message is useful for a data operation.
    // `localReadReady` is left as-is: pre-ack it never resolved (the attach itself rejected); post-ack it already
    // resolved. The `milestone-error` path is untouched — that is a genuine engine failure, not disposal.
    const disposedError = new ClientDisposedError();
    // ADR-0049: a detach BEFORE the first attach ack settles fails `attachSyncClient` (a detach-during-boot rejects
    // the attach rather than leaving it pending) — with the SAME "client detached" error the pre-firstAttachReady
    // handshake rejection used, preserving the ADR-0040 P2 contract (idempotent once the attach already resolved).
    failFirstAttach(detachError());
    failWriteReady(disposedError);
    failBootSettled(disposedError);
    // The attached `ready` had NO reject path — a detach BEFORE initial sync would otherwise leave
    // `client.ready` / `client.start()` pending forever. Settle it once with the same disposed error.
    if (!readyResolved) {
      readyResolved = true;
      rejectReady(disposedError);
    }
    for (const pending of rpcPending.values()) pending.reject(detachError());
    rpcPending.clear();
    clearAllOverdue();
    for (const pending of initialPending.values()) pending.reject(detachError());
    initialPending.clear();
    for (const resolve of hydratedPending.values()) resolve();
    hydratedPending.clear();
    for (const waiters of groupWaiters.values()) for (const resolve of waiters) resolve();
    groupWaiters.clear();
    // ADR-0049: queued handoff ops settle with the detach error (rule 5), and the placement timers are cleared.
    const queued = handoffQueue.splice(0);
    for (const item of queued) item.reject(detachError());
    clearQueueDeadline();
    // ADR-0049 step 10b: release this tab's leader-lock claim (invariant 2 — one claim per attachment, released
    // on detach). Idempotent; a no-op when this tab never elected (SW-direct / no factory).
    releaseElectionClaim?.();
    releaseElectionClaim = undefined;
    // Release this tab's ref on an ADOPTED shared coordinator (ref-counted registry cleanup); no-op otherwise.
    if (adoptedSharedCoordinatorStore !== undefined) {
      releaseSharedCoordinator(adoptedSharedCoordinatorStore);
      adoptedSharedCoordinatorStore = undefined;
    }
    if (silenceHandle !== undefined) {
      timers.clearTimeout(silenceHandle);
      silenceHandle = undefined;
    }
    if (pagehideListener) pageWindow?.removeEventListener("pagehide", pagehideListener);
    // Tear down BOTH listeners: the bridge listener on the data port, the control listener on the control port.
    dataPort.removeEventListener("message", listener);
    controlPort.removeEventListener("message", controlListener);
    dataPort.close?.();
    if (controlPort !== dataPort) controlPort.close?.();
  };
  // Structural window guard — this file compiles without the DOM lib (it also runs under tests/workers).
  interface PageLifecycleWindowLike {
    addEventListener(type: "pagehide" | "pageshow", handler: (event: { persisted: boolean }) => void): void;
    removeEventListener(type: "pagehide" | "pageshow", handler: (event: { persisted: boolean }) => void): void;
  }
  const pageWindow = (globalThis as { window?: PageLifecycleWindowLike }).window;
  const pagehideListener = pageWindow
    ? (event: { persisted: boolean }) => {
        if (!event.persisted) detachFromWorker();
      }
    : undefined;
  if (pagehideListener) pageWindow?.addEventListener("pagehide", pagehideListener);
  // ADR-0049 step 10b: the real page-lifecycle subscription the election coordinator's BFCache hooks use
  // (`pagehide.persisted` → release authority + retire; `pageshow` → re-queue + re-attach). Structural window
  // check, exactly like the detach `pagehide` above; injectable (`electionIo.pageLifecycle`) for tests.
  const pageLifecycle: CoordinatorDeps["pageLifecycle"] =
    options.electionIo?.pageLifecycle ??
    (pageWindow
      ? {
          onPageHide: (listener) => pageWindow.addEventListener("pagehide", (event) => listener(event.persisted)),
          onPageShow: (listener) => pageWindow.addEventListener("pageshow", () => listener()),
        }
      : undefined);

  const initialToken = options.getToken ? await options.getToken() : null;
  // The testing memory-backend override travels as an explicit wire field, not the symbol marker — a symbol
  // does not survive `postMessage` structured clone (ADR-0036). Read it off the spread helper's options here.
  const memoryOverride = readTestStoreMarker(options) === "memory";
  // Restore (ADR-0035 decision 6): a `File`/`Blob` cannot cross as a transferable, so decompose it into a
  // zero-copy `ArrayBuffer` + name/mime (the `ExportArtefactWire` pattern in reverse) and list the buffer on
  // the attach `postMessage`'s transfer list. Read the bytes BEFORE building the payload (async).
  const restoreWire: RestoreArtefactWire | undefined = options.restoreFrom
    ? {
        buffer: await options.restoreFrom.arrayBuffer(),
        fileName: options.restoreFrom instanceof File ? options.restoreFrom.name : "restore.pgdata.tar",
        mimeType: options.restoreFrom.type || "application/octet-stream",
      }
    : undefined;
  // The attach payload builder — reused by the FIRST attach and every re-attach (pipe swap / reconnect). Restore
  // rides ONLY the one handshake that reaches the engine home (SW port in SW-direct, first pipe attach when
  // elected — see the send sites); `runAttachHandshake`'s `restoreConsumed` guard makes any later carry
  // structurally impossible (the buffer is transferred/detached, and you cannot restore into a running store).
  function buildAttachPayload(includeRestore: boolean): AttachPayload {
    return {
      token: initialToken,
      ...(options.storeId ? { storeId: options.storeId } : {}),
      ...(options.storePath ? { storePath: options.storePath } : {}),
      ...(memoryOverride ? { testStoreBackend: "memory" as const } : {}),
      ...(options.executionLimit ? { executionLimit: options.executionLimit } : {}),
      ...(includeRestore && restoreWire ? { restore: restoreWire } : {}),
      ...(options.syncEnabled != null || options.role != null || options.freshStore != null
        ? {
            config: {
              ...(options.syncEnabled != null ? { syncEnabled: options.syncEnabled } : {}),
              ...(options.role != null ? { role: options.role } : {}),
              ...(options.freshStore != null ? { freshStore: options.freshStore } : {}),
            },
          }
        : {}),
    };
  }
  // ─── ADR-0049 placement-query-FIRST attach ordering (elected-mode deadlock fix) ───────────────────
  // Post the placement query BEFORE the attach handshake. A router-only SharedWorker (elected-worker home) is
  // payload-blind and DROPS the bridge `attach`, so an SW-port ack would never come there and could never gate
  // the flow — but the bootstrap meta listener answers the placement query in BOTH SW modes, so this reliably
  // drives election. In SW-direct / declared-idbfs (and the no-placement / plain-port case) the reply is
  // `electionRequired: false` (or absent) and the SW-port attach below acks normally — a plain in-scope host attach.
  controlPort.postMessage({ [PLACEMENT_QUERY_KEY]: true });
  // A restore-bearing boot must know the engine HOME before the first handshake: the restore's ArrayBuffer
  // detaches on first post, and in elected mode the router-only SharedWorker silently DROPS bridge `attach`
  // envelopes — posting the restore there destroys the artifact without it ever reaching the engine (the
  // engine then boots a PLAIN store that only ever fills from sync). So await the placement reply (the
  // bootstrap meta listener answers in both SW modes — the same guarantee the whole elected flow rests on)
  // and route the restore over the port that reaches the engine: the SW port when the in-scope host IS the
  // engine (SW-direct / declared-idbfs), the per-tab pipe (`onConnectPort` handshake) when the engine is
  // elected. Non-restore boots keep the concurrent fire-and-forget handshake — no added latency.
  if (restoreWire !== undefined) {
    await placementKnown;
  }
  // Send the tab's attach handshake on the SW/control port. `firstAttachReady` settles off the FIRST ack from
  // EITHER home: the in-scope SW engine (SW-direct / baseline) acks THIS handshake; the elected engine acks the
  // per-tab PIPE handshake (`onConnectPort`, after election). In elected mode the router silently drops THIS
  // send (payload-blind — never taught to answer bridge envelopes); the gate then settles off the pipe, never the
  // SW port. `.catch` swallows the orphaned handshake promise (its `pendingAttachAck` is superseded by the pipe).
  void runAttachHandshake(currentDataPort(), placementResult?.electionRequired !== true).catch(() => undefined);
  try {
    await firstAttachReady;
  } catch (error) {
    // The engine boot failed (ADR-0032 FIX 1), a terminal pagehide rejected the ack mid-boot (ADR-0040 P2), or a
    // degraded election never delivered a pipe: run the full detach so BOTH listeners AND the pagehide handler are
    // removed (no leaks), then propagate. Idempotent — a pagehide that already detached makes this a cheap no-op.
    detachFromWorker();
    throw error;
  }
  status.isRunning = true;

  // ─── Live-rows seam (ADR-0032 S2 §4) ─────────────────────────────────────────────────────────────
  const subscribeLiveRows = async <TRow extends Record<string, unknown>>(
    input: SubscribeLiveRowsInput,
    onRows: (rows: TRow[]) => void,
  ): Promise<LiveRowsSubscription<TRow>> => {
    // A detached client has no port listener, so `live-initial` could never arrive — reject at once rather
    // than register a forever-pending initial waiter (ADR-0040 P2).
    if (detached) throw detachError();
    const queryId = newId("live");
    const materializer = new LiveRowsMaterializer<TRow>(input.pkColumns);
    diffHandlers.set(queryId, (diff) => {
      onRows(materializer.apply(diff));
    });
    // The subscribe payload — reused by the initial subscribe AND by the ADR-0049 re-subscribe on a pipe swap.
    const subscribePayload = {
      queryId,
      sql: input.sql,
      params: [...input.params],
      ...(input.fields ? { fields: [...input.fields] } : {}),
      ...(input.pkColumns ? { pkColumns: [...input.pkColumns] } : {}),
      ...(input.use ? { use: [...input.use] } : {}),
      // Per-subscription keep-alive hint (ADR-0040 decision 4) forwarded to the worker's manager.
      ...(input.keepAliveMs != null ? { keepAliveMs: input.keepAliveMs } : {}),
    };
    let initial: LiveInitialPayload;
    try {
      initial = await new Promise<LiveInitialPayload>((resolve, reject) => {
        const id = newId("sub");
        initialPending.set(id, { resolve, reject });
        // While the handoff window is open, QUEUE the subscribe (invariant 9); otherwise post at once.
        const dispatch = () => postBridgeMessage(currentDataPort(), codec, "subscribe", subscribePayload, id);
        if (windowOpen) {
          enqueue(dispatch, (error) => {
            initialPending.delete(id);
            reject(error);
          });
        } else {
          dispatch();
        }
      });
    } catch (error) {
      // The worker rejected the subscribe (invalid SQL, etc.); the initial-payload waiter rejected via the
      // `rpc-result` route (ADR-0032 FIX 2). Drop the pre-registered diff handler so no orphan survives.
      diffHandlers.delete(queryId);
      throw error;
    }
    const initialRows = materializer.seed(initial.rows as TRow[]);
    // Register the live query for ADR-0049 re-subscribe: on a pipe swap, re-issue the SAME subscribe (same
    // queryId → diffs still route to the same materializer/handler) and re-seed the materializer off the fresh
    // snapshot. This is the re-attach re-establishment of live queries (ADR-0041 staged readiness); its
    // multi-tab integration coverage is step 12. A rejected re-subscribe leaves the existing rows in place.
    const resubscribe = () => {
      const rid = newId("sub");
      initialPending.set(rid, {
        resolve: (fresh) => {
          onRows(materializer.seed(fresh.rows as TRow[]));
        },
        reject: () => undefined,
      });
      postBridgeMessage(currentDataPort(), codec, "subscribe", subscribePayload, rid);
    };
    activeSubscriptions.set(queryId, { resubscribe });
    // Pending groups present → build the `hydrated` promise the worker settles via `live-hydrated` (posted
    // after the catch-up rows on the same port — rows-before-signal). A missing/empty `hydratingTables`
    // means every referenced group (eager OR lazy) was already ready (steady state) or sync is disabled:
    // no hydration is pending, so no promise. Resolved on unsubscribe too, so an abandoned subscription
    // never leaves a forever-pending promise behind.
    let hydrated: Promise<void> | undefined;
    if (initial.hydratingTables && initial.hydratingTables.length > 0) {
      hydrated = new Promise<void>((resolve) => {
        hydratedPending.set(queryId, resolve);
      });
    }
    return {
      initialRows,
      unsubscribe: () => {
        diffHandlers.delete(queryId);
        activeSubscriptions.delete(queryId);
        hydratedPending.get(queryId)?.();
        hydratedPending.delete(queryId);
        postBridgeMessage(currentDataPort(), codec, "unsubscribe", { queryId });
      },
      // The lazy relations the worker's guard activated for this query (observability). `hydrated` — driven
      // by `hydratingTables`, not this — resolves once every pending group's caught-up rows are delivered.
      ...(initial.lazyTables ? { lazyTables: initial.lazyTables } : {}),
      ...(hydrated ? { hydrated } : {}),
    };
  };

  // ─── Assembled client ────────────────────────────────────────────────────────────────────────────
  const notSupported = (name: string) => (): never => {
    throw new Error(
      `[pgxsinkit] ${name} is not available on a worker-attached client: the tab holds no local PGlite. ` +
        `Direct store access (client.pglite) and store-lifecycle ops (destroy/dropReadCache) have no tab-local ` +
        `implementation. One-shot Drizzle reads (query/queryRow/queryRaw/queryRawRow), lazy activation ` +
        `(ensureSynced), and the write API ARE proxied to the worker.`,
    );
  };

  // A tab has no local store to run a read transaction against — every bridge executor's `transaction` throws.
  const noBridgeTransaction = (): never => {
    throw new Error(
      "[pgxsinkit] client.drizzle.transaction() is not available on a worker-attached client: a read " +
        "transaction needs a local PGlite the tab does not have. Use one-shot reads (client.query) instead.",
    );
  };
  // The ONE encoder of the `guardedQuery` positional wire tuple ({@link GuardedQueryWireArgs}): both tab-side
  // senders (the bridge executor below and `guardedRawQuery`) route through this so the shape is written once
  // and shares its contract with the worker-side decoder (`defineSyncWorker` types the decode against the same
  // type). The optional trailing `use` is appended only when present — never a spread of `undefined`.
  const guardedQueryArgs = (
    sql: string,
    params: unknown[] | undefined,
    rowMode: "array" | "object" | undefined,
    use?: readonly string[],
  ): GuardedQueryWireArgs => {
    // `rowMode` is only included when set (exactOptionalPropertyTypes: no `{ rowMode: undefined }`).
    const options = rowMode ? { rowMode } : {};
    return use ? [sql, params, options, use] : [sql, params, options];
  };
  // A `ClientPGlite`-shaped bridge executor Drizzle runs reads against (ADR-0032 decision 4). Drizzle's pglite
  // driver calls only `client.query` for reads and `client.transaction` for `.transaction()`. `query` routes
  // to the worker's `guardedQuery` RPC (stripping drizzle's non-serializable `parsers` to just `rowMode`; the
  // worker re-applies drizzle's identity parsers) and returns the full `Results` so Drizzle's mapping runs on
  // the tab. `use` (a raw-fragment's undetectable lazy relations, ADR-0021) is baked into the closure per read —
  // see `bridgeReadDrizzle` — NOT stashed on a shared field: a shared stash races, because Drizzle executes
  // the builder in a microtask AFTER `queryRaw` returns, so a plain `query` issued synchronously in between
  // would drain its executor first and consume the wrong call's `use`. A per-read scoped executor cannot
  // cross-contaminate.
  const makeBridgeExecutor = (use?: readonly string[]): ClientPGlite =>
    ({
      query: (sql: string, params?: unknown[], options?: { rowMode?: "array" | "object" }): Promise<Results> =>
        rpc<Results>("guardedQuery", guardedQueryArgs(sql, params, options?.rowMode, use)),
      transaction: noBridgeTransaction,
    }) as unknown as ClientPGlite;
  // The base (no-`use`) bridge database `client.drizzle` exposes, plus the cached factory that mints a fresh
  // database over a per-read `use`-carrying executor (the schema/relations are computed ONCE, ADR-0032
  // decision 4). `views` are unchanged.
  const { drizzle, views, drizzleFor } = buildRegistryReadHandles(options.registry, makeBridgeExecutor());
  // Build a `use`-scoped Drizzle for one `queryRaw`/`queryRawRow` call and run its builder against a shallow
  // clone of the client whose `drizzle` is that scoped db. The clone is safe: every client method is an arrow
  // closing over this scope (no `this`), so spreading preserves behaviour and only `drizzle` is swapped.
  const bridgeReadDrizzle = (use?: readonly string[]) => drizzleFor(makeBridgeExecutor(use));

  const groupKeyForTable = (table: SyncTableName<TRegistry>): string | undefined => {
    const entry = options.registry[table];
    return entry?.consistencyGroup ?? entry?.shape?.shapeKey;
  };

  const client: AttachedSyncClient<TRegistry> = {
    drizzle,
    views,
    // The tab has no local PGlite; reads go through the live-rows bridge. Touching `.pglite` is a misuse
    // — the real trap is installed as a NON-ENUMERABLE throwing getter after this literal (see below).
    pglite: undefined as never,
    tables: Object.fromEntries(
      Object.keys(options.registry).map((tableKey) => [
        tableKey,
        {
          key: tableKey,
          mode: options.registry[tableKey as SyncTableName<TRegistry>]!.mode,
          create: (input: unknown) => rpc<void>("create", [tableKey, input]),
          update: (entityKey: Record<string, string>, patch: unknown) =>
            rpc<void>("update", [tableKey, entityKey, patch]),
          delete: (entityKey: Record<string, string>) => rpc<void>("delete", [tableKey, entityKey]),
        },
      ]),
    ) as SyncClient<TRegistry>["tables"],
    localReadReady,
    writeReady,
    bootSettled,
    ready,
    status,
    start: async () => {
      await ready;
    },
    stop: async () => {
      detachFromWorker();
    },
    // ADR-0049 step 10b — SUPERVISED destroy from the attached facade. The SUPERVISOR is the TAB context, which
    // survives engine shutdown BY CONSTRUCTION: it detaches the engine, then runs the destructive lifecycle
    // itself (the tab has full OPFS/IndexedDB access). Ordering, per the plan's D8 fault rows:
    //   1. PEER REFUSAL FIRST — the SharedWorker alone knows the attached-tab count; more than one tab attached
    //      (this one + a peer) → `StoreDestroyRefusedError` (close peers first). Runs BEFORE detach + any effect.
    //   2. REFUSE-IF-OWED (unless `force`) — a cheap journal read via the `diagnostics` RPC while still attached
    //      (one round-trip; the honest minimum — the tab has no local journal). `force` skips it.
    //   3. DETACH, then run the destruction (set `deleting` → delete sentinel → delete backend store → delete
    //      meta record) with a bounded ownership-lock-lag retry on the backend delete (the just-detached engine's
    //      VFS ownership lock may lag). The initiating call resolves from the tab supervisor (invariant 13).
    destroy: async (destroyOptions) => {
      if (detached) throw detachError();
      const peers = await queryDestroyPeers();
      if (peers > 1) throw new StoreDestroyRefusedError(peers);
      if (!destroyOptions?.force) {
        const { mutation } = await client.diagnostics();
        const owed =
          mutation.pendingCount +
          mutation.sendingCount +
          mutation.failedCount +
          mutation.quarantinedCount +
          mutation.conflictedCount;
        if (owed > 0) {
          throw new Error(
            `destroy() refused: ${owed} mutation(s) still owed to the server. Flush them first or call destroy({ force: true }).`,
          );
        }
      }
      const storePath = resolveDestroyStorePath();
      // ADR-0049 D8 ordering (elected placement): RETIRE this tab's own elected engine and AWAIT its teardown —
      // the point its EXCLUSIVE OPFS sync-access handle is provably released — BEFORE deleting. The engine is a
      // dedicated Worker torn down ASYNCHRONOUSLY via the coordinator's retirement handshake; without this
      // barrier `deleteBackendStore` raced that release and failed `NoModificationAllowedError`. Run it while the
      // control channel is still up (before detach closes the SW port). A no-op when this tab holds no engine.
      if (electionCoordinator !== undefined) await electionCoordinator.retireEngine();
      else await awaitSharedHostTeardown();
      // Detach the engine FIRST — the supervisor is this tab, which outlives the engine. Idempotent.
      detachFromWorker();
      const effects = options.createDestructionEffects?.(storePath) ?? createStoreDestructionEffects(storePath);
      await runStoreDestruction(effects);
    },
    dropReadCache: notSupported("client.dropReadCache"),
    flush: (table) => rpc<void>("flush", [table]),
    reconcile: (table) => rpc<void>("reconcile", [table]),
    retryFailed: (table) => rpc<void>("retryFailed", [table]),
    recoverSending: (table) => rpc<void>("recoverSending", [table]),
    readMutationDetails: (table) => rpc<MutationDetail[]>("readMutationDetails", [table]),
    // Inspection reads run in the worker (ADR-0032 S2) — the same surface as the in-process client. `pglite`
    // itself stays blocked (below); these route the raw statement over the RPC round-trip instead.
    rawQuery: (sql, params, options) => rpc<Results>("rawQuery", [sql, params, options]),
    rawExec: (sql, options) => rpc<Results[]>("rawExec", [sql, options]),
    // The GUARDED raw-SQL read (ADR-0032 decision 4) — the seam the worker host dispatches `guardedQuery` to.
    // Unlike `rawQuery` (raw inspection, no guard), this routes to the worker's `guardedRawQuery`, so the read
    // gate + lazy-group guard run worker-side. Only `rowMode` crosses in the options (see the bridge executor).
    guardedRawQuery: (sql, params, options, use) =>
      rpc<Results>("guardedQuery", guardedQueryArgs(sql, params, options?.rowMode, use)),
    mutate: {
      create: (table, input) => rpc<void>("create", [table, input]),
      update: (table, entityKey, patch) => rpc<void>("update", [table, entityKey, patch]),
      delete: (table, entityKey) => rpc<void>("delete", [table, entityKey]),
      batch: (items) => rpc<void>("batch", [items]),
    },
    discardConflict: (table, entityKey) => rpc<void>("discardConflict", [table, entityKey]),
    discardQuarantined: (table, entityKey) => rpc<void>("discardQuarantined", [table, entityKey]),
    diagnostics: (table) => rpc<{ mutation: MutationDiagnostics }>("diagnostics", [table]),
    // The registry-wide mutation-status API (slice 4) over the SAME factory the in-process client uses,
    // wired to this facade's shared seams: the live-rows bridge (`subscribeLiveRows`) and the one-shot
    // `rawQuery` RPC. No new bridge message — `client.mutations` behaves identically to the in-process client.
    mutations: createMutationsApi({
      registry: options.registry,
      subscribeLiveRows,
      query: (sql, params) => rpc<Results>("rawQuery", [sql, params]),
    }),
    // One-shot Drizzle reads (ADR-0032 decision 4) — proxied, mirroring the in-process shapes exactly. `build`
    // runs against a client whose `drizzle` is a bridge database, so awaiting the builder executes the read via
    // the `guardedQuery` RPC: the read gate + lazy-group guard run worker-side (no tab-side `prepareQuery`) and
    // Drizzle's own mapping runs on the tab. The pure `query`/`queryRow` need no `use` (the worker's SQL scan
    // finds every relation) and run against the base `client`. `queryRaw`/`queryRawRow` may embed a raw
    // fragment naming a lazy relation the scan cannot see, so each runs against a `{ ...client, drizzle }`
    // clone whose drizzle carries THAT call's `use` in its own executor — no shared state, no cross-read race.
    query: (build) => Promise.resolve(build(client)),
    queryRow: async (build) => {
      const rows = await build(client);
      return rows[0] ?? null;
    },
    queryRaw: ({ build, use }) => Promise.resolve(build({ ...client, drizzle: bridgeReadDrizzle(use) })),
    queryRawRow: async ({ build, use }) => {
      const rows = await build({ ...client, drizzle: bridgeReadDrizzle(use) });
      return rows[0] ?? null;
    },
    // Lazy activation (ADR-0021) over the shared engine — a plain RPC. Activation is engine-WIDE, but unlike
    // `desync` it is additive and idempotent: starting a group another tab already activated is a no-op, and
    // it never reverts or truncates, so there is no cross-tab footgun. Resolves once the group's stream is
    // started (catch-up may still be in flight — await `groupReady` for that), exactly as in-process.
    ensureSynced: (keys) => rpc<void>("ensureSynced", [keys]),
    // `isSynced` is the SYNCHRONOUS peek in-process (`isTableStarted` — is the group's stream STARTED). It
    // cannot be an RPC (its signature returns a boolean, not a promise), and the tab's cached state cannot
    // answer it: the bridge delivers per-group CATCH-UP readiness (`status.groups` / `groupReady`), which is
    // strictly weaker than activation-started — an activated-but-not-yet-caught-up lazy group reads as
    // not-ready, the very case `isSynced` exists to distinguish. So no faithful synchronous answer is derivable.
    isSynced: () => {
      throw new Error(
        "[pgxsinkit] client.isSynced is not available on a worker-attached client: it is a SYNCHRONOUS " +
          "activation-STARTED peek (in-process: isTableStarted), but the tab caches only per-group CATCH-UP " +
          "readiness (status.groups / groupReady) — an activated-but-not-caught-up group reads as not-ready — " +
          "so a faithful synchronous answer cannot be derived, and a synchronous method cannot be an RPC. Use " +
          "client.groupReady(table) for catch-up completion, and client.ensureSynced([...]) to activate a lazy relation.",
      );
    },
    // In SharedWorker mode the engine is SHARED, so a desync from one tab reverts the consistency group for
    // EVERY attached tab — inherent to desync's group-wide semantics (that footgun is why the narrower
    // `discardEphemeral` exists). The RPC runs the worker's real `desync` (same refusals as in-process).
    desync: (key) => rpc<void>("desync", [key]),
    // Scoped, multi-tab-safe finalize (ADR-0021): drops an ephemeral relation's local rows and reverts it to
    // dormant. Safe under a shared engine because an ephemeral window is per-delivery-session and inherently
    // single-consumer; the RPC runs the worker's real `discardEphemeral` (refuses persistent members).
    discardEphemeral: (key) => rpc<void>("discardEphemeral", [key]),
    // The worker activates lazy relations inside its `subscribe` handler (via the `use` hint), so the tab's
    // `prepareQuery` is a no-op — the live-rows subscription is already guarded worker-side (ADR-0021).
    // Empty `lazyTables`: the real scan's keys travel back on the subscription itself (`live-initial`).
    prepareQuery: async () => ({ lazyTables: [] }),
    // The worker computes the pending hydrating tables inside its `subscribe` handler (on its owned client)
    // and reports them back on `live-initial` (`hydratingTables`), so the tab-side seam is a no-op here.
    hydratingTablesFor: () => [],
    transaction: async ({ mode }: { mode: WriteMode }, run) => {
      // Collect the unit's mutations tab-side (the run callback cannot cross the wire), then RPC the
      // serialized items + mode; the worker replays them into a real `client.transaction` (matching acks).
      const collected: MutationBatchItem<TRegistry>[] = [];
      const txTables = Object.fromEntries(
        Object.keys(options.registry).map((tableKey) => [
          tableKey,
          {
            create: (input: unknown) => {
              collected.push({ table: tableKey, kind: "create", input } as MutationBatchItem<TRegistry>);
            },
            update: (entityKey: Record<string, string>, patch: unknown) => {
              collected.push({ table: tableKey, kind: "update", entityKey, patch } as MutationBatchItem<TRegistry>);
            },
            updateBlind: (entityKey: Record<string, string>, patch: unknown) => {
              // ADR-0022 addendum: the `blind` flag rides the serialized item across the wire; the worker
              // replays it through `client.transaction`'s `updateBlind`, identical to the in-process client.
              collected.push({
                table: tableKey,
                kind: "update",
                entityKey,
                patch,
                blind: true,
              } as MutationBatchItem<TRegistry>);
            },
            delete: (entityKey: Record<string, string>) => {
              collected.push({ table: tableKey, kind: "delete", entityKey } as MutationBatchItem<TRegistry>);
            },
          },
        ]),
      ) as SyncTransaction<TRegistry>["tables"];
      await run({ tables: txTables });
      if (collected.length === 0) return { acks: [] };
      return rpc<SyncTransactionResult>("transaction", [{ mode, items: collected }]);
    },
    groupReady: async (table) => {
      // A detached client will never receive further `groupReady`/status edges — reject at once rather than
      // register a waiter that detach already drained (ADR-0040 P2).
      if (detached) throw detachError();
      const groupKey = groupKeyForTable(table);
      if (groupKey == null || readyGroups.has(groupKey)) return;
      await new Promise<void>((resolve) => {
        const waiters = groupWaiters.get(groupKey) ?? [];
        waiters.push(resolve);
        groupWaiters.set(groupKey, waiters);
      });
    },
    subscribeLiveRows,
    // Boot observability (ADR-0034): pull the worker engine's stored boot report over the bridge — returns
    // the same report regardless of when this tab attached (a late tab reads a boot that predates it).
    bootReport: () => rpc<BootReport | null>("bootReport", []),
    // Live-query diagnostics (ADR-0040 decision 5): pull the worker manager's per-entry snapshot over the
    // bridge (digests + counts only — plain objects that structured-clone across the wire).
    liveQueryDiagnostics: () => rpc<LiveQueryDiagnostics[]>("liveQueryDiagnostics", []),
    // Store backup (ADR-0035): the worker runs the live export on its owned client (its lifecycle slot
    // serialises it against every tab). The dump crosses back as a transferred `ArrayBuffer`; rebuild the
    // `File` tab-side from the wire form — NOT in the notSupported set (unlike the local `pglite` reads).
    exportStore: async (exportOptions?: StoreExportOptions): Promise<StoreExportResult> => {
      const wire = await rpc<ExportArtefactWire>("exportStore", [exportOptions]);
      return {
        file: new File([wire.buffer], wire.fileName, { type: wire.mimeType }),
        // The wire carries the discriminated union; `exportStore` always round-trips a store-backup report.
        report: wire.report as StoreExportResult["report"],
      };
    },
    // Diagnostic dump (ADR-0035): the worker runs the throwaway-clone dump on its owned client (same
    // lifecycle slot as every tab). The SQL crosses back as the same transferred `ArrayBuffer`; rebuild the
    // `File` tab-side. NOT in the notSupported set (unlike the local `pglite` reads).
    exportDiagnostics: async (exportOptions?: DiagnosticExportOptions): Promise<DiagnosticExportResult> => {
      const wire = await rpc<ExportArtefactWire>("exportDiagnostics", [exportOptions]);
      return {
        file: new File([wire.buffer], wire.fileName, { type: wire.mimeType }),
        // The wire carries the discriminated union; `exportDiagnostics` always round-trips a diagnostic-dump report.
        report: wire.report as DiagnosticExportResult["report"],
      };
    },
    // Data export (ADR-0035): the worker runs the drain-guarded `pg_dump -t` export on its owned client (same
    // lifecycle slot as every tab). The portable SQL crosses back as the same transferred `ArrayBuffer`;
    // rebuild the `File` tab-side. A `DataExportDrainError` surfaces as the rejected RPC (deserialised tab-side).
    exportData: async (exportOptions?: DataExportOptions): Promise<DataExportResult> => {
      const wire = await rpc<ExportArtefactWire>("exportData", [exportOptions]);
      return {
        file: new File([wire.buffer], wire.fileName, { type: wire.mimeType }),
        // The wire carries the discriminated union; `exportData` always round-trips a data-export report.
        report: wire.report as DataExportResult["report"],
      };
    },
    notifyAuthChanged: () => {
      void pushToken();
    },
    setOnline: (online: boolean) => {
      postBridgeMessage(currentDataPort(), codec, "set-online", { online });
    },
  };

  // The `pglite` misuse trap MUST be a NON-ENUMERABLE throwing getter, never an enumerable property
  // holding a throw-on-get Proxy: host tooling reflects over the client wherever the app hands it around
  // (React 19.2's dev-build render logging serializes prop diffs property-by-property — observed crashing
  // a <SyncClientProvider client={...}> re-render — and console inspection / object spreads do the same),
  // and an enumerable trap turns that passive reflection into a crash. Non-enumerable keeps the trap out
  // of every enumeration path while a direct `client.pglite` touch still throws the misuse error.
  Object.defineProperty(client, "pglite", {
    get: notSupported("client.pglite"),
    enumerable: false,
    configurable: true,
  });

  return client;
}

/** {@link provisionSyncWorker} options — attach's transport/store/factory seams, plus the provision expiry. */
export type ProvisionSyncWorkerOptions<TRegistry extends SyncTableRegistry> = Pick<
  AttachSyncClientOptions<TRegistry>,
  | "worker"
  | "port"
  | "storeId"
  | "storePath"
  | "codec"
  | "createEngineWorker"
  | "electionIo"
  | "awaitOwnershipRelease"
  | "timers"
> & {
  /**
   * How long (ms) the elected-mode provision claim (and its shared-coordinator ref) is held before an abandoned
   * warmed provision auto-retires (ADR-0049 step 8, "abandoned warmed provision → claim expiry"). Default 60000.
   * A later {@link attachSyncClient} on the same store ADOPTS the grant within this window (adding its own claim,
   * so the engine outlives the expiry). Inert on SW-direct.
   */
  provisionExpiryMs?: number;
};

/** Options for deliberately retiring a SW-direct host before changing its construction identity. */
export type RetireSyncWorkerHostOptions = Pick<
  AttachSyncClientOptions<SyncTableRegistry>,
  "worker" | "port" | "timers"
> & {
  /** Bound for the placement + teardown handshake. Default 5000 ms. */
  timeoutMs?: number;
};

/**
 * Quiesce and retire a SW-direct sync host without deleting its store.
 *
 * This is the construction-lifecycle companion to {@link provisionSyncWorker}: a caller that must replace a
 * SharedWorker under a different construction identity (for example, a different durability preference) first
 * awaits this barrier so the old extended-lifetime worker releases its database handle. Elected placement owns
 * retirement through its coordinator and is therefore rejected here. Retirement is refused while peer tabs are
 * attached: changing one tab's construction preference must not terminate a host other tabs are actively using.
 */
export function retireSyncWorkerHost(options: RetireSyncWorkerHostOptions): Promise<void> {
  const port = resolvePort(options);
  const timers: AttachClientTimers = options.timers ?? {
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
  };

  return new Promise<void>((resolve, reject) => {
    let identity: EngineIdentity | undefined;
    let settled = false;
    const finish = (result: { ok: true } | { ok: false; error: Error }): void => {
      if (settled) return;
      settled = true;
      timers.clearTimeout(timeout);
      port.removeEventListener("message", listener);
      if (result.ok) resolve();
      else reject(result.error);
    };
    const listener = (event: { data: unknown }): void => {
      const placement = readPlacementResult(event.data);
      if (placement !== undefined) {
        if (placement.electionRequired) {
          finish({
            ok: false,
            error: new Error(
              "[pgxsinkit] retireSyncWorkerHost only applies to a SW-direct host; elected placement retires " +
                "through its election coordinator.",
            ),
          });
          return;
        }
        identity = { swInstanceId: placement.swInstanceId, generation: 0 };
        port.postMessage({ [DESTROY_QUERY_KEY]: true });
        return;
      }
      const peers = readDestroyVerdict(event.data);
      if (peers !== undefined && identity !== undefined) {
        if (peers > 1) {
          finish({
            ok: false,
            error: new Error(
              `[pgxsinkit] SW-direct host retirement refused: ${peers} attached tabs still use this store. ` +
                "Close the peer tabs before changing the worker construction preference.",
            ),
          });
          return;
        }
        port.postMessage(wrapControlEnvelope({ type: "engine-teardown", identity }));
        return;
      }
      const control = readControlEnvelope(event.data);
      if (
        identity !== undefined &&
        control?.type === "control-ack" &&
        control.pingId === -1 &&
        engineIdentityEquals(control.identity, identity)
      ) {
        if (control.error) {
          finish({
            ok: false,
            error: new Error(`[pgxsinkit] SW-direct host teardown failed: ${control.error.message}`),
          });
        } else {
          finish({ ok: true });
        }
      }
    };
    const timeout = timers.setTimeout(
      () =>
        finish({
          ok: false,
          error: new Error("[pgxsinkit] timed out while retiring the SW-direct sync host."),
        }),
      options.timeoutMs ?? 5_000,
    );
    port.addEventListener("message", listener);
    port.start?.();
    port.postMessage({ [PLACEMENT_QUERY_KEY]: true });
  });
}

/**
 * Pre-spawn a worker's store WITHOUT attaching (ADR-0032 decision 5). Sent at the board's login screen against a
 * freshly-named spare `SharedWorker`: the worker runs PGlite `create`/initdb only and holds the raw store idle
 * until the real {@link attachSyncClient} claim adopts it. Resolves when the worker acks the provision (its initdb
 * settled); rejects only if the worker reports the create failed — the caller treats either outcome as best-effort,
 * since attach falls back to a fresh create regardless.
 *
 * Routed through the SAME placement-query-first flow as {@link attachSyncClient} (ADR-0049 step 8): a SW-direct
 * (or declared-idbfs) SharedWorker takes the `provision` bridge envelope on the SW port; a
 * router-only (`electionRequired`) SharedWorker DROPS bridge envelopes, so provision drives the election
 * coordinator's PROVISION CLAIM (expiry-bounded) and delivers the `provision` over the elected engine's per-tab
 * PIPE. The coordinator is REGISTERED per store so a later attach on the same tab ADOPTS the grant — no second
 * lock, no second engine, no double initdb (invariant 2). Elected mode REQUIRES a {@link createEngineWorker}
 * factory (mirroring attach); its absence is a clear rejection, never a hang.
 */
export function provisionSyncWorker<const TRegistry extends SyncTableRegistry>(
  options: ProvisionSyncWorkerOptions<TRegistry>,
): Promise<void> {
  const codec = options.codec ?? identityCodec;
  const port = resolvePort(options);
  const timers: AttachClientTimers = options.timers ?? {
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
  };
  const storePath = options.storePath ?? options.storeId ?? "pgxsinkit-overlay-v1";
  // The testing memory-backend override travels as an explicit wire field (a symbol does not survive structured
  // clone, ADR-0036) — read it off the spread helper's options and forward it to the worker.
  const memoryOverride = readTestStoreMarker(options) === "memory";
  const provisionPayload = {
    ...(options.storeId ? { storeId: options.storeId } : {}),
    ...(options.storePath ? { storePath: options.storePath } : {}),
    ...(memoryOverride ? { testStoreBackend: "memory" as const } : {}),
  };
  const pageLifecycle = readDefaultPageLifecycle();

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const ackRemovers: Array<() => void> = [];
    const controlListener = (event: { data: unknown; ports?: readonly BridgePort[] }): void => {
      const placement = readPlacementResult(event.data);
      if (placement !== undefined) {
        onPlacement(placement);
        return;
      }
      const control = readControlEnvelope(event.data);
      if (control?.type === "connect-port") onProvisionPipe(event.ports?.[0], control.identity);
    };
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      port.removeEventListener("message", controlListener);
      for (const remove of ackRemovers) remove();
      fn();
    };

    // Await `provision-ack` on whichever port carries it: the SW port (SW-direct) or the elected engine's pipe.
    // In elected mode the SW-port `provision` is dropped by the router, so its ack never comes — the pipe's does.
    const awaitAckOn = (ackPort: BridgePort): void => {
      const ackListener = (message: { data: unknown }): void => {
        if (!isBridgeEnvelope(message.data) || message.data.type !== "provision-ack") return;
        const ack = codec.decode(message.data.payload) as ProvisionAckPayload;
        settle(() => (ack.ok ? resolve() : reject(new Error(ack.error?.message ?? "worker provision failed"))));
      };
      ackPort.addEventListener("message", ackListener);
      ackPort.start?.();
      ackRemovers.push(() => ackPort.removeEventListener("message", ackListener));
    };
    const postProvisionOn = (target: BridgePort): void => {
      awaitAckOn(target);
      postBridgeMessage(target, codec, "provision", provisionPayload);
    };

    let placementDecided = false;
    let piped = false;
    const onProvisionPipe = (pipe: BridgePort | undefined, identity: EngineIdentity): void => {
      if (piped || pipe === undefined) return;
      piped = true;
      // The router piped this provision connection to the elected engine — deliver the `provision` over the pipe,
      // and STASH the pipe on the shared coordinator entry: the router mints one pipe per SW connection, so when a
      // later attach adopts this grant on the SAME port (the board's ordered-messages contract) it must receive
      // THIS pipe by handover — no second `connect-port` will ever arrive for an already-piped tab.
      stashProvisionPipe(storePath, pipe, identity);
      postProvisionOn(pipe);
    };

    const onPlacement = (result: PlacementQueryResult): void => {
      if (placementDecided) return;
      placementDecided = true;
      // SW-direct (or a non-placement transport that never replies): the SW-port `provision` below carries it.
      if (!result.electionRequired) return;
      // Elected (router-only): the SW drops the `provision` bridge envelope, so ELECT and provision over the pipe.
      // Resolve the engine factory exactly as attach does — the `createEngineWorker` override, else the default
      // derived from the SharedWorker's reported script URL (dual-scope entry). Neither available → a WIRING failure.
      const engineFactory = options.createEngineWorker ?? deriveEngineWorkerFactory(result.swScriptUrl);
      if (engineFactory === undefined) {
        settle(() =>
          reject(
            new ElectedEngineUnconstructibleError(
              result.swScriptUrl === undefined
                ? "provisionSyncWorker: the SharedWorker reported no derivable script URL and no `createEngineWorker` override was supplied"
                : "provisionSyncWorker: no `Worker` constructor is available in this scope to derive the module engine and no override was supplied",
            ),
          ),
        );
        return;
      }
      const provisionSwFactory = workerFactoryOf(options.worker);
      const coordinator = adoptOrRegisterCoordinator(storePath, () =>
        buildElectedCoordinator({
          storePath,
          controlPort: port,
          createEngineWorker: engineFactory,
          ...(provisionSwFactory ? { swFactory: provisionSwFactory } : {}),
          ...(options.electionIo ? { electionIo: options.electionIo } : {}),
          ...(options.awaitOwnershipRelease ? { awaitOwnershipRelease: options.awaitOwnershipRelease } : {}),
          timers,
          ...(pageLifecycle ? { pageLifecycle } : {}),
        }),
      );
      // The PROVISION CLAIM elects → the coordinator spawns the engine + announces; the router pipes this
      // connection (→ `onProvisionPipe`). Bound by expiry: an abandoned warmed provision auto-retires (its claim
      // AND its shared-coordinator ref release together), so a store nobody adopts never pins the leader lock.
      const releaseProvisionClaim = coordinator.claimForProvision();
      const expiryMs = options.provisionExpiryMs ?? 60_000;
      timers.setTimeout(() => {
        releaseProvisionClaim();
        releaseSharedCoordinator(storePath);
      }, expiryMs);
    };

    port.addEventListener("message", controlListener);
    port.start?.();
    // Placement-query-FIRST (mirror attach): answered in BOTH SW modes by the bootstrap meta listener. Send the
    // `provision` on the SW port immediately — SW-direct / declared-idbfs (the in-scope host) ack it here; a router-only
    // SW drops it and the elected pipe carries it instead. The first `provision-ack` from EITHER settles.
    port.postMessage({ [PLACEMENT_QUERY_KEY]: true });
    postProvisionOn(port);
  });
}

/** Resolve the default page-lifecycle subscription off `globalThis.window` (structural, no DOM lib) — for the
    elected provision coordinator's BFCache hooks; `undefined` in a non-window scope. Mirrors the attach client. */
function readDefaultPageLifecycle(): CoordinatorDeps["pageLifecycle"] {
  interface PageLifecycleWindowLike {
    addEventListener(type: "pagehide" | "pageshow", handler: (event: { persisted: boolean }) => void): void;
  }
  const pageWindow = (globalThis as { window?: PageLifecycleWindowLike }).window;
  if (!pageWindow) return undefined;
  return {
    onPageHide: (listener) => pageWindow.addEventListener("pagehide", (event) => listener(event.persisted)),
    onPageShow: (listener) => pageWindow.addEventListener("pageshow", () => listener()),
  };
}

/**
 * Resolve the transport port from the options: an explicit port, or a worker input (ADR-0049 D5) that is EITHER a
 * FACTORY `() => WorkerLike` (invoked here for a fresh instance — the reconnect/reconstruct callers pass the factory
 * so each call yields a new SharedWorker) OR a bare instance. From the instance: a SharedWorker's `.port`, or a
 * Worker itself (which IS the port).
 */
function resolvePort(options: { port?: BridgePort; worker?: (() => WorkerLike) | WorkerLike }): BridgePort {
  if (options.port) return options.port;
  const worker = typeof options.worker === "function" ? (options.worker as () => WorkerLike)() : options.worker;
  if (!worker) throw new Error("attachSyncClient: provide a `worker` or a `port`.");
  if (worker.port) return worker.port;
  if (worker.postMessage && worker.addEventListener && worker.removeEventListener) {
    return worker as BridgePort;
  }
  throw new Error("attachSyncClient: the provided `worker` is neither a Worker nor a SharedWorker port.");
}

/**
 * The SharedWorker reconstruction FACTORY, or `undefined` when the input is a bare instance/port (ADR-0049 D5). A
 * factory input (`worker: () => SharedWorker`) makes SharedWorker-death recovery a guarantee — the bridge-silence
 * reconnect and the keepalive reconstruction re-invoke it. A bare-instance input has none: reconstruction is
 * structurally unavailable (a SharedWorker cannot be rebuilt from itself), so those paths are simply not armed.
 */
function workerFactoryOf(worker: (() => WorkerLike) | WorkerLike | undefined): (() => WorkerLike) | undefined {
  return typeof worker === "function" ? (worker as () => WorkerLike) : undefined;
}

/**
 * Auto-derive the elected engine worker factory from the SharedWorker's reported script URL (ADR-0049 D5). The
 * worker entry is dual-scope, so `new Worker(swScriptUrl, { type: "module" })` boots the SAME entry as a dedicated
 * engine — no consumer wiring. Returns `undefined` when there is no derivable URL or no `Worker` constructor in
 * scope (a plain test scope); the caller then requires the `createEngineWorker` override or fails typed.
 */
function deriveEngineWorkerFactory(swScriptUrl: string | undefined): (() => ElectedEngineWorker) | undefined {
  if (swScriptUrl === undefined) return undefined;
  const WorkerCtor = (globalThis as { Worker?: new (url: string, options?: { type?: "module" }) => WorkerLike }).Worker;
  if (WorkerCtor === undefined) return undefined;
  return () => wrapEngineWorker(new WorkerCtor(swScriptUrl, { type: "module" }));
}

/**
 * Rebuild an Error from the bridge's serialized {@link BridgeErrorWire} shape, carrying `name` and `detail`
 * through. Restoring `name` is what keeps a typed worker-side failure (e.g. a restore refused with
 * `RestoreTargetExistsError`) detectable by the consumer without message matching.
 */
function rebuildError(error: RpcResultPayload["error"]): Error {
  if (error && "detail" in error) {
    const mismatch = executionLimitMismatchFromWire(error.detail);
    if (mismatch !== undefined) return mismatch;
  }
  const rebuilt = new Error(error?.message ?? "worker rpc failed");
  if (error?.name !== undefined) {
    rebuilt.name = error.name;
  }
  if (error && "detail" in error && error.detail !== undefined) {
    (rebuilt as Error & { detail?: unknown }).detail = error.detail;
  }
  return rebuilt;
}

/**
 * Rebuild an RPC/subscribe error, reconstructing the typed {@link EngineRelocatedError} when the bridge error's
 * `detail` carries the clone-safe `{ code: "engine-relocated", outcome }` wire form (ADR-0049 D10). This is the
 * attach-side reconstruction seam: a relocation failure crossing the pipe as a bridge error surfaces to the
 * consumer as an `instanceof EngineRelocatedError` with the honest `outcome`. Any other detail rebuilds as a
 * plain error carrying its `detail` (unchanged behavior).
 */
function rebuildRpcError(error: RpcResultPayload["error"]): Error {
  if (error && "detail" in error) {
    const relocated = engineRelocatedFromWire(error.detail);
    if (relocated !== undefined) return relocated;
  }
  return rebuildError(error);
}
