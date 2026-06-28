# Performance Tests

This directory is for long-running performance and abuse tests only.

These tests are intentionally separate from normal validation:

- they are not part of `bun run validate`
- they are not part of `bun run test`
- they may run for 10-30 minutes
- they may seed very large datasets and produce perf artifacts

Commands:

- `bun run test:performance`
- `bun run test:performance:client`
- `bun run test:performance:concurrent`
- `bun run test:performance:concurrent:matrix`
- `bun run test:performance:server`
- `bun run perf:lab` to launch the browser lab on `http://localhost:5174`

Performance artifacts and perf-lab logs default under `tmp/`:

- automated report JSON: `tmp/perf-results/`
- browser perf-lab logs: `tmp/perf-lab/`

Key environment variables:

- `PGXSINKIT_PERF_RESULTS_DIR`
- `PGXSINKIT_PERF_LOCAL_ROWS`
- `PGXSINKIT_PERF_PENDING_MUTATIONS`
- `PGXSINKIT_PERF_MUTATION_BATCH_SIZE`
- `PGXSINKIT_PERF_TABLE_COUNT`
- `PGXSINKIT_PERF_EXTRA_COLUMNS`
- `PGXSINKIT_PERF_SERVER_WORKERS`
- `PGXSINKIT_PERF_BATCHES_PER_WORKER`
- `PGXSINKIT_PERF_MUTATIONS_PER_BATCH`
- `PGXSINKIT_PERF_SEED_ROWS_PER_TABLE`
- `PGXSINKIT_PERF_PRESET`
- `PGXSINKIT_PERF_SCENARIO_KEY`
- `PGXSINKIT_PERF_MATRIX_PRESETS`
- `PGXSINKIT_PERF_MATRIX_SCENARIOS`
- `PGXSINKIT_PERF_MATRIX_FAIL_FAST`
- `PGXSINKIT_PERF_CONCURRENT_EXEC_MODE`
- `PGXSINKIT_PERF_CONCURRENT_CLIENTS`
- `PGXSINKIT_PERF_DISTINCT_USERS`
- `PGXSINKIT_PERF_OPERATIONS_PER_CLIENT`
- `PGXSINKIT_PERF_CREATE_PROBABILITY`
- `PGXSINKIT_PERF_DELETE_PROBABILITY`
- `PGXSINKIT_PERF_SMALL_BURST_MIN`
- `PGXSINKIT_PERF_SMALL_BURST_MAX`
- `PGXSINKIT_PERF_MEDIUM_BURST_MIN`
- `PGXSINKIT_PERF_MEDIUM_BURST_MAX`
- `PGXSINKIT_PERF_MEDIUM_BURST_PROBABILITY`
- `PGXSINKIT_PERF_LARGE_BATCH_SIZE`
- `PGXSINKIT_PERF_LARGE_BATCH_PROBABILITY`
- `PGXSINKIT_PERF_HOT_PARTITION_RATIO`
- `PGXSINKIT_PERF_JITTER_MIN_MS`
- `PGXSINKIT_PERF_JITTER_MAX_MS`
- `PGXSINKIT_PERF_CLIENT_MUTATION_P95_MAX_MS`
- `PGXSINKIT_PERF_CLIENT_READ_P95_MAX_MS`
- `PGXSINKIT_PERF_SERVER_BATCH_P95_MAX_MS`
- `PGXSINKIT_PERF_CONCURRENT_ENQUEUE_P95_MAX_MS`
- `PGXSINKIT_PERF_CONCURRENT_FLUSH_P95_MAX_MS`
- `PGXSINKIT_PERF_CONCURRENT_CONVERGENCE_P95_MAX_MS`
- `PGXSINKIT_PERF_CONCURRENT_CONVERGENCE_TIMEOUT_MS`

The first goal is signal, not perfect benchmarking science. These tests should help detect crashes, pathological slowdowns, and obvious scale cliffs before production traffic does.

The automated suites now enforce coarse p95 budgets by default. Override those via environment variables when running on slower machines or when validating a deliberately larger scenario. Reports include both the measured percentile values and the evaluated budget results.

The concurrent client lane also uses a scenario-aware convergence timeout while waiting for Electric echoes to clear acknowledged mutations. Override that only when validating on unusually slow infrastructure:

- `PGXSINKIT_PERF_CONCURRENT_CONVERGENCE_TIMEOUT_MS`

The concurrent client lane is the end-to-end complement to the existing local-only and server-only suites. It provisions a synthetic registry in PostgreSQL, seeds user-owned rows directly, starts a real batch write server, creates multiple authenticated `createSyncClient(...)` instances, waits for initial sync through Electric, then runs repeated local mutate-plus-flush loops with a representative mix of create, update, and delete mutations while collecting enqueue, flush, and convergence percentiles.

Concurrent lane defaults are driven by two env knobs:

- `PGXSINKIT_PERF_PRESET=smoke|realistic|heavy`
- `PGXSINKIT_PERF_SCENARIO_KEY=mixed-small-bursts|mixed-small-plus-large|hot-partition-overlap`

The concurrent lane execution model is controlled independently:

- `PGXSINKIT_PERF_CONCURRENT_EXEC_MODE=single-process|multi-process`

If unset, it defaults to `single-process`. Prefixing the variable before the Bun command is enough; the runner passes the environment through to the test process and the concurrent lane selects the requested mode from there.

The first-pass scenarios are:

- `mixed-small-bursts`: mostly 1-3 local mutations followed by immediate flush, with create and delete traffic mixed in alongside updates
- `mixed-small-plus-large`: small bursts with occasional medium and large `client.mutate.batch(...)` bursts and the same mixed mutation model
- `hot-partition-overlap`: shared hot subset of already-synced rows to increase overlap without expanding into same-row conflict handling yet, while still including representative create and delete traffic; freshly created ids stay client-local until later sync makes them safe for sibling clients to target

