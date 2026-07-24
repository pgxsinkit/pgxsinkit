import { PGlite, type PGliteOptions, type QueryOptions, type Results } from "@electric-sql/pglite";
import { live, type PGliteWithLive } from "@electric-sql/pglite/live";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { defineRelations } from "drizzle-orm/relations";

import type {
  MutationAck,
  MutationDiagnostics,
  MutationSummary,
  RegistryRelations,
  RegistryTables,
  RegistryViews,
  SyncConfigInput,
  SyncRuntimeStatus,
  SyncTableCreateInput,
  SyncTableEntry,
  SyncStorageDeclaration,
  SyncTableName,
  SyncTableRegistry,
  SyncTableUpdateInput,
  StorageDurability,
  WriteMode,
} from "@pgxsinkit/contracts";
import {
  fingerprintRegistry,
  getSyncRegistrySchema,
  getSyncRegistryStorage,
  isClaimsDependentRowFilter,
  resolveStorageDeclaration,
} from "@pgxsinkit/contracts";
// Type-only import (erased at runtime): the opfs-repacked factory's option/return types for the `opfs://`
// branch. The factory VALUE is loaded lazily via dynamic `import()` inside that branch so a Bun unit test
// mocking `@electric-sql/pglite` never evaluates the factory's `class ... extends PGlite` module top level.
import type { CreateOpfsRepackedPGliteOptions, OpfsRepackedPGlite } from "@pgxsinkit/pglite-opfs-repacked";

import {
  type AdoptionDeclaration,
  type AdoptionEffects,
  adoptionEligible,
  type AdoptionOutcome,
  buildAdoptionEffects,
  runAdoptionTransition,
  runManualAdoption,
} from "./adoption";
import { type BootReport, type BootReportBuilder, createBootReportBuilder } from "./boot-report";
import { type ConvergenceDriver, type ConvergenceTrigger, createConvergenceDriver } from "./convergence";
import { syncDebug, timeAsync } from "./debug";
import { describeErrorChain } from "./error-chain";
import { type DataExportOptions, type DataExportResult, performDataExport } from "./export-data";
import { type DiagnosticExportOptions, type DiagnosticExportResult, performDiagnosticExport } from "./export-dump";
import { performStoreExport, type StoreExportOptions, type StoreExportResult } from "./export-store";
import {
  assertLazyRefsActivated,
  buildLazyGuardIndex,
  findReferencedLazyKeysInSql,
  findReferencedSyncedKeysInSql,
} from "./lazy-guard";
import { createLifecycleSlot } from "./lifecycle-slot";
import { wrapLiveQueryForMaterialization } from "./live-rows-sql";
import {
  type LocalStoreVersionEvent,
  clearLazyGroupActivation,
  readActivatedLazyGroups,
  readStoredLocalSchemaFingerprint,
  reconcileLocalStoreVersion,
  writeLazyGroupActivation,
  writeStoredLocalSchemaFingerprint,
} from "./local-store";
import {
  createMutationRuntime,
  type MutationBatchItem,
  type MutationDetail,
  type MutationKind,
  type WriteUnit,
} from "./mutation";
import { createMutationsApi, type MutationsApi } from "./mutations-api";
import { createOpfsEffects, type OpfsEffectsDeps } from "./opfs-effects";
import {
  buildDataExportCloneCleanupSql,
  buildDataExportEnumHeaderSql,
  buildDesyncTableSql,
  buildDropReadCacheSql,
  buildLocalMetaBootstrapSql,
  buildWipeLocalStoreSql,
  collectDataExportSyncedTableNames,
  computeLocalSchemaFingerprint,
  generateDurableLocalSchemaSql,
  generateEphemeralLocalSchemaSql,
  generateLocalSchemaSql,
} from "./schema";
import { startConfiguredSync } from "./shape-sync";
import {
  recoverDeniedBootDeletion,
  resolveStoreBoot,
  type ResolvedStorageBackend,
  type StoreBootResolution,
} from "./store-boot";
import { runCommitmentBarrier } from "./store-lifecycle";
import {
  idbStoreExists as defaultIdbStoreExists,
  type StoreBootVerdict,
  type StoreMetaDeps,
  type StoreMetaPhase,
  writeStoreMetaRecord,
} from "./store-meta";
import {
  classifyNonPersistentDataDir,
  NonPersistentStoreError,
  normaliseStorePathInput,
  readTestStoreMarker,
  resolveStoreDataDir,
  RestoreTargetExistsError,
  storeIndexedDbDatabaseName,
  storeTargetExists,
  type StorePathInput,
} from "./store-path";
import { createSyncEngine, type SyncEngine } from "./sync";
import { buildShapeHeaders } from "./sync-auth";
import { LiveRowsMaterializer } from "./worker/live-diff";
import {
  createLiveQueryManager,
  type LiveQueryDiagnostics,
  type LiveQueryManager,
  validateLiveQueryPolicy,
} from "./worker/live-query-manager";

export { generateLocalSchemaSql };
export { wrapLiveQueryForMaterialization } from "./live-rows-sql";
export type { BootReport } from "./boot-report";
export {
  type CloneDumpPhases,
  type CloneDumpResult,
  type DiagnosticExportDeps,
  type DiagnosticExportOptions,
  type DiagnosticExportResult,
  performDiagnosticExport,
  runThrowawayCloneDump,
} from "./export-dump";
export {
  type DataExportDeps,
  DataExportDrainError,
  type DataExportOptions,
  type DataExportResult,
  DEFAULT_DRAIN_TIMEOUT_MS,
  type DrainJournalOption,
  type DrainJournalOptions,
  performDataExport,
} from "./export-data";
export {
  type DataExportReport,
  deriveStoreId,
  type DiagnosticDumpReport,
  type ExportReport,
  type ExportReportCommon,
  performDatadirDump,
  performStoreExport,
  type StoreBackupReport,
  type StoreExportDeps,
  type StoreExportOptions,
  type StoreExportResult,
} from "./export-store";
export {
  type AdoptionDeclaration,
  type AdoptionEffects,
  adoptionEligible,
  type AdoptionOutcome,
  runAdoptionTransition,
  runManualAdoption,
} from "./adoption";
export { createLifecycleSlot, LifecycleBusyError, type LifecycleSlot } from "./lifecycle-slot";
export {
  destroyStoreArtifacts,
  type ElectedEngineWorker,
  ElectedEngineUnconstructibleError,
  quiesceStoreWorker,
  StoreDestroyRefusedError,
  type StoreDestructionRetryOptions,
  type StoreWorkerQuiesceOptions,
  type StoreWorkerQuiesceOutcome,
  wrapEngineWorker,
} from "./worker/attach-sync-client";
export {
  ENGINE_RELOCATED_CODE,
  EngineRelocatedError,
  type EngineRelocatedOutcome,
  type ExecutionLimitConfig,
  ExecutionLimitMismatchError,
} from "./worker/engine-control";
export { createOpfsEffects, type OpfsEffects, type OpfsEffectsDeps } from "./opfs-effects";
export {
  resolveStoreBoot,
  type ResolvedStorageBackend,
  type ResolveStoreBootOptions,
  type StoreBootResolution,
} from "./store-boot";
export {
  InvalidStorePathError,
  NonPersistentStoreError,
  resolveStoreDataDir,
  RestoreTargetExistsError,
  storeIndexedDbDatabaseName,
  storeTargetExists,
} from "./store-path";
export {
  type ConvergenceClient,
  type ConvergenceDriver,
  type ConvergenceDriverOptions,
  type ConvergenceTrigger,
  createBrowserConvergenceTrigger,
  createConvergenceDriver,
  createIntervalConvergenceTrigger,
} from "./convergence";
export { instrumentShapeFetch, setSyncDebugSink, syncDebug, timeAsync } from "./debug";
export {
  type AttachedSyncClient,
  attachSyncClient,
  type AttachSyncClientOptions,
  provisionSyncWorker,
} from "./worker/attach-sync-client";
export { defineSyncWorker, type DefineSyncWorkerOptions, type SyncWorkerHost } from "./worker/define-sync-worker";
export {
  computeLiveDiff,
  type LiveDiffState,
  LiveRowsMaterializer,
  rowKey,
  seedLiveDiffState,
} from "./worker/live-diff";
export type { LiveQueryDiagnostics };
export { createWorkerTokenCache, type WorkerTokenCache } from "./worker/token-cache";
export {
  type AttachAckPayload,
  type AttachPayload,
  type AuthTokenSnapshot,
  BRIDGE_CHANNEL,
  BRIDGE_PROTOCOL_VERSION,
  type BridgeCodec,
  type BridgeEnvelope,
  type BridgeEvent,
  type BridgeMessageType,
  type BridgePort,
  type BridgeTransferable,
  encodeEnvelope,
  type ExportArtefactWire,
  identityCodec,
  isBridgeEnvelope,
  type LiveDiffPayload,
  type LiveInitialPayload,
  postBridgeMessage,
  type ProvisionAckPayload,
  type ProvisionPayload,
  type RpcOp,
  type RpcPayload,
  type RpcResultPayload,
  type SetOnlinePayload,
  type SubscribePayload,
  type TokenRequestPayload,
  type TokenResponsePayload,
  type WakePayload,
} from "./worker/protocol";
export {
  assertLazyRefsActivated,
  buildLazyGuardIndex,
  findReferencedLazyKeysInSql,
  findReferencedSyncedKeysInSql,
  type LazyGuardIndex,
  LazyRelationNotActivatedError,
} from "./lazy-guard";
export {
  type AllMutationsView,
  getAllMutationsView,
  getJournalTable,
  getLocalMetaTable,
  getOverlayTable,
  getReadModelView,
  getSyncedLocalTable,
  getSyncStateView,
  type JournalTable,
  type LocalMetaTable,
  type OverlayTable,
  type ReadModelView,
  type SyncStateView,
} from "./local-tables";
export {
  createMutationsApi,
  type MutationListOptions,
  type MutationListSubscription,
  type MutationsApi,
  type MutationsApiDeps,
  type MutationSummaryDetail,
  type MutationSummarySubscription,
} from "./mutations-api";
export type { LocalStoreVersionEvent };

/**
 * A write-path method was invoked against a client whose `writeReady` stage has not resolved and the caller
 * opted out of awaiting it (ADR-0041). pgxsinkit's own write methods always `await writeReady` internally, so
 * this is NEVER thrown on the stage-1 default path. It is **reserved for the stage-2 opt-out surface** — the
 * ADR's typed pre-`writeReady` rejection for a consumer who chooses not to await — so a pre-`writeReady` write
 * fails loudly rather than silently no-oping. Exported now so that surface is a non-breaking addition later.
 */
export class WriteNotReadyError extends Error {
  constructor() {
    super(
      "pgxsinkit: write attempted before `writeReady` resolved. Await `client.writeReady` (the default write " +
        "methods do this for you) before enqueuing, or gate the write on it.",
    );
    this.name = "WriteNotReadyError";
  }
}

/**
 * The client was stopped/destroyed (or its worker attachment detached) before a boot stage it exposed could
 * resolve (ADR-0041 FIX 2). `stop()`/`destroy()` reject the still-pending `writeReady` and `ready` with this so
 * a parked mutation or an `await client.ready` / `client.start()` fails FAST rather than hanging forever after
 * teardown. `bootSettled` still RESOLVES (it means "teardown completion", not "boot succeeded").
 */
export class ClientDisposedError extends Error {
  constructor() {
    super("pgxsinkit: the client was stopped/destroyed before this readiness stage resolved.");
    this.name = "ClientDisposedError";
  }
}

// The store carries PGlite's own `live` extension (a genuine create-time extension) plus the pgxsinkit
// sync engine's namespace, attached post-create by `createSyncClient` as the `electric` property (ADR-0032
// S1) — no longer a create-time extension. The `electric` part is derived from `createSyncEngine`'s real
// return so the type follows the attached object.
export type ClientPGlite = PGliteWithLive & { electric: SyncEngine["namespace"] };

/**
 * The pre-warmed PGlite boot assets (the WASM modules + filesystem bundle), consumed by
 * {@link createClientPGlite} / {@link CreateSyncClientOptions.pgliteBootAssets}. The host fetches +
 * compiles these on an earlier screen and hands the promise in, so `PGlite.create` skips its own lazy
 * asset load — see the field's JSDoc for the accelerator geometry.
 */
export interface PgliteBootAssets {
  pgliteWasmModule?: WebAssembly.Module;
  initdbWasmModule?: WebAssembly.Module;
  fsBundle?: Blob;
}

/** Options for {@link createClientPGlite}. */
export interface CreateClientPGliteOptions {
  /**
   * Pre-warmed PGlite boot assets (see {@link CreateSyncClientOptions.pgliteBootAssets}). Awaited and
   * passed into `PGlite.create`; a rejected warm is caught to `undefined` (falls back to PGlite's own
   * asset load), so it never fails the create.
   */
  bootAssets?: Promise<PgliteBootAssets>;
  /**
   * @internal Toolkit-internal durability carrier (ADR-0047), NOT a public per-open knob. Durability is
   * registry-declared: {@link createSyncClient} resolves `storage.durability ?? "relaxed"` off its registry
   * and threads the resolved mode in here — the ONE resolution point — for every mint it funnels through this
   * factory (its own boot, the worker provision/spare mint, the pre-expose idb drain read). Defaults to
   * `"relaxed"` when absent and is stamped onto the `boot pglite.create` rail (ADR-0047 D3). On idb, relaxed
   * returns before the whole-datadir snapshot flush and schedules it asynchronously; strict keeps that
   * synchronous snapshot (~100–200ms per statement). On OPFS-repacked the package factory keeps PGlite on its
   * awaited host path: relaxed routine sync asserts health without an ordinary physical flush, while strict
   * flushes arena data before metadata. Initialization, activation, and open-state close retain strict
   * ordering in both OPFS modes.
   */
  durability?: StorageDurability;
  /**
   * @internal Test-only storage-backend override (ADR-0036). `"memory"` resolves the store to a
   * scheme-selected in-memory store — the sanctioned unit-test/ephemeral lane. Never a product
   * configuration: reached only through `@pgxsinkit/client/testing`, never consumer-facing.
   */
  backendOverride?: "memory";
  /**
   * A store-backup tarball to seed the new store from (ADR-0035 decision 6, restore) — a `File`/`Blob` as
   * produced by {@link SyncClient.exportStore}. Passed straight to PGlite's `loadDataDir`, so the created
   * store boots ON the backup's datadir. Restore is a CREATION-path feature: the caller (`createSyncClient`)
   * has already proven the target does not yet exist ({@link storeTargetExists}); this option carries no
   * freshness check of its own. A corrupt/foreign tarball surfaces as a PGlite boot failure here.
   */
  restoreFrom?: File | Blob;
  /**
   * @internal ADR-0049 (capability-driven engine placement) step 10a: the placement probe's result, threaded
   * from the caller (the boot path resolves it via {@link resolveStoreBoot}). Default `false` keeps today's
   * behavior BYTE-IDENTICAL — the store resolves to `idb://` / `file://` / `memory://` exactly as before.
   * `true` resolves the browser store to `opfs://`, which routes to the opfs-repacked factory below.
   */
  hasOpfsSyncAccess?: boolean;
  /**
   * @internal ADR-0049 step 10a: the opfs-repacked factory + store-directory seam, injectable so Bun unit
   * tests exercise the `opfs://` branch WITHOUT loading real WASM/OPFS. In production both default to the real
   * implementations (`createOpfsRepackedPGlite` via a lazy `import()`, and the OPFS effects' store directory
   * handle). Never consumer-facing.
   */
  pgliteFactories?: {
    /** The opfs-repacked PGlite factory; defaults to a lazily-imported `createOpfsRepackedPGlite`. */
    createOpfsRepacked?: (options: CreateOpfsRepackedPGliteOptions) => Promise<OpfsRepackedPGlite>;
    /** The create-if-absent store directory handle for the factory; defaults to the real OPFS effects. */
    getStoreDirectoryHandle?: () => Promise<unknown>;
    /** Backoff between bounded open retries (ms); defaults to a small real delay. Tests pass `0`. */
    retryDelayMs?: number;
  };
}

/**
 * Bounded open-retry budget for the opfs-repacked factory. Covers BOTH transient UnknownError-class failures AND
 * the ADR-0049 fault-matrix "VFS ownership-lock release lag → successor open retries on contention until clear,
 * bounded, then boot failure": when a leader engine is DELIBERATELY terminated (execution-limit verdict) while
 * BUSY, `worker.terminate()` cannot interrupt synchronous WASM, so the dying worker holds its EXCLUSIVE OPFS
 * sync-access handle until its in-flight op finishes and the agent tears down — the successor (respawned in the
 * same tab, immediately, since `awaitOwnershipRelease` is the documented no-op) must retry its open across that
 * lag. The budget below (linear backoff: 100·(1+…+9) ≈ 4.5 s) spans a realistic release lag; a hang longer than
 * the budget still fails closed (bounded), never a stranded half-open store.
 */
const OPFS_OPEN_ATTEMPTS = 10;
/** Default backoff between opfs open retries (ms); grows linearly per attempt (ADR-0049 ownership-release lag). */
const OPFS_OPEN_BACKOFF_MS = 100;
/** The opfs-repacked store extent size (ADR-0049 step 10a). */
const OPFS_STORE_EXTENT_SIZE = 65536;
/**
 * Non-enumerable brand stamped on an opfs-repacked instance {@link createClientPGlite} mints (ADR-0049): the
 * opfs-repacked VFS owns its store on a dedicated OPFS directory and reports NO `dataDir` (a custom VFS, the
 * field is honestly `undefined`), so the BYO "non-persistent" guard ({@link classifyNonPersistentDataDir},
 * which reads only `dataDir`) would wrongly reject it as an in-memory default when it is adopted as a
 * `precreatedPglite` (the provision-then-attach path). This brand lets the guard recognise it as PROVABLY
 * persistent. `Symbol.for` so the brand survives even if the instance is inspected via a different module copy.
 */
const OPFS_REPACKED_PERSISTENT = Symbol.for("pgxsinkit.opfsRepackedPersistent");

/**
 * Open the opfs-repacked factory with bounded retries (3) and a small linear backoff for transient failures,
 * then propagate the last error — a committed store's final failure is HARD, and an uncommitted candidate's
 * likewise propagates (the caller never exposes an unopened store). Kept simple: retry the whole factory call,
 * always, then throw.
 */
async function openWithBoundedRetries<T>(open: () => Promise<T>, backoffMs: number): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= OPFS_OPEN_ATTEMPTS; attempt += 1) {
    try {
      return await open();
    } catch (error) {
      lastError = error;
      if (attempt < OPFS_OPEN_ATTEMPTS && backoffMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, backoffMs * attempt));
      }
    }
  }
  throw lastError;
}

/**
 * Create the raw local PGlite store the sync client runs on — the SAME `PGlite.create` call
 * {@link createSyncClient} makes internally (the `electric` + `live` extensions, pre-warmed boot-asset
 * consumption, and the `boot pglite.create` rail stamp), extracted so exactly one implementation exists
 * and a host can create the store EAGERLY on an earlier screen. Hand the returned (still-pending)
 * instance to {@link CreateSyncClientOptions.precreatedPglite}: the client then owns schema exec, prepare
 * hooks, journal recovery, and registry reconciliation, exactly as its own `storePath` path does.
 *
 * Takes a plain store path (ADR-0036), never a storage URL — the backend is DERIVED from the engine home
 * (capability-selected opfs-repacked with IndexedDB fallback in a browser, or the filesystem on Bun/Node);
 * a scheme-bearing path throws {@link InvalidStorePathError}.
 * Also accepts the testing helper's output (`createClientPGlite(memoryStoreForTests("x"))`) so a test can
 * mint a memory store without naming a backend.
 *
 * The instance is deliberately **schemaless** — the registry-derived local schema is role/registry
 * dependent, so it is applied post-create by `createSyncClient`. The eager create buys only the expensive
 * initdb (+ persistent-store open), which is the dominant cold-boot cost once the WASM is pre-warmed.
 *
 * `bootAssets` is the pre-warmed WASM/fs bundle (see {@link CreateSyncClientOptions.pgliteBootAssets}); a
 * rejected warm is caught to `undefined`, so PGlite falls back to loading its own assets — never a failure.
 */
export async function createClientPGlite(
  store: StorePathInput,
  options?: CreateClientPGliteOptions,
): Promise<ClientPGlite> {
  // Normalise the store argument to a plain path (+ any internal memory override the testing helper carried),
  // then derive the concrete PGlite dataDir URL (ADR-0036) — the single resolution point. A scheme-bearing/
  // empty storePath throws here, so the old dataDir-URL contract fails loudly, never silently re-interpreted.
  const normalised = normaliseStorePathInput(store);
  const storePath = normalised.storePath;
  const backendOverride = options?.backendOverride ?? normalised.backendOverride;
  // An eager precreate is itself a store mint. Before a denied browser home opens its replacement IDB store,
  // settle any durable `deleting` authority exactly as the ordinary createSyncClient path does. Keeping this at
  // the documented precreate factory protects callers outside defineSyncWorker; the worker provision handler
  // carries the same guard separately because it permits a caller-supplied createPglite factory.
  if (options?.hasOpfsSyncAccess !== true && backendOverride !== "memory") {
    await recoverDeniedBootDeletion(storePath);
  }
  // Derive the concrete PGlite dataDir URL (ADR-0036) — the single resolution point. Browser/worker → `idb://`,
  // Bun/Node → `file://`, the sanctioned test lane → `memory://`. A scheme-bearing/empty storePath throws here.
  // ADR-0049 step 10a: when the caller threads the placement probe's grant (`hasOpfsSyncAccess`), the browser
  // store resolves to `opfs://` and routes to the opfs-repacked factory below. Default (undefined/false) leaves
  // this call BYTE-IDENTICAL to today (`resolveStoreDataDir(storePath, backendOverride)`), so no baseline shifts.
  const dataDir = options?.hasOpfsSyncAccess
    ? resolveStoreDataDir(storePath, backendOverride, { hasIndexedDb: true, hasOpfsSyncAccess: true })
    : resolveStoreDataDir(storePath, backendOverride);
  // Stamp the store's scheme on the boot rail (never the full path — it can carry an identity-specific store
  // name): "idb:" / "file:" / "memory:".
  const dataDirScheme = dataDir.slice(0, dataDir.indexOf(":") + 1);
  // Resolve any pre-warmed boot assets BEFORE (and outside) the `boot pglite.create` stamp: the
  // fetch+compile was kicked off on an earlier screen, so this await just retrieves the already-settled
  // result and the stamp measures the create itself. A rejected warm is caught to `undefined` so a failed
  // pre-warm silently falls back to PGlite's own asset loading rather than failing the boot.
  const bootAssets = options?.bootAssets ? await options.bootAssets.catch(() => undefined) : undefined;
  // Durability (ADR-0047) is registry-declared and resolved by createSyncClient; the resolved mode is threaded
  // in via the internal `durability` carrier. Every store minting path (createSyncClient's own create, the
  // worker's default createPglite factory, spare/prewarm mints) funnels through this function, so the
  // `?? "relaxed"` here is the terminal fallback when no mode was threaded (e.g. an eager caller-owned
  // precreate). Maps to PGlite's `relaxedDurability` boolean (`"strict"` → false). On idb the per-query
  // synchronous flush dominates write latency; relaxing it schedules the flush asynchronously instead.
  const relaxedDurability = (options?.durability ?? "relaxed") !== "strict";

  // ADR-0049 step 10a — the `opfs://` branch. PGlite does NOT accept `opfs://` as a dataDir; instead the
  // opfs-repacked factory owns the store on a dedicated OPFS directory. The factory is loaded LAZILY (a
  // dynamic `import()`) and both it and the store-directory handle are injectable (`pgliteFactories`) so a Bun
  // unit test drives this branch with no real WASM/OPFS. Durability maps from the same `relaxedDurability`
  // resolution above (ADR-0047's default logic is untouched): `relaxed` → the factory's `"relaxed"`, else
  // `"strict"`. The open is retried a bounded number of times for transient failures, then propagates.
  if (dataDir.startsWith("opfs://")) {
    const opfsPglite = (await timeAsync(
      "boot pglite.create",
      async () => {
        const createOpfsRepacked =
          options?.pgliteFactories?.createOpfsRepacked ??
          (await import("@pgxsinkit/pglite-opfs-repacked")).createOpfsRepackedPGlite;
        const getStoreDirectoryHandle =
          options?.pgliteFactories?.getStoreDirectoryHandle ??
          (() => createOpfsEffects(storePath).getStoreDirectoryHandle());
        const directory = await getStoreDirectoryHandle();
        return openWithBoundedRetries(
          () =>
            createOpfsRepacked({
              directory: directory as CreateOpfsRepackedPGliteOptions["directory"],
              durability: relaxedDurability ? "relaxed" : "strict",
              extentSize: OPFS_STORE_EXTENT_SIZE,
              // The store is engine-less by construction (only `live` is a create-time extension); the sync
              // engine attaches post-create (ADR-0032 S1). Restore + pre-warmed boot assets ride the same
              // `pglite` sub-options the idb path uses.
              pglite: {
                ...(bootAssets ?? {}),
                ...(options?.restoreFrom ? { loadDataDir: options.restoreFrom } : {}),
                extensions: { live },
              },
            }),
          options?.pgliteFactories?.retryDelayMs ?? OPFS_OPEN_BACKOFF_MS,
        );
      },
      { ...(dataDirScheme ? { dataDir: dataDirScheme } : {}), relaxedDurability },
    )) as unknown as ClientPGlite;
    // Brand it PROVABLY persistent: the opfs-repacked VFS reports no `dataDir`, so without this the BYO
    // non-persistent guard would reject it when it is adopted as a `precreatedPglite` (provision-then-attach).
    try {
      Object.defineProperty(opfsPglite, OPFS_REPACKED_PERSISTENT, {
        value: true,
        enumerable: false,
        configurable: true,
      });
    } catch {
      // A frozen/exotic instance — the guard still falls back to its dataDir classification (best-effort brand).
    }
    return opfsPglite;
  }

  const pglite = (await timeAsync(
    "boot pglite.create",
    () => {
      const createOptions: PGliteOptions = {
        ...(bootAssets ?? {}),
        relaxedDurability,
        // Restore (ADR-0035 decision 6): seed the brand-new store from the backup tarball. PGlite's
        // `loadDataDir` unpacks it into the datadir being created, so the store boots ON the backup's bytes —
        // the whole synced cache, Overlay, and Mutation journal that travelled inside it. Absent on a normal
        // create (the store initdbs empty).
        ...(options?.restoreFrom ? { loadDataDir: options.restoreFrom } : {}),
        // Only PGlite's own `live` extension is a create-time extension; the pgxsinkit sync engine is NOT
        // (ADR-0032 S1) — it is a plain module `createSyncClient` attaches post-create as `pg.electric`. So
        // a store minted here is deliberately ENGINE-LESS by construction: a spare/pre-warmed store (e.g.
        // the board's login-screen mint) carries no engine, no shape streams, and no Electric connections
        // until it is claimed and handed to `createSyncClient`.
        extensions: {
          live,
        },
      };
      // idb/file/memory take the dataDir-string form; upstream PGlite's own scheme parser selects the backend.
      return PGlite.create(dataDir, createOptions);
    },
    // Stamp the resolved durability mode + store scheme so every boot-rail capture shows the mode and lane the
    // store was created under (ADR-0047 diagnosability).
    { ...(dataDirScheme ? { dataDir: dataDirScheme } : {}), relaxedDurability },
    // `as unknown as` because the raw store is deliberately engine-less here (only `live` is a create-time
    // extension); `createSyncClient` provisions the `electric` namespace post-create (ADR-0032 S1).
  )) as unknown as ClientPGlite;
  return pglite;
}

