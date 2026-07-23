import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";
import { PgDialect, type AnyPgTable } from "drizzle-orm/pg-core";
import { getColumns } from "drizzle-orm/utils";
import { createSchemaFactory } from "drizzle-orm/zod";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";

import {
  batchMutationRequestSchema,
  buildOwnershipShapeWhere,
  quoteIdentifier as quoteIdent,
  type BatchMutationRequest,
  type MutationAck,
  type SyncTableEntry,
  type SyncTableRegistry,
} from "@pgxsinkit/contracts";
import {
  buildSyntheticCreatePayload,
  buildSyntheticGovernanceSql,
  buildSyntheticRegistry,
  buildSyntheticRegistrySchemaName,
  buildSyntheticServerSchemaSql,
  buildSyntheticTruncateSql,
  countSyntheticWorkloadRows,
  defaultSyntheticPerfLabScenario,
  demoJwtHasRole,
  findSyntheticPerfLabScenarioDefinition,
  syntheticPerfLabScenarioDefinitions,
  type DemoJwtClaims,
} from "@pgxsinkit/schema";

import { parseDemoAuthClaimsFromRequest } from "../apps/write-api/src/demo-auth";
import {
  buildPlpgsqlBatchFunctionDdl,
  executePlpgsqlBatch,
  expectedApplyFingerprint,
} from "../packages/server/src/mutations/plpgsql-apply";
import type { TransactionClient } from "../packages/server/src/mutations/types";
import {
  PERF_LAB_DATABASE_URL,
  PERF_LAB_ELECTRIC_URL,
  PERF_LAB_HOST,
  PERF_LAB_WRITE_API_PORT,
} from "./perf-lab-config";

const { createInsertSchema: createMutationInsertSchema } = createSchemaFactory({
  coerce: { date: true },
});

type PerfLabReadQueryClient = Pick<typeof adminDb, "select">;

const allowedOrigins = ["http://localhost:5174", "http://127.0.0.1:5174"];

const provisionSchema = z.object({
  tableCount: z.number().int().min(1),
  extraColumnCount: z.number().int().min(1),
});

const seedSchema = z.object({
  rowCount: z.number().int().min(1),
});

type PreparedPerfRegistry = {
  schemaName: string;
  tableCount: number;
  extraColumnCount: number;
  tableNames: string[];
  electricTables: string[];
  registry: SyncTableRegistry;
};

type BunServerHandle = {
  stop: () => void;
};

declare const Bun: {
  serve: (options: {
    hostname?: string;
    port: number;
    idleTimeout?: number;
    fetch: (request: Request) => Response | Promise<Response>;
  }) => BunServerHandle;
};

const databaseUrl = process.env["DATABASE_URL"] ?? PERF_LAB_DATABASE_URL;
const electricUrl = process.env["ELECTRIC_URL"] ?? PERF_LAB_ELECTRIC_URL;
const host = process.env["WRITE_API_HOST"] ?? PERF_LAB_HOST;
const port = readPort(process.env["WRITE_API_PORT"], PERF_LAB_WRITE_API_PORT);

const adminDb = drizzle({ connection: databaseUrl });
const app = new Hono();

const preparedRegistries = new Map<string, PreparedPerfRegistry>();

let activeRegistry: PreparedPerfRegistry | null = null;
let provisionQueue = Promise.resolve();
let shuttingDown = false;

app.use(
  "*",
  cors({
    origin: allowedOrigins,
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
  }),
);

app.get("/health", (context) => {
  return context.json({ ok: true });
});

app.get("/api/perf-lab/status", (context) => {
  if (!activeRegistry) {
    return context.json({ ready: false, scenario: null });
  }

  return context.json({
    ready: true,
    scenario: {
      schemaName: activeRegistry.schemaName,
      tableCount: activeRegistry.tableCount,
      extraColumnCount: activeRegistry.extraColumnCount,
      activeTable: activeRegistry.tableNames[0] ?? null,
    },
  });
});

