import { performance } from "node:perf_hooks";

import { and, desc, eq, exists, inArray, sql, type SQL } from "drizzle-orm";
import type { drizzle as bunSqlDrizzle } from "drizzle-orm/bun-sql";
import {
  bigint,
  boolean,
  PgDialect,
  pgPolicy,
  pgRole,
  pgTable,
  QueryBuilder,
  uuid,
  varchar,
  type AnyPgColumn,
  type AnyPgTable,
} from "drizzle-orm/pg-core";

import {
  buildGrantScopeShapeWhere,
  buildSupabaseGrantScopeNativePolicies,
  buildSupabaseMembershipNativePolicies,
  resolveGrantScopeIds,
  type JwtClaims,
} from "@pgxsinkit/contracts";

import { pgPolicies } from "../../support/catalog-tables";
import { createTablesFromSchema } from "../../support/drizzle";
import { computePercentiles } from "./scenario";

// ---------------------------------------------------------------------------
// RLS read-load harness (ADR-pending). Measures the *read* cost of RLS-governed
// SELECTs at scale, for the two authorization shapes pgxsinkit ships:
//   - membership fan-out: visible via an `IN (SELECT … FROM membership …)` subquery,
//   - grant-scope:        visible via a JWT-resident grant set (no join).
//
// Because Electric cannot read RLS, each shape is measured three ways, so we can
// compare what the *direct-read* endpoint pays (RLS) against what the *synced* path
// pays (the Electric shape `where`) against the unfiltered floor:
//   - baseline    — privileged SELECT, no predicate (the floor),
//   - shape-query — privileged SELECT + the resolved row-filter `where` (what Electric runs),
//   - rls         — SET ROLE authenticated + claims, policy active (what a direct read runs).
//
// The RLS line is measured for both the InitPlan-correct policy and the deliberately
// naive (correlated) variant, with and without the supporting index — so the suite
// both regression-guards the fast path and demonstrates the cliff.
//
// Everything is provisioned in self-contained, prefixed tables in `public` (the perf
// Postgres is ephemeral, recreated per run) so the track never touches the
// migration-provisioned membership schema and can freely swap policies/indexes.
// ---------------------------------------------------------------------------

const PREFIX = "rls_perf_";
const READ_LIMIT = 50;

// Fixture tables (prefixed; varchar role to avoid provisioning an enum type). The real contracts
// policy builders are applied to these columns, so the track exercises the shipped artifact directly.
// These pgTables ARE the provisioned DDL (rendered offline via `createTablesFromSchema`), so they
// carry NO pgPolicy extras — the harness installs/swaps policies per measurement cell — and the two
// governed tables are declared via `pgTable.withRLS` (the only RLS-enabled relations; the
// lookup/container tables stay plain). `created_at_us` defaults to 0 to match the provisioned shape
// (seeding always supplies it); the deterministic seeded values are what the ORDER BY exercises.
const workspacesTable = pgTable(`${PREFIX}workspaces`, {
  id: uuid("id").primaryKey(),
  ownerId: uuid("owner_id"),
  locked: boolean("locked").notNull().default(false),
});
const workspaceMembersTable = pgTable(`${PREFIX}workspace_members`, {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull(),
  memberId: uuid("member_id").notNull(),
  role: varchar("role", { length: 32 }).notNull().default("member"),
  muted: boolean("muted").notNull().default(false),
});
const workItemsTable = pgTable.withRLS(`${PREFIX}work_items`, {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull(),
  ownerId: uuid("owner_id"),
  createdAtUs: bigint("created_at_us", { mode: "bigint" }).notNull().default(0n),
});
const offeringsTable = pgTable(`${PREFIX}offerings`, {
  id: uuid("id").primaryKey(),
});
const enrolmentsTable = pgTable.withRLS(`${PREFIX}enrolments`, {
  id: uuid("id").primaryKey(),
  offeringId: uuid("offering_id").notNull(),
  createdAtUs: bigint("created_at_us", { mode: "bigint" }).notNull().default(0n),
});

const dialect = new PgDialect();

// The governed fixture table a scenario measures — both carry `id` + `createdAtUs`.
type GovernedFixtureTable = AnyPgTable & { id: AnyPgColumn; createdAtUs: AnyPgColumn };

