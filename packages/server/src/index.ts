import { eq, sql } from "drizzle-orm";
import type { AnyPgTable } from "drizzle-orm/pg-core";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { drizzle } from "drizzle-orm/postgres-js";
import { Hono } from "hono";
import { cors } from "hono/cors";
import postgres from "postgres";

import type {
  RegistryTables,
  ServerRouteSpec,
  SyncRuntimeStatus,
  SyncServerAddress,
  SyncTableEntry,
  SyncTableRegistry,
} from "@pgxsinkit/contracts";

import { registerBulkMutationRoute } from "./mutations/bulk/route";
import type { BulkMutationBackend } from "./mutations/bulk/types";
import { ensureOperationsLogSchema } from "./operations-log/ddl";
import type { OpsLogBackend, OperationsLogConfig } from "./operations-log/types";
import { logOperation, logOperationSafely } from "./operations-log/writer";

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

export interface CreateSyncServerOptions<TRegistry extends SyncTableRegistry> {
  registry: TRegistry;
  databaseUrl: string;
  backend?: "drizzle" | BulkMutationBackend;
  resolveAuthClaims?: (request: Request) => Promise<Record<string, unknown> | null> | Record<string, unknown> | null;
  operationsLog?: {
    enabled?: boolean;
  };
  port?: number;
  host?: string;
  idleTimeoutSeconds?: number;
  allowedOrigins?: string[];
  onStatusChange?: (status: SyncRuntimeStatus) => void;
}

export interface ServerDiagnostics<TRegistry extends SyncTableRegistry> {
  tables: Array<keyof TRegistry & string>;
  modes: Record<string, TRegistry[keyof TRegistry]["mode"]>;
  routes: Record<string, ServerRouteSpec | undefined>;
}

export interface SyncServer<TRegistry extends SyncTableRegistry> {
  drizzle: PostgresJsDatabase<RegistryTables<TRegistry>>;
  fetch: (request: Request) => Promise<Response>;
  request: (path: string, init?: RequestInit) => Promise<Response>;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  status: SyncRuntimeStatus;
  address: SyncServerAddress | null;
  diagnostics: () => ServerDiagnostics<TRegistry>;
}

export function createSyncServer<TRegistry extends SyncTableRegistry>(
  options: CreateSyncServerOptions<TRegistry>,
): SyncServer<TRegistry> {
  const client = createPostgresClient(options.databaseUrl);
  const schema = buildSchema(options.registry);
  const db = drizzle({ client, schema });
  const app = new Hono();
  let bunServer: BunServerHandle | undefined;

  const status: SyncRuntimeStatus = {
    phase: "ready",
    isRunning: false,
  };

  let address: SyncServerAddress | null = null;
  const operationsLogConfig = resolveOperationsLogConfig(options.operationsLog);
  const operationsLogReady = ensureOperationsLogSchema(db, operationsLogConfig);
  const backend = options.backend ?? "drizzle";

  app.use(
    "/api/*",
    cors({
      origin: options.allowedOrigins ?? defaultAllowedOrigins,
      allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization"],
    }),
  );

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

  app.get("/health", (context) => {
    return context.json({ ok: true });
  });

  for (const [tableKey, entry] of Object.entries(options.registry)) {
    registerTableRoutes(app, db, tableKey, entry, {
      backend,
      operationsLogConfig,
      operationsLogReady,
    });
  }

  if (backend !== "drizzle") {
    registerBulkMutationRoute(
      app,
      db,
      options.registry,
      backend,
      operationsLogConfig,
      operationsLogReady,
      options.resolveAuthClaims,
    );
  }

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
      await client.end();
      options.onStatusChange?.(status);
    },
    status,
    get address() {
      return address;
    },
    diagnostics: () => ({
      tables: Object.keys(options.registry) as Array<keyof TRegistry & string>,
      modes: Object.fromEntries(Object.entries(options.registry).map(([key, entry]) => [key, entry.mode])),
      routes: Object.fromEntries(Object.entries(options.registry).map(([key, entry]) => [key, entry.routes])),
    }),
  };
}