app.post("/api/perf-lab/provision", async (context) => {
  const body = provisionSchema.parse(await context.req.json());

  await enqueueProvision(async () => {
    activeRegistry = await activateRegistry(body.tableCount, body.extraColumnCount);
  });

  return context.json({
    ok: true,
    schemaName: activeRegistry?.schemaName ?? null,
    activeTable: activeRegistry?.tableNames[0] ?? null,
  });
});

app.post("/api/perf-lab/seed", async (context) => {
  const body = seedSchema.parse(await context.req.json());
  const claims = parseDemoAuthClaimsFromRequest(context.req.raw);

  if (!claims?.sub) {
    return context.json({ message: "Perf-lab remote seeding requires a demo auth token." }, 401);
  }

  if (!activeRegistry) {
    return context.json({ message: "Perf-lab registry is not provisioned yet." }, 409);
  }

  await seedRegistryRows(activeRegistry, body.rowCount, claims);

  return context.json({
    ok: true,
    schemaName: activeRegistry.schemaName,
    activeTable: activeRegistry.tableNames[0] ?? null,
    rowCount: body.rowCount,
  });
});

app.post("/api/mutations", async (context) => {
  if (!activeRegistry) {
    return context.json({ message: "Perf-lab registry is not ready yet." }, 503);
  }

  const currentRegistry = activeRegistry;

  let rawBody: unknown;

  try {
    rawBody = await context.req.json();
  } catch {
    return context.json({ message: "Invalid batch mutation request", issues: [] }, 400);
  }

  let body: BatchMutationRequest;

  try {
    body = batchMutationRequestSchema.parse(rawBody);
  } catch (error) {
    return context.json(
      {
        message: "Invalid batch mutation request",
        issues: isValidationError(error) ? error.issues : [],
      },
      400,
    );
  }

  const validationErrors: string[] = [];

  for (const mutation of body.mutations) {
    const entry = currentRegistry.registry[mutation.tableName];

    if (!entry) {
      validationErrors.push(`Unknown table: ${mutation.tableName}`);
      continue;
    }

    const syncEntry = entry as SyncTableEntry;
    const normalizedPayload = toSchemaPayload(syncEntry, mutation.payload);
    const managedFieldViolations = findManagedFieldViolations(syncEntry, mutation.kind, normalizedPayload);

    if (managedFieldViolations.length > 0) {
      validationErrors.push(
        `${mutation.tableName}/${mutation.mutationId} includes server-managed fields: ${managedFieldViolations.join(", ")}`,
      );
      continue;
    }

    try {
      if (mutation.kind === "update") {
        const payloadKeys =
          typeof normalizedPayload === "object" && normalizedPayload !== null
            ? Object.keys(normalizedPayload as object)
            : [];
        if (payloadKeys.length === 0) {
          throw new Error("At least one field must be provided");
        }
        createMutationInsertSchema(syncEntry.table as AnyPgTable)
          .partial()
          .parse(normalizedPayload);
      } else if (mutation.kind === "create") {
        createMutationInsertSchema(syncEntry.table as AnyPgTable).parse(normalizedPayload);
      }
      // delete has no payload to validate
    } catch (error) {
      const suffix = isValidationError(error) ? ` (${JSON.stringify(error.issues)})` : "";
      validationErrors.push(`${mutation.tableName}/${mutation.mutationId}${suffix}`);
    }
  }

  if (validationErrors.length > 0) {
    return context.json({ message: `Payload validation failed: ${validationErrors.join("; ")}` }, 400);
  }

  const claims = parseDemoAuthClaimsFromRequest(context.req.raw);

  if (!claims?.sub) {
    return context.json({ message: "Perf-lab mutations require a demo auth token." }, 401);
  }

  const sanitizedBatch = sanitizeManagedFields(body, currentRegistry.registry);

  try {
    const acks = await adminDb.transaction(async (tx) => {
      await tx.execute(sql.raw(`SET LOCAL search_path TO ${quoteIdent(currentRegistry.schemaName)}, public`));
      await tx.execute(sql`SET CONSTRAINTS ALL DEFERRED`);
      await executePlpgsqlBatch(
        tx as unknown as TransactionClient,
        sanitizedBatch,
        context.req.path,
        false,
        true,
        { ...claims },
        // ADR-0030: the installed apply function verifies itself against this fingerprint in-body.
        expectedApplyFingerprint(currentRegistry.registry, { functionSchema: currentRegistry.schemaName }),
        { functionSchema: currentRegistry.schemaName },
      );

      const responseAcks: MutationAck[] = [];

      for (const mutation of sanitizedBatch.mutations) {
        const entry = currentRegistry.registry[mutation.tableName] as SyncTableEntry;
        const serverUpdatedAtUs = await readServerUpdatedAtUs(tx, entry, mutation.entityKey);

        responseAcks.push({
          tableName: mutation.tableName,
          entityKey: mutation.entityKey,
          mutationId: mutation.mutationId,
          mutationSeq: mutation.mutationSeq,
          status: "acked",
          ...(serverUpdatedAtUs ? { serverUpdatedAtUs } : {}),
        });
      }

      return responseAcks;
    });

    return context.json({ acks });
  } catch (error) {
    const message = formatBatchExecutionError(error);

    console.error("[perf-lab-server] /api/mutations failed", {
      schemaName: currentRegistry.schemaName,
      mutationCount: sanitizedBatch.mutations.length,
      sample: sanitizedBatch.mutations.slice(0, 3).map((mutation) => ({
        tableName: mutation.tableName,
        kind: mutation.kind,
        mutationId: mutation.mutationId,
        mutationSeq: mutation.mutationSeq,
        entityKey: mutation.entityKey,
      })),
      message,
    });
    console.error(error);

    return context.json({ message }, 500);
  }
});

