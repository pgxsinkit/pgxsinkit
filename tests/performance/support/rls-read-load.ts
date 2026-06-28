import { performance } from "node:perf_hooks";

import { sql, type SQL } from "drizzle-orm";
import { bigint, boolean, PgDialect, pgPolicy, pgRole, pgTable, uuid, varchar } from "drizzle-orm/pg-core";

import {
  buildGrantScopeShapeWhere,
  buildSupabaseGrantScopeNativePolicies,
  buildSupabaseMembershipNativePolicies,
  resolveGrantScopeIds,
  type JwtClaims,
} from "@pgxsinkit/contracts";

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
const nowMicrosecondsSql = sql`CAST(FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000000) AS BIGINT)`;

// Fixture tables (prefixed; varchar role to avoid provisioning an enum type). The real contracts
// policy builders are applied to these columns, so the track exercises the shipped artifact directly.
// The workspaces/offerings container tables are created via raw DDL in `provision()` — no policy
// references their columns (no write-gate here), so they need no Drizzle definition.
const workspaceMembersTable = pgTable(`${PREFIX}workspace_members`, {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull(),
  memberId: uuid("member_id").notNull(),
  role: varchar("role", { length: 32 }).notNull().default("member"),
  muted: boolean("muted").notNull().default(false),
});
const workItemsTable = pgTable(`${PREFIX}work_items`, {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull(),
  ownerId: uuid("owner_id"),
  createdAtUs: bigint("created_at_us", { mode: "bigint" }).notNull().default(nowMicrosecondsSql),
});
const enrolmentsTable = pgTable(`${PREFIX}enrolments`, {
  id: uuid("id").primaryKey(),
  offeringId: uuid("offering_id").notNull(),
  createdAtUs: bigint("created_at_us", { mode: "bigint" }).notNull().default(nowMicrosecondsSql),
});

const dialect = new PgDialect();

export interface RlsReadConfig {
  preset: "smoke" | "realistic" | "heavy";
  containers: number;
  focalContainers: number;
  rowsPerContainer: number;
  membersPerContainer: number;
  samples: number;
  rlsP95MaxMs: number;
}

interface RlsReadDb {
  execute: (query: SQL) => Promise<unknown>;
  transaction: <T>(fn: (tx: { execute: (query: SQL) => Promise<unknown> }) => Promise<T>) => Promise<T>;
}

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

