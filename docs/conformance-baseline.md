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
  fallback path, unchanged.
- **`electric.syncing` flag set during sync** → decision 6 (keep the sync-origin GUC, renamed).
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
