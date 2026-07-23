import type { PgAsyncDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import type {
  JwtClaims,
  RegistryRelations,
  RegistryTables,
  SyncRuntimeStatus,
  SyncServerAddress,
  SyncTableRegistry,
} from "@pgxsinkit/contracts";

import { proxyElectricShapeRequest } from "./electric-proxy";
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
   * When set, the server serves a read-path Electric shape proxy that shares the
   * single `resolveAuthClaims` adapter with the write path (ADR-0003). Without it,
   * no shape proxy is registered.
   */
  electricUrl?: string;
  /** Path for the shape proxy route. Defaults to `/api/shape`. */
  shapeProxyPath?: string;
  /** Optional per-request extra params passed to customWhere/shared filters. */
  resolveShapeParams?: (request: Request) => Record<string, unknown> | undefined;
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
   * Opt-in per-request timing log (default false). When on, each mutation and shape-proxy request emits
   * one compact `[pgxsinkit-timing]` line with an ISO-8601(ms, UTC) timestamp and phase durations, for
   * attributing wall-clock latency against the client's `syncDebug` lines. Off by default — a pure
   * diagnostic surface that adds no standing query or latency when unset.
   */
  logTimings?: boolean;
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

  const shapeProxyPath = options.shapeProxyPath ?? "/api/shape";

  // CORS covers the canonical /api/* routes and the shape proxy path when it is relocated outside /api/.
  const corsScopes: CorsScope[] = [{ prefix: "/api/" }];
  if (options.electricUrl) {
    corsScopes.push({ exact: shapeProxyPath });
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
  );
  for (const path of batchMutationPaths) {
    router.post(path, mutationHandlers.batch);
  }
  for (const path of authoritativeMutationPaths) {
    router.post(path, mutationHandlers.authoritative);
  }

  // The read-path shape proxy shares the same resolveAuthClaims adapter, so read and
  // write authorization can never diverge (ADR-0003).
  if (options.electricUrl) {
    const electricUrl = options.electricUrl;
    const resolveAuthClaims = options.resolveAuthClaims;
    const resolveShapeParams = options.resolveShapeParams;
    router.get(shapeProxyPath, async (request) => {
      const claims = resolveAuthClaims ? await resolveAuthClaims(request) : null;
      const extraParams = resolveShapeParams?.(request);
      return proxyElectricShapeRequest(request, claims, {
        registry: options.registry,
        electricUrl,
        ...(extraParams ? { extraParams } : {}),
        ...(options.logTimings ? { logTimings: true } : {}),
      });
    });
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
export { renderPgxsinkitUtilitiesMigration } from "./migrations/utilities";
export { ensureOperationsLogSchema, operationsLogRegclassTarget } from "./operations-log/ddl";
export { operationsLogTable } from "./operations-log/schema";
export { proxyElectricShapeRequest } from "./electric-proxy";
export type { ElectricProxyOptions } from "./electric-proxy";
export { readSqlState } from "./sql-state";
