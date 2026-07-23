# The registry item is the ingest engine's spec

Status: accepted (2026-07-02); implemented (2026-07-03)

[ADR-0028](0028-own-the-sync-engine-outright.md) brought the read-path apply and metadata
paths up to repo standards under the Drizzle tier hierarchy. Its slice-F work landed with a
contract that, on review, was aimed at the wrong shape of the problem: the appliers re-derived
anonymous "passthrough" `pgTable`s from bare name strings (`apply-tables.ts`), the type-resolution
paths read `information_schema` at runtime and treated that read as the engine's *normal* process
(`catalog-tables.ts`), the metadata stores kept hand-written `CREATE TABLE` text, the must-refetch
wipe deleted row-by-row, and the option surface (`SyncShapesToTablesOptions` / `ShapeToTableOptions`)
still carried per-shape `table`, `schema`, `primaryKey`, `columnTypes`, `applyStrategy`, and
`mapColumns` — table-scoped facts passed alongside a registry the engine already had access to.

A design session (2026-07-02) reframed all of this around one observation: **the engine already
owns a complete, authoritative, per-table specification — the registry item.** Everything the
apply path needs is derivable from it by construction, and the repo already ships the machinery to
do so (`getSyncedLocalTable`, `deriveSyncColumnTypes`, the `schema.ts` renderer). The slice-F
constructs were a parallel table/type system standing next to machinery that already existed.
This ADR records the corrected contract; it supersedes the parts of ADR-0028's slice F/G that the
old contract shaped, and removes "measured perf regression" from ADR-0028's standing tier-③
allow-list.

## Decision

1. **The engine's spec is the registry item.** `SyncShapesToTablesOptions` gains a group-level
   `registry`; each shape carries a `tableKey`. The per-shape `table`, `schema`, `primaryKey`,
   `columnTypes`, `applyStrategy`, and `mapColumns` options are deleted — every one derives from
   the registry entry: local table identity via `getSyncedLocalTable(registry, tableKey)` (which
   renders bare for ephemeral lifecycles, fixing the latent `makeTable` qualification bug), primary
   keys from the entry table's columns, apply strategy from the registry's build-time
   classification (`classifyTableApplyStrategy`). `mapColumns` dies outright — it has zero producers
   outside the engine's own internals and zero test users; it is upstream residue with no caller.
   *Rationale:* a table-scoped fragment passed next to the registry that already describes that
   table is a smell — two sources that can disagree; the entry is the single source by construction.
   *Rejected:* (a) slice F's passthrough-table factory (`apply-tables.ts`), which re-derived
   anonymous tables from name strings while `getSyncedLocalTable` already returns the real objects —
   a parallel table system beside machinery the repo already had; (b) hybrid string-or-entry APIs
   that accept either a name or a `tableKey` — two codepaths, no gain, and the drift the entry was
   meant to close reopened. *Consequence:* the engine's own suites build small **real** registries
   for fixtures through the production registry-definition API, so the last "generic caller" residue
   (tests that constructed engine options from bare strings) dies with the option surface.

2. **Type knowledge derives from the model, never supplied, never introspected.** The casts for
   `json_to_recordset`, the COPY UDT lookups, and the bulk-recordset casts all come from
   `deriveSyncColumnTypes(entry)` — existing, proven contracts code that reads the same Drizzle
   definitions the local-schema generator reads. The three `information_schema` type-resolution
   probes and the engine's catalog stubs (`catalog-tables.ts`) are deleted. *Rationale:* the local
   store has exactly one DDL author — `generateLocalSchemaSql`, rendering from the same model — and
   the ADR-0004 registry fingerprint forces a rebuild whenever the model changes, so the catalog is
   *causally downstream* of the model. Introspecting `information_schema` observes our own rendered
   output with extra steps and a round-trip; the model states the answer directly. Extension types
   cannot arrive unmodeled: either the model declared them (so `deriveSyncColumnTypes` sees them) or
   the boot DDL that renders from that model would have failed first. This also fixes a latent bug:
   the probes filtered `table_schema = schema ?? 'public'`, so ephemeral (pg_temp) shapes on the
   json/copy paths introspected the *wrong* schema and produced empty casts. This SUPERSEDES the
   ADR-0028 slice-F ruling that "introspection is the normal process" — that ruling was made against
   the old contract, where the only alternative on the table was a dev-supplied array; with decision
   1 the model is present and authoritative by construction, so the introspection is not a normal
   process but a redundant one. *Rejected:* (a) mandatory caller-supplied `columnTypes` with a
   fail-fast (the discarded *first* slice-F design — dev-supplied data that then needs validation);
   (b) introspect-once-and-cache (adds a query plus a cache lifecycle to re-learn what the model
   already states).

