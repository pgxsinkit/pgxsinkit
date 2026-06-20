# Testing Strategy

## Unit tests

Unit tests must stay fast and deterministic. They cover:

- contract parsing and normalization
- sync URL and shape configuration
- write payload mapping
- local mutation journaling semantics, including atomic client-side batch enqueue and per-entity sequencing
- explicit edge cases such as blank titles or invalid UUIDs

## Integration tests

Integration tests are container-backed and require `infra/compose/docker-compose.yml`.

Each integration test command launches its own isolated Podman Compose project on ephemeral host ports, runs tests against those URLs, and tears containers down (including volumes) afterwards. This keeps integration runs independent from demo/example containers and from each other.

This is the canonical integration workflow for the repo.

Schema ownership for integration tests is strict:

- PostgreSQL tables used by the demo app and integration suites belong in `packages/schema` and must be migrated through Drizzle.
- Integration tests must not create server-side tables inline when the shape can be expressed through Drizzle schema modules and normal migrations.
- Cleanup should prefer Drizzle table deletes or other schema-owned helpers over handwritten setup SQL.

The remaining accepted raw SQL in integration coverage is narrow:

- grants to Supabase roles such as `authenticated`, because Drizzle policies do not grant table privileges by themselves
- PostgreSQL-specific constraint/session commands such as `ALTER CONSTRAINT ... DEFERRABLE` when the target behavior is not emitted by the current Drizzle migration path
- PGlite-local runtime/schema SQL where the client runtime does not have a Drizzle migration adapter
- PL/pgSQL function DDL and execution paths that are intentionally generated as SQL artifacts

Run them by slice when possible:

- `bun run test:integration:contract` for public facade contract coverage
- `bun run test:integration:implementation` for lower-level implementation coverage
- `bun run test:integration` for the full integration suite

Use `bun run infra:up` only for manual local demo development. It applies the committed infra/drizzle migration history after infra becomes reachable. Integration scripts must not depend on or reuse that shared stack.

### Contract suites

These verify the public facade surfaces against non-demo registries and should stay focused on externally visible behavior.

- client facade readiness, persistence, local typed access, and write-path diagnostics
- server facade diagnostics, health, CRUD behavior, validation, and missing-record handling

### Implementation suites

These verify the lower-level integration behavior behind the facades.

The canonical scenarios are:

- initial sync from PostgreSQL through ElectricSQL into PGlite
- server-side writes becoming visible to a running PGlite subscriber
- write API validation failures and successful persistence
- local batch submission through the public client facade, including create-plus-update chains before flush
- deferred foreign-key behavior for out-of-order batch writes
- repeated polling without fixed sleeps

## Upgrade gates

When changing PostgreSQL, ElectricSQL, PGlite, or the vendored `packages/pglite-sync` implementation, add at least one regression test for any newly observed drift.

## Performance tests

Performance and abuse tests live outside the normal validation lane.

Use:

- `bun run test:performance`
- `bun run test:performance:client`
- `bun run test:performance:concurrent`
- `bun run test:performance:concurrent:matrix`
- `bun run test:performance:server`
- `bun run perf:lab`

These runs may take 10-30 minutes, seed large datasets, and write result artifacts under `tmp/perf-results/` or a custom `PGXSINKIT_PERF_RESULTS_DIR`.

The automated performance suites enforce coarse default p95 budgets for client mutation latency, client optimistic-read latency, and artifact batch latency. Override those defaults with:

- `PGXSINKIT_PERF_CLIENT_MUTATION_P95_MAX_MS`
- `PGXSINKIT_PERF_CLIENT_READ_P95_MAX_MS`
- `PGXSINKIT_PERF_SERVER_BATCH_P95_MAX_MS`
- `PGXSINKIT_PERF_CONCURRENT_ENQUEUE_P95_MAX_MS`
- `PGXSINKIT_PERF_CONCURRENT_FLUSH_P95_MAX_MS`
- `PGXSINKIT_PERF_CONCURRENT_CONVERGENCE_P95_MAX_MS`

They must not be added to `validate`, `test`, `test:unit`, or `test:integration` by default.

The main goals are:

- apply-function abuse testing
- large-schema and large-row-count scenarios
- optimistic local read performance with 100k+ local rows and large pending journals
- flush throughput under realistic journal sizes so query-shape and index changes can be measured independently from local enqueue costs
- end-to-end concurrent multi-client pressure with real auth identities, real sync, and real server contention

The performance lanes are intentionally distinct:

- `test:performance:client`: local-only optimistic staging and read costs inside one client
- `test:performance:concurrent`: end-to-end multi-client mutate, flush, sync-echo, and convergence behavior under contention
- `test:performance:server`: server-only concurrent `/api/mutations` pressure

The browser lab at `apps/perf-lab/` is the manual companion for those client-runtime scenarios. `bun run perf:lab` launches a dedicated fixed-name stack for the lab itself, tears any prior `pgxsinkit-perf-lab` processes and containers down first, and writes browser-lab logs under `tmp/perf-lab/`. Its default live mode reprovisions the active synthetic registry on the dedicated write server, seeds PostgreSQL, waits for those rows to sync into browser PGlite through Electric, stages local mutations, flushes them upstream, and waits for the Electric echo plus reconcile pass to settle before calling the full cycle complete.

The concurrent client lane now uses scenario-driven mixed mutation traffic keyed by `PGXSINKIT_PERF_SCENARIO_KEY`, with create and delete probabilities configurable alongside the existing burst-shape knobs. The first pass covers `mixed-small-bursts`, `mixed-small-plus-large`, and `hot-partition-overlap`. Same-row conflicts, disconnect/reconnect, restart-resume, and deliberate server-failure scenarios still belong in the same lane but remain follow-up work.

Use `bun run test:performance:concurrent:matrix` to run the preset/scenario grid sequentially. Filter it with comma-separated `PGXSINKIT_PERF_MATRIX_PRESETS` and `PGXSINKIT_PERF_MATRIX_SCENARIOS` values when you want to run only part of the matrix.

The performance runner is now single-owner by design: it uses a fixed Podman Compose project name, refuses to start if another `run-performance-suite.ts` process is still alive, tears down stale suite containers before relaunch, and prunes leftover `tmp/pgxsinkit-perf-concurrent-*` work directories on startup and shutdown. If a prior run was interrupted, rerun the same command in the foreground and let the harness recover that stale state before starting new work.

The concurrent mixed-load harness now keeps the shared hot row pool limited to rows that were already synced for all same-user clients at scenario start. Freshly created ids remain client-local until later sync distributes them, which prevents sibling clients from enqueueing updates or deletes against rows they have not hydrated yet. Delete targets are also reserved out of the shared pool as soon as a batch is assembled so sibling clients do not plan follow-up mutations against rows that are about to disappear from their local read models.

## Provisioning parity

Integration coverage should reflect the provisioning workflow described in:

- `docs/migrations.md`
- `docs/function-artifacts.md`

In staging/prod, keep at least one contract suite path running against the preinstalled function migration, not startup-generated SQL.
