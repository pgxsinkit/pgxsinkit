// Started life as a copy of @electric-sql/pglite-sync (Apache-2.0, © ElectricSQL — see NOTICE).
// Fully internalized (ADR-0009); upstream compatibility is an explicit anti-goal (ADR-0028) — evolve freely.
import type { Offset } from "@electric-sql/client";
import type { PGliteInterface, Transaction } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { quoteIdentifier } from "@pgxsinkit/contracts";

import { renderCreateTableSql } from "../schema";
import { drizzleOverPg } from "./drizzle-executor";
import { getMetadataTables, getSessionMetadataTables, pickMetadataTables } from "./metadata-tables";
import { type Lsn, type SubscriptionKey } from "./types";

export interface SubscriptionState {
  key: SubscriptionKey;
  shape_metadata: Record<string, ShapeSubscriptionState>;
  last_lsn: Lsn;
}

export interface ShapeSubscriptionState {
  handle: string;
  offset: Offset;
}

export interface GetSubscriptionStateOptions {
  readonly pg: PGliteInterface | Transaction;
  readonly metadataSchema: string;
  readonly subscriptionKey: SubscriptionKey;
  /**
   * ADR-0042: read the SESSION (`pg_temp`) cursor instead of the durable one for an ephemeral group. On
   * every engine boot the session table is empty, so a returning ephemeral group correctly reads `null`
   * (a brand-new subscription) and re-streams its whole shape from scratch over the recreated TEMP cluster.
   */
  readonly sessionScoped?: boolean;
}

export async function getSubscriptionState({
  pg,
  metadataSchema,
  subscriptionKey,
  sessionScoped = false,
}: GetSubscriptionStateOptions): Promise<SubscriptionState | null> {
  const { subscriptionsMetadata } = pickMetadataTables(metadataSchema, sessionScoped);
  const rows = await drizzleOverPg(pg)
    .select()
    .from(subscriptionsMetadata)
    .where(eq(subscriptionsMetadata.key, subscriptionKey));

  if (rows.length === 0) {
    return null;
  }
  if (rows.length > 1) {
    throw new Error(`Multiple subscriptions found for key: ${subscriptionKey}`);
  }

  const row = rows[0];
  if (!row) {
    throw new Error(`Subscription row missing for key: ${subscriptionKey}`);
  }
  if (typeof row.key !== "string") {
    throw new Error(`Invalid key type: ${typeof row.key}`);
  }
  if (!row.shape_metadata || typeof row.shape_metadata !== "object") {
    throw new Error("Invalid shape_metadata payload");
  }
  if (typeof row.last_lsn !== "string") {
    throw new Error(`Invalid last_lsn type: ${typeof row.last_lsn}`);
  }

  return {
    key: row.key,
    shape_metadata: row.shape_metadata,
    last_lsn: BigInt(row.last_lsn),
  };
}

export interface UpdateSubscriptionStateOptions {
  pg: PGliteInterface | Transaction;
  metadataSchema: string;
  subscriptionKey: SubscriptionKey;
  shapeMetadata: Record<string, ShapeSubscriptionState>;
  lastLsn: Lsn;
  debug?: boolean;
  /** ADR-0042: persist the cursor to the SESSION (`pg_temp`) table for an ephemeral group. */
  sessionScoped?: boolean;
}

export async function updateSubscriptionState({
  pg,
  metadataSchema,
  subscriptionKey,
  shapeMetadata,
  lastLsn,
  debug,
  sessionScoped = false,
}: UpdateSubscriptionStateOptions) {
  if (debug) {
    console.log("updating subscription state", subscriptionKey, shapeMetadata, lastLsn);
  }

  const { subscriptionsMetadata } = pickMetadataTables(metadataSchema, sessionScoped);
  const lastLsnText = lastLsn.toString();
  await drizzleOverPg(pg)
    .insert(subscriptionsMetadata)
    .values({ key: subscriptionKey, shape_metadata: shapeMetadata, last_lsn: lastLsnText })
    .onConflictDoUpdate({
      target: subscriptionsMetadata.key,
      set: { shape_metadata: shapeMetadata, last_lsn: lastLsnText },
    });
}

export interface DeleteSubscriptionStateOptions {
  pg: PGliteInterface | Transaction;
  metadataSchema: string;
  subscriptionKey: SubscriptionKey;
}

export async function deleteSubscriptionState({ pg, metadataSchema, subscriptionKey }: DeleteSubscriptionStateOptions) {
  // ADR-0042: SCOPE-BLIND delete — remove the key from BOTH the durable and the session (`pg_temp`) cursor
  // tables. Idempotent (a `WHERE key = …` no-op on the table that never held it), so every existing caller —
  // `desync`, `discardEphemeral`, the `"rebuilt"` all-keys reset — clears both with zero caller changes, and
  // a persistent→ephemeral flip leaves no orphaned durable cursor row behind.
  const db = drizzleOverPg(pg);
  const { subscriptionsMetadata } = getMetadataTables(metadataSchema);
  const session = getSessionMetadataTables();
  await db.delete(subscriptionsMetadata).where(eq(subscriptionsMetadata.key, subscriptionKey));
  await db.delete(session.subscriptionsMetadata).where(eq(session.subscriptionsMetadata.key, subscriptionKey));
}

export interface MigrateSubscriptionMetadataTablesOptions {
  pg: PGliteInterface | Transaction;
  metadataSchema: string;
}

export async function migrateSubscriptionMetadataTables({
  pg,
  metadataSchema,
}: MigrateSubscriptionMetadataTablesOptions) {
  // ADR-0029 D3: the metadata relations are RENDERED from the `metadata-tables.ts` pgTables through the
  // in-house schema renderer (`renderCreateTableSql`), so the pgTable is the single source and the old
  // DDL/pgTable drift can no longer exist. The CREATE SCHEMA + `SET` GUC default remain tier-③-by-nature
  // (schema identifier assembled at construction; the GUC has no tier-①/② form). Executed together as
  // one batch, exactly as before — same relations, same IF NOT EXISTS idempotence, same GUC default.
  const { subscriptionsMetadata, shapeRowTags } = getMetadataTables(metadataSchema);
  // ADR-0042: alongside the durable relations, provision the SESSION (`pg_temp`) cursor + tag tables in the
  // SAME migrate step (once per engine, memoized by the caller). Their DDL is the unqualified `CREATE TEMP
  // TABLE` form rendered from the same session pgTables (single-source, ADR-0029 D3) — the TEMP keyword
  // places them in `pg_temp` where the DML (schema-qualified `pg_temp.*`) reads/writes them. They die with
  // the engine, so an ephemeral group's cursor lifetime is mechanically tied to the TEMP cluster it indexes.
  const session = getSessionMetadataTables();
  const statements = [
    `SET ${metadataSchema}.syncing = false;`,
    `CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(metadataSchema)};`,
    ...renderCreateTableSql(subscriptionsMetadata),
    ...renderCreateTableSql(shapeRowTags),
    ...renderCreateTableSql(session.subscriptionsMetadata, { temp: true }),
    ...renderCreateTableSql(session.shapeRowTags, { temp: true }),
  ];
  await pg.exec(statements.join("\n"));
}
