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
import type { ApplyFunctionDriftCheck } from "./mutations/plpgsql-apply";
import { batchMutationPaths, createMutationHandler } from "./mutations/route";
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
   * What to do at startup if the installed `pgxsinkit_apply_mutations` function does not match the
   * current registry + applier codegen (ADR-0018). Defaults to `"error"` (refuse to serve writes
   * against a stale applier). Use `"warn"`/`"off"` only for deploy orders that update the function a
   * beat after the server. An unfingerprinted function (older pgxsinkit) is never treated as drift.
   */
  applyFunctionDriftCheck?: ApplyFunctionDriftCheck;
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
  // Thread the presence probe into the effective config. operations_log is an *optional* feature
  // (default-enabled), so if logging was requested but the table is absent, disable it at runtime
  // rather than letting every write fail on a missing table — the documented degradation
  // (ensureOperationsLogSchema warns and returns `false`). The route awaits `operationsLogReady`
  // before any logOperation, so the corrected flag is in effect by the time logging runs, and the
  // route holds this same config object. (Board dogfooding finding: discarding this boolean made a
  // missing optional table 500 every mutation.)
  const operationsLogReady = ensureOperationsLogSchema(db, operationsLogConfig).then((present) => {
    operationsLogConfig.enabled = operationsLogConfig.enabled && present;
  });

  const shapeProxyPath = options.shapeProxyPath ?? "/api/shape";

  // CORS mirrors the previous middleware scopes: everything under /api/*, the /mutations alias, and
  // the shape proxy path (which may be relocated outside /api/).
  const corsScopes: CorsScope[] = [{ prefix: "/api/" }, { exact: "/mutations" }];
  if (options.electricUrl) {
    corsScopes.push({ exact: shapeProxyPath });
  }
  router.setCors(
    {
      origins: options.allowedOrigins ?? defaultAllowedOrigins,
      allowMethods: ["GET", "POST", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization"],
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

  // The single mutation ingress point — all writes go through POST /api/mutations (and the /mutations alias).
  const mutationHandler = createMutationHandler(
    db,
    options.registry,
    operationsLogConfig,
    operationsLogReady,
    options.resolveAuthClaims,
    options.applyFunctionDriftCheck,
  );
  for (const path of batchMutationPaths) {
    router.post(path, mutationHandler);
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

export { batchMutationPaths, createMutationHandler } from "./mutations/route";
export type { CorsConfig, CorsScope, FetchHandler, RouterErrorHandler } from "./router";
export { FetchRouter } from "./router";
export { buildPlpgsqlBatchFunctionDdl, expectedApplyFingerprint } from "./mutations/plpgsql-apply";
export type { ApplyFunctionDriftCheck } from "./mutations/plpgsql-apply";
export { ensureOperationsLogSchema } from "./operations-log/ddl";
export { operationsLogTable } from "./operations-log/schema";
export { proxyElectricShapeRequest } from "./electric-proxy";
export type { ElectricProxyOptions } from "./electric-proxy";
