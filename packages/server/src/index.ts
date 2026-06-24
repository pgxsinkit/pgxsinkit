import type { PgAsyncDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { Hono } from "hono";
import { cors } from "hono/cors";

import type {
  JwtClaims,
  RegistryRelations,
  RegistryTables,
  SyncRuntimeStatus,
  SyncServerAddress,
  SyncTableRegistry,
} from "@pgxsinkit/contracts";

import { proxyElectricShapeRequest } from "./electric-proxy";
import { registerMutationRoute } from "./mutations/route";
import { ensureOperationsLogSchema } from "./operations-log/ddl";
import type { OperationsLogConfig } from "./operations-log/types";

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
  /** Existing Hono app to register routes on. If omitted, a new Hono app is created. */
  app?: Hono;
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
  /** Health check endpoint. Only applies when pgxsinkit owns the Hono app. */
  healthCheck?: boolean | { path: string };
  port?: number;
  host?: string;
  idleTimeoutSeconds?: number;
  allowedOrigins?: string[];
  onStatusChange?: (status: SyncRuntimeStatus) => void;
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
  const ownsApp = !options.app;
  const db = options.db;
  const app = options.app ?? new Hono();
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

  if (ownsApp) {
    const corsMiddleware = cors({
      origin: options.allowedOrigins ?? defaultAllowedOrigins,
      allowMethods: ["GET", "POST", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization"],
    });

    app.use("/api/*", corsMiddleware);
    app.use("/mutations", corsMiddleware);

    if (options.electricUrl) {
      app.use(options.shapeProxyPath ?? "/api/shape", corsMiddleware);
    }

    app.onError((error, context) => {
      status.phase = "degraded";
      status.lastError = error instanceof Error ? error.message : "Unexpected error";
      options.onStatusChange?.(status);

      if (isValidationError(error)) {
        return context.json(
          {
            message: "Validation failed",
            issues: error.issues,
          },
          400,
        );
      }

      return context.json(
        {
          message: error instanceof Error ? error.message : "Unexpected error",
        },
        500,
      );
    });

    const healthCheckPath = resolveHealthCheckPath(options.healthCheck, true);

    if (healthCheckPath) {
      app.get(healthCheckPath, (context) => {
        return context.json({ ok: true });
      });
    }
  }

  // The single mutation ingress point — all writes go through POST /api/mutations
  registerMutationRoute(app, db, options.registry, operationsLogConfig, operationsLogReady, options.resolveAuthClaims);

  // The read-path shape proxy shares the same resolveAuthClaims adapter, so read and
  // write authorization can never diverge (ADR-0003).
  if (options.electricUrl) {
    const shapeProxyPath = options.shapeProxyPath ?? "/api/shape";
    const electricUrl = options.electricUrl;
    const resolveAuthClaims = options.resolveAuthClaims;
    const resolveShapeParams = options.resolveShapeParams;
    app.get(shapeProxyPath, async (context) => {
      const claims = resolveAuthClaims ? await resolveAuthClaims(context.req.raw) : null;
      const extraParams = resolveShapeParams?.(context.req.raw);
      return proxyElectricShapeRequest(context.req.raw, claims, {
        registry: options.registry,
        electricUrl,
        ...(extraParams ? { extraParams } : {}),
      });
    });
  }

  const fetch = async (request: Request) => app.fetch(request);

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

      if (!ownsApp) {
        throw new Error("createSyncServer.start() requires pgxsinkit to own the Hono app (no external app provided)");
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
        fetch: app.fetch,
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

export { registerMutationRoute } from "./mutations/route";
export { buildPlpgsqlBatchFunctionDdl } from "./mutations/plpgsql-apply";
export { ensureOperationsLogSchema } from "./operations-log/ddl";
export { operationsLogTable } from "./operations-log/schema";
export { proxyElectricShapeRequest } from "./electric-proxy";
export type { ElectricProxyOptions } from "./electric-proxy";
