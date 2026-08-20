import { z } from "zod";

export const integrationEnvSchema = z.object({
  databaseUrl: z.string().default("postgresql://postgres:password@localhost:54321/pgxsinkit?sslmode=disable"),
  /** The Circuits engine control API — what the in-process control plane calls to create shapes. */
  circuitsEngineUrl: z.string().default("http://localhost:7010"),
  /** durable-streams, which the lane's in-process edge proxies reads to. */
  durableStreamsUrl: z.string().default("http://localhost:8791"),
});

export type IntegrationEnv = z.infer<typeof integrationEnvSchema>;

export function readIntegrationEnv(overrides?: Partial<IntegrationEnv>) {
  return integrationEnvSchema.parse({
    databaseUrl: process.env["DATABASE_URL"],
    circuitsEngineUrl: process.env["CIRCUITS_ENGINE_URL"],
    durableStreamsUrl: process.env["DURABLE_STREAMS_URL"],
    ...overrides,
  });
}
