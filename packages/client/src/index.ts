import { PGlite, type PGliteInterfaceExtensions } from "@electric-sql/pglite";
import { live, type PGliteWithLive } from "@electric-sql/pglite/live";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { defineRelations } from "drizzle-orm/relations";

import type {
  MutationDiagnostics,
  RegistryRelations,
  RegistryTables,
  RegistryViews,
  SyncConfigInput,
  SyncRuntimeStatus,
  SyncTableCreateInput,
  SyncTableEntry,
  SyncTableName,
  SyncTableRegistry,
  SyncTableUpdateInput,
} from "@pgxsinkit/contracts";
import { classifyTableApplyStrategy, deriveSyncColumnTypes, getSyncRegistrySchema } from "@pgxsinkit/contracts";

import { type ConvergenceDriver, type ConvergenceTrigger, createConvergenceDriver } from "./convergence";
import { assertLazyRefsActivated, buildLazyGuardIndex, findReferencedLazyKeysInSql } from "./lazy-guard";
import {
  type LocalStoreVersionEvent,
  clearLazyGroupActivation,
  readActivatedLazyGroups,
  reconcileLocalStoreVersion,
  writeLazyGroupActivation,
} from "./local-store";
import { createMutationRuntime, type MutationBatchItem, type MutationDetail, type MutationKind } from "./mutation";
import { buildDesyncTableSql, buildDropReadCacheSql, buildWipeLocalStoreSql, generateLocalSchemaSql } from "./schema";
import { createElectricExtension, startConfiguredSync } from "./shape-sync";
import { buildAuthShapeHeaders } from "./sync-auth";

export { generateLocalSchemaSql };
export {
  type ConvergenceClient,
  type ConvergenceDriver,
  type ConvergenceDriverOptions,
  type ConvergenceTrigger,
  createBrowserConvergenceTrigger,
  createConvergenceDriver,
  createIntervalConvergenceTrigger,
} from "./convergence";
export { syncDebug, timeAsync } from "./debug";
export {
  assertLazyRefsActivated,
  buildLazyGuardIndex,
  findReferencedLazyKeysInSql,
  type LazyGuardIndex,
  LazyRelationNotActivatedError,
} from "./lazy-guard";
export type { LocalStoreVersionEvent };

export type ClientPGlite = PGliteWithLive &
  PGliteInterfaceExtensions<{ electric: ReturnType<typeof createElectricExtension> }>;