app.get("/v1/electric-proxy", async (context) => {
  const claims = parseDemoAuthClaimsFromRequest(context.req.raw);

  if (!activeRegistry) {
    return context.json({ message: "Perf-lab registry is not ready yet." }, 503);
  }

  return await proxyShapeRequest(context.req.raw, claims, activeRegistry);
});

app.onError((error, context) => {
  const message = error instanceof Error ? error.message : "Unexpected perf-lab server error";
  console.error(message);
  return context.json({ message }, 500);
});

process.on("SIGINT", () => {
  void shutdown();
});
process.on("SIGTERM", () => {
  void shutdown();
});

await installSharedAuthHelpers();
await prebuildKnownScenarioSchemas();
activeRegistry = await activateRegistry(
  defaultSyntheticPerfLabScenario.tableCount,
  defaultSyntheticPerfLabScenario.extraColumnCount,
);

const server = Bun.serve({
  hostname: host,
  port,
  idleTimeout: 120,
  fetch: app.fetch,
});

console.log(`Perf-lab write server ready on http://${host}:${port}`);

async function installSharedAuthHelpers() {
  await adminDb.execute(sql.raw(buildSyntheticGovernanceSql({} as SyncTableRegistry)));
}

async function prebuildKnownScenarioSchemas() {
  for (const definition of syntheticPerfLabScenarioDefinitions) {
    await ensurePreparedRegistry({
      tableCount: definition.scenario.tableCount,
      extraColumnCount: definition.scenario.extraColumnCount,
      schemaName: definition.schemaName,
    });
  }
}

async function activateRegistry(tableCount: number, extraColumnCount: number) {
  const preparedRegistry = await ensurePreparedRegistry({ tableCount, extraColumnCount });
  const truncateSql = buildSyntheticTruncateSql(preparedRegistry.registry);

  if (truncateSql.length > 0) {
    await adminDb.execute(sql.raw(truncateSql));
  }

  console.log(
    `Activated perf-lab schema ${preparedRegistry.schemaName} (${tableCount} tables, ${extraColumnCount} extra columns)`,
  );

  return preparedRegistry;
}