/**
 * Author the measured read (optionally shape-filtered) as a tier-① builder over the fixture pgTable
 * and render it ONCE with inline params — the sampled statement stays a pre-rendered raw string, so
 * no per-iteration builder work contaminates the timing. The Electric-grammar `shapeWhere` fragment
 * is a measured artifact and is embedded byte-exact via `sql.raw`.
 */
function renderGovernedReadQuery(table: GovernedFixtureTable, shapeWhere?: string): string {
  let query = new QueryBuilder().select({ id: table.id }).from(table).$dynamic();
  if (shapeWhere !== undefined) {
    query = query.where(sql.raw(shapeWhere));
  }
  return dialect.sqlToQuery(query.orderBy(desc(table.createdAtUs)).limit(READ_LIMIT).getSQL().inlineParams()).sql;
}

export interface RlsReadConfig {
  preset: "smoke" | "realistic" | "heavy";
  containers: number;
  focalContainers: number;
  rowsPerContainer: number;
  membersPerContainer: number;
  samples: number;
  rlsP95MaxMs: number;
}

// The perf test hands the harness its real bun-sql Drizzle handle: setup/seeding author tier-①
// statements directly on it, while the measured cells keep executing pre-rendered raw strings.
type RlsReadDb = ReturnType<typeof bunSqlDrizzle>;

const presetSizing: Record<RlsReadConfig["preset"], Omit<RlsReadConfig, "preset" | "rlsP95MaxMs">> = {
  smoke: { containers: 200, focalContainers: 5, rowsPerContainer: 20, membersPerContainer: 10, samples: 100 },
  realistic: { containers: 1_000, focalContainers: 8, rowsPerContainer: 30, membersPerContainer: 15, samples: 200 },
  heavy: { containers: 4_000, focalContainers: 10, rowsPerContainer: 40, membersPerContainer: 20, samples: 200 },
};

export function readRlsReadConfig(): RlsReadConfig {
  const preset = resolvePreset(process.env["PGXSINKIT_PERF_PRESET"]);
  const sizing = presetSizing[preset];
  const containers = readPositiveInt("PGXSINKIT_PERF_RLS_CONTAINERS", sizing.containers);
  const focalContainers = Math.min(containers, readPositiveInt("PGXSINKIT_PERF_RLS_FOCAL", sizing.focalContainers));
  return {
    preset,
    containers,
    focalContainers,
    rowsPerContainer: readPositiveInt("PGXSINKIT_PERF_RLS_ROWS_PER_CONTAINER", sizing.rowsPerContainer),
    membersPerContainer: readPositiveInt("PGXSINKIT_PERF_RLS_MEMBERS_PER_CONTAINER", sizing.membersPerContainer),
    samples: readPositiveInt("PGXSINKIT_PERF_RLS_SAMPLES", sizing.samples),
    // The single hard budget: the correct policy, with its index, on the direct-read path. Generous and
    // env-overridable; the naive / no-index lines are reported, not asserted (they are expected to be slow).
    rlsP95MaxMs: readPositiveFloat(
      "PGXSINKIT_PERF_RLS_P95_MAX_MS",
      preset === "heavy" ? 60 : preset === "realistic" ? 35 : 20,
    ),
  };
}

