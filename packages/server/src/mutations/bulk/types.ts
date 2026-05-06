export type BulkMutationBackend = "bulk-plpgsql-artifact";

export interface TransactionClient {
  execute: (query: unknown) => Promise<unknown>;
}
