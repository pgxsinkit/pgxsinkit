import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PGlite } from "@electric-sql/pglite";
import { count, eq } from "drizzle-orm";

import {
  createIntervalConvergenceTrigger,
  createSyncClient,
  getLocalMetaTable,
  getOverlayTable,
  type MutationDetail,
} from "@pgxsinkit/client";
import { projectsSyncRegistry, projectsTable, type CreateProjectInput } from "@pgxsinkit/schema";
import { createSyncServer } from "@pgxsinkit/server";
import {
  createServerDb,
  readIntegrationEnv,
  startNativeSyncStack,
  waitFor,
  type NativeSyncStack,
} from "@pgxsinkit/test-utils";

import { installPlpgsqlBatchFunction } from "../../packages/server/src/mutations/plpgsql-apply";
import { fixedTestClaims } from "../support/claims";
import { drizzleOver } from "../support/drizzle";

const env = readIntegrationEnv();

async function createPersistentDataDir() {
  return mkdtemp(join(tmpdir(), "pgxsinkit-client-contract-"));
}

describe("client facade contract", () => {
  let stack!: NativeSyncStack<ReturnType<typeof createSyncServer<typeof projectsSyncRegistry>>>;
  let server!: ReturnType<typeof createSyncServer<typeof projectsSyncRegistry>>;
  let batchWriteUrl!: string;
  const serverDb = createServerDb(projectsSyncRegistry, env.databaseUrl);

  beforeAll(async () => {
    // One origin serves both halves here: `createSyncServer` mounts /sync/v1/* beside /api/mutations,
    // which is the default deployment shape. Only the EDGE is separate, because in production it is
    // the CDN-frontable surface and the control plane is not.
    stack = await startNativeSyncStack({
      env,
      createServer: (readPath) =>
        createSyncServer({
          registry: projectsSyncRegistry,
          db: serverDb.db,
          resolveAuthClaims: fixedTestClaims,
          readPath,
        }),
    });
    server = stack.server;
    batchWriteUrl = `${stack.controlPlaneUrl}/api/mutations`;

    await installPlpgsqlBatchFunction(server.drizzle, projectsSyncRegistry);
  });

  beforeEach(async () => {
    await server.drizzle.delete(projectsTable);
  });

  afterAll(async () => {
    await stack.stop();
    await serverDb.close();
  });

  it("syncs a non-demo registry into local typed access", async () => {
    const storePath = await createPersistentDataDir();

    try {
      const seededProject: CreateProjectInput = {
        id: "01965156-5884-7a0b-a24e-31b5c9be0001",
        name: "Client contract seed",
      };

      await server.drizzle.insert(projectsTable).values(seededProject);

      const client = await createSyncClient({
        registry: projectsSyncRegistry,
        controlPlaneUrl: stack.controlPlaneUrl,
        streamBaseUrl: stack.streamBaseUrl,
        batchWriteUrl,
        storePath,
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
      await rm(storePath, { recursive: true, force: true });
    }
  }, 30_000);

  it("persists synced data across client restart", async () => {
    const storePath = await createPersistentDataDir();

    try {
      const seededProject: CreateProjectInput = {
        id: "01965156-5884-7a0b-a24e-31b5c9be0002",
        name: "Restart proof",
      };

      await server.drizzle.insert(projectsTable).values(seededProject);

      const firstClient = await createSyncClient({
        registry: projectsSyncRegistry,
        controlPlaneUrl: stack.controlPlaneUrl,
        streamBaseUrl: stack.streamBaseUrl,
        batchWriteUrl,
        storePath,
      });

      try {
        await firstClient.ready;
        await waitFor(async () => {
          const rows = await firstClient.drizzle.select().from(projectsTable);
          expect(rows).toHaveLength(1);
        });
      } finally {
        // stop() halts sync + closes the handle but preserves the local store, so the
        // second client on the same storePath still sees the synced data (ADR-0005).
        await firstClient.stop();
      }

      const secondClient = await createSyncClient({
        registry: projectsSyncRegistry,
        controlPlaneUrl: stack.controlPlaneUrl,
        streamBaseUrl: stack.streamBaseUrl,
        batchWriteUrl,
        storePath,
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
      await rm(storePath, { recursive: true, force: true });
    }
  }, 30_000);

  it("writes through the public client facade and clears diagnostics after sync echo", async () => {
    const storePath = await createPersistentDataDir();

    try {
      const client = await createSyncClient({
        registry: projectsSyncRegistry,
        controlPlaneUrl: stack.controlPlaneUrl,
        streamBaseUrl: stack.streamBaseUrl,
        batchWriteUrl,
        storePath,
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
      await rm(storePath, { recursive: true, force: true });
    }
  }, 30_000);

  it("batches local facade mutations and clears diagnostics after sync echo", async () => {
    const storePath = await createPersistentDataDir();

    try {
      const client = await createSyncClient({
        registry: projectsSyncRegistry,
        controlPlaneUrl: stack.controlPlaneUrl,
        streamBaseUrl: stack.streamBaseUrl,
        batchWriteUrl,
        storePath,
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
      await rm(storePath, { recursive: true, force: true });
    }
  }, 30_000);

  it("rebuilds the read cache on a registry-version change and re-syncs (ADR-0006)", async () => {
    const storePath = await createPersistentDataDir();

    try {
      await server.drizzle.insert(projectsTable).values({
        id: "01965156-5884-7a0b-a24e-31b5c9be0006",
        name: "Upgrade survivor",
      });

      const firstClient = await createSyncClient({
        registry: projectsSyncRegistry,
        controlPlaneUrl: stack.controlPlaneUrl,
        streamBaseUrl: stack.streamBaseUrl,
        batchWriteUrl,
        storePath,
      });

      try {
        await firstClient.ready;
        await waitFor(async () => {
          const rows = await firstClient.drizzle.select().from(projectsTable);
          expect(rows).toHaveLength(1);
        });

        // Simulate a returning user whose store was provisioned under an older registry
        // fingerprint, with nothing owed locally (a clean drain).
        const meta = getLocalMetaTable(projectsSyncRegistry);
        await drizzleOver(firstClient.pglite as unknown as PGlite)
          .update(meta)
          .set({ value: "older-fingerprint" })
          .where(eq(meta.key, "registry_fingerprint"));
      } finally {
        await firstClient.stop();
      }

      const events: string[] = [];
      const secondClient = await createSyncClient({
        registry: projectsSyncRegistry,
        controlPlaneUrl: stack.controlPlaneUrl,
        streamBaseUrl: stack.streamBaseUrl,
        batchWriteUrl,
        storePath,
        onSchemaChange: (event) => {
          events.push(event.status);
        },
      });

      try {
        await secondClient.ready;

        // The fingerprint changed with nothing owed -> read cache rebuilt, then re-synced.
        expect(events).toEqual(["rebuilt"]);
        await waitFor(async () => {
          const rows = await secondClient.drizzle.select().from(projectsTable);
          expect(rows).toHaveLength(1);
          expect(rows[0]?.name).toBe("Upgrade survivor");
        });
      } finally {
        await secondClient.destroy({ force: true });
      }
    } finally {
      await rm(storePath, { recursive: true, force: true });
    }
  }, 30_000);

  it("auto-converges a write via the opt-in driver without a manual flush (ADR-0005)", async () => {
    const storePath = await createPersistentDataDir();

    try {
      const client = await createSyncClient({
        registry: projectsSyncRegistry,
        controlPlaneUrl: stack.controlPlaneUrl,
        streamBaseUrl: stack.streamBaseUrl,
        batchWriteUrl,
        storePath,
        // An interval trigger drives convergence deterministically (no DOM events needed).
        autoSync: createIntervalConvergenceTrigger(200),
      });

      try {
        await client.ready;

        await client.tables.projects.create({
          id: "01965156-5884-7a0b-a24e-31b5c9be0009",
          name: "Auto converged",
        });

        // No manual flush(): the driver flushes + reconciles on its own schedule.
        await waitFor(async () => {
          const remoteRows = await server.drizzle.select().from(projectsTable);
          expect(remoteRows).toHaveLength(1);
          expect(remoteRows[0]?.name).toBe("Auto converged");

          const diagnostics = await client.diagnostics();
          expect(diagnostics.mutation.pendingCount).toBe(0);
        });
      } finally {
        await client.destroy({ force: true });
      }
    } finally {
      await rm(storePath, { recursive: true, force: true });
    }
  }, 30_000);

  it("read path recovers from token expiry: surfaces auth-needed, then resumes on re-auth without a restart (ADR-0013)", async () => {
    const storePath = await createPersistentDataDir();
    // A real session gated behind an auth proxy: only a valid Bearer token reaches the control
    // plane; anything else 401s — exactly the JWT-expiry case a boot-time token freeze wedged.
    const VALID_TOKEN = "valid-session-token";
    let currentToken = "expired-token"; // invalid at boot → subscribe 401s

    // The gate sits in front of the CONTROL PLANE, and only there, because that is the only surface
    // the subject's own JWT ever reaches on the native path (ADR-0055): stream reads carry the
    // minted stream token instead, and the edge checks that. So an expired session presents as a
    // failing subscribe, not as a failing read.
    const authGate = Bun.serve({
      port: 0,
      idleTimeout: 0,
      fetch: (request) => {
        if (request.headers.get("Authorization") !== `Bearer ${VALID_TOKEN}`) {
          return new Response(JSON.stringify({ message: "token expired" }), {
            status: 401,
            headers: { "content-type": "application/json" },
          });
        }
        return server.fetch(request);
      },
    });
    const gatedControlPlaneUrl = `http://127.0.0.1:${authGate.port}`;

    try {
      await server.drizzle.insert(projectsTable).values({
        id: "01965156-5884-7a0b-a24e-31b5c9be000a",
        name: "Visible after re-auth",
      });

      const phases: string[] = [];
      const client = await createSyncClient({
        registry: projectsSyncRegistry,
        controlPlaneUrl: gatedControlPlaneUrl,
        streamBaseUrl: stack.streamBaseUrl,
        batchWriteUrl,
        storePath,
        // Per-request token (ADR-0013): consulted fresh on every shape fetch and every retry.
        getAuthToken: async () => currentToken,
        onStatusChange: (status) => phases.push(status.phase),
      });

      try {
        // While the token is dead subscribe 401s every retry; it must NOT stop — it surfaces a
        // distinct auth-needed status (prompt re-login) and keeps retrying forever with backoff.
        await waitFor(async () => {
          expect(client.status.phase).toBe("auth-needed");
        });

        // Re-authenticate: the next per-request Authorization header resolves the valid token, the
        // gate forwards, and sync resumes — with NO client restart and no manual re-subscribe.
        currentToken = VALID_TOKEN;

        await waitFor(async () => {
          const rows = await client.drizzle.select().from(projectsTable);
          expect(rows).toHaveLength(1);
          expect(rows[0]?.name).toBe("Visible after re-auth");
        });

        expect(client.status.phase).toBe("ready");
        // The status channel saw the distinct auth-needed indication and then cleared it on resume.
        expect(phases).toContain("auth-needed");
        expect(phases.at(-1)).toBe("ready");
      } finally {
        await client.destroy({ force: true });
      }
    } finally {
      await authGate.stop(true);
      await rm(storePath, { recursive: true, force: true });
    }
  }, 30_000);

  it("destroy() refuses while writes are owed, and force-wipes (ADR-0005)", async () => {
    const storePath = await createPersistentDataDir();

    try {
      const client = await createSyncClient({
        registry: projectsSyncRegistry,
        controlPlaneUrl: stack.controlPlaneUrl,
        streamBaseUrl: stack.streamBaseUrl,
        batchWriteUrl,
        storePath,
      });

      await client.ready;

      // An un-flushed write is owed to the server; destroy() must refuse to drop it.
      await client.tables.projects.create({
        id: "01965156-5884-7a0b-a24e-31b5c9be0008",
        name: "Owed write",
      });

      let refusal: Error | null = null;
      try {
        await client.destroy();
      } catch (error) {
        refusal = error as Error;
      }

      expect(refusal?.message).toMatch(/still owed/);
      expect((await client.diagnostics()).mutation.pendingCount).toBe(1);

      // force wipes regardless and closes the handle.
      await client.destroy({ force: true });
    } finally {
      await rm(storePath, { recursive: true, force: true });
    }
  }, 30_000);

  // The genuine end-to-end of the pessimistic write path (ADR-0022): a REAL public
  // `client.transaction({ mode: "pessimistic" })` against the REAL `createSyncServer` over HTTP. The
  // client routing (`flushUnit` → `/api/mutations/unit`) and the server's authoritative route are otherwise
  // tested in SEPARATE halves (the `pessimistic-flush` unit test mocks the server; `write-api`
  // integration posts hand-built bodies). Neither half can see the *contract* between them — the URL
  // path, the request body shape (`{ writeUnit, mutations }`), the ack shape. This closes that gap:
  // the two halves only stay in agreement because this test exercises them as one.
  it("a pessimistic transaction routes through the real authoritative endpoint and applies it (ADR-0022 e2e)", async () => {
    const storePath = await createPersistentDataDir();

    try {
      // syncEnabled:false isolates the WRITE contract from the read stream — the pessimistic flush is a
      // foreground server round-trip, so no Electric timing is involved and the assertions are exact.
      const client = await createSyncClient({
        registry: projectsSyncRegistry,
        controlPlaneUrl: stack.controlPlaneUrl,
        streamBaseUrl: stack.streamBaseUrl,
        batchWriteUrl,
        storePath,
        syncEnabled: false,
      });

      try {
        const projectId = "01965156-5884-7a0b-a24e-31b5c9be00b1";
        // The whole public surface: a real transaction block. Its unit flush-routes to the authoritative
        // endpoint and the call resolves only once the server has decided.
        const result = await client.transaction({ mode: "pessimistic" }, (tx) => {
          tx.tables.projects.create({ id: projectId, name: "Pessimistic e2e" });
        });

        // The contract no half-test can prove: the client built `/api/mutations/unit`, the server's
        // authoritative route accepted that body, applied it, and returned an ack the client parsed.
        expect(result.acks).toHaveLength(1);
        expect(result.acks[0]?.status).toBe("acked");
        expect(result.acks[0]?.serverUpdatedAtUs).toMatch(/^[0-9]+$/);

        // The write really landed in the authoritative (server) database.
        const remoteRows = await server.drizzle.select().from(projectsTable).where(eq(projectsTable.id, projectId));
        expect(remoteRows).toHaveLength(1);
        expect(remoteRows[0]?.name).toBe("Pessimistic e2e");

        // The client journal settled with nothing left owed (the `acked` row is retained until the read
        // echo, which is disabled here — so we assert the owed counters, not `ackedCount`).
        const diagnostics = await client.diagnostics();
        expect(diagnostics.mutation.pendingCount).toBe(0);
        expect(diagnostics.mutation.sendingCount).toBe(0);
        expect(diagnostics.mutation.failedCount).toBe(0);
      } finally {
        await client.destroy({ force: true });
      }
    } finally {
      await rm(storePath, { recursive: true, force: true });
    }
  }, 30_000);

  it("a pessimistic transaction surfaces a SANITISED server rejection and auto-discards the overlay (ADR-0022 §4 e2e)", async () => {
    const storePath = await createPersistentDataDir();

    try {
      const projectId = "01965156-5884-7a0b-a24e-31b5c9be00b2";
      // Pre-seed the row on the AUTHORITATIVE server so the client's create collides on the primary key —
      // a DB-enforced invariant the offline client cannot evaluate locally. With the read stream disabled
      // the client never learns of this row, so it issues an honest optimistic create that the server alone
      // can decline.
      await server.drizzle.insert(projectsTable).values({ id: projectId, name: "Already there" });

      const rejected: MutationDetail[] = [];
      const client = await createSyncClient({
        registry: projectsSyncRegistry,
        controlPlaneUrl: stack.controlPlaneUrl,
        streamBaseUrl: stack.streamBaseUrl,
        batchWriteUrl,
        storePath,
        syncEnabled: false,
        onReject: (details) => {
          rejected.push(...details);
        },
      });

      try {
        const result = await client.transaction({ mode: "pessimistic" }, (tx) => {
          tx.tables.projects.create({ id: projectId, name: "Colliding create" });
        });

        expect(result.acks).toHaveLength(1);
        expect(result.acks[0]?.status).toBe("rejected");
        // The contract: the rejection reason is sanitised at the SERVER before it crosses the wire, so no
        // raw DB internals (constraint name, the offending key value/PII) ever reach the client.
        const reason = result.acks[0]?.rejectionReason ?? "";
        expect(reason.length).toBeGreaterThan(0);
        expect(reason).not.toContain("constraint");
        expect(reason).not.toContain("duplicate key");
        expect(reason).not.toContain(projectId);

        // ADR-0022 §4: the optimistic overlay was auto-discarded for the whole unit, and `onReject` fired.
        expect(rejected).toHaveLength(1);
        expect(rejected[0]?.status).toBe("rejected");
        const overlayTable = getOverlayTable(projectsSyncRegistry, "projects");
        const overlay = await drizzleOver(client.pglite as unknown as PGlite)
          .select({ c: count() })
          .from(overlayTable)
          .where(eq(overlayTable["id"]!, projectId));
        expect(overlay[0]?.c).toBe(0);

        // The unit rolled back: the authoritative row is untouched.
        const remoteRows = await server.drizzle.select().from(projectsTable).where(eq(projectsTable.id, projectId));
        expect(remoteRows).toHaveLength(1);
        expect(remoteRows[0]?.name).toBe("Already there");
      } finally {
        await client.destroy({ force: true });
      }
    } finally {
      await rm(storePath, { recursive: true, force: true });
    }
  }, 30_000);
});