async function ensurePreparedRegistry(options: { tableCount: number; extraColumnCount: number; schemaName?: string }) {
  const matchingScenario = findSyntheticPerfLabScenarioDefinition({
    tableCount: options.tableCount,
    extraColumnCount: options.extraColumnCount,
  });
  const schemaName =
    options.schemaName ??
    matchingScenario?.schemaName ??
    buildSyntheticRegistrySchemaName({
      tableCount: options.tableCount,
      extraColumnCount: options.extraColumnCount,
    });
  const cachedRegistry = preparedRegistries.get(schemaName);

  if (cachedRegistry) {
    return cachedRegistry;
  }

  const bundle = buildSyntheticRegistry({
    tableCount: options.tableCount,
    extraColumnCount: options.extraColumnCount,
    schemaName,
  });

  console.log(
    `Preparing perf-lab schema ${schemaName} (${options.tableCount} tables, ${options.extraColumnCount} extra columns)`,
  );

  await adminDb.execute(sql.raw(buildSyntheticServerSchemaSql(bundle.registry)));
  await adminDb.execute(sql.raw(buildSyntheticGovernanceSql(bundle.registry)));
  await adminDb.execute(
    sql.raw(
      buildPlpgsqlBatchFunctionDdl(bundle.registry, {
        functionSchema: schemaName,
      }),
    ),
  );

  const preparedRegistry: PreparedPerfRegistry = {
    schemaName,
    tableCount: options.tableCount,
    extraColumnCount: options.extraColumnCount,
    tableNames: bundle.tableNames,
    electricTables: Object.values(bundle.registry)
      .map((entry) => entry.shape?.electricTable ?? entry.shape?.tableName ?? "")
      .filter((tableName) => tableName.length > 0),
    registry: bundle.registry,
  };

  preparedRegistries.set(schemaName, preparedRegistry);
  return preparedRegistry;
}

async function seedRegistryRows(preparedRegistry: PreparedPerfRegistry, rowCount: number, claims: DemoJwtClaims) {
  const batchSize = 250;
  const tableCount = preparedRegistry.tableNames.length;

  if (tableCount === 0) {
    throw new Error("Perf-lab registry has no active table.");
  }

  for (const [tableIndex, tableName] of preparedRegistry.tableNames.entries()) {
    const entry = preparedRegistry.registry[tableName] as SyncTableEntry;

    for (let start = 0; start < rowCount; start += batchSize) {
      const batchEnd = Math.min(rowCount, start + batchSize);
      const rows = buildSeedInsertRows(tableIndex, start, batchEnd, preparedRegistry.extraColumnCount, claims.sub);

      await adminDb.insert(entry.table as AnyPgTable).values(rows);
    }
  }

  console.log(
    `Seeded ${countSyntheticWorkloadRows(tableCount, rowCount)} total rows across ${tableCount} tables in ${preparedRegistry.schemaName} for ${claims.sub}`,
  );
}

