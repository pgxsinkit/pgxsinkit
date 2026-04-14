import type { Offset } from "@electric-sql/client";
import type { PGliteInterface, Transaction } from "@electric-sql/pglite";

import { type Lsn, type SubscriptionKey } from "./types";

const subscriptionTableName = "subscriptions_metadata";

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
}

export async function getSubscriptionState({
  pg,
  metadataSchema,
  subscriptionKey,
}: GetSubscriptionStateOptions): Promise<SubscriptionState | null> {
  const result = await pg.query<SubscriptionState>(
    `
      SELECT key, shape_metadata, last_lsn
      FROM ${subscriptionMetadataTableName(metadataSchema)}
      WHERE key = $1
    `,
    [subscriptionKey],
  );

  if (result.rows.length === 0) {
    return null;
  }
  if (result.rows.length > 1) {
    throw new Error(`Multiple subscriptions found for key: ${subscriptionKey}`);
  }

  const row = result.rows[0];
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
}

export async function updateSubscriptionState({
  pg,
  metadataSchema,
  subscriptionKey,
  shapeMetadata,
  lastLsn,
  debug,
}: UpdateSubscriptionStateOptions) {
  if (debug) {
    console.log("updating subscription state", subscriptionKey, shapeMetadata, lastLsn);
  }

  await pg.query(
    `
      INSERT INTO ${subscriptionMetadataTableName(metadataSchema)}
        (key, shape_metadata, last_lsn)
      VALUES
        ($1, $2, $3)
      ON CONFLICT(key)
      DO UPDATE SET
        shape_metadata = EXCLUDED.shape_metadata,
        last_lsn = EXCLUDED.last_lsn;
    `,
    [subscriptionKey, shapeMetadata, lastLsn.toString()],
  );
}

export interface DeleteSubscriptionStateOptions {
  pg: PGliteInterface | Transaction;
  metadataSchema: string;
  subscriptionKey: SubscriptionKey;
}

export async function deleteSubscriptionState({ pg, metadataSchema, subscriptionKey }: DeleteSubscriptionStateOptions) {
  await pg.query(`DELETE FROM ${subscriptionMetadataTableName(metadataSchema)} WHERE key = $1`, [subscriptionKey]);
}

export interface MigrateSubscriptionMetadataTablesOptions {
  pg: PGliteInterface | Transaction;
  metadataSchema: string;
}

export async function migrateSubscriptionMetadataTables({
  pg,
  metadataSchema,
}: MigrateSubscriptionMetadataTablesOptions) {
  await pg.exec(
    `
      SET ${metadataSchema}.syncing = false;
      CREATE SCHEMA IF NOT EXISTS "${metadataSchema}";
      CREATE TABLE IF NOT EXISTS ${subscriptionMetadataTableName(metadataSchema)} (
        key TEXT PRIMARY KEY,
        shape_metadata JSONB NOT NULL,
        last_lsn TEXT NOT NULL
      );
    `,
  );
}

function subscriptionMetadataTableName(metadataSchema: string) {
  return `"${metadataSchema}"."${subscriptionTableName}"`;
}
