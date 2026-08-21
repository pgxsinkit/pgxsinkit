# A two-verb wire, and what replaces primary-key collision surfacing

Status: accepted (2026-08-21) — amends [ADR-0014](0014-bulk-apply-ordering-safety.md) decision 1 and
narrows [ADR-0045](0045-per-table-apply-mode-for-locally-derived-rows.md)

## Context

ADR-0014 decision 1 folds a drained read batch to one net operation per primary key, and pins one
rule inside that fold: a net `INSERT` is a **plain** INSERT, so a genuine primary-key collision
surfaces rather than being silently upserted. ADR-0045 then carved out a per-table exception
(`applyMode: "upsert"`) for tables that legitimately hold locally-derived provisional rows, and was
explicit that the exception must stay scoped so "the collision-surfacing signal is intact everywhere
it matters".

Both rest on a premise the Circuits wire does not supply. **The engine emits two verbs, `upsert` and
`delete`, and nothing else.** `translate_output` in `apps/engine/src/engine/output.rs` emits `upsert`
for every row it materialises and key-only `delete` for every retraction; `insert` and `update` exist
only on the *input* side, where the replication ingestor parses them out of Postgres. A shape row can
enter a subscriber's view for reasons that are not a Postgres INSERT — a subquery flip, a scope
grant, a backfill replay — so the engine states the row's value and claims nothing about what
preceded it.

The translator did not reflect that. It mapped `upsert` to `insert` on a comment asserting `upsert`
meant "a backfill row", and kept an `update` branch for a verb that never arrives. A probe against a
live engine disproved the comment: a standalone UPDATE in its own transaction arrives as `upsert`
too. So every change after a key's first became a colliding INSERT, and the integration lane failed
on exactly that — a row frozen at its created value while the server showed the update.

The fix is forced. What is not forced is what happens to the invariant ADR-0014 pinned, which is why
this is an ADR and not a bug fix.

## What the invariant was actually worth

**A primary-key collision can never originate from application data.** Postgres enforces uniqueness
upstream, so the server cannot send two distinct rows sharing a key. There is no schema a consumer
can write that produces one. It was never an application guard; it was an invariant tripwire on the
replication machinery, and ADR-0014 says so in its own terms — "under faithful replication the local
row mirrors the server".

The state it could catch was **stale rows the client should no longer hold**, and it caught them only
indirectly: the server later re-sent one of those keys, and the plain INSERT failed. The dominant
source of such rows was Electric emitting *silence* when a row left a shape via a subquery-membership
change — the exact hazard [ADR-0057](0057-retiring-tagged-subquery-reconciliation.md) has just
retired, whose failure mode it describes as "a row the client should no longer hold, with no error
anywhere". The collision was the downstream alarm for that state.

Circuits states evictions rather than implying them. The tripwire's principal cause was designed out
one ADR ago, by this same migration.

## Decision

1. **The wire vocabulary is `upsert | delete`.** `StreamOperation` and `SyncOperation` are narrowed
   to those two, so the dead branches are impossible rather than merely unused. The translator carries
   the operation through; it no longer maps one.

2. **ADR-0014 decision 1 is amended.** The fold's buckets become `deletes` and `upserts`. Its
   sub-rules collapse accordingly: the `updates` bucket has no producer, and `[delete, update]` — the
   "malformed for a faithful stream" throw — checked for a state the vocabulary can no longer express.
   Both are deleted, along with `applyBulkUpdatesToTable`. **The clearing DELETE on a re-created key
   stays**, and is now load-bearing rather than defensive: `ON CONFLICT DO UPDATE` refreshes only the
   columns the row carries, so folding `[delete, upsert]` to a bare upsert would let a row that
   genuinely left and re-entered keep column values from its previous life. The ADR-0014 property test
   — *fold-then-bulk ≡ ordered per-row apply* against non-empty initial state — is what pins it, and
   is retained with the oracle rewritten to model `ON CONFLICT DO UPDATE` rather than replacement.

3. **Every streamed change applies as `INSERT … ON CONFLICT (pk) DO UPDATE`.** This is sound because
   an engine upsert carries the **complete projected row** every time — `row_to_json_cols(row,
   out_cols)` emits every column of `out_cols`, never a changed-column subset — and the shape's
   `out_cols` is exactly the local table's column set. A batch is therefore uniform by construction,
   which is also why the bulk-UPDATE applier's column-set grouping is deleted rather than ported:
   Electric's default replica sent only changed columns, and that is what made a batch heterogeneous.

   That uniformity is now **load-bearing and asserted** (`assertUniformColumnSet`). Every bulk applier
   takes its column list from the first row of the batch, so a mixed batch does not fail — it writes
   the wrong thing (a row missing a column binds `DEFAULT` and overwrites a real value on conflict; an
   extra column is silently dropped). The guard was added after a deliberately hand-written
   heterogeneous batch in the ADR-0014 property test produced exactly that silent corruption. Leaving
   it unchecked was not defensible once the plain INSERT — the previous backstop for "the apply path
   wrote something wrong" — had been retired by this same ADR.

   The universal `ON CONFLICT (pk)` also makes the local table's primary key **load-bearing DDL**,
   where a plain INSERT plus `UPDATE … WHERE pk` needed no constraint at all. The generator has always
   emitted it from the registry spec (`getLocalSyncPrimaryKeyColumns` → `buildTableColumnSql`), but the
   drizzle `localTable` object did not carry it, so anything building DDL from that object produced a
   keyless table and a 42P10 at the first upsert. `defineSyncTable` now states the local key on
   `localTable` too, honouring a `clientProjection.localPrimaryKey` narrowing.

