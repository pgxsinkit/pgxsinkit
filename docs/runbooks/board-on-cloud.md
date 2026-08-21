# Runbook: run the board demo on managed BaaS (Supabase Cloud)

> **Status: retired 2026-08-21 — the read path this describes no longer exists.** Electric Cloud is
> being shut down, and the classic Electric read path the board used against it was removed with
> ADR-0055 (the Circuits engine + durable-streams are now the sync core). What survives here is the
> write path, auth, migrations, seeding and the Event lane drain — all still accurate. The read half is
> marked below with what a revival would need. A return on the native read path is possible once an
> engine + durable-streams are hosted somewhere; nothing is committed to.

## When to use

When you want the `apps/board` demo's **write** path running against a real managed Supabase Cloud
project instead of the local compose stack (`bun run infra:up`). The same board code runs unchanged;
you supply your own credentials. Design: board
[ADR-0008](../../apps/board/docs/adr/0008-board-on-managed-baas.md) (and
[ADR-0007](../../apps/board/docs/adr/0007-supabase-asymmetric-auth-only.md) for the auth model).

This is **not** a one-command "push". It is: do the one-time manual setup below, fill in
`board.cloud.env`, then `bun run board:cloud:deploy`. Project creation is a manual console action that
cannot be scripted from this repo.

> The local stack proves everything the cloud path depends on (`bun run test:integration:board`, 8/8 —
> new-API-key flow, ES256/JWKS verification, the read/write topology). What only your cloud accounts can
> prove is the managed endpoints themselves; that is what this runbook drives.

## Prerequisites

- The **Supabase CLI** installed.
- A personal access token created while signed into the board demo's Supabase account.
- A **Supabase Cloud** account.
- `bun install` done in this repo.

## One-time setup (manual)

### 1. Create the Supabase project

In the Supabase dashboard, create a project. From **Project Settings**, collect:

- **Project ref** — the 20-character ref → `BOARD_SUPABASE_PROJECT_REF`. It is the authoritative
  target passed to every mutating Supabase CLI command.
- **Personal access token** — create one from the board account's account-token page →
  `BOARD_SUPABASE_ACCESS_TOKEN`.
- **Project URL** — `https://<ref>.supabase.co` → `BOARD_SUPABASE_URL`. This can be omitted for the
  standard URL, which the script derives from the ref.
- **API Keys** (the _new_ keys; the board uses asymmetric auth, which is the default for new projects):
  the **publishable** key → `BOARD_PUBLISHABLE_KEY`, the **secret** key → `BOARD_SECRET_KEY`.
- **Database** → the **direct** connection string (port 5432) → `BOARD_DATABASE_URL`, and the
  **transaction pooler** string (Supavisor, port 6543) → `BOARD_DB_POOLER_URL`.

No auth config is needed: new projects already sign sessions ES256 and expose
`/auth/v1/.well-known/jwks.json`, which the board functions verify against.

### 2. The read path — RETIRED, and what a revival needs

This step used to create an Electric Cloud source. It no longer applies: the classic Electric read path
was removed, and Electric Cloud is shutting down.

**No managed equivalent is provided here.** The native read path is two workloads —

- the **Circuits engine**, which needs a **direct** (non-pooler) logical-replication connection to the
  project's database, creates its own slot, and takes an explicit bare-name table list
  (`ELECTRIC_CIRCUITS_PG_TABLES`); and
- a **durable-streams** server, which the engine writes to and the edge reads from.

Supabase Cloud hosts neither, and this repo deploys neither — nothing in `board:cloud:*` stands them up.
So the cloud path deploys auth, migrations, the seed, the write function and the Event lane drain; the
read path has no upstream unless you run those two workloads yourself somewhere reachable.

Reviving it means pointing the board's two read functions at them, as three function secrets — the same
three the local stack sets on its `functions`
service ([`infra/compose/board-compose.yml`](../../infra/compose/board-compose.yml)):

- `CIRCUITS_ENGINE_URL` — the engine's control-plane HTTP, reachable **only** from `board-sync`.
- `DURABLE_STREAMS_URL` — the log, reachable **only** from `board-stream`. The durable-streams protocol
  has no read authorization in any implementation, so nothing else may reach it.
- `STREAM_TOKEN_SECRET` — one secret: `board-sync` mints stream tokens with it, `board-stream` verifies
  them.

