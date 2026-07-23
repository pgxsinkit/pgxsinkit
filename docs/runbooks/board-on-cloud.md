# Runbook: run the board demo on managed BaaS (Supabase Cloud + Electric Cloud)

## When to use

When you want the `apps/board` demo running against **real managed services** — a Supabase Cloud
project + an Electric Cloud source — instead of the local compose stack (`bun run infra:up`). The same
board code runs unchanged; you supply your own credentials. Design: board
[ADR-0008](../../apps/board/docs/adr/0008-board-on-managed-baas.md) (and
[ADR-0007](../../apps/board/docs/adr/0007-supabase-asymmetric-auth-only.md) for the auth model).

This is **not** a one-command "push". It is: do the one-time manual setup below, fill in
`board.cloud.env`, then `bun run board:cloud:deploy`. Two steps are manual console actions that
cannot be scripted from this repo (project creation and the Electric source).

> The local stack proves everything the cloud path depends on (`bun run test:integration:board`, 8/8 —
> new-API-key flow, ES256/JWKS verification, the read/write topology). What only your cloud accounts can
> prove is the managed endpoints themselves; that is what this runbook drives.

## Prerequisites

- The **Supabase CLI** installed.
- A personal access token created while signed into the board demo's Supabase account.
- A **Supabase Cloud** account and an **Electric Cloud** account (https://dashboard.electric-sql.cloud).
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

### 2. Create the Electric Cloud source

In the Electric Cloud dashboard, create a **source** pointed at your project's database. Electric needs
a **direct** (non-pooler) connection with logical replication — Supabase ships `wal_level=logical`, so
the project's direct connection string works as-is. Electric provisions a **source id** + **secret**;
compose them into:

```
ELECTRIC_SHAPE_URL=https://api.electric-sql.cloud/v1/shape?source_id=<id>&secret=<secret>
```

`board-sync` forwards to this verbatim (the proxy only rewrites `where`/`columns`), and the secret stays
server-side as a function secret — it never reaches the browser.

> **Activate subqueries on your Cloud source.** The board's membership-scoped shapes use a cross-table
> `where` subquery, which is a flagged Electric preview. On managed Electric Cloud it is **activated per
> source by Electric staff on request** (no self-serve toggle yet; default-on is intended) — so **ask
> Electric to enable subqueries for your source** (their Discord / support). Until then a normal member's
> shapes return `400 {"where":["Subqueries are not supported"]}` while an **admin** (all-rows, no
> subquery) works — that asymmetry is the symptom. Alternatively, self-host Electric with
> `ELECTRIC_FEATURE_FLAGS=allow_subqueries,tagged_subqueries` pointed at the project's direct DB and set
> `ELECTRIC_SHAPE_URL` to it. See
> [The Electric subquery requirement](https://pgxsinkit.github.io/concepts/electric-subqueries/).

### 3. Fill in `board.cloud.env`

```sh
cp board.cloud.env.example board.cloud.env   # board.cloud.env is gitignored — it holds real secrets
```

Fill in every value from steps 1–2.

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
2. **secrets** — sets `ELECTRIC_SHAPE_URL` as a function secret. That is the _only_ secret to set:
   Supabase Cloud auto-injects `SUPABASE_URL` (→ JWKS) and `SUPABASE_DB_URL` (the pooler → board-write)
   into every function, and the `SUPABASE_` prefix is reserved (the CLI rejects setting it).
3. **functions** — `bun run edge:build` then `supabase functions deploy board-write board-sync`. They
   deploy from the pre-built bundles (`supabase/config.toml` points each `entrypoint` at
   `functions-dist/<name>/index.js`, `verify_jwt = false` — the functions self-verify the session token).
4. **seed** — GoTrue identities (admin API via the project gateway, which translates your secret key into
   the service_role JWT) + the deterministic public fixtures (direct DB connection).

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
leg). The read proxy (board-sync) is deliberately **not** pinned: its upstream is Electric Cloud's global
CDN, so pinning it away from a distant visitor would add intercontinental hops per catch-up.

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
  Symptom of a wrong list: every shape request dies as a CORS error and the readers retry from
  `offset=-1` forever — and in worker mode those requests are **invisible in the page's Network tab**
  (see the next note).
- **Sync traffic missing from DevTools** — in worker mode the whole engine runs in a SharedWorker, and
  browsers do not show a SharedWorker's network requests in the page's Network panel; the tab console
  only shows forwarded `[pgxsinkit·w]` rail lines. Inspect the worker itself (`chrome://inspect/#workers`
  → the board worker → inspect) — its own DevTools has the real Network and Console.
- **Direct vs pooler** — migrations, the seed, and the Electric source use the **direct** connection
  (DDL / privileged role / logical replication). The edge functions use the **pooler** (transaction
  mode, port 6543; `board-write`'s `postgres.js` already sets `prepare: false`).
- **Electric and old values** — if update/delete-driven features misbehave on a synced table, set
  `REPLICA IDENTITY FULL` on it so Electric receives the previous row (the board's move-in/move-out read
  filter depends on it).
- **`supabase` not found** — the secrets + functions steps spawn the Supabase CLI directly, so it must
  be a real binary on the PATH a non-interactive process sees (a shell alias/function, or a mise/asdf
  shim only active in your interactive shell, won't be visible). If the deploy fails with "`supabase`
  was not found on PATH", install the CLI globally or set `SUPABASE_BIN` to its absolute path:
  `SUPABASE_BIN=$(which supabase) bun run board:cloud:deploy`.
- **What can't be scripted** — project creation and the Electric source are account-scoped console
  actions; this repo's scripts own the repeatable migrate/deploy/seed work.
