# Architecture

The repository is split into three boundaries:

## 1. Contracts

`packages/contracts` owns the transport shape. Zod schemas define what the browser may send and what the API may return.

## 2. Sync adapter

`packages/client/src/sync` is the read-path ingest engine — internalized into the client (ADR-0009), originally vendored from upstream `@electric-sql/pglite-sync`. Upstream compatibility is now an explicit anti-goal ([adr/0028](adr/0028-own-the-sync-engine-outright.md)): it is ours to evolve — a serialized commit queue, a registry-item-driven apply ladder, and registry-declared consistency groups. The registry entry is the engine's per-table spec ([adr/0029](adr/0029-registry-item-driven-ingest-engine.md)): apply strategy, `json`/COPY casts, local table identity, and metadata DDL all derive from the Drizzle model — never carried through the option surface, never introspected from `information_schema`. We still sync with Electric via `@electric-sql/client` + `@electric-sql/experimental`.

`@pgxsinkit/client` wraps the internal sync engine (`packages/client/src/shape-sync.ts`) — the place to layer retries and instrumentation. There is no separate sync-engine package (see [adr/0007](adr/0007-absorb-sync-engine.md)).

## 3. Verification harness

`tests/integration` proves the topology against real services. The harness and the demo app exist to prove and harden the `@pgxsinkit/*` toolkit — which is the product — not the other way round.

## Current data flow

1. The write API validates a request with Zod.
2. The web client optionally attaches Authorization headers from demo identity tokens (`none`, `user`, `admin`).
3. Browser creates are written first into a local overlay table and a durable mutation journal in PGlite.
4. The browser may enqueue mutations one at a time or atomically stage a local batch into the same overlay and journal tables.
5. The browser flushes journal entries through the write API.
6. When RLS is enabled, the write API verifies JWT claims and passes them to PostgreSQL via `resolveAuthClaims`.
7. The API writes to PostgreSQL through the in-database apply function `pgxsinkit_apply_mutations` (`POST /api/mutations`).
8. ElectricSQL exposes shape data from PostgreSQL.
9. The write API shape proxy (`/v1/electric-proxy`) forwards read requests to Electric and enforces owner filtering for protected tables unless caller role is admin.
10. PGlite subscribes through the client's internal read-path engine (`packages/client/src/sync`).
11. Acked overlay rows are cleared only after the synced echo reaches the acknowledged server `updated_at_us` value.
12. The integration tests assert eventual convergence inside local PGlite.

## The write path

There is exactly one write path (see [adr/0002](adr/0002-single-in-database-write-path.md)). It requires a preinstalled PL/pgSQL entry function (`pgxsinkit_apply_mutations`) managed by migrations, defers constraints during execution (`SET CONSTRAINTS ALL DEFERRED`), and applies Supabase-compatible auth claim context for RLS-enabled registries.

Client flush behavior uses the exact `batchWriteUrl` endpoint, whose path is `/api/mutations`; authoritative
units use its `/api/mutations/unit` sibling. There is no selectable backend.

The write API also supports startup-time control of server-side operations logging via `WRITE_API_OPS_LOG_ENABLED`. This flag is read at process start and requires a restart to change.

The `operations_log` table is a Drizzle-managed internal server table included in drizzle-kit migration generation. Startup no longer creates this table at runtime. Provision database schema with committed migrations via `bun run db:migrate` before starting the write API.

`WRITE_API_OPS_LOG_ENABLED` controls whether logging rows are written. It does not control table creation.

## Provisioning runbooks

- `docs/migrations.md` defines the canonical schema-to-environment workflow.
- `docs/function-artifacts.md` defines generation, apply, and verification of the write path's apply function (`pgxsinkit_apply_mutations`).

## Timestamp model

- `created_at_us` and `updated_at_us` are the authoritative time fields.
- They are stored as PostgreSQL `BIGINT` microseconds since unix epoch.
- They cross API and sync boundaries as decimal strings.
- Human-readable timestamp projections can be added later if they become operationally useful, but they are not the sync truth.

## Client mutation contract