Two gaps in this repo's cloud scripts must be closed at the same time, both recorded in
`scripts/board-cloud-deploy.ts`: the deployed-function list omits `board-stream`, and `ELECTRIC_SHAPE_URL`
is still a **required** input for a path that no longer exists.

### 3. Fill in `board.cloud.env`

```sh
cp board.cloud.env.example board.cloud.env   # board.cloud.env is gitignored — it holds real secrets
```

Fill in every value from steps 1–2, plus `BOARD_EVENTS_DRAIN_SECRET` — a secret you generate yourself
(`openssl rand -hex 32`) that gates the Event lane's drain function (see the Event lane section below).

The scripts pass `BOARD_SUPABASE_PROJECT_REF` through `--project-ref` for secrets and function
deployment. They do not use mutable `supabase link` state, so another checkout linked to another
project cannot redirect these commands. When a standard `BOARD_SUPABASE_URL` is also present, its
hostname must match the ref or the script fails before making changes.

The scripts pass `BOARD_SUPABASE_ACCESS_TOKEN` as `SUPABASE_ACCESS_TOKEN` only to Supabase CLI
subprocesses. They do not use global profile state, so the board and another application can belong to
completely separate Supabase accounts without requiring repeated logins.

## Deploy (repeatable)

```sh
bun run board:cloud:deploy
```

That runs, in order (each is also its own `board:cloud:*` script if you need to re-run one):

1. **migrate** — applies the board's migrations to the cloud DB over the **direct** connection (the
   SECURITY DEFINER membership helper + the apply function need the privileged `postgres` role).
2. **secrets** — sets `BOARD_EVENTS_DRAIN_SECRET` as a function secret. There is very little to set:
   Supabase Cloud auto-injects `SUPABASE_URL` (→ JWKS) and `SUPABASE_DB_URL` (the pooler → board-write)
   into every function, and the `SUPABASE_` prefix is reserved (the CLI rejects setting it).
   **Retired input:** this step still _requires_ `ELECTRIC_SHAPE_URL` and still pushes it. It feeds a path
   that no longer exists; a revival replaces it with the three secrets named in step 2 above.
3. **functions** — `bun run edge:build` then
   `supabase functions deploy board-write board-sync board-events-drain`. They deploy from the pre-built
   bundles (`supabase/config.toml` points each `entrypoint` at `functions-dist/<name>/index.js`,
   `verify_jwt = false` — each function self-verifies its own credential: board-write and board-sync the
   GoTrue session token, and the drain function its shared secret).
   **Retired gap:** the list omits `board-stream`, the read path's edge — so even with an engine and a log
   running, reads would have no gate deployed.
4. **cron** — enables `pg_cron` + `pg_net` and schedules `board_events_drain` to POST at the drain function
   every 10 seconds. See below.
5. **seed** — GoTrue identities (admin API via the project gateway, which translates your secret key into
   the service_role JWT) + the deterministic public fixtures (direct DB connection).

### The Event lane on this stack (the third function + cron)

Locally, the board's Event lane is drained by the toolkit's **long-lived consumer runner**
(`bun run dev:board:consumer`). Managed Supabase cannot host a long-lived process, so the cloud deploy
drains the same queues through a third edge function, `board-events-drain`, which runs one bounded
`drainOnce()` pass per invocation (pgxsinkit ADR-0053, amendment 2026-08-02). Two things call it:

- **The cron schedule is the delivery guarantee.** `bun run board:cloud:cron` is idempotent — it creates
  the extensions `if not exists` and (re-)schedules the fixed job name `board_events_drain`, so re-running
  it after a secret rotation or URL change is the supported way to update it. The job SQL embeds
  host-specific values (your project URL, your secret), which is exactly why it lives in the deploy script
  and never in a committed migration.
- **`board-write` nudges it on enqueue,** so an issue view archives in milliseconds rather than up to ten
  seconds later. The nudge is fire-and-forget: losing one costs latency, never an event.

`BOARD_EVENTS_DRAIN_SECRET` (in `board.cloud.env`) is the only gate — the callers are machines with no
GoTrue session — and the function compares it in constant time. Generate one with `openssl rand -hex 32`;
the deploy refuses anything but ≥16 characters of `[A-Za-z0-9_-]`, because it is embedded in the job's SQL.
Check on it with `select * from cron.job where jobname = 'board_events_drain';` and
`select * from cron.job_run_details order by start_time desc limit 5;`.

## Run the frontend against the cloud backend

```sh
bun run board:cloud:dev
```

