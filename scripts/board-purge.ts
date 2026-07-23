import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";

import {
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

const TABLES = [messageTable, channelTable, issueTable, teamMemberTable, teamTable, profileTable];
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
  await db.execute(sql`DROP SCHEMA IF EXISTS ${sql.identifier("drizzle")} CASCADE`);

  console.log(
    `Purged board objects: ${TABLES.length} tables (cascading views/policies/triggers), ` +
      `${ENUMS.length} enums, ${FUNCTIONS.length} functions, and the drizzle migrations schema.`,
  );
}

await main();
