import { createSyncClient, type ClientPGlite } from "@pgxsinkit/client";
import type { SyncTableRegistry } from "@pgxsinkit/contracts";

export type PerfLabClient = Awaited<ReturnType<typeof createSyncClient<SyncTableRegistry>>>;
export type PerfLabDb = ClientPGlite;

export type PerfLabConnectionMode = "live" | "offline";

export interface PerfLabConnectionOptions {
  mode: PerfLabConnectionMode;
  batchWriteUrl: string;
  /** The pgxsinkit control plane (ADR-0055). Defaults to the write origin's own `/sync` mount. */
  controlPlaneUrl: string;
  /** The edge serving durable-streams reads. */
  streamBaseUrl: string;
  getAuthToken?: () => Promise<string | null | undefined>;
  syncEnabled?: boolean;
}

export interface PerfLabConnectionDefaults {
  liveBatchWriteUrl: string;
  liveControlPlaneUrl: string;
  liveStreamBaseUrl: string;
  offlineBatchWriteUrl: string;
}

export interface LoadPerfClientOptions {
  prepareLocalDbBeforeSchema?: (db: PerfLabDb) => Promise<void>;
  prepareLocalDbAfterSchema?: (db: PerfLabDb) => Promise<void>;
}

const offlineConnectionDefaults = {
  offlineBatchWriteUrl: "http://127.0.0.1:1/api/mutations",
} as const;

export function getPerfLabConnectionDefaults(): PerfLabConnectionDefaults {
  const writeApiOrigin = (import.meta.env["VITE_WRITE_API_ORIGIN"] ?? "http://127.0.0.1:3101").replace(/\/+$/, "");
  const liveBatchWriteUrl = `${writeApiOrigin}/api/mutations`;
  // The control plane is the write origin by default: `createSyncServer` mounts /sync/v1/* beside
  // /api/mutations, so one deployment answers both. The stream edge is separate by construction —
  // it is the CDN-frontable surface, so it has no sensible same-origin default.
  const liveControlPlaneUrl = import.meta.env["VITE_CONTROL_PLANE_URL"] ?? writeApiOrigin;
  const liveStreamBaseUrl = import.meta.env["VITE_STREAM_BASE_URL"] ?? "http://127.0.0.1:8791/v1/stream";

  return {
    liveBatchWriteUrl,
    liveControlPlaneUrl,
    liveStreamBaseUrl,
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
    controlPlaneUrl: resolved.controlPlaneUrl,
    streamBaseUrl: resolved.streamBaseUrl,
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
      controlPlaneUrl: "",
      streamBaseUrl: "",
      getAuthToken: undefined,
      syncEnabled: false,
    };
  }

  const batchWriteUrl = connectionOptions.batchWriteUrl.trim();
  const controlPlaneUrl = connectionOptions.controlPlaneUrl.trim() || batchWriteUrl;
  const streamBaseUrl = connectionOptions.streamBaseUrl.trim();
  const getAuthToken = connectionOptions.getAuthToken
    ? async () => {
        const token = await connectionOptions.getAuthToken?.();
        return token?.trim() || undefined;
      }
    : undefined;
  const initialAuthToken = await getAuthToken?.();

  return {
    batchWriteUrl,
    controlPlaneUrl,
    streamBaseUrl,
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
