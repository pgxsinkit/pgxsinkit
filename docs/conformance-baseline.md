# pglite-sync conformance baseline (vendored upstream tests)

The read-path sync engine — internalized at `packages/client/src/sync/` (ADR-0009 Phase 1),
originally vendored from ElectricSQL's `@electric-sql/pglite` (package `pglite-sync`) — is being
rewritten by [ADR-0009](adr/0009-internalize-read-path-sync.md): consistency groups, a type-driven
apply ladder, and a serialized commit queue. Through that rewrite we keep **upstream's own test
suites** as a behavioural **regression oracle**, not just our one thin apply test.

## What is vendored

| Ported file                                             | From (upstream)             | Lane                                   |
| ------------------------------------------------------- | --------------------------- | -------------------------------------- |
| `tests/unit/pglite-sync-upstream.test.ts`               | `test/sync.test.ts`         | `bun run test:unit` (own invocation)   |
| `tests/integration/pglite-sync-e2e.integration.test.ts` | `test-e2e/sync-e2e.test.ts` | `bun run test:integration:conformance` |

- **Pinned upstream commit:** `2eba679f64c4a9ddef57d25c052ec4f0287cc497` (2026-06-16).
- **License:** Apache-2.0 (upstream © ElectricSQL). Attribution in [`NOTICE`](../NOTICE) and each
  file's header.

## Porting policy (faithful, refreshable)

These are _upstream's_ tests; we hold them to upstream's standards, not ours. Each ported file
is `@ts-nocheck` + `oxlint-disable` with a header explaining why: the value is the **runtime
behaviour**, and keeping the bodies byte-faithful keeps a refresh cheap. Only three things change
on a port:

1. **Framework:** Vitest → `bun:test` (`vi.fn`→`mock`, `vi.mock`→`mock.module`, `vi.waitUntil`/
   `vi.waitFor` → local helpers). The unit file runs in its **own `bun test` invocation** because
   `mock.module('@electric-sql/experimental')` is process-global and would otherwise bleed the
   `MultiShapeStream` mock into suites that use the real stream.
2. **DB driver (e2e only):** node-`pg` → `Bun.SQL` behind a thin `makePgClient` shim exposing
   `.query()/.connect()/.end()`, per the repo standard. Reads still go through PGlite's `pg.sql`.
3. **bun matcher quirk:** `expect(fn).rejects` → `expect(promise).rejects` (bun unwraps a promise,
   not a function).

**Refresh procedure:** re-pull the upstream file at a newer commit, re-apply `vi.*` token
transforms, swap the top import block for the shim, and update the pinned SHA here + in `NOTICE`.

## What the suites guard (→ ADR-0009 decisions)

- **Multi-shape simultaneous sync + cross-table transactions + multi-table must-refetch** →
  decision 2 (registry-declared **consistency groups** / atomic cross-table commit).
- **COPY FROM (+ special chars) and camelCase `json_to_recordset`** → decision 3 (the static,
  type-driven apply ladder — **built, Phase 3**). The classifier (`classifyApplyStrategy` /
  `classifyTableApplyStrategy` in contracts) picks `copy | json | insert` from registry column types;
  the `json` path now takes its casts from registry-supplied `columnTypes` (no `information_schema`
  round-trip) and keeps the introspection only as a fallback for the registry-less generic API the
  oracle exercises. New proofs: `tests/unit/apply-strategy.test.ts` (classifier tiers, fast) and
  `tests/unit/apply-ladder.test.ts` (each tier on the pinned PGlite, incl. jsonb + bigint[] via the
  `columnTypes` json path). The two oracle COPY tests and the camelCase json test stay green on the
  fallback path, unchanged. The COPY path itself now serializes via a faithful port of Postgres' own
  COPY **TEXT** format (`CopyAttributeOutText` + `array_out`, in `sync/copy.ts`, ported from upstream
  `electric-sql/pglite` PR #1035), replacing the hand-rolled CSV encoder that mangled arrays,
  json/jsonb, bytea and embedded delimiters — proven by `tests/unit/copy.test.ts` (serializer units +
  real-PGlite `COPY FROM` round-trips for scalars/arrays/multi-dim/json/jsonb/`jsonb[]`/timestamps/
  bytea). json/jsonb disambiguation comes from the registry `columnTypes` (information_schema only as
  the generic-caller fallback), like the json path.
- **`pgxsinkit.syncing` flag set during sync** → decision 6 (the sync-origin GUC, renamed from the
  upstream `electric.syncing` to our own metadata namespace; the oracle now asserts the new name).
- **Subscription persist/resume, clears+restarts on refetch, must-refetch** → decision 4/5
  (serialized commit queue + failure surfacing; Electric `must-refetch` stays its own path).
- **Insert/update/delete, in-transaction apply, empty-update, case sensitivity** → the apply
  invariants the rewrite must preserve.

## The contract through ADR-0009

1. The vendored suites **stay green through 0009's internal rewrite** (commit queue, apply ladder,
   GUC rename) while the public surface is unchanged.
2. When 0009 changes the public surface (folding into the client, `consistencyGroup`), each test is
   **migrated to the new API one at a time** — never silently deleted. A removed behaviour must be a
   conscious, reviewed decision, not a vanished test.

## Bug already surfaced

