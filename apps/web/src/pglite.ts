import { createSyncClient, type ClientPGlite } from "@pgxsinkit/client";
import { demoSyncRegistry, type DemoAuthIdentity } from "@pgxsinkit/demo";

export type AppDb = ClientPGlite;
export type AppClient = Awaited<ReturnType<typeof createSyncClient<typeof demoSyncRegistry>>>;

interface LoadedDatabase {
  client: AppClient;
  db: AppDb;
  initialSyncDone: Promise<void>;
  dispose: () => Promise<void>;
}

interface LoadPGliteOptions {
  identity: DemoAuthIdentity;
  getAuthToken?: () => Promise<string | null | undefined>;
}

type SharedLoadedDatabase = Omit<LoadedDatabase, "dispose">;

interface SharedDatabaseEntry {
  refCount: number;
  promise: Promise<SharedLoadedDatabase>;
}

const sharedDatabases = new Map<string, SharedDatabaseEntry>();

export async function loadPGlite(options?: LoadPGliteOptions): Promise<LoadedDatabase> {
  const writeUrl = import.meta.env.VITE_WRITE_API_URL ?? "http://localhost:3001";
  const batchWriteUrl = import.meta.env.VITE_BATCH_WRITE_URL ?? writeUrl;
  const electricUrl = import.meta.env.VITE_ELECTRIC_URL ?? `${writeUrl}/v1/shape-proxy`;
  const getAuthToken = options?.getAuthToken
    ? async () => {
        const token = await options.getAuthToken?.();
        return token ?? undefined;
      }
    : undefined;
  const initialAuthToken = await getAuthToken?.();
  const dataDir = getDemoDataDirForIdentity(options?.identity ?? "user1");
  let entry = sharedDatabases.get(dataDir);

  if (!entry) {
    entry = {
      refCount: 0,
      promise: createSyncClient({
        registry: demoSyncRegistry,
        electricUrl,
        writeUrl,
        batchWriteUrl,
        ...(getAuthToken ? { getAuthToken } : {}),
        syncEnabled: initialAuthToken !== undefined,
        dataDir,
      }).then((client) => ({
        client,
        db: client.pglite,
        initialSyncDone: client.ready,
      })),
    };

    sharedDatabases.set(dataDir, entry);
  }

  entry.refCount += 1;

  try {
    const loaded = await entry.promise;
    let disposed = false;

    return {
      ...loaded,
      dispose: async () => {
        if (disposed) {
          return;
        }

        disposed = true;
        await releaseSharedDatabase(dataDir, entry);
      },
    };
  } catch (error) {
    entry.refCount -= 1;

    if (entry.refCount <= 0 && sharedDatabases.get(dataDir) === entry) {
      sharedDatabases.delete(dataDir);
    }

    throw error;
  }
}

export function getDemoDataDirForIdentity(identity: DemoAuthIdentity): string {
  return `idb://pgxsinkit-overlay-v1-${identity}`;
}

async function releaseSharedDatabase(dataDir: string, entry: SharedDatabaseEntry): Promise<void> {
  entry.refCount -= 1;

  if (entry.refCount > 0) {
    return;
  }

  if (sharedDatabases.get(dataDir) === entry) {
    sharedDatabases.delete(dataDir);
  }

  const loaded = await entry.promise;
  await loaded.client.destroy();
}
