import { z } from "zod";

import { unixMicrosecondsSchema } from "./common";

export const syncRuntimePhaseSchema = z.enum(["booting", "syncing", "ready", "degraded"]);

export const syncRuntimeStatusSchema = z
  .object({
    phase: syncRuntimePhaseSchema,
    isRunning: z.boolean(),
    lastError: z.string().trim().min(1).optional(),
  })
  .strict();

export const syncServerAddressSchema = z
  .object({
    host: z.string().trim().min(1),
    port: z.number().int().positive(),
  })
  .strict();

export const mutationDiagnosticsSchema = z
  .object({
    pendingCount: z.number().int().nonnegative(),
    sendingCount: z.number().int().nonnegative(),
    ackedCount: z.number().int().nonnegative(),
    failedCount: z.number().int().nonnegative(),
    lastFlushAtUs: unixMicrosecondsSchema.optional(),
    lastAckAtUs: unixMicrosecondsSchema.optional(),
  })
  .strict();

export type SyncRuntimePhase = z.infer<typeof syncRuntimePhaseSchema>;
export type SyncRuntimeStatus = z.infer<typeof syncRuntimeStatusSchema>;
export type SyncServerAddress = z.infer<typeof syncServerAddressSchema>;
export type MutationDiagnostics = z.infer<typeof mutationDiagnosticsSchema>;
