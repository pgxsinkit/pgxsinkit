# Local schema evolution and mutation compatibility

Status: accepted (2026-06-22); implemented (decision 9, lossless offline upgrade, deferred by design)

The local PGlite database (`idb://pgxsinkit-overlay-v1`, `client/index.ts:107`) is
provisioned by `generateLocalSchemaSql` (CREATE-style DDL) from the registry. There
is no migration path when the registry shape changes for a returning offline user;
the `-v1` suffix implies a manual, all-or-nothing reset.

The local DB holds three kinds of state with very different durability:

1. **Synced read cache** (shape data) — *reconstructible*; dropping it costs only a
   re-sync.
2. **Overlay rows** (optimistic writes not yet acked) — *pending intent*; dropping
   un-flushed ones is real data loss.
3. **Mutation journal** (the durable list of writes owed to the server; states
   `pending`/`sending`/`acked`/`failed` — `mutation.ts:45`, `schema.ts:90-94`) —
   the local source of truth; it **must** survive.

The journal already has a durable `failed` state with
`attempt_count`/`last_error`/`last_http_status`, retryable via `retryFailed`
(`failed → pending`). There is **no** version/schema stamp on journal entries.
Journal/overlay/read-model identities are name-coupled to the synced table
(`schema.ts:358-368`): a column add/drop is replayable, but a table rename/removal
orphans its journal. The parity boundary (`docs/architecture.md:78-83`) already
classifies `FOREIGN KEY` as best-effort and non-authoritative locally — the server
is the enforcement point.

Maintainer decisions (2026-06-22): lossless **offline** upgrade is a super-advanced
feature, **deferred** ("when someone really needs it"). The default is
drain-then-drop while online. Optimistic *attempt* yes; *silent* loss no.

## Decision

1. **Treat the three state classes separately.** The read cache is
   droppable/reconstructible; the journal + overlay are authority. Drop+resync
   applies to the read cache, never blindly to the whole DB.

2. **Default upgrade path is drain-then-drop (online).** On a detected registry
   change, flush + confirm acks first, then drop+resync the read cache only. Local
   FK "loss" is a non-issue — best-effort per the parity boundary, over a bounded
   window.

3. **The local-DB version key is registry-derived** (the
   [ADR-0004](0004-one-registry-interpreter.md) fingerprint), so upgrades are
   *detected*, not manually versioned.

4. **An incompatible drain is never silent loss.** The server is the authority: a
   mutation it cannot apply lands in a state and is surfaced, not dropped. Split
   `failed` into **transient** (network / 5xx → retry) and
   **permanent/quarantined** (4xx structural rejection → not retried, surfaced via
   callback). Stamp each journal entry with the registry fingerprint it was
   authored under, so a version-boundary crossing is *known* before sending.

5. **Loss-detection lives at authoring time, not only at runtime.** A registry-diff
   gate classifies `previous → working` registry as *compatible / risky /
   breaking*. Breaking diffs (dropped/renamed/repurposed column, new `NOT NULL`
   without default, PK change, table removal) become a conscious release decision —
   rework to expand/contract, or accept-and-notify. This catches the one case
   runtime cannot: silent column **repurposing** (applies "successfully", means the
   wrong thing).

6. **The migration discipline is expand/contract (parallel change).** Never
   drop/rename/repurpose in the same release that ships the new client; add-new →
   backfill → retire-later. The server stays backward-compatible through a window
   that outlives the slowest offline client's drain, so incompatible drains
   essentially never bite. The diff gate enforces the discipline.

7. **Enforcement respects the library/consumer boundary.** pgxsinkit ships
   **mechanism**: the diff + classification, the fingerprint, a runnable check (bin
   / exported function), and a default-safe runtime
   (quarantine + surface + continue on mismatch — **not** refuse-to-start). The
   **consumer** owns enforcement: the baseline (a committed `registry.lock` /
   fingerprint) and whether the check's non-zero exit blocks their CI. The
   committed lock is the enforcement surface — a breaking change shows as a
   reviewable lockfile diff, and regenerating it is the explicit acknowledgement
   (prior art: drizzle-kit migrations; the `0.0.0` + tag standard of
   [ADR-0001](0001-unified-ts-release-versioning-tooling-standard.md)). Layered:
   runtime net (ours, unconditional) / lock diff (review-visible) / opt-in CI check
   (theirs).

8. **Reject full ALTER-migrations for the read cache.** It is reconstructible; a
   parallel local migration history would itself drift — the ADR-0004 disease.

9. **Deferred:** lossless offline upgrade (block-the-upgrade-until-drained, or
   offline journal replay/re-mapping across a registry boundary). These need the
   old schema kept around and offline mutation re-mapping; revisit when a real need
   appears.

## Consequences

- Returning offline users get a defined, bounded, non-lossy-by-default upgrade.
- Data loss becomes either impossible (expand/contract) or surfaced-and-acknowledged
  (diff gate / quarantine), never silent.
- pgxsinkit gains a registry-diff/check tool and a fingerprint-stamped journal
  without owning anyone's pipeline.

## Implementation status

