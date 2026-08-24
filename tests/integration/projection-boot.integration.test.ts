import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";

import { count, eq } from "drizzle-orm";

import { asReadonly, defineReadProjection, defineSyncRegistry, type JwtClaims } from "@pgxsinkit/contracts";
import {
  projectionKeyRowsSyncRegistry,
  projectionKeyRowsTable,
  projectsSyncRegistry,
  projectsTable,
} from "@pgxsinkit/schema";
import { createSyncServer } from "@pgxsinkit/server";
import {
  createServerDb,
  readIntegrationEnv,
  startNativeSyncStack,
  waitFor,
  type NativeSyncStack,
} from "@pgxsinkit/test-utils";

import { startCircuitsSync } from "../../packages/client/src/circuits/group-sync";
import { getSyncedLocalTable } from "../../packages/client/src/local-tables";
import { generateLocalSchemaSql } from "../../packages/client/src/schema";
import { DEFAULT_METADATA_SCHEMA } from "../../packages/client/src/sync/metadata-tables";
import { createCircuitsTestPGlite } from "../support/circuits-pglite";
import { drizzleOver } from "../support/drizzle";

// Class guard for the two entry-transform drops fixed in this change (asReadonly / defineReadProjection
// dropping `makeColumns`). Since ADR-0029 P1 the client derives EVERY synced-table object from that
// factory (resolveApplyTarget → getSyncedLocalTable → projectedColumnBuilders), so a member-style client
// booting over a projected entry that lost the factory dies at subscribe time — exactly the board demo's
// member-login failure. This boots the real sync engine over a registry that contains BOTH transform
// outputs and asserts it syncs rows for each; it red-lines on either drop.
//
// It reuses the DEMO `projects` physical table the harness already provisions (`bun run db:migrate` over
// packages/schema/src/integration.ts), rather than the board schema stack: one authoritative writable
// entry (`projectsSyncRegistry.projects`) is consumed two ways — `asReadonly` (a member's read-only view)
// and `defineReadProjection` (a narrower column subset over the same physical rows) — so both transforms
// are exercised against one seeded table with no read filter (all rows stream to any authenticated sub).

const env = readIntegrationEnv();

const AUTH_SUB = "b0a7c0de-0000-4000-8000-0000000000f1";

// The authoritative writable entry (built by defineSyncTable, so it carries the column factory).
const projectsOwner = projectsSyncRegistry.projects;

// A member-style registry: the SAME physical `projects` table consumed through both entry transforms.
// `projects` = the whole row, read-only (asReadonly); `projects_summary` = a column subset over the same
// rows (defineReadProjection). Distinct local identities, one physical table — the shape of a per-client
// projection registry, minus the board stack.
const memberProjectionRegistry = defineSyncRegistry({
  projects: asReadonly(projectsOwner),
  projects_summary: defineReadProjection(projectsOwner, { as: "projects_summary", columns: ["name"] }),
});

const localSchemaSql = generateLocalSchemaSql(memberProjectionRegistry);

const PROJECT_ONE = "c1000000-0000-4000-8000-000000000001";
const PROJECT_TWO = "c1000000-0000-4000-8000-000000000002";

async function createLocalStore() {
  const pg = await createCircuitsTestPGlite();
  await pg.exec(localSchemaSql);
  return pg;
}

async function startClient(
  pg: Awaited<ReturnType<typeof createLocalStore>>,
  urls: Pick<NativeSyncStack<unknown>, "controlPlaneUrl" | "streamBaseUrl">,
) {
  let markDone: (() => void) | null = null;
  const initialSyncDone = new Promise<void>((resolve) => {
    markDone = resolve;
  });

  // The engine resolves an ApplyTarget for EVERY table in `memberProjectionRegistry` at subscribe time —
  // getSyncedLocalTable(registry, "projects") for the asReadonly entry and getSyncedLocalTable(registry,
  // "projects_summary") for the read projection. If either lost its column factory, this throws here.
  const sync = await startCircuitsSync(pg, {
    registry: memberProjectionRegistry,
    controlPlaneUrl: urls.controlPlaneUrl,
    streamBaseUrl: urls.streamBaseUrl,
    metadataSchema: DEFAULT_METADATA_SCHEMA,
    onInitialSync: () => {
      markDone?.();
      markDone = null;
    },
  });

  return { sync, initialSyncDone };
}

