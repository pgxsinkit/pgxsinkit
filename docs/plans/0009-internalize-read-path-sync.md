# Plan — ADR-0009: Internalize the read-path sync

Implements [ADR-0009](../adr/0009-internalize-read-path-sync.md). Goal: own the
read-path ingest end-to-end — delete `@pgxsinkit/pglite-sync`, add consistency
groups, a static type-driven apply ladder, a serialized commit queue with real
error surfacing, and a pgxsinkit-owned metadata namespace.

Depends on / coordinates with: [ADR-0004](../adr/0004-one-registry-interpreter.md)
(shared `sql-identifier` resolver, fingerprint), [ADR-0005](../adr/0005-mutation-convergence.md)
(`computeRetryDelayMs`, `degraded` phase), [ADR-0006](../adr/0006-local-schema-evolution.md)
(group-granular `dropReadCache`/rebuild, registry-diff/lock), and supersedes
[ADR-0007](../adr/0007-absorb-sync-engine.md) decision 2.

Each phase ends `validate`-green; streaming/atomicity/failure proofs run in the
Podman integration lane.

## Phase 1 — Internalize as-is (behaviour-preserving)

- Move `packages/pglite-sync/src/{index,apply,subscriptionState,types}.ts` into
  `packages/client/src/sync/` as internal modules; `shape-sync.ts` imports them
  directly.
- Delete the `@pgxsinkit/pglite-sync` package: drop from
  `scripts/build-public-packages.ts`, the tsconfig path map(s) incl.
  `tsconfig.dts.json`, the `apps/web` dependency + Vite alias, and the `client`
  dependency. Re-export nothing new from the public surface.
- Repoint the unit test (`tests/unit/*pglite-sync*` / apply tests) and any
  integration-harness / client-reset mocks to the internal module.
- Docs: drop `pglite-sync` from the packages page + generated reference (coordinate
  with ADR-0008's consistency rule); 5 → 4 public packages in `RELEASING`/README.
- Route `apply.ts` identifier quoting through the ADR-0004 `sql-identifier` resolver
  (delete the local `'"'+s+'"'` quoting). No behaviour change intended.

## Phase 2 — Serialized commit queue + error path

- Replace `void commitUpToLsn(...)` + `setTimeout(0)` with a single-flight commit
  chain: the subscribe callback buffers + advances the frontier synchronously,
  enqueues, and returns; at most one `pg.transaction` runs at a time; commits
  coalesce; the buffer has a high-water mark.
- Make the committed frontier a running variable (advance after each successful
  commit); remove the redundant empty re-commits the boot-time `const` causes.
- Failure policy: jittered retry/backoff (`computeRetryDelayMs`) → on exhaustion set
  `phase = "degraded"` and fire `onSyncError`; never flip `isUpToDate` on an
  unapplied commit. Wire `onSyncError` through `shape-sync.ts` /
  `createSyncClient` (it is currently unwired). Keep Electric `must-refetch` as its
  own truncate+re-stream path.
- Integration: prove a forced commit failure surfaces as `degraded` + `onSyncError`
  and that recovery resumes; prove no overlapping-transaction errors under a fast
  backfill.

## Phase 3 — Static type-driven apply ladder

- A classifier maps each table to `copy | json | insert` from registry column types:
  all COPY-safe scalars → `copy`; any array/json/jsonb (rest COPY-safe) → `json`;
  else `insert`. Conservative COPY-safe whitelist; `insert` is the floor.
- Keep all three apply functions; select per table from the classifier (no runtime
  probing, no `information_schema` round-trip). Drive `mapColumns` from the registry
  projection rather than ad-hoc.
- Integration: a fixture table per tier (scalar-only, jsonb/array, exotic) proving
  each path applies correctly — especially bigint + bigint[] through `json` on the
  pinned PGlite.

## Phase 4 — Consistency groups

- Add `consistencyGroup?: string` to the synced-table registry options; default each
  ungrouped table to its own singleton group.
- Group tables → one `MultiShapeStream` per group; commit a group atomically at its
  shared LSN frontier. Subscription key + `shape_metadata`, and `dropReadCache` /
  rebuild + the boot reconcile's subscription reset, all become group-granular.
- Reflect group membership in the ADR-0006 registry-diff/lock (a group change is a
  reviewable lock diff; classify cross-group moves).
- Integration: a grouped pair (e.g. discussion+post) never exposes a child before
  its parent within a group; an ungrouped table still streams independently.

## Phase 5 — Metadata namespace + docs

- Rename the metadata schema (and therefore the `*.syncing` GUC) from `electric` to a
  pgxsinkit-owned name; update `dropReadCache`/wipe SQL accordingly. (Pre-launch: no
  durable local DBs to migrate — rebuild handles it.)
- Docs: `CONTEXT.md` Read-path terms (done in this ADR), `architecture.md` read-path
  section, `getting-started` if it references the engine.

## Acceptance

- `@pgxsinkit/pglite-sync` is gone; the read-path engine lives in `client`; 4 public
  packages; `validate` + fixture smoke green.
- Sync-commit failures surface (`degraded` + `onSyncError`); no silent divergence;
  no overlapping transactions.
- Each apply tier is exercised and correct on the pinned PGlite.
- A declared consistency group applies its tables atomically; ungrouped tables keep
  independent frontiers.
- The metadata schema/GUC is pgxsinkit-owned.