- **Decisions 5, 6, 7 (authoring-time gate + discipline + library/consumer boundary)
  — done.** `packages/contracts/src/registry-diff.ts` classifies a shape change
  (`compatible | risky | breaking`) over the ADR-0004 canonical shape, with
  `buildRegistryLock`, `diffRegistryAgainstLock`, `runRegistryCheck` (consumer wires
  the exit code), and `summarizeRegistryDiff`. The same-name type-change case — the
  silent repurposing the runtime cannot catch — is classified `breaking`. Pinned by
  `tests/unit/registry-diff.test.ts`. The expand/contract discipline and the
  commit-the-lock enforcement model are documented in
  [docs/registry-evolution.md](../registry-evolution.md).
- **Decision 4 (journal `registry_version` stamp + transient/permanent split) — done.**
  `client/src/schema.ts` adds the `registry_version` journal column; the mutation runtime
  stamps it at enqueue from the ADR-0004 fingerprint (`createSyncClient` passes
  `fingerprintRegistry(registry)`). `mutation-state.ts` defines the `quarantined` terminal
  state and `classifyFailureStatus`: a structural `4xx` → `quarantined` (surfaced via the
  `onQuarantine` callback + `diagnostics().mutation.quarantinedCount`, never retried);
  network/`5xx`/transient-`4xx` → retryable `failed`. The ADR-0005 hard attempt cap
  (`maxMutationAttempts`, default 10) escalates an exhausted `failed` to `quarantined`, and
  a quarantined mutation holds later same-entity mutations behind it. Pinned by
  `tests/unit/mutation-quarantine.test.ts` + `tests/unit/mutation-state.test.ts`.
- **Decisions 1–3 (fingerprint-keyed store, drain-then-drop boot, `dropReadCache`)
  — done.** A local-meta table (`pgxsinkit_local_meta`, `client/src/schema.ts`) records the
  registry fingerprint the store was provisioned under; `client/src/local-store.ts`
  (`reconcileLocalStoreVersion`) compares it on boot. On a change with **nothing owed**, it
  wipes and rebuilds the read cache at the new shape and resets the Electric subscriptions so
  shapes re-stream; with writes still owed it **defers** (surfaced via `onSchemaChange`,
  retried on a later boot) so nothing is dropped — the drain happens across sessions as
  pending writes flush and reconcile. `buildDropReadCacheSql` (read cache only, preserves
  overlay/journal) and `buildWipeLocalStoreSql` (full teardown) are the drop primitives;
  `client.dropReadCache()` exposes the former. Pinned by `tests/unit/local-store.test.ts`
  and proven against real Electric in `tests/integration/client-contract.integration.test.ts`
  (cross-boot rebuild + re-sync).
- **Decision 9 (lossless offline upgrade) — deferred** as designed.

**Supported baseline.** The fingerprint mechanism and the journal's `registry_version` column both
exist in 0.2.0. An unstamped store is therefore unconditionally treated as brand-new and stamped;
there is no supported unstamped store format or conversion path. A stamped store's journal always has
`registry_version`, so the genuine fingerprint-mismatch defer (writes owed) never meets a missing
column. Pinned by `tests/unit/local-store.test.ts`.

References: [ADR-0004](0004-one-registry-interpreter.md) (fingerprint);
[ADR-0005](0005-mutation-convergence.md) (drop primitive, quarantine surfacing);
`docs/migrations.md`; `CONTEXT.md` (Parity boundary, Mutation journal, Local
schema); [docs/plans/0006-local-schema-evolution.md](../plans/0006-local-schema-evolution.md).

## Addendum (2026-07-06): `discardQuarantined` — quarantine gains a symmetric rollback

Decision 4 shipped `quarantined` as a **surfaced but un-discardable** terminal state: `onQuarantine`
fired and the kept optimistic overlay stayed, but there was no rollback primitive. A quarantined overlay
row therefore lingered in the read model and **poisoned later same-entity writes** — a re-create threw
(`latestMutationSeq` still counted the quarantined head) and an update chained its base onto that dead
head. The host could only surface the loss, never clear it. This was asymmetric with ADR-0015's
`conflicted`, which had `discardConflict` (delete the terminal journal rows + clear the kept overlay
behind the owed-guard), and the asymmetry pushed consumers to **mis-route a permanent policy denial
(e.g. an RLS `42501`) to `conflicted`** purely to borrow that rollback.

`discardQuarantined(table, entityKey)` closes the gap — exactly symmetric to `discardConflict` in
signature, placement, and semantics. Both public discards are now one internal helper
(`discardTerminalEntity`) parameterized by the terminal status it retires: it deletes the entity's
journal rows in that status and clears the kept overlay through the shared `buildOverlayDiscardQuery`
owed-guard (the overlay survives when another still-pending write owes the entity), in its own
transaction. After a `discardQuarantined` the phantom row is gone from the read model and a subsequent
mutation on the same entity is accepted. It crosses the SharedWorker bridge (ADR-0032) as its own
`RpcOp`, mirroring `discardConflict`.

Consumer consequence: a permanently-rejected write (structural 4xx, or an RLS policy denial routed to
quarantine) now has an honest rollback, so **policy denials no longer need the `conflicted` reroute** —
reserve `conflicted` for genuine stale-write conflicts. Pinned by the `discardQuarantined` cases in
`tests/unit/mutation-quarantine.test.ts` (create/update rollback + re-accept, owed-guard, no-op safety)
and the bridge round-trip in `tests/unit/worker-bridge.test.ts`.
