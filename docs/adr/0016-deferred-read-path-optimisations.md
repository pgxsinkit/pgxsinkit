# Deferred read-path optimisations and their triggers to revisit

Status: accepted (2026-06-23)

Two read-path ideas surfaced in the 2026-06-23 architecture review (worklog ISS-09, ISS-11). Both are
plausible but neither earns a build now, and both are the kind of thing a future review re-suggests
unless the reasoning is recorded. This ADR defers them with explicit triggers to revisit, so the
deferral is a decision, not an omission.

## Decision

1. **Defer the durable pre-apply ingest log (ISS-09).** The proposal was to persist normalised Electric
   messages locally before applying them, for replay, poison-LSN isolation, and postmortem. We defer it:
   the durable source of truth for un-applied read state is **already** Electric plus the persisted
   `offset`/`handle`, committed in the *same transaction* as the synced rows — which is exactly bounded,
   resumable replay. A second local ledger duplicates that and adds its own drift surface (the
   [ADR-0004](0004-one-registry-interpreter.md) "two sources of truth" disease). The only residual value
   — isolating a single poison LSN and offline postmortem inspection — is niche.

   **Trigger to revisit:** a concrete, observed failure mode where a row/LSN cannot be applied and
   offset-replay cannot recover (a true poison message), such that quarantining one LSN without losing
   the stream is worth the extra write path and drift surface. If built, it is a consumer of the ISS-06
   Shape inbox seam.

2. **Defer the materialised read model for hot tables (ISS-11).** The proposal was an optional physical
   read table per hot/wide table instead of the `UNION ALL` Read model view. We defer it: the Overlay is
   normally tiny (only un-acked writes), so the view's anti-join is usually cheap, and materialisation
   adds write amplification *and* another place the [ADR-0010](0010-convergence-barrier.md) Convergence
   barrier must hold consistently. **Field experience sets a high bar:** earlier versions of pgxsinkit ran
   ~100k-row read/write tables on the view-based read model at acceptable performance. So the burden of
   proof for materialisation is not "it might be faster" but a **measured, genuine improvement** —
   specifically a real reduction in CPU and battery drain on a representative device — established on the
   performance lanes (wide schema, 100k+ rows, many pending overlays), view vs materialised.

   **Trigger to revisit:** such a benchmark demonstrating that real CPU/battery reduction, for a
   registry-configurable opt-in mode — not before.

## Consequences

- The toolkit stays lean; neither change is carried speculatively.
- The reasoning survives this scratch worklog, so a future architecture pass (or AI review) does not
  re-raise either without meeting its stated trigger.
- Both deferrals have an explicit, falsifiable condition to reopen, so "deferred" never means "forgotten."

References: [ADR-0004](0004-one-registry-interpreter.md) (the duplicate-source-of-truth hazard ISS-09
would add); [ADR-0010](0010-convergence-barrier.md) / [ADR-0011](0011-convergence-model.md) (the barrier
a materialised read model would have to preserve); [ADR-0009](0009-internalize-read-path-sync.md) (the
internalized read path / ISS-06 Shape inbox an ingest log would attach to);
`tmp/agents/sync-system-improvement-worklog.md` (ISS-09, ISS-11).