That launches the local Vite client pointed at your cloud backend, deriving the browser vars
(`VITE_BOARD_SUPABASE_URL` + `VITE_BOARD_PUBLISHABLE_KEY`) from `BOARD_SUPABASE_URL` +
`BOARD_PUBLISHABLE_KEY` in `board.cloud.env`. Only `VITE_`-prefixed vars reach the browser, so this
exposes the **publishable** key (safe), never the secret.

Set `BOARD_FUNCTIONS_REGION` in `board.cloud.env` to the project's region (the REGION token in your
pooler host, e.g. `eu-central-1`). The client sends it as the `x-region` header on the **write** function
(board-write) only — via `writeRequestHeaders` — so its DB-bound worker executes **next to the database**
rather than next to you. Supabase runs functions near the caller by default, which makes every write
function→DB statement a cross-region round trip (measured from Singapore against an `eu-central-1`
project: ~162ms per statement, ~3s per write; pinned: the long hop is paid once on the client→function
leg). The read surfaces are deliberately **not** pinned: the edge is meant to sit behind a CDN, so
pinning reads away from the caller would add intercontinental hops per catch-up. A revival should
re-measure that for the control plane specifically — its upstream is the engine, which is DB-adjacent, so
the write function's argument may apply to it and not to the edge.

Sign in at `/login` with any seeded identity (e.g. `alice@board.local`, password `board-demo-password`).

To test the compiled production client rather than Vite's source-mode development server, run:

```sh
bun run board:cloud:preview
```

This builds `apps/board` with the same cloud `VITE_BOARD_*` values and serves its `dist` through Vite
preview at `http://localhost:5173`. Use `board:cloud:dev` on port `5660` for source-mode development.

> Prefer plain `bun run dev:board`? Then put `VITE_BOARD_SUPABASE_URL` + `VITE_BOARD_PUBLISHABLE_KEY` in
> the **workspace-root `.env`** (Vite reads `VITE_*` from there via `envDir`) — the same two values.

## Notes & troubleshooting

- **Frontend CORS** — the functions' built-in default allow-list covers only the e2e/preview origins
  (`http://localhost:5173`/`5174`), **not** the Vite dev-server port (5660) — so `board:cloud:dev`
  needs `BOARD_ALLOWED_ORIGINS` set (and re-pushed via `board:cloud:secrets`). Easiest: `*`, which
  reflects any request origin — sound for this backend because auth is a bearer token, not cookies —
  and never needs re-pushing when a dev port changes. Or enumerate exact origins (scheme+host+port).
  Symptom of a wrong list: every subscribe and every stream read dies as a CORS error and the client
  retries from the start of the stream forever — and in worker mode those requests are **invisible in
  the page's Network tab** (see the next note). A second, quieter CORS mistake belongs to the edge only:
  its mount must name `STREAM_READ_EXPOSED_HEADERS` on `Access-Control-Expose-Headers`, or the browser
  hides every `stream-*` header and the reader wedges without an error.
- **Sync traffic missing from DevTools** — in worker mode the whole engine runs in a SharedWorker, and
  browsers do not show a SharedWorker's network requests in the page's Network panel; the tab console
  only shows forwarded `[pgxsinkit·w]` rail lines. Inspect the worker itself (`chrome://inspect/#workers`
  → the board worker → inspect) — its own DevTools has the real Network and Console.
- **Direct vs pooler** — migrations and the seed use the **direct** connection (DDL / privileged role),
  as would the Circuits engine's replication connection if one were ever pointed here. The edge
  functions use the **pooler** (transaction mode, port 6543; `board-write`'s `postgres.js` already sets
  `prepare: false`).
- **Replica identity** — nothing to set by hand. The Circuits engine sets `REPLICA IDENTITY FULL` on
  the tables in its explicit list itself, which is one more reason that list must never be `*`.
- **`supabase` not found** — the secrets + functions steps spawn the Supabase CLI directly, so it must
  be a real binary on the PATH a non-interactive process sees (a shell alias/function, or a mise/asdf
  shim only active in your interactive shell, won't be visible). If the deploy fails with "`supabase`
  was not found on PATH", install the CLI globally or set `SUPABASE_BIN` to its absolute path:
  `SUPABASE_BIN=$(which supabase) bun run board:cloud:deploy`.
- **What can't be scripted** — project creation is an account-scoped console action, and hosting the
  engine + durable-streams is out of scope entirely; this repo's scripts own the repeatable
  migrate/deploy/seed work.
