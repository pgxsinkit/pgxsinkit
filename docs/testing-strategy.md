# Testing Strategy

## Unit tests

Unit tests must stay fast and deterministic. They cover:

- contract parsing and normalization
- sync URL and shape configuration
- write payload mapping
- local mutation journaling semantics, including atomic client-side batch enqueue and per-entity sequencing
- explicit edge cases such as blank titles or invalid UUIDs

### 0.2.0 contract boundaries

The first published contract is intentionally narrow, and focused tests pin its public boundaries:

- Writes use `batchWriteUrl`; the routed endpoints are `/api/mutations` and `/api/mutations/unit` only. An
  absolute deployment URL may prefix that canonical suffix (for example a Supabase Function URL), but aliases
  such as `/mutations` are rejected. Coverage: `tests/unit/pessimistic-flush.test.ts`,
  `tests/integration/client-contract.integration.test.ts`, `tests/integration/server-contract.integration.test.ts`,
  and `tests/integration/board-smoke.integration.test.ts`.
- Registry row filters are authored through the typed-column callback exposed by `defineSyncTable` and
  `defineReadProjection`; resolved `customWhere` output remains the server proxy contract. Coverage:
  `tests/unit/contracts.test.ts`, `tests/unit/registry-projection.test.ts`, and
  `tests/unit/row-filter-shape.test.ts`.
- Local preparation hooks are named by timing: `prepareLocalDbBeforeSchema` and
  `prepareLocalDbAfterSchema`. Coverage: `tests/unit/client-sync-reset.test.ts` and
  `tests/unit/worker-bridge.test.ts`.
- Journal rows always carry a non-null `registry_version`, and an exact local-schema fingerprint mismatch is a
  hard failure rather than in-place schema replay. Coverage: `tests/unit/local-store.test.ts` and
  `tests/unit/schema-fingerprint-fast-path.test.ts`.
- The apply function exposes only the current mutation signature, and the vendored Supabase router verifies
  asymmetric JWKS-backed JWTs only. Coverage: `tests/unit/plpgsql-apply.test.ts` and the board integration lane.

## Worker bridge protocol

The `attachSyncClient` / `defineSyncWorker` bridge (ADR-0032) evolved during the July 2026 implementation; the notes below record the resulting contract so coverage stays anchored to current behavior.

Under **ADR-0049** the SharedWorker is always the attach point but is no longer always the engine home: where the engine runs is a runtime capability decision, never a consumer knob. Under the default `storage.backend: "opfs"` an **unconditional** real `createSyncAccessHandle` probe (never method-presence) runs at boot and selects **SW-direct** (`shared-worker`: the engine boots in the SharedWorker itself, WebKit today) or **elected** (`elected-worker`: the SharedWorker is router-only and the engine boots in a tab-spawned dedicated worker holding the handles, Chromium/Firefox). The one opt-out is the registry declaration `storage.backend: "idbfs"`, which forces the in-SharedWorker IDB engine and skips the probe. Both capability paths must stay tested; the unit lanes below exercise them off-browser, and the engine CORE (`SyncWorkerHost.connect`, live queries, journal, convergence) runs unchanged in either home.

- The attach (worker-attached) client now **proxies one-shot Drizzle reads and `ensureSynced`**. `query` / `queryRow` / `queryRaw` / `queryRawRow` compile a read to SQL on the tab (its `drizzle` runs over a bridge executor) and route it to the worker; `ensureSynced([keys])` starts the named lazy groups on the shared engine.
- Two RPC ops were added to the bridge protocol (`packages/client/src/worker/protocol.ts`):
  - `ensureSynced` — carries `[keys]`; additive/idempotent lazy activation over the shared engine.
  - `guardedQuery` — the guarded one-shot Drizzle read. Its positional wire contract is the named `GuardedQueryWireArgs` tuple: `[sql, params, { rowMode }, use?]`, encoded once tab-side and decoded against the same type worker-side.
- **Only `rowMode` crosses in the query options.** Drizzle's pglite `parsers` map is functions (non-serializable), so it is stripped tab-side; the worker re-applies an identity-parser mirror (`DRIZZLE_PGLITE_IDENTITY_PARSERS` — drizzle's fixed `parsers` constant mirrored verbatim: temporal OIDs plus `numeric[]`) so the identity-parsed OIDs round-trip as raw strings exactly as the in-process drizzle session sees them.
- Deliberate behaviour notes:
  - A bare awaited `client.drizzle` read is **GUARDED on attach** — stricter than the in-process escape hatch, which lets a bare `client.drizzle` read run ungated.
  - `client.drizzle.transaction()` and `client.isSynced(...)` **throw** on a worker-attached client (no tab-local PGlite for a read transaction; `isSynced` is a synchronous activation-started peek the tab cannot answer). See ADR-0044, "The attach client proxies one-shot reads; isSynced stays a refusal".

