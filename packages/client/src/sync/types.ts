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
 * A change the fold has established is the net UPSERT of a complete row.
 *
 * The narrowing is what the bulk paths rely on: `value` carries every projected column, so the rows
 * can go out as one multi-row statement (or a COPY) with no per-row branch on which columns are
 * present. Guaranteed by the engine, not merely hoped for — `row_to_json_cols` emits every column of
 * the shape's `out_cols` on every upsert.
 */
export type UpsertChangeMessage = SyncChange & {
  headers: { operation: "upsert" };
};
