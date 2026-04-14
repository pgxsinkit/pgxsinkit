import { z } from "zod";

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