// ─── ADR-0049 step 11b: adoption boot wiring (declaration-gated) ──────────────────────────────────────
// The pure adoption orchestrator (`adoption.ts`, step 11a) is effect-injected; here we build the REAL effects
// and CALL the transition at the right point in the boot. The transition runs BEFORE any engine is exposed
// (invariant 3 — pre-expose exclusivity), consults the declaration FIRST (invariant 4 — default off), and
// deletes the idb predecessor ONLY after the commitment barrier publishes (invariants 3/4).

/**
 * A store is being actively held by a live in-process client. The manual {@link adoptStore} API is a
 * CREATION-PATH operation (like `restoreFrom`): it must be called INSTEAD of {@link createSyncClient}, never
 * against a store an open client already owns — an idb→opfs migration under a live engine would strand the
 * engine's writes. Detected via a module-level live-store registry (every {@link createSyncClient} that mints a
 * client-owned store registers its path and unregisters on `stop()`/`destroy()`).
 */
export class StoreInUseError extends Error {
  constructor(storePath: string) {
    super(
      `[pgxsinkit] adoptStore(${JSON.stringify(storePath)}) refused: a live client is currently holding this ` +
        "store. Adoption is a creation-path migration — call it INSTEAD of createSyncClient, before any client " +
        "opens the store (stop/destroy the existing client first).",
    );
    this.name = "StoreInUseError";
  }
}

/** The paths of stores currently held by a live in-process client — the {@link adoptStore} live-store guard. */
const liveStorePaths = new Set<string>();

/** Internal-only marker for the live adoption executor's inner candidate boot. Never exported or consumer-set. */
const ADOPTION_CANDIDATE_BUILD: unique symbol = Symbol("pgxsinkit.adoptionCandidateBuild");
type AdoptionCandidateBuildOptions = { [ADOPTION_CANDIDATE_BUILD]?: true };
/** Internal-only PGlite boundary used by the real adoption recursion test; never exported or consumer-set. */
const INTERNAL_PGLITE_CREATE: unique symbol = Symbol("pgxsinkit.internalPgliteCreate");
type InternalPgliteCreateOptions = { [INTERNAL_PGLITE_CREATE]?: typeof createClientPGlite };

/**
 * @internal Injectable seams for the boot-time adoption decision (step 11b). Real defaults in production; unit
 * tests inject fakes so the wiring is exercised without real IndexedDB/OPFS/WASM. Shared by the automatic boot
 * path ({@link runBootAdoption}) and the manual {@link adoptStore} API.
 */
export interface AdoptionWiringSeams {
  /** Non-creating recordless idb existence check (adoption only ever migrates an EXISTING idb store). */
  idbStoreExists?: (storePath: string) => Promise<boolean>;
  /** The boot classifier + executor (`store-boot.ts`) — its verdict drives {@link adoptionEligible}. */
  resolveStoreBoot?: (storePath: string) => Promise<StoreBootResolution>;
  /** The real {@link AdoptionEffects} factory; injected in tests with recording fakes. */
  buildEffects?: (storePath: string) => AdoptionEffects;
  /** Diagnostics sink; defaults to the boot debug rail. */
  log?: (message: string, data?: Record<string, unknown>) => void;
  /** The store-meta IndexedDB seam (defaults to `globalThis.indexedDB`). */
  meta?: StoreMetaDeps;
  /** The OPFS root seam (defaults to `navigator.storage.getDirectory`). */
  opfs?: OpfsEffectsDeps;
  /** The external PGlite create boundary; the real adoption transition and inner createSyncClient remain intact. */
  createPglite?: typeof createClientPGlite;
  /** The live-store guard the manual {@link adoptStore} consults (defaults to the module-level registry). */
  isStoreLive?: (storePath: string) => boolean;
}

/** The bootstrap context an adoption transition's real effects need (registry + endpoints + auth + gate). */
interface AdoptionBootContext<TRegistry extends SyncTableRegistry> {
  registry: TRegistry;
  electricUrl: string;
  batchWriteUrl: string;
  getAuthToken?: () => Promise<string | undefined>;
  requestHeaders?: Record<string, string>;
  /** The effective app-level sync toggle — a `false` here fails the gate (adoption cannot reconstruct offline-by-config). */
  syncEnabled: boolean;
  /** Bounded wait for the eager Consistency groups' initial catch-up before the gate fails (offline/unauthorized). */
  gateDeadlineMs?: number;
  meta?: StoreMetaDeps;
  opfs?: OpfsEffectsDeps;
  createPglite?: typeof createClientPGlite;
}

/** Delete-if-present the store's PGlite idb database; only `onsuccess` proves completion. */
function deleteAdoptionIdbPredecessor(storePath: string, meta?: StoreMetaDeps): Promise<void> {
  const idb =
    meta != null && "indexedDB" in meta
      ? (meta.indexedDB as unknown as IdbDeleteLike | undefined)
      : (globalThis as { indexedDB?: IdbDeleteLike }).indexedDB;
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
    // `blocked` is nonterminal: the queued request may still succeed after the blocker closes. Do not lie to
    // the adoption transition by reporting predecessor cleanup complete before `onsuccess`.
    request.onblocked = () => undefined;
    timeout = setTimeout(() => finish(new Error(`indexedDB deletion timed out while blocked for ${name}`)), 5_000);
  });
}

/** The minimal structural `indexedDB.deleteDatabase` surface (no DOM lib) — mirrors `store-boot.ts`. */
interface IdbDeleteLike {
  deleteDatabase(name: string): {
    error?: unknown;
    onsuccess: (() => void) | null;
    onerror: (() => void) | null;
    onblocked?: (() => void) | null;
  };
}

/**
 * Build the REAL {@link AdoptionEffects} the transition drives (step 11b). The idb engine is booted PRE-EXPOSE
 * (never surfaced) solely to read the drain journal; the opfs candidate is built via the normal server bootstrap
 * (`createSyncClient` with `syncEnabled: true`, `freshStore: true`, adoption OFF so it never recurses) and gated
 * on the eager Consistency groups' catch-up; the shared commitment barrier (`runCommitmentBarrier`) commits it;
 * only THEN is the idb predecessor deleted.
 */
function buildRealAdoptionEffects<TRegistry extends SyncTableRegistry>(
  storePath: string,
  ctx: AdoptionBootContext<TRegistry>,
): AdoptionEffects {
  const opfs = createOpfsEffects(storePath, ctx.opfs);
  const createPglite = ctx.createPglite ?? createClientPGlite;
  const setPhase = (phase: StoreMetaPhase): Promise<void> =>
    writeStoreMetaRecord(storePath, { phase, updatedAt: Date.now() }, ctx.meta);
  return buildAdoptionEffects({
    async readIdbJournal() {
      // Open the idb engine PRE-EXPOSE (strict durability, no opfs grant → idb backend) solely to read the drain
      // journal. Never surfaced to tabs (invariant 3). Because this is a READ-ONLY drain probe (no write ever
      // reaches it), the engine is CLOSED here — releasing every idb handle so a deferred (`journal-owed`) boot
      // can re-open the store cleanly, and so the drained path deletes the idb database with nothing holding it.
      // `strictSyncAndCloseIdb` is therefore a no-op below: the "strict close" is trivially satisfied — an
      // unwritten engine has nothing to flush, and the handle is already released.
      const idbPglite = await createPglite(storePath, { durability: "strict" });
      try {
        const runtime = createMutationRuntime({
          db: idbPglite,
          registry: ctx.registry,
          batchWriteUrl: ctx.batchWriteUrl,
          ownsMetaTable: true,
        });
        const stats = await runtime.readMutationStats();
        return {
          pending: stats.pendingCount,
          sending: stats.sendingCount,
          acked: stats.ackedCount,
          failed: stats.failedCount,
          quarantined: stats.quarantinedCount,
          conflicted: stats.conflictedCount,
          rejected: stats.rejectedCount,
        };
      } finally {
        await idbPglite.close();
      }
    },
    setPhase,
    async buildCandidate() {
      // Adoption reconstructs from the server — a sync-disabled boot cannot: fail the gate BEFORE minting.
      if (!ctx.syncEnabled) {
        throw new Error(
          "[pgxsinkit] adoption gate unmet: sync is disabled (`syncEnabled: false`), so the opfs successor " +
            "cannot be reconstructed online. The idb store stays authoritative.",
        );
      }
      // Build the opfs candidate via the NORMAL server bootstrap path (its own `createClientPGlite` mints the
      // opfs store at the store directory). `freshStore: true` overlaps catch-up with the local phases; adoption
      // is OFF so this never recurses; the phase stays `adopting` (set by the caller) for crash recovery.
      const candidate = await createSyncClient<TRegistry>({
        registry: ctx.registry,
        electricUrl: ctx.electricUrl,
        batchWriteUrl: ctx.batchWriteUrl,
        storePath,
        hasOpfsSyncAccess: true,
        freshStore: true,
        syncEnabled: true,
        // Durability is registry-declared (ADR-0047): this candidate boot resolves it from `ctx.registry`, the
        // SAME registry as the store it succeeds, so the opfs successor is minted under the declared mode.
        [ADOPTION_CANDIDATE_BUILD]: true,
        [INTERNAL_PGLITE_CREATE]: createPglite,
        ...(ctx.getAuthToken ? { getAuthToken: ctx.getAuthToken } : {}),
        ...(ctx.requestHeaders ? { requestHeaders: ctx.requestHeaders } : {}),
      } as CreateSyncClientOptions<TRegistry> & AdoptionCandidateBuildOptions & InternalPgliteCreateOptions);
      const strictSync = (candidate.pglite as unknown as { strictSync?: () => Promise<void> }).strictSync;
      if (typeof strictSync !== "function") {
        await candidate.stop().catch(() => undefined);
        throw new Error(
          "[pgxsinkit] adoption: the candidate store does not expose `strictSync()` — the commitment barrier " +
            "requires an OPFS-repacked engine (data-before-authority, invariant 3).",
        );
      }
      return {
        ready: candidate.ready,
        strictSync: () => strictSync.call(candidate.pglite),
        close: () => candidate.stop(),
      };
    },
    publishSentinel: () => opfs.publishSentinel(),
    deleteSentinel: () => opfs.deleteSentinel(),
    deleteStoreDirectory: () => opfs.deleteStoreDirectory(),
    deleteIdbPredecessor: () => deleteAdoptionIdbPredecessor(storePath, ctx.meta),
    ...(ctx.gateDeadlineMs != null ? { gateDeadlineMs: ctx.gateDeadlineMs } : {}),
  });
}

/** The default real seams for the adoption boot decision (production wiring). */
function realAdoptionSeams<TRegistry extends SyncTableRegistry>(
  ctx: AdoptionBootContext<TRegistry>,
  seams?: AdoptionWiringSeams,
): Required<Pick<AdoptionWiringSeams, "idbStoreExists" | "resolveStoreBoot" | "buildEffects" | "log">> {
  return {
    idbStoreExists: seams?.idbStoreExists ?? ((sp: string) => defaultIdbStoreExists(sp, ctx.meta)),
    resolveStoreBoot:
      seams?.resolveStoreBoot ??
      ((sp: string) =>
        resolveStoreBoot(sp, {
          hasOpfsSyncAccess: true,
          ...(ctx.meta || ctx.opfs
            ? { deps: { ...(ctx.meta ? { meta: ctx.meta } : {}), ...(ctx.opfs ? { opfs: ctx.opfs } : {}) } }
            : {}),
        })),
    buildEffects: seams?.buildEffects ?? ((sp: string) => buildRealAdoptionEffects(sp, ctx)),
    log: seams?.log ?? ((message, data) => syncDebug(message, data)),
  };
}

/**
 * @internal The boot-time AUTOMATIC adoption decision (step 11b). Returns whether the subsequent client-owned
 * mint should open the OPFS backend (`bootHasOpfs`) after any adoption transition ran. Adoption ONLY ever
 * migrates an EXISTING idb store (a committed-opfs or virgin store has no idb predecessor), so a non-creating
 * idb existence check gates the whole path; then the boot classifier's verdict drives {@link adoptionEligible}.
 * On `adopted: true` the opfs successor is committed and the mint opens it; on any `adopted: false` (owed
 * journal / gate unmet / barrier failed) the idb store stays authoritative and the mint opens idb.
 */
export async function runBootAdoption<TRegistry extends SyncTableRegistry>(
  storePath: string,
  declaration: AdoptionDeclaration,
  ctx: AdoptionBootContext<TRegistry>,
  seamsOverride?: AdoptionWiringSeams,
): Promise<{ bootHasOpfs: boolean; outcome?: AdoptionOutcome }> {
  const seams = realAdoptionSeams(ctx, seamsOverride);
  // Adoption migrates an EXISTING idb store; nothing to adopt otherwise (committed-opfs / virgin have no idb).
  if (!(await seams.idbStoreExists(storePath))) return { bootHasOpfs: true };
  const resolution = await seams.resolveStoreBoot(storePath);
  const verdict = resolution.verdict;
  if (verdict === undefined || !adoptionEligible(declaration, verdict, true)) {
    // The classifier already executed any recovery (e.g. an interrupted adoption). Honour its resolved backend.
    const bootHasOpfs = resolution.storageBackend === "opfs-repacked";
    seams.log("boot adoption not eligible — using the classifier's resolved backend", {
      action: verdict?.action,
      storageBackend: resolution.storageBackend,
    });
    return { bootHasOpfs };
  }
  const outcome = await runAdoptionTransition(declaration, seams.buildEffects(storePath));
  if (outcome.adopted) {
    seams.log("boot adoption committed the opfs successor; idb predecessor deleted", {
      ...(outcome.predecessorCleanupPending ? { predecessorCleanupPending: outcome.predecessorCleanupPending } : {}),
    });
    return { bootHasOpfs: true, outcome };
  }
  seams.log("boot adoption deferred/failed — idb stays authoritative", {
    reason: outcome.reason,
    ...(outcome.error ? { error: outcome.error } : {}),
  });
  return { bootHasOpfs: false, outcome };
}

// ─── ADR-0049 step 11c: FRESH/RESTORE commitment boot wiring ───────────────────────────────────────────
// Step 11b wired the DECLARATION-gated adoption transition; it left one gap (its own commit message names it):
// a virgin (or restored) opfs boot minted `opfs://` straight through `resolveStoreDataDir` WITHOUT the phase
// machine — no candidate record, no commitment barrier, no sentinel. That violated invariant 3 (an uncommitted
// candidate is never exposed to writes; commitment precedes exposure — D7) and invariant 12 (record written at
// creation, completed before exposure). This wiring closes it: EVERY browser opfs boot the client owns now
// routes through the boot phase machine, and a fresh/restore candidate is committed by the shared barrier
// BEFORE exposure. It COMPOSES with 11b — the declared-adoption-on-idb-store decision runs FIRST; this path
// runs only when the opfs grant survives it (so an already-committed successor resolves `open-committed` with
// no re-commit, and a deferred adoption's `false` grant short-circuits to idb).

/**
 * @internal Injectable seams for the FRESH/RESTORE commitment boot wiring (step 11c). Real defaults in
 * production (`globalThis.indexedDB` / `navigator.storage`); unit tests inject fakes so the phase machine and
 * the commitment barrier are exercised without real IndexedDB / OPFS / WASM. Mirrors {@link AdoptionWiringSeams}:
 * the IO surfaces are faked, the barrier runs over the REAL `resolveStoreBoot` / `createOpfsEffects` /
 * `writeStoreMetaRecord` so the record-before-directory ordering and the sentinel/phase writes are real.
 */
export interface FreshCommitmentSeams {
  /** The boot classifier + executor (`store-boot.ts`); its verdict decides whether a candidate needs the barrier. */
  resolveStoreBoot?: (storePath: string) => Promise<StoreBootResolution>;
  /** Diagnostics sink; defaults to the boot debug rail. */
  log?: (message: string, data?: Record<string, unknown>) => void;
  /** The store-meta IndexedDB seam (defaults to `globalThis.indexedDB`). */
  meta?: StoreMetaDeps;
  /** The OPFS root seam (defaults to `navigator.storage.getDirectory`). */
  opfs?: OpfsEffectsDeps;
  /** The recordless non-creating idb existence check (defaults to store-meta's `idbStoreExists`). */
  idbExists?: (storePath: string) => Promise<boolean>;
}

/** The PRE-MINT outcome of {@link resolveFreshBoot}: the resolved backend and whether the milestone owes a barrier. */
export interface FreshBootResolution {
  /** Whether the client-owned mint should open the OPFS backend (a classification landing on idb flips this false). */
  bootHasOpfs: boolean;
  /** The resolved backend, for diagnostics (ADR-0049). */
  storageBackend: ResolvedStorageBackend;
  /** The executed boot verdict (absent on the short-circuited non-opfs path). */
  verdict?: StoreBootVerdict;
  /**
   * Whether an UNCOMMITTED opfs candidate was stood up that the shared commitment barrier must promote at the
   * local-init milestone ({@link runFreshCommitmentBarrier}) BEFORE exposure. True only for the two fresh
   * candidate verdicts (`virgin-create` / `delete-candidate-and-rebuild`) landing on `opfs-repacked`; a
   * committed store (`open-committed` / `repair-record-then-open-committed`) is already committed (no re-run).
   */
  needsCommitmentBarrier: boolean;
}

/**
 * Map a resolved PGlite dataDir URL to the ADR-0049 decision 12 `storageBackend` diagnostic — the inverse of
 * {@link resolveStoreDataDir}'s scheme selection (`opfs://` → opfs-repacked, `idb://` → idbfs, `file://` →
 * filesystem, `memory://` → memory). Used to stamp the BootReport at the single client-owned mint seam. Returns
 * `undefined` for an unrecognised scheme (a BYO instance whose dataDir the toolkit never minted — e.g. an
 * opfs-repacked wrapper that does not self-report an `opfs://` dataDir), so the field is then honestly omitted.
 */
function storageBackendFromDataDir(dataDir: string | undefined): NonNullable<BootReport["storageBackend"]> | undefined {
  if (dataDir == null) return undefined;
  if (dataDir.startsWith("opfs://")) return "opfs-repacked";
  if (dataDir.startsWith("idb://")) return "idbfs";
  if (dataDir.startsWith("file://")) return "filesystem";
  if (dataDir.startsWith("memory://")) return "memory";
  return undefined;
}

/** Does a boot verdict stand up an UNCOMMITTED opfs candidate the commitment barrier must promote (invariant 3)? */
function verdictNeedsCommitmentBarrier(
  verdict: StoreBootVerdict | undefined,
  storageBackend: ResolvedStorageBackend,
): boolean {
  if (storageBackend !== "opfs-repacked") return false;
  return verdict?.action === "virgin-create" || verdict?.action === "delete-candidate-and-rebuild";
}

/**
 * @internal ADR-0049 step 11c — Phase 1 (PRE-MINT). Route a client-owned OPFS-home boot through the boot phase
 * machine ({@link resolveStoreBoot}) so: a virgin/restore boot stands up an UNCOMMITTED opfs candidate (record
 * BEFORE directory, invariant 12); a committed store resolves `open-committed` (no barrier re-run); a recordless
 * idb store (adoption not declared) downgrades to idb (invariant 14 — never a fresh opfs mint over an existing
 * idb store's data); and an interrupted destruction/adoption/candidate is recovered by the classifier itself. Returns
 * whether the mint opens opfs and whether the local-init milestone must run the commitment barrier. A `false`
 * `hasOpfsSyncAccess` SHORT-CIRCUITS (an idbfs/file home opens directly — the opfs commitment phase machine never
 * runs), which is also how this composes with 11b: a deferred/failed adoption flips the grant to `false`.
 */
export async function resolveFreshBoot(
  storePath: string,
  hasOpfsSyncAccess: boolean,
  backendOverride: "memory" | undefined,
  seams?: FreshCommitmentSeams,
): Promise<FreshBootResolution> {
  // Guard: only the browser opfs engine home routes through the phase machine. No grant (or the memory test
  // lane, which has no meta machinery) → the idb/file/memory path is untouched except that a browser denied
  // boot must finish an already-authorized `deleting` handoff before it creates a replacement IDB store.
  if (!hasOpfsSyncAccess || backendOverride === "memory") {
    if (!hasOpfsSyncAccess && backendOverride !== "memory") await recoverDeniedBootDeletion(storePath);
    return {
      bootHasOpfs: false,
      storageBackend: backendOverride === "memory" ? "memory" : "idbfs",
      needsCommitmentBarrier: false,
    };
  }
  const runResolve =
    seams?.resolveStoreBoot ??
    ((sp: string) =>
      resolveStoreBoot(sp, {
        hasOpfsSyncAccess: true,
        ...(seams?.meta || seams?.opfs || seams?.idbExists
          ? {
              deps: {
                ...(seams?.meta ? { meta: seams.meta } : {}),
                ...(seams?.opfs ? { opfs: seams.opfs } : {}),
                ...(seams?.idbExists ? { idbExists: seams.idbExists } : {}),
              },
            }
          : {}),
      }));
  const resolution = await runResolve(storePath);
  const bootHasOpfs = resolution.storageBackend === "opfs-repacked";
  const needsCommitmentBarrier = verdictNeedsCommitmentBarrier(resolution.verdict, resolution.storageBackend);
  (seams?.log ?? ((message, data) => syncDebug(message, data)))("boot fresh commitment resolved the boot backend", {
    action: resolution.verdict?.action,
    storageBackend: resolution.storageBackend,
    needsCommitmentBarrier,
  });
  return {
    bootHasOpfs,
    storageBackend: resolution.storageBackend,
    ...(resolution.verdict ? { verdict: resolution.verdict } : {}),
    needsCommitmentBarrier,
  };
}

/**
 * @internal ADR-0049 step 11c — Phase 2 (LOCAL-INIT MILESTONE, PRE-EXPOSE). Run the shared commitment barrier
 * ({@link runCommitmentBarrier}: `strictSync()` returns with VFS health good → publish the sentinel →
 * `opfs-committed` phase) over the live engine's `strictSync()`. The caller invokes this ONLY after the
 * FRESH/RESTORE provenance gate has passed (successful local initialization/recovery — the local-read core is
 * proven; D7 requires NO server for fresh/restore) and BEFORE exposure. A throw PROPAGATES out of the boot: the
 * barrier is all-or-nothing, so nothing is published, the `opfs-candidate` record survives, and the next boot's
 * classifier tears the candidate down and rebuilds (`delete-candidate-and-rebuild`) — nothing was ever exposed,
 * nothing strands (invariant 3). Real effects run over `createOpfsEffects` + `writeStoreMetaRecord`, injectable
 * for unit tests via {@link FreshCommitmentSeams}.
 */
/**
 * Extract the live engine's `strictSync()` from an opfs-repacked store for the commitment barrier (mirrors the
 * adoption path's `commitCandidate`). The commitment barrier requires it (data-before-authority, invariant 3);
 * a store that does not expose it is not an OPFS-repacked engine, which is a boot invariant violation.
 */
function resolveEngineStrictSync(pglite: ClientPGlite): () => Promise<void> {
  const strictSync = (pglite as unknown as { strictSync?: () => Promise<void> }).strictSync;
  if (typeof strictSync !== "function") {
    throw new Error(
      "[pgxsinkit] fresh commitment: the opfs store does not expose `strictSync()` — the commitment barrier " +
        "requires an OPFS-repacked engine (data-before-authority, invariant 3).",
    );
  }
  return () => strictSync.call(pglite);
}

export async function runFreshCommitmentBarrier(
  storePath: string,
  strictSyncReturns: () => Promise<void>,
  seams?: FreshCommitmentSeams,
): Promise<void> {
  const opfs = createOpfsEffects(storePath, seams?.opfs);
  await runCommitmentBarrier({
    strictSyncReturns,
    publishSentinel: () => opfs.publishSentinel(),
    setPhase: (phase) => writeStoreMetaRecord(storePath, { phase, updatedAt: Date.now() }, seams?.meta),
  });
  (seams?.log ?? ((message, data) => syncDebug(message, data)))(
    "boot fresh commitment barrier committed the opfs store",
    {
      storePath,
    },
  );
}