The default mutation mix comes from the preset and scenario config. Override it with:

- `PGXSINKIT_PERF_CREATE_PROBABILITY`
- `PGXSINKIT_PERF_DELETE_PROBABILITY`

The update share is derived from the remaining probability mass after create and delete are applied.

Example runs:

- `PGXSINKIT_PERF_CONCURRENT_EXEC_MODE=multi-process bun run test:performance:concurrent`
- `PGXSINKIT_PERF_PRESET=smoke PGXSINKIT_PERF_SCENARIO_KEY=mixed-small-bursts bun run test:performance:concurrent`
- `PGXSINKIT_PERF_CONCURRENT_EXEC_MODE=multi-process PGXSINKIT_PERF_PRESET=smoke PGXSINKIT_PERF_SCENARIO_KEY=mixed-small-bursts bun run test:performance:concurrent`
- `PGXSINKIT_PERF_PRESET=realistic PGXSINKIT_PERF_SCENARIO_KEY=mixed-small-plus-large bun run test:performance:concurrent`
- `PGXSINKIT_PERF_PRESET=heavy PGXSINKIT_PERF_SCENARIO_KEY=hot-partition-overlap bun run test:performance:concurrent`

Concurrent test matrix:

- `bun run test:performance:concurrent:matrix` runs the full 3 x 3 preset/scenario grid sequentially
- `PGXSINKIT_PERF_MATRIX_PRESETS=smoke bun run test:performance:concurrent:matrix` runs all smoke cases
- `PGXSINKIT_PERF_MATRIX_SCENARIOS=mixed-small-bursts,hot-partition-overlap bun run test:performance:concurrent:matrix` runs selected scenarios across all presets
- `PGXSINKIT_PERF_MATRIX_PRESETS=smoke PGXSINKIT_PERF_MATRIX_SCENARIOS=mixed-small-bursts bun run test:performance:concurrent:matrix` runs a single matrix cell through the matrix runner
- `PGXSINKIT_PERF_MATRIX_FAIL_FAST=true bun run test:performance:concurrent:matrix` stops on the first failing matrix case instead of collecting all failures

The browser lab is intended for browser-based full-cycle testing of the client runtime under large synced datasets. It ships with one-click presets for local-100k, wide-schema, and mixed-pressure runs. In the default live mode it reprovisions a dedicated perf-lab write server for the active synthetic registry, seeds rows into PostgreSQL, waits for those rows to sync into browser PGlite through Electric, stages pending mutations through the real client runtime, flushes them upstream, and waits for the Electric echo to clear overlay state again.

Set `PGXSINKIT_PERF_MUTATION_BATCH_SIZE` before `bun run perf:lab` to change how many local mutations the browser lab stages per `client.mutate.batch(...)` call. The default is `1`, which keeps one-mutation-at-a-time behavior.

`bun run perf:lab` owns its own dedicated stack. It first tears down any prior `pgxsinkit-perf-lab` containers and fixed child processes, then starts a fresh PostgreSQL, ElectricSQL, perf-lab write server, and Vite browser server on fixed names and ports. The default live URLs are `http://127.0.0.1:3101` for writes and `http://127.0.0.1:3101/v1/electric-proxy` for Electric proxying. The browser app respects `VITE_WRITE_API_URL`, `VITE_BATCH_WRITE_URL`, and `VITE_ELECTRIC_URL` if you intentionally override them.

Offline loopback mode remains available for purely local pressure checks, but that is not the default path.

## RLS read load

`bun run test:performance:rls` measures the cost of **RLS-governed reads** at scale — the path a
direct (non-synced) read endpoint takes — for the two authorization shapes the toolkit ships:

- **membership fan-out** — visibility via `container IN (SELECT … FROM membership …)`, and
- **grant-scope** — visibility via a JWT-resident grant set (`app_metadata.authorization.grants`), no join.

Because Electric cannot read RLS, each shape is measured three ways so the numbers are comparable:

- **baseline** — privileged `SELECT`, no predicate (the floor),
- **shape-query** — privileged `SELECT` + the resolved row-filter `where` (what Electric runs on the synced path),
- **rls** — `SET ROLE authenticated` + claims, policy active (what a direct read runs).

The `rls` line is run for both the InitPlan-correct policy and a deliberately **naive** (correlated)
variant, **with and without** the supporting index. The report records `cliffRatioP95` (naive ÷
correct), `indexSpeedupP95` (no-index ÷ index), and `rlsVsShapeP95` (direct-read RLS ÷ Electric
shape query — close to 1 means a direct read costs about what the synced shape query costs), plus an
`EXPLAIN ANALYZE` capture for the correct and naive plans. The **only asserted** budget is the
correct, indexed `rls` p95 (`PGXSINKIT_PERF_RLS_P95_MAX_MS`); the naive / no-index lines are reported,
not gated (they are expected to be slow — that is the demonstration).

Knobs (all default per `PGXSINKIT_PERF_PRESET`):

- `PGXSINKIT_PERF_RLS_CONTAINERS` — workspaces / offerings seeded
- `PGXSINKIT_PERF_RLS_FOCAL` — how many of them the focal caller can see (member / granted)
- `PGXSINKIT_PERF_RLS_ROWS_PER_CONTAINER` — rows seeded per container
- `PGXSINKIT_PERF_RLS_MEMBERS_PER_CONTAINER` — membership volume per container
- `PGXSINKIT_PERF_RLS_SAMPLES` — read samples per measured cell
- `PGXSINKIT_PERF_RLS_P95_MAX_MS` — the asserted budget for the correct, indexed read
