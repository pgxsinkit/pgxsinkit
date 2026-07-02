import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { count, eq, getColumns, inArray, max, sql } from "drizzle-orm";
import { drizzle as bunDrizzle } from "drizzle-orm/bun-sql";
import type { AnyPgTable, PgAsyncDatabase, PgColumn, PgQueryResultHKT, PgView } from "drizzle-orm/pg-core";

import {
  createSyncClient,
  getOverlayTable,
  getReadModelView,
  getSyncedLocalTable,
  type MutationBatchItem,
} from "@pgxsinkit/client";
import type { RegistryRelations, SyncTableRegistry } from "@pgxsinkit/contracts";
import {
  DEMO_JWT_USER1,
  DEMO_JWT_USER10,
  DEMO_JWT_USER11,
  DEMO_JWT_USER12,
  DEMO_JWT_USER13,
  DEMO_JWT_USER14,
  DEMO_JWT_USER15,
  DEMO_JWT_USER16,
  DEMO_JWT_USER17,
  DEMO_JWT_USER18,
  DEMO_JWT_USER19,
  DEMO_JWT_USER2,
  DEMO_JWT_USER20,
  DEMO_JWT_USER21,
  DEMO_JWT_USER22,
  DEMO_JWT_USER23,
  DEMO_JWT_USER24,
  DEMO_JWT_USER25,
  DEMO_JWT_USER3,
  DEMO_JWT_USER4,
  DEMO_JWT_USER5,
  DEMO_JWT_USER6,
  DEMO_JWT_USER7,
  DEMO_JWT_USER8,
  DEMO_JWT_USER9,
  DEMO_USER1_ID,
  DEMO_USER10_ID,
  DEMO_USER11_ID,
  DEMO_USER12_ID,
  DEMO_USER13_ID,
  DEMO_USER14_ID,
  DEMO_USER15_ID,
  DEMO_USER16_ID,
  DEMO_USER17_ID,
  DEMO_USER18_ID,
  DEMO_USER19_ID,
  DEMO_USER2_ID,
  DEMO_USER20_ID,
  DEMO_USER21_ID,
  DEMO_USER22_ID,
  DEMO_USER23_ID,
  DEMO_USER24_ID,
  DEMO_USER25_ID,
  DEMO_USER3_ID,
  DEMO_USER4_ID,
  DEMO_USER5_ID,
  DEMO_USER6_ID,
  DEMO_USER7_ID,
  DEMO_USER8_ID,
  DEMO_USER9_ID,
  buildSyntheticCreatePayload,
  buildSyntheticGovernanceSql,
  buildSyntheticRegistry,
  buildSyntheticServerSchemaSql,
  buildSyntheticUpdatePatch,
} from "@pgxsinkit/schema";
import { createSyncServer } from "@pgxsinkit/server";
import { createServerDb, readIntegrationEnv, waitFor } from "@pgxsinkit/test-utils";

import { parseDemoAuthClaimsFromRequest } from "../../../apps/write-api/src/demo-auth";
import {
  installPlpgsqlBatchFunction,
  verifyPlpgsqlBatchFunction,
} from "../../../packages/server/src/mutations/plpgsql-apply";
import {
  applyConcurrentMutationToRowPool,
  buildConcurrentMutationPlan,
  commitConcurrentBatchRowPools,
  createConcurrentRowPool,
  mergeConcurrentRowPools,
  pickConcurrentMutationKind,
  reserveConcurrentDeletedEntities,
  resolveConcurrentMutationMix,
  type ConcurrentMutationKind,
  type ConcurrentRowPool,
} from "./concurrent-mutation-mix";
import { selectRowExpectationsForVerification, type RowPresenceExpectation } from "./row-expectations";
import { computePercentiles, type ConcurrentPerfScenarioKey, type PerfScenarioConfig } from "./scenario";

interface DemoPerfUser {
  key: string;
  userId: string;
  token: string;
  userIndex: number;
}

interface ConcurrentClientHandle {
  key: string;
  clientIndex: number;
  assignment: DemoPerfUser;
  dataDir: string;
  client: Awaited<ReturnType<typeof createSyncClient<typeof registryPlaceholder>>>;
  sharedRowPoolState: SharedConcurrentRowPoolState;
  localRowPool: ConcurrentRowPool;
  nextCreateSequence: number;
  enqueueTimingsMs: number[];
  flushTimingsMs: number[];
  convergenceTimingsMs: number[];
  batchSizeHistogram: Record<string, number>;
  operations: number;
  mutations: number;
  createMutations: number;
  updateMutations: number;
  deleteMutations: number;
  acknowledgedMutations: number;
  failedFlushCount: number;
  retryCount: number;
  mutationFallbackCount: number;
  skippedDeleteCount: number;
}

interface ConcurrentClientDiagnostics {
  clientKey: string;
  authKey: string;
  mutation: Awaited<ReturnType<ConcurrentClientHandle["client"]["diagnostics"]>>["mutation"];
}

interface SharedConcurrentRowPoolState {
  rowPool: ConcurrentRowPool;
  planningQueue: Promise<void>;
}

interface ConcurrentMutationRequest {
  desiredKind: ConcurrentMutationKind;
  mutationIndex: number;
  tableIndex: number;
  selectionSequence: number;
}

interface ConcurrentBatchPlanResult {
  batchItems: Array<MutationBatchItem<typeof registryPlaceholder>>;
  batchExpectations: RowPresenceExpectation[];
  batchCreatedEntities: Array<{ tableIndex: number; entityId: string }>;
  batchDeletedEntities: Array<{ tableIndex: number; entityId: string }>;
  batchCounts: {
    create: number;
    update: number;
    delete: number;
    fallbacks: number;
    skippedDeletes: number;
  };
}

interface ConcurrentWorkerPlanRequest {
  assignmentKey: string;
  clientIndex: number;
  userIndex: number;
  operationIndex: number;
  nextCreateSequence: number;
  localRowPool: ConcurrentRowPool;
  mutationRequests: ConcurrentMutationRequest[];
}

interface ConcurrentWorkerCommitRequest {
  assignmentKey: string;
  createdEntities: Array<{ tableIndex: number; entityId: string }>;
  deletedEntities: Array<{ tableIndex: number; entityId: string }>;
}

interface ConcurrentMixedLoadWorkerInput {
  assignment: DemoPerfUser;
  clientIndex: number;
  config: PerfScenarioConfig;
  coordinatorUrl: string;
  dataDir: string;
  writeUrl: string;
}

interface ConcurrentMixedLoadWorkerResult {
  batchSizeHistogram: Record<string, number>;
  convergenceTimingsMs: number[];
  enqueueTimingsMs: number[];
  finalDiagnostic: ConcurrentClientDiagnostics;
  flushTimingsMs: number[];
  perClient: ConcurrentClientSummary;
}

export interface ConcurrentClientSummary {
  clientKey: string;
  authKey: string;
  operations: number;
  mutations: number;
  createMutations: number;
  updateMutations: number;
  deleteMutations: number;
  failedFlushCount: number;
  retryCount: number;
  mutationFallbackCount: number;
  skippedDeleteCount: number;
  enqueueLatencyMs: ReturnType<typeof computePercentiles>;
  flushLatencyMs: ReturnType<typeof computePercentiles>;
  convergenceLatencyMs: ReturnType<typeof computePercentiles>;
}

export interface ConcurrentScenarioRunResult {
  scenarioKey: ConcurrentPerfScenarioKey;
  concurrentPreset: PerfScenarioConfig["concurrentPreset"];
  registryTableNames: string[];
  durationMs: number;
  totalOperations: number;
  totalMutations: number;
  createMutations: number;
  updateMutations: number;
  deleteMutations: number;
  completedFlushes: number;
  acknowledgedMutations: number;
  failedFlushCount: number;
  retryCount: number;
  mutationFallbackCount: number;
  skippedDeleteCount: number;
  nonConvergedClientCount: number;
  enqueueTimingsMs: number[];
  flushTimingsMs: number[];
  convergenceTimingsMs: number[];
  batchSizeHistogram: Record<string, number>;
  perClient: ConcurrentClientSummary[];
  finalDiagnostics: ConcurrentClientDiagnostics[];
}

