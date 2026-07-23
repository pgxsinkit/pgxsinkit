import { z } from "zod";

import { unixMicrosecondsSchema } from "./common";

export const mutationKindSchema = z.enum(["create", "update", "delete"]);
/**
 * The full Mutation-journal status machine — every status a journal row can hold, including the two
 * terminal states (`quarantined`, ADR-0006; `conflicted`, ADR-0015). Kept in lockstep with the
 * client's `MutationStatus` (packages/client/src/mutation-state.ts). Distinct from
 * {@link mutationAckStatusSchema}, the narrower *transport* subset a server ack may carry.
 */
export const mutationStatusSchema = z.enum([
  "pending",
  "sending",
  "acked",
  "failed",
  "quarantined",
  "conflicted",
  "rejected",
]);
/**
 * The *transport* statuses a server ack may carry. `acked` (applied), `failed` (transient, retry),
 * `conflicted` (ADR-0015 stale write — overlay KEPT, resolve as a new write), and `rejected` (ADR-0022 —
 * a business rejection from the authoritative endpoint: a server-side invariant the client cannot evaluate
 * said no, so the optimistic overlay is auto-discarded for the whole write-unit and the typed reason is
 * surfaced).
 */
export const mutationAckStatusSchema = z.enum(["acked", "failed", "conflicted", "rejected"]);

export const entityKeySchema = z.record(z.string().trim().min(1), z.string().trim().min(1));

export const mutationEnvelopeSchema = z
  .object({
    tableName: z.string().trim().min(1),
    entityKey: entityKeySchema,
    // INVARIANT — the public mutation surface is UUID-only by contract (this schema, the ack/rejection
    // schemas below, and the client's `mutation_id UUID` journal). The generated apply function and the
    // `operations_log` accept an OPAQUE TEXT id for one narrow case: a DIRECT server-side caller that
    // derives child envelopes (composite `${parentId}:<tag>:<n>` ids) and calls the apply function
    // itself, never crossing this HTTP route or the client journal. So a non-UUID id can never enter a
    // request that this schema validates. See packages/server/src/mutations/plpgsql-apply.ts.
    mutationId: z.uuid(),
    mutationSeq: z.number().int().nonnegative(),
    kind: mutationKindSchema,
    payload: z.unknown(),
    clientTimestampUs: unixMicrosecondsSchema,
    /**
     * The Base server version this write was authored against (ADR-0015): the row's Server version
     * at enqueue for a chain head, or its predecessor's resolved version for a chained write. The
     * applier compares the row's *current* Server version to it — `current > base` ⇒ a stale write
     * (an external write interleaved). Absent on a `create` (its conflict is a PK collision, a
     * separate concern) and on blind authoritative writes; absence means no stale check runs.
     */
    baseServerVersion: unixMicrosecondsSchema.optional(),
  })
  .strict();

export const mutationAckSchema = z
  .object({
    tableName: z.string().trim().min(1),
    entityKey: entityKeySchema,
    // UUID-only (public-surface invariant; see mutationEnvelopeSchema). The route builds every ack from
    // the request envelope's own UUID `mutationId` — never from the apply function's returned conflict
    // rows (which are TEXT and, for a direct caller's derived child, non-UUID) — so a text id can never
    // reach this ack: the conflict map is keyed by returned text ids but only looked up by request UUIDs.
    mutationId: z.uuid(),
    mutationSeq: z.number().int().nonnegative(),
    status: mutationAckStatusSchema,
    serverUpdatedAtUs: unixMicrosecondsSchema.optional(),
    conflictReason: z.string().trim().min(1).optional(),
    /**
     * The typed reason a `rejected` ack carries (ADR-0022): the authoritative endpoint's account of why the
     * write-unit was declined (a capacity/quota/uniqueness rule — e.g. the DB constraint or trigger message).
     * Surfaced to the app when the optimistic overlay is auto-discarded.
     */
    rejectionReason: z.string().trim().min(1).optional(),
    httpStatus: z.number().int().min(100).max(599).optional(),
  })
  .strict();

export const batchMutationRequestSchema = z
  .object({
    mutations: z.array(mutationEnvelopeSchema).min(1),
  })
  .strict();

/**
 * The body of an **authoritative write** (ADR-0022 §3, mechanism c): one pessimistic write-**unit** — a set
 * of co-committed mutations the server applies in its **own isolated transaction**, atomically, returning a
 * per-mutation ack. `writeUnit` is the client's unit id (the dynamic `transaction` tag, or the static
 * consistency-group key), carried for attribution. Distinct from `batchMutationRequestSchema` only in
 * *semantics* (atomic unit + a constraint exception → a clean `rejected` ack, never a whole-batch 500) and
 * its endpoint path; the mutation envelope is identical.
 */
export const authoritativeWriteRequestSchema = z
  .object({
    writeUnit: z.string().trim().min(1).optional(),
    mutations: z.array(mutationEnvelopeSchema).min(1),
  })
  .strict();

export const batchMutationAckSchema = z
  .object({
    acks: z.array(mutationAckSchema),
  })
  .strict();

/**
 * Per-mutation attribution for a structural batch rejection. The batch write is atomic —
 * one structurally-invalid mutation rejects the whole POST with a single non-2xx — so the
 * server names the offending mutation(s) here. That lets the client quarantine exactly those
 * and keep the innocent siblings retryable, instead of dragging the whole offline queue to
 * quarantine at the shared attempt cap.
 */
export const mutationRejectionSchema = z
  .object({
    tableName: z.string().trim().min(1),
    // UUID-only (public-surface invariant; see mutationEnvelopeSchema). Attribution names an offending
    // request mutation, whose id this same contract already validated as a UUID.
    mutationId: z.uuid(),
    mutationSeq: z.number().int().nonnegative(),
    reason: z.string().trim().min(1),
  })
  .strict();

/**
 * The body of a non-2xx batch-mutation response. `rejections` is present only when the fault
 * is attributable to specific mutations (payload validation); whole-batch faults (execution
 * 5xx, auth, malformed envelope) carry just a `message`. Unknown extra fields are stripped.
 */
export const batchMutationErrorSchema = z.object({
  message: z.string().optional(),
  rejections: z.array(mutationRejectionSchema).optional(),
});

export type MutationKind = z.infer<typeof mutationKindSchema>;
export type MutationStatus = z.infer<typeof mutationStatusSchema>;
export type MutationAckStatus = z.infer<typeof mutationAckStatusSchema>;
export type EntityKey = z.infer<typeof entityKeySchema>;
export type MutationEnvelope = z.infer<typeof mutationEnvelopeSchema>;
export type MutationAck = z.infer<typeof mutationAckSchema>;
export type BatchMutationRequest = z.infer<typeof batchMutationRequestSchema>;
export type AuthoritativeWriteRequest = z.infer<typeof authoritativeWriteRequestSchema>;
export type BatchMutationAck = z.infer<typeof batchMutationAckSchema>;
export type MutationRejection = z.infer<typeof mutationRejectionSchema>;
export type BatchMutationError = z.infer<typeof batchMutationErrorSchema>;