/**
 * Format an opfs open failure into the VERBATIM `Name: message` the `storageFallbackReason` diagnostic carries
 * (ADR-0049 decision 12). A non-Error throw is stringified.
 */
function formatOpenFailureReason(error: unknown): string {
  if (error instanceof Error) return `${error.name || "Error"}: ${error.message}`;
  return String(error);
}

/**
 * @internal ADR-0049 D6 — the VIRGIN-UNCREATABLE session idbfs fallback (plan step 13 gap; plan fault row "opfs
 * uncreatable, virgin → Session idbfs fallback after bounded retries, record written"). The COUNTERPART to
 * {@link runFreshCommitmentBarrier}: instead of committing a candidate that opened, this handles a candidate
 * that could NOT open. When the client-owned opfs mint exhausts {@link openWithBoundedRetries} on a
 * VIRGIN/candidate boot, tear the never-committed candidate down and re-mint on idbfs FOR THIS SESSION. Returns
 * the verbatim open-failure reason (`Name: message`) the caller stamps via the step-13 `storageFallbackReason`
 * seam.
 *
 * APPLIES ONLY to the positive-absence virgin/candidate path. {@link createSyncClient} gates this on
 * `commitmentBarrierPending` (= {@link FreshBootResolution.needsCommitmentBarrier}), which is true ONLY for
 * `virgin-create` / `delete-candidate-and-rebuild` landing on opfs — a boot that published NO sentinel and holds
 * an unexposed candidate. A COMMITTED store (record `opfs-committed`, or a present sentinel reading committed →
 * `open-committed` / `repair-record-then-open-committed`) owes NO barrier, so the gate is false and its open
 * failure PROPAGATES HARD (CONTEXT § "Commitment marker": "once committed, any opfs boot failure is a hard
 * failure"; accepted-risk register). This function is therefore never reached for a committed store.
 *
 * Teardown: delete-if-present the sentinel (a stale sentinel is impossible before the barrier, but symmetric
 * with `delete-candidate-and-rebuild`) AND the candidate directory, then set the meta record to
 * `idb-authoritative` — NOT delete it.
 *
 * STICKINESS (reconciling the plan's D6 "non-sticky, opfs retried next boot" verdict with the LATER phase
 * machine): the record is the first-use authority, and an idb fallback store IS a recorded idb store (boot
 * classification 7's caution / invariant 14 — the same as the no-handle virgin path, which already records
 * `idb-authoritative`). So the next boot classifies `boot-idb-authoritative` (classification 5) and boots idb;
 * it does NOT loop through virgin re-creation each boot. Retry-to-opfs is the DESIGNED non-destructive ADOPTION
 * re-entry (a declared consumer re-adopts to opfs on a later drained boot) — the phase machine's intended,
 * supervised re-entry — rather than a destructive per-boot re-probe. This keeps the fault row true ("record
 * written") and the fault-row semantics honest for the composition actually shipped.
 */
export async function fallbackVirginCandidateToIdb(
  storePath: string,
  openError: unknown,
  seams?: FreshCommitmentSeams,
): Promise<string> {
  const opfs = createOpfsEffects(storePath, seams?.opfs);
  await opfs.deleteSentinel();
  await opfs.deleteStoreDirectory();
  await writeStoreMetaRecord(storePath, { phase: "idb-authoritative", updatedAt: Date.now() }, seams?.meta);
  const reason = formatOpenFailureReason(openError);
  (seams?.log ?? ((message, data) => syncDebug(message, data)))(
    "boot fresh commitment: opfs candidate uncreatable after bounded retries — session idbfs fallback",
    { storePath, reason },
  );
  return reason;
}

/** Options for the manual {@link adoptStore} API — the creation-path adoption trigger. */
export interface AdoptStoreOptions<TRegistry extends SyncTableRegistry> {
  registry: TRegistry;
  electricUrl: string;
  batchWriteUrl: string;
  /** The store to adopt (a plain path/name; the idb predecessor is migrated to a committed OPFS successor). */
  storePath?: string;
  getAuthToken?: () => Promise<string | undefined>;
  requestHeaders?: Record<string, string>;
  syncEnabled?: boolean;
  /** Bounded wait (ms) for the eager Consistency groups' catch-up before the gate fails closed. */
  gateDeadlineMs?: number;
  /** @internal test seams (fake effects / idb existence / meta+opfs IO). */
  seams?: AdoptionWiringSeams;
}

/**
 * The MANUAL adoption API (ADR-0049 D7, plan step 11b): migrate an EXISTING idb-authoritative store into a
 * committed OPFS successor ON DEMAND, without the automatic {@link CreateSyncClientOptions.adoption} declaration
 * — the consumer's explicit call IS the authorization (they were told to export/migrate any local-only data
 * first). Like `restoreFrom` it is a CREATION-PATH operation: call it INSTEAD of {@link createSyncClient},
 * before any client opens the store — it REFUSES with {@link StoreInUseError} while a live in-process client
 * holds the store. The drain predicate still gates it (a store that owes the server work is not adoptable), and
 * every failure recovery is identical to the automatic path (idb stays authoritative; nothing strands).
 */
export async function adoptStore<const TRegistry extends SyncTableRegistry>(
  options: AdoptStoreOptions<TRegistry>,
): Promise<AdoptionOutcome> {
  const storePath = options.storePath ?? "pgxsinkit-overlay-v1";
  const isStoreLive = options.seams?.isStoreLive ?? ((sp: string) => liveStorePaths.has(sp));
  if (isStoreLive(storePath)) throw new StoreInUseError(storePath);
  const ctx: AdoptionBootContext<TRegistry> = {
    registry: options.registry,
    electricUrl: options.electricUrl,
    batchWriteUrl: options.batchWriteUrl,
    ...(options.getAuthToken ? { getAuthToken: options.getAuthToken } : {}),
    ...(options.requestHeaders ? { requestHeaders: options.requestHeaders } : {}),
    syncEnabled: options.syncEnabled ?? true,
    ...(options.gateDeadlineMs != null ? { gateDeadlineMs: options.gateDeadlineMs } : {}),
    ...(options.seams?.meta ? { meta: options.seams.meta } : {}),
    ...(options.seams?.opfs ? { opfs: options.seams.opfs } : {}),
    ...(options.seams?.createPglite ? { createPglite: options.seams.createPglite } : {}),
  };
  const effects = options.seams?.buildEffects?.(storePath) ?? buildRealAdoptionEffects(storePath, ctx);
  return runManualAdoption(effects);
}

export interface CreateSyncClientOptions<TRegistry extends SyncTableRegistry> {
  registry: TRegistry;
  electricUrl: string;
  batchWriteUrl: string;
  getAuthToken?: () => Promise<string | undefined>;
  /**
   * Static headers added to **every** read-shape and write request, alongside the per-request
   * `Authorization` (which always wins). The toolkit is agnostic about deployment-gateway
   * credentials, so this is the seam for them — e.g. a Supabase Cloud `apikey` header the platform
   * function gateway expects. Sent even when no `getAuthToken` is supplied.
   */
  requestHeaders?: Record<string, string>;
  /**
   * Extra static headers sent on the **write** path only (the mutation-flush POST), merged over
   * {@link requestHeaders} (`{...requestHeaders, ...writeRequestHeaders}`). Read/shape requests never
   * see these. The seam exists because the two ingress points have opposite geometry: the write
   * function is DB-bound, so pinning it to the database's region (e.g. an `x-region` header) keeps its
   * chatty function→DB protocol on a ~1ms loop; the read proxy's upstream is a globally-distributed
   * CDN (Electric Cloud), so pinning reads away from the caller pays intercontinental round trips per
   * catch-up hop. Put region/DB-affinity headers here; keep gateway credentials the reads also need
   * (e.g. `apikey`) in the shared {@link requestHeaders}.
   */
  writeRequestHeaders?: Record<string, string>;
  syncEnabled?: boolean;
  /**
   * The local store's name (ADR-0036) — a PLAIN path/name, never a PGlite storage URL. The storage backend
   * is DERIVED from the engine home (capability-selected opfs-repacked with IndexedDB fallback in a browser,
   * or the filesystem on Bun/Node); a
   * scheme-bearing string (anything containing `://`) is rejected with {@link InvalidStorePathError}
   * at boot. Defaults to a built-in overlay store name when omitted. A memory-backed store is not a product
   * configuration — for the test/ephemeral lane, spread `memoryStoreForTests(...)` from
   * `@pgxsinkit/client/testing` instead of naming one here.
   */
  storePath?: string;
  /**
   * @internal Toolkit-internal WIRE-declaration carrier (ADR-0050), NOT a public per-boot knob. The worker
   * host threads the store's BOUND storage declaration (registry static + the first payload's wire
   * declaration + defaults) in here, and this boot's single storage resolution point folds it with the
   * registry's own static declaration — an explicit disagreement is a typed
   * `StorageDeclarationRefusedError` (the worker handlers refuse conflicts before this ever throws).
   * In-process consumers never set it: their registry IS the declaration.
   */
  storage?: SyncStorageDeclaration;
  /**
   * ADR-0049 D1: the placement probe's OPFS-sync-access grant, threaded from the SharedWorker's engine home
   * (`defineSyncWorker`'s SW-direct bootstrap) into this boot so the client-owned create opens the OPFS-repacked
   * backend. Absent/false is the honest IDBFS home — the declared `backend: "idbfs"` mode or a capability-absence
   * fallback (a main thread can never hold handles either). Forwarded verbatim to {@link createClientPGlite}, which
   * resolves the actual dataDir from it.
   */
  hasOpfsSyncAccess?: boolean;
  /**
   * ADR-0049 (capability-driven engine placement) decision 7, plan step 11b: the consumer's explicit
   * reconstructibility DECLARATION authorizing AUTOMATIC adoption of an existing idb-authoritative store into a
   * committed OPFS successor. DEFAULT OFF (`undefined`) — hook absence is NEVER authority (`rawExec` writes
   * documented local-only state on any store), so only this explicit `"server-reconstructible"` value (or the
   * manual {@link adoptStore} API) authorizes deleting the idb predecessor. Honoured ONLY on the browser
   * OPFS-home boot path (when {@link hasOpfsSyncAccess} is granted and the client owns the create — never the
   * BYO-instance / restore paths): a boot that finds an idb-authoritative store runs the pre-expose drain check,
   * reconstructs the successor through the Adoption-bootstrap gate (authorized online reconstruction — the eager
   * Consistency groups' initial catch-up), commits it via the strict barrier, and only then deletes the idb
   * predecessor. Any deferral/failure (owed journal, gate unmet, barrier failed) leaves the idb store
   * authoritative and boots it normally.
   */
  adoption?: AdoptionDeclaration;
  /**
   * Pre-warmed PGlite boot assets (the WASM modules + filesystem bundle), awaited and passed straight
   * into `PGlite.create`. The intent is to hide PGlite's ~2.5s cold `boot pglite.create` cost —
   * dominated by the WASM fetch+compile — behind user think-time: the host starts fetching/compiling
   * these on an earlier screen (e.g. the login/identity picker) and hands the still-pending promise
   * here, so by the time a store is opened the assets are already resolved and `PGlite.create` skips
   * its own lazy asset load. Ignored when {@link pgliteInstance} is supplied (the caller owns that
   * instance's boot). A rejected/failed warm is caught to `undefined` and never fails the boot — PGlite
   * falls back to loading its own assets, so this is a pure best-effort accelerator.
   */
  pgliteBootAssets?: Promise<PgliteBootAssets>;
  resetSubscriptionKeys?: string[];
  prepareLocalDbBeforeSchema?: (pglite: ClientPGlite) => Promise<void>;
  prepareLocalDbAfterSchema?: (pglite: ClientPGlite) => Promise<void>;
  onStatusChange?: (status: SyncRuntimeStatus) => void;
  onTableInitialSync?: (tableKey: string) => void;
  /**
   * A fully-provisioned PGlite instance the CALLER owns end-to-end. The client runs NONE of its
   * post-create boot steps against it — no schema exec, prepare hooks, or registry reconciliation
   * (journal recovery still runs, as it does on every path). Use it only when the caller has already
   * applied the registry schema itself. Contrast the three PGlite-provenance seams:
   * - {@link storePath} (default) — the client creates the store AND runs every post-create step.
   * - {@link precreatedPglite} — the caller creates the raw store (via {@link createClientPGlite}), but
   *   the client still runs every post-create step (schema, prepare hooks, and reconciliation), exactly as
   *   `storePath` does.
   * - `pgliteInstance` — the caller creates AND provisions the store; the client runs none of them.
   *
   * A caller-owned instance is REFUSED with {@link NonPersistentStoreError} if it is provably
   * non-persistent (a `new PGlite()` default, or an in-memory store) — pgxsinkit's durability semantics
   * assume a persisted store (ADR-0036). Acknowledge a deliberate test store by spreading
   * `testStoreAcknowledgment()` from `@pgxsinkit/client/testing`.
   *
   * Mutually exclusive with {@link precreatedPglite} (supplying both throws).
   */
  pgliteInstance?: ClientPGlite;
  /**
   * A raw PGlite instance the caller created EAGERLY (via {@link createClientPGlite}) — typically on an
   * earlier screen, to hide the ~1.9s cold `initdb`/IDBFS open behind user think-time — but for which the
   * client still owns EVERYTHING else: schema exec, prepare hooks, journal recovery, and registry
   * reconciliation all run exactly as on the {@link storePath} path. This is the difference from
   * {@link pgliteInstance} (which skips schema, prepare hooks, and reconciliation because the caller owns
   * them); see that
   * option's JSDoc for the three-way distinction.
   *
   * The promise form lets the still-pending eager create be handed straight in. Precedence/validation:
   * - Supplying both this and {@link pgliteInstance} throws — they claim different ownership.
   * - {@link storePath} is used ONLY as the fallback store name if this promise REJECTS: a failed eager
   *   create is caught, logged on the boot rail, and the normal `storePath` create path runs instead (also
   *   consuming {@link pgliteBootAssets} if provided). The pattern is a pure accelerator, never a boot
   *   dependency.
   * - A successfully-adopted instance is subject to the same {@link NonPersistentStoreError} refusal as
   *   {@link pgliteInstance} (checked after resolution, so the refusal propagates rather than being
   *   swallowed by the reject-fallback).
   */
  precreatedPglite?: Promise<ClientPGlite>;
  /**
   * Restore the store from a **store backup** (ADR-0035 decision 6) — a `File`/`Blob` tarball as produced by
   * {@link SyncClient.exportStore}. The client creates its store with the backup handed to PGlite's
   * `loadDataDir`, so it boots ON the backup's datadir (synced cache + Overlay + Mutation journal, all the
   * bytes that travelled inside it). Three restore-only rules apply, none of them optional:
   *
   * - **Fresh target only.** Refused with {@link RestoreTargetExistsError} if a store already exists at the
   *   resolved {@link storePath} — restore never overlays a live store (that would corrupt the datadir); the
   *   remedy is a deliberate {@link SyncClient.destroy} of the existing store first.
   * - **Comes online iff the recovered journal is clean (ADR-0046).** If journal recovery found NOTHING to
   *   quarantine — an empty recovered journal, the guaranteed-clean server-built bootstrap-artifact case — the
   *   restore boots ONLINE, honouring {@link syncEnabled}/{@link autoSync} exactly as a normal boot (streams,
   *   flush, convergence). If recovered mutations were quarantined, the boot stays OFFLINE (no shape streams,
   *   no read fetch, no flush): the app inspects {@link SyncClient.diagnostics}, releases/discards the
   *   quarantined rows, then a subsequent NORMAL boot of the (now-persisted) store brings sync online.
   *   `loadDataDir` happens exactly once, on this restore boot. An explicit `syncEnabled: false` keeps it offline.
   * - **Journal quarantined.** Every non-terminal recovered row (`pending`/`sending`/`failed`) is moved to
   *   `quarantined` — nothing recovered from a backup auto-flushes (the write path has no `mutationId` dedupe
   *   ledger, so replay is unsafe on last-write-wins tables). Release (`retryFailed`) or discard
   *   (`discardQuarantined`) them explicitly. When this pass quarantines nothing, the restore comes online (above).
   *
   * Mutually exclusive with {@link pgliteInstance} AND {@link precreatedPglite} — restore owns the store's
   * creation (`loadDataDir` is a create-time seed), so a caller-supplied instance conflicts (supplying either
   * with `restoreFrom` throws).
   */
  restoreFrom?: File | Blob;
  /**
   * PROVABLY-fresh store hint (ADR-0032 S4 / backlog-0003): the caller guarantees this store is brand-new
   * and schemaless — no prior schema, no synced rows, no persisted subscription state. When set (and sync
   * is enabled, and the client owns schema exec — i.e. not the {@link pgliteInstance} path), the shape
   * catch-up is started BEFORE the local boot phases (schema exec, journal recovery, and registry
   * reconciliation) and buffered in memory, with commits gated until those phases finish — so the network
   * catch-up overlaps them instead of running strictly after. On a far-from-database caller this collapses
   * boot from `local-phases + catch-up` toward `max(local-phases, catch-up)`.
   *
   * MUST be set only when freshness is proven, never derived by probing — a claimed schemaless spare (the
   * board's claim path knows: a claimed spare is always fresh; a mapped/returning store never is). A wrong
   * `true` on a warm store would start the streams from offset 0 and skip the subscription-state read,
   * re-snapshotting instead of resuming. Absent/false → the exact sequential path (the default, correct for
   * every warm store).
   */
  freshStore?: boolean;
  /**
   * Hard cap on send attempts before a still-failing mutation is quarantined
   * (ADR-0005 congestion policy). Defaults to the library's built-in cap.
   */
  maxMutationAttempts?: number;
  /**
   * Invoked when mutations are quarantined (permanently rejected by the server, terminal). The library
   * surfaces them here rather than silently dropping or retry-looping (ADR-0006). Surface, then either
   * re-author + resubmit or roll back via {@link SyncClient.discardQuarantined} — which clears the kept
   * overlay + quarantined journal rows so the entity accepts new mutations again.
   */
  onQuarantine?: (quarantined: MutationDetail[]) => void | Promise<void>;
  /**
   * Invoked when mutations are `conflicted` — a stale write the server declined under the
   * `reject-if-stale` Conflict policy (ADR-0015). The optimistic Overlay is kept, so the app shows a
   * resolution/diff UI and resolves each as a new write (`mutate.update`) or `discardConflict`s it.
   */
  onConflict?: (conflicted: MutationDetail[]) => void | Promise<void>;
  /**
   * Invoked when a pessimistic write-unit is `rejected` (ADR-0022) — a business decline from the
   * authoritative endpoint (capacity/quota/uniqueness). The inverse of `onConflict`: the optimistic Overlay
   * was auto-discarded for the whole unit, so the app surfaces the typed reason rather than a resolve UI.
   */
  onReject?: (rejected: MutationDetail[]) => void | Promise<void>;
  /**
   * Invoked when a supported store's registry fingerprint changes. `rebuilt` means the clean read cache was
   * rebuilt at the new shape; `deferred` means local mutations are still owed and must drain first.
   */
  onSchemaChange?: (event: LocalStoreVersionEvent) => void | Promise<void>;
  /**
   * Opt-in convergence driver (ADR-0005). Supply a {@link ConvergenceTrigger} (e.g.
   * `createBrowserConvergenceTrigger()`) and the client drives `flush`/`reconcile`/`retryFailed`
   * on the trigger's schedule, started once sync is ready and stopped on `stop()`/`destroy()`.
   * Omit it for fully-manual convergence (the mechanism primitives stay public either way).
   */
  autoSync?: ConvergenceTrigger;
  /** Invoked after each automatic convergence pass with its error, or `null` on success (only when `autoSync` is set). */
  onConvergencePass?: (error: unknown) => void;
  /**
   * Invoked when a read-path sync commit fails after exhausting its retries (ADR-0009 decision 5).
   * The runtime enters the `degraded` phase and holds the read cache at the last applied commit
   * instead of silently diverging from the server; recovery is a later commit or a restart/refetch.
   */
  onSyncError?: (error: Error) => void;
  /**
   * Boot observability (ADR-0034): invoked exactly once, at boot completion, with the finalized
   * {@link BootReport}. The push counterpart of {@link SyncClient.bootReport} (the pull) for consumers that
   * want the numbers without polling — dashboards, CI budget gates. Never fired before initial sync; a
   * `stop()`/`destroy()` before then means it never fires.
   */
  onBootReport?: (report: BootReport) => void;
  /**
   * @internal Boot mode stamped into the {@link BootReport} (ADR-0034). `defineSyncWorker` sets `"worker"`;
   * absent → `"in-process"`. Not a behavior knob — it only labels the report.
   */
  bootMode?: BootReport["mode"];
  /**
   * @internal Engine home stamped into the {@link BootReport} (ADR-0049 decision 12). Threaded by
   * `defineSyncWorker` from the SharedWorker placement decision — `"shared-worker"` (SW-direct) or
   * `"elected-worker"`. Absent only for a plain non-worker scope that cannot derive a browser engine home; the
   * in-process client stamps `"in-process"` itself. Report-label only.
   */
  engineHome?: BootReport["engineHome"];
  /**
   * @internal Capability-absence fallback reason stamped into the {@link BootReport} (ADR-0049 D1/D12). Threaded
   * by `defineSyncWorker` when the placement bootstrap opened the in-SharedWorker IDBFS engine because OPFS was
   * CAPABLE but no home could hold sync-access handles (every probe denied / the OPFS API absent). Unlike the
   * client's own internal fallback reasons (adoption-deferred, recordless-idb — set only under a granted probe),
   * this externally-supplied reason is stamped verbatim on an idbfs boot. Absent on a granted opfs boot and on the
   * declared `backend: "idbfs"` mode (that is the data contract, not a fallback). Report-label only.
   */
  storageFallbackReason?: string;
  /**
   * @internal Provision timing for a boot that ADOPTS a pre-provisioned store (ADR-0034). When the store was
   * minted ahead of boot (a spare's off-thread initdb), the provisioner stamps its create cost and ready
   * time here; the boot reports them as {@link BootReport.provision} and sets `phases.pgliteCreateMs = null`.
   * A promise because the stamp settles with the spare's `create`. Only honoured on the {@link precreatedPglite}
   * adoption path (ignored on a fallback create). `provisionReadyAt` must share this process's monotonic clock.
   */
  provisionStamp?: Promise<{ initdbMs: number; provisionReadyAt: number }>;
  /**
   * Bounded zero-subscriber keep-alive for the live-query manager (ADR-0040 decision 4) — same block as
   * {@link DefineSyncWorkerOptions.liveQueries}. Takes effect in BOTH client forms: the in-process client
   * now owns its own manager (decision 6), so this policy governs its live-query dedup and retention just as
   * it does the worker's. Defaults: `defaultKeepAliveMs` 0 (tear a query down the instant its last consumer
   * leaves), `maxRetainedQueries` 16, `maxRetainedRows` 50_000.
   */
  liveQueries?: {
    defaultKeepAliveMs?: number;
    maxRetainedQueries?: number;
    maxRetainedRows?: number;
  };
}

export interface SyncClientTableHandle<TRegistry extends SyncTableRegistry, TKey extends SyncTableName<TRegistry>> {
  key: TKey;
  mode: TRegistry[TKey]["mode"];
  create: (input: SyncTableCreateInput<TRegistry, TKey>) => Promise<void>;
  update: (entityKey: Record<string, string>, patch: SyncTableUpdateInput<TRegistry, TKey>) => Promise<void>;
  delete: (entityKey: Record<string, string>) => Promise<void>;
}

/**
 * A table handle inside a {@link SyncClient.transaction} block (ADR-0022 §2). It *collects* mutations into
 * the open write-unit rather than enqueuing each immediately; the whole set is enqueued atomically when the
 * block's callback returns. The calls are synchronous (collection only) — no per-call await needed.
 */
export interface SyncTransactionTableHandle<
  TRegistry extends SyncTableRegistry,
  TKey extends SyncTableName<TRegistry>,
> {
  create: (input: SyncTableCreateInput<TRegistry, TKey>) => void;
  update: (entityKey: Record<string, string>, patch: SyncTableUpdateInput<TRegistry, TKey>) => void;
  delete: (entityKey: Record<string, string>) => void;
  /**
   * An **update-by-key with no local base row** (ADR-0022 addendum). Ordinary `update` requires the entity
   * to be present in the actor's local read model (it seeds the optimistic overlay and captures the base
   * server version); `updateBlind` skips that presence check and writes NO overlay — nothing appears in the
   * read model. Use it when the write target is deliberately EXCLUDED from your read shape (a write-only
   * flow, or an anonymity-scoped moderation write whose row streams only to a different projection), so there
   * is no local row to update and nothing to show optimistically.
   *
   * **Pessimistic-only.** The /unit expander is authoritative for the outcome, so a blind write is meaningful
   * only inside a `transaction({ mode: "pessimistic" })` block (or over a statically-pessimistic table). An
   * optimistic-routed blind write has nothing to converge and THROWS at enqueue.
   *
   * The acked journal row **retires without a synced echo** (no visible row ever converges for it), so it does
   * not linger — unlike the seed-a-phantom-row workaround this replaces, whose acked row + overlay lingered
   * forever behind the echo barrier. A `conflicted` blind write stays dischargeable via `discardConflict`; a
   * `rejected` one is surfaced via `onReject`, both with no overlay to clean up.
   */
  updateBlind: (entityKey: Record<string, string>, patch: SyncTableUpdateInput<TRegistry, TKey>) => void;
}

/** The handle passed to a {@link SyncClient.transaction} callback: collecting table handles for the unit. */
export interface SyncTransaction<TRegistry extends SyncTableRegistry> {
  tables: { [TKey in SyncTableName<TRegistry>]: SyncTransactionTableHandle<TRegistry, TKey> };
}

/**
 * The result of a {@link SyncClient.transaction}. A `pessimistic` block carries the authoritative server
 * `acks` (each `acked` / `conflicted` / `rejected`); an `optimistic` block enqueues atomically and flushes
 * in the background, so its `acks` are empty.
 */
