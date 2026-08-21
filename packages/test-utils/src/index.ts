import { drizzle } from "drizzle-orm/bun-sql";
import { defineRelations } from "drizzle-orm/relations";
import { z } from "zod";

import type { RegistryRelations, SyncTableRegistry } from "@pgxsinkit/contracts";
import { buildRegistrySchema } from "@pgxsinkit/server";

export function createServerDb<TRegistry extends SyncTableRegistry>(
  registry: TRegistry,
  databaseUrl: string,
): { db: ReturnType<typeof drizzle<RegistryRelations<TRegistry>>>; close: () => Promise<void> } {
  const schema = buildRegistrySchema(registry);
  const relations = defineRelations(schema) as RegistryRelations<TRegistry>;
  const db = drizzle({ connection: databaseUrl, relations });
  return {
    db: db as ReturnType<typeof drizzle<RegistryRelations<TRegistry>>>,
    close: () => db.$client.close(),
  };
}

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

export async function waitFor(callback: () => Promise<void>, options?: { timeoutMs?: number; intervalMs?: number }) {
  const timeoutMs = options?.timeoutMs ?? 15_000;
  const intervalMs = options?.intervalMs ?? 250;
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    try {
      await callback();
      return;
    } catch (error) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
      if (Date.now() - start >= timeoutMs) {
        throw error;
      }
    }
  }

  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}
