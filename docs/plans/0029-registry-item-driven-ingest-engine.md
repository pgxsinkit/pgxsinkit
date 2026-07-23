# Plan — ADR-0029: The registry item is the ingest engine's spec

Implements [ADR-0029](../adr/0029-registry-item-driven-ingest-engine.md). Goal: collapse the
read-path ingest engine onto the registry item as its sole per-table spec — the option surface,
type knowledge, metadata DDL, and must-refetch wipe all derive from (or render through) machinery
the repo already owns — and retire the parallel table/type constructs ADR-0028's slice F introduced.

Supersedes / amends: [ADR-0028](../adr/0028-own-the-sync-engine-outright.md) slice F (the
passthrough-table + introspection contract) and slice G (the perf gate), plus that ADR's standing
tier-③ perf allow-list entry. Depends on / coordinates with:
[ADR-0004](../adr/0004-one-registry-interpreter.md) (fingerprint, shared resolver, tier discipline),
[ADR-0009](../adr/0009-internalize-read-path-sync.md) (the internalized engine),
[ADR-0006](../adr/0006-local-schema-evolution.md) (fingerprint-driven rebuild),
[ADR-0021](../adr/0021-lazy-ephemeral-sync-lifecycle.md) (ephemeral/pg_temp),
[ADR-0014](../adr/0014-bulk-apply-ordering-safety.md) (fold + reconcile completeness).

**Review protocol.** Each slice runs as an implementer/reviewer pair: an implementer executes the
slice, a fresh-context reviewer verifies it against this plan and the ADR, and the owner sees the
reviewer's verdict _before_ the slice is committed. Every slice ends `validate`-green; the
integration/perf proofs run in the Podman lane.

**Slice P0 — ADR + plan.** **Outcome (done):** ADR-0029 and this plan authored.

## Slice P1 — Engine restructure (D1 + D2 + D4 + D6)

**Outcome (done):** option surface collapsed onto `{ registry, shapes: { tableKey } }`;
`apply-tables.ts`, `catalog-tables.ts` and the three `information_schema` probes deleted; casts
derive from `deriveSyncColumnTypes`; must-refetch truncates; `syncShapeToTable` kept as thin sugar;
the batched-insert family ships render-once; suites rebuilt on real fixture registries; the
truncate-reconcile unit test lands green.

One commit.

- Rewrite the option surface: `SyncShapesToTablesOptions` gains `registry`; each shape carries
  `tableKey`. Delete the per-shape `table`, `schema`, `primaryKey`, `columnTypes`, `applyStrategy`,
  and `mapColumns` options from `ShapeToTableOptions`, `SyncShapeToTableOptions`, and their
  consumers (`sync/index.ts`, `apply.ts`, `subscription-state.ts`, `tags.ts`).
- Derive every table-scoped fact from the entry: identity via `getSyncedLocalTable(registry,
tableKey)` (bare rendering for ephemeral lifecycles — fixes the `makeTable` qualification bug),
  PKs from the entry table's columns, strategy from `classifyTableApplyStrategy(entry)`.
- Delete `apply-tables.ts` and `catalog-tables.ts` and the three `information_schema` probes
  (`resolveJsonRecordsetColumns`, `resolveCopyColumnUdts`, `recordsetColumnCasts`); author the
  appliers over `getSyncedLocalTable` objects and derive casts from `deriveSyncColumnTypes(entry)`.
  This closes the wrong-schema empty-casts bug on pg_temp json/copy shapes.
- `mapColumns` dies outright (no external producers, no test users).
- Must-refetch wipe (D4): replace the row-wise DELETE at `sync/index.ts` with a `TRUNCATE` over the
  `getSyncedLocalTable` object (tier ②), keeping the tag-store clear and the `onMustRefetch` hook.
- `syncShapeToTable` (D6) stays as thin sugar over the group form, taking the entry-based options.
- Batched-insert render-once (D5): the plain-`INSERT` backfill family ships in its render-once /
  memoized form from the start, on the measured grounds — the per-test A/B found a real regression
  scaling with row count (+9.0% @20k, +11.9% @150k, +18.3% @300k; median 12.89s→15.26s) from the
  per-row × per-column builder AST walk + per-value `customType.toDriver`. Author it tier-①, render
  its `{sql, params}` once per shape. This is the ONLY pre-emptive render-once; every other builder
  stays plain until a measurement demands it.