// Deterministic focal ids so the JWT grants and the seeded focal containers/memberships agree.
function focalContainerId(index: number): string {
  return `f0000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;
}
const FOCAL_SUBJECT = "5ab10000-0000-4000-8000-000000000001";

function focalIds(config: RlsReadConfig): string[] {
  return Array.from({ length: config.focalContainers }, (_, index) => focalContainerId(index));
}

// The focal caller's claims: membership scenario carries only the subject (memberships are in the table);
// grant-scope carries the grant set in app_metadata.authorization.grants (no table).
function membershipClaims(): JwtClaims {
  return { role: "authenticated", sub: FOCAL_SUBJECT };
}
function grantScopeClaims(config: RlsReadConfig): JwtClaims {
  return {
    role: "authenticated",
    sub: FOCAL_SUBJECT,
    app_metadata: {
      authorization: {
        grants: focalIds(config).map((offeringId) => ({ role: "teacher", scope: { kind: "offering", offeringId } })),
      },
    },
  };
}

type ScenarioKey = "membership" | "grant-scope";

interface RlsVariant {
  mode: string;
  policies: ReturnType<typeof pgPolicy>[];
}

interface ScenarioSpec {
  key: ScenarioKey;
  tableName: string;
  /** The governed fixture pgTable — the typed authoring surface for the measured queries. */
  table: GovernedFixtureTable;
  readQuery: string;
  indexDdl: string[];
  correctPolicies: ReturnType<typeof pgPolicy>[];
  naivePolicies: ReturnType<typeof pgPolicy>[];
  /** Extra RLS forms to measure against the correct/naive baseline — the planner-guiding experiments. */
  extraVariants: RlsVariant[];
  claims: JwtClaims;
  shapeWhere: string;
}

// The policy `to authenticated` role marker. The role itself is ensured in SQL during provisioning;
// renderPolicyDdl emits `TO authenticated` literally, so this only needs to satisfy the builders' type.
const authenticatedPgRole = pgRole("authenticated");

// The naive membership variant: a **correlated** EXISTS over the membership table that references the
// governed container column, so it is re-evaluated per row (the read-path analogue of the grant-scope
// naive form). Contrast the correct policy's uncorrelated `container IN (SELECT … )`, hoisted once.
function buildNaiveMembershipPolicies(): ReturnType<typeof pgPolicy>[] {
  const subject = sql.raw(
    `(select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid)`,
  );
  // Tier-① authored: exists() over a QueryBuilder subquery whose predicate references the governed
  // table's column — the render keeps the per-row correlation (`... = "rls_perf_work_items".
  // "workspace_id"` inside `exists (select 1 …)`), so the experiment's plan shape is unchanged.
  const predicate = exists(
    new QueryBuilder()
      .select({ one: sql`1` })
      .from(workspaceMembersTable)
      .where(
        and(
          eq(workspaceMembersTable.memberId, subject),
          eq(workspaceMembersTable.workspaceId, workItemsTable.workspaceId),
        ),
      ),
  );
  return [
    pgPolicy(`${PREFIX}work_items_select_membership_naive`, {
      as: "permissive",
      for: "select",
      to: authenticatedPgRole,
      using: predicate,
    }),
  ];
}

// Shared SQL fragments for the experimental variants (the grants jsonb array; the JWT subject uuid).
const GRANTS_JSONB = `coalesce((coalesce(nullif(current_setting('request.jwt.claim', true), ''), nullif(current_setting('request.jwt.claims', true), ''))::jsonb #> '{app_metadata,authorization,grants}'), '[]'::jsonb)`;
const SUBJECT_UUID = `(select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid)`;
const CALLER_OFFERINGS_FN = `${PREFIX}caller_offerings`;

// Experiment 1 — restructure `IN (subquery)` → `= ANY(ARRAY(subquery))`. The ARRAY() materializes the
// (uncorrelated) set once and `= ANY(<array>)` is a ScalarArrayOp, which the planner CAN drive as an
// index scan — unlike the hashed-subplan semi-join that `IN (subquery)` produces.
function buildAnyArrayMembershipPolicies(): ReturnType<typeof pgPolicy>[] {
  const subject = sql.raw(SUBJECT_UUID);
  const predicate = sql`${workItemsTable.workspaceId} = any(array(select ${workspaceMembersTable.workspaceId} from ${workspaceMembersTable} where ${workspaceMembersTable.memberId} = ${subject}))`;
  return [
    pgPolicy(`${PREFIX}work_items_select_membership_anyarray`, {
      as: "permissive",
      for: "select",
      to: authenticatedPgRole,
      using: predicate,
    }),
  ];
}

function buildAnyArrayGrantScopePolicies(): ReturnType<typeof pgPolicy>[] {
  const predicate = sql`${enrolmentsTable.offeringId} = any(array(select (grant_elem -> 'scope' ->> 'offeringId')::uuid from jsonb_array_elements(${sql.raw(GRANTS_JSONB)}) as grant_elem where grant_elem -> 'scope' ->> 'kind' = 'offering' and grant_elem ->> 'role' = 'teacher'))`;
  return [
    pgPolicy(`${PREFIX}enrolments_select_grant_scope_anyarray`, {
      as: "permissive",
      for: "select",
      to: authenticatedPgRole,
      using: predicate,
    }),
  ];
}