export interface CreateSyncClientOptions<TRegistry extends SyncTableRegistry> {
  registry: TRegistry;
  electricUrl: string;
  writeUrl: string;
  getAuthToken?: () => Promise<string | undefined>;
  syncEnabled?: boolean;
  dataDir?: string;
  resetSubscriptionKeys?: string[];
  prepareLocalDbBeforeSchema?: (pglite: ClientPGlite) => Promise<void>;
  prepareLocalDb?: (pglite: ClientPGlite) => Promise<void>;
  onStatusChange?: (status: SyncRuntimeStatus) => void;
  onTableInitialSync?: (tableKey: string) => void;
  pgliteInstance?: ClientPGlite;
  /**
   * Hard cap on send attempts before a still-failing mutation is quarantined
   * (ADR-0005 congestion policy). Defaults to the library's built-in cap.
   */
  maxMutationAttempts?: number;
  /**
   * Invoked when mutations are quarantined (permanently rejected by the server, terminal).
   * The library surfaces them here rather than silently dropping or retry-looping (ADR-0006).
   */
  onQuarantine?: (quarantined: MutationDetail[]) => void | Promise<void>;
  /**
   * Invoked when mutations are `conflicted` — a stale write the server declined under the
   * `reject-if-stale` Conflict policy (ADR-0015). The optimistic Overlay is kept, so the app shows a
   * resolution/diff UI and resolves each as a new write (`mutate.update`) or `discardConflict`s it.
   */
  onConflict?: (conflicted: MutationDetail[]) => void | Promise<void>;
  /**
   * Invoked on boot when the registry fingerprint differs from the one the local store was
   * provisioned under (ADR-0006). `rebuilt` = the read cache was dropped and rebuilt at the
   * new shape; `deferred` = un-flushed/quarantined writes are still owed, so the rebuild is
   * postponed (and retried on a later boot) rather than dropping owed data.
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
}

export interface SyncClientTableHandle<TRegistry extends SyncTableRegistry, TKey extends SyncTableName<TRegistry>> {
  key: TKey;
  mode: TRegistry[TKey]["mode"];
  create: (input: SyncTableCreateInput<TRegistry, TKey>) => Promise<void>;
  update: (entityKey: Record<string, string>, patch: SyncTableUpdateInput<TRegistry, TKey>) => Promise<void>;
  delete: (entityKey: Record<string, string>) => Promise<void>;
}

/** Minimal shape of a Drizzle select builder: inspectable via `.toSQL()` and awaitable for its rows. */
export interface DrizzleQueryBuilder<TRows extends readonly unknown[]> extends PromiseLike<TRows> {
  toSQL(): { sql: string; params: unknown[] };
}

/**
 * A declared-safe query (ADR-0021). `use` names the lazy relations the query reads — they are
 * activated and awaited before it runs. `build` receives the client; reach relations through
 * `c.views` / `c.drizzle` / a directly-imported synced table as usual.
 */
export interface GuardedQuerySpec<TRegistry extends SyncTableRegistry, TRows extends readonly unknown[]> {
  use?: readonly SyncTableName<TRegistry>[];
  build: (client: SyncClient<TRegistry>) => DrizzleQueryBuilder<TRows>;
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

export interface SyncClient<TRegistry extends SyncTableRegistry> {
  drizzle: PgliteDatabase<RegistryRelations<TRegistry>>;
  pglite: ClientPGlite;
  views: RegistryViews<TRegistry>;
  tables: {
    [TKey in SyncTableName<TRegistry>]: SyncClientTableHandle<TRegistry, TKey>;
  };
  ready: Promise<void>;
  status: SyncRuntimeStatus;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  /**
   * Wipe the entire local store (synced cache + overlay + journal) and close the handle
   * (ADR-0005). Refuses if mutations are still owed to the server unless `force` is set, so
   * it never silently drops un-flushed writes. Distinct from `stop()`, which only halts sync.
   */
  destroy: (options?: { force?: boolean }) => Promise<void>;
  /**
   * Drop and rebuild the reconstructible synced read cache, preserving the overlay and
   * mutation journal (ADR-0006). The next sync refills it. Use to recover from a corrupt or
   * stale read cache without losing un-flushed writes.
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
  diagnostics: (table?: SyncTableName<TRegistry>) => Promise<{ mutation: MutationDiagnostics }>;
  /**
   * Run a one-shot (non-live) typed query with the lazy-relation safety net (ADR-0021). The lazy
   * relations the query reads are activated and awaited before it runs — declare them in `use`, and/or
   * let pgxsinkit auto-detect them from the builder — and the tripwire rejects any lazy relation the
   * compiled SQL still references but that is not active, so the result can never be silently
   * empty/stale. The guaranteed-safe alternative to a bare `client.drizzle` read.
   */
  query: <TRows extends readonly unknown[]>(spec: GuardedQuerySpec<TRegistry, TRows>) => Promise<TRows>;
  /** {@link query} returning the first row, or null when empty. */
  queryRow: <TRows extends readonly unknown[]>(
    spec: GuardedQuerySpec<TRegistry, TRows>,
  ) => Promise<TRows[number] | null>;
  /**
   * Activate one or more lazy relations (ADR-0021): open their consistency-group subscription if held
   * out of the eager boot, resolving once their initial sync completes. Idempotent — eager or
   * already-started relations resolve immediately. Use to pre-activate before a raw/`client.drizzle`
   * read, or as the manual escape hatch the tripwire points to.
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
   * The read-path safety seam (ADR-0021): scan the compiled `sql` for the lazy relations it reads
   * (∪ the optional `use`), activate them, and await their initial sync — so a lazy relation
   * auto-activates on *any* reference (FROM, JOIN, subquery, WHERE). Resolves once it is safe to run the
   * query; a backstop throws {@link LazyRelationNotActivatedError} only if a referenced relation could
   * not be activated. Exposed for the React live hooks (which own their query build); `query`/`queryRow`
   * are the higher-level non-live wrappers. Raw, non-Drizzle SQL is out of scope — pass `use`, or
   * `ensureSynced` first.
   */
  prepareQuery: (input: PrepareQueryInput<TRegistry>) => Promise<void>;
}

export type { MutationBatchItem, MutationDetail, MutationDiagnostics, MutationKind };

export async function createSyncClient<const TRegistry extends SyncTableRegistry>(
  options: CreateSyncClientOptions<TRegistry>,
): Promise<SyncClient<TRegistry>> {
  const status: SyncRuntimeStatus = {
    phase: "booting",
    isRunning: false,
  };

  let resolveReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });

  let pglite: ClientPGlite;
  if (options.pgliteInstance) {
    pglite = options.pgliteInstance;
    // Assume schema is already applied by caller
  } else {
    pglite = (await PGlite.create(options.dataDir ?? "idb://pgxsinkit-overlay-v1", {
      extensions: {
        electric: createElectricExtension(),
        live,
      },
    })) as ClientPGlite;

    if (options.prepareLocalDbBeforeSchema) {
      await options.prepareLocalDbBeforeSchema(pglite);
    }

    const schemaSql = generateLocalSchemaSql(options.registry);
    await pglite.exec(schemaSql);

    if (options.prepareLocalDb) {
      await options.prepareLocalDb(pglite);
    }
  }

  const mutationRuntime = createMutationRuntime({
    db: pglite,
    registry: options.registry,
    writeUrl: options.writeUrl,
    ...(options.getAuthToken ? { getAuthToken: options.getAuthToken } : {}),
    ...(options.maxMutationAttempts != null ? { maxMutationAttempts: options.maxMutationAttempts } : {}),
    ...(options.onQuarantine ? { onQuarantine: options.onQuarantine } : {}),
    ...(options.onConflict ? { onConflict: options.onConflict } : {}),
  });

  // Reclaim any in-flight mutations interrupted by a previous shutdown (ADR-0005), then
  // reconcile the local store against the current registry fingerprint before sync starts
  // (ADR-0006). Skipped when the caller supplies their own pglite (they own its schema).
  await mutationRuntime.recoverSending();

  let versionEvent: LocalStoreVersionEvent | null = null;

  if (!options.pgliteInstance) {
    versionEvent = await reconcileLocalStoreVersion({
      db: pglite,
      registry: options.registry,
      runtime: mutationRuntime,
      ...(options.onSchemaChange ? { onSchemaChange: options.onSchemaChange } : {}),
    });
  }

  const drizzleDb = createDrizzleDatabase(pglite, buildSchema(options.registry));
  // Static index of the registry's lazy relations (ADR-0021), driving the read-path safety net.
  const lazyGuardIndex = buildLazyGuardIndex(options.registry);

  const syncEnabled = options.syncEnabled ?? true;
  let sync: Awaited<ReturnType<typeof startConfiguredSync>> | null = null;
  let convergenceDriver: ConvergenceDriver | null = null;
  // Whether the read path's first initial sync has completed, so a recovery from `auth-needed`
  // returns to the right steady-state phase (`ready` if already caught up, else `syncing`).
  let initialSyncCompleted = false;
  // Why the runtime is `degraded` (#4). A read-stream error degraded clears on the next successful
  // batch; a commit-failure degraded is sticky (a fetch can succeed while applies still fail), so a
  // bare `onSyncActivity` must not clear it.
  let degradedReason: "stream" | "commit" | null = null;