const env = readIntegrationEnv();
const demoUsers: readonly Omit<DemoPerfUser, "userIndex">[] = [
  {
    key: "user1",
    userId: DEMO_USER1_ID,
    token: DEMO_JWT_USER1,
  },
  {
    key: "user2",
    userId: DEMO_USER2_ID,
    token: DEMO_JWT_USER2,
  },
  {
    key: "user3",
    userId: DEMO_USER3_ID,
    token: DEMO_JWT_USER3,
  },
  {
    key: "user4",
    userId: DEMO_USER4_ID,
    token: DEMO_JWT_USER4,
  },
  {
    key: "user5",
    userId: DEMO_USER5_ID,
    token: DEMO_JWT_USER5,
  },
  {
    key: "user6",
    userId: DEMO_USER6_ID,
    token: DEMO_JWT_USER6,
  },
  {
    key: "user7",
    userId: DEMO_USER7_ID,
    token: DEMO_JWT_USER7,
  },
  {
    key: "user8",
    userId: DEMO_USER8_ID,
    token: DEMO_JWT_USER8,
  },
  {
    key: "user9",
    userId: DEMO_USER9_ID,
    token: DEMO_JWT_USER9,
  },
  {
    key: "user10",
    userId: DEMO_USER10_ID,
    token: DEMO_JWT_USER10,
  },
  {
    key: "user11",
    userId: DEMO_USER11_ID,
    token: DEMO_JWT_USER11,
  },
  {
    key: "user12",
    userId: DEMO_USER12_ID,
    token: DEMO_JWT_USER12,
  },
  {
    key: "user13",
    userId: DEMO_USER13_ID,
    token: DEMO_JWT_USER13,
  },
  {
    key: "user14",
    userId: DEMO_USER14_ID,
    token: DEMO_JWT_USER14,
  },
  {
    key: "user15",
    userId: DEMO_USER15_ID,
    token: DEMO_JWT_USER15,
  },
  {
    key: "user16",
    userId: DEMO_USER16_ID,
    token: DEMO_JWT_USER16,
  },
  {
    key: "user17",
    userId: DEMO_USER17_ID,
    token: DEMO_JWT_USER17,
  },
  {
    key: "user18",
    userId: DEMO_USER18_ID,
    token: DEMO_JWT_USER18,
  },
  {
    key: "user19",
    userId: DEMO_USER19_ID,
    token: DEMO_JWT_USER19,
  },
  {
    key: "user20",
    userId: DEMO_USER20_ID,
    token: DEMO_JWT_USER20,
  },
  {
    key: "user21",
    userId: DEMO_USER21_ID,
    token: DEMO_JWT_USER21,
  },
  {
    key: "user22",
    userId: DEMO_USER22_ID,
    token: DEMO_JWT_USER22,
  },
  {
    key: "user23",
    userId: DEMO_USER23_ID,
    token: DEMO_JWT_USER23,
  },
  {
    key: "user24",
    userId: DEMO_USER24_ID,
    token: DEMO_JWT_USER24,
  },
  {
    key: "user25",
    userId: DEMO_USER25_ID,
    token: DEMO_JWT_USER25,
  },
];

const registryPlaceholder = buildSyntheticRegistry({
  tableCount: 1,
  extraColumnCount: 1,
}).registry;

export async function runConcurrentMixedLoadScenario(config: PerfScenarioConfig): Promise<ConcurrentScenarioRunResult> {
  if (config.executionMode === "multi-process") {
    return runConcurrentMixedLoadScenarioMultiProcess(config);
  }

  return runConcurrentMixedLoadScenarioSingleProcess(config);
}

async function runConcurrentMixedLoadScenarioSingleProcess(
  config: PerfScenarioConfig,
): Promise<ConcurrentScenarioRunResult> {
  const users = resolveDemoUsers(config.distinctUsers);
  const { registry, tableNames } = buildSyntheticRegistry({
    tableCount: Math.max(1, config.tableCount),
    extraColumnCount: config.extraColumnCount,
  });

  let server: ReturnType<typeof createSyncServer<typeof registry>> | undefined;
  let httpServer: Server | undefined;
  const dataDirs: string[] = [];
  const clientHandles: Array<
    ConcurrentClientHandle & { client: Awaited<ReturnType<typeof createSyncClient<typeof registry>>> }
  > = [];
  const sharedRowPoolsByUser = new Map<string, SharedConcurrentRowPoolState>();
  const serverDb = createServerDb(registry, env.databaseUrl);

  try {
    const provisioningServer = createSyncServer({
      registry,
      db: serverDb.db,
    });

    try {
      await provisioningServer.drizzle.execute(sql.raw(buildSyntheticServerSchemaSql(registry)));
      await provisioningServer.drizzle.execute(sql.raw(buildSyntheticGovernanceSql(registry)));
      await installPlpgsqlBatchFunction(provisioningServer.drizzle, registry);
      await verifyPlpgsqlBatchFunction(provisioningServer.drizzle, registry);
      await seedSyntheticRows(
        registry,
        tableNames,
        config.seedRowsPerTable,
        config.extraColumnCount,
        users,
        provisioningServer.drizzle,
      );
    } finally {
      await provisioningServer.stop();
    }

    server = createSyncServer({
      registry,
      db: serverDb.db,
      resolveAuthClaims: (request) => {
        const claims = parseDemoAuthClaimsFromRequest(request);
        return claims ? { ...claims } : null;
      },
    });

    const startedFetchServer = await startFetchServer(server.fetch, 0);
    httpServer = startedFetchServer.server;
    const writeUrl = `http://127.0.0.1:${startedFetchServer.port}`;

    for (let clientIndex = 0; clientIndex < config.concurrentClients; clientIndex += 1) {
      const assignment = users[clientIndex % users.length]!;
      const ownedRowCount = countOwnedRows(config.seedRowsPerTable, assignment.userIndex, users.length);
      const rowPoolSize = resolveRowPoolSize(config, ownedRowCount);
      const dataDir = await createPersistentDataDir();
      dataDirs.push(dataDir);

      const client = await createSyncClient({
        registry,
        electricUrl: env.electricUrl,
        writeUrl,
        getAuthToken: async () => assignment.token,
        dataDir,
      });

      await client.ready;
      const expectedSyncedIdsByTable = buildExpectedSyncedIdsByTable(
        tableNames,
        rowPoolSize,
        assignment.userIndex,
        users.length,
        config.extraColumnCount,
      );
      await waitForSeedSync(registry, client, expectedSyncedIdsByTable);

      const sharedRowPoolState = sharedRowPoolsByUser.get(assignment.key) ?? {
        rowPool: createConcurrentRowPool(
          tableNames.map((tableName) => [...(expectedSyncedIdsByTable.get(tableName) ?? [])]),
        ),
        planningQueue: Promise.resolve(),
      };
      sharedRowPoolsByUser.set(assignment.key, sharedRowPoolState);

      clientHandles.push({
        key: `client-${clientIndex.toString().padStart(2, "0")}`,
        clientIndex,
        assignment,
        dataDir,
        client,
        sharedRowPoolState,
        localRowPool: createConcurrentRowPool(tableNames.map(() => [])),
        nextCreateSequence: 0,
        enqueueTimingsMs: [],
        flushTimingsMs: [],
        convergenceTimingsMs: [],
        batchSizeHistogram: {},
        operations: 0,
        mutations: 0,
        createMutations: 0,
        updateMutations: 0,
        deleteMutations: 0,
        acknowledgedMutations: 0,
        failedFlushCount: 0,
        retryCount: 0,
        mutationFallbackCount: 0,
        skippedDeleteCount: 0,
      });
    }

    const startedAtMs = performance.now();

    await Promise.all(
      clientHandles.map((handle) =>
        executeClientWorkload({
          handle,
          config,
          registry,
          tableNames,
          users,
        }),
      ),
    );

    const finalDiagnostics = await Promise.all(
      clientHandles.map(async (handle) => ({
        clientKey: handle.key,
        authKey: handle.assignment.key,
        mutation: (await handle.client.diagnostics()).mutation,
      })),
    );

    return buildRunResult(config, tableNames, performance.now() - startedAtMs, clientHandles, finalDiagnostics);
  } finally {
    await Promise.all(clientHandles.map((handle) => handle.client.stop()));
    await stopHttpServer(httpServer);
    await server?.stop();
    await serverDb.close();
    await Promise.all(dataDirs.map((dataDir) => rm(dataDir, { recursive: true, force: true })));
  }
}