// Experiment 2 — a STABLE SETOF function with a ROWS cardinality declaration. Postgres has no
// comment hints, but `ROWS n` tells the planner the function yields ~n rows, so the `IN (SELECT fn())`
// semi-join is estimated at ~n (not the default guess that drives the seq scan). Defined in provision().
function buildFnRowsGrantScopePolicies(): ReturnType<typeof pgPolicy>[] {
  const predicate = sql`${enrolmentsTable.offeringId} in (select ${sql.raw(`${CALLER_OFFERINGS_FN}()`)})`;
  return [
    pgPolicy(`${PREFIX}enrolments_select_grant_scope_fnrows`, {
      as: "permissive",
      for: "select",
      to: authenticatedPgRole,
      using: predicate,
    }),
  ];
}

function membershipScenario(): ScenarioSpec {
  const tableName = `${PREFIX}work_items`;
  // The synced (Electric) path's authorization is the same subquery, run privileged as a plain WHERE.
  const shapeWhere = `"workspace_id" in (select "workspace_id" from ${PREFIX}workspace_members where "member_id" = '${FOCAL_SUBJECT}')`;
  return {
    key: "membership",
    tableName,
    table: workItemsTable,
    readQuery: renderGovernedReadQuery(workItemsTable),
    indexDdl: [
      `CREATE INDEX IF NOT EXISTS ${PREFIX}wm_member_ws ON ${PREFIX}workspace_members (member_id, workspace_id)`,
      `CREATE INDEX IF NOT EXISTS ${PREFIX}wi_ws ON ${tableName} (workspace_id)`,
    ],
    correctPolicies: buildSupabaseMembershipNativePolicies({
      role: authenticatedPgRole,
      containerColumn: workItemsTable.workspaceId,
      ownerColumn: workItemsTable.ownerId,
      membershipTable: workspaceMembersTable,
      membershipContainerColumn: workspaceMembersTable.workspaceId,
      membershipSubjectColumn: workspaceMembersTable.memberId,
      managerRoleColumn: workspaceMembersTable.role,
    }),
    naivePolicies: buildNaiveMembershipPolicies(),
    extraVariants: [{ mode: "rls-anyarray", policies: buildAnyArrayMembershipPolicies() }],
    claims: membershipClaims(),
    shapeWhere,
  };
}

function grantScopeScenario(config: RlsReadConfig): ScenarioSpec {
  const tableName = `${PREFIX}enrolments`;
  const ids = resolveGrantScopeIds(grantScopeClaims(config), { scopeKind: "offering", roleValues: ["teacher"] });
  return {
    key: "grant-scope",
    tableName,
    table: enrolmentsTable,
    readQuery: renderGovernedReadQuery(enrolmentsTable),
    indexDdl: [`CREATE INDEX IF NOT EXISTS ${PREFIX}en_offering ON ${tableName} (offering_id)`],
    correctPolicies: buildSupabaseGrantScopeNativePolicies({
      role: authenticatedPgRole,
      scopeColumn: enrolmentsTable.offeringId,
      scopeKind: "offering",
      roleValues: ["teacher"],
    }),
    naivePolicies: buildSupabaseGrantScopeNativePolicies({
      role: authenticatedPgRole,
      scopeColumn: enrolmentsTable.offeringId,
      scopeKind: "offering",
      roleValues: ["teacher"],
      naive: true,
    }),
    extraVariants: [
      { mode: "rls-anyarray", policies: buildAnyArrayGrantScopePolicies() },
      { mode: "rls-fnrows", policies: buildFnRowsGrantScopePolicies() },
    ],
    claims: grantScopeClaims(config),
    // The Electric shape `where` is a measured artifact and must be the literal text Electric would
    // run — author it from the typed column via the contracts builder, render once inline.
    shapeWhere: new PgDialect().sqlToQuery(buildGrantScopeShapeWhere(enrolmentsTable.offeringId, ids).inlineParams())
      .sql,
  };
}

