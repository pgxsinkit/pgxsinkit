import { z } from "zod";

import { unixMicrosecondsSchema } from "./common";

export const mutationKindSchema = z.enum(["create", "update", "delete"]);
export const mutationStatusSchema = z.enum(["pending", "sending", "acked", "failed"]);
export const mutationAckStatusSchema = z.enum(["acked", "failed", "conflicted"]);

export const entityKeySchema = z.record(z.string().trim().min(1), z.string().trim().min(1));

export const mutationEnvelopeSchema = z
  .object({
    tableName: z.string().trim().min(1),
    entityKey: entityKeySchema,
    mutationId: z.uuid(),
    mutationSeq: z.number().int().nonnegative(),
    kind: mutationKindSchema,
    payload: z.unknown(),
    clientTimestampUs: unixMicrosecondsSchema,
  })
  .strict();

export const mutationAckSchema = z
  .object({
    tableName: z.string().trim().min(1),
    entityKey: entityKeySchema,
    mutationId: z.uuid(),
    mutationSeq: z.number().int().nonnegative(),
    status: mutationAckStatusSchema,
    serverUpdatedAtUs: unixMicrosecondsSchema.optional(),
    conflictReason: z.string().trim().min(1).optional(),
    httpStatus: z.number().int().min(100).max(599).optional(),
  })
  .strict();

export const batchMutationRequestSchema = z
  .object({
    mutations: z.array(mutationEnvelopeSchema).min(1),
  })
  .strict();

export const batchMutationAckSchema = z
  .object({
    acks: z.array(mutationAckSchema),
  })
  .strict();

export type MutationKind = z.infer<typeof mutationKindSchema>;
export type MutationStatus = z.infer<typeof mutationStatusSchema>;
export type MutationAckStatus = z.infer<typeof mutationAckStatusSchema>;
export type EntityKey = z.infer<typeof entityKeySchema>;
export type MutationEnvelope = z.infer<typeof mutationEnvelopeSchema>;
export type MutationAck = z.infer<typeof mutationAckSchema>;
export type BatchMutationRequest = z.infer<typeof batchMutationRequestSchema>;
export type BatchMutationAck = z.infer<typeof batchMutationAckSchema>;