  status.isRunning = true;

  if (syncEnabled) {
    // After a read-cache rebuild the Electric subscription bookkeeping is stale (it would
    // believe the dropped shapes are still caught up and never backfill), so reset every
    // shape subscription to force a fresh re-stream (ADR-0006).
    const resetKeys =
      versionEvent?.status === "rebuilt"
        ? [...(options.resetSubscriptionKeys ?? []), ...allGroupSubscriptionKeys(options.registry)]
        : options.resetSubscriptionKeys;
    await resetSubscriptionsIfRequested(pglite, resetKeys);

    status.phase = "syncing";
    options.onStatusChange?.(status);

    // Promote any `lazy + persistent` group activated on a previous boot back into the eager set
    // (ADR-0021 §2); the sync engine does no DB read of its own.
    const promotedGroups = await readActivatedLazyGroups(pglite, options.registry);

    sync = await startConfiguredSync(pglite as unknown as Parameters<typeof startConfiguredSync>[0], {
      syncConfig: buildSyncConfigFromRegistry(options.registry, options.electricUrl),
      promotedGroups,
      // Persist a durable lazy group's activation on first on-demand start, so the next boot promotes it.
      onLazyActivated: (groupKey) => {
        void writeLazyGroupActivation(pglite, options.registry, groupKey);
      },
      // The read path resolves the token per request (ADR-0013), not frozen at boot — so a
      // long-lived session never wedges on JWT expiry. Read and write share one token lifecycle.
      ...(options.getAuthToken ? { shapeHeaders: buildAuthShapeHeaders(options.getAuthToken) } : {}),
      ...(options.onTableInitialSync ? { onTableInitialSync: options.onTableInitialSync } : {}),
      onInitialSync: () => {
        initialSyncCompleted = true;
        status.phase = "ready";
        options.onStatusChange?.(status);
        resolveReady();
      },
      onSyncError: (error) => {
        // A sync commit exhausted its retries (ADR-0009 decision 5): go degraded and surface it,
        // rather than letting the read cache silently diverge from the server. Sticky (see below).
        status.phase = "degraded";
        degradedReason = "commit";
        status.lastError = error.message;
        options.onStatusChange?.(status);
        options.onSyncError?.(error);
      },
      // #4: a terminal/transient NON-auth read-stream error → `degraded`, so the runtime never keeps
      // reporting healthy while the read stream has stalled. Does not override the more-actionable
      // `auth-needed`, nor a commit-failure degraded. Cleared on the next successful batch below.
      onReadStreamError: (error) => {
        // Never mask the more-actionable auth-needed, nor a sticky commit-failure degraded (its
        // lastError is the more serious signal — a stream blip must not overwrite it).
        if (status.phase === "auth-needed") return;
        if (status.phase === "degraded" && degradedReason === "commit") return;
        // Enter, or refresh, a stream-degraded status. Refreshing keeps `lastError` pointing at the
        // most recent stream fault (and re-emits) rather than freezing on the first one, so a stream
        // that fails one way then another reports the current cause (observability).
        status.phase = "degraded";
        degradedReason = "stream";
        status.lastError = error.message;
        options.onStatusChange?.(status);
      },
      // Clear a recoverable status (auth-needed, or a read-stream degraded) the moment a batch is
      // delivered again. A commit-failure degraded is NOT cleared here — a fetch can succeed while
      // applies keep failing, so only `onSyncError` clearing (a clean commit) would lift it.
      onSyncActivity: () => {
        if (status.phase === "auth-needed" || (status.phase === "degraded" && degradedReason === "stream")) {
          degradedReason = null;
          status.phase = initialSyncCompleted ? "ready" : "syncing";
          options.onStatusChange?.(status);
        }
      },
      // ADR-0013 Phase 3: surface a persistent read-path auth failure as a distinct `auth-needed`
      // status (the app prompts re-login) while the stream keeps retrying for a fresh token. Only
      // wired when a token provider exists — without one there is no auth lifecycle to track.
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
  } else {
    status.phase = "ready";
    options.onStatusChange?.(status);
    resolveReady();
  }

  if (options.autoSync) {
    convergenceDriver = createConvergenceDriver({
      client: {
        flush: () => mutationRuntime.flush(),
        reconcile: () => mutationRuntime.reconcile(),
      },
      trigger: options.autoSync,
      ...(options.onConvergencePass ? { onPass: options.onConvergencePass } : {}),
    });

    // Start driving convergence once the initial sync is ready, so a pass never races the
    // first shape load. stop()/destroy() halt it.
    void ready.then(() => convergenceDriver?.start());
  }

  // Event-driven convergence: the moment a mutation is enqueued, ask the driver to run a pass so the
  // write flushes immediately rather than waiting for the trigger's next interval tick. This is what
  // lets the interval be a rare fallback (and so run far less often). No-op when `autoSync` is off — the
  // caller drives `flush`/`reconcile` itself.
  const requestConvergence = () => convergenceDriver?.requestPass();
  const mutate: SyncClient<TRegistry>["mutate"] = {
    create: async (table, input) => {
      await mutationRuntime.create(table, input);
      requestConvergence();
    },
    update: async (table, entityKey, patch) => {
      await mutationRuntime.update(table, entityKey, patch);
      requestConvergence();
    },
    delete: async (table, entityKey) => {
      await mutationRuntime.delete(table, entityKey);
      requestConvergence();
    },
    batch: async (items) => {
      await mutationRuntime.batch(items);
      requestConvergence();
    },
  };

  // ─── Lazy-relation activation + the declared-safe query facade (ADR-0021) ──────────────────────
  const ensureSynced: SyncClient<TRegistry>["ensureSynced"] = async (keys) => {
    const activeSync = sync;
    if (activeSync == null || keys.length === 0) return;
    const groupKeys = new Set<string>();
    for (const key of keys) {
      const groupKey = activeSync.groupKeyForTable(key);
      if (groupKey != null) groupKeys.add(groupKey);
    }
    await Promise.all([...groupKeys].map((groupKey) => activeSync.ensureGroupStarted(groupKey)));
  };

  const isSynced: SyncClient<TRegistry>["isSynced"] = (key) => {
    const activeSync = sync;
    // Sync disabled → local-only: reads hit whatever is in the local store, so nothing is "dormant".
    if (activeSync == null) return true;
    return activeSync.isTableStarted(key);
  };

  const desync: SyncClient<TRegistry>["desync"] = async (key) => {
    const entry = options.registry[key];
    if (entry == null) throw new Error(`desync: unknown table ${String(key)}`);
    if (entry.subscription !== "lazy") {
      throw new Error(
        `desync('${String(key)}') refused: only a lazy relation can be desynced — an eager relation is always-on and would immediately re-sync.`,
      );
    }

    // Refuse if the table owes the server unsent/unsettled writes: the truncate clears the journal, so
    // dropping un-acked local intent would be silent data loss. Flush (or discard) those first.
    const stats = await mutationRuntime.readMutationStats(key);
    const owed =
      stats.pendingCount + stats.sendingCount + stats.failedCount + stats.quarantinedCount + stats.conflictedCount;
    if (owed > 0) {
      throw new Error(
        `desync('${String(key)}') refused: ${owed} unsettled mutation(s) in the local journal. Flush or discard them first.`,
      );
    }

    const activeSync = sync;
    const groupKey = activeSync?.groupKeyForTable(key);
    // Stop the stream BEFORE truncating so a live shape can't re-populate the rows we just cleared, then
    // revert the durable promotion (a no-op for ephemeral, which never persisted a flag) so the next boot
    // holds the relation dormant, and finally empty the read cache.
    if (activeSync != null && groupKey != null) activeSync.stopGroup(groupKey);
    if (groupKey != null) await clearLazyGroupActivation(pglite, options.registry, groupKey);
    await pglite.exec(buildDesyncTableSql(options.registry, key as string));
  };

  const prepareQuery: SyncClient<TRegistry>["prepareQuery"] = async ({ sql, use }) => {
    // Scan the compiled SQL for the lazy relations it reads (∪ the explicit `use`) and activate them.
    // The compiled SQL is ground truth and Drizzle quotes every relation, so any reference — FROM, JOIN,
    // subquery, WHERE — is caught; over-matching is bounded and harmless (one spurious persistent
    // subscription at worst, never a wrong result). Detection and activation are one step (ADR-0021).
    const toActivate = new Set<string>(use ?? []);
    for (const key of findReferencedLazyKeysInSql(sql, lazyGuardIndex)) toActivate.add(key);
    await ensureSynced([...toActivate] as SyncTableName<TRegistry>[]);
    // Backstop: if a referenced lazy relation is somehow still not active (a failed start, or no group),
    // throw rather than let the query read empty/stale. In the normal path everything scanned was just
    // activated, so this passes.
    assertLazyRefsActivated({
      sql,
      index: lazyGuardIndex,
      isActive: (key) => isSynced(key as SyncTableName<TRegistry>),
    });
  };

  const runGuardedQuery = async <TRows extends readonly unknown[]>(
    spec: GuardedQuerySpec<TRegistry, TRows>,
  ): Promise<TRows> => {
    const builder = spec.build(client);
    await prepareQuery({ sql: builder.toSQL().sql, ...(spec.use ? { use: spec.use } : {}) });
    return builder;
  };

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
    ready,
    status,
    start: async () => {
      await ready;
    },
    stop: async () => {
      // Await any in-flight convergence pass before closing PGlite, so a pass never queries a
      // closed handle.
      await convergenceDriver?.stop();
      sync?.unsubscribe();
      status.isRunning = false;
      options.onStatusChange?.(status);
      await pglite.close();
    },
    destroy: async (destroyOptions) => {
      if (!destroyOptions?.force) {
        const stats = await mutationRuntime.readMutationStats();
        const owed =
          stats.pendingCount + stats.sendingCount + stats.failedCount + stats.quarantinedCount + stats.conflictedCount;

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
      await pglite.close();
    },
    dropReadCache: async () => {
      await pglite.exec(buildDropReadCacheSql(options.registry));
      await pglite.exec(generateLocalSchemaSql(options.registry));
      // Reset the Electric subscriptions so the rebuilt synced tables re-stream from scratch
      // rather than the bookkeeping believing they are already caught up (ADR-0006).
      await resetSubscriptionsIfRequested(pglite, allGroupSubscriptionKeys(options.registry));
    },
    flush: (table) => mutationRuntime.flush(table),
    reconcile: (table) => mutationRuntime.reconcile(table),
    retryFailed: (table) => mutationRuntime.retryFailed(table),
    recoverSending: (table) => mutationRuntime.recoverSending(table),
    readMutationDetails: (table) => mutationRuntime.readMutationDetails(table),
    mutate,
    discardConflict: (table, entityKey) => mutationRuntime.discardConflict(table, entityKey),
    diagnostics: async (table) => ({
      mutation: await mutationRuntime.readMutationStats(table),
    }),
    query: (spec) => runGuardedQuery(spec),
    queryRow: async (spec) => {
      const rows = await runGuardedQuery(spec);
      return rows[0] ?? null;
    },
    ensureSynced,
    isSynced,
    desync,
    prepareQuery,
  };

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
    // Resolve the read-path apply ladder statically from the registry's column types (ADR-0009
    // decision 3): the engine selects copy|json|insert and feeds the json path its casts, with no
    // runtime information_schema round-trip.
    applyStrategy: classifyTableApplyStrategy(entry),
    columnTypes: deriveSyncColumnTypes(entry),
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