export interface RlsReadModeMetric {
  /** "baseline" | "shape-query" | "rls-<variant>" (rls-correct, rls-naive, rls-anyarray, rls-fnrows, …). */
  mode: string;
  indexed: boolean;
  latencyMs: ReturnType<typeof computePercentiles>;
  rowsReturned: number;
  /** A single query hit STATEMENT_TIMEOUT_MS (this cell is bounded, not precisely measured). */
  timedOut: boolean;
}

export interface RlsReadScenarioMetric {
  scenario: ScenarioKey;
  visibleRowEstimate: number;
  modes: RlsReadModeMetric[];
  cliffRatioP95: number; // rls-naive p95 / rls-correct p95 (indexed)
  indexSpeedupP95: number; // rls-correct no-index p95 / rls-correct indexed p95
  /** indexed RLS p95 ÷ indexed shape-query p95, per RLS variant (1.0 = as fast as the Electric shape). */
  vsShapeP95: Record<string, number>;
  /** indexed EXPLAIN ANALYZE plan, per RLS variant. */
  explains: Record<string, string>;
}

// ── provisioning + seeding ──────────────────────────────────────────────────

async function provision(db: RlsReadDb): Promise<void> {
  await db.execute(
    sql.raw(
      `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF; END $$;`,
    ),
  );
  await dropAll(db);
  // The five fixture tables, created from their pgTable definitions via the offline empty→schema DDL
  // generator. The two governed pgTables are `pgTable.withRLS`, so this emits exactly the two
  // `ALTER TABLE … ENABLE ROW LEVEL SECURITY` statements the harness needs: RLS is enabled ONLY on
  // the governed tables being measured — the lookup tables (workspace_members, workspaces, offerings)
  // stay readable, the standard "lookup secured via the governed table" pattern. (Enabling RLS on the
  // lookup with no policy would make the work_items subquery return an empty set → the governed read
  // would see zero rows.) No pgPolicy is attached to the fixture tables, so no CREATE POLICY is
  // emitted here — policies are installed/swapped per measurement cell.
  await createTablesFromSchema(db, {
    workspacesTable,
    workspaceMembersTable,
    workItemsTable,
    offeringsTable,
    enrolmentsTable,
  });
  // authenticated needs SELECT on every table the policies read (including the membership lookup the
  // work_items subquery joins).
  for (const tableName of allTables()) {
    await db.execute(sql.raw(`GRANT SELECT ON TABLE ${tableName} TO authenticated`));
  }

  // The ROWS-hinted grant-set resolver for the rls-fnrows experiment: a STABLE SETOF function whose
  // `ROWS 8` declaration gives the planner the cardinality the runtime jsonb subquery hides from it.
  // It reads only the JWT (no table), so no SECURITY DEFINER is needed; current_setting is session
  // state, visible regardless of the function's security context.
  await db.execute(
    sql.raw(
      `CREATE OR REPLACE FUNCTION ${CALLER_OFFERINGS_FN}() RETURNS SETOF uuid LANGUAGE sql STABLE ROWS 8 AS $fn$
        SELECT (grant_elem -> 'scope' ->> 'offeringId')::uuid
        FROM jsonb_array_elements(${GRANTS_JSONB}) AS grant_elem
        WHERE grant_elem -> 'scope' ->> 'kind' = 'offering' AND grant_elem ->> 'role' = 'teacher'
      $fn$`,
    ),
  );
  await db.execute(sql.raw(`GRANT EXECUTE ON FUNCTION ${CALLER_OFFERINGS_FN}() TO authenticated`));
}

