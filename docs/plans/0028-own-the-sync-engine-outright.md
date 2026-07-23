# Plan — ADR-0028: Own the sync engine outright

Implements [ADR-0028](../adr/0028-own-the-sync-engine-outright.md). Goal: retire the
last upstream-compatibility posture around the read-path engine and its suites — no
refresh path, no byte-faithful bodies, no upstream-parity justifications — then bring the
former oracle suites and the apply/metadata paths up to repo standards (strict typecheck,
lint clean, the raw-SQL→Drizzle tier hierarchy of [ADR-0004](../adr/0004-one-registry-interpreter.md)).

Depends on / coordinates with: [ADR-0009](../adr/0009-internalize-read-path-sync.md)
(the engine is already internalized), [ADR-0004](../adr/0004-one-registry-interpreter.md)
(shared `sql-identifier` resolver, the tier discipline), and
[ADR-0019](../adr/0019-row-filters-as-drizzle-fragments.md) (Drizzle fragments). Each slice
ends `validate`-green; the integration/perf proofs run in the Podman lane.

## Slice A — Posture removal (this slice)

**Outcome (done):** posture removed — suites renamed, baseline doc moved to
`docs/history/`, provenance shrunk to the two-anchor form, NOTICE/AGENTS/docs updated.

- New ADR-0028 + this plan.
- Rename the four suites for purpose (`sync-engine`, `sync-apply`, `sync-engine-e2e`,
  `registry-sync-roundtrip`) and fix every ripple (the unit runner's ISOLATED/WEIGHT keys,
  the `test:integration:*` script keys + file args, the apply test's env var / debug label /
  `describe`).
- Move `docs/conformance-baseline.md` → `docs/history/pglite-sync-vendoring.md` with an
  "obsolete historical record" banner; repoint the one live link (plan 0009).
- Shrink live provenance to the two-anchor form on copied source files; reword the
  upstream-parity comments (`types.ts`, `copy.ts`); rewrite the two renamed suite headers to
  the ownership form. Update `NOTICE`, `AGENTS.md`, `docs/architecture.md`,
  `docs/testing-strategy.md`, `CONTEXT.md`.
- No behavioural code change in this slice.

## Slice B — e2e suite to repo standards

**Outcome (done):** `@ts-nocheck` + `oxlint-disable` pragmas removed from the e2e
suite; it typechecks and lints clean with behavioural coverage intact.

- Remove the `/* oxlint-disable */` + `@ts-nocheck` pragmas from
  `tests/integration/sync-engine-e2e.integration.test.ts`; make it typecheck and lint clean.
- Keep the behavioural coverage; the raw ingest statements it genuinely needs (the surface
  under test) stay tier ③ per the ADR allow-list — the rest convert.

## Slice C — Unit engine test Drizzle conversion

**Outcome (done):** the unit engine test's in-test SQL converted to the Drizzle tiers
where expressible; the `MultiShapeStream` mock and its isolated shard kept.

- `tests/unit/sync-engine.test.ts`: convert its in-test SQL to the Drizzle tiers where
  expressible; keep the process-global `MultiShapeStream` mock and its isolated shard.

## Slice D — e2e Drizzle conversion

**Outcome (done):** the remaining expressible raw statements in the e2e suite converted
to Drizzle objects / typed `sql\`\`` templates; only the permanent tier-③ cases remain. This state
is also the pre-render-once perf A/B baseline for P3.

- Convert the remaining expressible raw statements in the e2e suite to Drizzle objects /
  typed `sql\`\`` templates, leaving only the permanent tier-③ cases.

## Slice E — Engine metadata stores via a Drizzle-over-Transaction executor

**Outcome (done):** `subscription-state.ts` and the metadata bookkeeping in `index.ts`
routed through a Drizzle executor bound to the PGlite `Transaction`, replacing hand-built statements.

