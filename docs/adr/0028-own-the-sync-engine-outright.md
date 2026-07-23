# Own the sync engine outright (upstream compatibility is an anti-goal)

Status: accepted (2026-07-02); implemented (2026-07-03)

[ADR-0009](0009-internalize-read-path-sync.md) internalized the read-path engine into
`@pgxsinkit/client` (`packages/client/src/sync/`) and dissolved the
`@pgxsinkit/pglite-sync` vendoring boundary — superseding [ADR-0007](0007-absorb-sync-engine.md)
decision 2. What it did **not** retire was the *test-suite* posture. The suites seeded
from upstream kept a "faithful, refreshable" porting policy: byte-faithful bodies,
`@ts-nocheck` + `oxlint-disable` pragmas, a pinned upstream SHA, and a documented refresh
procedure (`docs/conformance-baseline.md`). That policy treats the suites as *upstream's*
tests held to *upstream's* standards, kept cheap to re-pull.

The engine has diverged from upstream by design (serialized commit queue, static apply
ladder, consistency groups, removed `ON CONFLICT` band-aids, renamed metadata namespace).
There is no upstream to stay compatible with — it is effectively unmaintained — and every
hour spent keeping bodies re-pullable is spent holding our own regression net *below* the
standards we hold everything else to. The residual posture is now pure cost.

## Decision

1. **Upstream compatibility with pglite-sync is an anti-goal.** There is no refresh path,
   no pinned-SHA tracking, and "matches upstream" / "keeps the refresh cheap" is **never**
   a valid justification for code shape, test shape, or a raw-SQL string anywhere on the
   sync surface. This supersedes the porting policy of the conformance baseline (now the
   historical record at [docs/history/pglite-sync-vendoring.md](../history/pglite-sync-vendoring.md))
   and the last residue of [ADR-0007](0007-absorb-sync-engine.md) decision 2.
   ADR-0007 and [ADR-0009](0009-internalize-read-path-sync.md) remain immutable records of
   how the boundary was drawn and then dissolved; this ADR retires only the leftover
   compatibility posture, not their history.

2. **The former oracle suites are first-class owned tests.** They keep their behavioural
   coverage — they are still the read-path safety net through refactors — but not their
   fixedness. They are renamed for purpose and held to repo standards (strict typecheck,
   lint clean, the raw-SQL→Drizzle tier hierarchy):

   | Was | Now | Role |
   | --- | --- | --- |
   | `tests/unit/pglite-sync-upstream.test.ts` | `tests/unit/sync-engine.test.ts` | behavioural test of the internalized engine |
   | `tests/unit/pglite-sync-apply.test.ts` | `tests/unit/sync-apply.test.ts` | apply-path unit test |
   | `tests/integration/pglite-sync-e2e.integration.test.ts` | `tests/integration/sync-engine-e2e.integration.test.ts` | e2e engine test on the real Electric+Postgres lane |
   | `tests/integration/electric-pglite-sync.integration.test.ts` | `tests/integration/registry-sync-roundtrip.integration.test.ts` | registry-driven read round-trip |

   `sync-engine.test.ts` still mocks a process-global `MultiShapeStream`, so it keeps its
   own isolated `bun test` invocation in the parallel runner.

3. **Provenance policy.** A file that began as a copy of pglite-sync keeps exactly two
   references to the original, no more: a short prominent header comment —

   > Started life as a copy of `@electric-sql/pglite-sync` (Apache-2.0, © ElectricSQL —
   > see NOTICE). Fully internalized (ADR-0009); upstream compatibility is an explicit
   > anti-goal (ADR-0028) — evolve freely.

   — and the `NOTICE` attribution (Apache-2.0, legally required and permanent). Everything
   else — refresh procedures, byte-faithfulness notes, pinned SHAs, upstream-parity
   commentary — is relegated to the historical changelog at
   [docs/history/pglite-sync-vendoring.md](../history/pglite-sync-vendoring.md). Files that
   are pgxsinkit-native (`tags.ts`, `shape-inbox.ts` from ADR-0023/0024/0014) carry no such
   header. `copy.ts` began as a port of the upstream PGlite serializer (electric-sql/pglite
   PR #1035), so it keeps that specific reference folded into the standard two-line shape.

4. **The Drizzle mandate applies to the whole sync surface.** Every database statement
   climbs to the highest tier that works: ① pure Drizzle objects → ② a typed `sql\`\``
   template interpolating column/table objects and bound params → ③ a raw string, last
   resort only. Tier ③ survives **only** for the genuinely inexpressible. (Performance is
   **not** a standing tier-③ justification — that allowance is removed by
   [ADR-0029](0029-registry-item-driven-ingest-engine.md) decision 5, which replaces it with a
   render-once memoization ladder for any real measured regression.) The permanent tier-③
   allow-list, enumerated here so future sweeps do not re-litigate it:

   - runtime DDL generators (identifier/type text assembled at runtime);
   - PL/pgSQL function bodies and triggers;
   - `CREATE TYPE` / `DO $$ … $$` existence guards;
   - `SET LOCAL` GUCs (e.g. the sync-origin `pgxsinkit.syncing` flag);
   - `current_setting(...)` probes;
   - `COPY … FROM '/dev/blob'` ingest;
   - transaction keywords issued by `pg.transaction` internals;
   - PGlite's string-only `live.query` handoff of already-Drizzle-compiled SQL.

   Anything outside that list must be tier ① or ②; "the surrounding file uses raw SQL" and
   "it matches upstream" are both non-reasons.

## Consequences

- The read-path suites are held to the same bar as the rest of the repo; the divergence
  from upstream is now explicit and free, not a cost to be managed.
- The conformance baseline doc becomes a historical changelog; the live provenance shrinks
  to two anchors per copied file plus `NOTICE`.
- The Apache-2.0 attribution stays intact and permanent — ownership does not erase origin.
- Cost: the pragma/raw-SQL conversion of the two heavy suites is real work, sequenced in
  the plan below; this ADR removes the *posture* first so the conversions cannot be argued
  back to "keep it re-pullable".

References: [ADR-0029](0029-registry-item-driven-ingest-engine.md) (supersedes this ADR's
slice F/G contract — the registry item becomes the engine spec — and removes the tier-③
perf allowance in decision 4); [ADR-0007](0007-absorb-sync-engine.md) (absorbed the wrapper;
decision 2 superseded), [ADR-0009](0009-internalize-read-path-sync.md) (internalized the engine),
[ADR-0004](0004-one-registry-interpreter.md) (shared identifier resolver / the Drizzle
tier discipline), [ADR-0019](0019-row-filters-as-drizzle-fragments.md) (row filters as
Drizzle fragments); [docs/history/pglite-sync-vendoring.md](../history/pglite-sync-vendoring.md)
(the retired porting policy, kept as the vendoring-era changelog);
[docs/plans/0028-own-the-sync-engine-outright.md](../plans/0028-own-the-sync-engine-outright.md).