// Seeding runs in setup (before any timing), so it executes live through the drizzle handle:
// tier-① inserts, with tier-② fragments only for what Drizzle cannot express (`gen_random_uuid()`,
// `row_number() over ()`, the `generate_series` row source, and `::uuid` on bound params feeding a
// select list, where Postgres cannot infer the parameter type from the insert target).
async function seed(db: RlsReadDb, config: RlsReadConfig): Promise<void> {
  const focal = focalIds(config);
  const qb = new QueryBuilder();
  // SQL fields in an insert…select must carry an alias (drizzle's typing enforces it); the alias only
  // names the select's output column and changes nothing about what is inserted.
  const focalSubjectUuid = (alias: string) => sql`${FOCAL_SUBJECT}::uuid`.as(alias);
  const rowNumberBigint = () => sql`(row_number() over ())::bigint`.as("created_at_us");
  const genRandomUuid = (alias: string) => sql`gen_random_uuid()`.as(alias);

  // Containers: F deterministic focal + the rest random.
  await db.insert(workspacesTable).values(focal.map((id) => ({ id })));
  await db.insert(offeringsTable).values(focal.map((id) => ({ id })));
  if (config.containers > config.focalContainers) {
    const extra = config.containers - config.focalContainers;
    await db
      .insert(workspacesTable)
      .select(qb.select({ id: genRandomUuid("id") }).from(sql`generate_series(1, ${extra})`));
    await db
      .insert(offeringsTable)
      .select(qb.select({ id: genRandomUuid("id") }).from(sql`generate_series(1, ${extra})`));
  }

  // Focal user is a member of the F focal workspaces.
  await db.insert(workspaceMembersTable).select(
    qb
      .select({ id: genRandomUuid("id"), workspaceId: workspacesTable.id, memberId: focalSubjectUuid("member_id") })
      .from(workspacesTable)
      .where(inArray(workspacesTable.id, focal)),
  );
  // Bulk other memberships across all workspaces (volume for the subquery).
  await db.insert(workspaceMembersTable).select(
    qb
      .select({ id: genRandomUuid("id"), workspaceId: workspacesTable.id, memberId: genRandomUuid("member_id") })
      .from(workspacesTable)
      .crossJoin(sql`generate_series(1, ${config.membersPerContainer})`),
  );

  // Rows: rowsPerContainer per container, monotonic created_at_us for the ORDER BY.
  await db.insert(workItemsTable).select(
    qb
      .select({
        id: genRandomUuid("id"),
        workspaceId: workspacesTable.id,
        ownerId: focalSubjectUuid("owner_id"),
        createdAtUs: rowNumberBigint(),
      })
      .from(workspacesTable)
      .crossJoin(sql`generate_series(1, ${config.rowsPerContainer})`),
  );
  await db.insert(enrolmentsTable).select(
    qb
      .select({ id: genRandomUuid("id"), offeringId: offeringsTable.id, createdAtUs: rowNumberBigint() })
      .from(offeringsTable)
      .crossJoin(sql`generate_series(1, ${config.rowsPerContainer})`),
  );
  await db.execute(sql.raw(`ANALYZE`));
}

async function dropAll(db: RlsReadDb): Promise<void> {
  for (const tableName of allTables()) {
    await db.execute(sql.raw(`DROP TABLE IF EXISTS ${tableName} CASCADE`));
  }
}

function allTables(): string[] {
  return [
    `${PREFIX}work_items`,
    `${PREFIX}workspace_members`,
    `${PREFIX}workspaces`,
    `${PREFIX}enrolments`,
    `${PREFIX}offerings`,
  ];
}

// ── policy install/swap + measurement ───────────────────────────────────────

function renderPolicyDdl(tableName: string, policy: ReturnType<typeof pgPolicy>): string {
  const config = policy as unknown as {
    name: string;
    for?: string;
    as?: string;
    using?: SQL;
    withCheck?: SQL;
  };
  const command = (config.for ?? "all").toUpperCase();
  const mode = (config.as ?? "permissive").toUpperCase();
  const using = config.using ? ` USING (${dialect.sqlToQuery(config.using).sql})` : "";
  const withCheck = config.withCheck ? ` WITH CHECK (${dialect.sqlToQuery(config.withCheck).sql})` : "";
  return `CREATE POLICY "${config.name}" ON ${tableName} AS ${mode} FOR ${command} TO authenticated${using}${withCheck}`;
}

async function installPolicies(
  db: RlsReadDb,
  tableName: string,
  policies: ReturnType<typeof pgPolicy>[],
): Promise<void> {
  await dropPolicies(db, tableName);
  for (const policy of policies) {
    await db.execute(sql.raw(renderPolicyDdl(tableName, policy)));
  }
}