Porting the unit suite immediately caught a real divergence: the vendored
`applyMessagesToTableWithJson` had **dropped the identifier quotes** upstream uses
(`"${column_name}"`), so camelCase columns folded to lowercase and `json_to_recordset` returned
`null`. Fixed in the apply module (now `packages/client/src/sync/apply.ts`) — an ADR-0004-class
unquoted-identifier bug the vendored engine had carried; Phase 1 then routed all of apply's
identifier quoting through the shared `quoteIdentifier` resolver.

## Upstream divergences removed (apply is operation-faithful)

Diffing our vendored apply path against upstream (`@electric-sql/pglite-sync@0.5.4`, the npm publish
of the pinned commit) surfaced **two band-aids that were injected into the vendored copy and are not
in upstream** — both papering over the same thing (an `insert` landing on an existing row) instead of
treating it as the protocol violation it is. Now that we own the engine, apply does exactly what
Electric sends:

1. **The COPY primary-key guard.** `applyMessagesToTableWithCopy` early-returned to
   `applyInsertsToTable` whenever a `primaryKey` was present — and every shape has one — so the COPY
   path was unreachable dead code. Upstream's COPY function does not even take `primaryKey`. Removed;
   COPY now runs (an Electric `insert` is a new row, so it cannot legitimately collide).
2. **The data-path `ON CONFLICT`.** The three data INSERTs carried
   `ON CONFLICT (pk) DO UPDATE/NOTHING` (a local `buildUpsertClause`), silently upserting a replayed
   insert. Upstream's three data INSERTs are plain; its only `ON CONFLICT` is the
   `subscriptions_metadata` bookkeeping upsert (kept). An `insert` means a new row (post-truncate or
   first send); a genuine primary-key collision is a truncate/protocol violation that must surface
   (→ the commit queue's `degraded` + `onSyncError`), never be swallowed. Removed `buildUpsertClause`
   and all three usages.

The two **`*pglite-sync-apply.test.ts`** cases that asserted upsert-on-replay were migrated (per the
contract above) to assert a replayed key now **fails** instead of overwriting; `apply-ladder.test.ts`
likewise. The upstream oracle stays green (it never assumed upsert). The whole change was proven
end-to-end on the Podman integration lane — contract, implementation (write round-trip, membership
fan-out, electric↔pglite), and the e2e conformance suite (35 tests) — confirming the engine's
truncate-before-restream / offset-resume invariants keep inserts genuinely conflict-free in real
operation, so the upsert was never load-bearing.

## Clean break from the vendored API (no consumer back-compat)

Having internalised the engine, we stopped tracking the vendored public surface and adjudicated the
remaining ours-vs-upstream differences individually:

1. **`useCopy` removed entirely; `'csv'` initial-insert method renamed to `'copy'`.** The deprecated
   `useCopy?: boolean` option and its runtime `console.warn` shim are gone from both option
   interfaces and the engine; `InitialInsertMethod` is now `'insert' | 'copy' | 'json'`. The single
   selection axis is `initialInsertMethod` (explicit caller value wins) falling back to the
   registry-resolved `applyStrategy`. No deprecation window — there are no external consumers to keep
   compatible.
2. **`copy` is now the default initial-backfill method.** With the COPY **TEXT** serializer
   round-tripping every built-in type (proven by `copy.test.ts` + the re-enabled real-Electric
   `data_types_table` COPY case), COPY is the safe no-brainer bootstrap. `applyStrategyToInsertMethod`
   and `syncShapesToTables` both default to `copy`; `insert`/`json` are selected only when explicitly
   requested or resolved from column types.
3. **Re-aligned _with_ upstream where ours had drifted, by choice:**
   - **Extension name** restored to `"Postgres Sync"` (ours lagged on the old `"ElectricSQL Sync"`).
   - **Rollback on unsubscribe-mid-commit** restored. If the engine unsubscribes while a commit
     transaction is in flight, it now `tx.rollback()`s rather than persisting work during teardown
     (PGlite's `transaction()` skips its COMMIT once the tx is closed). The retry loop then declines
     to advance the committed frontier. We err toward _less_ persisted local data: the un-advanced
     offset means a later resume simply re-streams that batch.

## Consistency groups + the pgxsinkit metadata namespace (ADR-0009 decisions 2 + 6)

The two remaining ADR-0009 decisions landed together:

- **Consistency groups (decision 2).** A `consistencyGroup` on a synced table binds it with its
  peers onto one `MultiShapeStream` committed atomically at a shared LSN frontier, so a local reader
  never sees one grouped table advanced past another for the same server transaction. Ungrouped
  tables default to a singleton group (today's independent frontier). The apply engine now resolves
  each shape's strategy and its `useInsert` transition **per shape**, so one member finishing its
  bulk backfill no longer forces the rest onto plain `INSERT` — the latent bug in the multi-shape
  path that, per the ADR, had never actually run. Group membership is part of the registry
  fingerprint and a `risky` registry-diff change (a move re-keys the subscription); subscription
  reset is group-granular. Proven end-to-end: a grouped pair syncs on one stream persisting a single
  `subscriptions_metadata` row covering both shapes.
- **Metadata namespace (decision 6).** The local bookkeeping schema and the sync-origin GUC are
  renamed from the upstream `electric` default to `pgxsinkit` — `pgxsinkit.subscriptions_metadata`
  and `SET LOCAL pgxsinkit.syncing = true`. This is our local state, not Electric's. No durable
  local DBs exist pre-launch, so the rebuild path handles the one-time schema change.