export interface SyncTransactionResult {
  acks: MutationAck[];
}

/** Minimal shape of a Drizzle select builder: inspectable via `.toSQL()` and awaitable for its rows. */
export interface DrizzleQueryBuilder<TRows extends readonly unknown[]> extends PromiseLike<TRows> {
  toSQL(): { sql: string; params: unknown[] };
}

/**
 * The builder callback for a guarded read (ADR-0021): it receives the client and returns a Drizzle
 * select builder. Reach relations through `c.views` / `c.drizzle` / a directly-imported synced table.
 */
export type GuardedQueryFn<TRegistry extends SyncTableRegistry, TRows extends readonly unknown[]> = (
  client: SyncClient<TRegistry>,
) => DrizzleQueryBuilder<TRows>;

/**
 * A guarded query whose builder MAY embed a raw `sql` template fragment (ADR-0021). A raw fragment can
 * name a lazy relation as a bare/unquoted identifier the compiled-SQL scan cannot see, so declare those
 * relations in `use` — they are activated and awaited before the query runs. Pure-Drizzle reads need no
 * `use` (the scan detects every relation): pass the builder callback directly to `client.query`.
 */
export interface GuardedRawQuerySpec<TRegistry extends SyncTableRegistry, TRows extends readonly unknown[]> {
  use?: readonly SyncTableName<TRegistry>[];
  build: GuardedQueryFn<TRegistry, TRows>;
}

/**
 * Inputs to the read-path safety seam {@link SyncClient.prepareQuery}. The lazy relations a query reads
 * are detected by scanning the compiled `sql` (union with the optional explicit `use`), then activated.
 * Shared by the live React hooks and the non-live facade.
 */
export interface PrepareQueryInput<TRegistry extends SyncTableRegistry> {
  /** The compiled (parameterised) Drizzle SQL the query will run — the scan's ground-truth target. */
  sql: string;
  /** Lazy relations to also activate, beyond those scanned from `sql` — a pre-activation hint, not required. */
  use?: readonly SyncTableName<TRegistry>[];
}

/**
 * The narrow live-rows seam (ADR-0032 S2 §4) both client modes implement so the `@pgxsinkit/react` hooks
 * work against either. Input for a reactive subscription: the compiled SQL + params (from a Drizzle
 * builder's `.toSQL()` or a raw string) and the result's `pkColumns` (drives worker-side diff keying;
 * omit for a keyless query). The in-process client runs it directly over `pglite.live`; the worker-attached
 * client runs the live query in the worker and streams DIFFs across the bridge.
 */
export interface SubscribeLiveRowsInput {
  sql: string;
  params: readonly unknown[];
  /**
   * The unique output aliases to render the query's columns under so it is SAFE TO MATERIALISE, in the
   * compiled SQL's column order (one per output column). Drizzle emits no output aliases, so a JOIN whose
   * tables share a column name compiles to duplicate output names — which PGlite's `live` extension
   * refuses to materialise (`column "title" specified more than once`) and which silently collapse
   * same-named columns even in a plain query. When supplied, the seam wraps the query so every output
   * column gets its alias and rows come back KEYED BY THESE ALIASES; the consumer's row-mapper must read
   * by alias (the `@pgxsinkit/react` hooks do). Omit for a raw or non-colliding query — the seam then
   * leaves the SQL untouched and rows stay keyed by the underlying column names.
   */
  fields?: readonly string[];
  /**
   * The result's PK columns — the diff-keying identity across the bridge (§4). Omit for a keyless query.
   * When {@link fields} is supplied the result columns are the aliases, so a PK column here must be named
   * by its ALIAS (the aliased result column), not the underlying source column.
   */
  pkColumns?: readonly string[];
  /**
   * Lazy relations (ADR-0021) to activate before the query runs — forwarded to the worker so it can
   * `prepareQuery` before registering the live query (the tab's own `prepareQuery` is a no-op against the
   * worker bridge). Ignored by the in-process client, whose `prepareQuery` already ran on the tab.
   */
  use?: readonly string[];
  /**
   * Per-subscription keep-alive hint (ms) for the live-query manager (ADR-0040 decision 4): retain this
   * query's shared registration for the grace period after its last consumer leaves, so a re-mount reuses it
   * verbatim (no re-materialization). Honoured in BOTH modes — the worker manager and the in-process manager
   * (decision 6). Bounded by the `liveQueries` policy budgets. Absent → no hint.
   */
  keepAliveMs?: number;
}

/** A handle to a live-rows subscription: the initial ordered snapshot plus an idempotent unsubscribe. */
export interface LiveRowsSubscription<TRow> {
  initialRows: TRow[];
  unsubscribe: () => void;
  /**
   * The `lazy` relations the query reads (the guard's scan) — the relations held out of the eager boot
   * set. Activation (stream start) completed before the subscription registered. Informational only:
   * {@link hydrated} — not this — reflects catch-up completion, and it now spans eager groups too.
   */
  lazyTables?: readonly string[];
  /**
   * Present when the query reads ANY consistency group (eager OR lazy) that was NOT YET caught up at
   * subscribe time: resolves once every such group has completed its initial catch-up AND this
   * subscription has already delivered rows reflecting it (the seam refreshes the live query after
   * catch-up, then resolves — rows-before-signal is guaranteed, so flipping a UI out of its loading state
   * on this promise can never flash a false "empty"). Absent when every referenced group is already ready
   * at subscribe time (the steady-state fast path — no extra refresh) or sync is disabled. Offline note:
   * stays pending until the catch-up truly completes — gate empty-state COPY on it, not data access (rows
   * flow regardless).
   */
  hydrated?: Promise<void>;
}

/**
 * Result of {@link SyncClient.prepareQuery}: the `lazy` relations the guard scanned out of the SQL
 * (∪ the explicit `use`) and activated. Activation means the group's STREAM IS STARTED — reads are
 * safe from the tripwire — not that its initial catch-up has completed; await
 * {@link SyncClient.groupReady} per key for that (see ADR-0021 / ADR-0032 decision 6).
 *
 * Parameterized by the TABLE-NAME UNION, not the registry: `keyof TRegistry` in an output position
 * would make the registry parameter contravariant, and `SyncClient<ConcreteRegistry>` would stop
 * being assignable to bare-`SyncTableRegistry` supertypes — the erasure pattern consumer seams rely
 * on. A name union in output position keeps the whole client covariant in its registry.
 */
export interface PreparedQueryResult<TTable extends string = string> {
  lazyTables: readonly TTable[];
}

export interface SyncClient<TRegistry extends SyncTableRegistry> {
  drizzle: PgliteDatabase<RegistryRelations<TRegistry>>;
  pglite: ClientPGlite;
  views: RegistryViews<TRegistry>;
  tables: {
    [TKey in SyncTableName<TRegistry>]: SyncClientTableHandle<TRegistry, TKey>;
  };
  /**
   * Local-read readiness (ADR-0041): resolves once PGlite is open, the durable schema is ready, registry
   * reconciliation has completed, and the drizzle read
   * facade is built — so cached rows are queryable. Resolving this stage requires NO write runtime, NO sync
   * start, and NO network I/O, so an offline boot resolves it promptly. Under the ADR-0041 Option B contract
   * `createSyncClient()` (and, in stage 2, `attachSyncClient()`) resolves at exactly this stage; the write and
   * sync tail continues in the background. Monotonic and idempotent.
   */
  localReadReady: Promise<void>;
  /**
   * Write readiness (ADR-0041): resolves once the mutation runtime is constructed and boot recovery has
   * completed (plus restore quarantine on a restore boot) — enqueue is safe. Every write-path method awaits
   * this internally, so a write issued the instant `localReadReady` resolves completes once `writeReady`
   * lands rather than failing opaquely. Resolves with NO network I/O. Monotonic and idempotent.
   */
  writeReady: Promise<void>;
  /**
   * @internal Boot-settled signal (ADR-0041): resolves at today's full in-process resolution point — the
   * write runtime, boot recovery, and sync START have all run (initial catch-up is NOT awaited; that is
   * `ready`). The worker bridge awaits this before `attach-ack` so worker-mode external timing is unchanged
   * in stage 1; stage 2 replaces it with per-stage milestone messages. Not part of the supported public
   * surface — a diagnostics/bridge hook only.
   */
  bootSettled: Promise<void>;
  ready: Promise<void>;
  status: SyncRuntimeStatus;
  start: () => Promise<void>;
  /**
   * Synchronously abort all sync/write activity (in-flight write fetches, shape-stream long-polls, convergence
   * scheduling) without awaiting. Idempotent. The first action of every teardown path — stop()/destroy() call it,
   * and the SharedWorker host calls it before draining subscribes / disposing live queries so no teardown step
   * races a still-live engine. Not a substitute for stop()/destroy(): the awaited teardown (unsubscribe, dispose,
   * pglite.close) still follows. Callers rarely invoke it directly.
   */
  haltActivity: () => void;
  stop: () => Promise<void>;
  /**
   * Wipe the entire local store (synced cache + overlay + journal) and close the handle
   * (ADR-0005). Refuses if mutations are still owed to the server unless `force` is set, so
   * it never silently drops un-flushed writes. Distinct from `stop()`, which only halts sync.
   * Runs under the single lifecycle slot (ADR-0035 decision 4): a concurrent export — or another
   * `destroy`/`discardEphemeral`/`dropReadCache` — rejects with a {@link LifecycleBusyError} rather
   * than interleaving the wipe with a running export.
   */
  destroy: (options?: { force?: boolean }) => Promise<void>;
  /**
   * Drop and rebuild the reconstructible synced read cache, preserving the overlay and
   * mutation journal (ADR-0006). The next sync refills it. Use to recover from a corrupt or
   * stale read cache without losing un-flushed writes. Runs under the single lifecycle slot
   * (ADR-0035 decision 4) — it drops and rebuilds the synced tables, so an export must not capture a
   * half-rebuilt cache; a concurrent export (or `destroy`/`discardEphemeral`) rejects with a
   * {@link LifecycleBusyError}.
   */
  dropReadCache: () => Promise<void>;
  flush: (table?: SyncTableName<TRegistry>) => Promise<void>;
  reconcile: (table?: SyncTableName<TRegistry>) => Promise<void>;
  retryFailed: (table?: SyncTableName<TRegistry>) => Promise<void>;
  recoverSending: (table?: SyncTableName<TRegistry>) => Promise<void>;
  readMutationDetails: (table?: SyncTableName<TRegistry>) => Promise<MutationDetail[]>;
  mutate: {
    create: <TKey extends SyncTableName<TRegistry>>(
      table: TKey,
      input: SyncTableCreateInput<TRegistry, TKey>,
    ) => Promise<void>;
    update: <TKey extends SyncTableName<TRegistry>>(
      table: TKey,
      entityKey: Record<string, string>,
      patch: SyncTableUpdateInput<TRegistry, TKey>,
    ) => Promise<void>;
    delete: <TKey extends SyncTableName<TRegistry>>(table: TKey, entityKey: Record<string, string>) => Promise<void>;
    batch: (items: ReadonlyArray<MutationBatchItem<TRegistry>>) => Promise<void>;
  };
  /**
   * Discard a `conflicted` entity (ADR-0015): clear its conflicted journal entry and kept optimistic
   * Overlay, so the Read model falls back to the synced (server) value. Use when the user abandons a
   * stale edit instead of resolving it as a new write.
   */
  discardConflict: <TKey extends SyncTableName<TRegistry>>(
    table: TKey,
    entityKey: Record<string, string>,
  ) => Promise<void>;
  /**
   * Discard a `quarantined` entity (ADR-0006): clear its quarantined journal entry and kept optimistic
   * Overlay, so the Read model falls back to the synced (server) value. The rollback path for a write
   * the server permanently rejected — e.g. an RLS policy denial (42501) routed to quarantine. After the
   * discard the phantom optimistic row is gone and the entity accepts new mutations again (no longer
   * blocked behind the quarantined head). Symmetric to {@link SyncClient.discardConflict}; the overlay
   * is kept when another still-owed write depends on it. No-op for an entity with no quarantined entry.
   */
  discardQuarantined: <TKey extends SyncTableName<TRegistry>>(
    table: TKey,
    entityKey: Record<string, string>,
  ) => Promise<void>;
  diagnostics: (table?: SyncTableName<TRegistry>) => Promise<{ mutation: MutationDiagnostics }>;
  /**
   * The registry-wide reactive mutation-status surface: a global per-status summary and a
   * filtered normalized detail list over EVERY writable journal, each available one-shot or as a live
   * subscription. Identical on the in-process and worker-attached client. Render a global sync indicator with
   * ONE `subscribeSummary` instead of one journal live query per writable table; consumers never touch the
   * generated journal relation names. See {@link MutationsApi}.
   */
  mutations: MutationsApi<TRegistry>;
  /**
   * The INSPECTION read surface (debug pages, REPLs, ad-hoc counts) — identical on the in-process and
   * worker-attached client (on the latter the statement runs in the worker). The statement runs raw
   * against the local store: it BYPASSES the mutation journal and optimistic overlay, and any write it
   * issues stays local and will NOT converge. For app data reads prefer the live-rows hooks /
   * {@link subscribeLiveRows} (or the guarded {@link query} family); reach for this only to look at the
   * store, not to read app state or mutate it.
   */
  rawQuery: (sql: string, params?: unknown[], options?: RawQueryOptions) => Promise<Results>;
  /** {@link rawQuery} for multi-statement SQL, returning one {@link Results} per statement. */
  rawExec: (sql: string, options?: RawQueryOptions) => Promise<Results[]>;
  /**
   * @internal The worker host's guarded one-shot read seam (ADR-0032 decision 4): {@link rawQuery} PLUS the
   * ADR-0041 read gate and the ADR-0021 lazy-group guard, sharing one gate+guard core with the in-process
   * `query`/`queryRaw` builder path so the two entry points can never drift on guard semantics.
   * `defineSyncWorker` dispatches the `guardedQuery` RpcOp to this on its owned in-process client; the attach
   * client's Drizzle-over-bridge compiles the SQL on the tab and routes the read here so the guard runs
   * worker-side. Accepts the full PGlite {@link QueryOptions} (the worker re-applies drizzle's identity
   * parsers here — temporal OIDs + numeric[]) plus the raw-fragment `use` list. NOT part of the app-facing
   * read surface — reach for {@link query} / {@link queryRaw} instead; kept `@internal` (above) and excluded
   * from the generated API docs (typedoc excludeInternal).
   */
  guardedRawQuery: (
    sql: string,
    params?: unknown[],
    options?: QueryOptions,
    use?: readonly SyncTableName<TRegistry>[],
  ) => Promise<Results>;
  /**
   * Run a one-shot (non-live) typed **pure-Drizzle** query with the lazy-relation safety net (ADR-0021).
   * Pass the builder callback directly — pgxsinkit scans the compiled SQL and activates + awaits every
   * lazy relation it reads (FROM, JOIN, subquery, WHERE) before it runs, and the tripwire rejects any
   * lazy relation the SQL still references but that is not active, so the result is never silently
   * empty/stale. The guaranteed-safe alternative to a bare `client.drizzle` read. If the builder embeds
   * a raw `sql` template fragment, use {@link queryRaw} and declare the lazy relations in `use`.
   */
  query: <TRows extends readonly unknown[]>(build: GuardedQueryFn<TRegistry, TRows>) => Promise<TRows>;
  /** {@link query} returning the first row, or null when empty. */
  queryRow: <TRows extends readonly unknown[]>(
    build: GuardedQueryFn<TRegistry, TRows>,
  ) => Promise<TRows[number] | null>;
  /**
   * {@link query} for a builder that embeds a raw `sql` template fragment (ADR-0021). The compiled-SQL
   * scan can miss a lazy relation named as a bare/unquoted identifier inside raw SQL, so declare those
   * in `use` — they are activated and awaited before the query runs. Pure-Drizzle reads should use
   * {@link query} instead (no `use` needed).
   */
  queryRaw: <TRows extends readonly unknown[]>(spec: GuardedRawQuerySpec<TRegistry, TRows>) => Promise<TRows>;
  /** {@link queryRaw} returning the first row, or null when empty. */
  queryRawRow: <TRows extends readonly unknown[]>(
    spec: GuardedRawQuerySpec<TRegistry, TRows>,
  ) => Promise<TRows[number] | null>;
  /**
   * Activate one or more lazy relations (ADR-0021): open their consistency-group subscription if held
   * out of the eager boot, resolving once each group's STREAM IS STARTED — reads are then tripwire-safe,
   * but the initial catch-up may still be in flight (local rows can be legitimately empty/stale until it
   * lands; await {@link groupReady} per relation for catch-up completion — deliberately separate so an
   * offline client still reads its persisted local rows instead of hanging on the network). Idempotent —
   * eager or already-started relations resolve immediately. Use to pre-activate before a
   * raw/`client.drizzle` read, or as the manual escape hatch the tripwire points to.
   */
  ensureSynced: (keys: readonly SyncTableName<TRegistry>[]) => Promise<void>;
  /**
   * Whether a relation's group has started and hydrated (ADR-0021). False for a still-dormant `lazy`
   * relation; true for eager relations once boot completes (and always when sync is disabled).
   */
  isSynced: (key: SyncTableName<TRegistry>) => boolean;
  /**
   * Revert a `lazy` relation to dormant (ADR-0021 §2) — the inverse of on-demand activation: stop its
   * consistency group's stream, clear any persisted `lazy + persistent` activation (so the next boot
   * holds it dormant again), and clean-truncate its local read cache. A later reference re-activates it
   * from scratch. Refuses when the relation is `eager` (always-on, would immediately re-sync) or owes
   * the server unsettled writes (the truncate would drop them — flush or discard first). The reclaim
   * primitive a host wires to navigation/idle for a rarely-opened lazy view; for an `ephemeral`
   * relation, idle-eviction is otherwise automatic at session end.
   */
  desync: (key: SyncTableName<TRegistry>) => Promise<void>;
  /**
   * Drop an **ephemeral** relation's local rows and revert it to dormant (ADR-0021) — the narrow,
   * scoped twin of {@link desync}. It runs the identical group-teardown machinery (stop the group stream,
   * clear the persisted lazy activation, reset the persisted subscription, clean-truncate every member),
   * but under a STRICTER gate: EVERY member of the relation's consistency group must be `retention:
   * "ephemeral"` — it refuses (naming the offender) if any member is persistent. Where a `desync` from one
   * tab reverts the shared group for every attached tab (the SharedWorker footgun), `discardEphemeral` is
   * safe under multi-tab because an ephemeral window is per-delivery-session and inherently single-consumer
   * — nothing durable, and no other tab, depends on it. Refuses an `eager` relation (always-on, would
   * immediately re-sync) and a group that owes the server unsettled writes, exactly as `desync` does. The
   * finalize primitive for a secure-delivery window: drop the local rows at session end without touching a
   * durable relation. Note the drop is local-lifecycle only: a later re-subscription re-activates the lazy
   * group and re-streams whatever the SERVER still serves — post-finalize non-redelivery is the server
   * gate's guarantee (e.g. a consumed server-owned cursor), not this method's. Runs under the single
   * lifecycle slot (ADR-0035 decision 4): a concurrent export (or `destroy`/`dropReadCache`) rejects with a
   * {@link LifecycleBusyError} rather than interleaving the cache truncate with a running export.
   */
  discardEphemeral: (key: SyncTableName<TRegistry>) => Promise<void>;
  /**
   * The read-path safety seam (ADR-0021): scan the compiled `sql` for the lazy relations it reads
   * (∪ the optional `use`) and activate them — so a lazy relation auto-activates on *any* reference
   * (FROM, JOIN, subquery, WHERE). Resolves once it is safe to run the query (streams started, tripwire
   * satisfied) and returns the activated keys ({@link PreparedQueryResult}) so a consumer can further
   * await {@link groupReady} per key for catch-up completion — the React hooks drive `hydrating` off
   * exactly that. A backstop throws {@link LazyRelationNotActivatedError} only if a referenced relation
   * could not be activated. Exposed for the React live hooks (which own their query build);
   * `query`/`queryRow` are the higher-level non-live wrappers. Raw, non-Drizzle SQL is out of scope —
   * pass `use`, or `ensureSynced` first.
   */
  prepareQuery: (input: PrepareQueryInput<TRegistry>) => Promise<PreparedQueryResult<SyncTableName<TRegistry>>>;
  /**
   * Author an atomic write-**unit** (ADR-0022 §2). The callback receives collecting table handles; every
   * mutation it issues is tagged into one unit and enqueued atomically when the callback returns.
   *
   * - `mode: "pessimistic"` — **server-authoritative**: the unit flush-routes to the authoritative endpoint
   *   and this call resolves only once the server has decided. The result's `acks` carry each member's
   *   outcome — `acked`, `conflicted` (overlay kept, ADR-0015), or `rejected` (overlay auto-discarded for
   *   the whole unit, surfaced via `onReject`, ADR-0022 §4). Throws on transport failure (overlay kept). A
   *   pessimistic block may also issue {@link SyncTransactionTableHandle.updateBlind} — an update-by-key with
   *   no local base row and no overlay, for a write target excluded from the actor's read shape.
   * - `mode: "optimistic"` — an atomic batch enqueue that flushes in the background (empty `acks`).
   */
  transaction: (
    options: { mode: WriteMode },
    run: (tx: SyncTransaction<TRegistry>) => void | Promise<void>,
  ) => Promise<SyncTransactionResult>;
  /**
   * Per-group readiness (ADR-0032 decision 6): a promise resolving the moment the given table's
   * consistency group is up-to-date. Resolves immediately for an already-ready (or sync-disabled)
   * group; stays pending for a still-dormant `lazy` relation until it is activated and caught up. The
   * opt-in progressive-paint signal beside the all-eager-groups `ready` gate. `status.groups` carries the
   * same readiness as a synchronous snapshot.
   */
  groupReady: (table: SyncTableName<TRegistry>) => Promise<void>;
  /**
   * The referenced consistency groups' member tables that are NOT YET caught up at call time (ADR-0021 /
   * ADR-0032 decision 6): scan the compiled SQL for every synced relation the query reads (∪ `use`), map
   * each to its consistency group, and return those whose group has not completed its initial catch-up.
   * Empty when sync is disabled OR every referenced group is already ready — the steady-state fast path in
   * which the live-rows seam builds no `hydrated` promise. The seam (and the worker bridge) use this to gate
   * `hydrating` uniformly across eager AND lazy groups; ACTIVATION is separate and stays lazy-only. Returns
   * plain table-name strings (not `keyof TRegistry`) to keep the client covariant in its registry.
   */
  hydratingTablesFor: (query: { sql: string; use?: readonly string[] }) => readonly string[];
  /**
   * The live-rows seam (ADR-0032 S2 §4): register a reactive query and receive its initial ordered
   * snapshot plus subsequent updates via `onRows`. The React live hooks consume THIS (not `pglite.live`
   * directly), so they run unchanged against both the in-process client (which implements it over
   * `pglite.live`) and the worker-attached client (which implements it over the bridge). Prefer the
   * higher-level `@pgxsinkit/react` hooks; this is the lower-level primitive they build on.
   */
  subscribeLiveRows: <TRow extends Record<string, unknown> = Record<string, unknown>>(
    input: SubscribeLiveRowsInput,
    onRows: (rows: TRow[]) => void,
  ) => Promise<LiveRowsSubscription<TRow>>;
  /**
   * Boot observability (ADR-0034): the engine's most recent COMPLETED boot report, or `null` before the
   * first boot finalizes (and after a `stop()`/`destroy()` that preceded initial sync). Pull — so a
   * late-attaching tab can read a boot that predates it; in worker mode it round-trips to the worker's
   * stored report. The push counterpart is the `onBootReport` client option.
   */
  bootReport: () => Promise<BootReport | null>;
  /**
   * Live-query diagnostics (ADR-0040 decision 5): a point-in-time snapshot of the live-query manager's
   * entries — opaque fingerprint digests plus counts/timings only, NEVER SQL, params, or row values. Both
   * client forms return the real snapshot: in WORKER mode this pulls the worker manager's snapshot over the
   * bridge; the IN-PROCESS client returns its own manager's snapshot directly.
   */
  liveQueryDiagnostics: () => Promise<LiveQueryDiagnostics[]>;
  /**
   * Take a **store backup** (ADR-0035): a full-fidelity, PGlite-restorable tarball of the whole local
   * store — synced cache, Overlay, and Mutation journal (unflushed writes included) — via PGlite's
   * `dumpDataDir`. Taken LIVE (a `CHECKPOINT` serialised behind engine work, then the dump; no engine
   * suspension, no tab disruption), so it never blocks and is the only lossless export an offline device
   * with unflushed writes can take. Awaits engine-ready rather than rejecting during boot, then runs under
   * the single lifecycle slot: a second export (or, later, `destroy`/`discardEphemeral`) attempted while
   * one is in flight rejects immediately with a {@link LifecycleBusyError} — retry once it settles.
   * Resolves to the artefact `File` plus an {@link ExportReport} (phase timings + a diagnostics snapshot).
   */
  exportStore: (options?: StoreExportOptions) => Promise<StoreExportResult>;
  /**
   * Take a **diagnostic dump** (ADR-0035): human-readable SQL of EVERYTHING the store holds — synced tables,
   * the `_overlay`/`_mutations` journal (unflushed writes included — the evidence a diagnostic exists for),
   * the `pgxsinkit` metadata schema, the read-model views, and the reconcile functions/triggers — via
   * `pg_dump`. To keep `pg_dump`'s `DEALLOCATE ALL` away from the live engine, the dump runs against a
   * memory-backed THROWAWAY clone booted from a live datadir dump (ADR-0035 addendum): the running store is
   * never suspended and no tab is disrupted. Awaits engine-ready rather than rejecting during boot, then
   * runs under the single lifecycle slot — a concurrent export (or `destroy`/`discardEphemeral`) rejects
   * immediately with a {@link LifecycleBusyError}. Resolves to the SQL `File` (`application/sql`) plus a
   * {@link DiagnosticDumpReport} (phase timings + a diagnostics snapshot). Active ephemeral (`pg_temp`)
   * clusters are absent by construction (ADR-0035 decision 5 — `pg_dump` ignores temp objects).
   */
  exportDiagnostics: (options?: DiagnosticExportOptions) => Promise<DiagnosticExportResult>;
  /**
   * Take a **data export** (ADR-0035): the PORTABLE artefact — the synced tables and the enum types they
   * depend on, schema + data, nothing of pgxsinkit's machinery — as SQL loadable into a vanilla Postgres. It
   * is a generated enum DDL header concatenated ahead of `pg_dump -t <table> ... --no-owner` (one `-t` per
   * physical synced table; ephemeral/read-projection entries excluded by construction), run against the same
   * memory-backed THROWAWAY clone the diagnostic dump uses — so the live engine is never touched.
   *
   * Unlike the other two exports it GUARDS the journal (decision 3): a strict export requires a DRAINED
   * journal — all mutation counts zero, including `acked` writes whose synced echo has not landed (they live
   * only in the Overlay). The drain flushes drainable rows and awaits convergence up to
   * `drainJournal.timeoutMs` (default `15_000`); non-drainable states (`failed`/`quarantined`/`conflicted`)
   * fail FAST with a {@link DataExportDrainError} carrying the diagnostics. `drainJournal: false` is the
   * escape hatch — export synced state as-is (unflushed writes absent; `report.escapeHatch` records it). An
   * offline device with a clean journal exports strictly and instantly; one with a dirty journal cannot
   * produce a strict export (its lossless option is `exportStore`).
   *
   * Awaits engine-ready rather than rejecting during boot, then runs the whole drain+dump under the single
   * lifecycle slot — a concurrent export (or `destroy`/`discardEphemeral`) rejects with a
   * {@link LifecycleBusyError}. Resolves to the SQL `File` (`application/sql`) plus a {@link DataExportReport}
   * (drain + clone-pipeline phase timings, the applied `-t` table list, and the escape-hatch flag).
   */
  exportData: (options?: DataExportOptions) => Promise<DataExportResult>;
}