- Route `subscription-state.ts` (and the metadata bookkeeping in `index.ts`) through a
  Drizzle executor bound to the PGlite `Transaction`, replacing hand-built statements.

## Slice F — Apply-path table objects + catalog-stub type-resolution reads

**Outcome (done; superseded in part by ADR-0029 P1):** the slice-F contract was implemented
(passthrough-table factory, `information_schema` catalog stub, apply-path tiering); ADR-0029 then
reframed the engine onto the registry item and replaced these constructs — the superseded-in-part
banners below stand.

> **Superseded in part by [ADR-0029](../adr/0029-registry-item-driven-ingest-engine.md) — see
> its plan slice P1.** The "introspection is the normal process" ruling below is overturned by
> ADR-0029 decision 2 (type knowledge derives from `deriveSyncColumnTypes(entry)`, never
> introspected — the catalog is causally downstream of the model), and the passthrough-table
> factory is replaced by `getSyncedLocalTable` (ADR-0029 decision 1). The text is kept as the
> record of the slice-F contract that ADR-0029 subsequently replaced.

Corrected design (2026-07-02): the earlier "delete the registry-less `information_schema`
fallbacks" framing was wrong and is retired. The `information_schema.columns` type-resolution
reads on the `json`/`copy` apply paths are the engine's **normal** process, not a fallback: the
local database is the authoritative source for the casts/UDTs the apply must match, so the read
is kept with behaviour unchanged. Caller-supplied `columnTypes` stays exactly what it is — an
**optional** round-trip-saving cache used when present. The read is not made required, no
fail-fast is added, and no caller contract changes.

What this slice actually does:

- New `apply-tables.ts`: memoized **passthrough** `pgTable`s (identity `customType`
  `toDriver`/`fromDriver`) so the appliers author INSERT/UPDATE/DELETE/upsert as tier-① Drizzle
  over `drizzleOverPg`, binding byte-identically to the old raw params (bare vs schema-qualified
  per the ephemeral rule).
- New `catalog-tables.ts`: a read-only `information_schema.columns` stub `pgTable`; the three
  type-resolution probes (`resolveJsonRecordsetColumns`, `resolveCopyColumnUdts`,
  `recordsetColumnCasts`) convert from raw `information_schema` SQL to tier-① stub selects, same
  WHERE, same mapping, same call timing (only when `columnTypes` is absent, exactly as before).
- `apply.ts` DML: single-row + batched INSERT, move-in upsert (`onConflictDoUpdate`/`DoNothing`)
  to tier ①; the `json_to_recordset` insert and the bulk DELETE/UPDATE to tier ② (interpolated
  table object + a single bound param carrying the raw JS array — `sql.param`, never
  `JSON.stringify`, which would throw on bigint payloads — plus the recordset record-definition /
  join as raw text the grammar requires). COPY stays tier ③ (allow-list; `generateCopyData`
  untouched).
- `sync/index.ts` must-refetch `DELETE FROM <table>` to a tier-① delete over a passthrough table.

## Slice G — Perf gate

> **Replaced by [ADR-0029](../adr/0029-registry-item-driven-ingest-engine.md) plan slices P3/P4.**
> ADR-0029 decision 5 removes "measured perf regression" as a tier-③ ground entirely; the
> perf lane becomes a detection-only A/B protocol (P3) whose only remedy for a real regression is
> the render-once memoization ladder, never a tier-③ reversion. The text below is retired.

- Run the existing performance lane before/after the conversions; a MEASURED significant
  regression is the only ground on which a converted statement may revert to tier ③.

## Acceptance

- No refresh procedure, pinned SHA, or byte-faithfulness claim remains outside
  `docs/history/`, `NOTICE`, and the two-anchor source headers.
- The four renamed suites are green and (after B–F) typecheck + lint clean.
- The sync surface honours the ADR-0028 tier hierarchy; every surviving tier-③ statement is
  on the ADR's permanent allow-list or backed by a measured perf regression.
