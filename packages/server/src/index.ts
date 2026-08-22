import type { PgAsyncDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import type {
  JwtClaims,
  RegistryRelations,
  RegistryTables,
  SyncRuntimeStatus,
  SyncServerAddress,
  SyncTableRegistry,
} from "@pgxsinkit/contracts";
import { batchEventPaths, getSyncRegistryStreams } from "@pgxsinkit/contracts";

import type { EntitlementSet } from "./circuits/edge";
import type { CircuitsEngineClient } from "./circuits/engine-client";
import {
  barrierPath,
  createBarrierHandler,
  createRefreshHandler,
  createReleaseHandler,
  createSubscribeHandler,
  refreshPath,
  releasePath,
  subscribePath,
} from "./circuits/subscribe";
import { createPgmqEventQueue } from "./events/pgmq-queue";
import type { EventQueue } from "./events/queue";
import { createEventIngestHandler, type EventGate, type EventsEnqueuedHook } from "./events/route";
import {
  authoritativeMutationPaths,
  batchMutationPaths,
  createMutationHandler,
  type StartupVerificationMode,
} from "./mutations/route";
import { ensureOperationsLogSchema } from "./operations-log/ddl";
import type { OperationsLogConfig } from "./operations-log/types";
import { FetchRouter, type CorsScope } from "./router";

const defaultAllowedOrigins = ["http://localhost:5173", "http://localhost:5174"];

interface BunServerHandle {
  stop: () => void;
}

interface BunNamespace {
  serve: (options: {
    port: number;
    hostname?: string;
    idleTimeout?: number;
    fetch: (request: Request) => Response | Promise<Response>;
  }) => BunServerHandle;
}

/**
 * How the operations-log table's presence is resolved at startup (ADR-0030 decision 3):
 * - `"probe"` (default): the safe degradation posture (ADR-0030) — one query ensures/confirms the table,
 *   and logging is disabled at runtime (with a warning) if it is absent, so a missing table degrades
 *   gracefully instead of failing writes.
 * - `"enabled"`: assume the table exists — NO query. If it is actually absent, writes then fail loudly.
 * - `"disabled"`: turn logging off with NO query.
 *
 * `"enabled" | "disabled"` are the serverless posture: paired with `startupVerification: "deploy-time"`,
 * a fresh worker sends zero queries before the mutation transaction itself.
 */
export type OperationsLogStartupMode = "probe" | "enabled" | "disabled";

/**
 * The `deployment` profile owns the server's startup query posture (ADR-0030 decision 3). Its defaults
 * are the safe degradation posture — probe-and-verify at startup — so a long-lived host that never sets
 * it still verifies and degrades gracefully; serverless / per-request workers set
 * `{ startupVerification: "deploy-time", operationsLog: "enabled" | "disabled" }` for a
 * zero-startup-query first write.
 */
export interface DeploymentProfile {
  /** Governs ONLY the RLS auth-helper verify now (apply-fn drift is self-verifying). Default `"in-process"`. */
  startupVerification?: StartupVerificationMode;
  /** How the operations-log table presence is resolved. Default `"probe"`. */
  operationsLog?: OperationsLogStartupMode;
}

export interface CreateSyncServerOptions<
  TRegistry extends SyncTableRegistry,
  TDb extends PgAsyncDatabase<PgQueryResultHKT, RegistryRelations<TRegistry>> = PgAsyncDatabase<
    PgQueryResultHKT,
    RegistryRelations<TRegistry>
  >,
> {
  registry: TRegistry;
  db: TDb;
  resolveAuthClaims?: (request: Request) => Promise<JwtClaims | null> | JwtClaims | null;
  /**
   * When set, the server serves the NATIVE read path's control plane (ADR-0055): subscribe, stream-token
   * re-mint, and the engine convergence barrier. Without it, none of those routes is registered and the
   * deployment is write-only.
   *
   * They share the single `resolveAuthClaims` adapter with the write path (ADR-0003), so read and write
   * authorization cannot diverge.
   */
  readPath?: {
    /** The Circuits engine's control API — never client-reachable; only this process calls it. */
    engine: CircuitsEngineClient;
    /**
     * The live entitlement set backing the shared tier. Omit when the registry declares no shared
     * shape — a shared subscription is then refused with that reason rather than silently allowed.
     */
    entitlements?: EntitlementSet;
    /** The stream-token signing key, shared with the edge. */
    key: CryptoKey;
    /** Per-deployment override of ADR-0055's 5-minute token lifetime. */
    ttlSeconds?: number;
    /** How long the barrier answer may be cached. Default 0 — see `createBarrierHandler`. */
    barrierMaxAgeSeconds?: number;
    /** Optional per-request extra params passed to the private tier's row filters. */
    resolveShapeParams?: (request: Request) => Record<string, unknown> | undefined;
  };
  operationsLog?: {
    enabled?: boolean;
  };
  /** Health check endpoint. Enabled by default at `/health`; `false` disables it, `{ path }` relocates it. */
  healthCheck?: boolean | { path: string };
  port?: number;
  host?: string;
  idleTimeoutSeconds?: number;
  allowedOrigins?: string[];
  onStatusChange?: (status: SyncRuntimeStatus) => void;
  /**
   * The startup query posture (ADR-0030). The apply function now verifies its own ADR-0018 fingerprint
   * in-body on every call (SQLSTATE `PXS01` on drift), so there is no startup drift check to configure;
   * this governs only the RLS auth-helper verify and the operations-log presence resolution. Defaults
   * are the safe degradation posture (ADR-0030). See {@link DeploymentProfile}.
   */
  deployment?: DeploymentProfile;
  /**
   * The **Event lane**'s consent/entitlement gate (ADR-0053 decision 1): the lane's one function, and so an
   * option here rather than a registry field (the registry stays declarative data only). Called once per
   * event, after its payload validated and its identity resolved, and before anything is enqueued; a refusal
   * is a per-event `refused` verdict. Absent → every well-formed event is allowed. See {@link EventGate}.
   */
  eventGate?: EventGate;
  /**
   * Fired after an ingest request ENQUEUED at least one sub-batch (ADR-0053 amendment, 2026-08-02): the
   * deployment-agnostic seam a SERVERLESS deployment uses to nudge whatever endpoint runs the consumer's
   * `drainOnce()`, so an interactive append drains in milliseconds instead of waiting for the next
   * scheduled tick. Fire-and-forget — it is called after the commit, its throw is caught and warn-logged,
   * and the scheduled sweep (not the nudge) is the delivery guarantee. Absent → nothing is nudged, which is
   * right for a deployment hosting the long-lived runner. See {@link EventsEnqueuedHook}.
   */
  onEventsEnqueued?: EventsEnqueuedHook;
  /**
   * The Event lane's queue backend. Defaults to the shipped pgmq backend over this server's own `db`
   * (`createPgmqEventQueue`), which is what makes an enqueue join the endpoint's transaction. Override it to
   * run the lane on another backend, or to substitute a fake in tests.
   */
  eventQueue?: EventQueue;
  /**
   * Opt-in per-request timing log (default false). When on, each mutation and shape-proxy request emits
   * one compact `[pgxsinkit-timing]` line with an ISO-8601(ms, UTC) timestamp and phase durations, for
   * attributing wall-clock latency against the client's `syncDebug` lines. Off by default — a pure
   * diagnostic surface that adds no standing query or latency when unset.
   */
  logTimings?: boolean;
  /**
   * The roles the INSTALLED apply function was generated with (`pgxsinkit-generate
   * --grant-execute-to <role>`, ADR-0054). Default `[]` — owner-only, the default the CLI generates.
   *
   * It is not a grant this server performs; it is how the server reproduces the artifact's ADR-0018
   * fingerprint, which hashes the ACL along with the rest of the body. Generate with a grant and leave
   * this unset and every write fails `PXS01` (stale artifact) — so the two lists must stay identical.
   */
  applyFunctionGrantExecuteTo?: readonly string[];
  /**
   * The schema the INSTALLED apply function lives in (`pgxsinkit-generate --function-schema <schema>`).
   * Default: unset — the artifact is generated unqualified and resolved through the connection's
   * `search_path`.
   *
   * It does two things at once, which is why one option drives both: the schema is part of the
   * fingerprinted body (the function names itself in its own self-check), AND it is how this server
   * QUALIFIES the call. Generate with `--function-schema` and leave this unset and the call goes out
   * unqualified — which either finds nothing (`42883`) or, worse, finds a same-named function elsewhere
   * on the `search_path` that then fails `PXS01` against a fingerprint it does not carry. The two must
   * name the same schema.
   */
  applyFunctionSchema?: string;
}

export interface ServerDiagnostics<TRegistry extends SyncTableRegistry> {
  tables: Array<keyof TRegistry & string>;
  modes: Record<string, TRegistry[keyof TRegistry]["mode"]>;
}

export interface SyncServer<
  TRegistry extends SyncTableRegistry,
  TDb extends PgAsyncDatabase<PgQueryResultHKT, RegistryRelations<TRegistry>> = PgAsyncDatabase<
    PgQueryResultHKT,
    RegistryRelations<TRegistry>
  >,
> {
  drizzle: TDb;
  fetch: (request: Request) => Promise<Response>;
  request: (path: string, init?: RequestInit) => Promise<Response>;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  status: SyncRuntimeStatus;
  address: SyncServerAddress | null;
  diagnostics: () => ServerDiagnostics<TRegistry>;
}

export function createSyncServer<
  TRegistry extends SyncTableRegistry,
  TDb extends PgAsyncDatabase<PgQueryResultHKT, RegistryRelations<TRegistry>> = PgAsyncDatabase<
    PgQueryResultHKT,
    RegistryRelations<TRegistry>
  >,
>(options: CreateSyncServerOptions<TRegistry, TDb>): SyncServer<TRegistry, TDb> {
  const db = options.db;
  const router = new FetchRouter();
  let bunServer: BunServerHandle | undefined;

  const status: SyncRuntimeStatus = {
    phase: "ready",
    isRunning: false,
  };

  let address: SyncServerAddress | null = null;
  const operationsLogConfig = resolveOperationsLogConfig(options.operationsLog);
  const operationsLogStartup = options.deployment?.operationsLog ?? "probe";
  // ADR-0030: how operations_log presence is resolved decides whether startup issues a query at all.
  // - "probe" (default): thread the presence probe into the effective config. operations_log is an
  //   *optional* feature (default-enabled), so if logging was requested but the table is absent, disable
  //   it at runtime rather than letting every write fail on a missing table — the documented degradation
  //   (ensureOperationsLogSchema warns and returns `false`). The route awaits `operationsLogReady` before
  //   any logOperation, so the corrected flag is in effect by the time logging runs, and the route holds
  //   this same config object. (Board dogfooding: discarding this boolean 500'd every mutation on a
  //   missing optional table.)
  // - "enabled": assume the table exists — NO query; logging stays on (an actual absence then fails
  //   writes loudly, by design). "disabled": logging off — NO query.
  let operationsLogReady: Promise<void>;
  if (operationsLogStartup === "probe") {
    operationsLogReady = ensureOperationsLogSchema(db, operationsLogConfig).then((present) => {
      operationsLogConfig.enabled = operationsLogConfig.enabled && present;
    });
  } else {
    if (operationsLogStartup === "disabled") {
      operationsLogConfig.enabled = false;
    }
    operationsLogReady = Promise.resolve();
  }

  // CORS covers the canonical /api/* routes, plus the native control plane's own /sync/v1/* prefix.
  const corsScopes: CorsScope[] = [{ prefix: "/api/" }];
  if (options.readPath) {
    corsScopes.push({ prefix: "/sync/v1/" });
  }
  router.setCors(
    {
      origins: options.allowedOrigins ?? defaultAllowedOrigins,
      allowMethods: ["GET", "POST", "OPTIONS"],
      // `apikey`: a deployment gateway (Supabase) expects it on every request, so the browser client
      // sends it; it must be allowed in the preflight even though the server itself ignores it.
      allowHeaders: ["Content-Type", "Authorization", "apikey"],
    },
    corsScopes,
  );

  router.setErrorHandler((error) => {
    status.phase = "degraded";
    status.lastError = error instanceof Error ? error.message : "Unexpected error";
    options.onStatusChange?.(status);

    if (isValidationError(error)) {
      return Response.json({ message: "Validation failed", issues: error.issues }, { status: 400 });
    }

    return Response.json({ message: error instanceof Error ? error.message : "Unexpected error" }, { status: 500 });
  });

  const healthCheckPath = resolveHealthCheckPath(options.healthCheck, true);
  if (healthCheckPath) {
    router.get(healthCheckPath, () => Response.json({ ok: true }));
  }

  // The single mutation ingress point — all writes go through POST /api/mutations.
  const mutationHandlers = createMutationHandler(
    db,
    options.registry,
    operationsLogConfig,
    operationsLogReady,
    options.resolveAuthClaims,
    options.deployment?.startupVerification ?? "in-process",
    options.logTimings ?? false,
    options.applyFunctionGrantExecuteTo ?? [],
    options.applyFunctionSchema,
  );
  for (const path of batchMutationPaths) {
    router.post(path, mutationHandlers.batch);
  }
  for (const path of authoritativeMutationPaths) {
    router.post(path, mutationHandlers.authoritative);
  }

  // The Event lane's ingestion endpoint (ADR-0053 decision 3), mounted ONLY when the registry registers at
  // least one Event stream — a registry without streams has no event lane, and the path stays a 404. Nothing
  // is probed or provisioned here: the queues are deploy-time DDL (`pgxsinkit-generate --events`), so the
  // route preserves the zero-startup-query posture.
  const eventStreams = getSyncRegistryStreams(options.registry);
  if (eventStreams && Object.keys(eventStreams).length > 0) {
    const eventQueue = options.eventQueue ?? createPgmqEventQueue({ db });
    const eventHandler = createEventIngestHandler(db, options.registry, eventQueue, {
      ...(options.resolveAuthClaims ? { resolveAuthClaims: options.resolveAuthClaims } : {}),
      ...(options.eventGate ? { eventGate: options.eventGate } : {}),
      ...(options.onEventsEnqueued ? { onEventsEnqueued: options.onEventsEnqueued } : {}),
      logTimings: options.logTimings ?? false,
    });
    for (const path of batchEventPaths) {
      router.post(path, eventHandler);
    }
  }

  // The native control plane (ADR-0055). It shares the same resolveAuthClaims adapter as the write
  // path, so read and write authorization can never diverge (ADR-0003).
  //
  // Note what is NOT here: any route that serves shape DATA. Reads terminate on durable-streams
  // through the edge, which is the whole point of the topology — this process is asked once, at
  // subscribe time, and is then out of the read path entirely.
  if (options.readPath) {
    const readPath = options.readPath;
    const resolveAuthClaims = options.resolveAuthClaims;
    // Refused at construction, not at the first subscribe. Every read is bound to a subject in both
    // tiers (ADR-0055): the private tier fuses it into the predicate and the shared tier checks it
    // against the entitlement set, and a stream token with no subject would name a bearer no
    // revocation could ever reach. So a read path with no way to resolve a subject cannot grant
    // anything — it is a contradiction, and the only useful moment to say so is now, rather than as
    // a 401 every client then sits in.
    if (resolveAuthClaims === undefined) {
      throw new Error(
        "[pgxsinkit] createSyncServer: `readPath` was configured without `resolveAuthClaims`. The native " +
          "read path mints a per-subject stream token, so it cannot serve a deployment that has no way to " +
          "resolve a subject. Provide `resolveAuthClaims`, or drop `readPath` for a write-only deployment.",
      );
    }
    const subscribeOptions = {
      registry: options.registry,
      engine: readPath.engine,
      ...(readPath.entitlements ? { entitlements: readPath.entitlements } : {}),
      key: readPath.key,
      ...(readPath.ttlSeconds !== undefined ? { ttlSeconds: readPath.ttlSeconds } : {}),
      resolveAuthClaims,
    };

    router.post(subscribePath, createSubscribeHandler(subscribeOptions));
    router.post(refreshPath, createRefreshHandler(subscribeOptions));
    // The close half of subscribe. Every grant subscribe handed out is a named claim on an engine
    // shape, and a live claim blocks dormancy and eviction — so without this route every shape waits
    // out its full lease window before it can be reclaimed. The release is idempotent (each grant
    // names its own claim), and a release that never arrives is reclaimed by the lease anyway; see
    // `releaseStreamGrants`.
    router.post(releasePath, createReleaseHandler({ engine: readPath.engine, key: readPath.key, resolveAuthClaims }));
    router.get(
      barrierPath,
      createBarrierHandler({
        engine: readPath.engine,
        resolveAuthClaims,
        ...(readPath.barrierMaxAgeSeconds !== undefined ? { maxAgeSeconds: readPath.barrierMaxAgeSeconds } : {}),
      }),
    );
  }

  const fetch = router.fetch;

  return {
    drizzle: db,
    fetch,
    request: (path, init) => {
      const baseUrl = address === null ? "http://localhost" : `http://${address.host}:${address.port}`;
      return fetch(new Request(new URL(path, baseUrl).toString(), init));
    },
    start: async () => {
      if (bunServer) {
        return;
      }

      const bun = getBunNamespace();
      if (!bun) {
        throw new Error("createSyncServer.start() requires the Bun runtime");
      }

      const host = options.host ?? "0.0.0.0";
      const port = options.port ?? 3001;
      const idleTimeout = options.idleTimeoutSeconds;

      bunServer = bun.serve({
        hostname: host,
        port,
        ...(idleTimeout !== undefined ? { idleTimeout } : {}),
        fetch,
      });

      status.isRunning = true;
      status.phase = "ready";
      delete status.lastError;
      address = { host, port };
      options.onStatusChange?.(status);
    },
    stop: async () => {
      bunServer?.stop();
      bunServer = undefined;
      status.isRunning = false;
      options.onStatusChange?.(status);
    },
    status,
    get address() {
      return address;
    },
    diagnostics: () => ({
      tables: Object.keys(options.registry) as Array<keyof TRegistry & string>,
      modes: Object.fromEntries(Object.entries(options.registry).map(([key, entry]) => [key, entry.mode])),
    }),
  };
}

export function buildRegistrySchema<TRegistry extends SyncTableRegistry>(
  registry: TRegistry,
): RegistryTables<TRegistry> {
  return Object.fromEntries(
    Object.entries(registry).map(([key, entry]) => [key, entry.table]),
  ) as RegistryTables<TRegistry>;
}

function resolveHealthCheckPath(config?: boolean | { path: string }, defaultEnabled = false): string | null {
  if (config === false) {
    return null;
  }

  if (config === undefined && !defaultEnabled) {
    return null;
  }

  if (typeof config === "object" && "path" in config) {
    return config.path;
  }

  return "/health";
}

function getBunNamespace(): BunNamespace | undefined {
  const maybeBun = (globalThis as { Bun?: BunNamespace }).Bun;
  return maybeBun;
}

function isValidationError(error: unknown): error is { issues: unknown[] } {
  return typeof error === "object" && error !== null && "issues" in error && Array.isArray(error.issues);
}

function resolveOperationsLogConfig(options?: { enabled?: boolean }): OperationsLogConfig {
  return {
    enabled: options?.enabled ?? true,
  };
}

export { authoritativeMutationPaths, batchMutationPaths, createMutationHandler } from "./mutations/route";
export type { StartupVerificationMode } from "./mutations/route";
export type { CorsConfig, CorsScope, FetchHandler, RouterErrorHandler } from "./router";
export { FetchRouter } from "./router";
export { buildPlpgsqlBatchFunctionDdl, expectedApplyFingerprint } from "./mutations/plpgsql-apply";
export type { ApplyFunctionRenderOptions } from "./mutations/plpgsql-apply";
export { renderPgxsinkitUtilitiesMigration } from "./migrations/utilities";
export { ensureOperationsLogSchema, operationsLogRegclassTarget } from "./operations-log/ddl";
export { operationsLogTable } from "./operations-log/schema";
export { readSqlState } from "./sql-state";
export {
  createEventIngestHandler,
  eventIngestRequiresClaims,
  EVENT_QUEUE_UNAVAILABLE_RETRY_AFTER_SECONDS,
} from "./events/route";
export type {
  CreateEventIngestHandlerOptions,
  EventGate,
  EventGateDecision,
  EventGateInput,
  EventIngestDb,
  EventsEnqueuedHook,
  EventsEnqueuedInfo,
} from "./events/route";
export { assertEventQueueReceipts, eventStreamQueueName, MalformedEventQueueMessageError } from "./events/queue";
export type {
  DeadLetteredEventMessage,
  DeliveredEventMessage,
  EventQueue,
  EventQueueExecutor,
  EventQueueReadOptions,
  EventQueueReceipt,
} from "./events/queue";
export { createPgmqEventQueue, PGMQ_DEAD_LETTER_KEY } from "./events/pgmq-queue";
export type { CreatePgmqEventQueueOptions } from "./events/pgmq-queue";
export {
  computeEventPollWaitMs,
  defineEventConsumer,
  DEFAULT_EVENT_CONSUMER_BATCH_SIZE,
  DEFAULT_EVENT_DRAIN_BUDGET_MS,
  DEFAULT_EVENT_MAX_ATTEMPTS,
  DEFAULT_EVENT_POLL_CEILING_MS,
  DEFAULT_EVENT_POLL_FACTOR,
  DEFAULT_EVENT_POLL_FLOOR_MS,
  DEFAULT_EVENT_VISIBILITY_TIMEOUT_SECONDS,
} from "./events/consumer";
export type {
  DefineEventConsumerOptions,
  EventConsumer,
  EventConsumerBatch,
  EventConsumerCallback,
  EventConsumerPollOptions,
  EventConsumerSleep,
  EventDeadLetterReport,
  EventDrainOptions,
  EventDrainSummary,
} from "./events/consumer";
export {
  EVENT_LANE_FINGERPRINT_PREFIX,
  eventLaneDdlFingerprint,
  eventLaneStreamNames,
  renderEventLaneMigration,
} from "./events/ddl";
export { resolveEventIdentity } from "./events/identity";
export type { IdentityResolution } from "./events/identity";

// The Circuits-native read path (ADR-0055) — shape lifecycle only. Reads terminate on
// durable-streams and never traverse the engine.
export { compileShapeRequest, fingerprintShapeRequest, resolveEntryByShapeKey } from "./circuits/compile";
export type { CompiledShapeRequest, ShapeRequest } from "./circuits/compile";
export { CircuitsEngineError, createCircuitsEngineClient } from "./circuits/engine-client";
export type { CircuitsEngineClient, CircuitsEngineOptions } from "./circuits/engine-client";
export type { CircuitsShapeHandle, CreateShapeRequest } from "./circuits/wire";
export {
  DEFAULT_STREAM_TOKEN_TTL_SECONDS,
  findGrant,
  importStreamTokenKey,
  mintStreamToken,
  verifyStreamToken,
} from "./circuits/stream-token";
export type {
  MintStreamTokenOptions,
  VerifyStreamTokenOptions,
  StreamGrant,
  StreamTokenClaims,
  StreamTokenVerification,
} from "./circuits/stream-token";
export {
  authorizeStreamRead,
  createStreamGate,
  EntitlementsUnavailableError,
  readStreamToken,
  STREAM_READ_EXPOSED_HEADERS,
} from "./circuits/edge";
export type { EntitlementSet, GateDecision, StreamAuthorizationOptions, StreamGateOptions } from "./circuits/edge";
export {
  barrierPath,
  CircuitsLeaseConfigError,
  createBarrierHandler,
  createRefreshHandler,
  createReleaseHandler,
  createSubscribeHandler,
  refreshPath,
  refreshStreamToken,
  releasePath,
  releaseStreamGrants,
  subscribePath,
  subscribeToShapes,
} from "./circuits/subscribe";
export type {
  DeniedSubscription,
  GrantedSubscription,
  RefreshResult,
  SubscribeOptions,
  SubscribeResult,
  SubscriptionRequest,
} from "./circuits/subscribe";
