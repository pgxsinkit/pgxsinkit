# Architecture

The repository is split into four boundaries:

## 1. Contracts

`packages/contracts` owns the transport shape. Zod schemas define what the browser may send and what the API may return.

## 2. Persistence

`packages/db` owns the PostgreSQL table definition via Drizzle. It also exports helpers for building a database connection and common SQL fragments.

## 3. Sync adapter

`packages/pglite-sync` vendors the upstream `@electric-sql/pglite-sync` implementation.

`packages/sync-engine` is a narrow wrapper around that vendored package. This keeps upstream behavior visible while giving the repo a stable place to layer retries, instrumentation, and version-specific patches later.

## 4. Verification harness

`tests/integration` proves the topology against real services. This is the main value of the repo. The demo UI is deliberately smaller than the harness.

## Current data flow

1. The write API validates a request with Zod.
2. The web client optionally attaches Authorization headers from demo identity tokens (`none`, `user`, `admin`).
3. Browser creates are written first into a local overlay table and a durable mutation journal in PGlite.
4. The browser may enqueue mutations one at a time or atomically stage a local batch into the same overlay and journal tables.
5. The browser flushes journal entries through the write API.
6. In artifact mode with RLS enabled, the write API verifies JWT claims and passes them to PostgreSQL via `resolveAuthClaims` and `auth.set_auth_context`.
7. The API writes to PostgreSQL using Drizzle or configured batch backend.
8. ElectricSQL exposes shape data from PostgreSQL.
9. The write API shape proxy (`/v1/shape-proxy`) forwards read requests to Electric and enforces owner filtering for protected tables unless caller role is admin.
10. PGlite subscribes through the vendored `packages/pglite-sync` implementation.
11. Acked overlay rows are cleared only after the synced echo reaches the acknowledged server `updated_at_us` value.
12. The integration tests assert eventual convergence inside local PGlite.

## Demo backend switching

The demo write API can switch mutation execution backends with `WRITE_API_BACKEND`:

- `drizzle` for direct Drizzle CRUD route writes
- `bulk-dynamic` for a single `/api/mutations` endpoint using runtime metadata lookup
- `bulk-pregenerated` for a single `/api/mutations` endpoint using startup-generated SQL functions
- `bulk-plpgsql` for a single `/api/mutations` endpoint that sends the full batch object to one PL/pgSQL entry function
- `bulk-plpgsql-artifact` for a single `/api/mutations` endpoint that requires a preinstalled PL/pgSQL entry function managed by migrations/artifacts, defers constraints during execution (`SET CONSTRAINTS ALL DEFERRED`), and applies Supabase-compatible auth claim context for RLS-enabled registries

The demo web client can opt into batch flush via `VITE_BATCH_WRITE_URL`. If unset, it uses per-table write routes.

Local client batching is separate from that transport choice. `client.mutate.batch([...])` stages multiple local mutations atomically in one PGlite transaction, but `flush()` remains the transport boundary. If `VITE_BATCH_WRITE_URL` is set, flush sends queued mutations through `POST /api/mutations`; otherwise flush drains the same local journal through per-table CRUD routes.

The write API also supports startup-time control of server-side operations logging via `WRITE_API_OPS_LOG_ENABLED`. This flag is read at process start and requires a restart to change.

The `operations_log` table is a Drizzle-managed internal server table included in drizzle-kit migration generation. Startup no longer creates this table at runtime. Provision database schema with `bun run db:push` (or generated migrations) before starting the write API.

`WRITE_API_OPS_LOG_ENABLED` controls whether logging rows are written. It does not control table creation.

## Provisioning runbooks

- `docs/migrations.md` defines the canonical schema-to-environment workflow.
- `docs/function-artifacts.md` defines support-function artifact generation, apply, and verification for `bulk-plpgsql-artifact`.

## Timestamp model

- `created_at_us` and `updated_at_us` are the authoritative time fields.
- They are stored as PostgreSQL `BIGINT` microseconds since unix epoch.
- They cross API and sync boundaries as decimal strings.
- Human-readable timestamp projections can be added later if they become operationally useful, but they are not the sync truth.
