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
import { getSyncRegistrySchema } from "@pgxsinkit/contracts";

import { type LocalStoreVersionEvent, reconcileLocalStoreVersion } from "./local-store";
import { createMutationRuntime, type MutationBatchItem, type MutationDetail, type MutationKind } from "./mutation";
import { buildDropReadCacheSql, buildWipeLocalStoreSql, generateLocalSchemaSql } from "./schema";
import { createElectricExtension, startConfiguredSync } from "./shape-sync";

export { generateLocalSchemaSql };
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
   * Invoked on boot when the registry fingerprint differs from the one the local store was
   * provisioned under (ADR-0006). `rebuilt` = the read cache was dropped and rebuilt at the
   * new shape; `deferred` = un-flushed/quarantined writes are still owed, so the rebuild is
   * postponed (and retried on a later boot) rather than dropping owed data.
   */
  onSchemaChange?: (event: LocalStoreVersionEvent) => void | Promise<void>;
}

export interface SyncClientTableHandle<TRegistry extends SyncTableRegistry, TKey extends SyncTableName<TRegistry>> {
  key: TKey;
  mode: TRegistry[TKey]["mode"];
  create: (input: SyncTableCreateInput<TRegistry, TKey>) => Promise<void>;
  update: (entityKey: Record<string, string>, patch: SyncTableUpdateInput<TRegistry, TKey>) => Promise<void>;
  delete: (entityKey: Record<string, string>) => Promise<void>;
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
  diagnostics: (table?: SyncTableName<TRegistry>) => Promise<{ mutation: MutationDiagnostics }>;
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

  const syncEnabled = options.syncEnabled ?? true;
  let sync: Awaited<ReturnType<typeof startConfiguredSync>> | null = null;

  status.isRunning = true;

  if (syncEnabled) {
    // After a read-cache rebuild the Electric subscription bookkeeping is stale (it would
    // believe the dropped shapes are still caught up and never backfill), so reset every
    // shape subscription to force a fresh re-stream (ADR-0006).
    const resetKeys =
      versionEvent?.status === "rebuilt"
        ? [...(options.resetSubscriptionKeys ?? []), ...allShapeSubscriptionKeys(options.registry)]
        : options.resetSubscriptionKeys;
    await resetSubscriptionsIfRequested(pglite, resetKeys);

    status.phase = "syncing";
    options.onStatusChange?.(status);

    const syncAuthToken = options.getAuthToken ? await options.getAuthToken() : undefined;

    sync = await startConfiguredSync(pglite as unknown as Parameters<typeof startConfiguredSync>[0], {
      syncConfig: buildSyncConfigFromRegistry(options.registry, options.electricUrl),
      ...(syncAuthToken ? { shapeHeaders: { Authorization: `Bearer ${syncAuthToken}` } } : {}),
      ...(options.onTableInitialSync ? { onTableInitialSync: options.onTableInitialSync } : {}),
      onInitialSync: () => {
        status.phase = "ready";
        options.onStatusChange?.(status);
        resolveReady();
      },
    });
  } else {
    status.phase = "ready";
    options.onStatusChange?.(status);
    resolveReady();
  }

  const mutate: SyncClient<TRegistry>["mutate"] = {
    create: (table, input) => mutationRuntime.create(table, input),
    update: (table, entityKey, patch) => mutationRuntime.update(table, entityKey, patch),
    delete: (table, entityKey) => mutationRuntime.delete(table, entityKey),
    batch: (items) => mutationRuntime.batch(items),
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
      sync?.unsubscribe();
      status.isRunning = false;
      options.onStatusChange?.(status);
      await pglite.close();
    },
    destroy: async (destroyOptions) => {
      if (!destroyOptions?.force) {
        const stats = await mutationRuntime.readMutationStats();
        const owed = stats.pendingCount + stats.sendingCount + stats.failedCount + stats.quarantinedCount;

        if (owed > 0) {
          throw new Error(
            `destroy() refused: ${owed} mutation(s) still owed to the server. Flush them first or call destroy({ force: true }).`,
          );
        }
      }

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
      await resetSubscriptionsIfRequested(pglite, allShapeSubscriptionKeys(options.registry));
    },
    flush: (table) => mutationRuntime.flush(table),
    reconcile: (table) => mutationRuntime.reconcile(table),
    retryFailed: (table) => mutationRuntime.retryFailed(table),
    recoverSending: (table) => mutationRuntime.recoverSending(table),
    readMutationDetails: (table) => mutationRuntime.readMutationDetails(table),
    mutate,
    diagnostics: async (table) => ({
      mutation: await mutationRuntime.readMutationStats(table),
    }),
  };

  return client;
}

/** Every Electric shape subscription key declared by the registry (one per synced table). */
function allShapeSubscriptionKeys<TRegistry extends SyncTableRegistry>(registry: TRegistry): string[] {
  return Object.values(registry)
    .map((entry) => entry.shape?.shapeKey)
    .filter((key): key is string => typeof key === "string" && key.length > 0);
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
  };
}

function getClientProjection(entry: SyncTableEntry, tableKey: string) {
  if (!entry.clientProjection) {
    throw new Error(`clientProjection is required for client table ${tableKey}`);
  }

  return entry.clientProjection;
}
