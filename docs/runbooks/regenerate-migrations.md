# Runbook: regenerate the demo & integration migrations

## When to use

Whenever the demo or integration **schema** (`packages/schema`, `packages/board-schema`, the
operations-log schema) or the **sync registry** changes, regenerate the affected migrations so the
committed `infra/drizzle/` and `infra/board-drizzle/` histories match the current sources. Also use it,
when cleaning an ephemeral baseline, to collapse churn (e.g. several redundant `*_sync_artifact` folders) into one.

**This is entirely the agent's job. There is no operator/maintainer step — see
[Nothing for the maintainer](#nothing-for-the-maintainer--ever) at the end.** Unlike a product app with
a long-living personal dev/smoke database, pgxsinkit has **no persistent database at all**: every
database these migrations target is **ephemeral** — the demo stacks and the integration/perf harness
create a fresh Postgres and apply the whole committed history on each start/run. The one database that
physically persists — the hosted board demo's cloud project — is ephemeral **by policy**: the `Demo
reset` workflow (`.github/workflows/demo-reset.yml`, nightly + `workflow_dispatch`) purges every
migration-created object and re-applies the latest committed history from scratch before reseeding, so
a rewritten history ships by dispatching that workflow (never by hand-reconciling
`drizzle.__drizzle_migrations`).

## How the migration framework works here

- `drizzle-kit` 1.0+ emits one folder per migration (`migration.sql` + `snapshot.json`). There is **no
  central `meta/_journal.json`** — ordering is the timestamped folder prefix, and applied state is
  tracked in the `drizzle.__drizzle_migrations` table of whatever ephemeral DB is currently running.
- Two databases, two committed histories:
  - **`infra/drizzle/`** — the reference write-api and the integration/perf harness (`packages/schema`).
  - **`infra/board-drizzle/`** — the board demo (`packages/board-schema`).
- Each history mixes **generated** migrations (re-emit them on change) with **hand-written** custom
  migrations (no generator). `infra/drizzle` has no customs. The board's customs are NOT freely
  interleavable with a regenerated schema — they carry an apply-order dependency, so a board collapse
  rebuilds the whole set in order (see [Board: dependency-ordered full regeneration](#board-dependency-ordered-full-regeneration)):

  | set                   | generated (re-emit on change)                                                                                                             | hand-written (custom SQL — no generator)                                                                                     |
  | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
  | `infra/drizzle`       | utilities (generate CLI `--utilities`), schema (`db:generate`), governance (`db:generate:governance`), sync-fn (`sync:function:generate`) | —                                                                                                                            |
  | `infra/board-drizzle` | utilities (generate CLI `--utilities`), schema (`db:board:generate`), sync-fn (`db:board:sync-fn`)                                        | `*_board_prereqs` (membership + cross-team-trigger functions), `*_board_grants_trigger` (table grants + the `issue` trigger) |

  `db:generate` / `db:board:generate` diff the Drizzle schema against the latest `snapshot.json` on disk
  — they **never read a database**. The sync-fn generators (ADR-0018) stamp the apply function with a
  fingerprint of its own DDL; `sync:function:check` (run in CI and the server at startup) fails if a
  committed migration ever lags its registry.

## Procedure (all of it is the agent's; none of it needs a database)

Run from the repo root. Every step here is **filesystem-only** — nothing reads or writes a server DB.

1. **Edit the schema / registry sources.**
2. **Regenerate the affected migration(s):**
   - `infra/drizzle` schema change: `bun run db:generate` (and `bun run db:generate:governance` if
     typed governance metadata — DEFERRABLE constraints, conditional grants — changed)
   - `infra/drizzle` registry / apply-function change: `bun run sync:function:generate`
   - board schema change: `bun run db:board:generate`
   - board registry / apply-function change: `bun run db:board:sync-fn`

   For the board, mind the **apply ordering** — its hand-written customs are not freely interleavable
   with a regenerated schema. See [Board: dependency-ordered full regeneration](#board-dependency-ordered-full-regeneration).

3. **Format, validate, drift-check:**
   ```bash
   bun run format:write           # drizzle emits snapshot.json in its own style; oxfmt owns formatting
   bun run validate               # filesystem-only: PGlite-backed unit tests, never a server DB
   bun run sync:function:check    # asserts the committed sync-fn migrations match the registries
   ```
4. **Commit** the regenerated migration folders in the same changeset as the source edit.

To collapse churn in the ephemeral `infra/drizzle` baseline (e.g. redundant `*_sync_artifact` folders), delete the
stale **generated** folders and rebuild the chain in order — the **utilities migration first**, because
the schema column DEFAULTs and the generated apply function both call `public.pgxsinkit_clock_us()`, so a
chain missing or mis-ordering it fails at migrate time with an undefined-function error. The generate
CLI's `--utilities` mode uses `--name` as the **literal folder name** (it adds no timestamp prefix), so
pass an early-sorting name so it sorts before the drizzle-kit baselines:

```bash
bun packages/server/src/cli/generate.ts --utilities --project-dir . --config infra/drizzle.config.ts --name 20260703082600_pgxsinkit_utilities
bun run db:generate                 # the schema baseline
bun run db:generate:governance      # registry_governance (only if governance metadata changed)
bun run sync:function:generate      # the sync_artifact apply function, ordered last
```

Then run steps 3–4. The apply-function migration is a standalone `DROP … ; CREATE OR REPLACE`, so a single
fresh one ordered after the schema migrations is sufficient.

## Board: dependency-ordered full regeneration

The board (`infra/board-drizzle`) has a hard **apply order** its sources can't auto-satisfy in one
generated migration, so its hand-written customs are **not** freely interleavable with a regenerated
schema — collapsing it means rebuilding the whole set in dependency order, not preserving customs in
place. The order, and why:

1. **`*_pgxsinkit_utilities`** (generated, generate CLI `--utilities`) — `public.pgxsinkit_clock_us()`,
   the canonical microsecond clock. It must be **first**: the schema migration's column DEFAULTs and the
   apply function both call it, so a chain missing or mis-ordering it fails at migrate time with an
   undefined-function error. `--utilities` uses `--name` as the **literal folder name** (no timestamp
   prefix), so pass an early-sorting name so it sorts ahead of the drizzle-kit baselines.
2. **`*_board_prereqs`** (custom) — `board_member_team_ids()` (the recursion-free membership helper) and
   `board_block_cross_team_move()` (the trigger function). These must exist **before** the schema
   migration, because that migration's RLS policies reference the helper (`CREATE POLICY … board_member_team_ids()`
   fails if the function is absent). The helper is a **SQL** function that reads `team_member` (created
   later), so this migration runs `SET LOCAL check_function_bodies = off;` first — the body is validated
   at first call (runtime), by which point the table exists. The trigger function is PL/pgSQL (body never
   validated at CREATE), so it needs no special treatment but rides along here.
3. **schema** (generated, `db:board:generate`) — enums, the 6 tables, all RLS policies (current
   helper-based form), and `ENABLE ROW LEVEL SECURITY`.
4. **`*_board_grants_trigger`** (custom) — `GRANT`s to `authenticated` and `CREATE TRIGGER
issue_block_cross_team_move` (both need the tables, so they follow the schema).
5. **`*_board_sync_artifact`** (generated, `db:board:sync-fn`) — the `pgxsinkit_apply_mutations` apply
   function. Standalone `DROP … ; CREATE OR REPLACE`, ordered last.

Procedure (filesystem-only; timestamps increase with each call so the folders sort in this order):

```bash
rm -rf infra/board-drizzle/2026*/                                  # drop the whole board history
bun packages/server/src/cli/generate.ts --utilities --project-dir . --config infra/board-drizzle.config.ts --name 20260703082600_pgxsinkit_utilities
#   → --utilities uses --name as the LITERAL folder name (no timestamp prefix); the early-sorting name keeps it first
bunx drizzle-kit generate --custom --name=board_prereqs --config=infra/board-drizzle.config.ts
#   → fill its migration.sql with the two functions (SET LOCAL check_function_bodies=off; helper; trigger fn)
bun run db:board:generate                                          # the schema migration
bunx drizzle-kit generate --custom --name=board_grants_trigger --config=infra/board-drizzle.config.ts
#   → fill its migration.sql with the GRANTs + CREATE TRIGGER
bun run db:board:sync-fn                                           # the apply function
```

Then run the standard step 3 (`format:write`, `validate`, `sync:function:check`).

**Optional apply-validation (the agent's own; never the maintainer's).** Because the ordering has real
failure modes, it is worth confirming the fresh set applies before committing — against a **throwaway**
Postgres, never the running board stack (whose volumes `infra:up`/the smoke lane own):

```bash
PORT=55432; PROJ="board-mig-val-$$"
PGXSINKIT_INTEGRATION_POSTGRES_PORT=$PORT podman compose -f infra/compose/docker-compose.yml -p "$PROJ" up -d postgres
# wait for pg_isready, then apply as the harness superuser (its `postgres` role has a different password):
BOARD_DATABASE_URL="postgresql://supabase_admin:your-super-secret-and-long-postgres-password@127.0.0.1:$PORT/postgres?sslmode=disable" \
  bun run db:board:migrate
PGXSINKIT_INTEGRATION_POSTGRES_PORT=$PORT podman compose -f infra/compose/docker-compose.yml -p "$PROJ" down -v
```

The `supabase/postgres` harness image supplies the `authenticated` role and `auth.uid()`, so the board's
RLS + SECURITY DEFINER helper apply exactly as on the board stack.

## Nothing for the maintainer — ever

> These migrations only ever target **ephemeral** databases — the demo stacks and the integration/perf
> harness, recreated from scratch on every run. There is **no long-living pgxsinkit dev/smoke database**,
> so the "operator applies the migrations to their personal DB" step that exists for a product app
> **does not exist here**. The maintainer does **nothing**, and the agent must not imply otherwise.
>
> - The new history applies **automatically** the next time anything starts: every `bun run infra:up`
>   (board), `bun run infra:harness:up` (reference), and every integration/perf run brings up a fresh
>   Postgres and applies the **whole committed history**. There is nothing to apply by hand and nobody
>   to wait for.
> - **Never tell the maintainer to apply, migrate, reset, or "bring a database in line."** There is no
>   such database.
> - The **only** follow-up is optional and the **agent's own**: if a stack is **already running** and
>   should reflect the change immediately, the agent cycles it — `bun run infra:down && bun run infra:up`
>   (board) or `bun run infra:harness:down && bun run infra:harness:up` (reference). **If nothing is
>   running, there is nothing to do** — do not mention an apply step at all; saying so when no stack is
>   up is just confusing.