- Rebuild the engine suites (`sync-engine.test.ts`, `sync-apply.test.ts`, and the integration
  suites) on small **real** registries built through the production registry-definition API — the
  last "generic caller" fixtures die with the option surface.
- Add the truncate-reconcile unit test (D4): prove `reconcileTable`'s `clearable_entities` pass
  completes acked-delete reconciliation after a truncate-wipe.

## Slice P2 — Metadata DDL through the in-house renderer (D3)

**Outcome (done):** the `schema.ts` render core extracted for reuse (with `CREATE INDEX`
support); the `metadata-tables.ts` pgTables render through it, replacing the hand-written
`CREATE TABLE` text in `subscription-state.ts` and `tags.ts`; the drift guard demoted to a
provisioning round-trip.

- Extract the `schema.ts` render core for reuse; add `CREATE INDEX` support for the tag-store index.
- Render the `metadata-tables.ts` pgTables through it, replacing the hand-written `CREATE TABLE`
  text in `migrateSubscriptionMetadataTables` (subscription-state.ts) and `shapeRowTagsDdl`
  (tags.ts).
- Demote the DDL-vs-pgTable drift guard to a plain provisioning round-trip.

## Slice P3 — Perf A/B protocol + final sweep (D5)

**Outcome (done):** perf A/B run (pre-render-once vs render-once; min-based, COPY-control
adjusted); the fixture converted to the real-registry form and the tier-③/docs sweep completed.
**Verdict:** the old builder's scaling signature (+9.0 → +11.9 → +18.3%) is eliminated — the
render-once head is flat in row count, leaving only a fixed ≈ +0.35s once-per-shape render cost; no
tier-③ reversion anywhere. Full record in ADR-0029 → Consequences → Measured outcome.

- Perf protocol (detection-only): interleaved pre-render-once/render-once states, ×2, on a quiet machine.
  Record the HEAVY PER-TEST timings **here** in this plan. This slice does not gate any
  revert — a real measured regression triggers the render-once ladder (D5), not a tier-③ reversion.
- Re-validate the P1 batched-insert render-once form against the new registry-table builder, using
  the parked `tmp/agents` A/B logs (the +9.0/+11.9/+18.3% baseline data) as the comparison baseline:
  confirm the memoized builder closes the measured regression to within the COPY control's ±2%.
- Final sweep: convert the `sync-commit-queue` fixture to the real-registry form; grep the tier-③
  allow-list usages and confirm none rely on the removed perf justification; wording pass on
  `docs/testing-strategy.md` and `docs/architecture.md` to match the new contract.

### P3 measurements

Executed 2026-07-02/03, pre-render-once vs render-once implementations, quiet machine, min-based
with a COPY-control adjustment. The full table + interpretation is recorded in
[ADR-0029 → Consequences → Measured outcome](../adr/0029-registry-item-driven-ingest-engine.md); the
raw `tmp/agents` A/B logs/XMLs were deleted in P4 once the numbers landed in the ADR.

## Slice P4 — Status flips + docs regen

**Outcome (done):** ADR-0028 and ADR-0029 flipped to
`accepted (2026-07-02); implemented (2026-07-03)`; every slice above marked done with its final
state recorded;
the final perf record folded into ADR-0029 (verdict: the +9.0 → +11.9 → +18.3% scaling signature is
gone, only a fixed ≈ +0.35s once-per-shape cost remains, no tier-③ reversion); the ADR decisions
index regenerated (`docs:adr:check` green). The `tmp/agents` perf scaffolding and raw A/B
logs/XMLs were deleted now that the numbers live in the ADR — provenance is the ADR record, not the
raw sample files.

- Flip ADR-0029 and this plan from "in progress" once P1–P3 land.
- Regenerate the ADR decisions index (`bun run docs:adr`); rebuild the docs `llms.txt` artifacts if
  publishing (`bun run docs:build` — the artifacts are gitignored build output, not committed).

## Acceptance

- The engine option surface is `{ registry, shapes: { [name]: { tableKey, shape, ... } } }`; no
  table-scoped fragment is passed alongside the registry.
- `apply-tables.ts`, `catalog-tables.ts`, and the three `information_schema` probes are gone; casts
  derive from `deriveSyncColumnTypes`.
- Metadata DDL renders from its pgTables; the drift guard is a provisioning round-trip.
- Must-refetch truncates; the truncate-reconcile unit test is green.
- No tier-③ statement is backed by a perf justification; the render-once ladder is the sanctioned
  response to a measured regression.
- The suites run on real fixture registries; `validate` and `docs:adr:check` green.