Coverage: `tests/unit/worker-one-shot-reads.test.ts` (real in-process engine behind `defineSyncWorker`, driven by `attachSyncClient` over injected `MessageChannel` port pairs in Bun) plus the real-SharedWorker case in `tests/e2e/board-worker.e2e.test.ts`.

The board browser lane also switches between two identities inside one page realm and asserts that their
localStorage bindings resolve to distinct stores. This pins the general lifecycle contract: a new store may
attach immediately after the previous client detaches, without waiting for that store's worker lifetime or
provision expiry.

## Storage and durability

Under **ADR-0049 (capability-driven engine placement)** the store backend is a runtime capability decision, not a fixed idb topology. The store-minting funnel (`store-path.ts`, the ONE URL assembler) derives the dataDir URL from the executing scope: the placement probe granted sync-access handles → `opfs://` (opfs-repacked, the primary browser store on every platform); handles denied → `idb://` (browser/worker fallback); Bun/Node → `file://`; the sanctioned test lane → `memory://`. Durability is declared once on the registry (`storage.durability`, ADR-0047), orthogonal to the backend the store boots on, and a capability fallback from opfs to idb keeps the declared durability.

- **Backend derivation.** `tests/unit/store-path.test.ts` covers the `opfs://` / `idb://` / `file://` / `memory://` derivation, the scheme precedence (memory override → opfs grant → idb → file), the `storeIdentityComponent` domain guards (lone surrogates, the encoded-length cap, `.`/`..` rejection), and the disjoint `pgxsinkit/stores|commitments|probe` namespaces (incl. `foo` vs `foo.committed`). `tests/unit/store-boot.test.ts` covers the `resolveStoreBoot` wiring that assembles the boot observations and executes the classifier's verdict, returning the resolved `dataDir` + `storageBackend`.
- **Diagnostics (ADR-0049 decision 12).** The `BootReport` carries additive `storageBackend` (`opfs-repacked` | `idbfs` | `filesystem` | `memory`), `engineHome` (`in-process` | `shared-worker` | `elected-worker`), and `storageFallbackReason` (set only when an opfs-capable boot opened idb — a deferred adoption or the recordless idb downgrade). `reportVersion` stays `1` — additive fields keep it. Coverage: `tests/unit/boot-report.test.ts` drives a real in-process boot (asserting `engineHome: "in-process"`, `storageBackend: "memory"` on the test lane) plus a builder-level suite for the additive omit-when-unstamped contract and the `shared-worker`/`elected-worker` + `opfs-repacked`/`idbfs` stamps.
- **Durability axis (ADR-0047).** Declared ONCE on the registry (`storage.durability`), a property of the data contract — not a per-open toggle, so no open site can disagree with another about a store's durability. It defaults to `"relaxed"` (the query returns before the datadir flush, scheduled asynchronously) with `"strict"` declarable (PGlite's synchronous end-of-query flush — ~100–200 ms/write on idb, cheap enough on opfs-repacked to actually opt into), and `createSyncClient` resolves it at exactly one point, passing the result into every store mint. `tests/unit/client-boot-optimizations.test.ts` asserts the registry declaration resolves to PGlite's `relaxedDurability` boolean across `createClientPGlite`, `createSyncClient`, and the `defineSyncWorker` provision factory. End to end, `tests/e2e/board-worker.e2e.test.ts` asserts the real posture on headless Chromium: the SharedWorker engine boots, a second tab attaches the same engine, and strict durability still round-trips writes.
- **Storage bench lanes (not CI).** The perf lab ships an in-browser storage benchmark suite (`apps/perf-lab`, `src/bench/`) — a matrix of timed SQL batteries across `idb`, `opfs-ahp`, and the constant-four-handle `opfs-repacked` backend, at 8 KiB or 64 KiB and relaxed or strict. Run it manually per engine (headless via `bun run bench:storage`, or the live page on a real device, especially iPhone/Safari for the WebKit numbers desktop cannot gather). Beyond the raw SQL columns it runs the phase-0 `sharedWorkerProof` (does the full repacked engine boot, persist, and reopen inside SharedWorker scope?) — this is the **capability-drift monitor**: it is what proved SW-direct hosting on WebKit and would catch a platform withdrawing or granting the capability. A manual evidence lane, NOT part of `validate`/CI.

