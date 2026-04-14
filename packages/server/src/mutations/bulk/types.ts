export type BulkMutationBackend = "bulk-dynamic" | "bulk-pregenerated" | "bulk-plpgsql" | "bulk-plpgsql-artifact";

export interface TransactionClient {
  execute: (query: unknown) => Promise<unknown>;
}
