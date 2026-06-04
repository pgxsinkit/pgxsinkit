import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSyncClient } from "@pgxsinkit/client";
import { projectsSyncRegistry, projectsTable, type CreateProjectInput } from "@pgxsinkit/schema";
import { createSyncServer } from "@pgxsinkit/server";
import { createServerDb, readIntegrationEnv, waitFor } from "@pgxsinkit/test-utils";

import { installPlpgsqlBatchFunction } from "../../packages/server/src/mutations/bulk/plpgsql-strategy";

const env = readIntegrationEnv();
let writeApiPort!: number;

async function createPersistentDataDir() {
  return mkdtemp(join(tmpdir(), "pgxsinkit-client-contract-"));
}

async function startFetchServer(
  handler: (request: Request) => Promise<Response>,
  port: number,
): Promise<{ server: Server; port: number }> {
  const server = createServer((incoming, outgoing) => {
    void handleIncomingRequest(incoming, outgoing, handler, port);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();

  if (!address || typeof address === "string") {
    throw new Error("Expected fetch server to bind to a TCP port");
  }

  return {
    server,
    port: (address as AddressInfo).port,
  };
}

async function handleIncomingRequest(
  incoming: IncomingMessage,
  outgoing: ServerResponse,
  handler: (request: Request) => Promise<Response>,
  port: number,
) {
  const body = await readRequestBody(incoming);
  const request = new Request(`http://127.0.0.1:${port}${incoming.url ?? "/"}`, {
    method: incoming.method,
    headers: incoming.headers as HeadersInit,
    body: shouldSendBody(incoming.method) ? body : undefined,
    duplex: "half",
  } as RequestInit & { duplex: "half" });

  const response = await handler(request);

  outgoing.statusCode = response.status;
  response.headers.forEach((value, key) => {
    outgoing.setHeader(key, value);
  });

  const responseBody = Buffer.from(await response.arrayBuffer());
  outgoing.end(responseBody);
}

async function readRequestBody(request: Parameters<Server["emit"]>[1]) {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }

  return chunks.length > 0 ? Buffer.concat(chunks) : undefined;
}

function shouldSendBody(method: string | undefined) {
  return method !== undefined && method !== "GET" && method !== "HEAD";
}

async function stopHttpServer(server: Server | undefined) {
  if (!server || !server.listening) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

describe("client facade contract", () => {
  let server!: ReturnType<typeof createSyncServer<typeof projectsSyncRegistry>>;
  let httpServer!: Server;
  const serverDb = createServerDb(projectsSyncRegistry, env.databaseUrl);

  beforeAll(async () => {
    server = createSyncServer({
      registry: projectsSyncRegistry,
      db: serverDb.db,
    });

    await installPlpgsqlBatchFunction(server.drizzle, projectsSyncRegistry);
    const startedFetchServer = await startFetchServer(server.fetch, 0);
    httpServer = startedFetchServer.server;
    writeApiPort = startedFetchServer.port;
  });

  beforeEach(async () => {
    await server.drizzle.delete(projectsTable);
  });

  afterAll(async () => {
    await stopHttpServer(httpServer);
    await server.stop();
    await serverDb.close();
  });

  it("syncs a non-demo registry into local typed access", async () => {
    const dataDir = await createPersistentDataDir();

    try {
      const seededProject: CreateProjectInput = {
        id: "01965156-5884-7a0b-a24e-31b5c9be0001",
        name: "Client contract seed",
      };

      await server.drizzle.insert(projectsTable).values(seededProject);

      const client = await createSyncClient({
        registry: projectsSyncRegistry,
        electricUrl: env.electricUrl,
        writeUrl: `http://127.0.0.1:${writeApiPort}`,
        dataDir,
      });

      try {
        await client.ready;
        expect(client.status.phase).toBe("ready");
        expect(client.status.isRunning).toBe(true);

        await waitFor(async () => {
          const rows = await client.drizzle.select().from(projectsTable);
          expect(rows).toHaveLength(1);
          expect(rows[0]?.name).toBe("Client contract seed");
        });

        const diagnostics = await client.diagnostics();
        expect(diagnostics.mutation.pendingCount).toBe(0);
        expect(diagnostics.mutation.failedCount).toBe(0);
      } finally {
        await client.destroy();
      }
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("persists synced data across client restart", async () => {
    const dataDir = await createPersistentDataDir();

    try {
      const seededProject: CreateProjectInput = {
        id: "01965156-5884-7a0b-a24e-31b5c9be0002",
        name: "Restart proof",
      };

      await server.drizzle.insert(projectsTable).values(seededProject);

      const firstClient = await createSyncClient({
        registry: projectsSyncRegistry,
        electricUrl: env.electricUrl,
        writeUrl: `http://127.0.0.1:${writeApiPort}`,
        dataDir,
      });

      try {
        await firstClient.ready;
        await waitFor(async () => {
          const rows = await firstClient.drizzle.select().from(projectsTable);
          expect(rows).toHaveLength(1);
        });
      } finally {
        await firstClient.destroy();
      }

      const secondClient = await createSyncClient({
        registry: projectsSyncRegistry,
        electricUrl: env.electricUrl,
        writeUrl: `http://127.0.0.1:${writeApiPort}`,
        dataDir,
      });

      try {
        await secondClient.ready;

        await waitFor(async () => {
          const rows = await secondClient.drizzle.select().from(projectsTable);
          expect(rows).toHaveLength(1);
          expect(rows[0]?.name).toBe("Restart proof");
        });
      } finally {
        await secondClient.destroy();
      }
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("writes through the public client facade and clears diagnostics after sync echo", async () => {
    const dataDir = await createPersistentDataDir();

    try {
      const client = await createSyncClient({
        registry: projectsSyncRegistry,
        electricUrl: env.electricUrl,
        writeUrl: `http://127.0.0.1:${writeApiPort}`,
        dataDir,
      });

      try {
        await client.ready;

        await client.tables.projects.create({
          id: "01965156-5884-7a0b-a24e-31b5c9be0003",
          name: "Public client mutation",
        });

        const queuedDiagnostics = await client.diagnostics();
        expect(queuedDiagnostics.mutation.pendingCount).toBe(1);

        await client.flush();

        await waitFor(async () => {
          const remoteRows = await server.drizzle.select().from(projectsTable);
          const localRows = await client.drizzle.select().from(projectsTable);

          await client.reconcile();
          const diagnostics = await client.diagnostics();

          expect(remoteRows).toHaveLength(1);
          expect(remoteRows[0]?.name).toBe("Public client mutation");
          expect(localRows).toHaveLength(1);
          expect(localRows[0]?.name).toBe("Public client mutation");
          expect(diagnostics.mutation.pendingCount).toBe(0);
          expect(diagnostics.mutation.failedCount).toBe(0);
          expect(diagnostics.mutation.ackedCount).toBe(0);
        });
      } finally {
        await client.destroy();
      }
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("batches local facade mutations and clears diagnostics after sync echo", async () => {
    const dataDir = await createPersistentDataDir();

    try {
      const client = await createSyncClient({
        registry: projectsSyncRegistry,
        electricUrl: env.electricUrl,
        writeUrl: `http://127.0.0.1:${writeApiPort}`,
        dataDir,
      });

      try {
        await client.ready;

        await client.mutate.batch([
          {
            table: "projects",
            kind: "create",
            input: {
              id: "01965156-5884-7a0b-a24e-31b5c9be0004",
              name: "Batched create",
            },
          },
          {
            table: "projects",
            kind: "update",
            entityKey: { id: "01965156-5884-7a0b-a24e-31b5c9be0004" },
            patch: {
              name: "Batched final name",
            },
          },
        ]);

        const queuedDiagnostics = await client.diagnostics();
        expect(queuedDiagnostics.mutation.pendingCount).toBe(2);

        await client.flush();

        await waitFor(async () => {
          const remoteRows = await server.drizzle.select().from(projectsTable);
          const localRows = await client.drizzle.select().from(projectsTable);

          expect(remoteRows).toHaveLength(1);
          expect(remoteRows[0]?.name).toBe("Batched final name");
          expect(localRows).toHaveLength(1);
          expect(localRows[0]?.name).toBe("Batched final name");

          await client.reconcile();

          const diagnostics = await client.diagnostics();
          expect(diagnostics.mutation.pendingCount).toBe(0);
          expect(diagnostics.mutation.failedCount).toBe(0);
          expect(diagnostics.mutation.ackedCount).toBe(0);
        });
      } finally {
        await client.destroy();
      }
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  }, 30_000);
});