async function dropPolicies(db: RlsReadDb, tableName: string): Promise<void> {
  const rows = await db
    .select({ policyname: pgPolicies.policyname })
    .from(pgPolicies)
    .where(and(eq(pgPolicies.schemaname, "public"), eq(pgPolicies.tablename, tableName)));
  for (const row of rows) {
    if (row.policyname === null) {
      continue;
    }
    await db.execute(sql.raw(`DROP POLICY IF EXISTS "${row.policyname}" ON ${tableName}`));
  }
}

// Per-cell sampling bounds, so a deliberately-pathological cell (naive policy, no index, heavy scale)
// can't run away: take up to `samples`, but stop once MIN_SAMPLES are in AND the cell has spent
// CELL_TIME_BUDGET_MS; and cap any single query at STATEMENT_TIMEOUT_MS (a timeout is a recorded data
// point — "doesn't complete in N s" — not a crash). The fast cells (correct policy) still get the full
// sample count well within the budget, so their p95 stays precise.
const MIN_SAMPLES = 5;
const CELL_TIME_BUDGET_MS = 3_000;
const STATEMENT_TIMEOUT_MS = 8_000;

interface CellResult {
  ms: number[];
  rows: number;
  timedOut: boolean;
}

// Sentinel thrown to force drizzle to ROLLBACK the read-only measurement tx — also the clean exit when
// a statement_timeout has already aborted it (COMMIT on an aborted tx would error).
const ROLLBACK_SENTINEL = Symbol("rls-read-load-rollback");

async function sampleCell(exec: () => Promise<unknown>, maxSamples: number): Promise<CellResult> {
  const ms: number[] = [];
  let rows = 0;
  let timedOut = false;
  const cellStart = performance.now();
  for (let i = 0; i < maxSamples; i += 1) {
    const started = performance.now();
    try {
      const result = await exec();
      ms.push(performance.now() - started);
      rows = Array.isArray(result) ? result.length : rows;
    } catch {
      // statement_timeout (or another abort) — record the capped sample and stop this cell.
      ms.push(performance.now() - started);
      timedOut = true;
      break;
    }
    if (i + 1 >= MIN_SAMPLES && performance.now() - cellStart >= CELL_TIME_BUDGET_MS) {
      break;
    }
  }
  return { ms, rows, timedOut };
}

async function timePrivileged(db: RlsReadDb, query: string, samples: number): Promise<CellResult> {
  return sampleCell(() => db.execute(sql.raw(query)), samples);
}

async function timeUnderRls(db: RlsReadDb, query: string, claims: JwtClaims, samples: number): Promise<CellResult> {
  const claimsJson = JSON.stringify(claims);
  let captured: CellResult | undefined;
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql.raw(`SET LOCAL ROLE authenticated`));
      await tx.execute(sql.raw(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`));
      await tx.execute(sql`select set_config('request.jwt.claims', ${claimsJson}, true)`);
      captured = await sampleCell(() => tx.execute(sql.raw(query)), samples);
      throw ROLLBACK_SENTINEL;
    });
  } catch (error) {
    if (error !== ROLLBACK_SENTINEL) {
      throw error;
    }
  }
  return captured ?? { ms: [], rows: 0, timedOut: true };
}

async function explainUnderRls(db: RlsReadDb, query: string, claims: JwtClaims): Promise<string> {
  const claimsJson = JSON.stringify(claims);
  let plan = "";
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql.raw(`SET LOCAL ROLE authenticated`));
      await tx.execute(sql.raw(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`));
      await tx.execute(sql`select set_config('request.jwt.claims', ${claimsJson}, true)`);
      const result = await tx.execute(sql.raw(`EXPLAIN (ANALYZE, BUFFERS) ${query}`));
      const rows = Array.isArray(result) ? (result as Array<Record<string, unknown>>) : [];
      // Each EXPLAIN row is a single "QUERY PLAN" text column; keep only string values.
      plan = rows
        .map((row) => {
          const value = Object.values(row)[0];
          return typeof value === "string" ? value : "";
        })
        .join("\n");
      throw ROLLBACK_SENTINEL;
    });
  } catch (error) {
    if (error !== ROLLBACK_SENTINEL) {
      return `EXPLAIN did not complete within ${STATEMENT_TIMEOUT_MS}ms (likely the naive plan at scale): ${String(error)}`;
    }
  }
  return plan;
}