3. **The metadata-store DDL renders from the pgTables through the in-house renderer.** The
   hand-written `CREATE TABLE` text in `migrateSubscriptionMetadataTables` (subscription-state.ts)
   and `shapeRowTagsDdl` (tags.ts) is replaced by rendering the slice-E `metadata-tables.ts`
   pgTables through the same `schema.ts` machinery that renders every other local relation — its
   core is extracted for reuse, and `CREATE INDEX` support is added to it for the tag-store index.
   *Rationale:* single source by construction — the pgTable is the one definition, the DDL is
   rendered from it, and the existing DDL-vs-pgTable drift guard demotes to a plain provisioning
   round-trip because the two can no longer diverge. *Rejected:* pushSchema / drizzle-kit at runtime
   — a heavy dev-tool bundle in a browser client, when the in-house renderer already exists and
   already handles the TEMP-table variants drizzle-kit cannot emit.

4. **Must-refetch wipes via TRUNCATE (tier ②).** The must-refetch cache wipe is engine cache
   maintenance, not a server echo: the row-level reconcile trigger exists to react to *server truth*
   arriving, and firing it off the engine's own cache wipe conflates the two. The reconcile LOOP —
   `reconcileTable`'s `clearable_entities` pass, which clears acked-delete journal rows once the
   synced row is gone — is the completeness guarantee; the trigger is only a race-closer for streamed
   echoes, and the re-snapshot inserts that follow a wipe still fire it. TRUNCATE is also O(1)
   against the ~900k statement executions a row-wise DELETE would run on a 300k-row wipe.
   *Rationale:* a wipe is not server truth, so it must not trigger server-echo reactions; correctness
   rides the reconcile loop, not the per-row trigger. A unit test proves the loop completes
   acked-delete reconciliation after a truncate-wipe. *Rejected:* row-wise DELETE (the upstream
   shortcut and the slice-F tier-① form; "truncate-before-restream" was the stated intent all along).

