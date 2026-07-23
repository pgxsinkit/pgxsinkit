import { z } from "zod";

import { composeCredentials } from "../../../infra/compose-credentials";

/**
 * Validated at import time so misconfiguration fails at startup naming the
 * offending variable, instead of propagating undefined into the server.
 */
const envSchema = z.object({
  DATABASE_URL: z.string().min(1).default(composeCredentials.DEFAULT_DATABASE_URL),
  ELECTRIC_URL: z.string().min(1).default("http://localhost:3000/v1/shape"),
  WRITE_API_OPS_LOG_ENABLED: z.stringbool().default(true),
  WRITE_API_IDLE_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(120),
  WRITE_API_PORT: z.coerce.number().int().positive().default(3001),
  DEMO_JWT_SECRET: z.string().min(1).optional(),
});

export const writeApiEnv = envSchema.parse(process.env);