async function runScenario(db: RlsReadDb, spec: ScenarioSpec, config: RlsReadConfig): Promise<RlsReadScenarioMetric> {
  const modes: RlsReadModeMetric[] = [];
  const rlsVariants: RlsVariant[] = [
    { mode: "rls-correct", policies: spec.correctPolicies },
    { mode: "rls-naive", policies: spec.naivePolicies },
    ...spec.extraVariants,
  ];
  // Composed once (tier-① builder + the byte-exact shape `where` fragment), rendered inline once —
  // every sample below replays the same pre-rendered raw string.
  const shapeQuery = renderGovernedReadQuery(spec.table, spec.shapeWhere);

  // Privileged baselines (no RLS) — independent of policy variant; measured per index state.
  for (const indexed of [false, true]) {
    if (indexed) {
      for (const ddl of spec.indexDdl) {
        await db.execute(sql.raw(ddl));
      }
      await db.execute(sql.raw(`ANALYZE`));
    }
    const base = await timePrivileged(db, spec.readQuery, config.samples);
    modes.push({
      mode: "baseline",
      indexed,
      latencyMs: computePercentiles(base.ms),
      rowsReturned: base.rows,
      timedOut: base.timedOut,
    });
    const shaped = await timePrivileged(db, shapeQuery, config.samples);
    modes.push({
      mode: "shape-query",
      indexed,
      latencyMs: computePercentiles(shaped.ms),
      rowsReturned: shaped.rows,
      timedOut: shaped.timedOut,
    });

    for (const variant of rlsVariants) {
      await installPolicies(db, spec.tableName, variant.policies);
      const measured = await timeUnderRls(db, spec.readQuery, spec.claims, config.samples);
      modes.push({
        mode: variant.mode,
        indexed,
        latencyMs: computePercentiles(measured.ms),
        rowsReturned: measured.rows,
        timedOut: measured.timedOut,
      });
    }
  }

  // EXPLAIN capture per RLS variant (indexed) — the plan is the experiment's primary evidence.
  const explains: Record<string, string> = {};
  for (const variant of rlsVariants) {
    await installPolicies(db, spec.tableName, variant.policies);
    explains[variant.mode] = await explainUnderRls(db, spec.readQuery, spec.claims);
  }

  const pick = (mode: string, indexed: boolean) =>
    modes.find((m) => m.mode === mode && m.indexed === indexed)?.latencyMs.p95 ?? 0;
  const correctIndexed = pick("rls-correct", true) || 1;
  const shapeIndexed = pick("shape-query", true) || 1;
  const vsShapeP95: Record<string, number> = {};
  for (const variant of rlsVariants) {
    vsShapeP95[variant.mode] = pick(variant.mode, true) / shapeIndexed;
  }

  return {
    scenario: spec.key,
    visibleRowEstimate: config.focalContainers * config.rowsPerContainer,
    modes,
    cliffRatioP95: pick("rls-naive", true) / correctIndexed,
    indexSpeedupP95: pick("rls-correct", false) / correctIndexed,
    vsShapeP95,
    explains,
  };
}

export async function runRlsReadLoad(
  db: RlsReadDb,
  config: RlsReadConfig,
): Promise<{ scenarios: RlsReadScenarioMetric[] }> {
  await provision(db);
  await seed(db, config);
  const scenarios: RlsReadScenarioMetric[] = [];
  scenarios.push(await runScenario(db, membershipScenario(), config));
  await dropPolicies(db, `${PREFIX}enrolments`);
  scenarios.push(await runScenario(db, grantScopeScenario(config), config));
  await dropAll(db);
  return { scenarios };
}

// ── env parsing ─────────────────────────────────────────────────────────────

function resolvePreset(raw: string | undefined): RlsReadConfig["preset"] {
  return raw === "smoke" || raw === "heavy" || raw === "realistic" ? raw : "realistic";
}
function readPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
function readPositiveFloat(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
