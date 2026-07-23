export interface TransactionClient {
  execute: (query: unknown) => Promise<unknown>;
}
