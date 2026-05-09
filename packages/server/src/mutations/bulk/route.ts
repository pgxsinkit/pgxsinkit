import { getTableName, sql } from "drizzle-orm";
import type { AnyPgTable } from "drizzle-orm/pg-core";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { getColumns } from "drizzle-orm/utils";
import type { Context, Hono } from "hono";

import type {
  BatchMutationRequest,
  MutationAck,
  RegistryRelations,
  SyncTableEntry,
  SyncTableRegistry,
} from "@pgxsinkit/contracts";
import {
  batchMutationRequestSchema,
  getOmittedProjectedColumns as getOmittedProjectionColumns,
} from "@pgxsinkit/contracts";

import type { OperationsLogConfig } from "../../operations-log/types";
import { logOperation, logOperationSafely } from "../../operations-log/writer";
import { executePlpgsqlBatch, verifyArtifactRlsAuthHelpers, verifyPlpgsqlBatchFunction } from "./plpgsql-strategy";
import type { BulkMutationBackend, TransactionClient } from "./types";

export function registerBulkMutationRoute<TRegistry extends SyncTableRegistry>(
  app: Hono,
  db: PostgresJsDatabase<RegistryRelations<TRegistry>>,
  registry: TRegistry,
  backend: BulkMutationBackend,
  operationsLogConfig: OperationsLogConfig,
  operationsLogReady: Promise<void>,
  resolveAuthClaims?: (request: Request) => Promise<Record<string, unknown> | null> | Record<string, unknown> | null,
) {
  let startupReadyPromise: Promise<void> | undefined;
  const batchMutationPaths = ["/api/mutations", "/mutations"] as const;

  const startupReady = () => {
    if (!startupReadyPromise) {
      startupReadyPromise = installBulkStartupDdl(db, registry, backend);
    }

    return startupReadyPromise;
  };

  const handleBatchMutation = async (context: Context) => {
    await Promise.all([startupReady(), operationsLogReady]);

    let rawBody: unknown;

    try {
      rawBody = await context.req.json();
    } catch (error) {
      await logOperationSafely(db, operationsLogConfig, {
        source: "batch",
        backend,
        tableName: null,
        operationKind: null,
        entityKey: null,
        payload: null,
        status: "validation_failed",
        errorMessage: error instanceof Error ? error.message : "Invalid JSON request body",
        httpStatus: 400,
        requestPath: context.req.path,
      });

      return context.json(
        {
          message: "Invalid batch mutation request",
          issues: [],
        },
        400,
      );
    }

    let body: BatchMutationRequest;

    try {
      body = batchMutationRequestSchema.parse(rawBody);
    } catch (error) {
      await logOperationSafely(db, operationsLogConfig, {
        source: "batch",
        backend,
        tableName: null,
        operationKind: null,
        entityKey: null,
        payload: rawBody,
        status: "validation_failed",
        errorMessage: error instanceof Error ? error.message : "Invalid batch mutation request",
        httpStatus: 400,
        requestPath: context.req.path,
      });

      return context.json(
        {
          message: "Invalid batch mutation request",
          issues: isValidationError(error) ? error.issues : [],
        },
        400,
      );
    }

    const validationErrors: string[] = [];
    const invalidMutations: Array<{
      mutation: BatchMutationRequest["mutations"][number];
      message: string;
    }> = [];

    for (const mutation of body.mutations) {
      if (!(mutation.tableName in registry)) {
        const message = `Unknown table: ${mutation.tableName}`;
        validationErrors.push(message);
        invalidMutations.push({ mutation, message });
        continue;
      }

      const entry = registry[mutation.tableName as keyof TRegistry]!;
      const syncEntry = entry as SyncTableEntry;
      const schemas = syncEntry.schemas;
      const normalizedPayload = toSchemaPayload(syncEntry, mutation.payload);
      const projectedFieldViolations = findProjectedFieldViolations(syncEntry, mutation.kind, normalizedPayload);

      if (projectedFieldViolations.length > 0) {
        const message = `${mutation.tableName}/${mutation.mutationId} includes client-omitted fields: ${projectedFieldViolations.join(", ")}`;
        validationErrors.push(message);
        invalidMutations.push({ mutation, message });
        continue;
      }

      const managedFieldViolations = findManagedFieldViolations(syncEntry, mutation.kind, normalizedPayload);

      if (managedFieldViolations.length > 0) {
        const message = `${mutation.tableName}/${mutation.mutationId} includes server-managed fields: ${managedFieldViolations.join(", ")}`;
        validationErrors.push(message);
        invalidMutations.push({ mutation, message });
        continue;
      }

      try {
        if (mutation.kind === "create" && schemas?.createSchema) {
          schemas.createSchema.parse(normalizedPayload);
        } else if (mutation.kind === "update" && schemas?.updateSchema) {
          schemas.updateSchema.parse(normalizedPayload);
        }
        // delete has no payload schema
      } catch (error) {
        const suffix = isValidationError(error) ? ` (${JSON.stringify(error.issues)})` : "";
        const message = `${mutation.tableName}/${mutation.mutationId}${suffix}`;
        validationErrors.push(message);
        invalidMutations.push({ mutation, message });
      }
    }

    if (validationErrors.length > 0) {
      for (const invalidMutation of invalidMutations) {
        await logOperationSafely(db, operationsLogConfig, {
          source: "batch",
          backend,
          tableName: invalidMutation.mutation.tableName,
          operationKind: invalidMutation.mutation.kind,
          entityKey: invalidMutation.mutation.entityKey,
          payload: invalidMutation.mutation.payload,
          status: "validation_failed",
          errorMessage: invalidMutation.message,
          httpStatus: 400,
          mutationId: invalidMutation.mutation.mutationId,
          mutationSeq: invalidMutation.mutation.mutationSeq,
          clientTimestampUs: invalidMutation.mutation.clientTimestampUs,
          requestPath: context.req.path,
        });
      }

      return context.json({ message: `Payload validation failed: ${validationErrors.join("; ")}` }, 400);
    }

    const acks: MutationAck[] = [];
    let actorUserId: string | null = null;
    const artifactAuthContextRequired = isArtifactAuthContextRequired(registry);

    try {
      await db.transaction(async (tx) => {
        const shouldApplyRlsContext = artifactAuthContextRequired;
        let userClaims: Record<string, unknown> = {};

        if (shouldApplyRlsContext) {
          const resolvedClaims = await resolveAuthClaims?.(context.req.raw);

          if (!isPlainObject(resolvedClaims)) {
            await logOperationSafely(db, operationsLogConfig, {
              source: "batch",
              backend,
              tableName: null,
              operationKind: null,
              entityKey: null,
              payload: rawBody,
              status: "validation_failed",
              errorMessage: "Missing validated JWT claims for RLS-enabled artifact backend",
              httpStatus: 401,
              requestPath: context.req.path,
            });

            throw new UnauthorizedBatchMutationError(
              "RLS-enabled artifact backend requires validated JWT claims in request context",
            );
          }

          userClaims = resolvedClaims;
          actorUserId = getUuidClaim(userClaims, "sub");
        }

        const batchRequest = sanitizeArtifactRestrictedFields(body, registry);
        await tx.execute(sql`SET CONSTRAINTS ALL DEFERRED`);

        await executePlpgsqlBatch(
          tx as unknown as TransactionClient,
          batchRequest,
          context.req.path,
          false,
          shouldApplyRlsContext,
          userClaims,
        );

        if (shouldApplyRlsContext) {
          await tx.execute(sql`RESET ROLE`);
        }

        for (const mutation of batchRequest.mutations) {
          const serverUpdatedAtUs = await readServerUpdatedAtUs(
            tx as unknown as TransactionClient,
            registry[mutation.tableName as keyof TRegistry] as SyncTableEntry,
            mutation.entityKey,
          );

          await logOperation(tx, operationsLogConfig, {
            source: "batch",
            backend,
            tableName: mutation.tableName,
            operationKind: mutation.kind,
            entityKey: mutation.entityKey,
            payload: mutation.payload,
            status: "succeeded",
            httpStatus: 200,
            mutationId: mutation.mutationId,
            mutationSeq: mutation.mutationSeq,
            clientTimestampUs: mutation.clientTimestampUs,
            requestPath: context.req.path,
            userId: actorUserId,
          });

          acks.push({
            tableName: mutation.tableName,
            entityKey: mutation.entityKey,
            mutationId: mutation.mutationId,
            mutationSeq: mutation.mutationSeq,
            status: "acked",
            ...(serverUpdatedAtUs ? { serverUpdatedAtUs } : {}),
          });
        }
      });
    } catch (error) {
      if (error instanceof UnauthorizedBatchMutationError) {
        return context.json({ message: error.message }, 401);
      }

      const errorMessage = formatBatchExecutionError(error);

      for (const mutation of body.mutations) {
        await logOperationSafely(db, operationsLogConfig, {
          source: "batch",
          backend,
          tableName: mutation.tableName,
          operationKind: mutation.kind,
          entityKey: mutation.entityKey,
          payload: mutation.payload,
          status: "execution_failed",
          errorMessage,
          httpStatus: 500,
          mutationId: mutation.mutationId,
          mutationSeq: mutation.mutationSeq,
          clientTimestampUs: mutation.clientTimestampUs,
          requestPath: context.req.path,
          userId: actorUserId,
        });
      }

      return context.json({ message: errorMessage }, 500);
    }

    return context.json({ acks });
  };

  for (const path of batchMutationPaths) {
    app.post(path, handleBatchMutation);
  }
}