4. **ADR-0045's `applyMode` narrows to a backfill policy.** It no longer selects between insert and
   upsert for steady-state changes, because there is no longer a choice to make. It retains exactly
   one job: the initial load — a fresh subscription or a post-must-refetch re-snapshot — assumes an
   empty table, which is what lets it use COPY or a plain multi-row INSERT, neither of which can
   express `ON CONFLICT`. `applyMode: "upsert"` says that assumption does not hold for this table.
   The plain-INSERT collision therefore survives in one place, and there it is a real precondition
   check rather than a leftover: a pre-existing row means the backfill's emptiness assumption was
   violated.

   That tier also requires **distinct keys within the batch**, which this wire does not hand it: a
   leading run of `upsert`s legitimately repeats a key, because a fresh client reads an append-only
   stream from the start and every revision of a row is its own envelope. The run is therefore folded
   to its net rows (decision 2's fold) before the bulk tier sees it. Without that, the fast path turns
   the first row that was ever updated into a duplicate-key failure on every fresh client.

5. **Two targeted assertions replace the tripwire**, placed where the invariant lives instead of
   depending on a side-effect of INSERT semantics:

   - **Post-clear residue** (`assertClearLeftNoResidue`). After a custom `onMustRefetch`, assert the
     clear actually cleared. Sound **only for a shape that is the sole occupant of its table**: when
     K shapes share one, each brings a scoped clear that deliberately leaves its co-tenants' rows
     standing, and the client holds no scope predicate to subtract them with — `CircuitsShapeSpec`
     carries an opaque callback, not a scope key. The shared case is carried by the scoped-clear
     requirement (ADR-0055 decision 4), and that is stated rather than papered over with a check that
     only looks like one. The default TRUNCATE path is not routed through it, because it cannot leave
     residue.

   - **`localPrimaryKey` pinning** (`assertLocalPrimaryKeyIsPinned`). A `clientProjection.localPrimaryKey`
     narrower than the server key collapses every server row differing only in a dropped column onto
     one local row. This is the one primary-key collision that was never machinery — it is a registry
     design error — and narrowing is nonetheless the feature's whole point, sound exactly when the
     shape's predicate admits one value per dropped column. So it is checked, not banned: the compiled
     predicate must pin every dropped column with a top-level `eq` or `IS NULL` conjunct, or the
     subscription is denied. Conservative by construction — a branch under `OR`/`NOT`, or an
     `IN (subquery)`, admits more than one value and does not pin.

   This is checked at compile time rather than at `defineSyncTable` because the predicate is
   claims-dependent: what pins `owner_id` is the subject fused into it, which does not exist until a
   real caller subscribes.

## Consequences

**A must-refetch/handle bug is now less observable than it was.** If ADR-0056 decision 6's handle
comparison ever fails to trigger a clear, stale rows survive a re-snapshot; the collision used to
shout, and an upsert overwrites silently. Assertion 5a covers the sole-occupant case, which is where a
custom clear can under-clear. It does not cover a shared table, and no client-side check can without a
scope predicate the client does not have. This is a real reduction in coverage and is recorded as one.

**`applyMode` keeps a name that no longer says what it does.** It reads as an apply policy and is now
a backfill policy. Renaming it is a registry-facing API change and was not taken as part of this;
`SyncTableEntry.applyMode` and the registry-options page both state the narrowed meaning at the
declaration site.

**Consumers gain nothing to change.** No registry field moves, no shape declaration changes, and the
apply path is strictly more tolerant than it was. The one behaviour a consumer could observe is the
new `localPrimaryKey` denial — and no registry in this repo declares one.

**A consumer building local DDL from `localTable` gets a primary key it did not get before.** That is
the point (decision 3), and it matches what the local-schema generator has always emitted, so a store
provisioned by pgxsinkit sees no change. A consumer that had been rendering its own local DDL from the
drizzle object — and relying on the absence of a key — would now get one.

## Alternatives considered

**Keep a plain INSERT by inferring novelty client-side** — track which keys the client believes it
holds and downgrade to INSERT when a key looks new. Rejected: it reintroduces inference as the basis
of a correctness check, which is precisely what ADR-0057 removed, and its failure mode is a spurious
commit failure on a correct stream.

**Ask the engine to distinguish insert from update on shape streams.** Rejected on the merits, not
just on cost: the distinction is not the engine's to make. A row entering a subscriber's view via a
subquery flip is neither an insert nor an update of that row, so any answer would be a fiction the
client would then depend on.

**Drop the clearing DELETE on a re-created key**, since an upsert carries a full row. Rejected — it is
only equivalent when the local table has no column outside the shape's projection, and the property
test in decision 2 fails without it.