describe("member-style client boot over asReadonly + defineReadProjection entries (ADR-0029 P1 regression)", () => {
  let stack!: NativeSyncStack<ReturnType<typeof createSyncServer<typeof memberProjectionRegistry>>>;
  let server!: ReturnType<typeof createSyncServer<typeof memberProjectionRegistry>>;
  const serverDb = createServerDb(memberProjectionRegistry, env.databaseUrl);

  beforeAll(async () => {
    // Read-only registry (both entries are readonly/projection), so no apply-function install is needed —
    // this exercises the read/boot path only. A fixed authenticated claim satisfies the auth adapter
    // (neither entry declares a customPredicate, so the subject only names the stream token's bearer).
    stack = await startNativeSyncStack({
      env,
      registry: memberProjectionRegistry,
      createServer: (readPath) =>
        createSyncServer({
          registry: memberProjectionRegistry,
          db: serverDb.db,
          resolveAuthClaims: (): JwtClaims => ({ role: "authenticated", sub: AUTH_SUB }),
          readPath,
        }),
    });
    server = stack.server;
  });

  beforeEach(async () => {
    await server.drizzle.delete(projectsTable);
    await server.drizzle.insert(projectsTable).values([
      { id: PROJECT_ONE, name: "Aurora" },
      { id: PROJECT_TWO, name: "Borealis" },
    ]);
  });

  afterAll(async () => {
    await stack.stop();
    await serverDb.close();
  });

  it("boots the engine and syncs rows for both the readonly and the projection entry", async () => {
    const pg = await createLocalStore();
    const { sync, initialSyncDone } = await startClient(pg, stack);

    try {
      // Reaching here already proves the boot survived resolveApplyTarget → getSyncedLocalTable for both
      // transform outputs (the throw that killed member login happened before initial sync could complete).
      await initialSyncDone;

      const localDb = drizzleOver(pg);
      // Query each entry's OWN local synced cache — the object getSyncedLocalTable derives from the
      // (now-preserved) column factory. Both must hydrate the two seeded rows.
      const readonlyProjects = getSyncedLocalTable(memberProjectionRegistry, "projects");
      const projectionSummary = getSyncedLocalTable(memberProjectionRegistry, "projects_summary");

      await waitFor(async () => {
        const readonlyRows = await localDb.select({ count: count() }).from(readonlyProjects);
        expect(readonlyRows[0]?.count).toBe(2);

        const summaryRows = await localDb.select({ count: count() }).from(projectionSummary);
        expect(summaryRows[0]?.count).toBe(2);
      });
    } finally {
      sync.unsubscribe();
      await pg.close();
    }
  }, 30_000);
});

