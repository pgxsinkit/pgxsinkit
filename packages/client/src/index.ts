import { PGlite, type PGliteInterfaceExtensions } from "@electric-sql/pglite";
import { live, type PGliteWithLive } from "@electric-sql/pglite/live";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { drizzle } from "drizzle-orm/pglite";

import type {
  ClientProjectionSpec,
  MutationDiagnostics,
  RegistryTables,
  SyncConfigInput,
  SyncRuntimeStatus,
  SyncTableCreateInput,
  SyncTableEntry,
  SyncTableName,
  SyncTableRegistry,
  SyncTableUpdateInput,
} from "@pgxsinkit/contracts";
import { getSyncRegistrySchema } from "@pgxsinkit/contracts";
import { createElectricExtension, startConfiguredSync } from "@pgxsinkit/sync-engine";

import { createMutationRuntime, type MutationBatchItem, type MutationDetail, type MutationKind } from "./mutation";
import { generateLocalSchemaSql } from "./schema";

export type ClientPGlite = PGliteWithLive &
  PGliteInterfaceExtensions<{ electric: ReturnType<typeof createElectricExtension> }>;

export interface CreateSyncClientOptions<TRegistry extends SyncTableRegistry> {
  registry: TRegistry;
  electricUrl: string;
  writeUrl: string;
  batchWriteUrl?: string;
  authToken?: string;
  syncEnabled?: boolean;
  dataDir?: string;
  resetSubscriptionKeys?: string[];
  prepareLocalDb?: (pglite: ClientPGlite) => Promise<void>;
  onStatusChange?: (status: SyncRuntimeStatus) => void;
}

export interface SyncClientTableHandle<TRegistry extends SyncTableRegistry, TKey extends SyncTableName<TRegistry>> {
  key: TKey;
  mode: TRegistry[TKey]["mode"];
  create: (input: SyncTableCreateInput<TRegistry, TKey>) => Promise<void>;
  update: (entityKey: Record<string, string>, patch: SyncTableUpdateInput<TRegistry, TKey>) => Promise<void>;
  delete: (entityKey: Record<string, string>) => Promise<void>;
}

export interface SyncClient<TRegistry extends SyncTableRegistry> {
  drizzle: PgliteDatabase<RegistryTables<TRegistry>>;
  pglite: ClientPGlite;
  tables: {
    [TKey in SyncTableName<TRegistry>]: SyncClientTableHandle<TRegistry, TKey>;
  };
  ready: Promise<void>;
  status: SyncRuntimeStatus;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  destroy: () => Promise<void>;
  flush: (table?: SyncTableName<TRegistry>) => Promise<void>;
  reconcile: (table?: SyncTableName<TRegistry>) => Promise<void>;
  retryFailed: (table?: SyncTableName<TRegistry>) => Promise<void>;
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

  const pglite = (await PGlite.create(options.dataDir ?? "idb://pgxsinkit-overlay-v1", {
    extensions: {
      electric: createElectricExtension(),
      live,
    },
  })) as ClientPGlite;

  const schemaSql = generateLocalSchemaSql(options.registry);
  await pglite.exec(schemaSql);

  if (options.prepareLocalDb) {
    await options.prepareLocalDb(pglite);
  }

  const drizzleDb = createDrizzleDatabase(pglite, buildSchema(options.registry));

  const syncEnabled = options.syncEnabled ?? true;
  let sync: Awaited<ReturnType<typeof startConfiguredSync>> | null = null;

  status.isRunning = true;

  if (syncEnabled) {
    await resetSubscriptionsIfRequested(pglite, options.resetSubscriptionKeys);

    status.phase = "syncing";
    options.onStatusChange?.(status);

    sync = await startConfiguredSync(pglite as unknown as Parameters<typeof startConfiguredSync>[0], {
      syncConfig: buildSyncConfigFromRegistry(options.registry, options.electricUrl),
      ...(options.authToken ? { shapeHeaders: { Authorization: `Bearer ${options.authToken}` } } : {}),
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

  const mutationRuntime = createMutationRuntime({
    db: pglite,
    registry: options.registry,
    writeUrl: options.writeUrl,
    ...(options.batchWriteUrl !== undefined ? { batchWriteUrl: options.batchWriteUrl } : {}),
    ...(options.authToken ? { authToken: options.authToken } : {}),
  });

  await mutationRuntime.recoverSending();

  const mutate: SyncClient<TRegistry>["mutate"] = {
    create: (table, input) => mutationRuntime.create(table, input),
    update: (table, entityKey, patch) => mutationRuntime.update(table, entityKey, patch),
    delete: (table, entityKey) => mutationRuntime.delete(table, entityKey),
    batch: (items) => mutationRuntime.batch(items),
  };

  const client: SyncClient<TRegistry> = {
    drizzle: drizzleDb,
    pglite,
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
    destroy: async () => {
      sync?.unsubscribe();
      status.isRunning = false;
      options.onStatusChange?.(status);
      await pglite.close();
    },
    flush: (table) => mutationRuntime.flush(table),
    reconcile: (table) => mutationRuntime.reconcile(table),
    retryFailed: (table) => mutationRuntime.retryFailed(table),
    readMutationDetails: (table) => mutationRuntime.readMutationDetails(table),
    mutate,
    diagnostics: async (table) => ({
      mutation: await mutationRuntime.readMutationStats(table),
    }),
  };

  return client;
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
  const createDatabase = drizzle as unknown as (config: {
    client: ClientPGlite;
    schema: RegistryTables<TRegistry>;
  }) => PgliteDatabase<RegistryTables<TRegistry>>;

  return createDatabase({ client, schema });
}

function buildSchema<TRegistry extends SyncTableRegistry>(registry: TRegistry) {
  return Object.fromEntries(
    Object.entries(registry).map(([key, entry]) => [key, entry.table]),
  ) as RegistryTables<TRegistry>;
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
    shape: entry.shape,
    routes: entry.routes,
    clientProjection,
  };
}

function getClientProjection(entry: SyncTableEntry, tableKey: string): ClientProjectionSpec {
  if (!entry.clientProjection) {
    throw new Error(`clientProjection is required for client table ${tableKey}`);
  }

  return entry.clientProjection;
}