5. **Performance is never a justification for raw SQL.** The measured record: at suite wall-clock
   granularity the slice E+F deltas sat below noise, but a subsequent per-test A/B (3 isolated
   runs/side, per-test medians, pre-render-once builder vs the slice-F implementation, with COPY as a flat ±2%
   control) found one *real* regression, confined to a single family — the plain-`INSERT` backfill —
   and it scaled with row count: +9.0% @20k, +11.9% @150k, +18.3% @300k (median 12.89s→15.26s). The
   diagnosis is the per-row × per-column builder AST walk plus a `customType.toDriver` invocation per
   value per batch — precisely the per-call overhead class the render-once ladder targets. The remedy
   is therefore applied in plan slice P1: the batched-insert family ships in its render-once /
   memoized form from the start (author it tier-① and render its `{sql, params}` once per shape,
   byte-comparable to a hand-built string with per-call overhead driven to zero), on these measured
   grounds. The tier-③ reversion the old ADR-0028 escape hatch produced from these same numbers is
   discarded — raw strings are not the remedy; the ladder is. The ladder for any *future* real
   measured ingest regression is the same: (1) render-once the affected builder; (2) if that is
   insufficient, escalate to the owner with numbers. There is no unilateral tier-③ reversion, and no
   pre-emptive render-once elsewhere — every other builder stays plain until a measurement demands
   otherwise. *Consequence:* "measured significant perf regression" is REMOVED from ADR-0028's
   standing tier-③ allow-list justifications (see that ADR's amendment). *Rejected:*
   keeping perf as a standing tier-③ escape hatch — it invites reverting authored Drizzle to strings
   on noise-level or synthetic-stress numbers, exactly the drift the tier hierarchy exists to stop.

6. **`syncShapeToTable` survives as thin sugar** over the group form, taking the same entry-based
   options (a single `{ registry, tableKey, shape, ... }`). *Rationale:* the suites exercise engine
   mechanics through the single-shape entrypoint; deleting it is churn with no design gain, and the
   thin wrapper cannot drift from the group form it delegates to.

## Consequences

- The option surface shrinks to `{ registry, shapes: { [name]: { tableKey, shape, ... } } }`; every
  table-scoped fact is read from the entry, so the engine and the generated store can never disagree
  about identity, projection, PKs, strategy, or types.
- Two whole modules (`apply-tables.ts`, `catalog-tables.ts`) and the three `information_schema`
  probes are deleted; the appliers author directly over `getSyncedLocalTable` objects and derive
  casts from `deriveSyncColumnTypes`.
- Two latent bugs close: the ephemeral qualification bug (via `getSyncedLocalTable`'s bare
  rendering) and the wrong-schema empty-casts bug on pg_temp json/copy shapes (via model-derived
  types).
- The metadata DDL and its pgTables become one source; the drift guard becomes a provisioning
  round-trip.
- Must-refetch is O(1) and no longer conflates cache maintenance with server-echo reconciliation.
- Perf is off the tier-③ allow-list; the render-once ladder replaces it as the sanctioned response
  to a real regression.
- Cost: the engine restructure is a real rewrite of the option surface and the appliers, and the
  suites must be rebuilt on real fixture registries; sequenced in the plan below.

### Measured outcome (2026-07-02/03)

The render-once ladder (D5) was validated against the slice-F builder it replaces. The pre-render-once
and render-once implementations were measured on a quiet machine using min-of-samples with a COPY-control adjustment
(base = 2 fresh + 3 same-day same-commit samples; the 20k insert cell re-measured with 3 further
full-suite head legs, 5 samples/side — a strict base/head interleave was abandoned when a driver
leg crashed mid-run).

| Insert-method backfill    | Old builder (slice-F) | Render-once head |
| ------------------------- | --------------------- | ---------------- |
| 20k / 100B (2.46 → 2.79s) | +9.0%                 | +12–13%          |
| 150k                      | +11.9%                | +2.0%            |
| 300k                      | +18.3%                | +4.4%            |
| 20k / 10KB                | —                     | +3.6%            |

| Other shape          | Render-once head             |
| -------------------- | ---------------------------- |
| large_initial_load   | +2.1%                        |
| large_update         | +2.9%                        |
| json                 | ≈0 to −2.3%                  |
| data_types           | −0.5 to −4.0%                |
| COPY (flat control)  | +0.3 / −0.5% (P3), +1.0% (P4 re-legs) |

The old builder's **scaling** signature — the per-row × per-column AST walk, reading
+9.0 → +11.9 → +18.3% as row count climbed — is eliminated: the render-once head is flat in row
count. What remains is a single REPRODUCIBLE FIXED cost of ≈ +0.35s per insert-method backfill
*shape* — the one-time render of the chunk AST plus first-batch warmup — paid once, not per row:
the same absolute delta lands at 150k (+0.33s) and 20k/10KB (~+0.4s), which is why it reads +12–13%
on a 2.5s test but only +4.4% raw on a 7.5s one (+2.0% once control-adjusted). The 300k delta
(+0.86s) runs above the ~0.35s fixed cost, but that excess sits inside 300k's noisy 2-sample band
(a 25.3s outlier is present), so the fixed cost should be read as approximate at 300k, not exact.
Per the D5 step-2 trade the owner accepted, that is the
explicit bargain render-once makes — per-row scaling cost driven to zero, bought with ~⅓s once per
shape, and only on the non-default insert method. No tier-③ reversion occurred anywhere; the ladder
held.

References: [ADR-0028](0028-own-the-sync-engine-outright.md) (owned the sync surface; its slice F/G
contract and its tier-③ perf allow-list are amended here);
[ADR-0004](0004-one-registry-interpreter.md) (shared identifier resolver, registry fingerprint, the
Drizzle tier discipline); [ADR-0009](0009-internalize-read-path-sync.md) (internalized the engine;
"we own the types" decision 3, realised fully here); [ADR-0006](0006-local-schema-evolution.md)
(the fingerprint-driven rebuild that makes the catalog downstream of the model);
[ADR-0021](0021-lazy-ephemeral-sync-lifecycle.md) (ephemeral/pg_temp lifecycles, the qualification
rule); [ADR-0014](0014-bulk-apply-ordering-safety.md) (the fold and the reconcile completeness the
truncate-wipe rides); `CONTEXT.md` (Registry item as engine spec, Type knowledge, Cache wipe vs
server echo); [docs/plans/0029-registry-item-driven-ingest-engine.md](../plans/0029-registry-item-driven-ingest-engine.md).