interface ScenarioSpec {
  key: ScenarioKey;
  tableName: string;
  readQuery: string;
  indexDdl: string[];
  correctPolicies: ReturnType<typeof pgPolicy>[];
  naivePolicies: ReturnType<typeof pgPolicy>[];
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
  const predicate = sql`exists (select 1 from ${workspaceMembersTable} where ${workspaceMembersTable.memberId} = ${subject} and ${workspaceMembersTable.workspaceId} = ${workItemsTable.workspaceId})`;
  return [
    pgPolicy(`${PREFIX}work_items_select_membership_naive`, {
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
    readQuery: `SELECT id FROM ${tableName} ORDER BY created_at_us DESC LIMIT ${READ_LIMIT}`,
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
    readQuery: `SELECT id FROM ${tableName} ORDER BY created_at_us DESC LIMIT ${READ_LIMIT}`,
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
    claims: grantScopeClaims(config),
    shapeWhere: buildGrantScopeShapeWhere("offering_id", ids),
  };
}

export interface RlsReadModeMetric {
  mode: "baseline" | "shape-query" | "rls-correct" | "rls-naive";
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
  rlsVsShapeP95: number; // rls-correct indexed p95 / shape-query indexed p95
  explainCorrectIndexed: string;
  explainNaiveIndexed: string;
}

// ── provisioning + seeding ──────────────────────────────────────────────────

async function provision(db: RlsReadDb): Promise<void> {
  await db.execute(
    sql.raw(
      `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF; END $$;`,
    ),
  );
  await dropAll(db);
  await db.execute(
    sql.raw(
      `CREATE TABLE ${PREFIX}workspaces (id uuid PRIMARY KEY, owner_id uuid, locked boolean NOT NULL DEFAULT false)`,
    ),
  );
  await db.execute(
    sql.raw(
      `CREATE TABLE ${PREFIX}workspace_members (id uuid PRIMARY KEY, workspace_id uuid NOT NULL, member_id uuid NOT NULL, role varchar(32) NOT NULL DEFAULT 'member', muted boolean NOT NULL DEFAULT false)`,
    ),
  );
  await db.execute(
    sql.raw(
      `CREATE TABLE ${PREFIX}work_items (id uuid PRIMARY KEY, workspace_id uuid NOT NULL, owner_id uuid, created_at_us bigint NOT NULL DEFAULT 0)`,
    ),
  );
  await db.execute(sql.raw(`CREATE TABLE ${PREFIX}offerings (id uuid PRIMARY KEY)`));
  await db.execute(
    sql.raw(
      `CREATE TABLE ${PREFIX}enrolments (id uuid PRIMARY KEY, offering_id uuid NOT NULL, created_at_us bigint NOT NULL DEFAULT 0)`,
    ),
  );
  // authenticated needs SELECT on every table the policies read (including the membership lookup the
  // work_items subquery joins). RLS is enabled ONLY on the governed tables being measured — the lookup
  // tables (workspace_members, workspaces, offerings) stay readable, the standard "lookup secured via
  // the governed table" pattern. (Enabling RLS on the lookup with no policy would make the work_items
  // subquery return an empty set → the governed read would see zero rows.)
  for (const tableName of allTables()) {
    await db.execute(sql.raw(`GRANT SELECT ON TABLE ${tableName} TO authenticated`));
  }
  for (const tableName of [`${PREFIX}work_items`, `${PREFIX}enrolments`]) {
    await db.execute(sql.raw(`ALTER TABLE ${tableName} ENABLE ROW LEVEL SECURITY`));
  }
}

async function seed(db: RlsReadDb, config: RlsReadConfig): Promise<void> {
  const focal = focalIds(config);
  const focalValues = focal.map((id) => `('${id}')`).join(", ");

  // Containers: F deterministic focal + the rest random.
  await db.execute(sql.raw(`INSERT INTO ${PREFIX}workspaces (id) VALUES ${focalValues}`));
  await db.execute(sql.raw(`INSERT INTO ${PREFIX}offerings (id) VALUES ${focalValues}`));
  if (config.containers > config.focalContainers) {
    const extra = config.containers - config.focalContainers;
    await db.execute(
      sql.raw(`INSERT INTO ${PREFIX}workspaces (id) SELECT gen_random_uuid() FROM generate_series(1, ${extra})`),
    );
    await db.execute(
      sql.raw(`INSERT INTO ${PREFIX}offerings (id) SELECT gen_random_uuid() FROM generate_series(1, ${extra})`),
    );
  }

  // Focal user is a member of the F focal workspaces.
  await db.execute(
    sql.raw(
      `INSERT INTO ${PREFIX}workspace_members (id, workspace_id, member_id) SELECT gen_random_uuid(), w.id, '${FOCAL_SUBJECT}' FROM ${PREFIX}workspaces w WHERE w.id IN (${focal.map((id) => `'${id}'`).join(", ")})`,
    ),
  );
  // Bulk other memberships across all workspaces (volume for the subquery).
  await db.execute(
    sql.raw(
      `INSERT INTO ${PREFIX}workspace_members (id, workspace_id, member_id) SELECT gen_random_uuid(), w.id, gen_random_uuid() FROM ${PREFIX}workspaces w CROSS JOIN generate_series(1, ${config.membersPerContainer})`,
    ),
  );

  // Rows: rowsPerContainer per container, monotonic created_at_us for the ORDER BY.
  await db.execute(
    sql.raw(
      `INSERT INTO ${PREFIX}work_items (id, workspace_id, owner_id, created_at_us) SELECT gen_random_uuid(), w.id, '${FOCAL_SUBJECT}', (row_number() OVER ())::bigint FROM ${PREFIX}workspaces w CROSS JOIN generate_series(1, ${config.rowsPerContainer})`,
    ),
  );
  await db.execute(
    sql.raw(
      `INSERT INTO ${PREFIX}enrolments (id, offering_id, created_at_us) SELECT gen_random_uuid(), o.id, (row_number() OVER ())::bigint FROM ${PREFIX}offerings o CROSS JOIN generate_series(1, ${config.rowsPerContainer})`,
    ),
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
  const rows = (await db.execute(
    sql.raw(`SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = '${tableName}'`),
  )) as Array<{ policyname: string }>;
  for (const row of rows ?? []) {
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
  const claimsJson = JSON.stringify(claims).replace(/'/g, "''");
  let captured: CellResult | undefined;
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql.raw(`SET LOCAL ROLE authenticated`));
      await tx.execute(sql.raw(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`));
      await tx.execute(sql.raw(`SELECT set_config('request.jwt.claims', '${claimsJson}', true)`));
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
  const claimsJson = JSON.stringify(claims).replace(/'/g, "''");
  let plan = "";
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql.raw(`SET LOCAL ROLE authenticated`));
      await tx.execute(sql.raw(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`));
      await tx.execute(sql.raw(`SELECT set_config('request.jwt.claims', '${claimsJson}', true)`));
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
    const shaped = await timePrivileged(
      db,
      `SELECT id FROM ${spec.tableName} WHERE ${spec.shapeWhere} ORDER BY created_at_us DESC LIMIT ${READ_LIMIT}`,
      config.samples,
    );
    modes.push({
      mode: "shape-query",
      indexed,
      latencyMs: computePercentiles(shaped.ms),
      rowsReturned: shaped.rows,
      timedOut: shaped.timedOut,
    });

    for (const [variant, policies] of [
      ["rls-correct", spec.correctPolicies],
      ["rls-naive", spec.naivePolicies],
    ] as const) {
      await installPolicies(db, spec.tableName, policies);
      const measured = await timeUnderRls(db, spec.readQuery, spec.claims, config.samples);
      modes.push({
        mode: variant,
        indexed,
        latencyMs: computePercentiles(measured.ms),
        rowsReturned: measured.rows,
        timedOut: measured.timedOut,
      });
    }
  }

  // EXPLAIN captures on the indexed correct + naive policies.
  await installPolicies(db, spec.tableName, spec.correctPolicies);
  const explainCorrectIndexed = await explainUnderRls(db, spec.readQuery, spec.claims);
  await installPolicies(db, spec.tableName, spec.naivePolicies);
  const explainNaiveIndexed = await explainUnderRls(db, spec.readQuery, spec.claims);

  const pick = (mode: RlsReadModeMetric["mode"], indexed: boolean) =>
    modes.find((m) => m.mode === mode && m.indexed === indexed)?.latencyMs.p95 ?? 0;
  const correctIndexed = pick("rls-correct", true) || 1;

  return {
    scenario: spec.key,
    visibleRowEstimate: config.focalContainers * config.rowsPerContainer,
    modes,
    cliffRatioP95: pick("rls-naive", true) / correctIndexed,
    indexSpeedupP95: pick("rls-correct", false) / correctIndexed,
    rlsVsShapeP95: correctIndexed / (pick("shape-query", true) || 1),
    explainCorrectIndexed,
    explainNaiveIndexed,
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