export type { MutationBatchItem, MutationDetail, MutationDiagnostics, MutationKind, MutationSummary };

/**
 * The structured-clone-safe subset of PGlite's `QueryOptions` the inspection surface carries. Kept
 * narrow ON PURPOSE: on a worker-attached client the options object crosses the bridge via
 * `postMessage`, so function-valued options (`parsers`, `serializers`, `onNotice`) can never be part
 * of this contract. `rowMode: "array"` is what `@electric-sql/pglite-repl` asks for on every exec.
 */
export interface RawQueryOptions {
  rowMode?: "object" | "array";
}

/** The `{ query, exec }` duck `@electric-sql/pglite-repl` drives, backed by a client's inspection surface. */
export interface ReplInspectionSurface {
  query: (sql: string, params?: unknown[], options?: RawQueryOptions) => Promise<Results>;
  exec: (sql: string, options?: RawQueryOptions) => Promise<Results[]>;
}

/**
 * Shape a {@link SyncClient}'s inspection surface (`rawQuery`/`rawExec`) as the `{ query, exec }` duck
 * `@electric-sql/pglite-repl` needs. Identical on the in-process and worker-attached client — on the latter
 * each statement routes through the worker bridge, so the REPL works even though `client.pglite` is
 * unavailable. Cast the result at the `<Repl pg={...}>` prop (the REPL types the prop as a full `PGlite`).
 * The surface is registry-independent, so it accepts any client's `rawQuery`/`rawExec` pair.
 */
export function replAdapter(
  client: Pick<SyncClient<SyncTableRegistry>, "rawQuery" | "rawExec">,
): ReplInspectionSurface {
  return {
    // Thread the options through UNMODIFIED — the REPL execs with `{ rowMode: "array" }` and renders
    // each row with `row.map`, so dropping the options here breaks every REPL statement.
    query: (sql, params, options) => client.rawQuery(sql, params, options),
    exec: (sql, options) => client.rawExec(sql, options),
  };
}

