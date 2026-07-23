import { createSyncClient, type ClientPGlite } from "@pgxsinkit/client";
import type { SyncTableRegistry } from "@pgxsinkit/contracts";

export type PerfLabClient = Awaited<ReturnType<typeof createSyncClient<SyncTableRegistry>>>;
export type PerfLabDb = ClientPGlite;

export type PerfLabConnectionMode = "live" | "offline";

export interface PerfLabConnectionOptions {
  mode: PerfLabConnectionMode;
  batchWriteUrl: string;
  electricUrl: string;
  getAuthToken?: () => Promise<string | null | undefined>;
  syncEnabled?: boolean;
}

export interface PerfLabConnectionDefaults {
  liveBatchWriteUrl: string;
  liveElectricUrl: string;
  offlineBatchWriteUrl: string;
  offlineElectricUrl: string;
}

export interface LoadPerfClientOptions {
  prepareLocalDbBeforeSchema?: (db: PerfLabDb) => Promise<void>;
  prepareLocalDbAfterSchema?: (db: PerfLabDb) => Promise<void>;
}

const offlineConnectionDefaults = {
  offlineBatchWriteUrl: "http://127.0.0.1:1/api/mutations",
  offlineElectricUrl: "http://127.0.0.1:1/v1/shape",
} as const;

export function getPerfLabConnectionDefaults(): PerfLabConnectionDefaults {
  const writeApiOrigin = (import.meta.env["VITE_WRITE_API_ORIGIN"] ?? "http://127.0.0.1:3101").replace(/\/+$/, "");
  const liveBatchWriteUrl = `${writeApiOrigin}/api/mutations`;
  const liveElectricUrl = import.meta.env["VITE_ELECTRIC_URL"] ?? `${writeApiOrigin}/v1/electric-proxy`;

  return {
    liveBatchWriteUrl,
    liveElectricUrl,
    ...offlineConnectionDefaults,
  };
}

export async function loadPerfClient(
  registry: SyncTableRegistry,
  storePath: string,
  connectionOptions: PerfLabConnectionOptions,
  options: LoadPerfClientOptions = {},
) {
  const resolved = await resolveConnectionOptions(connectionOptions);
  const client = await createSyncClient({
    registry,
    electricUrl: resolved.electricUrl,
    batchWriteUrl: resolved.batchWriteUrl,
    ...(resolved.getAuthToken ? { getAuthToken: resolved.getAuthToken } : {}),
    syncEnabled: resolved.syncEnabled,
    ...(resolved.syncEnabled ? { resetSubscriptionKeys: getRegistryShapeKeys(registry) } : {}),
    ...(options.prepareLocalDbBeforeSchema ? { prepareLocalDbBeforeSchema: options.prepareLocalDbBeforeSchema } : {}),
    ...(options.prepareLocalDbAfterSchema ? { prepareLocalDbAfterSchema: options.prepareLocalDbAfterSchema } : {}),
    storePath,
  });

  return {
    client,
    db: client.pglite,
    dispose: async () => {
      await client.stop();
    },
  };
}

export function buildPerfStorePath(runId: string) {
  void runId;
  // A plain store path (ADR-0036); the browser derives the IndexedDB backend.
  return "pgxsinkit-perf-lab-browser";
}

async function resolveConnectionOptions(connectionOptions: PerfLabConnectionOptions) {
  if (connectionOptions.mode === "offline") {
    return {
      batchWriteUrl: offlineConnectionDefaults.offlineBatchWriteUrl,
      electricUrl: offlineConnectionDefaults.offlineElectricUrl,
      getAuthToken: undefined,
      syncEnabled: false,
    };
  }

  const batchWriteUrl = connectionOptions.batchWriteUrl.trim();
  const electricUrl = connectionOptions.electricUrl.trim() || `${batchWriteUrl}/v1/electric-proxy`;
  const getAuthToken = connectionOptions.getAuthToken
    ? async () => {
        const token = await connectionOptions.getAuthToken?.();
        return token?.trim() || undefined;
      }
    : undefined;
  const initialAuthToken = await getAuthToken?.();

  return {
    batchWriteUrl,
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
