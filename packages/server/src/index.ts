import type { PgAsyncDatabase } from "drizzle-orm/pg-core";
import { Hono } from "hono";
import { cors } from "hono/cors";

import type {
  RegistryRelations,
  RegistryTables,
  SyncRuntimeStatus,
  SyncServerAddress,
  SyncTableRegistry,
} from "@pgxsinkit/contracts";

import { registerBulkMutationRoute } from "./mutations/bulk/route";
import type { BulkMutationBackend } from "./mutations/bulk/types";
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
  TDb extends PgAsyncDatabase<any, RegistryRelations<TRegistry>> = PgAsyncDatabase<any, RegistryRelations<TRegistry>>,
> {
  registry: TRegistry;
  db: TDb;
  /** Existing Hono app to register routes on. If omitted, a new Hono app is created. */
  app?: Hono;
  backend?: BulkMutationBackend;
  resolveAuthClaims?: (request: Request) => Promise<Record<string, unknown> | null> | Record<string, unknown> | null;
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
  TDb extends PgAsyncDatabase<any, RegistryRelations<TRegistry>> = PgAsyncDatabase<any, RegistryRelations<TRegistry>>,
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
  TDb extends PgAsyncDatabase<any, RegistryRelations<TRegistry>> = PgAsyncDatabase<any, RegistryRelations<TRegistry>>,
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
  const operationsLogReady = ensureOperationsLogSchema(db, operationsLogConfig).then(() => {});
  const backend = options.backend ?? "bulk-plpgsql-artifact";

  if (ownsApp) {
    const corsMiddleware = cors({
      origin: options.allowedOrigins ?? defaultAllowedOrigins,
      allowMethods: ["GET", "POST", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization"],
    });

    app.use("/api/*", corsMiddleware);
    app.use("/mutations", corsMiddleware);

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
  registerBulkMutationRoute(
    app,
    db,
    options.registry,
    backend,
    operationsLogConfig,
    operationsLogReady,
    options.resolveAuthClaims,
  );

  const fetch = async (request: Request) => app.fetch(request);

  return {
    drizzle: db,
    fetch,
    request: (path, init) => {
      const baseUrl = address === null ? "http://localhost" : `http://${address.host}:${address.port}`;
      return fetch(new Request(new URL(path, baseUrl), init));
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

export { registerBulkMutationRoute } from "./mutations/bulk/route";
export { buildPlpgsqlBatchFunctionDdl } from "./mutations/bulk/plpgsql-strategy";
export { ensureOperationsLogSchema } from "./operations-log/ddl";
export { operationsLogTable } from "./operations-log/schema";
export { proxyElectricShapeRequest } from "./electric-proxy";
export type { ElectricProxyOptions } from "./electric-proxy";