## Engine placement (ADR-0049)

Two engine-placement paths exist and both must stay tested (ADR-0049 consequence). The bulk of the control plane, the phase machines, and the lifecycle state machines are proved **off-browser** as pure/effect-injected modules, driven over `MessageChannel` and injected timers — Bun has no real SharedWorker, `navigator.locks`, OPFS, or WASM, so every IO surface is faked and no real engine is constructed in these lanes.

- **Control plane (MessageChannel-driven, injected timers).** `tests/unit/engine-control.test.ts` — the identity-tagged protocol types (staleness, retirement, overdue-dispatch reports, the opt-in execution limit with default-off + mismatch rejection) and the `EngineRelocatedError` `code`+`outcome` round-trip. `tests/unit/engine-router.test.ts` — the SharedWorker-side router (communication centre): attach registry, per-tab proxy-pipe minting/transfer, relocation-notice fan-out, probe forwarding, identity staleness, pipe isolation. `tests/unit/attach-placement.test.ts` — the attach client's handoff window: bounded queue open/flush/overflow, pending-op classification incl. old-pipe settlement, worker-factory seam, bridge-silence deadline. `tests/unit/election-coordinator.test.ts` — the tab-side claim lifecycle (provision expiry, last-claim retirement ordering, keepalive reconstruction, BFCache release/reclaim) over mocked locks. `tests/unit/engine-entry-control.test.ts` — the elected-engine-worker control plane on the dedicated-worker entry (dynamic `connect-port`, probe replies, retirement/teardown), driven through an injected fake scope. `tests/unit/sw-placement-bootstrap.test.ts` — the SharedWorker placement bootstrap gating each `onconnect` port on the resolved home (SW-direct host connect vs router-only attach). `tests/unit/placement-probe.test.ts` — the probe module over an injected FS surface.
- **Phase-machine / meta / lifecycle / adoption pure suites (crash-table composition proofs).** `tests/unit/store-meta.test.ts` — the total phase machine + boot classification 1–7, precedence (`deleting` highest), failed-read fail-closed, the recordless non-creating idb existence check. `tests/unit/store-lifecycle.test.ts` — the fresh/restore commitment barrier, adoption recovery + completion ordering, and the destruction machine, each over its crash table. `tests/unit/adoption.test.ts` + `tests/unit/adoption-wiring.test.ts` — the effect-injected adoption orchestrator and the declaration-gated boot decision (`runBootAdoption`) + manual `adoptStore`. `tests/unit/fresh-commitment.test.ts` — the fresh/restore commitment boot wiring (`resolveFreshBoot` record-before-directory, `runFreshCommitmentBarrier` strict data-before-authority). `tests/unit/destroy-supervision.test.ts` — the supervised destructive lifecycle (peer refusal, resumable boundaries). The three crash tables (fresh/restore, adoption, destruction) are exercised row-by-row by composing the pure classifiers/machines with faked observations, rather than a Cartesian per-field fault matrix (accepted-risk register item 7).
- **Sharded runner (cross-file WASM isolation).** `scripts/run-unit-tests.ts` splits the unit files into independent `bun test` shards run in a worker pool: the heavy real-engine/PGlite files (e.g. `boot-report.test.ts`) get their own isolated single-file shard so a `mock.module` (process-global) and a live WASM heap in one file never bleed into another, and the process stays flat regardless of file count. Run the placement suites through it — `bun scripts/run-unit-tests.ts tests/unit/boot-report.test.ts tests/unit/engine-router.test.ts …` — not a bare `bun test` over the set.

## Playwright multi-tab lanes (landed)

`tests/e2e/placement/` is the real-worker, real-`navigator.locks`, real-OPFS family. The serverless
suite runs with `bun run test:browser:placement` across Chromium, Firefox, and WebKit. It covers
placement decisions, election/succession, handoff queueing and relocation classification,
keepalive reconstruction, execution-limit termination, provision-then-attach, supervised
destroy/recreate (including IDB database deletion), fresh commitment, and recordless-idb recognition.

The server-backed lanes run the real write API + Electric stack. `bun run test:integration:placement`
selects Chromium and is appended to `test:integration`, matching CI's installed browser.
`bun run test:browser:placement:server` runs the same server family without a project filter and is
the separate all-browser gate. It adds offline-first journal survival, delayed-write relocation
outcomes, and declared IDB→OPFS adoption with committed reload.

Playwright automation prevents a genuine BFCache entry on the configured engines, so the
persisted-pagehide release/reclaim sequence remains deterministic unit coverage plus a real-device
check. WebKitGTK also lacks the worker-scope OPFS grants needed for several SW-direct assertions;
those lanes annotate/skip the platform limitation rather than claim synthetic coverage.

