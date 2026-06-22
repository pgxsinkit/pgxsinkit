import { createSyncClient, type ClientPGlite } from "@pgxsinkit/client";
import type { SyncTableRegistry } from "@pgxsinkit/contracts";

export type PerfLabClient = Awaited<ReturnType<typeof createSyncClient<SyncTableRegistry>>>;
export type PerfLabDb = ClientPGlite;

export type PerfLabConnectionMode = "live" | "offline";

export interface PerfLabConnectionOptions {
  mode: PerfLabConnectionMode;
  writeUrl: string;
  electricUrl: string;
  getAuthToken?: () => Promise<string | null | undefined>;
  syncEnabled?: boolean;
}

export interface PerfLabConnectionDefaults {
  liveWriteUrl: string;
  liveElectricUrl: string;
  offlineWriteUrl: string;
  offlineElectricUrl: string;
}

export interface LoadPerfClientOptions {
  prepareLocalDbBeforeSchema?: (db: PerfLabDb) => Promise<void>;
  prepareLocalDb?: (db: PerfLabDb) => Promise<void>;
}

const offlineConnectionDefaults = {
  offlineWriteUrl: "http://127.0.0.1:1",
  offlineElectricUrl: "http://127.0.0.1:1/v1/shape",
} as const;

export function getPerfLabConnectionDefaults(): PerfLabConnectionDefaults {
  const liveWriteUrl = import.meta.env["VITE_WRITE_API_URL"] ?? "http://127.0.0.1:3101";
  const liveElectricUrl = import.meta.env["VITE_ELECTRIC_URL"] ?? `${liveWriteUrl}/v1/electric-proxy`;

  return {
    liveWriteUrl,
    liveElectricUrl,
    ...offlineConnectionDefaults,
  };
}

export async function loadPerfClient(
  registry: SyncTableRegistry,
  dataDir: string,
  connectionOptions: PerfLabConnectionOptions,
  options: LoadPerfClientOptions = {},
) {
  const resolved = await resolveConnectionOptions(connectionOptions);
  const client = await createSyncClient({
    registry,
    electricUrl: resolved.electricUrl,
    writeUrl: resolved.writeUrl,
    ...(resolved.getAuthToken ? { getAuthToken: resolved.getAuthToken } : {}),
    syncEnabled: resolved.syncEnabled,
    ...(resolved.syncEnabled ? { resetSubscriptionKeys: getRegistryShapeKeys(registry) } : {}),
    ...(options.prepareLocalDbBeforeSchema ? { prepareLocalDbBeforeSchema: options.prepareLocalDbBeforeSchema } : {}),
    ...(options.prepareLocalDb ? { prepareLocalDb: options.prepareLocalDb } : {}),
    dataDir,
  });

  return {
    client,
    db: client.pglite,
    dispose: async () => {
      await client.stop();
    },
  };
}

export function buildPerfDataDir(runId: string) {
  void runId;
  return "idb://pgxsinkit-perf-lab-browser";
}

async function resolveConnectionOptions(connectionOptions: PerfLabConnectionOptions) {
  if (connectionOptions.mode === "offline") {
    return {
      writeUrl: offlineConnectionDefaults.offlineWriteUrl,
      electricUrl: offlineConnectionDefaults.offlineElectricUrl,
      getAuthToken: undefined,
      syncEnabled: false,
    };
  }

  const writeUrl = connectionOptions.writeUrl.trim();
  const electricUrl = connectionOptions.electricUrl.trim() || `${writeUrl}/v1/electric-proxy`;
  const getAuthToken = connectionOptions.getAuthToken
    ? async () => {
        const token = await connectionOptions.getAuthToken?.();
        return token?.trim() || undefined;
      }
    : undefined;
  const initialAuthToken = await getAuthToken?.();

  return {
    writeUrl,
    electricUrl,
    getAuthToken,
    syncEnabled: Boolean(connectionOptions.syncEnabled && initialAuthToken),
  };
}

function getRegistryShapeKeys(registry: SyncTableRegistry) {
  return Object.values(registry).flatMap((entry) => {
    if (entry.mode === "writeonly" || entry.shape === undefined) {
      return [];
    }

    return [entry.shape.shapeKey];
  });
}
