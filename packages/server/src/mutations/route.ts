import { and, eq, sql, type AnyRelations } from "drizzle-orm";
import { getTableConfig, type AnyPgTable } from "drizzle-orm/pg-core";
import type { PgAsyncDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { getColumns } from "drizzle-orm/utils";
import { createSchemaFactory } from "drizzle-orm/zod";

import type {
  BatchMutationRequest,
  JwtClaims,
  MutationAck,
  RegistryRelations,
  SyncTableEntry,
  SyncTableRegistry,
} from "@pgxsinkit/contracts";
import {
  batchMutationRequestSchema,
  getOmittedProjectedColumns as getOmittedProjectionColumns,
  resolveServerVersionColumnName,
} from "@pgxsinkit/contracts";

import type { OperationsLogConfig } from "../operations-log/types";
import { logOperation, logOperationSafely } from "../operations-log/writer";
import type { FetchHandler } from "../router";
import {
  executePlpgsqlBatch,
  verifyPlpgsqlBatchFunction,
  verifyRlsAuthHelpers,
  type ApplyFunctionDriftCheck,
} from "./plpgsql-apply";
import type { TransactionClient } from "./types";

const { createInsertSchema: createMutationInsertSchema } = createSchemaFactory({
  coerce: { date: true },
});

type RouteReadQueryClient = Pick<PgAsyncDatabase<PgQueryResultHKT, AnyRelations>, "select">;

export const batchMutationPaths = ["/api/mutations", "/mutations"] as const;

export function createMutationHandler<TRegistry extends SyncTableRegistry>(
  db: PgAsyncDatabase<PgQueryResultHKT, RegistryRelations<TRegistry>>,
  registry: TRegistry,
  operationsLogConfig: OperationsLogConfig,
  operationsLogReady: Promise<void>,
  resolveAuthClaims?: (request: Request) => Promise<JwtClaims | null> | JwtClaims | null,
  applyFunctionDriftCheck?: ApplyFunctionDriftCheck,
): FetchHandler {
  let startupReadyPromise: Promise<void> | undefined;

  const startupReady = () => {
    if (!startupReadyPromise) {
      startupReadyPromise = installStartupDdl(db, registry, applyFunctionDriftCheck);
    }

    return startupReadyPromise;
  };

  const handleBatchMutation = async (request: Request): Promise<Response> => {
    await Promise.all([startupReady(), operationsLogReady]);

    const requestPath = new URL(request.url).pathname;
    let rawBody: unknown;

    try {
      rawBody = await request.json();
    } catch (error) {
      await logOperationSafely(db, operationsLogConfig, {
        tableName: null,
        operationKind: null,
        entityKey: null,
        payload: null,
        status: "validation_failed",
        errorMessage: error instanceof Error ? error.message : "Invalid JSON request body",
        httpStatus: 400,
        requestPath: requestPath,
      });

      return Response.json(
        {
          message: "Invalid batch mutation request",
          issues: [],
        },
        { status: 400 },
      );
    }

    let body: BatchMutationRequest;

    try {
      body = batchMutationRequestSchema.parse(rawBody);
    } catch (error) {
      await logOperationSafely(db, operationsLogConfig, {
        tableName: null,
        operationKind: null,
        entityKey: null,
        payload: rawBody,
        status: "validation_failed",
        errorMessage: error instanceof Error ? error.message : "Invalid batch mutation request",
        httpStatus: 400,
        requestPath: requestPath,
      });

      return Response.json(
        {
          message: "Invalid batch mutation request",
          issues: isValidationError(error) ? error.issues : [],
        },
        { status: 400 },
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
          buildCreateValidationSchema(syncEntry).parse(normalizedPayload);
        }
        // delete has no payload to validate
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
          requestPath: requestPath,
        });
      }

      // Attribute the rejection to the specific offending mutations. The batch is atomic
      // (nothing was applied), so the client can quarantine exactly these and keep the
      // innocent siblings retryable — one bad mutation never poisons the whole offline queue.
      return Response.json(
        {
          message: `Payload validation failed: ${validationErrors.join("; ")}`,
          rejections: invalidMutations.map(({ mutation, message }) => ({
            tableName: mutation.tableName,
            mutationId: mutation.mutationId,
            mutationSeq: mutation.mutationSeq,
            reason: message,
          })),
        },
        { status: 400 },
      );
    }

    const acks: MutationAck[] = [];
    let actorUserId: string | null = null;
    const rlsAuthContextRequired = isRlsAuthContextRequired(registry);

    try {
      await db.transaction(async (tx) => {
        const shouldApplyRlsContext = rlsAuthContextRequired;
        let userClaims: Record<string, unknown> = {};

        if (shouldApplyRlsContext) {
          const resolvedClaims = await resolveAuthClaims?.(request);

          if (!isPlainObject(resolvedClaims)) {
            await logOperationSafely(db, operationsLogConfig, {
              tableName: null,
              operationKind: null,
              entityKey: null,
              payload: rawBody,
              status: "validation_failed",
              errorMessage: "Missing validated JWT claims for RLS-enabled tables",
              httpStatus: 401,
              requestPath: requestPath,
            });

            throw new UnauthorizedBatchMutationError(
              "RLS-enabled tables require validated JWT claims in request context",
            );
          }

          userClaims = resolvedClaims;
          actorUserId = getUuidClaim(userClaims, "sub");
        }

        const batchRequest = sanitizeRestrictedFields(body, registry);
        await tx.execute(sql`SET CONSTRAINTS ALL DEFERRED`);

        const conflicts = await executePlpgsqlBatch(
          tx as unknown as TransactionClient,
          batchRequest,
          requestPath,
          false,
          shouldApplyRlsContext,
          userClaims,
        );

        if (shouldApplyRlsContext) {
          await tx.execute(sql`RESET ROLE`);
        }

        // ADR-0015: a reject-if-stale stale write was NOT applied — the applier returned it here.
        // Surface a `conflicted` ack (distinct from a failure) carrying the row's current Server
        // version, so the client keeps the optimistic overlay and resolves it as a new write.
        const conflictByMutationId = new Map(conflicts.map((conflict) => [conflict.mutationId, conflict]));

        for (const mutation of batchRequest.mutations) {
          const conflict = conflictByMutationId.get(mutation.mutationId);

          if (conflict) {
            // #6: a null currentServerVersion means the target row no longer exists (an UPDATE whose
            // row was deleted by another writer), distinct from a stale write over a row that moved.
            const conflictReason =
              conflict.currentServerVersion == null
                ? `Update rejected by the reject-if-stale conflict policy (ADR-0015): the target row no ` +
                  `longer exists on the server (deleted by another writer after this write was authored).`
                : `Stale write rejected by the reject-if-stale conflict policy (ADR-0015): the row's current ` +
                  `server version ${conflict.currentServerVersion} is ahead of the base ` +
                  `${mutation.baseServerVersion ?? "(unknown)"} this write was authored against.`;

            await logOperation(tx, operationsLogConfig, {
              tableName: mutation.tableName,
              operationKind: mutation.kind,
              entityKey: mutation.entityKey,
              payload: mutation.payload,
              status: "conflicted",
              errorMessage: conflictReason,
              httpStatus: 409,
              mutationId: mutation.mutationId,
              mutationSeq: mutation.mutationSeq,
              clientTimestampUs: mutation.clientTimestampUs,
              requestPath: requestPath,
              userId: actorUserId,
            });

            acks.push({
              tableName: mutation.tableName,
              entityKey: mutation.entityKey,
              mutationId: mutation.mutationId,
              mutationSeq: mutation.mutationSeq,
              status: "conflicted",
              ...(conflict.currentServerVersion ? { serverUpdatedAtUs: conflict.currentServerVersion } : {}),
              conflictReason,
              httpStatus: 409,
            });
            continue;
          }

          const serverUpdatedAtUs = await readServerUpdatedAtUs(
            tx,
            registry[mutation.tableName as keyof TRegistry] as SyncTableEntry,
            mutation.entityKey,
          );

          await logOperation(tx, operationsLogConfig, {
            tableName: mutation.tableName,
            operationKind: mutation.kind,
            entityKey: mutation.entityKey,
            payload: mutation.payload,
            status: "succeeded",
            httpStatus: 200,
            mutationId: mutation.mutationId,
            mutationSeq: mutation.mutationSeq,
            clientTimestampUs: mutation.clientTimestampUs,
            requestPath: requestPath,
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
        return Response.json({ message: error.message }, { status: 401 });
      }

      const errorMessage = formatBatchExecutionError(error);

      for (const mutation of body.mutations) {
        await logOperationSafely(db, operationsLogConfig, {
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
          requestPath: requestPath,
          userId: actorUserId,
        });
      }

      return Response.json({ message: errorMessage }, { status: 500 });
    }

    return Response.json({ acks });
  };

  return handleBatchMutation;
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

function isRlsAuthContextRequired(registry: SyncTableRegistry): boolean {
  return Object.values(registry).some(
    (entry) =>
      getTableConfig(entry.table as AnyPgTable).policies.length > 0 ||
      (entry.governance?.managedFields ?? []).some((field) => field.strategy === "authUid"),
  );
}

class UnauthorizedBatchMutationError extends Error {}

function getUuidClaim(claims: JwtClaims, key: string): string | null {
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

function sanitizeRestrictedFields(batch: BatchMutationRequest, registry: SyncTableRegistry): BatchMutationRequest {
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

/**
 * The zod schema used to validate a `create` payload. Managed-on-create fields (`authUid` /
 * `nowMicroseconds`) are stamped by the server AFTER validation, so the client correctly omits them —
 * and {@link findManagedFieldViolations} already rejects a payload that includes them. They are
 * omitted from the insert schema so a NOT NULL managed column without a SQL DEFAULT (e.g. an `authUid`
 * author/owner/created_by) is not falsely required. (A column carrying a DEFAULT is already optional
 * in the drizzle insert schema; this also covers a managed column that has none.)
 */
export function buildCreateValidationSchema(entry: SyncTableEntry) {
  const createSchema = createMutationInsertSchema(entry.table as AnyPgTable);
  const managedCreateKeys = getManagedFieldsForOperation(entry, "create").map((field) => field.propertyKey);
  if (managedCreateKeys.length === 0) {
    return createSchema;
  }
  // The omit-mask keys are derived from governance at runtime, so they cannot be narrowed to the
  // schema's literal-key mask type — cast through the parameter type.
  const omitMask = Object.fromEntries(managedCreateKeys.map((key) => [key, true as const])) as Parameters<
    typeof createSchema.omit
  >[0];
  return createSchema.omit(omitMask);
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

function resolveServerUpdatedAtColumnName(entry: SyncTableEntry): string {
  // The single source for the Server version column (ADR-0010 / ADR-0004): resolves the
  // managed field's property key to its column name. Falls back to the conventional name for
  // resilience, though registry validation now guarantees a writable table declares one.
  return resolveServerVersionColumnName(entry) ?? "updated_at_us";
}

async function readServerUpdatedAtUs(
  tx: RouteReadQueryClient,
  entry: SyncTableEntry,
  entityKey: Record<string, string>,
): Promise<string | undefined> {
  const columns = getColumns(entry.table as AnyPgTable);
  const columnName = resolveServerUpdatedAtColumnName(entry);
  const updatedAtColumn = Object.values(columns).find((column) => column.name === columnName);

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
    .select({ updatedAtUs: sql<string>`${updatedAtColumn}::text` })
    .from(entry.table as AnyPgTable)
    .where(whereClause)
    .limit(1);

  return rows[0]?.updatedAtUs ?? undefined;
}

async function installStartupDdl<TRegistry extends SyncTableRegistry>(
  db: PgAsyncDatabase<PgQueryResultHKT, RegistryRelations<TRegistry>>,
  registry: TRegistry,
  applyFunctionDriftCheck?: ApplyFunctionDriftCheck,
): Promise<void> {
  await verifyPlpgsqlBatchFunction(
    db,
    registry,
    applyFunctionDriftCheck ? { driftCheck: applyFunctionDriftCheck } : {},
  );

  if (isRlsAuthContextRequired(registry)) {
    await verifyRlsAuthHelpers(db);
  }
}