- Applications must not directly mutate synced tables.
- Client writes must go through the mutation runtime, which stages local intent into overlay and journal tables.
- Synced tables are updated by shape sync from ElectricSQL and are treated as replication targets.
- A flush failure is durable and classified (see [adr/0006](adr/0006-local-schema-evolution.md)): a transient error (network / `5xx` / transient `4xx`) stays a retryable `failed` under jittered, capped backoff; a structural `4xx` rejection — or exhausting the hard attempt cap — becomes a terminal `quarantined`, surfaced via the `onQuarantine` callback and never retried.

## Read-path identity and the token provider contract

The read path and the write path share **one** token lifecycle (see [adr/0013](adr/0013-read-path-identity-refresh.md); the client mirror of [adr/0003](adr/0003-secured-sync-ingress.md)'s server-side one-identity decision). The client consults the consumer's `getAuthToken` **per request** — never frozen at boot:

- Each shape's `Authorization` header is an async function (`async () => Bearer ${await getAuthToken()}`) that Electric resolves on every request and every retry, so a long-lived offline-first session always presents a fresh token instead of one captured at startup. An absent token resolves to an empty value (unauthenticated), never the literal `Bearer undefined`.
- A read-path auth error (`401`/`403`) is recovered at the per-shape `onError`, which returns retry so Electric re-resolves the header for a fresh token. Electric already auto-retries network/`5xx`/`429`, but **not** `4xx`, so this is the gap the toolkit closes. It never returns `void` for an auth error — `void` stops the stream permanently, which is wrong for offline-first.
- A persistent auth failure retries forever with jittered backoff (no attempt cap) and surfaces a distinct **`auth-needed`** status through `onStatusChange` (kept separate from `degraded`, a commit-retry exhaustion), so the app can prompt re-login. Sync auto-resumes — the status returns to `ready`/`syncing` — the instant re-authentication makes `getAuthToken` valid again; the read path never silently wedges or permanently dies.

**Provider contract — `getAuthToken` must be refresh-deduping.** It is now called per request by **both** paths, so it must return the cached valid token and refresh **single-flight**: an N-shape consistency group resolves the header per request, and a momentarily-expired token must trigger exactly **one** refresh, not N. The consumer owns this dedup; the toolkit calls the provider and assumes it.

## Client lifecycle and the local store

- The local store is keyed by the registry fingerprint (recorded in `pgxsinkit_local_meta`), not a manual `idb://…-vN` suffix. On boot the client reconciles a fingerprint change with a drain-then-drop rebuild of the read cache, deferring the rebuild while writes are still owed so nothing is dropped (see [adr/0006](adr/0006-local-schema-evolution.md)).
- `stop()` halts sync and closes the handle, **preserving** the local store. `destroy()` is a true teardown that **wipes** the store (synced cache + overlay + journal), refusing while writes are owed unless `destroy({ force: true })`. `dropReadCache()` rebuilds only the reconstructible synced cache, preserving the journal and overlay.
- Convergence is manual by default (`flush`/`reconcile`/`retryFailed` stay public). Supplying `autoSync` (a `ConvergenceTrigger`) opts into the driver, which owns the loop on the app's schedule while the library owns the congestion policy (see [adr/0005](adr/0005-mutation-convergence.md)). `createBrowserConvergenceTrigger` and `createIntervalConvergenceTrigger` are the bundled adapters.

## Local schema prerequisite hook

- Client initialization now supports a pre-schema hook: `prepareLocalDbBeforeSchema`.
- This hook runs after PGlite creation and before local schema SQL execution when `createSyncClient` creates the database instance.
- Use this hook to provision prerequisite local objects required by generated schema SQL.
- `prepareLocalDbAfterSchema` runs after generated local schema execution for app objects that depend
  on the registry tables.

## The parity boundary

The local schema is a read cache plus write-staging buffer, not a mirror of Postgres. The full,
canonical boundary — what is **never** local (server authority) versus what is **not yet** local
(best-effort gaps to narrow) — is defined in [CONTEXT.md](../CONTEXT.md) (the _Parity boundary_
term) and explained on the docs site's "Local schema & DDL parity" page. In short:

- **Never local (server authority):** RLS/governance enforcement, triggers, functions, materialized
  views, and managed-field values.
- **Not yet local (best-effort gaps):** static defaults, generated columns, CHECK, FOREIGN KEY, and
  UNIQUE — enforceable only against the synced subset, never a substitute for the server.
- Automatic provisioning is limited to enum types; other prerequisite objects go through
  `prepareLocalDbBeforeSchema`.