function isValidationError(error: unknown): error is { issues: unknown[] } {
  return typeof error === "object" && error !== null && "issues" in error && Array.isArray(error.issues);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

  const value = (error as unknown as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isArtifactAuthContextRequired(registry: SyncTableRegistry): boolean {
  return Object.values(registry).some(
    (entry) =>
      entry.governance?.rls?.enabled === true ||
      (entry.governance?.managedFields ?? []).some((field) => field.strategy === "authUid"),
  );
}

class UnauthorizedBatchMutationError extends Error {}

function getUuidClaim(claims: Record<string, unknown>, key: string): string | null {
  const value = claims[key];

  if (typeof value !== "string") {
    return null;
  }

  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) ? value : null;
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

function findProjectedFieldViolations(
  entry: SyncTableEntry,
  mutationKind: BatchMutationRequest["mutations"][number]["kind"],
  payload: unknown,
): string[] {
  if (mutationKind === "delete" || !isPlainObject(payload)) {
    return [];
  }

  const projectedFields = getProjectedAwayFields(entry);
  if (projectedFields.length === 0) {
    return [];
  }

  const payloadKeys = new Set(Object.keys(payload));

  return [
    ...new Set(
      projectedFields
        .filter((field) => payloadKeys.has(field.propertyKey) || payloadKeys.has(field.columnName))
        .map((field) => field.propertyKey),
    ),
  ];
}

function sanitizeArtifactRestrictedFields(
  batch: BatchMutationRequest,
  registry: SyncTableRegistry,
): BatchMutationRequest {
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
      const projectedFields = getProjectedAwayFields(entry as SyncTableEntry);

      if (managedFields.length === 0 && projectedFields.length === 0) {
        return mutation;
      }

      const payload = isPlainObject(mutation.payload) ? { ...mutation.payload } : {};

      for (const field of managedFields) {
        delete payload[field.propertyKey];
        delete payload[field.columnName];
      }

      for (const field of projectedFields) {
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

function getProjectedAwayFields(entry: SyncTableEntry) {
  return getOmittedProjectionColumns(entry).map(({ propertyKey, columnName }) => ({
    propertyKey,
    columnName,
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
  tx: TransactionClient,
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

    return sql`${quoteIdentifier(primaryKeyColumn)} = ${rawValue}`;
  });

  const result = (await tx.execute(sql`
    SELECT ${quoteIdentifier("updated_at_us")}::text AS "updatedAtUs"
    FROM ${quoteIdentifier(getTableName(entry.table as AnyPgTable))}
    WHERE ${sql.join(conditions, sql` AND `)}
    LIMIT 1
  `)) as Iterable<{ updatedAtUs: string | null }>;

  const row = Array.from(result)[0];
  return row?.updatedAtUs ?? undefined;
}

function quoteIdentifier(identifier: string) {
  return sql.raw(`"${identifier.replace(/"/g, '""')}"`);
}

async function installBulkStartupDdl<TRegistry extends SyncTableRegistry>(
  db: PostgresJsDatabase<RegistryRelations<TRegistry>>,
  registry: TRegistry,
  _backend: BulkMutationBackend,
): Promise<void> {
  await verifyPlpgsqlBatchFunction(db);

  if (isArtifactAuthContextRequired(registry)) {
    await verifyArtifactRlsAuthHelpers(db);
  }
}
