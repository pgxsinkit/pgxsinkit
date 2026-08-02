import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";

import {
  boardIssueViewEventTable,
  boardSyncRegistry,
  channelKindEnum,
  channelTable,
  issuePriorityEnum,
  issueStatusEnum,
  issueTable,
  messageTable,
  profileTable,
  teamMemberTable,
  teamTable,
} from "@pgxsinkit/board-schema";
import { EVENT_STREAM_QUEUE_PREFIX, getSyncRegistryStreams } from "@pgxsinkit/contracts";

// Full purge of the board's migration-created objects, so `db:board:migrate` can re-apply the
// committed history from scratch — the "drop" half of the demo reset (purge → migrate → seed;
// .github/workflows/demo-reset.yml). This is what makes a REWRITTEN/collapsed migration history
// (docs/runbooks/regenerate-migrations.md) deployable to the one persistent database the board has —
// the cloud demo project — without hand-reconciling `drizzle.__drizzle_migrations`.
//
// Scope: OUR objects only, derived from the current board schema model — never a blanket
// `DROP SCHEMA public` (Supabase owns the schema container and may host extension objects in it).
// The drop list follows the model, so an object REMOVED from the model in a rewrite lingers until a
// later history reuses its name; for a nightly-rebuilt demo database that is acceptable.
//
// Drop order: tables first (CASCADE takes their views, policies, and triggers), then the enums, then
// the hand-written functions (their dependents — RLS policies, the issue trigger — are already gone),
// then the drizzle bookkeeping schema so migrate starts from an empty ledger.
//
// DROP statements have no drizzle-object form (tier ③ by nature), but every identifier that CAN be
// typed is: tables interpolate as Drizzle table objects, enum names come from the pgEnum model
// objects. Only the two PL/pgSQL helper names and the apply-function name are spelled out — they are
// hand-written custom SQL with no model object to reference.

const DATABASE_URL =
  process.env["BOARD_DATABASE_URL"] ??
  "postgresql://postgres:your-super-secret-and-long-postgres-password@localhost:54322/postgres?sslmode=disable";

const TABLES = [
  messageTable,
  channelTable,
  issueTable,
  teamMemberTable,
  teamTable,
  profileTable,
  // The Event lane's archive (pgxsinkit ADR-0053 decision 9). Migration-created like every other
  // board table; without this drop the re-applied history dies on its bare CREATE TABLE.
  boardIssueViewEventTable,
];
const ENUMS = [issueStatusEnum, issuePriorityEnum, channelKindEnum];
// The board's custom-migration functions (see infra/board-drizzle/*_board_prereqs) + the generated
// apply function (ADR-0018). Name-only DROP is unambiguous — one overload of each exists.
const FUNCTIONS = ["board_member_team_ids", "board_block_cross_team_move", "pgxsinkit_apply_mutations"];

async function main(): Promise<void> {
  const db = drizzle({ connection: DATABASE_URL });

  for (const table of TABLES) {
    await db.execute(sql`DROP TABLE IF EXISTS ${table} CASCADE`);
  }
  for (const pgEnum of ENUMS) {
    await db.execute(sql`DROP TYPE IF EXISTS ${sql.identifier(pgEnum.enumName)} CASCADE`);
  }
  for (const name of FUNCTIONS) {
    await db.execute(sql`DROP FUNCTION IF EXISTS ${sql.identifier(name)} CASCADE`);
  }

  // The Event lane's pgmq queues (pgxsinkit ADR-0053 decision 5), model-derived like the tables: one
  // queue per Event stream the board registry declares. `pgmq.create` in the re-applied migration is
  // idempotent, so the drop is not needed for migrate to succeed — it is needed so a reset also
  // discards queued-but-unconsumed and archived demo events (the cloud demo deploys no consumer
  // process, so the nightly reset is the only bound on queue growth). Guarded on the extension and on
  // the queue's own meta row, so a database that never ran the event-lane migration purges clean. The
  // extension itself is never dropped: Supabase owns the extension surface, and other tenants of the
  // cluster may use it.
  const streamNames = Object.keys(getSyncRegistryStreams(boardSyncRegistry) ?? {});
  let droppedQueues = 0;
  const pgmqInstalled = Array.from(
    (await db.execute(sql`SELECT 1 AS present FROM pg_extension WHERE extname = 'pgmq'`)) as Iterable<unknown>,
  );
  if (pgmqInstalled.length > 0) {
    for (const streamName of streamNames) {
      const queueName = `${EVENT_STREAM_QUEUE_PREFIX}${streamName}`;
      const dropped = Array.from(
        (await db.execute(
          // Tier ②: `drop_queue` runs once per matching meta row (0 or 1), so a missing queue is a
          // no-op rather than the error a bare call raises.
          sql`SELECT pgmq.drop_queue(queue_name) AS dropped FROM pgmq.meta WHERE queue_name = ${queueName}`,
        )) as Iterable<unknown>,
      );
      droppedQueues += dropped.length;
    }
  }

  await db.execute(sql`DROP SCHEMA IF EXISTS ${sql.identifier("drizzle")} CASCADE`);

  console.log(
    `Purged board objects: ${TABLES.length} tables (cascading views/policies/triggers), ` +
      `${ENUMS.length} enums, ${FUNCTIONS.length} functions, ${droppedQueues}/${streamNames.length} ` +
      `event-lane pgmq queues, and the drizzle migrations schema.`,
  );
}

await main();