function createPostgresClient(connectionString: string) {
  const url = new URL(connectionString);
  const sslmode = url.searchParams.get("sslmode");

  return postgres({
    host: url.hostname,
    port: Number(url.port || "5432"),
    database: url.pathname.replace(/^\//, ""),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    ssl: sslmode === "disable" ? false : "prefer",
    max: 10,
  });
}

function buildSchema<TRegistry extends SyncTableRegistry>(registry: TRegistry) {
  return Object.fromEntries(
    Object.entries(registry).map(([key, entry]) => [key, entry.table]),
  ) as RegistryTables<TRegistry>;
}

function registerTableRoutes<TRegistry extends SyncTableRegistry>(
  app: Hono,
  db: PostgresJsDatabase<RegistryTables<TRegistry>>,
  tableKey: string,
  entry: SyncTableEntry<AnyPgTable>,
  options: {
    backend: OpsLogBackend;
    operationsLogConfig: OperationsLogConfig;
    operationsLogReady: Promise<void>;
  },
) {
  const basePath = entry.routes?.basePath;

  if (!basePath) {
    return;
  }

  const primaryKeyColumnName = getSinglePrimaryKeyColumnName(entry, tableKey);
  const primaryKeyColumn = getTableColumn(entry.table, primaryKeyColumnName, tableKey);
  const crudWritesAllowed = options.backend !== "bulk-plpgsql-artifact";

  if (entry.mode !== "writeonly") {
    app.get(basePath, async (context) => {
      const rows = await db.select().from(entry.table);
      return context.json(parseRows(entry, rows));
    });
  }

  if (entry.mode !== "readonly") {
    if (!crudWritesAllowed) {
      registerMethodNotAllowed(app, basePath, ["POST", "PATCH", "DELETE"], tableKey);
      registerMethodNotAllowed(app, `${basePath}/:id`, ["PATCH", "DELETE"], tableKey);
      return;
    }

    app.post(basePath, async (context) => {
      await options.operationsLogReady;

      const requestBody = await context.req.json();
      let payload: unknown;

      try {
        payload = parseCreatePayload(entry, requestBody);
      } catch (error) {
        await logOperationSafely(db, options.operationsLogConfig, {
          source: "crud",
          backend: options.backend,
          tableName: tableKey,
          operationKind: "create",
          entityKey: extractEntityKeyFromRecord(entry, requestBody),
          payload: requestBody,
          status: "validation_failed",
          errorMessage: error instanceof Error ? error.message : "Validation failed",
          httpStatus: 400,
          requestPath: context.req.path,
        });

        return context.json(
          {
            message: "Validation failed",
            issues: isValidationError(error) ? error.issues : [],
          },
          400,
        );
      }

      try {
        const insertedRow = await db.transaction(async (tx) => {
          const inserted = await tx
            .insert(entry.table)
            .values(payload as never)
            .returning();

          const row = inserted[0];
          if (!row) {
            throw new Error(`Failed to insert ${tableKey}`);
          }

          await logOperation(tx, options.operationsLogConfig, {
            source: "crud",
            backend: options.backend,
            tableName: tableKey,
            operationKind: "create",
            entityKey: extractEntityKeyFromRecord(entry, row),
            payload,
            status: "succeeded",
            httpStatus: 201,
            requestPath: context.req.path,
          });

          return row;
        });

        return context.json(parseRow(entry, insertedRow), 201);
      } catch (error) {
        await logOperationSafely(db, options.operationsLogConfig, {
          source: "crud",
          backend: options.backend,
          tableName: tableKey,
          operationKind: "create",
          entityKey: extractEntityKeyFromRecord(entry, payload),
          payload,
          status: "execution_failed",
          errorMessage: error instanceof Error ? error.message : "Execution failed",
          httpStatus: 500,
          requestPath: context.req.path,
        });

        throw error;
      }
    });

    app.patch(`${basePath}/:id`, async (context) => {
      await options.operationsLogReady;

      const id = context.req.param("id");
      const entityKey = {
        [primaryKeyColumnName]: id,
      };
      const requestBody = await context.req.json();
      let payload: unknown;

      try {
        payload = parseUpdatePayload(entry, requestBody);
      } catch (error) {
        await logOperationSafely(db, options.operationsLogConfig, {
          source: "crud",
          backend: options.backend,
          tableName: tableKey,
          operationKind: "update",
          entityKey,
          payload: requestBody,
          status: "validation_failed",
          errorMessage: error instanceof Error ? error.message : "Validation failed",
          httpStatus: 400,
          requestPath: context.req.path,
        });

        return context.json(
          {
            message: "Validation failed",
            issues: isValidationError(error) ? error.issues : [],
          },
          400,
        );
      }

      try {
        const updatedRow = await db.transaction(async (tx) => {
          const updated = await tx
            .update(entry.table)
            .set(withUpdatedAtUs(entry.table, payload))
            .where(eq(primaryKeyColumn, id))
            .returning();

          if (updated.length === 0) {
            await logOperation(tx, options.operationsLogConfig, {
              source: "crud",
              backend: options.backend,
              tableName: tableKey,
              operationKind: "update",
              entityKey,
              payload,
              status: "not_found",
              httpStatus: 404,
              requestPath: context.req.path,
            });

            return null;
          }

          const row = updated[0]!;

          await logOperation(tx, options.operationsLogConfig, {
            source: "crud",
            backend: options.backend,
            tableName: tableKey,
            operationKind: "update",
            entityKey: extractEntityKeyFromRecord(entry, row) ?? entityKey,
            payload,
            status: "succeeded",
            httpStatus: 200,
            requestPath: context.req.path,
          });

          return row;
        });

        if (updatedRow === null) {
          return context.json({ message: `${tableKey} record not found` }, 404);
        }

        return context.json(parseRow(entry, updatedRow));
      } catch (error) {
        await logOperationSafely(db, options.operationsLogConfig, {
          source: "crud",
          backend: options.backend,
          tableName: tableKey,
          operationKind: "update",
          entityKey,
          payload,
          status: "execution_failed",
          errorMessage: error instanceof Error ? error.message : "Execution failed",
          httpStatus: 500,
          requestPath: context.req.path,
        });

        throw error;
      }
    });

    app.delete(`${basePath}/:id`, async (context) => {
      await options.operationsLogReady;

      const id = context.req.param("id");
      const entityKey = {
        [primaryKeyColumnName]: id,
      };

      try {
        const deleted = await db.transaction(async (tx) => {
          const deletedRows = await tx.delete(entry.table).where(eq(primaryKeyColumn, id)).returning();

          if (deletedRows.length === 0) {
            await logOperation(tx, options.operationsLogConfig, {
              source: "crud",
              backend: options.backend,
              tableName: tableKey,
              operationKind: "delete",
              entityKey,
              payload: entityKey,
              status: "not_found",
              httpStatus: 404,
              requestPath: context.req.path,
            });

            return false;
          }

          await logOperation(tx, options.operationsLogConfig, {
            source: "crud",
            backend: options.backend,
            tableName: tableKey,
            operationKind: "delete",
            entityKey,
            payload: entityKey,
            status: "succeeded",
            httpStatus: 204,
            requestPath: context.req.path,
          });

          return true;
        });

        if (!deleted) {
          return context.json({ message: `${tableKey} record not found` }, 404);
        }

        return context.body(null, 204);
      } catch (error) {
        await logOperationSafely(db, options.operationsLogConfig, {
          source: "crud",
          backend: options.backend,
          tableName: tableKey,
          operationKind: "delete",
          entityKey,
          payload: entityKey,
          status: "execution_failed",
          errorMessage: error instanceof Error ? error.message : "Execution failed",
          httpStatus: 500,
          requestPath: context.req.path,
        });

        throw error;
      }
    });
  }
}

function getSinglePrimaryKeyColumnName(entry: SyncTableEntry, tableKey: string) {
  if (entry.primaryKey.columns.length !== 1) {
    throw new Error(`@pgxsinkit/server currently supports single-column primary keys only: ${tableKey}`);
  }

  return entry.primaryKey.columns[0]!;
}

function getTableColumn(table: AnyPgTable, columnName: string, tableKey: string) {
  const column = (table as unknown as Record<string, unknown>)[columnName];

  if (!column) {
    throw new Error(`Primary key column ${columnName} was not found on table ${tableKey}`);
  }

  return column as never;
}

function parseCreatePayload(entry: SyncTableEntry, input: unknown) {
  return entry.schemas?.createSchema ? entry.schemas.createSchema.parse(input) : input;
}

function parseUpdatePayload(entry: SyncTableEntry, input: unknown) {
  return entry.schemas?.updateSchema ? entry.schemas.updateSchema.parse(input) : input;
}

function registerMethodNotAllowed(app: Hono, path: string, methods: string[], tableKey: string) {
  for (const method of methods) {
    app.on(method as "POST" | "PATCH" | "DELETE", path, (context) => {
      context.header("Allow", "GET, OPTIONS");

      return context.json(
        {
          message: `CRUD ${method} routes are disabled for ${tableKey} when WRITE_API_BACKEND=bulk-plpgsql-artifact. Use POST /api/mutations instead.`,
        },
        405,
      );
    });
  }
}

function parseRows(entry: SyncTableEntry, rows: unknown[]) {
  return rows.map((row) => parseRow(entry, row));
}

function parseRow(entry: SyncTableEntry, row: unknown) {
  const normalized = normalizeBigInts(row);
  return entry.schemas?.recordSchema ? entry.schemas.recordSchema.parse(normalized) : normalized;
}

function withUpdatedAtUs(table: AnyPgTable, payload: unknown) {
  const values = {
    ...(isRecord(payload) ? payload : {}),
  };

  if ("updatedAtUs" in table) {
    values.updatedAtUs = sql`CAST(FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000000) AS BIGINT)`;
  }

  return values as never;
}

function normalizeBigInts(value: unknown): unknown {
  if (typeof value === "bigint") {
    return value.toString();
  }

  if (Array.isArray(value)) {
    return value.map((entry) => normalizeBigInts(entry));
  }

  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, normalizeBigInts(entry)]));
  }

  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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

function extractEntityKeyFromRecord(entry: SyncTableEntry, value: unknown): Record<string, string> | null {
  if (!isRecord(value)) {
    return null;
  }

  const entityKey: Record<string, string> = {};

  for (const primaryKeyColumn of entry.primaryKey.columns) {
    const rawValue = value[primaryKeyColumn];

    if (rawValue === undefined || rawValue === null) {
      return null;
    }

    if (
      typeof rawValue === "string" ||
      typeof rawValue === "number" ||
      typeof rawValue === "bigint" ||
      typeof rawValue === "boolean"
    ) {
      entityKey[primaryKeyColumn] = String(rawValue);
      continue;
    }

    return null;
  }

  return entityKey;
}