function buildSeedInsertRows(
  tableIndex: number,
  start: number,
  end: number,
  extraColumnCount: number,
  ownerId: string,
) {
  const rows: Array<Record<string, string | bigint>> = [];

  for (let rowIndex = start; rowIndex < end; rowIndex += 1) {
    const payload = buildSyntheticCreatePayload(tableIndex, rowIndex, extraColumnCount);
    const timestampUs = 1_700_000_000_000_000n + BigInt(rowIndex);
    const row: Record<string, string | bigint> = {
      id: payload.id,
      ownerId,
      modifiedBy: ownerId,
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

  return rows;
}

async function proxyShapeRequest(request: Request, claims: DemoJwtClaims | null, registry: PreparedPerfRegistry) {
  const targetUrl = buildShapeTargetUrl(request, claims, registry);
  const response = await fetch(targetUrl, {
    method: "GET",
    headers: forwardHeaders(request.headers),
    signal: request.signal,
  });

  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "private, no-store, no-cache, must-revalidate, max-age=0");
  headers.set("Pragma", "no-cache");
  headers.set("Expires", "0");
  headers.set("Vary", appendVaryHeader(headers.get("Vary"), "Authorization"));

  return new Response(response.body, {
    status: response.status,
    headers,
  });
}

function buildShapeTargetUrl(request: Request, claims: DemoJwtClaims | null, registry: PreparedPerfRegistry) {
  const requestUrl = new URL(request.url);
  const targetUrl = new URL(electricUrl);
  const activeTables = new Set(registry.electricTables);

  targetUrl.search = requestUrl.search;

  const table = targetUrl.searchParams.get("table");

  if (!table || !activeTables.has(table) || (claims && demoJwtHasRole(claims, "admin"))) {
    return targetUrl.toString();
  }

  const ownershipFilter = renderOwnershipShapeFilter(registry, table, claims?.sub);
  const existingWhere = targetUrl.searchParams.get("where");

  if (!existingWhere) {
    targetUrl.searchParams.set("where", ownershipFilter);
    return targetUrl.toString();
  }

  targetUrl.searchParams.set("where", `(${existingWhere}) AND (${ownershipFilter})`);
  return targetUrl.toString();
}

/**
 * The ownership `where` the proxy pins onto a non-admin shape request, authored from the registry's
 * real owner COLUMN via `buildOwnershipShapeWhere` (bare column + typed subject; `DENY_ALL` = `false`
 * when unauthenticated) and rendered inline once for the shape URL. The rendered text carries a QUOTED
 * bare column (`"owner_id" = '…'`) — Electric's shape grammar accepts quoted bare columns, and `false`
 * exactly as it accepted the old hand-written `1 = 0`.
 */
function renderOwnershipShapeFilter(
  registry: PreparedPerfRegistry,
  electricTable: string,
  subject: string | undefined,
) {
  const entry = Object.values(registry.registry).find(
    (candidate) => (candidate.shape?.electricTable ?? candidate.shape?.tableName) === electricTable,
  );
  // Index-signature access (registry columns are dynamic by construction); every synthetic perf-lab
  // table defines `ownerId`, and `electricTables` above derives from this same registry.
  const ownerColumn = entry ? getColumns(entry.table as AnyPgTable)["ownerId"] : undefined;

  if (!ownerColumn) {
    throw new Error(`Perf-lab registry has no ownerId column for shape table ${electricTable}`);
  }

  return new PgDialect().sqlToQuery(buildOwnershipShapeWhere(ownerColumn, subject).inlineParams()).sql;
}

function findManagedFieldViolations(
  entry: SyncTableEntry,
  mutationKind: BatchMutationRequest["mutations"][number]["kind"],
  payload: unknown,
): string[] {
  if (mutationKind === "delete" || !isPlainObject(payload)) {
    return [];
  }

  const managedFields = getManagedFieldsForOperation(entry, mutationKind);
  if (managedFields.length === 0) {
    return [];
  }

  const payloadKeys = new Set(Object.keys(payload));
  return managedFields.filter((field) => payloadKeys.has(field.propertyKey)).map((field) => field.propertyKey);
}

function sanitizeManagedFields(batch: BatchMutationRequest, registry: SyncTableRegistry): BatchMutationRequest {
  return {
    mutations: batch.mutations.map((mutation) => {
      if (mutation.kind === "delete") {
        return mutation;
      }

      const entry = registry[mutation.tableName];

      if (!entry) {
        return mutation;
      }

      const managedFields = getManagedFieldsForOperation(entry as SyncTableEntry, mutation.kind);
      if (managedFields.length === 0) {
        return mutation;
      }

      const payload = isPlainObject(mutation.payload) ? { ...mutation.payload } : {};

      for (const field of managedFields) {
        delete payload[field.propertyKey];
        delete payload[field.columnName];
      }

      return {
        ...mutation,
        payload,
      };
    }),
  };
}

function getManagedFieldsForOperation(
  entry: SyncTableEntry,
  mutationKind: BatchMutationRequest["mutations"][number]["kind"],
) {
  if (mutationKind === "delete") {
    return [];
  }

  const columns = getColumns(entry.table as AnyPgTable);
  const columnMap = new Map(Object.entries(columns).map(([propertyKey, column]) => [propertyKey, column.name]));

  return (entry.governance?.managedFields ?? [])
    .filter((field) => field.applyOn.includes(mutationKind))
    .map((field) => ({
      propertyKey: field.column,
      columnName: columnMap.get(field.column) ?? field.column,
      strategy: field.strategy,
    }));
}

function toSchemaPayload(entry: SyncTableEntry, payload: unknown): unknown {
  if (!isPlainObject(payload)) {
    return payload;
  }

  const columns = getColumns(entry.table as AnyPgTable);
  const keyMap = new Map<string, string>();

  for (const [propertyKey, column] of Object.entries(columns)) {
    keyMap.set(propertyKey, propertyKey);
    keyMap.set(column.name, propertyKey);
  }

  return Object.fromEntries(Object.entries(payload).map(([key, value]) => [keyMap.get(key) ?? key, value]));
}

async function readServerUpdatedAtUs(
  tx: PerfLabReadQueryClient,
  entry: SyncTableEntry,
  entityKey: Record<string, string>,
): Promise<string | undefined> {
  const columns = getColumns(entry.table as AnyPgTable);
  const updatedAtColumn = Object.values(columns).find((column) => column.name === "updated_at_us");

  if (!updatedAtColumn) {
    return undefined;
  }

  const conditions = entry.primaryKey.columns.map((primaryKeyColumn) => {
    const rawValue = entityKey[primaryKeyColumn];

    if (rawValue === undefined) {
      throw new Error(`Missing entity key value for primary key column ${primaryKeyColumn}`);
    }

    const primaryKeyTableColumn = Object.values(columns).find((column) => column.name === primaryKeyColumn);

    if (!primaryKeyTableColumn) {
      throw new Error(`Missing table column metadata for primary key column ${primaryKeyColumn}`);
    }

    return eq(primaryKeyTableColumn, rawValue);
  });

  const whereClause = conditions.length === 1 ? conditions[0]! : and(...conditions);
  const rows = await tx
    .select({ updatedAtUs: updatedAtColumn })
    .from(entry.table as AnyPgTable)
    .where(whereClause)
    .limit(1);

  // The column is bigint `mode: "bigint"`, so drizzle maps the driver value to a BigInt (the generic
  // column object erases that type, hence the assertion); `String(...)` renders the same digits the
  // old `::text` projection produced (no suffix), keeping the JSON-safe string form callers expect.
  const updatedAtUs = rows[0]?.updatedAtUs as bigint | string | undefined;
  return updatedAtUs == null ? undefined : String(updatedAtUs);
}

function formatBatchExecutionError(error: unknown): string {
  const rootCause = getRootCauseError(error);

  if (!rootCause) {
    return "Batch mutation failed";
  }

  const details = [rootCause.message];
  const errorCode = getErrorStringProperty(rootCause, "code");
  const errorDetail = getErrorStringProperty(rootCause, "detail");
  const errorHint = getErrorStringProperty(rootCause, "hint");

  if (errorCode) {
    details.push(`code: ${errorCode}`);
  }

  if (errorDetail) {
    details.push(`detail: ${errorDetail}`);
  }

  if (errorHint) {
    details.push(`hint: ${errorHint}`);
  }

  return details.join(" | ");
}

function getRootCauseError(error: unknown): Error | null {
  let current = error;
  let lastError: Error | null = null;
  const seen = new Set<unknown>();

  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    lastError = current;
    current = current.cause;
  }

  return lastError;
}

function getErrorStringProperty(error: Error, key: string): string | null {
  if (!(key in error)) {
    return null;
  }

  const value = Reflect.get(error, key);
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isValidationError(error: unknown): error is { issues: unknown[] } {
  return typeof error === "object" && error !== null && "issues" in error && Array.isArray(error.issues);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function forwardHeaders(headers: Headers) {
  const next = new Headers();

  for (const [name, value] of headers.entries()) {
    const lowerName = name.toLowerCase();

    if (lowerName === "host" || lowerName === "authorization") {
      continue;
    }

    next.set(name, value);
  }

  return next;
}

function appendVaryHeader(existingValue: string | null, nextValue: string) {
  if (!existingValue) {
    return nextValue;
  }

  const values = existingValue
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  if (values.includes(nextValue)) {
    return values.join(", ");
  }

  values.push(nextValue);
  return values.join(", ");
}

function enqueueProvision(task: () => Promise<void>) {
  const nextTask = provisionQueue.then(task);
  provisionQueue = nextTask.catch(() => undefined);
  return nextTask;
}

function readPort(rawValue: string | undefined, fallback: number) {
  const parsed = Number.parseInt(rawValue ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

async function shutdown() {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  server.stop();
  await adminDb.$client.close();
  process.exit(0);
}
