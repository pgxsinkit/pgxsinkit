# pgxsinkit

`pgxsinkit` is a hardened demo repository for a `PostgreSQL -> ElectricSQL -> PGlite` read path and a `client -> write API -> PostgreSQL` write path.

Canonical timestamps are stored as bigint microseconds since unix epoch and cross API/sync boundaries as decimal strings.

## Goals

- Keep the downward sync path aligned with upstream `@electric-sql/pglite-sync`, while vendoring locally for hardening.
- Put the write path behind a typed API using Bun, Drizzle, and Zod.
- Maintain fast unit tests plus container-backed integration tests.
- Make upgrades of Drizzle, PostgreSQL, ElectricSQL, and PGlite routine and measurable.

## Workspace layout

- `apps/web`: React + Vite demo UI using local PGlite.
- `apps/write-api`: Bun + Hono write API.
- `packages/contracts`: shared validation schemas and DTOs.
- `packages/pglite-sync`: vendored upstream sync implementation.
- `packages/sync-engine`: wrapper around vendored sync package.
- `packages/test-utils`: shared test helpers.
- `infra/compose`: compose files for PostgreSQL and ElectricSQL.
- `infra/drizzle`: drizzle migrations for PostgreSQL.
- `tests/unit`: pure unit tests.
- `tests/integration`: container-backed integration tests.

## Quick start

1. `mise install`
2. `bun install`
3. `cp .env.example .env`
4. `bun run infra:up`
5. `bun run dev:api`
6. `bun run dev:web`

`bun run infra:up` now applies the latest committed infra/drizzle migration history, including governance and sync-function migrations.

## Releasing

See [RELEASING.md](./RELEASING.md) for publishing the `@pgxsinkit/*` packages to npm and GitHub Packages (bump → tag → publish, one tag at a time).

## Provisioning workflow

1. Edit schema sources in `packages/schema/src/schema.ts`, `packages/schema/src/integration.ts`, and/or `packages/server/src/operations-log/schema.ts`.
2. Generate schema migrations: `bun run db:generate`.
3. Generate governance SQL when needed: `bun run db:generate:governance`.
4. Regenerate sync function artifact when registry/strategy changes: `bun run sync:function:generate`.
5. Review generated SQL under `infra/drizzle/`.
6. Apply the committed migration history: `bun run db:migrate` (or `bun run infra:up`).
7. Commit governance and sync-function migrations alongside the related code changes; there is no separate apply step for them.

See `docs/migrations.md` and `docs/function-artifacts.md`.

## Integration test model

- `bun run test:integration:contract`
- `bun run test:integration:implementation`
- `bun run test:integration`

These spin up isolated compose stacks on ephemeral ports and tear everything down afterward.

## Perf lab

`bun run perf:lab` now owns a dedicated fixed-name stack separate from the shared demo workflow. It tears down any prior `pgxsinkit-perf-lab` containers and child processes, starts fresh PostgreSQL, ElectricSQL, a dedicated perf-lab write server, and the browser lab, then writes logs under `tmp/perf-lab/`.

The browser default is the full cycle: seed PostgreSQL for the active synthetic registry, sync those rows into browser PGlite, flush local mutations upstream, and wait for the Electric echo to clear overlay state again.

## Performance suites

Long-running performance tests are intentionally separate from `bun run validate`.

Commands:

- `bun run test:performance`
- `bun run test:performance:client`
- `bun run test:performance:concurrent`
- `bun run test:performance:concurrent:matrix`
- `bun run test:performance:server`

The concurrent lane reads configuration from `PGXSINKIT_PERF_*` environment variables. For the common case, yes: prefixing the variable before the Bun command is enough.

Examples:

- `PGXSINKIT_PERF_CONCURRENT_EXEC_MODE=multi-process bun run test:performance:concurrent`
- `PGXSINKIT_PERF_CONCURRENT_EXEC_MODE=multi-process PGXSINKIT_PERF_PRESET=smoke PGXSINKIT_PERF_SCENARIO_KEY=mixed-small-bursts bun run test:performance:concurrent`

Execution mode options:

- `PGXSINKIT_PERF_CONCURRENT_EXEC_MODE=single-process`
- `PGXSINKIT_PERF_CONCURRENT_EXEC_MODE=multi-process`

If unset, the concurrent suite defaults to `single-process`.

Preset and scenario selection:

- `PGXSINKIT_PERF_PRESET=smoke|realistic|heavy`
- `PGXSINKIT_PERF_SCENARIO_KEY=mixed-small-bursts|mixed-small-plus-large|hot-partition-overlap`

The performance runner provisions its own isolated PostgreSQL and ElectricSQL stack, applies the current Drizzle schema, runs the requested perf tests, writes JSON reports under `tmp/perf-results/`, and tears the stack down afterward.

More detailed performance configuration, including the full env var list and matrix runner options, lives in `tests/performance/README.md`.

## Stable backend contract

Stable write mode is artifact-only:

- `WRITE_API_BACKEND=bulk-plpgsql-artifact`

Legacy backend strategy utilities are isolated under experimental exports:

- `@pgxsinkit/server/experimental`
- `@pgxsinkit/client/experimental`

Long-polling shape proxy requests may need a higher Bun idle timeout than the default 10 seconds.

- `WRITE_API_IDLE_TIMEOUT_SECONDS=120`

To send batch writes from web client:

- `VITE_BATCH_WRITE_URL=http://localhost:3001`

The web app reads `VITE_*` variables from the repository root `.env`, even when launched via `bun run dev:web`.

If unset, stable client behavior still uses `writeUrl` for `POST /api/mutations`.

## Demo auth lifecycle

The demo includes an end-to-end auth simulation without external identity providers:

- Web app identity selector: `none`, `user`, `admin`.
- `user` and `admin` use fixed Supabase-style HS256 JWTs.
- Client sends `Authorization: Bearer ...` for write and shape requests.
- Write API validates demo JWTs and maps claims into `resolveAuthClaims`.
- Write API exposes `/v1/electric-proxy`, forwarding to Electric and enforcing owner filters for protected tables (`authors`, `todos`) unless caller role is `admin`.

If `DEMO_JWT_SECRET` is unset, the shared demo secret is used.

## Operations logging

Server-side operations logging is startup-configured with:

- `WRITE_API_OPS_LOG_ENABLED=true` (default)
- `WRITE_API_OPS_LOG_ENABLED=false`

The `operations_log` table is migration-managed (not runtime-created).

## Validation

Typical gates:

- `bun run validate` # contains format, lint and typecheck
- `bun run test:integration:contract`
- `bun run test:integration:implementation`

## Version policy

- Type checking uses the native preview compiler (`bun run typecheck`).

## References

- `docs/architecture.md`
- `docs/testing-strategy.md`
- `docs/ai-assistant-guide.md`
