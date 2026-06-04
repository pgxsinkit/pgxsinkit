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
    close: () => (db as any).$client?.close() ?? Promise.resolve(),
  };
}

export const integrationEnvSchema = z.object({
  databaseUrl: z.string().default("postgresql://postgres:password@localhost:54321/pgxsinkit?sslmode=disable"),
  electricUrl: z.string().default("http://localhost:3000/v1/shape"),
});

export type IntegrationEnv = z.infer<typeof integrationEnvSchema>;

export function readIntegrationEnv(overrides?: Partial<IntegrationEnv>) {
  return integrationEnvSchema.parse({
    databaseUrl: process.env.DATABASE_URL,
    electricUrl: process.env.ELECTRIC_URL,
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
