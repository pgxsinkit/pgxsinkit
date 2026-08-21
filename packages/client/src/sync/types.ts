// Started life as a copy of @electric-sql/pglite-sync (Apache-2.0, © ElectricSQL — see NOTICE).
// Fully internalized (ADR-0009); upstream compatibility is an explicit anti-goal (ADR-0028) — evolve freely.
//
// What remains here is only what the NATIVE path uses. The shape-stream option and message types this
// file used to re-export were `@electric-sql/client`'s, and nothing reads them any more: the transport
// is `@durable-streams/client` and the change contract is `@pgxsinkit/contracts`' `SyncChange`.

import type { SyncChange } from "@pgxsinkit/contracts";

export type Lsn = bigint;

export type SubscriptionKey = string;
export type InitialInsertMethod = "insert" | "copy" | "json";

/**
 * A change the fold has established is a plain INSERT of a complete row.
 *
 * The narrowing is what the bulk-insert path relies on: `value` carries every column, so the rows can
 * go out as one multi-row INSERT (or a COPY) with no per-row branch on which columns are present.
 */
export type InsertChangeMessage = SyncChange & {
  headers: { operation: "insert" };
};