The manual Chromium provision comparison is
`bunx playwright test --config tests/e2e/placement/playwright.bench.config.ts`; it is intentionally
outside every aggregate and reports foreground attach-to-first-query timing for plain versus
provision-ahead-of-attach samples.

## Integration tests

Integration tests are container-backed and require `infra/compose/docker-compose.yml`.

Each integration test command launches its own isolated Podman Compose project on ephemeral host ports, runs tests against those URLs, and tears containers down (including volumes) afterwards. This keeps integration runs independent from demo/example containers and from each other.

This is the canonical integration workflow for the repo.

Schema ownership for integration tests is strict:

- PostgreSQL tables used by the demo app and integration suites belong in `packages/schema` and must be migrated through Drizzle.
- Integration tests must not create server-side tables inline when the shape can be expressed through Drizzle schema modules and normal migrations.
- Cleanup should prefer Drizzle table deletes or other schema-owned helpers over handwritten setup SQL.

Since the repo-wide raw-SQL→Drizzle campaign, fixtures, seeds, and assertion reads are **Drizzle-authored**, not hand-written SQL:

- `tests/support/drizzle.ts` provides `drizzleOver(pg)` (a memoized tier-① Drizzle handle over any test PGlite instance) and `createTablesFromSchema(db, schema)` (creates fixture tables by generating empty→schema migration statements offline), so setup and assertion reads run through Drizzle builders.
- `tests/support/catalog-tables.ts` supplies read-only Drizzle stubs for the system catalogs the suites introspect (`information_schema.*`, `pg_catalog.*`), so schema/DDL assertions select through Drizzle instead of raw catalog SQL.
- The client's local-table factories (`getSyncedLocalTable` / `getOverlayTable` / `getJournalTable` / `getSyncStateView` / `getReadModelView` / `getLocalMetaTable` from `@pgxsinkit/client`) give typed Drizzle objects for the generated local relations, so overlay/journal/sync-state assertions no longer hand-write SQL against `<t>_overlay` / `<t>_mutations`.

The accepted raw remainder is the justified tier-③ set — SQL that genuinely cannot be a Drizzle object:

- `GRANT`/`REVOKE` to Supabase roles such as `authenticated` (Drizzle policies do not grant table privileges by themselves).
- PL/pgSQL function DDL and execution paths intentionally generated as SQL artifacts.
- Session/constraint commands (`SET`, `ALTER CONSTRAINT ... DEFERRABLE`) and `COPY` bulk-load paths.
- Electric shape-grammar `where` probes and planner-experiment text exercised as literal strings.

Run them by slice when possible:

- `bun run test:integration:contract` for public facade contract coverage
- `bun run test:integration:implementation` for lower-level implementation coverage
- `bun run test:integration:placement` for the Chromium server-backed placement family
- `bun run test:integration` for the full integration suite

Use `bun run infra:harness:up` only for manual local reference development (the `apps/write-api` minimal server). It applies the committed infra/drizzle migration history after infra becomes reachable. Integration scripts must not depend on or reuse that shared stack. (The substantial board demo uses its own stack via `bun run infra:up`.)

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

When changing PostgreSQL, ElectricSQL, PGlite, or the internalized read-path engine (`packages/client/src/sync`), add at least one regression test for any newly observed drift.

Recorded apply-semantics drift (read-path engine):

- **Generated-identity PKs.** drizzle-orm's insert builder drops a `GENERATED ALWAYS AS IDENTITY` column from `.values()`, so the insert-family apply paths (CDC per-row, bulk-insert tier, move-in upsert) now emit `INSERT … OVERRIDING SYSTEM VALUE` when the applied columns include such a column, preserving the server's authoritative id. Regression: `tests/unit/bulk-apply.test.ts` ("generated-identity PK") asserts the applied ids MATCH the delivered server values, not a local sequence.
- **Enum columns.** The apply-ladder classifier now treats Drizzle `pgEnum` columns as COPY-safe / JSON-safe (via `SyncColumnType.isEnum`) instead of falling to the per-row `insert` floor; the `json_to_recordset` cast identifier-quotes and schema-qualifies the enum type name. Regressions: `tests/unit/apply-strategy.test.ts` (enum classification) and `tests/unit/bulk-apply.test.ts` ("enum columns") round-trip labels through the COPY and JSON tiers.

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

The automated performance suites enforce coarse default p95 budgets for client mutation latency, client optimistic-read latency, and server write-batch latency. Override those defaults with:

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
