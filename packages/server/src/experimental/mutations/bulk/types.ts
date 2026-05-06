export type ExperimentalBulkMutationBackend = "bulk-dynamic" | "bulk-pregenerated" | "bulk-plpgsql";

export interface TransactionClient {
  execute: (query: unknown) => Promise<unknown>;
}
