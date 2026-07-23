import { and, eq, sql, type AnyRelations } from "drizzle-orm";
import { getTableConfig, type AnyPgTable } from "drizzle-orm/pg-core";
import type { PgAsyncDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { getColumns } from "drizzle-orm/utils";
import { createSchemaFactory } from "drizzle-orm/zod";

import type {
  AuthoritativeWriteRequest,
  BatchMutationRequest,
  JwtClaims,
  MutationAck,
  RegistryRelations,
  SyncTableEntry,
  SyncTableRegistry,
} from "@pgxsinkit/contracts";
import {
  authoritativeWriteRequestSchema,
  batchMutationRequestSchema,
  getOmittedProjectedColumns as getOmittedProjectionColumns,
  getProjectedColumns,
  resolveServerVersionColumnName,
} from "@pgxsinkit/contracts";

import type { OperationsLogConfig } from "../operations-log/types";
import { logOperation, logOperationSafely } from "../operations-log/writer";
import type { FetchHandler } from "../router";
import { readSqlState } from "../sql-state";
import {
  executePlpgsqlBatch,
  expectedApplyFingerprint,
  type MutationConflict,
  verifyRlsAuthHelpers,
} from "./plpgsql-apply";
import type { TransactionClient } from "./types";

/**
 * How the write path handles its remaining startup query class — the RLS auth-helper verify (ADR-0030
 * decision 3). The apply-function drift guarantee moved into the call itself (self-verifying function),
 * so this now governs ONLY that helper check:
 * - `"in-process"` (default): keep today's boot-time `verifyRlsAuthHelpers` and its clear startup error.
 * - `"deploy-time"`: skip it — the migration pipeline owns that guarantee, so a fresh (serverless)
 *   worker sends ZERO queries before the mutation transaction itself.
 */
export type StartupVerificationMode = "in-process" | "deploy-time";

const { createInsertSchema: createMutationInsertSchema } = createSchemaFactory({
  coerce: { date: true },
});

type RouteReadQueryClient = Pick<PgAsyncDatabase<PgQueryResultHKT, AnyRelations>, "select">;

export const batchMutationPaths = ["/api/mutations"] as const;
/** The authoritative (pessimistic) write endpoint (ADR-0022 §3): one atomic write-unit per POST. */
export const authoritativeMutationPaths = ["/api/mutations/unit"] as const;

export function createMutationHandler<TRegistry extends SyncTableRegistry>(
  db: PgAsyncDatabase<PgQueryResultHKT, RegistryRelations<TRegistry>>,
  registry: TRegistry,
  operationsLogConfig: OperationsLogConfig,
  operationsLogReady: Promise<void>,
  resolveAuthClaims?: (request: Request) => Promise<JwtClaims | null> | JwtClaims | null,
  startupVerification: StartupVerificationMode = "in-process",
  logTimings = false,
): { batch: FetchHandler; authoritative: FetchHandler } {
  let startupReadyPromise: Promise<void> | undefined;

  // ADR-0030: the fingerprint this server expects for its registry + applier codegen, computed ONCE per
  // server instance. Every `executePlpgsqlBatch` passes it so the installed apply function can verify
  // itself in-body (SQLSTATE 'PXS01' on drift) — this replaces the deleted startup verify.
  const expectedFingerprint = expectedApplyFingerprint(registry);

  // Per-request timing scratch (opt-in). authMs/applyMs are filled at the narrow phase call sites inside
  // the handler; totalMs + status are measured by `withTiming` wrapping the returned handler. A fresh
  // object per request keeps this concurrency-safe without threading state through the handler internals.
  const perfNow = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
  interface RequestTiming {
    handlerStart: number;
    preTxMs: number;
    txOpenMs: number;
    authMs: number;
    applyMs: number;
    mutations: number;
  }
  const withTiming = (route: string, handler: (request: Request, timing?: RequestTiming) => Promise<Response>) => {
    if (!logTimings) {
      return (request: Request) => handler(request);
    }
    return async (request: Request): Promise<Response> => {
      const start = perfNow();
      const timing: RequestTiming = {
        handlerStart: start,
        preTxMs: 0,
        txOpenMs: 0,
        authMs: 0,
        applyMs: 0,
        mutations: 0,
      };
      const response = await handler(request, timing);
      console.log(
        "[pgxsinkit-timing]",
        JSON.stringify({
          route,
          preTxMs: Math.round(timing.preTxMs),
          txOpenMs: Math.round(timing.txOpenMs),
          authMs: Math.round(timing.authMs),
          applyMs: Math.round(timing.applyMs),
          totalMs: Math.round(perfNow() - start),
          mutations: timing.mutations,
          status: response.status,
        }),
      );
      return response;
    };
  };
  // Stamp the two spans the phase timers cannot see: preTxMs = handler entry → transaction call
  // (parse + zod validation), txOpenMs = transaction call → callback entry (the driver's LAZY
  // connection establishment + BEGIN — on serverless this is where a fresh worker's pooler
  // TLS/DNS cost lands, invisible to authMs/applyMs).
  const stampPreTx = (timing: RequestTiming | undefined) => {
    if (timing) timing.preTxMs = perfNow() - timing.handlerStart;
    return timing ? perfNow() : 0;
  };
  const stampTxOpen = (timing: RequestTiming | undefined, txCallAt: number) => {
    if (timing) timing.txOpenMs = perfNow() - txCallAt;
  };

  const startupReady = () => {
    if (!startupReadyPromise) {
      // ADR-0030: "deploy-time" skips the boot-time RLS auth-helper verify (the migration pipeline owns
      // that guarantee), so a fresh worker sends no query here — combined with a declared operations-log
      // posture, the first statement a serverless worker sends is the mutation transaction itself.
      startupReadyPromise = startupVerification === "in-process" ? installStartupDdl(db, registry) : Promise.resolve();
    }

    return startupReadyPromise;
  };

  // Per-mutation payload validation shared by the batch and authoritative endpoints (security: both must
  // reject client-omitted projection fields, server-managed fields, and malformed payloads before apply).
  // Logs each offender and returns the attributable 400 Response, or null when every mutation is valid.
  const validateMutationsOrRespond = async (
    mutations: BatchMutationRequest["mutations"],
    requestPath: string,
  ): Promise<Response | null> => {
    const validationErrors: string[] = [];
    const invalidMutations: Array<{
      mutation: BatchMutationRequest["mutations"][number];
      message: string;
    }> = [];

    for (const mutation of mutations) {
      if (!(mutation.tableName in registry)) {
        const message = `Unknown table: ${mutation.tableName}`;
        validationErrors.push(message);
        invalidMutations.push({ mutation, message });
        continue;
      }

      const entry = registry[mutation.tableName as keyof TRegistry]!;
      const syncEntry = entry as SyncTableEntry;
      const normalizedPayload = toSchemaPayload(syncEntry, mutation.payload);
      // Surface (once per table+key) only a payload key the apply path would SILENTLY drop — a truly
      // unknown key, never a projected-away/server-only column (those are 400-rejected just below, so
      // the helper excludes them; warning "the write succeeds" then rejecting was the misleading overlap).
      warnOnSilentlyDroppedPayloadKeys(syncEntry, mutation.tableName, mutation.kind, normalizedPayload);
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

    return null;
  };

  const handleBatchMutation = async (request: Request, timing?: RequestTiming): Promise<Response> => {
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

    const invalidResponse = await validateMutationsOrRespond(body.mutations, requestPath);
    if (invalidResponse) {
      return invalidResponse;
    }

    if (timing) timing.mutations = body.mutations.length;

    const acks: MutationAck[] = [];
    let actorUserId: string | null = null;
    const rlsAuthContextRequired = isRlsAuthContextRequired(registry);

    try {
      const txCallAt = stampPreTx(timing);
      await db.transaction(async (tx) => {
        stampTxOpen(timing, txCallAt);
        const shouldApplyRlsContext = rlsAuthContextRequired;
        let userClaims: Record<string, unknown> = {};

        if (shouldApplyRlsContext) {
          const authStart = timing ? perfNow() : 0;
          const resolvedClaims = await resolveAuthClaims?.(request);
          if (timing) timing.authMs = perfNow() - authStart;

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

        const applyStart = timing ? perfNow() : 0;
        const conflicts = await executePlpgsqlBatch(
          tx as unknown as TransactionClient,
          batchRequest,
          requestPath,
          false,
          shouldApplyRlsContext,
          userClaims,
          expectedFingerprint,
        );
        if (timing) timing.applyMs = perfNow() - applyStart;

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

  // ADR-0022 §3 (mechanism c): the authoritative (pessimistic) write endpoint. One write-**unit** per POST,
  // applied in its OWN isolated transaction, atomically — so a constraint/trigger exception becomes a clean
  // per-mutation `rejected` ack (the whole unit rolls back, overlays auto-discard) instead of the batch
  // path's whole-batch 500, and a stale member surfaces `conflicted` (overlays kept) without partial apply.
  const handleAuthoritativeWrite = async (request: Request, timing?: RequestTiming): Promise<Response> => {
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
      return Response.json({ message: "Invalid authoritative write request", issues: [] }, { status: 400 });
    }

    let body: AuthoritativeWriteRequest;

    try {
      body = authoritativeWriteRequestSchema.parse(rawBody);
    } catch (error) {
      await logOperationSafely(db, operationsLogConfig, {
        tableName: null,
        operationKind: null,
        entityKey: null,
        payload: rawBody,
        status: "validation_failed",
        errorMessage: error instanceof Error ? error.message : "Invalid authoritative write request",
        httpStatus: 400,
        requestPath: requestPath,
      });
      return Response.json(
        {
          message: "Invalid authoritative write request",
          issues: isValidationError(error) ? error.issues : [],
        },
        { status: 400 },
      );
    }

    const invalidResponse = await validateMutationsOrRespond(body.mutations, requestPath);
    if (invalidResponse) {
      return invalidResponse;
    }

    if (timing) timing.mutations = body.mutations.length;

    const rlsAuthContextRequired = isRlsAuthContextRequired(registry);
    let actorUserId: string | null = null;
    // The unit's outcome, decided inside its OWN transaction: applied (Server versions per member) or
    // conflicted (a stale member → rolled back, overlays kept). An execution exception is handled in catch.
    let appliedServerVersions: Map<string, string | null> | null = null;
    let unitConflicts: MutationConflict[] | null = null;

    try {
      const txCallAt = stampPreTx(timing);
      await db.transaction(async (tx) => {
        stampTxOpen(timing, txCallAt);
        const shouldApplyRlsContext = rlsAuthContextRequired;
        let userClaims: Record<string, unknown> = {};

        if (shouldApplyRlsContext) {
          const authStart = timing ? perfNow() : 0;
          const resolvedClaims = await resolveAuthClaims?.(request);
          if (timing) timing.authMs = perfNow() - authStart;

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

        const unitRequest = sanitizeRestrictedFields(body, registry);
        await tx.execute(sql`SET CONSTRAINTS ALL DEFERRED`);

        const applyStart = timing ? perfNow() : 0;
        const conflicts = await executePlpgsqlBatch(
          tx as unknown as TransactionClient,
          unitRequest,
          requestPath,
          false,
          shouldApplyRlsContext,
          userClaims,
          expectedFingerprint,
        );
        if (timing) timing.applyMs = perfNow() - applyStart;

        if (shouldApplyRlsContext) {
          await tx.execute(sql`RESET ROLE`);
        }

        if (conflicts.length > 0) {
          // The unit is atomic — a stale member means none of it applies. Roll back; report all members as
          // conflicted (overlays kept, re-resolve the unit) below.
          unitConflicts = conflicts;
          throw new UnitNotCommittedError();
        }

        // Applied cleanly. Read each member's resulting Server version INSIDE the txn, before it commits.
        const versions = new Map<string, string | null>();
        for (const mutation of unitRequest.mutations) {
          const version = await readServerUpdatedAtUs(
            tx,
            registry[mutation.tableName as keyof TRegistry] as SyncTableEntry,
            mutation.entityKey,
          );
          versions.set(mutation.mutationId, version ?? null);
        }
        appliedServerVersions = versions;
      });
    } catch (error) {
      if (error instanceof UnauthorizedBatchMutationError) {
        return Response.json({ message: error.message }, { status: 401 });
      }

      if (!(error instanceof UnitNotCommittedError)) {
        // A DB-enforced invariant (capacity/quota/uniqueness constraint or trigger) declined the unit. The
        // whole unit rolled back; surface a per-mutation `rejected` ack so the client auto-discards the
        // unit's optimistic overlay (ADR-0022 §4). The ack carries a SANITISED reason — the raw DB error
        // (constraint names, offending values/PII, schema, hints) stays in the operations log only.
        const internalDetail = formatBatchExecutionError(error);
        const publicReason = toPublicRejectionReason(error);
        const rejectedAcks: MutationAck[] = [];
        for (const mutation of body.mutations) {
          await logOperationSafely(db, operationsLogConfig, {
            tableName: mutation.tableName,
            operationKind: mutation.kind,
            entityKey: mutation.entityKey,
            payload: mutation.payload,
            status: "execution_failed",
            errorMessage: internalDetail,
            httpStatus: 409,
            mutationId: mutation.mutationId,
            mutationSeq: mutation.mutationSeq,
            clientTimestampUs: mutation.clientTimestampUs,
            requestPath: requestPath,
            userId: actorUserId,
          });
          rejectedAcks.push({
            tableName: mutation.tableName,
            entityKey: mutation.entityKey,
            mutationId: mutation.mutationId,
            mutationSeq: mutation.mutationSeq,
            status: "rejected",
            rejectionReason: publicReason,
            httpStatus: 409,
          });
        }
        return Response.json({ acks: rejectedAcks });
      }
      // UnitNotCommittedError — `unitConflicts` is set; fall through to conflicted-ack building.
    }

    const acks: MutationAck[] = [];

    if (unitConflicts) {
      const conflictByMutationId = new Map(
        (unitConflicts as MutationConflict[]).map((conflict) => [conflict.mutationId, conflict]),
      );
      for (const mutation of body.mutations) {
        const conflict = conflictByMutationId.get(mutation.mutationId);
        const conflictReason = conflict
          ? conflict.currentServerVersion == null
            ? `Update rejected by the reject-if-stale conflict policy (ADR-0015): the target row no longer ` +
              `exists on the server (deleted by another writer after this write was authored).`
            : `Stale write rejected by the reject-if-stale conflict policy (ADR-0015): the row's current ` +
              `server version ${conflict.currentServerVersion} is ahead of the base ` +
              `${mutation.baseServerVersion ?? "(unknown)"} this write was authored against.`
          : `Atomic write-unit not committed (ADR-0022): a sibling write in the same unit was rejected as ` +
            `stale, so this write rolled back too. Re-resolve the unit.`;

        await logOperationSafely(db, operationsLogConfig, {
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
          ...(conflict?.currentServerVersion ? { serverUpdatedAtUs: conflict.currentServerVersion } : {}),
          conflictReason,
          httpStatus: 409,
        });
      }
      return Response.json({ acks });
    }

    // Applied: ack every member, carrying the Server version each converged to.
    const serverVersions = appliedServerVersions ?? new Map<string, string | null>();
    for (const mutation of body.mutations) {
      await logOperationSafely(db, operationsLogConfig, {
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
      const serverUpdatedAtUs = serverVersions.get(mutation.mutationId) ?? undefined;
      acks.push({
        tableName: mutation.tableName,
        entityKey: mutation.entityKey,
        mutationId: mutation.mutationId,
        mutationSeq: mutation.mutationSeq,
        status: "acked",
        ...(serverUpdatedAtUs ? { serverUpdatedAtUs } : {}),
      });
    }

    return Response.json({ acks });
  };

  return {
    batch: withTiming("mutations", handleBatchMutation),
    authoritative: withTiming("mutations", handleAuthoritativeWrite),
  };
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

/**
 * Map a DB exception to a **client-safe** rejection reason for an authoritative `rejected` ack (ADR-0022 §4).
 * The raw error text (`formatBatchExecutionError`) leaks constraint names, schema/table, the offending
 * VALUES (potential PII), and trigger hints — and a `rejected` ack is success-path copy the app surfaces to
 * users, so it must not echo that. Two cases:
 *
 * - **App-authored `RAISE`** (PL/pgSQL `RAISE EXCEPTION 'cohort is full'`, SQLSTATE `P0001` / a custom `P0…`
 *   class): the message IS the consumer's own user-facing copy — pass it through. This is the intended way
 *   to give a friendly capacity/quota message.
 * - **Built-in integrity violations** (SQLSTATE class `23`) and everything else: return a stable generic
 *   message keyed by SQLSTATE — never the raw message/detail/hint. Full detail stays in the operations log.
 */
export function toPublicRejectionReason(error: unknown): string {
  const fallback = "The write was rejected by a server rule.";
  const rootCause = getRootCauseError(error);

  if (!rootCause) {
    return fallback;
  }

  // Resolve the SQLSTATE with the driver-agnostic helper (bun-sql — this project's runtime driver —
  // carries it on `errno`, not `code`; postgres.js / pg on `code`). Reading `error.code` directly, as
  // this did, returned bun's generic "ERR_POSTGRES_SERVER_ERROR" and dropped every app-authored `P0…`
  // and constraint code into the generic fallback, breaking ADR-0022's friendly rejection channel.
  // `readSqlState` walks the cause chain itself, so it runs on the ORIGINAL error; the app-authored
  // RAISE MESSAGE below still comes from the root cause.
  const code = readSqlState(error);

  // ADR-0030: the self-verifying apply function raises SQLSTATE 'PXS01' when its installed fingerprint
  // does not match this server's registry/codegen — the drift the deleted startup verify used to catch.
  // Surface the same actionable operator guidance the old startup error gave (it carries no PII, only the
  // regenerate-and-apply instruction), rather than the generic rejection fallback.
  if (code === "PXS01") {
    return (
      "The server's apply function is out of date: its installed fingerprint does not match this " +
      "server's registry/codegen. Regenerate the sync-function migration (pgxsinkit-generate) and apply " +
      "it before serving writes."
    );
  }

  // App-authored RAISE — the message is the consumer's own copy, safe to surface.
  if (code && (code === "P0001" || code.startsWith("P0"))) {
    return rootCause.message.trim() || fallback;
  }

  // Built-in integrity violations: generic, code-keyed messages only (no raw constraint names / values).
  const genericByCode: Record<string, string> = {
    "23505": "This conflicts with an existing record (a uniqueness rule was violated).",
    "23514": "A validation rule rejected this write.",
    "23503": "A referenced record is missing (a relationship rule was violated).",
    "23502": "A required value was missing.",
    "23P01": "An exclusion rule rejected this write.",
  };

  if (code && genericByCode[code]) {
    return genericByCode[code]!;
  }

  if (code && code.startsWith("23")) {
    return "A data-integrity rule rejected this write.";
  }

  return fallback;
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
      (entry.governance?.managedFields ?? []).some((field) => field.strategy === "authClaim"),
  );
}

class UnauthorizedBatchMutationError extends Error {}

/**
 * Thrown inside the authoritative write's transaction to roll the whole unit back when a member is a stale
 * write (ADR-0015) — distinct from an execution exception (a capacity/constraint rejection). The handler
 * catches it and reports every member `conflicted` (overlays kept), having committed nothing.
 */
class UnitNotCommittedError extends Error {}

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

// One structured warning per (table, dropped-key) per process. The apply path is hot; a memoized set
// keeps a recurring silent-drop from spamming the log while still surfacing it once. The keys are
// client-controlled (a malicious/buggy client can send unbounded junk keys), so the set is capped: past
// the cap we stop memoizing AND stop warning, so the process can never accumulate unbounded entries.
const warnedDroppedPayloadKeys = new Set<string>();
const MAX_WARNED_DROPPED_KEYS = 10_000;
// Set true after the one-time "warnings suppressed" notice fires, so the cap notice logs exactly once.
let droppedKeyWarningSuppressed = false;

/**
 * Warn — **once** per (table, key) per process — when a mutation payload carries a key the apply path
 * will **silently drop**: a key that is neither a writable (projected) column, a server-managed field,
 * nor a projected-away column that request validation already 400-rejects. The generated apply function
 * reads only the table's PROJECTED columns from the payload jsonb, so such a key never lands — were it
 * "applied" the write would collapse to a bare server-version (`updated_at_us`) bump. This is the clean
 * two-case split (ADR-0022 posture docs):
 *
 * - **Projected-away / server-only columns** (`clientProjection.omitColumns`) sent explicitly are
 *   **400-rejected** by {@link findProjectedFieldViolations} — they are NOT silently dropped, so this
 *   helper deliberately does **not** warn for them (warning "the write still succeeds" and then
 *   rejecting was the misleading overlap the review flagged).
 * - **Unknown non-column keys** (a typo, a stale field) are what the apply path silently ignores — those
 *   are exactly the keys this warns about, once, as a debugging aid. It is NOT an error and changes no
 *   semantics.
 *
 * Exported for direct unit coverage.
 */
export function warnOnSilentlyDroppedPayloadKeys(
  entry: SyncTableEntry,
  tableName: string,
  mutationKind: BatchMutationRequest["mutations"][number]["kind"],
  payload: unknown,
): void {
  if (mutationKind === "delete" || !isPlainObject(payload)) {
    return;
  }

  // The keys the apply path will actually write: the projected columns (what it reads from payload) plus
  // the managed fields for this operation (server-stamped, legitimately present). Both property key and
  // DB column name are accepted, so a payload keyed either way is not falsely flagged.
  const writable = new Set<string>();
  for (const { propertyKey, columnName } of getProjectedColumns(entry)) {
    writable.add(propertyKey);
    writable.add(columnName);
  }
  for (const { propertyKey, columnName } of getManagedFieldsForOperation(entry, mutationKind)) {
    writable.add(propertyKey);
    writable.add(columnName);
  }

  // Keys request validation will 400-REJECT (an explicitly-sent projected-away / server-only column):
  // those never reach apply, so they are NOT a silent drop — exclude them so the warning is reserved for
  // truly-unknown keys the apply path drops without validation rejecting.
  const rejectedAtValidation = new Set<string>();
  for (const { propertyKey, columnName } of getProjectedAwayFields(entry)) {
    rejectedAtValidation.add(propertyKey);
    rejectedAtValidation.add(columnName);
  }

  for (const key of Object.keys(payload)) {
    if (writable.has(key) || rejectedAtValidation.has(key)) {
      continue;
    }
    const memoKey = `${tableName}::${key}`;
    if (warnedDroppedPayloadKeys.has(memoKey)) {
      continue;
    }
    // Cap the memo set against client-controlled key spray: once full, emit one final suppression notice
    // and stop both memoizing and warning — the set never grows past the cap.
    if (warnedDroppedPayloadKeys.size >= MAX_WARNED_DROPPED_KEYS) {
      if (!droppedKeyWarningSuppressed) {
        droppedKeyWarningSuppressed = true;
        console.warn(
          `[pgxsinkit] Dropped-key warnings suppressed: more than ${MAX_WARNED_DROPPED_KEYS} distinct ` +
            `(table, key) pairs have been reported this process. Further dropped payload keys will not be logged.`,
        );
      }
      return;
    }
    warnedDroppedPayloadKeys.add(memoKey);
    console.warn(
      `[pgxsinkit] Payload for table "${tableName}" carries key "${key}", which is not a column of that ` +
        `table — the apply path silently ignores it (a write that reached apply would collapse to a bare ` +
        `server-version bump). This is almost always a typo or a stale field: check the spelling against ` +
        `the table's columns, or remove "${key}" if the schema no longer has it. (A projected-away/` +
        `server-only column would instead be 400-rejected, not dropped, so it is not what this warns about.) ` +
        `(Logged once per table+key per process.)`,
      { table: tableName, droppedKey: key, hint: "unknown-non-column-key" },
    );
  }
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

// ADR-0030: the apply-function drift verify is gone from startup — the function verifies itself in-body
// (SQLSTATE 'PXS01'). The only remaining boot-time check is the RLS auth-helper presence, and only when
// the registry actually needs it. Reached only under `startupVerification: "in-process"`.
async function installStartupDdl<TRegistry extends SyncTableRegistry>(
  db: PgAsyncDatabase<PgQueryResultHKT, RegistryRelations<TRegistry>>,
  registry: TRegistry,
): Promise<void> {
  if (isRlsAuthContextRequired(registry)) {
    await verifyRlsAuthHelpers(db);
  }
}