// `clientProjection.omitColumns` may remove a server PK component only when `localPrimaryKey`
// deliberately narrows identity and the row predicate pins every removed component. This is the
// userday-shaped case: server identity `(id, owner_id)`, client identity `(id)`, owner omitted.
//
// The full lifecycle matters. A backfill/upsert must not leak `owner_id` into the projected local
// row, while a body-less delete must translate the engine's server identity to the local identity.
// A projection-only assertion would miss the latter and leave stale rows behind.
describe("client projection with a predicate-pinned composite server key", () => {
  const OWNER_SUB = "b0a7c0de-0000-4000-8000-0000000000f2";
  const OTHER_OWNER = "b0a7c0de-0000-4000-8000-0000000000f3";
  const SEEDED_ID = "c2000000-0000-4000-8000-000000000001";
  const LIVE_ID = "c2000000-0000-4000-8000-000000000002";

  let stack!: NativeSyncStack<ReturnType<typeof createSyncServer<typeof projectionKeyRowsSyncRegistry>>>;
  let server!: ReturnType<typeof createSyncServer<typeof projectionKeyRowsSyncRegistry>>;
  const serverDb = createServerDb(projectionKeyRowsSyncRegistry, env.databaseUrl);
  const projectedLocalSchemaSql = generateLocalSchemaSql(projectionKeyRowsSyncRegistry);

  beforeAll(async () => {
    stack = await startNativeSyncStack({
      env,
      registry: projectionKeyRowsSyncRegistry,
      createServer: (readPath) =>
        createSyncServer({
          registry: projectionKeyRowsSyncRegistry,
          db: serverDb.db,
          resolveAuthClaims: (): JwtClaims => ({ role: "authenticated", sub: OWNER_SUB }),
          readPath,
        }),
    });
    server = stack.server;
  });

  beforeEach(async () => {
    await server.drizzle.delete(projectionKeyRowsTable);
    await server.drizzle.insert(projectionKeyRowsTable).values([
      { id: SEEDED_ID, ownerId: OWNER_SUB, value: "seeded-visible" },
      // The same narrowed local key may exist under another owner because owner_id is part of the
      // server PK. Predicate pinning is what makes only one of them enter this subject's shape.
      { id: SEEDED_ID, ownerId: OTHER_OWNER, value: "seeded-hidden" },
    ]);
  });

  afterAll(async () => {
    await stack.stop();
    await serverDb.close();
  });

  it("syncs projected backfill and live upserts, then deletes by the narrowed local key", async () => {
    const pg = await createCircuitsTestPGlite();
    await pg.exec(projectedLocalSchemaSql);

    let rejectOnSyncError: ((error: Error) => void) | null = null;
    const syncError = new Promise<never>((_resolve, reject) => {
      rejectOnSyncError = reject;
    });
    let markInitialSyncDone: (() => void) | null = null;
    const initialSyncDone = new Promise<void>((resolve) => {
      markInitialSyncDone = resolve;
    });

    const sync = await startCircuitsSync(pg, {
      registry: projectionKeyRowsSyncRegistry,
      controlPlaneUrl: stack.controlPlaneUrl,
      streamBaseUrl: stack.streamBaseUrl,
      metadataSchema: DEFAULT_METADATA_SCHEMA,
      onInitialSync: () => {
        markInitialSyncDone?.();
        markInitialSyncDone = null;
      },
      onSyncError: (error) => rejectOnSyncError?.(error),
    });

    const localDb = drizzleOver(pg);
    const localRows = getSyncedLocalTable(projectionKeyRowsSyncRegistry, "projection_key_rows");
    const waitWithoutSyncError = (assertion: () => Promise<void>) => Promise.race([waitFor(assertion), syncError]);

    try {
      await Promise.race([initialSyncDone, syncError]);

      await waitWithoutSyncError(async () => {
        const rows = await localDb.select().from(localRows);
        expect(rows).toEqual([{ id: SEEDED_ID, value: "seeded-visible" }]);
      });

      await server.drizzle
        .insert(projectionKeyRowsTable)
        .values({ id: LIVE_ID, ownerId: OWNER_SUB, value: "live-created" });

      await waitWithoutSyncError(async () => {
        const rows = await localDb.select().from(localRows).where(eq(localRows.id, LIVE_ID));
        expect(rows).toEqual([{ id: LIVE_ID, value: "live-created" }]);
      });

      await server.drizzle
        .update(projectionKeyRowsTable)
        .set({ value: "live-updated" })
        .where(eq(projectionKeyRowsTable.id, LIVE_ID));

      await waitWithoutSyncError(async () => {
        const rows = await localDb.select().from(localRows).where(eq(localRows.id, LIVE_ID));
        expect(rows).toEqual([{ id: LIVE_ID, value: "live-updated" }]);
      });

      await server.drizzle.delete(projectionKeyRowsTable).where(eq(projectionKeyRowsTable.id, LIVE_ID));

      await waitWithoutSyncError(async () => {
        const rows = await localDb.select().from(localRows).where(eq(localRows.id, LIVE_ID));
        expect(rows).toHaveLength(0);
      });
    } finally {
      rejectOnSyncError = null;
      sync.unsubscribe();
      await pg.close();
    }
  }, 30_000);
});