async function runConcurrentMixedLoadScenarioMultiProcess(
  config: PerfScenarioConfig,
): Promise<ConcurrentScenarioRunResult> {
  const users = resolveDemoUsers(config.distinctUsers);
  const { registry, tableNames } = buildSyntheticRegistry({
    tableCount: Math.max(1, config.tableCount),
    extraColumnCount: config.extraColumnCount,
  });

  let server: ReturnType<typeof createSyncServer<typeof registry>> | undefined;
  let httpServer: Server | undefined;
  let coordinatorServer: Server | undefined;
  const dataDirs: string[] = [];
  const sharedRowPoolsByUser = new Map<string, SharedConcurrentRowPoolState>();
  const serverDb = createServerDb(registry, env.databaseUrl);

  try {
    const provisioningServer = createSyncServer({
      registry,
      db: serverDb.db,
    });

    try {
      await provisioningServer.drizzle.execute(sql.raw(buildSyntheticServerSchemaSql(registry)));
      await provisioningServer.drizzle.execute(sql.raw(buildSyntheticGovernanceSql(registry)));
      await installPlpgsqlBatchFunction(provisioningServer.drizzle, registry);
      await verifyPlpgsqlBatchFunction(provisioningServer.drizzle, registry);
      await seedSyntheticRows(
        registry,
        tableNames,
        config.seedRowsPerTable,
        config.extraColumnCount,
        users,
        provisioningServer.drizzle,
      );
    } finally {
      await provisioningServer.stop();
    }

    server = createSyncServer({
      registry,
      db: serverDb.db,
      resolveAuthClaims: (request) => {
        const claims = parseDemoAuthClaimsFromRequest(request);
        return claims ? { ...claims } : null;
      },
    });

    const startedFetchServer = await startFetchServer(server.fetch, 0);
    httpServer = startedFetchServer.server;
    const writeUrl = `http://127.0.0.1:${startedFetchServer.port}`;

    for (const assignment of users) {
      if (sharedRowPoolsByUser.has(assignment.key)) {
        continue;
      }

      const ownedRowCount = countOwnedRows(config.seedRowsPerTable, assignment.userIndex, users.length);
      const rowPoolSize = resolveRowPoolSize(config, ownedRowCount);
      const expectedSyncedIdsByTable = buildExpectedSyncedIdsByTable(
        tableNames,
        rowPoolSize,
        assignment.userIndex,
        users.length,
        config.extraColumnCount,
      );

      sharedRowPoolsByUser.set(assignment.key, {
        rowPool: createConcurrentRowPool(
          tableNames.map((tableName) => [...(expectedSyncedIdsByTable.get(tableName) ?? [])]),
        ),
        planningQueue: Promise.resolve(),
      });
    }

    const startedCoordinator = await startConcurrentCoordinatorServer({
      config,
      sharedRowPoolsByUser,
      tableNames,
    });
    coordinatorServer = startedCoordinator.server;
    const coordinatorUrl = `http://127.0.0.1:${startedCoordinator.port}`;

    const workerInputs: ConcurrentMixedLoadWorkerInput[] = [];

    for (let clientIndex = 0; clientIndex < config.concurrentClients; clientIndex += 1) {
      const assignment = users[clientIndex % users.length]!;
      const dataDir = await createPersistentDataDir();
      dataDirs.push(dataDir);
      workerInputs.push({
        assignment,
        clientIndex,
        config,
        coordinatorUrl,
        dataDir,
        writeUrl,
      });
    }

    const startedAtMs = performance.now();
    const workerSettledResults = await Promise.allSettled(
      workerInputs.map((input) => runConcurrentMixedLoadWorkerProcess(input)),
    );

    const rejectedWorkerResult = workerSettledResults.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );

    if (rejectedWorkerResult) {
      throw rejectedWorkerResult.reason;
    }

    const workerResults = workerSettledResults.map((result) => {
      if (result.status !== "fulfilled") {
        throw new Error("Expected concurrent worker result to be fulfilled");
      }

      return result.value;
    });

    return buildRunResultFromWorkerResults(config, tableNames, performance.now() - startedAtMs, workerResults);
  } finally {
    await stopHttpServer(coordinatorServer);
    await stopHttpServer(httpServer);
    await server?.stop();
    await serverDb.close();
    await Promise.all(dataDirs.map((dataDir) => rm(dataDir, { recursive: true, force: true })));
  }
}

async function runConcurrentMixedLoadWorkerProcess(input: ConcurrentMixedLoadWorkerInput) {
  const outputFile = join(input.dataDir, "worker-result.json");
  const encodedInput = Buffer.from(JSON.stringify(input), "utf8").toString("base64url");
  const workerFile = join(process.cwd(), "tests/performance/support/concurrent-mixed-load-worker.ts");

  await new Promise<void>((resolve, reject) => {
    const child = spawn("bun", [workerFile], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PGXSINKIT_PERF_WORKER_INPUT: encodedInput,
        PGXSINKIT_PERF_WORKER_OUTPUT_FILE: outputFile,
      },
      stdio: "inherit",
    });

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new Error(
          `Concurrent worker ${input.clientIndex} failed${signal ? ` (signal: ${signal})` : ""}${typeof code === "number" ? ` (exit code: ${code})` : ""}`,
        ),
      );
    });
  });

  const rawResult = await readFile(outputFile, "utf8");
  return JSON.parse(rawResult) as ConcurrentMixedLoadWorkerResult;
}

