# Local schema evolution and mutation compatibility

Status: proposed (2026-06-22)

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

References: [ADR-0004](0004-one-registry-interpreter.md) (fingerprint);
[ADR-0005](0005-mutation-convergence.md) (drop primitive, quarantine surfacing);
`docs/migrations.md`; `CONTEXT.md` (Parity boundary, Mutation journal, Local
schema); [docs/plans/0006-local-schema-evolution.md](../plans/0006-local-schema-evolution.md).