export async function createSyncClient<const TRegistry extends SyncTableRegistry>(
  options: CreateSyncClientOptions<TRegistry>,
): Promise<SyncClient<TRegistry>> {
  // The outer adoption transition owns the durable `adopting` phase and final commitment barrier. Its inner
  // candidate boot must mint only candidate bytes; re-entering the ordinary phase machine would classify the
  // live `adopting` record as crash recovery and tear the candidate down underneath itself.
  const adoptionCandidateBuild =
    (options as CreateSyncClientOptions<TRegistry> & AdoptionCandidateBuildOptions)[ADOPTION_CANDIDATE_BUILD] === true;
  const createPglite =
    (options as CreateSyncClientOptions<TRegistry> & InternalPgliteCreateOptions)[INTERNAL_PGLITE_CREATE] ??
    createClientPGlite;
  // Fail fast on a bad keep-alive policy — before any PGlite boot work (ADR-0040 decision 4 — bounded).
  validateLiveQueryPolicy(options.liveQueries);
  const status: SyncRuntimeStatus = {
    phase: "booting",
    isRunning: false,
  };

  let resolveReady!: () => void;
  let rejectReady!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  // Staged boot readiness (ADR-0041). Three monotonic, idempotent stages resolved as the boot crosses them:
  //   - `localReadReady`: local-read core done (schema + registry reconcile + drizzle facade) — zero network.
  //   - `writeReady`: mutation runtime + boot recovery (+ restore quarantine) done — enqueue is safe.
  //   - `bootSettled`: today's full resolution point (sync START done). The worker bridge awaits it (stage 1).
  // Under the Option B contract this function RESOLVES at `localReadReady` and runs the write/sync tail in the
  // background, so a returning offline consumer gets a readable client without waiting on the network. Each
  // stage's rejection is guarded (below) so an unconsumed stage never surfaces as an unhandled rejection —
  // real awaiters still observe the failure.
  // `localReadReady` has no reject binding: a local-read-core failure throws straight out of this async
  // function (so the returned promise rejects, exactly as a pre-ADR-0041 boot failure did) before the client
  // is handed out, leaving `localReadReady` pending on a store nobody holds — no awaiter, no leak.
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

  if (options.pgliteInstance && options.precreatedPglite) {
    throw new Error(
      "createSyncClient: pass at most one of `pgliteInstance` or `precreatedPglite` — they claim different ownership of the post-create boot steps (schema exec, prepare hooks, and registry reconciliation).",
    );
  }

  // Restore (ADR-0035 decision 6) owns the store's CREATION — the backup tarball is a `loadDataDir` seed on
  // the fresh store — so it cannot coexist with a caller-supplied instance (which claims the store already
  // exists and is provisioned). Fail loudly rather than silently ignore one.
  const restoreBoot = options.restoreFrom != null;
  if (restoreBoot && (options.pgliteInstance || options.precreatedPglite)) {
    throw new Error(
      "createSyncClient: `restoreFrom` is mutually exclusive with `pgliteInstance` / `precreatedPglite` — restore boots a brand-new store from the backup (a create-time `loadDataDir` seed), so it cannot adopt a caller-owned instance. Drop the instance option, or drop `restoreFrom` (ADR-0035).",
    );
  }

  // Restore boots start offline and DEFER the sync-enable decision until AFTER journal recovery (ADR-0046,
  // refining ADR-0035 decision 6): a restore comes online iff recovery found NOTHING to quarantine — an empty
  // recovered journal, the guaranteed-clean server-built bootstrap-artifact case — and stays offline (today's
  // behaviour) when recovered mutations were quarantined, because a replayed write is unsafe without a dedupe
  // ledger. The decision is taken in the restore recovery block below (it needs the quarantine count) and
  // honours an explicit `syncEnabled: false`. A normal boot resolves its final value here, up front.
  let syncEnabled = restoreBoot ? false : (options.syncEnabled ?? true);
  // ADR-0032 S4 overlap flag. A restore starts `syncEnabled: false` here, so it never takes the overlap
  // prefetch path (a restore also never presents a fresh spare store); the flag stays `false` for the whole
  // boot even when the restore later comes online (which uses the sequential sync-start path, not overlap).
  const overlapPrefetch = syncEnabled && options.freshStore === true && !options.pgliteInstance;
  // How the store presents at boot (ADR-0034 `storeKind`): a restore boot seeds a brand-new store from a
  // backup; otherwise the caller's fresh-store hint (the same signal as `freshStore`) marks a fresh spare;
  // everything else is a warm (existing persisted) store. Restore wins — a restore boot is never "fresh".
  const storeKind: BootReport["storeKind"] = restoreBoot ? "restored" : options.freshStore === true ? "fresh" : "warm";

  // Engine home for the report (ADR-0049 decision 12): the in-process client is always `"in-process"`; a worker
  // boot carries the placement `engineHome` the worker threaded in (`"shared-worker"` / `"elected-worker"`), or
  // omits it (undefined) when that scope never ran the placement probe (a dedicated elected-engine worker).
  const bootMode: BootReport["mode"] = options.bootMode ?? "in-process";
  const engineHome: BootReport["engineHome"] | undefined = bootMode === "worker" ? options.engineHome : "in-process";

  // Boot observability (ADR-0034): build a structured report across the boot, finalized once at initial
  // sync. Created FIRST so its monotonic anchor precedes every timed phase (including the PGlite create).
  const bootReportBuilder: BootReportBuilder = createBootReportBuilder({
    mode: bootMode,
    freshStore: options.freshStore === true,
    storeKind,
    ...(engineHome != null ? { engineHome } : {}),
    overlapPrefetch,
    registryFingerprint: fingerprintRegistry(options.registry),
  });
  // The single engine lifecycle slot (ADR-0035 decision 4). The three exports plus the destructive
  // lifecycle ops — `destroy()`, `discardEphemeral()`, and `dropReadCache()` — all serialise through it,
  // so a wipe/rebuild can never interleave a running export (nor vice versa): the slot rejects the second
  // entrant with a typed LifecycleBusyError in either direction.
  const lifecycleSlot = createLifecycleSlot();

  let finalizedBootReport: BootReport | null = null;
  const finalizeBootReport = () => {
    if (finalizedBootReport) return;
    finalizedBootReport = bootReportBuilder.finalize();
    options.onBootReport?.(finalizedBootReport);
  };

  // The testing marker (ADR-0036 decision 3), read once off the options object: `"memory"` selects the
  // memory backend for a client-owned create AND acknowledges the BYO seam; `"acknowledged"` only unlocks
  // the BYO refusal. Absent for every production consumer — the marker rides in only via
  // `@pgxsinkit/client/testing`, never named in a public type.
  const testStoreMarker = readTestStoreMarker(options);
  const backendOverride = testStoreMarker === "memory" ? ("memory" as const) : undefined;

  // Bind the create options once for the two client-owned create paths (fresh `storePath`, and the
  // `precreatedPglite` reject-fallback), so both consume the same pre-warm + resolve the same backend.
  // ADR-0049 step 11b: the OPFS-home grant the client-owned mint opens under. Starts at the placement probe's
  // value and is ADJUSTED DOWN to `false` by a deferred/failed adoption (the idb store stays authoritative), or
  // kept `true` when adoption commits the opfs successor (the mint opens the now-committed store). Read at mint
  // time by `timedCreate` below, so the adoption block can settle it before the create runs.
  let bootHasOpfsSyncAccess = options.hasOpfsSyncAccess === true;
  // ADR-0049 step 11c: set by the pre-mint fresh-boot phase machine when it stands up an UNCOMMITTED opfs
  // candidate (virgin/restore) that the shared commitment barrier must promote BEFORE exposure. Read at the
  // local-init milestone below, so a fresh/restore boot commits (strictSync → sentinel → opfs-committed) before
  // `localReadReady` resolves and the client is handed out (invariant 3 — commitment precedes exposure).
  let commitmentBarrierPending = false;
  // ADR-0049 decision 12 `storageFallbackReason`: the verbatim reason an opfs-CAPABLE boot (the probe granted)
  // nonetheless opened idb. `probeGranted` is the entering grant; a fallback is `probeGranted && !bootHasOpfs...`
  // once the adoption + fresh phase machine has settled (never on a plain idb boot, where `probeGranted` is false).
  const probeGranted = options.hasOpfsSyncAccess === true;
  let storageFallbackReason: string | undefined;
  // Durability (ADR-0047 D2 + ADR-0050): resolve the store's declared mode ONCE here — this is the single
  // resolution point — from the registry's static declaration folded with the worker-threaded wire
  // declaration (`options.storage`, the ADR-0050 internal carrier; absent for in-process consumers). An
  // explicit disagreement is a typed refusal (the worker handlers refuse conflicts before this throws).
  // The resolved mode threads into every client-owned mint (its own boot create and the precreated-reject
  // fallback) via the internal carrier on `createClientPGlite`; no open site takes a durability option, so
  // no mint can contradict the data contract.
  const resolvedDurability: StorageDurability = resolveStorageDeclaration(
    getSyncRegistryStorage(options.registry),
    options.storage,
  ).durability;
  const createClientOptions: CreateClientPGliteOptions = {
    ...(options.pgliteBootAssets ? { bootAssets: options.pgliteBootAssets } : {}),
    ...(backendOverride ? { backendOverride } : {}),
    durability: resolvedDurability,
    // Restore (ADR-0035 decision 6): seed the fresh store from the backup via `loadDataDir`. Restore is
    // mutually exclusive with the BYO instance seams (checked above), so it only ever rides a client-owned
    // create — never the adopt paths, which leave `restoreFrom` unread.
    ...(restoreBoot ? { restoreFrom: options.restoreFrom } : {}),
  };
  const fallbackStorePath = options.storePath ?? "pgxsinkit-overlay-v1";
  let openedStorageBackend: NonNullable<BootReport["storageBackend"]> | undefined;

  // Fresh-target gate (ADR-0035 decision 6): restore refuses a store that already exists — it boots a
  // brand-new store and never overlays a live one. Checked BEFORE the create so we never touch (let alone
  // half-write) an existing datadir. The memory test lane is fresh by construction, so the probe is a no-op.
  if (restoreBoot) {
    const targetExists = await storeTargetExists(
      fallbackStorePath,
      backendOverride,
      bootHasOpfsSyncAccess ? { hasIndexedDb: true, hasOpfsSyncAccess: true } : undefined,
    );
    if (targetExists) {
      throw new RestoreTargetExistsError(fallbackStorePath);
    }
  }
  // Time a client-owned `createClientPGlite` into `phases.pgliteCreateMs`; an ADOPTED store (spare or
  // caller-supplied) leaves it `null` (create ran elsewhere — see the provision block below).
  const timedCreate = async (): Promise<ClientPGlite> => {
    const startedAt = performance.now();
    // ADR-0049 step 10b/11b: the OPFS-home grant is spread in at MINT time (not baked into `createClientOptions`),
    // so a boot adoption that ran just above can settle `bootHasOpfsSyncAccess` first — opening the committed
    // opfs successor (adopted) or the idb store (adoption deferred/failed). Default absent keeps today's backend.
    // ADR-0049 decision 12: this is the SINGLE client-owned mint seam, so stamp `storageBackend` from the resolved
    // dataDir scheme here — the same resolution `createClientPGlite` performs, so the diagnostic never diverges
    // from the backend actually opened. Covers every client-owned mint (in-process, worker, precreated-fallback).
    const resolvedDataDir = bootHasOpfsSyncAccess
      ? resolveStoreDataDir(fallbackStorePath, backendOverride, { hasIndexedDb: true, hasOpfsSyncAccess: true })
      : resolveStoreDataDir(fallbackStorePath, backendOverride);
    const created = await createPglite(fallbackStorePath, {
      ...createClientOptions,
      ...(bootHasOpfsSyncAccess ? { hasOpfsSyncAccess: true } : {}),
    });
    // ADR-0049 decision 12: stamp `storageBackend` only AFTER a SUCCESSFUL open (first-wins). A failed opfs open
    // — the virgin-uncreatable session idbfs fallback below re-mints on idb — therefore never stamps
    // `opfs-repacked`; the idb re-mint's `idbfs` is the one that lands, honestly reflecting the backend opened.
    const mintedBackend = storageBackendFromDataDir(resolvedDataDir);
    if (mintedBackend) {
      openedStorageBackend = mintedBackend;
      bootReportBuilder.setStorageBackend(mintedBackend);
    }
    bootReportBuilder.setPgliteCreateMs(performance.now() - startedAt);
    return created;
  };

  // ADR-0049 step 11b — AUTOMATIC adoption (declaration-gated, default off). Honoured ONLY on the client-owned
  // storePath create in a browser OPFS engine home (`bootHasOpfsSyncAccess`), never the BYO / restore paths: a
  // boot that finds an existing idb-authoritative store runs the pre-expose drain check, reconstructs the opfs
  // successor through the Adoption-bootstrap gate, commits it, and deletes the idb predecessor. Any deferral or
  // failure leaves the idb store authoritative — `bootHasOpfsSyncAccess` is flipped to false so the mint opens
  // idb. Runs before the create, so `timedCreate` opens whichever backend the transition settled on.
  const runBootAdoptionIfDeclared = async (): Promise<void> => {
    if (!bootHasOpfsSyncAccess || options.adoption !== "server-reconstructible" || restoreBoot) return;
    const { bootHasOpfs, outcome } = await runBootAdoption(fallbackStorePath, options.adoption, {
      registry: options.registry,
      electricUrl: options.electricUrl,
      batchWriteUrl: options.batchWriteUrl,
      ...(options.getAuthToken ? { getAuthToken: options.getAuthToken } : {}),
      ...(options.requestHeaders ? { requestHeaders: options.requestHeaders } : {}),
      syncEnabled: options.syncEnabled ?? true,
    });
    bootHasOpfsSyncAccess = bootHasOpfs;
    // ADR-0049 decision 12: a declared adoption that DEFERRED/FAILED left idb authoritative — an opfs-capable boot
    // that opened idb. Record the verbatim reason (the outcome's own classification) as the fallback reason.
    if (!bootHasOpfs && outcome && outcome.adopted === false) {
      storageFallbackReason = `adoption deferred (${outcome.reason})`;
    }
  };

  // Refuse a caller-owned instance that is PROVABLY non-persistent (ADR-0036 decision 4), unless a testing
  // acknowledgment is present. `classifyNonPersistentDataDir` inspects the instance's own dataDir (the
  // `ClientPGlite` interface hides it, so via a narrow cast) — the two provably-non-persistent shapes are
  // an undefined dataDir (PGlite's in-memory default) and an explicit memory store. Checked AFTER a
  // successful resolution of the BYO promise, so the refusal PROPAGATES rather than being swallowed by the
  // `precreatedPglite` reject-fallback below (which only catches a create that never produced a store).
  const refuseIfNonPersistent = (instance: ClientPGlite): void => {
    if (testStoreMarker !== undefined) return; // a deliberate test store — acknowledged.
    // An opfs-repacked instance is PROVABLY persistent (a dedicated OPFS directory) yet reports no `dataDir`
    // (custom VFS), so honour its brand before the dataDir classification — otherwise adopting a provisioned
    // opfs store (provision-then-attach, ADR-0049) would be wrongly refused as an in-memory default.
    if ((instance as Record<symbol, unknown>)[OPFS_REPACKED_PERSISTENT] === true) return;
    const observedDataDir = (instance as { dataDir?: string }).dataDir;
    // The two provably-non-persistent shapes: an undefined dataDir (a raw `new PGlite()` in-memory default)
    // and a `memory://` store. Every store the funnel mints carries a real `idb://`/`file://` dataDir string.
    const observed = classifyNonPersistentDataDir(observedDataDir);
    if (observed !== null) throw new NonPersistentStoreError(observed);
  };

  // The complete client-owned open path. Both an ordinary `storePath` boot and a rejected precreated
  // accelerator MUST enter here: recovery/adoption/classification precede every persistent mint. Keeping the
  // flow in one closure prevents a rejected eager create from bypassing live `deleting` authority or the OPFS
  // commitment phase machine by jumping straight to `timedCreate()`.
  const openOwnedStore = async (): Promise<ClientPGlite> => {
    // A capability-denied browser may inherit an interrupted destroy from an earlier granted engine home.
    // Resolve that authority before any replacement IDB store is minted; ordinary denied boots with no
    // `deleting` record remain unchanged apart from the bounded meta read.
    if (!bootHasOpfsSyncAccess && backendOverride !== "memory") {
      await recoverDeniedBootDeletion(fallbackStorePath);
    }
    // ADR-0049 step 11b: run the declaration-gated automatic adoption BEFORE the client-owned mint, so the mint
    // opens the committed opfs successor (adopted) or the still-authoritative idb store (deferred/failed). This
    // COMPOSES with step 11c below: adoption (declared, on an existing idb store) settles `bootHasOpfsSyncAccess`
    // FIRST; only then does the fresh/restore phase machine run.
    if (!adoptionCandidateBuild) await runBootAdoptionIfDeclared();
    // ADR-0049 step 11c: when the opfs grant survives adoption, route the client-owned mint through the boot
    // PHASE MACHINE (invariants 3/12/14). A virgin/restore boot stands up an UNCOMMITTED opfs candidate (record
    // BEFORE directory) and flags the commitment barrier for the local-init milestone; a committed store resolves
    // `open-committed` (no re-run — composes with an adoption that just committed); a recordless idb store (adoption
    // not declared) downgrades to idb (never a fresh opfs mint over an existing idb store's data). A `false` grant (probe denied
    // OR adoption deferred/failed) SHORT-CIRCUITS — the idbfs home opens directly, without the opfs commitment phase machine.
    if (adoptionCandidateBuild) {
      // The predecessor remains authoritative and its journal was proven drained before the outer transition
      // entered `adopting`. Remove any sentinel-less residue from an earlier authorized destruction, then create
      // the directory the candidate factory will open. No meta write and no commitment here: the outer adoption
      // transition owns both.
      const opfs = createOpfsEffects(fallbackStorePath);
      await opfs.deleteSentinel();
      await opfs.deleteStoreDirectory();
      await opfs.getStoreDirectoryHandle();
    } else if (bootHasOpfsSyncAccess) {
      const fresh = await resolveFreshBoot(fallbackStorePath, bootHasOpfsSyncAccess, backendOverride);
      // ADR-0049 decision 12: the phase machine downgraded a granted opfs boot to idb (invariant 14 — an existing
      // idb store is opened in place, never overwritten by a fresh opfs mint). That is an opfs-capable-boot-on-idb
      // fallback; record its verbatim verdict as the reason (only when adoption did not already set one).
      if (!fresh.bootHasOpfs && storageFallbackReason == null) {
        storageFallbackReason = `recordless idb store opened in place (invariant 14; verdict ${fresh.verdict?.action ?? "unknown"})`;
      }
      bootHasOpfsSyncAccess = fresh.bootHasOpfs;
      commitmentBarrierPending = fresh.needsCommitmentBarrier;
    }
    // ADR-0049 D6 — the VIRGIN-UNCREATABLE session idbfs fallback (plan step 13 gap; fault row "opfs uncreatable,
    // virgin → Session idbfs fallback after bounded retries, record written"). A VIRGIN/candidate opfs boot
    // (`commitmentBarrierPending` true — phase opfs-candidate, NO sentinel ever published) that cannot OPEN the
    // opfs store after `openWithBoundedRetries` exhausts tears the never-committed candidate down and re-mints on
    // idbfs FOR THIS SESSION ({@link fallbackVirginCandidateToIdb}: record → idb-authoritative, directory
    // deleted). A COMMITTED store's open failure is HARD: `commitmentBarrierPending` is false for
    // `open-committed` / `repair-record-then-open-committed` (record committed OR sentinel present), so the catch
    // is not even entered and the failure propagates. The fallback is thus reachable ONLY on positive proof of
    // absence (the virgin/candidate path), never over a committed store.
    if (commitmentBarrierPending) {
      try {
        return await timedCreate();
      } catch (openError) {
        storageFallbackReason = await fallbackVirginCandidateToIdb(fallbackStorePath, openError);
        bootHasOpfsSyncAccess = false;
        commitmentBarrierPending = false;
        return timedCreate();
      }
    }
    return timedCreate();
  };

  let pglite: ClientPGlite;
  // Whether the boot adopted the caller's `precreatedPglite` (vs. falling back to a fresh create) — gates
  // whether the provision stamp is honoured (ADR-0034).
  let adoptedPrecreated = false;
  if (options.pgliteInstance) {
    // The caller created AND provisioned this store; the client runs NONE of the post-create boot steps
    // (schema, prepare hooks, and reconciliation) — see the `pgliteInstance` JSDoc. No create here →
    // `pgliteCreateMs` null.
    refuseIfNonPersistent(options.pgliteInstance);
    pglite = options.pgliteInstance;
  } else if (options.precreatedPglite) {
    // The caller created the raw store eagerly via `createClientPGlite`; the client still owns every
    // post-create step below. A REJECTED eager create must never fail the boot: fall back to the normal
    // `storePath` create, so the pattern stays a pure accelerator. Reify the promise's outcome first, THEN
    // branch — so the {@link NonPersistentStoreError} refusal runs on a SUCCESSFULLY resolved instance,
    // outside any catch, and PROPAGATES (never swallowed by the reject-fallback, which is only for a create
    // that never produced a store).
    const outcome = await options.precreatedPglite.then(
      (instance) => ({ ok: true as const, instance }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    if (outcome.ok) {
      refuseIfNonPersistent(outcome.instance);
      pglite = outcome.instance;
      adoptedPrecreated = true;
    } else {
      syncDebug("boot precreated pglite rejected — falling back to storePath create", {
        error: outcome.error instanceof Error ? outcome.error.message : String(outcome.error),
      });
      pglite = await openOwnedStore();
    }
  } else {
    pglite = await openOwnedStore();
  }
  // ADR-0049 decision 12: stamp the fallback reason once the mint's backend is settled. Guarded on `probeGranted`
  // (an opfs-capable boot) — a plain idb boot never enters the adoption/fresh phase machine, so it never sets one.
  if (probeGranted && !bootHasOpfsSyncAccess && backendOverride !== "memory" && storageFallbackReason != null) {
    bootReportBuilder.setStorageFallbackReason(storageFallbackReason);
  }
  // ADR-0049 D1/D12 capability-absence fallback: `defineSyncWorker`'s placement bootstrap opened the in-SW IDBFS
  // engine because OPFS was CAPABLE but no home could hold handles. That boot enters here with `hasOpfsSyncAccess`
  // FALSE (so the internal `probeGranted` guard above never fires), so stamp the externally-supplied reason here on
  // the idbfs mint. `setStorageFallbackReason` is first-wins, so an internal reason already set is never clobbered.
  if (options.storageFallbackReason != null && backendOverride !== "memory" && !bootHasOpfsSyncAccess) {
    bootReportBuilder.setStorageFallbackReason(options.storageFallbackReason);
  }
  // ADR-0049 decision 12: a BYO instance / adopted-precreated store was created OUTSIDE the mint seam, so derive
  // its `storageBackend` from the instance's own dataDir where recognisable; an opfs-repacked wrapper (or an
  // unknown scheme) leaves it omitted (`setStorageBackend` is first-wins, so a fallback-create is never clobbered).
  if (options.pgliteInstance != null || adoptedPrecreated) {
    const byoBackend = storageBackendFromDataDir((pglite as { dataDir?: string }).dataDir);
    if (byoBackend) {
      openedStorageBackend = byoBackend;
      bootReportBuilder.setStorageBackend(byoBackend);
    }
  }
  // ADR-0049 step 11b: register the client-owned store path in the live-store guard so the manual `adoptStore`
  // API refuses to migrate a store an open client already holds (`StoreInUseError`). BYO instances the caller
  // owns are not registered (the caller manages their lifecycle). Unregistered on `stop()`/`destroy()` below.
  const ownsStoreLifecycle = !options.pgliteInstance;
  if (ownsStoreLifecycle) liveStorePaths.add(fallbackStorePath);

  // Provision block (ADR-0034): when the boot adopted a pre-provisioned store and the provisioner stamped
  // its create timing, report the spare's initdb cost + how long it sat ready, and leave `pgliteCreateMs`
  // null (the create was paid at provision time, off this boot's clock).
  if (adoptedPrecreated && options.provisionStamp) {
    const stamp = await options.provisionStamp.catch(() => null);
    if (stamp) {
      bootReportBuilder.setProvision({
        initdbMs: stamp.initdbMs,
        provisionedMsBeforeBoot: Math.max(0, bootReportBuilder.bootStartPerf - stamp.provisionReadyAt),
      });
    }
  }

  // Attach the sync engine explicitly, over the already-created instance, on ALL three provenance paths
  // (pgliteInstance, precreatedPglite, storePath) — ADR-0032 S1. The engine is no longer a create-time
  // extension, so the raw store (a `createClientPGlite` mint, or a caller's own instance) carries no
  // `electric` namespace until this point; the property assignment gives `ClientPGlite` its exact former
  // structural shape (live + electric) so every `pglite.electric.…` call site is unchanged. It is attached
  // BEFORE the schema/prepare steps below so a `prepareLocalDbAfterSchema` hook sees the same `.electric` it did when
  // the extension provided it at create time. `engine.close` (the former extension close hook — abort every
  // shape stream) is kept private to this client and run explicitly by `stop`/`destroy` at the same moment
  // `pglite.close()` used to trigger it.
  const engine: SyncEngine = await createSyncEngine(pglite);
  (pglite as { electric: SyncEngine["namespace"] }).electric = engine.namespace;

  // Whether the read path's first initial sync has completed, so a recovery from `auth-needed` returns to
  // the right steady-state phase (`ready` if already caught up, else `syncing`).
  let initialSyncCompleted = false;
  // Why the runtime is `degraded` (#4). A read-stream error degraded clears on the next successful batch; a
  // commit-failure degraded is sticky (a fetch can succeed while applies still fail), so a bare
  // `onSyncActivity` must not clear it.
  let degradedReason: "stream" | "commit" | null = null;

  // ─── Fresh-store prefetch overlap (ADR-0032 S4 / backlog-0003) ─────────────────────────────────────
  // On a PROVABLY-FRESH store (the caller's `freshStore` hint — a claimed schemaless spare) the shape
  // catch-up needs none of the local boot phases, so start it NOW and gate its commits on `dbReady`, which
  // we resolve once schema exec + journal recovery + registry reconciliation complete. The network then
  // overlaps those phases instead of running strictly after them. Gated to the schema-owning paths (the
  // `pgliteInstance` path runs no schema step, so it has nothing to hide); warm stores keep the exact
  // sequential path. See the `freshStore` option's JSDoc for who sets the hint (the board's claim path).
  // (`overlapPrefetch` is computed once up front — see the boot-report builder above.)
  let openDbGate: () => void = () => {};
  const dbReady = overlapPrefetch
    ? new Promise<void>((resolve) => {
        openDbGate = resolve;
      })
    : null;

  // The sync-start options, built once and used by BOTH the overlap early-start and the sequential start —
  // the only per-call difference is the promoted-lazy set (empty on a fresh store) and the overlap gate.
  const buildStartOptions = (promotedGroups: ReadonlySet<string>): Parameters<typeof startConfiguredSync>[1] => ({
    syncConfig: buildSyncConfigFromRegistry(options.registry, options.electricUrl),
    registry: options.registry,
    promotedGroups,
    ...(dbReady ? { dbReady } : {}),
    // Boot observability (ADR-0034): the collector opens a per-boot-group accumulator (rows/requests/fetch/
    // apply wall) for the eager + promoted groups; lazy on-demand starts get none, so they never enter the report.
    bootCollector: bootReportBuilder,
    // Persist a durable lazy group's activation on first on-demand start, so the next boot promotes it.
    onLazyActivated: (groupKey) => {
      void writeLazyGroupActivation(pglite, options.registry, groupKey);
    },
    // The read path resolves the token per request (ADR-0013), not frozen at boot — so a long-lived session
    // never wedges on JWT expiry. Read and write share one token lifecycle.
    ...(options.getAuthToken || options.requestHeaders
      ? {
          shapeHeaders: buildShapeHeaders({
            ...(options.getAuthToken ? { getAuthToken: options.getAuthToken } : {}),
            ...(options.requestHeaders ? { requestHeaders: options.requestHeaders } : {}),
          }),
        }
      : {}),
    ...(options.onTableInitialSync ? { onTableInitialSync: options.onTableInitialSync } : {}),
    // Per-group readiness (ADR-0032 decision 6): mirror each group's catch-up into `status.groups` and
    // re-emit, so an app can drive progressive per-group paint off `status` (and `client.groupReady`).
    onGroupReady: (groupKey) => {
      status.groups = { ...(status.groups ?? {}), [groupKey]: true };
      options.onStatusChange?.(status);
    },
    onInitialSync: () => {
      initialSyncCompleted = true;
      status.phase = "ready";
      options.onStatusChange?.(status);
      // Boot complete: the first initial sync landed and `ready` is about to resolve. One monotonic stamp
      // closes the boot rail opened by `boot pglite.create` (the stamp itself is the number).
      syncDebug("boot client ready");
      // Boot observability (ADR-0034): finalize the report at exactly this moment — the `boot client ready`
      // rail line — and fire the one-shot `onBootReport` push. Idempotent, so the sync-disabled path's own
      // finalize below never double-fires it.
      finalizeBootReport();
      resolveReady();
    },
    onSyncError: (error) => {
      // A sync commit exhausted its retries (ADR-0009 decision 5): go degraded and surface it, rather than
      // letting the read cache silently diverge from the server. Sticky (see below).
      status.phase = "degraded";
      degradedReason = "commit";
      // The cause chain, not just the wrapper: a drizzle "Failed query" message hides the actual
      // database error (SQLSTATE, detail) on `.cause`.
      status.lastError = describeErrorChain(error);
      options.onStatusChange?.(status);
      options.onSyncError?.(error);
    },
    // #4: a terminal/transient NON-auth read-stream error → `degraded`, so the runtime never keeps reporting
    // healthy while the read stream has stalled. Does not override the more-actionable `auth-needed`, nor a
    // commit-failure degraded. Cleared on the next successful batch below.
    onReadStreamError: (error) => {
      // Never mask the more-actionable auth-needed, nor a sticky commit-failure degraded (its lastError is
      // the more serious signal — a stream blip must not overwrite it).
      if (status.phase === "auth-needed") return;
      if (status.phase === "degraded" && degradedReason === "commit") return;
      // Enter, or refresh, a stream-degraded status. Refreshing keeps `lastError` pointing at the most
      // recent stream fault (and re-emits) rather than freezing on the first one, so a stream that fails one
      // way then another reports the current cause (observability).
      status.phase = "degraded";
      degradedReason = "stream";
      status.lastError = describeErrorChain(error);
      options.onStatusChange?.(status);
    },
    // Clear a recoverable status (auth-needed, or a read-stream degraded) the moment a batch is delivered
    // again. A commit-failure degraded is NOT cleared here — a fetch can succeed while applies keep failing,
    // so only `onSyncError` clearing (a clean commit) would lift it.
    onSyncActivity: () => {
      if (status.phase === "auth-needed" || (status.phase === "degraded" && degradedReason === "stream")) {
        degradedReason = null;
        status.phase = initialSyncCompleted ? "ready" : "syncing";
        options.onStatusChange?.(status);
      }
    },
    // ADR-0013 Phase 3: surface a persistent read-path auth failure as a distinct `auth-needed` status (the
    // app prompts re-login) while the stream keeps retrying for a fresh token. Only wired when a token
    // provider exists — without one there is no auth lifecycle to track.
    ...(options.getAuthToken
      ? {
          onAuthError: () => {
            if (status.phase !== "auth-needed") {
              status.phase = "auth-needed";
              options.onStatusChange?.(status);
            }
          },
        }
      : {}),
  });

  // Overlap: kick the shape streams off BEFORE schema exec (they buffer catch-up into the memory inbox,
  // commits gated on `dbReady`). A fresh store has no persisted lazy activations and no subscriptions to
  // reset, so both DB reads the sequential path makes first are skipped here.
  let earlySync: ReturnType<typeof startConfiguredSync> | null = null;
  let earlySyncStartedAt = 0;
  if (overlapPrefetch) {
    status.isRunning = true;
    status.phase = "syncing";
    options.onStatusChange?.(status);
    earlySyncStartedAt = performance.now();
    earlySync = startConfiguredSync(
      pglite as unknown as Parameters<typeof startConfiguredSync>[0],
      buildStartOptions(new Set()),
    );
  }

  if (!options.pgliteInstance) {
    if (options.prepareLocalDbBeforeSchema) {
      const prepareBeforeSchema = options.prepareLocalDbBeforeSchema;
      await bootReportBuilder.phase("prepare", "boot prepare(before-schema)", () => prepareBeforeSchema(pglite));
    }

    // Durable-schema fingerprint fast path. The whole block stays inside the
    // `schemaExec` phase so `schemaExecMs` remains comparable across the fast (skip) and full (replay) paths.
    await bootReportBuilder.phase("schemaExec", "boot local schema", async () => {
      // (2) The minimal bootstrap first — one small crossing so the `local_schema_fingerprint` read/write
      // below has its `pgxsinkit_local_meta` table before the durable replay is decided.
      await pglite.exec(buildLocalMetaBootstrapSql(options.registry));

      // (3) Generate the durable SQL (JS-only) and hash it; compare with the stored fingerprint.
      const currentFingerprint = computeLocalSchemaFingerprint(options.registry);
      const storedFingerprint = await readStoredLocalSchemaFingerprint(pglite, options.registry);

      if (storedFingerprint === currentFingerprint) {
        // (4a) Match → SKIP the durable replay entirely; the persisted durable schema is already current.
        bootReportBuilder.setSchemaFastPath({ skipped: true, fingerprintMatch: true });
      } else {
        // (4b) Absent/mismatch → replay the durable schema, then stamp the fingerprint after success.
        await pglite.exec(generateDurableLocalSchemaSql(options.registry));
        await writeStoredLocalSchemaFingerprint(pglite, options.registry, currentFingerprint);
        bootReportBuilder.setSchemaFastPath({ skipped: false, fingerprintMatch: false });
      }

      // (5) ALWAYS apply the ephemeral schema (TEMP relations die with the old engine), skipping the
      // crossing when the registry declares no ephemeral entry (the generator returns "").
      const ephemeralSql = generateEphemeralLocalSchemaSql(options.registry);
      if (ephemeralSql.length > 0) {
        await pglite.exec(ephemeralSql);
      }
    });

    if (options.prepareLocalDbAfterSchema) {
      const prepareLocalDbAfterSchema = options.prepareLocalDbAfterSchema;
      await bootReportBuilder.phase("prepare", "boot prepare(local-db)", () => prepareLocalDbAfterSchema(pglite));
    }
  }

  // The write path's headers are the shared base plus the write-only overrides (region/DB-affinity):
  // `{...requestHeaders, ...writeRequestHeaders}`. The read/shape path keeps `requestHeaders` alone
  // (below), so `writeRequestHeaders` never reach reads — the two ingress points pin independently.
  const writePathHeaders =
    options.requestHeaders || options.writeRequestHeaders
      ? { ...(options.requestHeaders ?? {}), ...(options.writeRequestHeaders ?? {}) }
      : undefined;

  // ADR-0039: an ordinary optimistic write activates its target's lazy consistency group (a write is a
  // reference, and a reference activates — the read path already does this). The runtime reports the
  // non-blind table keys per enqueue; this indirection is assigned once `ensureSynced`/`lazyGuardIndex`
  // exist below (a write never fires during boot, so it is a harmless no-op until then).
  let activateOrdinaryWriteTables: ((tables: readonly string[]) => void) | null = null;
  const mutationRuntime = createMutationRuntime({
    db: pglite,
    registry: options.registry,
    batchWriteUrl: options.batchWriteUrl,
    // pgxsinkit owns the local schema (and the `pgxsinkit_local_meta` marker table) unless the caller
    // supplied their own PGlite — then the marker is never touched and recovery runs unconditionally.
    ownsMetaTable: !options.pgliteInstance,
    onOrdinaryEnqueue: (tables) => activateOrdinaryWriteTables?.(tables),
    ...(options.getAuthToken ? { getAuthToken: options.getAuthToken } : {}),
    ...(writePathHeaders ? { requestHeaders: writePathHeaders } : {}),
    ...(options.maxMutationAttempts != null ? { maxMutationAttempts: options.maxMutationAttempts } : {}),
    ...(options.onQuarantine ? { onQuarantine: options.onQuarantine } : {}),
    ...(options.onConflict ? { onConflict: options.onConflict } : {}),
    ...(options.onReject ? { onReject: options.onReject } : {}),
  });

  // Activation buffer (ADR-0041): a read (`ensureSynced`) OR a write (`onOrdinaryEnqueue`) can reference a
  // lazy group after `localReadReady` but BEFORE `sync` is wired (the Option B window). With a null `sync` the
  // seams cannot start a group, so BOTH feed this one buffer; the tail replays it once sync is wired, so the
  // activation is never LOST across the staged split (ADR-0039 semantics preserved). Null once replayed (or on
  // a tail failure — see the tail's rejection handler).
  let pendingActivations: Set<string> | null = new Set();

  let versionEvent: LocalStoreVersionEvent | null = null;

  // Boot recovery (ADR-0005) driven by the durable recovery marker (slice 2), PLUS the restore quarantine
  // (ADR-0035 decision 6, gated on `restoreBoot` inside `runBootRecovery`). Hoisted so the restore path runs
  // it BEFORE read exposure (the ADR-0041 invariant) and the normal path defers it to the background write
  // tail. `runBootRecovery` owns the full decision — marker read, skip/unconditional/transactional recovery, restore
  // quarantine, marker clear — and returns the honest `warmBoot` outcome (ADR-0034).
  const runBootRecoveryStage = async (): Promise<void> => {
    const recoveryOutcome = await bootReportBuilder.phase("journalRecovery", "boot journal recovery", () =>
      mutationRuntime.runBootRecovery({ ownsMetaTable: !options.pgliteInstance, restore: restoreBoot }),
    );
    bootReportBuilder.setJournalRecovery(recoveryOutcome);
  };

  const runReconcileStage = async (): Promise<void> => {
    if (options.pgliteInstance) return;
    versionEvent = await bootReportBuilder.phase("storeVersionReconcile", "boot store-version reconcile", () =>
      reconcileLocalStoreVersion({
        db: pglite,
        registry: options.registry,
        runtime: mutationRuntime,
        ...(options.onSchemaChange ? { onSchemaChange: options.onSchemaChange } : {}),
      }),
    );
  };

  if (restoreBoot) {
    // Restore invariant (ADR-0041): quarantine every recovered write before exposing a read facade.
    // `localReadReady` and `writeReady` therefore coincide on a restore boot.
    await runBootRecoveryStage();

    // ADR-0046: with recovery + quarantine complete, decide whether this restore comes online. The restore
    // quarantine pass parked every recovered non-terminal write (pending/sending/failed) as `quarantined`, so a
    // zero quarantined count means the backup's journal was CLEAN — the server-built bootstrap-artifact case —
    // and sync may start exactly as a normal boot would. A non-zero count keeps the boot offline (the protective
    // ADR-0035 rule, now applied only where it protects) until the app releases the rows; a subsequent normal
    // boot then brings sync online. An explicit `syncEnabled: false` is always honoured (stays offline).
    const recoveredQuarantined = (await mutationRuntime.readMutationStats()).quarantinedCount;
    if (recoveredQuarantined === 0 && options.syncEnabled !== false) {
      syncEnabled = options.syncEnabled ?? true;
      syncDebug("boot restore comes online — recovered journal was clean (nothing to quarantine)");
    } else if (recoveredQuarantined > 0) {
      syncDebug(
        "boot restore stays offline — recovered journal mutations were quarantined; release/discard them and a subsequent normal boot brings sync online",
        { quarantinedCount: recoveredQuarantined, syncEnabledOption: options.syncEnabled ?? null },
      );
    }
    await runReconcileStage();
  } else {
    await runReconcileStage();
  }

  const drizzleDb = createDrizzleDatabase(pglite, buildSchema(options.registry));
  // Static index of the registry's lazy relations (ADR-0021), driving the read-path safety net.
  const lazyGuardIndex = buildLazyGuardIndex(options.registry);

  let sync: Awaited<ReturnType<typeof startConfiguredSync>> | null = null;
  let convergenceDriver: ConvergenceDriver | null = null;

  // Lifecycle guard (ADR-0041): `stop()`/`destroy()` can now be called while the background write/sync tail is
  // still in flight (React StrictMode mount/unmount is the canonical case). `disposed` lets the tail bail at
  // each stage boundary — before setting `isRunning`, before starting sync — so no shape stream starts after a
  // stop; and `stop`/`destroy` await `bootSettled` before teardown so the tail can never exec against a
  // closing PGlite.
  let disposed = false;
  // Resolves the moment `sync` is wired (and the activation buffer replayed); rejects if the boot is disposed
  // or the tail fails before wiring — so a read seam awaiting it in the pre-wire window unblocks rather than
  // hanging. On a sync-DISABLED boot it resolves at tail end (reads short-circuit before awaiting it anyway).
  let resolveSyncWired!: () => void;
  let rejectSyncWired!: (error: unknown) => void;
  const syncWired = new Promise<void>((resolve, reject) => {
    resolveSyncWired = resolve;
    rejectSyncWired = reject;
  });
  void syncWired.catch(() => undefined);
  // True once `sync` is genuinely wired — the read seams use this (not just `sync != null`) plus `syncEnabled`
  // to tell "sync disabled" (trivially ready) apart from "sync pending" (not yet ready / hydrating).
  const isSyncPending = (): boolean => syncEnabled && sync == null && !disposed;

  // Quiesce the background write/sync tail before a teardown (ADR-0041 BLOCKER 2). `stop()`/`destroy()` can be
  // called while the tail is still in flight (React StrictMode mount/unmount). Flag disposal so the tail bails
  // at its next stage boundary (never starting sync after this), gracefully release any read seam parked on
  // `syncWired` (it then falls through to the local-only path), then AWAIT `bootSettled` — swallowing a tail
  // failure — so the tail has fully SETTLED before teardown touches the engine/PGlite. Any sync the tail did
  // manage to start is assigned to `sync` by the time this resolves, for the caller's `sync?.unsubscribe()`.
  const quiesceTailForTeardown = async (): Promise<void> => {
    disposed = true;
    // ADR-0049 step 11b: release the live-store guard so a later manual `adoptStore` on this path is permitted
    // once this client is torn down (delete-if-present; a BYO-instance boot never registered, so it is a no-op).
    liveStorePaths.delete(fallbackStorePath);
    // FIX 2: a stopped client can never reach `writeReady` / `ready`, so reject them (idempotent — a race with
    // the tail's own resolve is settled first-wins; a normal stop AFTER boot is a no-op on the already-resolved
    // promises) so a parked mutation or an `await ready` / `start()` fails FAST rather than hanging past
    // teardown. `bootSettled` still RESOLVES below as teardown completion. Both are guarded by the
    // `.catch(() => undefined)` at construction, so an unconsumed rejection never leaks.
    const disposedError = new ClientDisposedError();
    rejectWriteReady(disposedError);
    rejectReady(disposedError);
    resolveSyncWired();
    await bootSettled.catch(() => undefined);
  };

  // Synchronously halt ALL sync/write ACTIVITY without awaiting anything — the first action of every teardown
  // entry point (stop()/destroy() here, and the SharedWorker host's closeHost, which calls this before it drains
  // pending subscribes or disposes live queries). Abort the mutation runtime's in-flight write fetches + any
  // stalled auth resolve, abort every shape-stream long-poll (engine.close's AbortControllers fire synchronously),
  // and stop convergence scheduling (the in-flight pass then settles fast — its fetch is aborted). Idempotent.
  // Without this, a teardown step that runs BEFORE the streams are aborted (live-query dispose, pending-subscribe
  // drain) races an engine still committing shape data and never settles. The full AWAITED teardown still runs
  // after; this only guarantees the network + scheduling are already dead when it does.
  const haltActivity = (): void => {
    disposed = true;
    mutationRuntime.abortInFlight();
    void engine.close();
    void convergenceDriver?.stop();
  };

  // The write/sync activation tail (ADR-0041 decision 3). On a NORMAL boot this runs in the BACKGROUND after
  // `localReadReady` resolves, so `createSyncClient` resolves at `localReadReady` (the Option B contract). On a
  // restore boot recovery already ran in the core, so the tail only opens the (unused) gate and settles. It
  // resolves `bootSettled` — today's full resolution point (sync START done; initial catch-up is NOT awaited,
  // that is `ready`), which the worker bridge awaits so worker-mode external timing is unchanged in stage 1.
  const runWriteAndSyncTail = async (): Promise<void> => {
    // Bail if the client was stopped before the tail even started (StrictMode mount/unmount): no write runtime
    // activation, no sync start. `bootSettled` still resolves (this returns), unblocking `stop()`'s await.
    if (disposed) return;
    // Normal boot: recovery runs here (restore already ran it in the core, before read exposure).
    if (!restoreBoot) {
      await runBootRecoveryStage();
    }
    if (disposed) return;
    // Write runtime + boot recovery complete — enqueue is safe. Stamp + resolve `writeReady` (idempotent: on a
    // restore boot it already resolved in the core alongside `localReadReady`).
    bootReportBuilder.setWriteReadyMs(performance.now() - bootReportBuilder.bootStartPerf);
    resolveWriteReady();

    // Do NOT set `isRunning` / start sync after a stop (BLOCKER 2): bail here so no shape stream is ever
    // started once teardown has begun.
    if (disposed) return;
    status.isRunning = true;

    // Open the overlap commit gate now the local store is ready (schema exec + journal recovery + reconcile
    // done): the catch-up the streams prefetched during those phases now drains in one commit train. A no-op
    // on the sequential path (`openDbGate` is the empty default there).
    openDbGate();

    if (syncEnabled) {
      if (earlySync) {
        // Overlap path: the shape streams have been prefetching since before schema exec; adopt the handle
        // (it resolves as soon as the streams are subscribed — catch-up drains via the gate just lifted, and
        // `onInitialSync` still gates `ready` on a fully-consistent first paint). The construction was kicked
        // off before schema exec, so time it here (concurrent-segment wall) into `phases.syncStartMs`.
        sync = await earlySync;
        bootReportBuilder.setSyncStartMs(performance.now() - earlySyncStartedAt);
        bootReportBuilder.markSyncStartDone();
      } else {
        // Sequential path (warm store / no fresh hint): apply any explicit subscription resets, promote
        // durable lazy groups, then start (catch-up strictly after the local phases).
        const resetKeys =
          versionEvent?.status === "rebuilt"
            ? [...(options.resetSubscriptionKeys ?? []), ...allGroupSubscriptionKeys(options.registry)]
            : options.resetSubscriptionKeys;
        await resetSubscriptionsIfRequested(pglite, resetKeys);
        // Re-check after the awaited reset: a stop during it must still abort BEFORE the network shape streams
        // start (BLOCKER 2 — cannot start sync after stop).
        if (disposed) return;

        status.phase = "syncing";
        options.onStatusChange?.(status);

        // Promote any `lazy + persistent` group activated on a previous boot back into the eager set
        // (ADR-0021 §2); the sync engine does no DB read of its own.
        const promotedGroups = await readActivatedLazyGroups(pglite, options.registry);
        if (disposed) return;

        sync = await bootReportBuilder.phase("syncStart", "boot sync start", () =>
          startConfiguredSync(
            pglite as unknown as Parameters<typeof startConfiguredSync>[0],
            buildStartOptions(promotedGroups),
          ),
        );
        bootReportBuilder.markSyncStartDone();
      }
      // If a stop landed DURING the sync-start await, unsubscribe the just-started streams here rather than
      // leaving them running (stop read `sync` as null before this assignment), then bail.
      if (disposed) {
        sync?.unsubscribe();
        sync = null;
        return;
      }
    } else {
      status.phase = "ready";
      options.onStatusChange?.(status);
      // Sync disabled: there is no `onInitialSync` gate, but boot IS complete — finalize the report at the
      // same moment `ready` resolves (ADR-0034). Idempotent with the sync path's finalize.
      finalizeBootReport();
      resolveReady();
    }

    // ADR-0039/0041: replay every activation (read via `ensureSynced` AND write via `onOrdinaryEnqueue`)
    // buffered while `sync` was still null. Now `sync` is wired, re-issuing them through `ensureSynced` starts
    // the referenced groups — the activation is preserved, never lost across the split. Awaited so the groups
    // are STARTED before `syncWired` resolves (a `ensureSynced`/`prepareQuery` awaiter then sees them active).
    const buffered = pendingActivations;
    pendingActivations = null;
    if (sync != null && buffered && buffered.size > 0) {
      await ensureSynced([...buffered] as SyncTableName<TRegistry>[]);
    }
    // Sync is wired (or disabled and boot complete): unblock any read seam that parked on `syncWired`.
    resolveSyncWired();
  };

  // Convergence driver (ADR-0035 decision 6 / ADR-0046): a restore boot that STAYS offline (recovered journal
  // quarantined) never stands up the driver, so an `autoSync` trigger drives NO flush/reconcile passes — the
  // quarantined rows must stay put until the app releases them and a normal boot goes online. A restore that
  // came online (clean recovered journal) is treated exactly like a normal online boot and DOES get the driver.
  // On every non-restore boot the gate is unchanged (`!restoreBoot` is true regardless of `syncEnabled`).
  if (options.autoSync && (!restoreBoot || syncEnabled)) {
    convergenceDriver = createConvergenceDriver({
      client: {
        flush: () => mutationRuntime.flush(),
        reconcile: () => mutationRuntime.reconcile(),
      },
      trigger: options.autoSync,
      ...(options.onConvergencePass ? { onPass: options.onConvergencePass } : {}),
    });

    // Start driving convergence once the initial sync is ready, so a pass never races the first shape load.
    // stop()/destroy() halt it. `ready` is now rejectable (ADR-0041: the background tail rejects it on
    // failure), so the rejection handler keeps the driver un-started and off the unhandled-rejection path.
    void ready.then(
      () => convergenceDriver?.start(),
      () => undefined,
    );
  }

  // Event-driven convergence: the moment a mutation is enqueued, ask the driver to run a pass so the
  // write flushes immediately rather than waiting for the trigger's next interval tick. This is what
  // lets the interval be a rare fallback (and so run far less often). No-op when `autoSync` is off — the
  // caller drives `flush`/`reconcile` itself.
  const requestConvergence = () => convergenceDriver?.requestPass();
  // Every write-path method gates on `writeReady` (ADR-0041): a write issued the instant `localReadReady`
  // resolves awaits the write runtime + boot recovery rather than racing an unfinished boot or failing
  // opaquely. `writeReady` is already resolved on the steady-state client, so this is a settled-promise await.
  const mutate: SyncClient<TRegistry>["mutate"] = {
    create: async (table, input) => {
      await writeReady;
      await mutationRuntime.create(table, input);
      requestConvergence();
    },
    update: async (table, entityKey, patch) => {
      await writeReady;
      await mutationRuntime.update(table, entityKey, patch);
      requestConvergence();
    },
    delete: async (table, entityKey) => {
      await writeReady;
      await mutationRuntime.delete(table, entityKey);
      requestConvergence();
    },
    batch: async (items) => {
      await writeReady;
      await mutationRuntime.batch(items);
      requestConvergence();
    },
  };

  // ─── Anonymous-activation diagnostic (ADR-0039) ────────────────────────────────────────────────
  // Per group key, whether ANY member's row filter denies (or cannot serve) an unauthenticated caller,
  // plus its member registry keys (for the warning). The registry is static and the group→member map is
  // fixed once sync is running, so it is computed once and cached.
  type GroupClaimsInfo = { claimsDependent: boolean; memberKeys: string[] };
  let groupClaimsInfoCache: Map<string, GroupClaimsInfo> | null = null;
  const groupClaimsInfoFor = (activeSync: NonNullable<typeof sync>): Map<string, GroupClaimsInfo> => {
    if (groupClaimsInfoCache != null) return groupClaimsInfoCache;
    const map = new Map<string, GroupClaimsInfo>();
    for (const key of Object.keys(options.registry) as SyncTableName<TRegistry>[]) {
      const groupKey = activeSync.groupKeyForTable(key as string);
      if (groupKey == null) continue;
      const entry = options.registry[key] as SyncTableEntry;
      const info = map.get(groupKey) ?? { claimsDependent: false, memberKeys: [] };
      info.memberKeys.push(key as string);
      if (isClaimsDependentRowFilter(entry.shape?.rowFilter)) info.claimsDependent = true;
      map.set(groupKey, info);
    }
    groupClaimsInfoCache = map;
    return map;
  };
  // One warning per group key, ever (a claims-denied group activated with no token opens an empty
  // subscription by construction, so repeated activations must not spam).
  const anonymousActivationWarned = new Set<string>();
  const warnIfAnonymousClaimsDependentActivation = (activeSync: NonNullable<typeof sync>, groupKey: string) => {
    if (anonymousActivationWarned.has(groupKey)) return;
    const info = groupClaimsInfoFor(activeSync).get(groupKey);
    if (info == null || !info.claimsDependent) return;
    // Fire-and-forget: activation never blocks or fails on the token probe (a rejected `getAuthToken`
    // is swallowed into a syncDebug line). The dedupe Set is checked+set synchronously around the warn,
    // so concurrent activations still emit at most one console.warn.
    void (async () => {
      try {
        const token = options.getAuthToken ? await options.getAuthToken() : undefined;
        if (token != null && token !== "") return;
        if (anonymousActivationWarned.has(groupKey)) return;
        anonymousActivationWarned.add(groupKey);
        console.warn(
          `pgxsinkit: activating the lazy group [${info.memberKeys.join(", ")}] with no auth token — its ` +
            `row filter denies unauthenticated callers, so this opens an empty subscription. Gate the first ` +
            `query on auth (e.g. the React hooks' \`ready\` option) so the group activates with real claims.`,
        );
        syncDebug("anonymous activation of a claims-dependent lazy group", {
          groupKey,
          tables: info.memberKeys,
        });
      } catch (error) {
        syncDebug("anonymous-activation auth probe failed", { groupKey, error });
      }
    })();
  };

  // ─── Lazy-relation activation + the declared-safe query facade (ADR-0021) ──────────────────────
  const ensureSynced: SyncClient<TRegistry>["ensureSynced"] = async (keys) => {
    if (keys.length === 0) return;
    // Sync PENDING (ADR-0041 Option B window): `sync` is not yet wired but the boot IS syncing. Record the
    // keys in the shared buffer AND await `syncWired` — the tail replays the buffer and STARTS the groups
    // before resolving `syncWired`, so on return the relations are genuinely active (the tripwire passes).
    // Distinct from sync DISABLED, which falls through to the trivially-active local-only path below.
    if (sync == null && isSyncPending()) {
      if (pendingActivations != null) for (const key of keys) pendingActivations.add(key);
      await syncWired;
    }
    const activeSync = sync;
    // Sync disabled → local-only (or the client was disposed before wiring): every relation is trivially
    // "synced" — reads hit whatever is local, so there is nothing to start.
    if (activeSync == null) return;
    const groupKeys = new Set<string>();
    for (const key of keys) {
      const groupKey = activeSync.groupKeyForTable(key);
      if (groupKey == null) continue;
      // Diagnostic at the activation choke point (ADR-0039): only for a group not yet started — an
      // already-active group has already paid (or dodged) this check. Write-triggered activation flows
      // through here too, so the warning fires for writes as well as reads.
      if (!activeSync.isTableStarted(key)) {
        warnIfAnonymousClaimsDependentActivation(activeSync, groupKey);
      }
      groupKeys.add(groupKey);
    }
    await Promise.all([...groupKeys].map((groupKey) => activeSync.ensureGroupStarted(groupKey)));
  };

  // ADR-0039: now `ensureSynced` + `lazyGuardIndex` exist, wire the ordinary-write activation. Filter the
  // reported tables to the lazy ones, then fire-and-forget `ensureSynced` — enqueue never blocks on the
  // network, and a failed start self-heals on the group's next activation (a `.catch` keeps the rejection
  // off the unhandled-rejection path).
  activateOrdinaryWriteTables = (tables) => {
    // ADR-0041: a write can land after `writeReady` but before `sync` is wired. Buffer the reported tables
    // (the tail replays them once sync is up) so the activation is never lost — this seam is fire-and-forget
    // (`onOrdinaryEnqueue` has a sync signature), so it cannot await `syncWired` the way `ensureSynced` does.
    if (sync == null) {
      if (pendingActivations != null) for (const table of tables) pendingActivations.add(table);
      return;
    }
    const lazyTables = tables.filter((table) => lazyGuardIndex.lazyKeys.has(table)) as SyncTableName<TRegistry>[];
    if (lazyTables.length === 0) return;
    void ensureSynced(lazyTables).catch((error) => {
      syncDebug("write-triggered lazy activation failed", { tables: lazyTables, error });
    });
  };

  // Per-table catch-up completion (ADR-0032 decision 6) — the body of `client.groupReady`, hoisted so the
  // live-rows seam can also await it when building a subscription's `hydrated` promise.
  const groupReadyForTable = async (table: SyncTableName<TRegistry>): Promise<void> => {
    // Sync PENDING (ADR-0041): wait for sync to wire before its catch-up can even be evaluated, so a group
    // referenced in the pre-wire window retains its catch-up meaning rather than resolving instantly.
    if (sync == null && isSyncPending()) {
      await syncWired;
    }
    const activeSync = sync;
    // Sync disabled → local-only (or disposed before wiring): every relation is trivially "ready".
    if (activeSync == null) return;
    const groupKey = activeSync.groupKeyForTable(table as string);
    if (groupKey == null) return;
    await activeSync.groupReady(groupKey);
  };

  // Synchronous peek at a table's consistency-group catch-up (ADR-0032 decision 6) — the counterpart of
  // `groupReadyForTable`, hoisted so the live-rows seam can compute the STEADY-STATE fast path: when every
  // referenced group is already ready at subscribe time, no `hydrated` promise is built (no extra refresh).
  const isGroupReadyForTable = (table: string): boolean => {
    const activeSync = sync;
    if (activeSync == null) {
      // Sync PENDING (ADR-0041): not yet wired → the group is NOT ready (its catch-up has not run). Sync
      // DISABLED → local-only, trivially ready.
      return !isSyncPending();
    }
    const groupKey = activeSync.groupKeyForTable(table);
    // No consistency group (unknown/writeonly) → nothing to await; treat as ready.
    if (groupKey == null) return true;
    return activeSync.isGroupReady(groupKey);
  };

  // The referenced synced tables whose consistency group is NOT YET caught up (ADR-0021/0032): scan the
  // compiled SQL for every synced relation the query reads (∪ the explicit `use`), then keep only those
  // whose group is still catching up. Empty when sync is DISABLED or every referenced group is already ready
  // — the steady-state fast path, where the live-rows seam builds no `hydrated` promise. When sync is PENDING
  // (ADR-0041 window) every referenced synced group is not-yet-ready, so all are returned as hydrating.
  const hydratingTablesFor = (query: { sql: string; use?: readonly string[] }): string[] => {
    // Sync disabled → nothing hydrates. Sync pending → every referenced synced group is hydrating (below).
    if (sync == null && !isSyncPending()) return [];
    const referenced = new Set<string>(query.use ?? []);
    for (const key of findReferencedSyncedKeysInSql(query.sql, lazyGuardIndex)) referenced.add(key);
    return [...referenced].filter((table) => !isGroupReadyForTable(table));
  };

  const isSynced: SyncClient<TRegistry>["isSynced"] = (key) => {
    const activeSync = sync;
    if (activeSync == null) {
      // Sync PENDING (ADR-0041): not yet wired → the relation is not started (dormant). Sync DISABLED →
      // local-only, so nothing is "dormant".
      return !isSyncPending();
    }
    return activeSync.isTableStarted(key);
  };

  // ADR-0021 §2/§4: the tables of `entry`'s consistency GROUP — a group is one subscription / one
  // transaction frontier, so reverting one member to dormant reverts them all (a table with no
  // `consistencyGroup` is its own singleton group).
  const groupTableKeysFor = (key: SyncTableName<TRegistry>, entry: SyncTableEntry): SyncTableName<TRegistry>[] => {
    const targetGroup = entry.consistencyGroup;
    return (
      targetGroup == null
        ? [key]
        : (Object.keys(options.registry) as SyncTableName<TRegistry>[]).filter(
            (candidate) => options.registry[candidate]!.consistencyGroup === targetGroup,
          )
    ) as SyncTableName<TRegistry>[];
  };

  // The shared group-teardown body of {@link desync} and {@link discardEphemeral} (ADR-0021 §2/§4). Both
  // revert a lazy relation's whole consistency group to dormant: refuse if any writable member owes
  // unsettled writes, stop the group stream, clear the persisted lazy activation, delete the persisted
  // Electric subscription (so re-activation re-streams from scratch), then clean-truncate every member's
  // local cluster. `label` names the calling primitive in the owed-writes refusal so each keeps its own
  // diagnostic (desync stays byte-identical). Callers apply their own lazy/retention gates BEFORE this.
  const tearDownLazyGroup = async (key: SyncTableName<TRegistry>, entry: SyncTableEntry, label: string) => {
    const groupTableKeys = groupTableKeysFor(key, entry);

    // Refuse if ANY writable member owes the server unsent/unsettled writes: the truncate clears the
    // journal, so dropping un-acked local intent would be silent data loss. Flush (or discard) those first.
    let owed = 0;
    for (const member of groupTableKeys) {
      if (options.registry[member]!.mode === "readonly") continue;
      const stats = await mutationRuntime.readMutationStats(member);
      owed +=
        stats.pendingCount + stats.sendingCount + stats.failedCount + stats.quarantinedCount + stats.conflictedCount;
    }
    if (owed > 0) {
      throw new Error(
        `${label}('${String(key)}') refused: ${owed} unsettled mutation(s) in the group's local journal. Flush or discard them first.`,
      );
    }

    const activeSync = sync;
    // The group key IS the Electric subscription key (`consistencyGroup ?? shapeKey`); fall back to the
    // registry derivation when sync is disabled.
    const groupKey = activeSync?.groupKeyForTable(key) ?? entry.consistencyGroup ?? entry.shape?.shapeKey;
    // Stop the stream BEFORE truncating so a live shape can't re-populate the rows we just cleared, and
    // revert the durable promotion (a no-op for ephemeral, which never persisted a flag) so the next boot
    // holds the relation dormant again.
    if (activeSync != null && groupKey != null) activeSync.stopGroup(groupKey);
    if (groupKey != null) await clearLazyGroupActivation(pglite, options.registry, groupKey);
    // CRITICAL: delete the group's persisted Electric subscription so a later re-activation re-streams the
    // shape from scratch. Without this it would resume from the old cursor and never re-send the rows we
    // truncate below — leaving the relation permanently missing its pre-desync data.
    if (groupKey != null) await resetSubscriptionsIfRequested(pglite, [groupKey]);
    // Clean-truncate every member's local cluster.
    for (const member of groupTableKeys) {
      await pglite.exec(buildDesyncTableSql(options.registry, member as string));
    }
  };

  const desync: SyncClient<TRegistry>["desync"] = async (key) => {
    // ADR-0041 (SHOULD-FIX 5): a destructive group-teardown reads the journal and stops a group's stream, so
    // it must not race the background tail's recovery updates / subscription reset / sync start. Gate on
    // `bootSettled` — these are rare admin ops, so the stronger gate is correct (a tail failure rejects here).
    await bootSettled;
    const entry = options.registry[key];
    if (entry == null) throw new Error(`desync: unknown table ${String(key)}`);
    if (entry.subscription !== "lazy") {
      throw new Error(
        `desync('${String(key)}') refused: only a lazy relation can be desynced — an eager relation is always-on and would immediately re-sync.`,
      );
    }
    await tearDownLazyGroup(key, entry, "desync");
  };

  const discardEphemeral: SyncClient<TRegistry>["discardEphemeral"] = async (key) => {
    // ADR-0041 (SHOULD-FIX 5): gate the destructive teardown on `bootSettled` so it never races the tail.
    await bootSettled;
    return (
      // Run inside the SAME lifecycle slot the exports use (ADR-0035 decision 4): discardEphemeral
      // clean-truncates an ephemeral group's local cache, so an export must never interleave it (nor it an
      // export) — the slot's typed LifecycleBusyError fires in both directions. The existing lazy/ephemeral
      // gates below stay EXACTLY as they were, now inside the slot run. (`desync` is deliberately NOT slotted:
      // only the ADR-0035-named destructive ops — destroy/discardEphemeral/dropReadCache — serialise here.)
      lifecycleSlot.run("discardEphemeral", async () => {
        const entry = options.registry[key];
        if (entry == null) throw new Error(`discardEphemeral: unknown table ${String(key)}`);
        // Keep the lazy gate desync has: eager+ephemeral is NOT forbidden by the type system (retention and
        // subscription are independent scalars on the entry — see contracts config.ts / registry.ts), and an
        // eager relation would immediately re-stream, so the same refusal applies here.
        if (entry.subscription !== "lazy") {
          throw new Error(
            `discardEphemeral('${String(key)}') refused: only a lazy relation can be discarded — an eager relation is always-on and would immediately re-sync.`,
          );
        }
        // STRICTER gate than desync: every member of the consistency group must be ephemeral. Retention is read
        // as `entry.retention ?? "persistent"` (absent → persistent, matching validateRegistryLifecycleGroups and
        // the schema generator); a read PROJECTION surfaces its declared retention on the same `retention` field
        // (withRetention/asEphemeral/defineReadProjection all set it), so this one read covers tables and
        // projections alike. Refuse (naming the offender) if any member is persistent — discardEphemeral is the
        // multi-tab-safe primitive for per-delivery-session windows, and truncating a persistent member's cache
        // would drop durable local data; use desync for a persistent lazy relation.
        for (const member of groupTableKeysFor(key, entry)) {
          if ((options.registry[member]!.retention ?? "persistent") !== "ephemeral") {
            throw new Error(
              `discardEphemeral('${String(key)}') refused: group member '${String(member)}' is persistent — ` +
                `discardEphemeral only drops an ephemeral relation's local rows. Use desync for a persistent lazy relation.`,
            );
          }
        }
        await tearDownLazyGroup(key, entry, "discardEphemeral");
      })
    );
  };

  const transaction: SyncClient<TRegistry>["transaction"] = async ({ mode }, run) => {
    // Write-path gate (ADR-0041): the atomic unit enqueues + (pessimistic) flushes, so await `writeReady`.
    await writeReady;
    // The block's table handles only COLLECT mutations; the whole set is enqueued atomically as one unit.
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

    if (collected.length === 0) {
      return { acks: [] };
    }

    const unit: WriteUnit = { id: globalThis.crypto.randomUUID(), mode };
    await mutationRuntime.batch(collected, unit);

    if (mode === "optimistic") {
      // An atomic batch enqueue; the background convergence loop flushes it (no foreground answer).
      void mutationRuntime.flush();
      return { acks: [] };
    }

    // Pessimistic: flush-route this unit to the authoritative endpoint and await the per-mutation result.
    return await mutationRuntime.flushUnit(unit.id);
  };

  const prepareQuery: SyncClient<TRegistry>["prepareQuery"] = async ({ sql, use }) => {
    // Scan the compiled SQL for the lazy relations it reads (∪ the explicit `use`) and activate them.
    // The compiled SQL is ground truth and Drizzle quotes every relation, so any reference — FROM, JOIN,
    // subquery, WHERE — is caught; over-matching is bounded and harmless (one spurious persistent
    // subscription at worst, never a wrong result). Detection and activation are one step (ADR-0021).
    const toActivate = new Set<string>(use ?? []);
    for (const key of findReferencedLazyKeysInSql(sql, lazyGuardIndex)) toActivate.add(key);
    const lazyTables = [...toActivate] as SyncTableName<TRegistry>[];
    await ensureSynced(lazyTables);
    // Backstop: if a referenced lazy relation is somehow still not active (a failed start, or no group),
    // throw rather than let the query read empty/stale. In the normal path everything scanned was just
    // activated, so this passes.
    assertLazyRefsActivated({
      sql,
      index: lazyGuardIndex,
      isActive: (key) => isSynced(key as SyncTableName<TRegistry>),
    });
    // Activated = streams started, NOT caught up. Hand back the keys so consumers (the React hooks'
    // `hydrating`) can await `groupReady` per key without blocking the read on the network.
    return { lazyTables };
  };

  // The single gate+guard core shared by BOTH one-shot read entry points (the in-process drizzle-builder path
  // below and the worker-reachable `guardedRawQuery`), so the read gate and lazy-group guard can never drift
  // between modes. Given the query's compiled SQL (∪ `use`): read gate first, then the lazy-group guard.
  const gateAndGuardRead = async (sql: string, use?: readonly SyncTableName<TRegistry>[]): Promise<void> => {
    // Read gate (ADR-0041): a query must not run against a store whose local-read core has not finished. On
    // the in-process client this is a settled-promise await (the client is handed out at `localReadReady`),
    // but it is cheap and keeps the read path safe if a caller retained a query builder across the boundary.
    await localReadReady;
    // Lazy-group guard (ADR-0021): scan the compiled SQL (∪ `use`) for lazy relations it reads and activate +
    // await them before the query runs, so a lazy relation is never read empty/stale.
    await prepareQuery({ sql, ...(use ? { use } : {}) });
  };

  const runGuardedQuery = async <TRows extends readonly unknown[]>(
    build: GuardedQueryFn<TRegistry, TRows>,
    use?: readonly SyncTableName<TRegistry>[],
  ): Promise<TRows> => {
    // Building the drizzle query is pure construction (no DB I/O — it only compiles to SQL), so compile first,
    // then run the shared gate+guard on that SQL, then hand back the still-unexecuted builder (its `await`
    // executes via the local drizzle exactly as before — return shape unchanged).
    const builder = build(client);
    await gateAndGuardRead(builder.toSQL().sql, use);
    return builder;
  };

  // The worker host's guarded one-shot read (ADR-0032 decision 4) — `rawQuery` PLUS the shared gate+guard.
  // `defineSyncWorker`'s `guardedQuery` handler calls this on its owned in-process client (re-applying
  // drizzle's identity parsers — temporal OIDs + numeric[] — in `options` first, since that parser map cannot cross the bridge);
  // the attach client's Drizzle-over-bridge routes reads here. Returns the full PGlite `Results` so drizzle's
  // own result mapping runs on the tab.
  const guardedRawQuery: SyncClient<TRegistry>["guardedRawQuery"] = async (sql, params, options, use) => {
    await gateAndGuardRead(sql, use);
    return pglite.query(sql, params as unknown[] | undefined, options);
  };

  // The live-query manager (ADR-0040) — the SAME module the worker uses (decision 6), so the in-process
  // client gets one lifecycle contract: dedup of identical concurrent subscriptions within this client,
  // bounded zero-subscriber keep-alive (`options.liveQueries`), and awaited teardown (decision 1 — `dispose()`
  // settles every un-awaited unsubscribe before `pglite.close()`, subsuming the old pending-teardowns set).
  // It cannot dedup across tabs (that is the worker's job) but keeps the contract identical across both forms.
  const liveManager: LiveQueryManager = createLiveQueryManager({
    live: pglite.live,
    ...(options.liveQueries ? { policy: options.liveQueries } : {}),
  });

  const client: SyncClient<TRegistry> = {
    drizzle: drizzleDb,
    pglite,
    views: buildViews(options.registry),
    tables: Object.fromEntries(
      Object.keys(options.registry).map((tableKey) => [
        tableKey,
        {
          key: tableKey,
          mode: options.registry[tableKey as SyncTableName<TRegistry>]!.mode,
          create: (input: SyncTableCreateInput<TRegistry, typeof tableKey>) =>
            mutate.create(tableKey as SyncTableName<TRegistry>, input),
          update: (entityKey: Record<string, string>, patch: SyncTableUpdateInput<TRegistry, typeof tableKey>) =>
            mutate.update(tableKey as SyncTableName<TRegistry>, entityKey, patch),
          delete: (entityKey: Record<string, string>) => mutate.delete(tableKey as SyncTableName<TRegistry>, entityKey),
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
    haltActivity,
    stop: async () => {
      // Halt all activity FIRST (see haltActivity) — before any await.
      haltActivity();
      // ADR-0041: quiesce the background boot tail FIRST — flag disposal (so it never starts sync after this)
      // and await its settlement — so no shape stream is left running and nothing execs against the closing
      // PGlite. Any sync the tail started before disposal is now in `sync` for the unsubscribe below.
      await quiesceTailForTeardown();
      // Await any in-flight convergence pass before closing PGlite, so a pass never queries a
      // closed handle.
      await convergenceDriver?.stop();
      sync?.unsubscribe();
      status.isRunning = false;
      options.onStatusChange?.(status);
      // Tear the engine down (abort every shape stream) immediately before closing the DB — the exact
      // point PGlite's own close used to invoke the former extension's close hook (ADR-0032 S1). Order
      // preserved: convergence stop → sync unsubscribe → status → engine close → pglite close.
      await engine.close();
      // Dispose the live-query manager before closing PGlite (ADR-0040 decisions 1 & 6): it cancels any
      // keep-alive timers and awaits every in-flight live `unsubscribe()`, so none races `pglite.close()`.
      await liveManager.dispose();
      await pglite.close();
    },
    destroy: (destroyOptions) =>
      // Run inside the SAME lifecycle slot the exports use (ADR-0035 decision 4), so a destructive wipe can
      // never interleave a running export (nor an export interleave this wipe) — the slot's typed
      // LifecycleBusyError fires in both directions. The refuse-if-owed guard stays EXACTLY as it was, now
      // inside the slot run.
      lifecycleSlot.run("destroy", async () => {
        // Halt all activity FIRST (see haltActivity) — before any await.
        haltActivity();
        // ADR-0041: quiesce the background boot tail BEFORE the owed-mutations read and the wipe, so neither
        // races the tail's recovery journal updates / sync start (BLOCKER 2). After this the tail has settled.
        await quiesceTailForTeardown();
        if (!destroyOptions?.force) {
          const stats = await mutationRuntime.readMutationStats();
          const owed =
            stats.pendingCount +
            stats.sendingCount +
            stats.failedCount +
            stats.quarantinedCount +
            stats.conflictedCount;

          if (owed > 0) {
            throw new Error(
              `destroy() refused: ${owed} mutation(s) still owed to the server. Flush them first or call destroy({ force: true }).`,
            );
          }
        }

        // Drain any in-flight convergence pass before wiping, so a pass never writes into a store
        // being torn down underneath it.
        await convergenceDriver?.stop();
        sync?.unsubscribe();
        status.isRunning = false;
        options.onStatusChange?.(status);
        await pglite.exec(buildWipeLocalStoreSql(options.registry));
        // Same teardown ordering as `stop`: abort the engine's streams before closing the DB, the moment
        // the former extension close hook fired during `pglite.close()` (ADR-0032 S1).
        await engine.close();
        // Dispose the live-query manager before closing PGlite — same close-vs-unsubscribe hang guard as
        // `stop()` (ADR-0040 decisions 1 & 6).
        await liveManager.dispose();
        await pglite.close();
        // ADR-0049 step 10b: phase-aware destructive lifecycle. The wipe + close above cleared the local store;
        // now finish the store-meta / OPFS-namespace side. Every recorded browser store runs the full destructive
        // lifecycle (set `deleting` → delete commitment
        // sentinel → delete both possible backend stores → delete meta). Wiping application tables and closing
        // PGlite do NOT delete its IndexedDB database; retaining that shell would make the next granted boot
        // classify it as an existing recordless idb store instead of a genuinely fresh path. A recordless lifecycle-owned
        // IDB store therefore enters the same machine; memory, filesystem, non-browser, and caller-owned stores
        // have no toolkit browser authority to finish.
        const { readStoreMetaRecord } = await import("./store-meta");
        const metaResult = await readStoreMetaRecord(fallbackStorePath);
        // A recordless fixed IDB store is still lifecycle-owned: wiping tables does not delete its
        // database shell, so it must enter the same supervised deletion machine. Memory/filesystem and
        // caller-owned instances stay outside this browser authority mechanism.
        if (
          (typeof metaResult === "object" && metaResult !== null) ||
          (ownsStoreLifecycle && openedStorageBackend === "idbfs")
        ) {
          const { runStoreDestruction, createStoreDestructionEffects } = await import("./worker/attach-sync-client");
          await runStoreDestruction(createStoreDestructionEffects(fallbackStorePath));
        }
      }),
    dropReadCache: async () => {
      // ADR-0041 (SHOULD-FIX 5): the drop+rebuild resets subscriptions and rewrites the read cache, so it must
      // not race the background tail's sync start / subscription reset. Gate on `bootSettled` first.
      await bootSettled;
      return (
        // Under the SAME lifecycle slot as the exports (ADR-0035 decision 4). WHY dropReadCache is slotted and
        // not just destroy/discardEphemeral: it DROPS and rebuilds the synced read-cache tables, so an export
        // racing it would capture a half-rebuilt cache in the artefact (some tables dropped, some re-created,
        // none re-streamed yet). The slot makes the drop+rebuild atomic against any concurrent export.
        lifecycleSlot.run("dropReadCache", async () => {
          await pglite.exec(buildDropReadCacheSql(options.registry));
          await pglite.exec(generateLocalSchemaSql(options.registry));
          // A full durable-schema exec re-stamps the durable-schema fingerprint (slice 3): exec and stamp
          // travel together so the next boot's fast path can trust the rebuilt cache's fingerprint.
          await writeStoredLocalSchemaFingerprint(
            pglite,
            options.registry,
            computeLocalSchemaFingerprint(options.registry),
          );
          // Reset the Electric subscriptions so the rebuilt synced tables re-stream from scratch
          // rather than the bookkeeping believing they are already caught up (ADR-0006).
          await resetSubscriptionsIfRequested(pglite, allGroupSubscriptionKeys(options.registry));
        })
      );
    },
    // Write-path methods gate on `writeReady` (ADR-0041): each enqueues, drains, or mutates a journal, so
    // none may run before the write runtime + boot recovery have completed. `writeReady` is already resolved
    // on the steady-state client, so these are settled-promise awaits.
    flush: async (table) => {
      await writeReady;
      return mutationRuntime.flush(table);
    },
    reconcile: async (table) => {
      await writeReady;
      return mutationRuntime.reconcile(table);
    },
    retryFailed: async (table) => {
      await writeReady;
      return mutationRuntime.retryFailed(table);
    },
    recoverSending: async (table) => {
      await writeReady;
      return mutationRuntime.recoverSending(table);
    },
    // NIT 7 (ADR-0041): these are READ diagnostics, deliberately UNGATED so they work at `localReadReady`. In
    // the narrow pre-`writeReady` window they may observe pre-recovery `sending` rows (boot recovery lifts
    // `sending → pending`), i.e. the honest current journal state before recovery has run — not a bug.
    readMutationDetails: (table) => mutationRuntime.readMutationDetails(table),
    mutate,
    discardConflict: async (table, entityKey) => {
      await writeReady;
      return mutationRuntime.discardConflict(table, entityKey);
    },
    discardQuarantined: async (table, entityKey) => {
      await writeReady;
      return mutationRuntime.discardQuarantined(table, entityKey);
    },
    // See the `readMutationDetails` note: a read, ungated, so pre-`writeReady` it may show pre-recovery counts.
    diagnostics: async (table) => ({
      mutation: await mutationRuntime.readMutationStats(table),
    }),
    // The registry-wide mutation-status API (slice 4). Assigned just below the object so it can close over
    // this client's own `subscribeLiveRows` + `pglite.query` seams — the SAME factory the worker facade uses.
    mutations: undefined as unknown as MutationsApi<TRegistry>,
    // Inspection surface (see the interface doc): straight through to the underlying store, no journal /
    // overlay involvement. The worker facade runs the identical call inside the worker's own client.
    rawQuery: (sql, params, options) => pglite.query(sql, params as unknown[] | undefined, options),
    rawExec: (sql, options) => pglite.exec(sql, options),
    // @internal: the guarded raw-SQL read the worker host dispatches `guardedQuery` to (ADR-0032 decision 4).
    guardedRawQuery,
    query: (build) => runGuardedQuery(build),
    queryRow: async (build) => {
      const rows = await runGuardedQuery(build);
      return rows[0] ?? null;
    },
    queryRaw: (spec) => runGuardedQuery(spec.build, spec.use),
    queryRawRow: async (spec) => {
      const rows = await runGuardedQuery(spec.build, spec.use);
      return rows[0] ?? null;
    },
    ensureSynced,
    isSynced,
    desync,
    discardEphemeral,
    prepareQuery,
    transaction,
    groupReady: groupReadyForTable,
    hydratingTablesFor,
    // The live-rows seam, now delegated to the shared `LiveQueryManager` (ADR-0040 decision 6) — identical
    // contract to the pre-adoption inline `pglite.live.query` seam, but with dedup of identical concurrent
    // subscriptions, keep-alive (`keepAliveMs`), and awaited teardown for free. The manager delivers a diff
    // stream (`deliverInitial` + `deliverDiff`); we fold it back into FULL ordered row arrays with a
    // per-subscription `LiveRowsMaterializer` (the SAME piece `attachSyncClient` uses tab-side), so the
    // public `onRows(rows)` / `initialRows` contract is byte-unchanged — and unchanged rows now keep `===`
    // identity across diffs (a bonus the raw `results.rows` path did not give). Keyless (no `pkColumns`)
    // exactly as the inline seam was: PGlite's `live.query` + the manager's value-identity diff.
    subscribeLiveRows: async ({ sql, params, fields, use, keepAliveMs }, onRows) => {
      // Read gate (ADR-0041): do not register a live query before the local-read core has finished (a
      // settled-promise await on the steady-state client — cheap, and stage-2-safe).
      await localReadReady;
      // Render the query safe to materialise: a JOIN with same-named columns fails `live.query`'s
      // temp-view creation (`column "title" specified more than once`) unless every output column has a
      // unique alias. No `fields` → SQL unchanged (the default name-keyed row shape). The wrap stays
      // caller-side (ADR-0040 decision 3): the manager receives POST-WRAP SQL.
      const materialSql = wrapLiveQueryForMaterialization(sql, fields);
      // Keyless materializer (matches the inline seam, which never passed pkColumns): initial rows seed it;
      // each diff folds into a fresh ordered array whose unchanged rows keep their object identity.
      const materializer = new LiveRowsMaterializer<Record<string, unknown>>(undefined);
      const subscription = await liveManager.subscribe(
        { materialSql, params: params as unknown[] },
        {
          // The initial snapshot is returned via `initialRows`, NOT `onRows` (which fires on CHANGES only) —
          // so `deliverInitial` just seeds the materializer; `initialRows` is read from it below.
          deliverInitial: (rows) => {
            materializer.seed(rows);
          },
          deliverDiff: (diff) => {
            onRows(materializer.apply(diff) as never);
          },
        },
        keepAliveMs != null ? { keepAliveMs } : undefined,
      );
      // Seeded synchronously by `deliverInitial` during `subscribe` above.
      const initialRows = materializer.current();
      let unsubscribed = false;
      // The query's lazy relations (guard scan ∪ `use`; the caller's `prepareQuery` already activated them)
      // are surfaced as `lazyTables` for observability — the relations held out of the eager boot set.
      const lazySet = new Set<string>(use ?? []);
      for (const key of findReferencedLazyKeysInSql(sql, lazyGuardIndex)) lazySet.add(key);
      const lazyTables = [...lazySet];
      // Hydration spans EVERY referenced consistency group (eager AND lazy): the tables whose group is not
      // yet caught up at subscribe time. Empty (steady state / sync disabled) → NO `hydrated` promise, so a
      // post-boot subscription pays no extra refresh (exactly today's eager-only behaviour). Otherwise build
      // `hydrated` with rows-before-signal ordering: await the pending groups' catch-up, refresh the live
      // query (the manager's coalesced refresh; its listener delivers the caught-up rows as a diff → onRows,
      // synchronously inside the refresh), THEN resolve — so a UI flipping out of its loading state on this
      // promise can never flash a false empty.
      const hydratingTables = hydratingTablesFor({ sql, ...(use ? { use } : {}) });
      const hydrated =
        hydratingTables.length > 0
          ? Promise.all(hydratingTables.map((table) => groupReadyForTable(table as SyncTableName<TRegistry>)))
              .then(async () => {
                if (!unsubscribed) await subscription.refresh();
              })
              .catch(() => undefined)
          : undefined;
      return {
        initialRows: initialRows as never,
        unsubscribe: () => {
          unsubscribed = true;
          // Non-blocking for the caller; the manager retains the teardown promise so `dispose()` (called by
          // `stop()`/`destroy()`) awaits it before closing PGlite (ADR-0040 decision 1 — the close race).
          void subscription.unsubscribe();
        },
        ...(lazyTables.length > 0 ? { lazyTables } : {}),
        ...(hydrated ? { hydrated } : {}),
      };
    },
    // Boot observability (ADR-0034): the finalized report (null before initial sync completes / after an
    // early stop). Resolves from the builder-owned ref this client holds — no round trip in-process.
    bootReport: async () => finalizedBootReport,
    // Live-query diagnostics (ADR-0040 decisions 5 & 6): the in-process client now owns a real manager, so
    // this returns its live snapshot (digests + counts/timings only — never SQL/params/rows).
    liveQueryDiagnostics: async () => liveManager.snapshot(),
    exportStore: async (exportOptions) => {
      // Await engine-ready first (ADR-0035: exports wait out a boot rather than rejecting during it), THEN
      // take the lifecycle slot — a concurrent export/lifecycle op is refused with a typed busy error.
      await ready;
      // Name the backup from the configured plain store PATH (ADR-0036), never the PGlite instance's
      // resolved dataDir URL — a resolved URL is internal plumbing and must not leak into an artefact name
      // as something to imitate. The store id is the path's last segment (see `deriveStoreId`).
      return lifecycleSlot.run("exportStore", () =>
        performStoreExport(
          {
            pglite,
            readMutationStats: () => mutationRuntime.readMutationStats(),
            ...(options.storePath != null ? { storePath: options.storePath } : {}),
          },
          exportOptions,
        ),
      );
    },
    exportDiagnostics: async (exportOptions) => {
      // Same lifecycle discipline as `exportStore` (ADR-0035): await engine-ready first (wait out a boot
      // rather than reject during it), THEN take the single slot so a concurrent export/lifecycle op is
      // refused with a typed busy error. The diagnostic dump runs the live datadir dump on `pglite`, then
      // clones it in memory — the live engine every reference here holds is never closed (the addendum's
      // whole reason for the throwaway clone over the abandoned suspend/reopen seam).
      await ready;
      return lifecycleSlot.run("exportDiagnostics", () =>
        performDiagnosticExport(
          {
            pglite,
            readMutationStats: () => mutationRuntime.readMutationStats(),
            ...(options.storePath != null ? { storePath: options.storePath } : {}),
          },
          exportOptions,
        ),
      );
    },
    exportData: async (exportOptions) => {
      // Same lifecycle discipline (ADR-0035): await engine-ready first (wait out a boot rather than reject),
      // THEN take the single slot. The DRAIN runs inside the slot (the caller-side placement decision 3
      // makes): flush needs the running engine and is not lifecycle-exclusive, but the artefact must be
      // taken right after the drain, so export owns the store's lifecycle for the whole drain+dump. The
      // `-t` allowlist + enum header are resolved from the registry through the SAME projection the DDL
      // generator uses — never re-derived by string convention.
      await ready;
      return lifecycleSlot.run("exportData", () =>
        performDataExport(
          {
            pglite,
            readMutationStats: () => mutationRuntime.readMutationStats(),
            flush: () => mutationRuntime.flush(),
            syncedTableNames: collectDataExportSyncedTableNames(options.registry),
            enumHeaderSql: buildDataExportEnumHeaderSql(options.registry),
            cloneCleanupSql: buildDataExportCloneCleanupSql(options.registry),
            ...(options.storePath != null ? { storePath: options.storePath } : {}),
          },
          exportOptions,
        ),
      );
    },
  };

  // Wire the mutation-status API over this client's shared seams (slice 4): its live-rows seam (over
  // `pglite.live` via the manager) and its one-shot `pglite.query`. The worker facade wires the SAME factory
  // over the bridge, so `client.mutations` behaves identically in both modes.
  client.mutations = createMutationsApi({
    registry: options.registry,
    subscribeLiveRows: client.subscribeLiveRows,
    query: (sql, params) => pglite.query<Record<string, unknown>>(sql, params),
  });

  // ─── ADR-0049 step 11c: FRESH/RESTORE commitment barrier — the LOCAL-INIT MILESTONE, PRE-EXPOSE ──────────
  // This is the earliest airtight local-initialization milestone (the FRESH/RESTORE provenance gate, D7 — NO
  // server): the durable schema and registry reconciliation (and, on a restore boot, recovery + quarantine)
  // have completed, and the drizzle read facade + client are built — the store is proven initialized. If
  // the pre-mint phase machine stood up an uncommitted opfs candidate, run the shared commitment barrier
  // (strictSync → sentinel → opfs-committed) NOW, BEFORE `resolveLocalReadReady()` resolves and the client is
  // handed out. A throw propagates straight out of this async function (exactly as a local-read-core failure
  // does — see `localReadReady`'s no-reject-binding rationale above): the returned promise rejects, the client
  // is NEVER exposed, nothing is published, the `opfs-candidate` record survives, and the next boot's classifier
  // tears the candidate down and rebuilds (invariant 3 — an uncommitted candidate is never exposed to writes).
  if (commitmentBarrierPending) {
    await runFreshCommitmentBarrier(fallbackStorePath, resolveEngineStrictSync(pglite));
  }

  // ─── Local-read core complete → resolve `localReadReady`, then run the write/sync tail in the background ──
  // (ADR-0041 Option B.) The durable schema and registry reconciliation are complete, and the drizzle
  // read facade + client are built — cached reads are safe now, with ZERO network. Stamp + resolve
  // `localReadReady`; on a restore boot `writeReady` coincides (recovery + quarantine already ran in the core,
  // before this read exposure — the ADR-0041 invariant). This function then RESOLVES at `localReadReady`.
  bootReportBuilder.setLocalReadReadyMs(performance.now() - bootReportBuilder.bootStartPerf);
  resolveLocalReadReady();
  if (restoreBoot) {
    bootReportBuilder.setWriteReadyMs(performance.now() - bootReportBuilder.bootStartPerf);
    resolveWriteReady();
  }

  // Guard the downstream stages so a tail failure on an UNCONSUMED stage (e.g. `bootSettled` in-process, where
  // only the worker awaits it) never surfaces as an unhandled rejection — a real awaiter still observes it.
  void writeReady.catch(() => undefined);
  void bootSettled.catch(() => undefined);
  void ready.catch(() => undefined);

  // Kick the write/sync tail (background). Its completion is today's full resolution point → `bootSettled`. A
  // tail failure lands AFTER `localReadReady` resolved, so it can no longer reject this function's returned
  // promise (as a pre-ADR-0041 boot failure would); surface it on every still-pending downstream stage instead
  // so their awaiters (a gated write, `ready`, the worker's `bootSettled`) fail loudly rather than hang.
  void runWriteAndSyncTail().then(
    () => {
      resolveBootSettled();
      // Belt-and-braces: if a `disposed` bail returned before the replay, drop the buffer so it cannot leak or
      // keep collecting (steady-state activations go straight through `ensureSynced` once `sync` is wired).
      pendingActivations = null;
      resolveSyncWired();
    },
    (error: unknown) => {
      syncDebug("boot write/sync tail failed after localReadReady", { error });
      // SHOULD-FIX 4: the tail failed at/before sync start, so buffered activations can never be replayed —
      // null the buffer (bounded, no unbounded growth) and name the loss on the debug rail.
      if (pendingActivations != null && pendingActivations.size > 0) {
        syncDebug("boot tail failure dropped buffered activations", { tables: [...pendingActivations] });
      }
      pendingActivations = null;
      // NIT 8: surface a signal beyond the stage rejections — move the runtime to `degraded` so a consumer
      // watching `status`/`onStatusChange` sees the boot failed, not just an awaiter of a stage promise.
      status.phase = "degraded";
      status.lastError = describeErrorChain(error);
      options.onStatusChange?.(status);
      rejectWriteReady(error);
      rejectReady(error);
      rejectBootSettled(error);
      // Unblock any read seam parked on `syncWired` — it will see `sync == null` and fall back to local-only.
      rejectSyncWired(error);
    },
  );

  return client;
}

/**
 * Every persisted subscription key declared by the registry — one per consistency group (ADR-0009
 * decision 2), not per table. Grouped tables share a subscription-state row keyed by their group;
 * ungrouped tables are singleton groups keyed by their own `shapeKey`. Deduped, since several tables
 * collapse onto one group key.
 */
function allGroupSubscriptionKeys<TRegistry extends SyncTableRegistry>(registry: TRegistry): string[] {
  const keys = Object.values(registry)
    .filter((entry) => typeof entry.shape?.shapeKey === "string" && entry.shape.shapeKey.length > 0)
    .map((entry) => entry.consistencyGroup ?? entry.shape!.shapeKey);
  return [...new Set(keys)];
}

async function resetSubscriptionsIfRequested(pglite: ClientPGlite, keys: string[] | undefined) {
  if (!keys || keys.length === 0) {
    return;
  }

  const uniqueKeys = [...new Set(keys.map((key) => key.trim()).filter((key) => key.length > 0))];

  if (uniqueKeys.length === 0) {
    return;
  }

  await pglite.electric.initMetadataTables();
  await Promise.all(uniqueKeys.map((key) => pglite.electric.deleteSubscription(key)));
}

function createDrizzleDatabase<TRegistry extends SyncTableRegistry>(
  client: ClientPGlite,
  schema: RegistryTables<TRegistry>,
) {
  const relations = defineRelations(schema) as RegistryRelations<TRegistry>;

  const createDatabase = drizzle as unknown as (config: {
    client: ClientPGlite;
    relations: RegistryRelations<TRegistry>;
  }) => PgliteDatabase<RegistryRelations<TRegistry>>;

  return createDatabase({ client, relations });
}

function buildSchema<TRegistry extends SyncTableRegistry>(registry: TRegistry) {
  return Object.fromEntries(
    Object.entries(registry).map(([key, entry]) => [key, entry.table]),
  ) as RegistryTables<TRegistry>;
}

function buildViews<TRegistry extends SyncTableRegistry>(registry: TRegistry) {
  return Object.fromEntries(
    Object.entries(registry).flatMap(([key, entry]) => (entry.view != null ? [[key, entry.view]] : [])),
  ) as RegistryViews<TRegistry>;
}

/**
 * The tab-side READ handles a worker-attached client exposes (ADR-0032 S2/decision 4): a Drizzle instance
 * plus the registry views. `createSyncClient`'s SAME builders, so a query built on either client compiles
 * identically. The `client` argument is the executor Drizzle runs against:
 * - Omit it (the default `{}` stub) for a BUILD-ONLY instance — Drizzle only compiles to SQL (`.toSQL()`)
 *   and the stub is never invoked; used where execution happens elsewhere (e.g. the live-rows bridge).
 * - Pass a `ClientPGlite`-shaped BRIDGE executor (its `query` routes to the worker's `guardedQuery` RPC) so
 *   that awaiting a builder executes through the bridge and Drizzle's own result mapping (relational/nested
 *   queries included) runs on the tab — the one-shot read path `attachSyncClient` wires (ADR-0032 decision 4).
 */
export function buildRegistryReadHandles<TRegistry extends SyncTableRegistry>(
  registry: TRegistry,
  client: ClientPGlite = {} as ClientPGlite,
): {
  drizzle: PgliteDatabase<RegistryRelations<TRegistry>>;
  views: RegistryViews<TRegistry>;
  /**
   * A drizzle-database FACTORY over this registry's schema (ADR-0032 decision 4): `(client) => db`, reusing
   * the schema + relations computed ONCE here so a caller can cheaply build additional per-executor databases
   * without recomputing them. `attachSyncClient` uses it to give each `queryRaw`/`queryRawRow` its OWN
   * bridge executor carrying that call's `use` — a scoped db, never a shared mutable stash (no read races).
   */
  drizzleFor: (client: ClientPGlite) => PgliteDatabase<RegistryRelations<TRegistry>>;
} {
  const drizzleFor = buildRegistryDrizzleFactory(registry);
  return {
    drizzle: drizzleFor(client),
    views: buildViews(registry),
    drizzleFor,
  };
}

/**
 * Compute a registry's Drizzle schema + relations ONCE and return a `(client) => db` factory over them
 * (ADR-0032 decision 4). Splitting this out of {@link buildRegistryReadHandles} lets `attachSyncClient` build
 * one base bridge database plus a fresh per-read database (each over its own executor) without paying the
 * schema/relations construction on every read — only the `client` binding differs between them.
 */
function buildRegistryDrizzleFactory<TRegistry extends SyncTableRegistry>(
  registry: TRegistry,
): (client: ClientPGlite) => PgliteDatabase<RegistryRelations<TRegistry>> {
  const relations = defineRelations(buildSchema(registry)) as RegistryRelations<TRegistry>;
  const createDatabase = drizzle as unknown as (config: {
    client: ClientPGlite;
    relations: RegistryRelations<TRegistry>;
  }) => PgliteDatabase<RegistryRelations<TRegistry>>;
  return (client) => createDatabase({ client, relations });
}

function buildSyncConfigFromRegistry<TRegistry extends SyncTableRegistry>(
  registry: TRegistry,
  electricUrl: string,
): SyncConfigInput {
  return {
    electricUrl,
    localSchema: getSyncRegistrySchema(registry),
    tables: Object.fromEntries(Object.entries(registry).map(([key, entry]) => [key, buildSyncTableInput(entry, key)])),
  };
}

function buildSyncTableInput(entry: SyncTableEntry, tableKey: string) {
  const clientProjection = getClientProjection(entry, tableKey);

  return {
    name: tableKey,
    mode: entry.mode,
    primaryKey: entry.primaryKey,
    ...(entry.shape !== undefined ? { shape: entry.shape } : {}),
    clientProjection,
    // The read-path apply ladder (strategy + json casts) is resolved by the engine directly from the
    // registry entry via `resolveApplyTarget` (ADR-0029 D1/D2) — `deriveSyncColumnTypes` /
    // `classifyTableApplyStrategy` on the model, never carried through this config surface.
    // Carry the consistency group (ADR-0009 decision 2) so the sync starter buckets grouped tables
    // onto one MultiShapeStream; absent → singleton group.
    ...(entry.consistencyGroup ? { consistencyGroup: entry.consistencyGroup } : {}),
    // Carry the lifecycle axes (ADR-0021) so the sync starter can hold lazy groups out of the eager
    // boot set and provision ephemeral clusters as TEMP; absent → eager/persistent (today's path).
    ...(entry.subscription ? { subscription: entry.subscription } : {}),
    ...(entry.retention ? { retention: entry.retention } : {}),
  };
}

function getClientProjection(entry: SyncTableEntry, tableKey: string) {
  if (!entry.clientProjection) {
    throw new Error(`clientProjection is required for client table ${tableKey}`);
  }

  return entry.clientProjection;
}