async function startConcurrentCoordinatorServer(options: {
  config: PerfScenarioConfig;
  sharedRowPoolsByUser: Map<string, SharedConcurrentRowPoolState>;
  tableNames: string[];
}) {
  const server = createServer((incoming, outgoing) => {
    void handleConcurrentCoordinatorRequest(incoming, outgoing, options);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();

  if (!address || typeof address === "string") {
    throw new Error("Expected concurrent coordinator to bind to a TCP port");
  }

  return {
    server,
    port: (address as AddressInfo).port,
  };
}

async function handleConcurrentCoordinatorRequest(
  incoming: IncomingMessage,
  outgoing: ServerResponse,
  options: {
    config: PerfScenarioConfig;
    sharedRowPoolsByUser: Map<string, SharedConcurrentRowPoolState>;
    tableNames: string[];
  },
) {
  try {
    const requestUrl = new URL(`http://127.0.0.1${incoming.url ?? "/"}`);
    const body = await readRequestJson(incoming);

    if (incoming.method === "POST" && requestUrl.pathname === "/plan") {
      const request = body as unknown as ConcurrentWorkerPlanRequest;
      const sharedRowPoolState = options.sharedRowPoolsByUser.get(request.assignmentKey);

      if (!sharedRowPoolState) {
        throw new Error(`Unknown coordinator user key: ${request.assignmentKey}`);
      }

      const plan = await withSharedRowPoolPlanningLock(sharedRowPoolState, async () =>
        buildConcurrentBatchPlan({
          config: options.config,
          localRowPool: request.localRowPool,
          mutationRequests: request.mutationRequests,
          nextCreateSequence: request.nextCreateSequence,
          operationIndex: request.operationIndex,
          reserveLocalDeletes: false,
          sharedRowPool: sharedRowPoolState.rowPool,
          tableNames: options.tableNames,
          clientIndex: request.clientIndex,
          userIndex: request.userIndex,
        }),
      );

      outgoing.statusCode = 200;
      outgoing.setHeader("content-type", "application/json");
      outgoing.end(JSON.stringify(plan));
      return;
    }

    if (incoming.method === "POST" && requestUrl.pathname === "/commit") {
      const request = body as unknown as ConcurrentWorkerCommitRequest;
      const sharedRowPoolState = options.sharedRowPoolsByUser.get(request.assignmentKey);

      if (!sharedRowPoolState) {
        throw new Error(`Unknown coordinator user key: ${request.assignmentKey}`);
      }

      commitConcurrentBatchRowPools({
        sharedRowPool: sharedRowPoolState.rowPool,
        localRowPool: createConcurrentRowPool(options.tableNames.map(() => [])),
        createdEntities: request.createdEntities,
        deletedEntities: request.deletedEntities,
      });

      outgoing.statusCode = 200;
      outgoing.setHeader("content-type", "application/json");
      outgoing.end(JSON.stringify({ ok: true }));
      return;
    }

    outgoing.statusCode = 404;
    outgoing.end();
  } catch (error) {
    outgoing.statusCode = 500;
    outgoing.setHeader("content-type", "application/json");
    outgoing.end(
      JSON.stringify({
        error: error instanceof Error ? error.message : "Unknown coordinator error",
      }),
    );
  }
}

async function readRequestJson(incoming: IncomingMessage) {
  const body = await readRequestBody(incoming);

  if (!body) {
    return {} as Record<string, unknown>;
  }

  return JSON.parse(body.toString("utf8")) as Record<string, unknown>;
}

function buildConcurrentBatchPlan(options: {
  config: PerfScenarioConfig;
  localRowPool: ConcurrentRowPool;
  mutationRequests: ConcurrentMutationRequest[];
  nextCreateSequence: number;
  operationIndex: number;
  reserveLocalDeletes: boolean;
  sharedRowPool: ConcurrentRowPool;
  tableNames: string[];
  clientIndex: number;
  userIndex: number;
}): ConcurrentBatchPlanResult {
  const {
    config,
    localRowPool,
    mutationRequests,
    nextCreateSequence,
    operationIndex,
    reserveLocalDeletes,
    sharedRowPool,
    tableNames,
    clientIndex,
  } = options;
  const plannedBatchItems: Array<MutationBatchItem<typeof registryPlaceholder>> = [];
  const batchRowPool = mergeConcurrentRowPools([sharedRowPool, localRowPool]);
  const plannedExpectations: RowPresenceExpectation[] = [];
  const plannedCreatedEntities: Array<{ tableIndex: number; entityId: string }> = [];
  const plannedDeletedEntities: Array<{ tableIndex: number; entityId: string }> = [];
  const plannedCounts = {
    create: 0,
    update: 0,
    delete: 0,
    fallbacks: 0,
    skippedDeletes: 0,
  };

  for (const request of mutationRequests) {
    const tableName = tableNames[request.tableIndex]!;
    const mutationPlan = buildConcurrentMutationPlan({
      desiredKind: request.desiredKind,
      tableIndex: request.tableIndex,
      selectionSequence: request.selectionSequence,
      rowPool: batchRowPool,
    });

    if (mutationPlan.fallbackApplied) {
      plannedCounts.fallbacks += 1;
    }

    if (mutationPlan.skippedDelete) {
      plannedCounts.skippedDeletes += 1;
    }

    if (mutationPlan.actualKind === "create") {
      const createOrdinal = nextCreateSequence + plannedCounts.create;
      const createRowIndex = buildCreateRowIndex(
        config.seedRowsPerTable,
        config.concurrentClients,
        clientIndex,
        createOrdinal,
      );
      const createInput = buildSyntheticCreatePayload(request.tableIndex, createRowIndex, config.extraColumnCount);
      const entityId = String(createInput.id);

      plannedBatchItems.push({
        table: tableName,
        kind: "create",
        input: createInput,
      } as MutationBatchItem<typeof registryPlaceholder>);
      applyConcurrentMutationToRowPool({
        rowPool: batchRowPool,
        tableIndex: request.tableIndex,
        mutationKind: "create",
        entityId,
      });
      plannedCreatedEntities.push({ tableIndex: request.tableIndex, entityId });
      plannedExpectations.push({ tableName, entityId, shouldExist: true });
      plannedCounts.create += 1;
      continue;
    }

    const entityId = mutationPlan.entityId;

    if (!entityId) {
      throw new Error(`Expected ${mutationPlan.actualKind} plan to resolve an entity id`);
    }

    if (mutationPlan.actualKind === "delete") {
      plannedBatchItems.push({
        table: tableName,
        kind: "delete",
        entityKey: { id: entityId },
      } as MutationBatchItem<typeof registryPlaceholder>);
      applyConcurrentMutationToRowPool({
        rowPool: batchRowPool,
        tableIndex: request.tableIndex,
        mutationKind: "delete",
        entityId,
      });
      plannedDeletedEntities.push({ tableIndex: request.tableIndex, entityId });
      plannedExpectations.push({ tableName, entityId, shouldExist: false });
      plannedCounts.delete += 1;
      continue;
    }

    plannedBatchItems.push({
      table: tableName,
      kind: "update",
      entityKey: { id: entityId },
      patch: buildConcurrentUpdatePatch(
        clientIndex,
        operationIndex,
        request.mutationIndex,
        request.selectionSequence,
        config.extraColumnCount,
      ),
    } as MutationBatchItem<typeof registryPlaceholder>);
    plannedCounts.update += 1;
  }

  for (const deletedEntity of plannedDeletedEntities) {
    applyConcurrentMutationToRowPool({
      rowPool: sharedRowPool,
      tableIndex: deletedEntity.tableIndex,
      mutationKind: "delete",
      entityId: deletedEntity.entityId,
    });

    if (reserveLocalDeletes) {
      applyConcurrentMutationToRowPool({
        rowPool: localRowPool,
        tableIndex: deletedEntity.tableIndex,
        mutationKind: "delete",
        entityId: deletedEntity.entityId,
      });
    }
  }

  return {
    batchItems: plannedBatchItems,
    batchExpectations: plannedExpectations,
    batchCreatedEntities: plannedCreatedEntities,
    batchDeletedEntities: plannedDeletedEntities,
    batchCounts: plannedCounts,
  };
}

export async function runConcurrentMixedLoadWorker(
  input: ConcurrentMixedLoadWorkerInput,
): Promise<ConcurrentMixedLoadWorkerResult> {
  const { assignment, clientIndex, config, coordinatorUrl, dataDir, writeUrl } = input;
  const { registry, tableNames } = buildSyntheticRegistry({
    tableCount: Math.max(1, config.tableCount),
    extraColumnCount: config.extraColumnCount,
  });
  const client = await createSyncClient({
    registry,
    electricUrl: env.electricUrl,
    writeUrl,
    getAuthToken: async () => assignment.token,
    dataDir,
  });

  const localRowPool = createConcurrentRowPool(tableNames.map(() => []));
  const handle = {
    key: `client-${clientIndex.toString().padStart(2, "0")}`,
    clientIndex,
    assignment,
    dataDir,
    client,
    localRowPool,
    nextCreateSequence: 0,
    enqueueTimingsMs: [] as number[],
    flushTimingsMs: [] as number[],
    convergenceTimingsMs: [] as number[],
    batchSizeHistogram: {} as Record<string, number>,
    operations: 0,
    mutations: 0,
    createMutations: 0,
    updateMutations: 0,
    deleteMutations: 0,
    acknowledgedMutations: 0,
    failedFlushCount: 0,
    retryCount: 0,
    mutationFallbackCount: 0,
    skippedDeleteCount: 0,
  };

  try {
    await client.ready;
    const ownedRowCount = countOwnedRows(
      config.seedRowsPerTable,
      assignment.userIndex,
      resolveDemoUsers(config.distinctUsers).length,
    );
    const rowPoolSize = resolveRowPoolSize(config, ownedRowCount);
    const expectedSyncedIdsByTable = buildExpectedSyncedIdsByTable(
      tableNames,
      rowPoolSize,
      assignment.userIndex,
      resolveDemoUsers(config.distinctUsers).length,
      config.extraColumnCount,
    );
    await waitForSeedSync(registry, client, expectedSyncedIdsByTable);

    const random = createDeterministicRandom(hashSeed(`${config.scenarioKey}:${handle.key}:${handle.assignment.key}`));
    const mutationMix = resolveConcurrentMutationMix(config.createProbability, config.deleteProbability);

    for (let operationIndex = 0; operationIndex < config.operationsPerClient; operationIndex += 1) {
      const mutationRequests = buildConcurrentMutationRequests({
        clientIndex,
        config,
        mutationMix,
        operationIndex,
        random,
        userIndex: assignment.userIndex,
      });
      const plan = await requestConcurrentBatchPlan(coordinatorUrl, {
        assignmentKey: assignment.key,
        clientIndex,
        userIndex: assignment.userIndex,
        operationIndex,
        nextCreateSequence: handle.nextCreateSequence,
        localRowPool: handle.localRowPool,
        mutationRequests,
      });

      reserveConcurrentDeletedEntities({
        sharedRowPool: createConcurrentRowPool(tableNames.map(() => [])),
        localRowPool: handle.localRowPool,
        deletedEntities: plan.batchDeletedEntities,
      });

      const enqueueStartedAt = performance.now();
      await handle.client.mutate.batch(plan.batchItems as Array<MutationBatchItem<typeof registryPlaceholder>>);
      handle.enqueueTimingsMs.push(performance.now() - enqueueStartedAt);
      handle.batchSizeHistogram[String(plan.batchItems.length)] =
        (handle.batchSizeHistogram[String(plan.batchItems.length)] ?? 0) + 1;
      handle.operations += 1;
      handle.mutations += plan.batchItems.length;
      handle.createMutations += plan.batchCounts.create;
      handle.updateMutations += plan.batchCounts.update;
      handle.deleteMutations += plan.batchCounts.delete;
      handle.mutationFallbackCount += plan.batchCounts.fallbacks;
      handle.skippedDeleteCount += plan.batchCounts.skippedDeletes;

      const flushStartedAt = performance.now();
      try {
        await handle.client.flush();
      } catch (error) {
        handle.failedFlushCount += 1;
        throw error;
      }
      handle.flushTimingsMs.push(performance.now() - flushStartedAt);

      const convergenceStartedAt = performance.now();
      await waitForConvergence(
        registry,
        handle as ConcurrentClientHandle & {
          client: Awaited<ReturnType<typeof createSyncClient<typeof registryPlaceholder>>>;
        },
        config,
        selectRowExpectationsForVerification(plan.batchExpectations),
      );
      handle.convergenceTimingsMs.push(performance.now() - convergenceStartedAt);
      handle.acknowledgedMutations += plan.batchItems.length;
      handle.nextCreateSequence += plan.batchCounts.create;

      commitConcurrentBatchRowPools({
        sharedRowPool: createConcurrentRowPool(tableNames.map(() => [])),
        localRowPool: handle.localRowPool,
        createdEntities: plan.batchCreatedEntities,
        deletedEntities: plan.batchDeletedEntities,
      });
      await commitConcurrentWorkerBatch(coordinatorUrl, {
        assignmentKey: assignment.key,
        createdEntities: plan.batchCreatedEntities,
        deletedEntities: plan.batchDeletedEntities,
      });

      const jitterMs = pickJitterMs(config, random);
      if (jitterMs > 0) {
        await delay(jitterMs);
      }
    }

    return {
      batchSizeHistogram: handle.batchSizeHistogram,
      convergenceTimingsMs: handle.convergenceTimingsMs,
      enqueueTimingsMs: handle.enqueueTimingsMs,
      finalDiagnostic: {
        clientKey: handle.key,
        authKey: handle.assignment.key,
        mutation: (await handle.client.diagnostics()).mutation,
      },
      flushTimingsMs: handle.flushTimingsMs,
      perClient: {
        clientKey: handle.key,
        authKey: handle.assignment.key,
        operations: handle.operations,
        mutations: handle.mutations,
        createMutations: handle.createMutations,
        updateMutations: handle.updateMutations,
        deleteMutations: handle.deleteMutations,
        failedFlushCount: handle.failedFlushCount,
        retryCount: handle.retryCount,
        mutationFallbackCount: handle.mutationFallbackCount,
        skippedDeleteCount: handle.skippedDeleteCount,
        enqueueLatencyMs: computePercentiles(handle.enqueueTimingsMs),
        flushLatencyMs: computePercentiles(handle.flushTimingsMs),
        convergenceLatencyMs: computePercentiles(handle.convergenceTimingsMs),
      },
    };
  } finally {
    await client.stop();
  }
}

async function requestConcurrentBatchPlan(coordinatorUrl: string, request: ConcurrentWorkerPlanRequest) {
  const response = await fetch(`${coordinatorUrl}/plan`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    throw new Error(`Coordinator plan request failed with ${response.status}: ${await response.text()}`);
  }

  return (await response.json()) as ConcurrentBatchPlanResult;
}

async function commitConcurrentWorkerBatch(coordinatorUrl: string, request: ConcurrentWorkerCommitRequest) {
  const response = await fetch(`${coordinatorUrl}/commit`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    throw new Error(`Coordinator commit request failed with ${response.status}: ${await response.text()}`);
  }
}

function buildRunResultFromWorkerResults(
  config: PerfScenarioConfig,
  tableNames: string[],
  durationMs: number,
  workerResults: ConcurrentMixedLoadWorkerResult[],
): ConcurrentScenarioRunResult {
  const enqueueTimingsMs = workerResults.flatMap((workerResult) => workerResult.enqueueTimingsMs);
  const flushTimingsMs = workerResults.flatMap((workerResult) => workerResult.flushTimingsMs);
  const convergenceTimingsMs = workerResults.flatMap((workerResult) => workerResult.convergenceTimingsMs);
  const batchSizeHistogram = mergeHistograms(workerResults.map((workerResult) => workerResult.batchSizeHistogram));
  const perClient = workerResults.map((workerResult) => workerResult.perClient);
  const finalDiagnostics = workerResults.map((workerResult) => workerResult.finalDiagnostic);

  return {
    scenarioKey: config.scenarioKey,
    concurrentPreset: config.concurrentPreset,
    registryTableNames: tableNames,
    durationMs,
    totalOperations: perClient.reduce((total, clientSummary) => total + clientSummary.operations, 0),
    totalMutations: perClient.reduce((total, clientSummary) => total + clientSummary.mutations, 0),
    createMutations: perClient.reduce((total, clientSummary) => total + clientSummary.createMutations, 0),
    updateMutations: perClient.reduce((total, clientSummary) => total + clientSummary.updateMutations, 0),
    deleteMutations: perClient.reduce((total, clientSummary) => total + clientSummary.deleteMutations, 0),
    completedFlushes: perClient.reduce(
      (total, clientSummary) => total + workerResults[perClient.indexOf(clientSummary)]!.flushTimingsMs.length,
      0,
    ),
    acknowledgedMutations: perClient.reduce((total, clientSummary) => total + clientSummary.mutations, 0),
    failedFlushCount: perClient.reduce((total, clientSummary) => total + clientSummary.failedFlushCount, 0),
    retryCount: perClient.reduce((total, clientSummary) => total + clientSummary.retryCount, 0),
    mutationFallbackCount: perClient.reduce((total, clientSummary) => total + clientSummary.mutationFallbackCount, 0),
    skippedDeleteCount: perClient.reduce((total, clientSummary) => total + clientSummary.skippedDeleteCount, 0),
    nonConvergedClientCount: finalDiagnostics.filter((diagnostic) => hasOutstandingMutations(diagnostic.mutation))
      .length,
    enqueueTimingsMs,
    flushTimingsMs,
    convergenceTimingsMs,
    batchSizeHistogram,
    perClient,
    finalDiagnostics,
  };
}

function buildConcurrentMutationRequests(options: {
  clientIndex: number;
  config: PerfScenarioConfig;
  mutationMix: ReturnType<typeof resolveConcurrentMutationMix>;
  operationIndex: number;
  random: () => number;
  userIndex: number;
}) {
  const { clientIndex, config, mutationMix, operationIndex, random, userIndex } = options;
  const burstSize = pickBurstSize(config, random);

  return Array.from({ length: burstSize }, (_, mutationIndex) => {
    const target = pickWorkloadTarget({
      tableCount: Math.max(1, config.tableCount),
      clientIndex,
      operationIndex,
      mutationIndex,
      userIndex,
    });

    return {
      desiredKind: pickConcurrentMutationKind(random, mutationMix),
      mutationIndex,
      tableIndex: target.tableIndex,
      selectionSequence: target.selectionSequence,
    } satisfies ConcurrentMutationRequest;
  });
}

async function executeClientWorkload(options: {
  handle: ConcurrentClientHandle & { client: Awaited<ReturnType<typeof createSyncClient<typeof registryPlaceholder>>> };
  config: PerfScenarioConfig;
  registry: SyncTableRegistry;
  tableNames: string[];
  users: DemoPerfUser[];
}) {
  const { handle, config, registry, tableNames } = options;
  const random = createDeterministicRandom(hashSeed(`${config.scenarioKey}:${handle.key}:${handle.assignment.key}`));
  const mutationMix = resolveConcurrentMutationMix(config.createProbability, config.deleteProbability);

  for (let operationIndex = 0; operationIndex < config.operationsPerClient; operationIndex += 1) {
    const burstSize = pickBurstSize(config, random);
    const { batchItems, batchExpectations, batchCreatedEntities, batchDeletedEntities, batchCounts } =
      await withSharedRowPoolPlanningLock(handle.sharedRowPoolState, async () => {
        const plannedBatchItems: Array<MutationBatchItem<typeof registryPlaceholder>> = [];
        const batchRowPool = mergeConcurrentRowPools([handle.sharedRowPoolState.rowPool, handle.localRowPool]);
        const plannedExpectations: RowPresenceExpectation[] = [];
        const plannedCreatedEntities: Array<{ tableIndex: number; entityId: string }> = [];
        const plannedDeletedEntities: Array<{ tableIndex: number; entityId: string }> = [];
        const plannedCounts = {
          create: 0,
          update: 0,
          delete: 0,
          fallbacks: 0,
          skippedDeletes: 0,
        };

        for (let mutationIndex = 0; mutationIndex < burstSize; mutationIndex += 1) {
          const desiredKind = pickConcurrentMutationKind(random, mutationMix);
          const target = pickWorkloadTarget({
            tableCount: tableNames.length,
            clientIndex: handle.clientIndex,
            operationIndex,
            mutationIndex,
            userIndex: handle.assignment.userIndex,
          });
          const tableName = tableNames[target.tableIndex]!;
          const mutationPlan = buildConcurrentMutationPlan({
            desiredKind,
            tableIndex: target.tableIndex,
            selectionSequence: target.selectionSequence,
            rowPool: batchRowPool,
          });

          if (mutationPlan.fallbackApplied) {
            plannedCounts.fallbacks += 1;
          }

          if (mutationPlan.skippedDelete) {
            plannedCounts.skippedDeletes += 1;
          }

          if (mutationPlan.actualKind === "create") {
            const createOrdinal = handle.nextCreateSequence + plannedCounts.create;
            const createRowIndex = buildCreateRowIndex(
              config.seedRowsPerTable,
              config.concurrentClients,
              handle.clientIndex,
              createOrdinal,
            );
            const createInput = buildSyntheticCreatePayload(target.tableIndex, createRowIndex, config.extraColumnCount);
            const entityId = String(createInput.id);

            plannedBatchItems.push({
              table: tableName,
              kind: "create",
              input: createInput,
            } as MutationBatchItem<typeof registryPlaceholder>);
            applyConcurrentMutationToRowPool({
              rowPool: batchRowPool,
              tableIndex: target.tableIndex,
              mutationKind: "create",
              entityId,
            });
            plannedCreatedEntities.push({ tableIndex: target.tableIndex, entityId });
            plannedExpectations.push({ tableName, entityId, shouldExist: true });
            plannedCounts.create += 1;
            continue;
          }

          const entityId = mutationPlan.entityId;

          if (!entityId) {
            throw new Error(`Expected ${mutationPlan.actualKind} plan to resolve an entity id`);
          }

          if (mutationPlan.actualKind === "delete") {
            plannedBatchItems.push({
              table: tableName,
              kind: "delete",
              entityKey: { id: entityId },
            } as MutationBatchItem<typeof registryPlaceholder>);
            applyConcurrentMutationToRowPool({
              rowPool: batchRowPool,
              tableIndex: target.tableIndex,
              mutationKind: "delete",
              entityId,
            });
            plannedDeletedEntities.push({ tableIndex: target.tableIndex, entityId });
            plannedExpectations.push({ tableName, entityId, shouldExist: false });
            plannedCounts.delete += 1;
            continue;
          }

          plannedBatchItems.push({
            table: tableName,
            kind: "update",
            entityKey: { id: entityId },
            patch: buildConcurrentUpdatePatch(
              handle.clientIndex,
              operationIndex,
              mutationIndex,
              target.selectionSequence,
              config.extraColumnCount,
            ),
          } as MutationBatchItem<typeof registryPlaceholder>);
          plannedCounts.update += 1;
        }

        reserveConcurrentDeletedEntities({
          sharedRowPool: handle.sharedRowPoolState.rowPool,
          localRowPool: handle.localRowPool,
          deletedEntities: plannedDeletedEntities,
        });

        return {
          batchItems: plannedBatchItems,
          batchExpectations: plannedExpectations,
          batchCreatedEntities: plannedCreatedEntities,
          batchDeletedEntities: plannedDeletedEntities,
          batchCounts: plannedCounts,
        };
      });

    const enqueueStartedAt = performance.now();
    await handle.client.mutate.batch(batchItems as Array<MutationBatchItem<typeof registryPlaceholder>>);
    handle.enqueueTimingsMs.push(performance.now() - enqueueStartedAt);
    handle.batchSizeHistogram[String(batchItems.length)] =
      (handle.batchSizeHistogram[String(batchItems.length)] ?? 0) + 1;
    handle.operations += 1;
    handle.mutations += batchItems.length;
    handle.createMutations += batchCounts.create;
    handle.updateMutations += batchCounts.update;
    handle.deleteMutations += batchCounts.delete;
    handle.mutationFallbackCount += batchCounts.fallbacks;
    handle.skippedDeleteCount += batchCounts.skippedDeletes;

    const flushStartedAt = performance.now();
    try {
      await handle.client.flush();
    } catch (error) {
      handle.failedFlushCount += 1;
      throw error;
    }
    handle.flushTimingsMs.push(performance.now() - flushStartedAt);

    const convergenceStartedAt = performance.now();
    await waitForConvergence(registry, handle, config, selectRowExpectationsForVerification(batchExpectations));
    handle.convergenceTimingsMs.push(performance.now() - convergenceStartedAt);
    handle.acknowledgedMutations += batchItems.length;
    handle.nextCreateSequence += batchCounts.create;
    commitConcurrentBatchRowPools({
      sharedRowPool: handle.sharedRowPoolState.rowPool,
      localRowPool: handle.localRowPool,
      createdEntities: batchCreatedEntities,
      deletedEntities: batchDeletedEntities,
    });

    const jitterMs = pickJitterMs(config, random);
    if (jitterMs > 0) {
      await delay(jitterMs);
    }
  }
}

function buildRunResult(
  config: PerfScenarioConfig,
  tableNames: string[],
  durationMs: number,
  handles: Array<
    ConcurrentClientHandle & { client: Awaited<ReturnType<typeof createSyncClient<typeof registryPlaceholder>>> }
  >,
  finalDiagnostics: ConcurrentClientDiagnostics[],
): ConcurrentScenarioRunResult {
  const enqueueTimingsMs = handles.flatMap((handle) => handle.enqueueTimingsMs);
  const flushTimingsMs = handles.flatMap((handle) => handle.flushTimingsMs);
  const convergenceTimingsMs = handles.flatMap((handle) => handle.convergenceTimingsMs);
  const batchSizeHistogram = mergeHistograms(handles.map((handle) => handle.batchSizeHistogram));
  const perClient = handles.map((handle) => ({
    clientKey: handle.key,
    authKey: handle.assignment.key,
    operations: handle.operations,
    mutations: handle.mutations,
    createMutations: handle.createMutations,
    updateMutations: handle.updateMutations,
    deleteMutations: handle.deleteMutations,
    failedFlushCount: handle.failedFlushCount,
    retryCount: handle.retryCount,
    mutationFallbackCount: handle.mutationFallbackCount,
    skippedDeleteCount: handle.skippedDeleteCount,
    enqueueLatencyMs: computePercentiles(handle.enqueueTimingsMs),
    flushLatencyMs: computePercentiles(handle.flushTimingsMs),
    convergenceLatencyMs: computePercentiles(handle.convergenceTimingsMs),
  }));

  return {
    scenarioKey: config.scenarioKey,
    concurrentPreset: config.concurrentPreset,
    registryTableNames: tableNames,
    durationMs,
    totalOperations: handles.reduce((total, handle) => total + handle.operations, 0),
    totalMutations: handles.reduce((total, handle) => total + handle.mutations, 0),
    createMutations: handles.reduce((total, handle) => total + handle.createMutations, 0),
    updateMutations: handles.reduce((total, handle) => total + handle.updateMutations, 0),
    deleteMutations: handles.reduce((total, handle) => total + handle.deleteMutations, 0),
    completedFlushes: handles.reduce((total, handle) => total + handle.flushTimingsMs.length, 0),
    acknowledgedMutations: handles.reduce((total, handle) => total + handle.acknowledgedMutations, 0),
    failedFlushCount: handles.reduce((total, handle) => total + handle.failedFlushCount, 0),
    retryCount: handles.reduce((total, handle) => total + handle.retryCount, 0),
    mutationFallbackCount: handles.reduce((total, handle) => total + handle.mutationFallbackCount, 0),
    skippedDeleteCount: handles.reduce((total, handle) => total + handle.skippedDeleteCount, 0),
    nonConvergedClientCount: finalDiagnostics.filter((diagnostic) => hasOutstandingMutations(diagnostic.mutation))
      .length,
    enqueueTimingsMs,
    flushTimingsMs,
    convergenceTimingsMs,
    batchSizeHistogram,
    perClient,
    finalDiagnostics,
  };
}

async function waitForConvergence(
  registry: SyncTableRegistry,
  handle: ConcurrentClientHandle & { client: Awaited<ReturnType<typeof createSyncClient<typeof registryPlaceholder>>> },
  config: PerfScenarioConfig,
  expectations: RowPresenceExpectation[] = [],
) {
  const timeoutMs = resolveConvergenceTimeoutMs(config);
  const startedAtMs = Date.now();
  let lastError: unknown;
  let lastDiagnostics: Awaited<ReturnType<typeof handle.client.diagnostics>> | null = null;

  try {
    while (Date.now() - startedAtMs < timeoutMs) {
      try {
        await handle.client.reconcile();
        const diagnostics = await handle.client.diagnostics();
        lastDiagnostics = diagnostics;

        if (diagnostics.mutation.failedCount > 0) {
          handle.retryCount += 1;
          await handle.client.retryFailed();
          throw new Error(`${handle.key} still has failed mutations to retry`);
        }

        if (diagnostics.mutation.pendingCount > 0 || diagnostics.mutation.sendingCount > 0) {
          throw new Error(`${handle.key} still has pending mutation state`);
        }

        await verifyLocalRowExpectations(registry, handle.client, expectations);

        if (diagnostics.mutation.ackedCount > 0) {
          throw new Error(`${handle.key} still has acknowledged mutations waiting for Electric echo`);
        }

        return;
      } catch (error) {
        lastError = error;
      }

      const intervalMs = isAckOnlyMutationState(lastDiagnostics?.mutation) ? 250 : 100;
      await delay(intervalMs);
    }

    throw lastError instanceof Error ? lastError : new Error(`${handle.key} did not converge within ${timeoutMs}ms`);
  } catch (error) {
    const diagnostics = lastDiagnostics ?? (await handle.client.diagnostics());
    const recentMutations = (await handle.client.readMutationDetails()).slice(0, 5).map((mutation) => ({
      tableName: mutation.tableName,
      entityKey: mutation.entityKey,
      kind: mutation.mutationKind,
      status: mutation.status,
      attempts: mutation.attemptCount,
      lastHttpStatus: mutation.lastHttpStatus,
      conflictReason: mutation.conflictReason,
      serverUpdatedAtUs: mutation.serverUpdatedAtUs,
    }));
    const recentEntityState = await readLocalEntityStateDiagnostics(registry, handle.client, recentMutations);
    const recentServerEntityState = await readServerEntityStateDiagnostics(registry, recentMutations);
    const waitReason = isAckOnlyMutationState(diagnostics.mutation)
      ? "waiting for Electric echo to clear acknowledged mutations"
      : "waiting for local mutation state to drain";

    throw new Error(
      [
        `${handle.key} did not converge within ${timeoutMs}ms (${waitReason})`,
        `mutation counts: pending=${diagnostics.mutation.pendingCount}, sending=${diagnostics.mutation.sendingCount}, failed=${diagnostics.mutation.failedCount}, acked=${diagnostics.mutation.ackedCount}`,
        recentMutations.length > 0 ? `recent mutations: ${JSON.stringify(recentMutations)}` : undefined,
        recentEntityState.length > 0 ? `recent entity state: ${JSON.stringify(recentEntityState)}` : undefined,
        recentServerEntityState.length > 0
          ? `recent server entity state: ${JSON.stringify(recentServerEntityState)}`
          : undefined,
        error instanceof Error ? `last wait error: ${error.message}` : undefined,
      ]
        .filter((part): part is string => part !== undefined)
        .join("\n"),
    );
  }
}

// Pre-measurement wait loop — a live tier-① builder per poll is fine here (nothing is being timed).
async function waitForSeedSync(
  registry: SyncTableRegistry,
  client: Awaited<ReturnType<typeof createSyncClient<typeof registryPlaceholder>>>,
  expectedSyncedIdsByTable: Map<string, string[]>,
) {
  await waitFor(
    async () => {
      for (const [tableName, expectedIds] of expectedSyncedIdsByTable.entries()) {
        const table = requireRegistryEntry(registry, tableName).table;
        const rows = await client.drizzle
          .select({ rowCount: count() })
          .from(table)
          .where(inArray(requireColumn(table, "id"), expectedIds));

        if ((rows[0]?.rowCount ?? 0) !== expectedIds.length) {
          throw new Error(`expected ${expectedIds.length} synced target rows in ${tableName}`);
        }
      }
    },
    {
      timeoutMs: 60_000,
      intervalMs: 250,
    },
  );
}

// Setup-phase seeding (unmeasured): tier-① inserts through the provisioning server's drizzle handle,
// in the same 250-row chunks (mirrors scripts/perf-lab-server.ts `seedRegistryRows`).
async function seedSyntheticRows<TRegistry extends SyncTableRegistry>(
  registry: TRegistry,
  tableNames: string[],
  seedRowsPerTable: number,
  extraColumnCount: number,
  users: DemoPerfUser[],
  db: PgAsyncDatabase<PgQueryResultHKT, RegistryRelations<TRegistry>>,
) {
  const batchSize = 250;

  for (const [tableIndex, tableName] of tableNames.entries()) {
    const entry = requireRegistryEntry(registry, tableName);

    for (let start = 0; start < seedRowsPerTable; start += batchSize) {
      const batchEnd = Math.min(seedRowsPerTable, start + batchSize);
      const rows: Array<Record<string, string | bigint>> = [];

      for (let rowIndex = start; rowIndex < batchEnd; rowIndex += 1) {
        const payload = buildSyntheticCreatePayload(tableIndex, rowIndex, extraColumnCount);
        const owner = users[rowIndex % users.length]!;
        const timestampUs = 1_700_000_000_000_000n + BigInt(tableIndex * seedRowsPerTable + rowIndex);
        const row: Record<string, string | bigint> = {
          id: payload.id,
          ownerId: owner.userId,
          modifiedBy: owner.userId,
          status: payload.status,
          priority: payload.priority,
          createdAtUs: timestampUs,
          updatedAtUs: timestampUs,
        };

        for (let columnIndex = 0; columnIndex < extraColumnCount; columnIndex += 1) {
          const fieldKey = `field${columnIndex.toString().padStart(2, "0")}`;
          row[fieldKey] = payload[fieldKey] ?? "";
        }

        rows.push(row);
      }

      await db.insert(entry.table as AnyPgTable).values(rows);
    }
  }
}

function resolveDemoUsers(requestedCount: number): DemoPerfUser[] {
  const resolvedCount = Math.min(Math.max(1, requestedCount), demoUsers.length);
  return demoUsers.slice(0, resolvedCount).map((user, userIndex) => ({
    ...user,
    userIndex,
  }));
}

function countOwnedRows(totalRowsPerTable: number, userIndex: number, distinctUsers: number) {
  let ownedRows = 0;

  for (let rowIndex = userIndex; rowIndex < totalRowsPerTable; rowIndex += distinctUsers) {
    ownedRows += 1;
  }

  return ownedRows;
}

function resolveRowPoolSize(config: PerfScenarioConfig, ownedRowCount: number) {
  const cappedRowCount = Math.min(ownedRowCount, resolveActiveRowPoolCap(config));

  if (config.scenarioKey !== "hot-partition-overlap") {
    return Math.max(1, cappedRowCount);
  }

  return Math.max(1, Math.floor(cappedRowCount * Math.max(0.01, config.hotPartitionRatio)));
}

function resolveActiveRowPoolCap(config: PerfScenarioConfig) {
  return Math.max(256, config.largeBatchSize * 8, config.mediumBurstMax * 12, config.smallBurstMax * 32);
}

function buildExpectedSyncedIdsByTable(
  tableNames: string[],
  rowPoolSize: number,
  userIndex: number,
  distinctUsers: number,
  extraColumnCount: number,
) {
  const expectedIdsByTable = new Map<string, string[]>();

  for (const [tableIndex, tableName] of tableNames.entries()) {
    const ids: string[] = [];

    for (let rowSlot = 0; rowSlot < rowPoolSize; rowSlot += 1) {
      const rowIndex = rowSlot * distinctUsers + userIndex;
      ids.push(String(buildSyntheticCreatePayload(tableIndex, rowIndex, extraColumnCount).id));
    }

    expectedIdsByTable.set(tableName, ids);
  }

  return expectedIdsByTable;
}

function pickBurstSize(config: PerfScenarioConfig, random: () => number) {
  const sample = random();

  if (sample < config.largeBatchProbability) {
    return config.largeBatchSize;
  }

  if (sample < config.largeBatchProbability + config.mediumBurstProbability) {
    return pickIntInRange(config.mediumBurstMin, config.mediumBurstMax, random);
  }

  return pickIntInRange(config.smallBurstMin, config.smallBurstMax, random);
}

function pickWorkloadTarget(options: {
  tableCount: number;
  clientIndex: number;
  operationIndex: number;
  mutationIndex: number;
  userIndex: number;
}) {
  const { tableCount, clientIndex, operationIndex, mutationIndex, userIndex } = options;
  const sequence = operationIndex * 97 + mutationIndex * 17 + clientIndex * 31;

  return {
    tableIndex: (sequence + userIndex) % tableCount,
    selectionSequence: sequence + userIndex,
  };
}

function buildCreateRowIndex(
  seedRowsPerTable: number,
  concurrentClients: number,
  clientIndex: number,
  createSequence: number,
) {
  return seedRowsPerTable + createSequence * Math.max(4, concurrentClients) + clientIndex;
}

function buildConcurrentUpdatePatch(
  clientIndex: number,
  operationIndex: number,
  mutationIndex: number,
  rowIndex: number,
  extraColumnCount: number,
) {
  const patch = {
    ...buildSyntheticUpdatePatch(rowIndex + operationIndex + mutationIndex, extraColumnCount),
  };

  if (extraColumnCount > 0) {
    patch["field00"] = `c${clientIndex}-o${operationIndex}-m${mutationIndex}`;
  }

  if (extraColumnCount > 1) {
    patch["field01"] = `row-${rowIndex}`;
  }

  return patch;
}

function pickJitterMs(config: PerfScenarioConfig, random: () => number) {
  if (config.jitterMaxMs <= config.jitterMinMs) {
    return config.jitterMinMs;
  }

  return pickIntInRange(config.jitterMinMs, config.jitterMaxMs, random);
}

function mergeHistograms(histograms: Record<string, number>[]) {
  return histograms.reduce<Record<string, number>>((merged, histogram) => {
    for (const [key, value] of Object.entries(histogram)) {
      merged[key] = (merged[key] ?? 0) + value;
    }

    return merged;
  }, {});
}

async function withSharedRowPoolPlanningLock<T>(state: SharedConcurrentRowPoolState, task: () => Promise<T>) {
  let releaseQueue: (() => void) | undefined;
  const currentQueue = new Promise<void>((resolve) => {
    releaseQueue = resolve;
  });
  const previousQueue = state.planningQueue;
  state.planningQueue = currentQueue;

  await previousQueue;

  try {
    return await task();
  } finally {
    releaseQueue?.();
  }
}

// Poll-dominated convergence window — live tier-① builders over the registry read-model view are
// acceptable here (the convergence metric is wait-bound, not statement-bound). The view's `id`
// column rides the entry's own property key (`id` for the synthetic registry).
async function verifyLocalRowExpectations(
  registry: SyncTableRegistry,
  client: Awaited<ReturnType<typeof createSyncClient<typeof registryPlaceholder>>>,
  expectations: RowPresenceExpectation[],
) {
  for (const expectation of expectations) {
    const view = requireReadModelView(registry, expectation.tableName);
    const rows = await client.drizzle
      .select({ rowCount: count() })
      .from(view)
      .where(eq(requireColumn(view, "id"), expectation.entityId));
    const rowCount = rows[0]?.rowCount ?? 0;

    if (expectation.shouldExist && rowCount < 1) {
      throw new Error(`expected ${expectation.entityId} to be visible in ${expectation.tableName}_read_model`);
    }

    if (!expectation.shouldExist && rowCount !== 0) {
      throw new Error(`expected ${expectation.entityId} to be absent from ${expectation.tableName}_read_model`);
    }
  }
}

// Failure-path diagnostics only: tier-① aggregates over the registry's synced/read-model/overlay
// relations (no `::text` casts — the returned bigint/varchar values are stringified for the report).
async function readLocalEntityStateDiagnostics(
  registry: SyncTableRegistry,
  client: Awaited<ReturnType<typeof createSyncClient<typeof registryPlaceholder>>>,
  mutations: Array<{
    tableName: string;
    entityKey: Record<string, string>;
    serverUpdatedAtUs?: string | null;
  }>,
) {
  const diagnostics: Array<{
    tableName: string;
    entityKey: Record<string, string>;
    serverUpdatedAtUs: string | null;
    readModelRowCount: number;
    readModelOverlayKind: string | null;
    readModelUpdatedAtUs: string | null;
    readModelLocalUpdatedAtUs: string | null;
    syncedRowCount: number;
    syncedUpdatedAtUs: string | null;
    overlayRowCount: number;
    overlayKind: string | null;
    overlayUpdatedAtUs: string | null;
    overlayLocalUpdatedAtUs: string | null;
  }> = [];

  for (const mutation of mutations) {
    const entityId = mutation.entityKey["id"];

    if (!entityId) {
      continue;
    }

    const syncedTable = getSyncedLocalTable(registry, mutation.tableName);
    const syncedRows = await client.drizzle
      .select({
        rowCount: count(),
        updatedAtUs: max(requireColumn(syncedTable, "updatedAtUs")),
      })
      .from(syncedTable)
      .where(eq(requireColumn(syncedTable, "id"), entityId));

    const readModelView = requireReadModelView(registry, mutation.tableName);
    const readModelRows = await client.drizzle
      .select({
        rowCount: count(),
        overlayKind: max(requireColumn(readModelView, "overlay_kind")),
        updatedAtUs: max(requireColumn(readModelView, "updatedAtUs")),
        localUpdatedAtUs: max(requireColumn(readModelView, "local_updated_at_us")),
      })
      .from(readModelView)
      .where(eq(requireColumn(readModelView, "id"), entityId));

    const overlayTable = getOverlayTable(registry, mutation.tableName);
    const overlayRows = await client.drizzle
      .select({
        rowCount: count(),
        overlayKind: max(overlayTable.overlayKind),
        updatedAtUs: max(requireColumn(overlayTable, "updatedAtUs")),
        localUpdatedAtUs: max(overlayTable.localUpdatedAtUs),
      })
      .from(overlayTable)
      .where(eq(requireColumn(overlayTable, "id"), entityId));

    diagnostics.push({
      tableName: mutation.tableName,
      entityKey: mutation.entityKey,
      serverUpdatedAtUs: mutation.serverUpdatedAtUs ?? null,
      readModelRowCount: readModelRows[0]?.rowCount ?? 0,
      readModelOverlayKind: formatNullableDiagnosticValue(readModelRows[0]?.overlayKind),
      readModelUpdatedAtUs: formatNullableDiagnosticValue(readModelRows[0]?.updatedAtUs),
      readModelLocalUpdatedAtUs: formatNullableDiagnosticValue(readModelRows[0]?.localUpdatedAtUs),
      syncedRowCount: syncedRows[0]?.rowCount ?? 0,
      syncedUpdatedAtUs: formatNullableDiagnosticValue(syncedRows[0]?.updatedAtUs),
      overlayRowCount: overlayRows[0]?.rowCount ?? 0,
      overlayKind: formatNullableDiagnosticValue(overlayRows[0]?.overlayKind),
      overlayUpdatedAtUs: formatNullableDiagnosticValue(overlayRows[0]?.updatedAtUs),
      overlayLocalUpdatedAtUs: formatNullableDiagnosticValue(overlayRows[0]?.localUpdatedAtUs),
    });
  }

  return diagnostics;
}

// Failure-path diagnostics against the SERVER database, authored over the registry's server table.
// Postgres has no max(uuid) aggregate, so the uuid columns keep the raw probe's `::text` cast as a
// tier-② typed fragment (the bigint columns keep it too, for byte-parity with the original probe).
async function readServerEntityStateDiagnostics(
  registry: SyncTableRegistry,
  mutations: Array<{
    tableName: string;
    entityKey: Record<string, string>;
    serverUpdatedAtUs?: string | null;
  }>,
) {
  if (mutations.length === 0) {
    return [];
  }

  const diagnosticDb = bunDrizzle(env.databaseUrl);

  try {
    const diagnostics: Array<{
      tableName: string;
      entityKey: Record<string, string>;
      serverUpdatedAtUs: string | null;
      rowCount: number;
      ownerId: string | null;
      modifiedBy: string | null;
      createdAtUs: string | null;
      updatedAtUs: string | null;
    }> = [];

    for (const mutation of mutations) {
      const entityId = mutation.entityKey["id"];

      if (!entityId) {
        continue;
      }

      const table = requireRegistryEntry(registry, mutation.tableName).table;
      const rows = await diagnosticDb
        .select({
          rowCount: count(),
          ownerId: max(sql<string>`${requireColumn(table, "ownerId")}::text`),
          modifiedBy: max(sql<string>`${requireColumn(table, "modifiedBy")}::text`),
          createdAtUs: max(sql<string>`${requireColumn(table, "createdAtUs")}::text`),
          updatedAtUs: max(sql<string>`${requireColumn(table, "updatedAtUs")}::text`),
        })
        .from(table)
        .where(eq(requireColumn(table, "id"), entityId));

      const row = rows[0];
      diagnostics.push({
        tableName: mutation.tableName,
        entityKey: mutation.entityKey,
        serverUpdatedAtUs: mutation.serverUpdatedAtUs ?? null,
        rowCount: row?.rowCount ?? 0,
        ownerId: formatNullableDiagnosticValue(row?.ownerId),
        modifiedBy: formatNullableDiagnosticValue(row?.modifiedBy),
        createdAtUs: formatNullableDiagnosticValue(row?.createdAtUs),
        updatedAtUs: formatNullableDiagnosticValue(row?.updatedAtUs),
      });
    }

    return diagnostics;
  } finally {
    await diagnosticDb.$client.close();
  }
}

function hasOutstandingMutations(mutation: {
  pendingCount: number;
  sendingCount: number;
  failedCount: number;
  ackedCount: number;
}) {
  return mutation.pendingCount + mutation.sendingCount + mutation.failedCount + mutation.ackedCount > 0;
}

function isAckOnlyMutationState(
  mutation:
    | {
        pendingCount: number;
        sendingCount: number;
        failedCount: number;
        ackedCount: number;
      }
    | null
    | undefined,
) {
  return (
    mutation !== null &&
    mutation !== undefined &&
    mutation.pendingCount === 0 &&
    mutation.sendingCount === 0 &&
    mutation.failedCount === 0 &&
    mutation.ackedCount > 0
  );
}

function resolveConvergenceTimeoutMs(config: PerfScenarioConfig) {
  const override = readOptionalPositiveIntEnv("PGXSINKIT_PERF_CONCURRENT_CONVERGENCE_TIMEOUT_MS");

  if (override !== null) {
    return override;
  }

  const largestExpectedBurst = Math.max(config.smallBurstMax, config.mediumBurstMax, config.largeBatchSize);
  const presetFloorMs =
    config.concurrentPreset === "heavy" ? 180_000 : config.concurrentPreset === "realistic" ? 120_000 : 60_000;
  const concurrencyAllowanceMs = config.concurrentClients * 5_000;
  const seedAllowanceMs = Math.ceil(config.seedRowsPerTable / 5_000) * 5_000;
  const burstAllowanceMs = largestExpectedBurst * 250;
  const budgetTailMs = Math.ceil(config.budgets.concurrentConvergenceP95MaxMs * 300);

  return Math.max(presetFloorMs, 60_000 + concurrencyAllowanceMs + seedAllowanceMs + burstAllowanceMs, budgetTailMs);
}

function readOptionalPositiveIntEnv(name: string) {
  const rawValue = process.env[name];

  if (!rawValue) {
    return null;
  }

  const parsedValue = Number.parseInt(rawValue, 10);

  if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
    throw new Error(`${name} must be a positive integer when set`);
  }

  return parsedValue;
}

function pickIntInRange(minimum: number, maximum: number, random: () => number) {
  const normalizedMinimum = Math.max(1, Math.min(minimum, maximum));
  const normalizedMaximum = Math.max(normalizedMinimum, maximum);
  return normalizedMinimum + Math.floor(random() * (normalizedMaximum - normalizedMinimum + 1));
}

function createDeterministicRandom(seed: number) {
  let state = seed >>> 0;

  return () => {
    state += 0x6d2b79f5;

    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(value: string) {
  let hash = 2166136261;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return hash >>> 0;
}

async function createPersistentDataDir() {
  const workspaceTmpDir = join(process.cwd(), "tmp");
  await mkdir(workspaceTmpDir, { recursive: true });
  return mkdtemp(join(workspaceTmpDir, "pgxsinkit-perf-concurrent-"));
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
    headers: incoming.headers as Bun.HeadersInit,
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

function requireRegistryEntry(registry: SyncTableRegistry, tableName: string) {
  const entry = registry[tableName];

  if (!entry) {
    throw new Error(`Missing registry table ${tableName}`);
  }

  return entry;
}

// The `<t>_read_model` view carries the entry's projected columns under their own property keys plus
// `overlay_kind` / `local_updated_at_us`; the returned intersection makes them addressable.
function requireReadModelView(registry: SyncTableRegistry, tableName: string): PgView & Record<string, PgColumn> {
  // The schema-qualified read-model factory (mirrors the sibling `getSyncedLocalTable`/`getOverlayTable`
  // reads); it throws if the entry is missing or not writable, preserving the previous guard behavior.
  return getReadModelView(registry, tableName) as unknown as PgView & Record<string, PgColumn>;
}

function requireColumn(relation: AnyPgTable | PgView, propertyKey: string): PgColumn {
  const column = (getColumns(relation) as Record<string, PgColumn | undefined>)[propertyKey];

  if (!column) {
    throw new Error(`Missing column ${propertyKey} on relation`);
  }

  return column;
}

// Failure-path diagnostics render whatever drizzle returns (bigint, string, number, …) as text.
function formatNullableDiagnosticValue(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
    return value.toString();
  }

  return JSON.stringify(value) ?? null;
}

function delay(durationMs: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, durationMs);
  });
}
