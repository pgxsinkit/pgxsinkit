# Backlog

The documented ledger for work we deliberately are **not** doing now: parked investigations (with
their evidence), improvement candidates, and escape-hatched designs. It fills the gap _before_
something becomes a plan — the promotion path is `backlog → docs/plans → docs/adr`.

Rules:

- One numbered file per item. Entries are **never deleted** — status flips instead, so a symptom
  someone trips over next year finds the prior investigation instead of restarting it.
- Every item carries a **Reopen trigger**: the concrete event or evidence that justifies picking it
  up. Until that fires, the item is settled — do not re-litigate it from scratch.
- `Status: parked` (investigated, evidence recorded, waiting on the trigger) · `candidate`
  (improvement we would take, unscheduled) · `promoted → plans/00xx` (one-line pointer to the plan
  or ADR that superseded it) · `dropped` (decided against; keep the why).
- This directory is an engineering ledger, not user documentation — it is not published to the docs
  site.

## Items

- [0001 — Stale-handle retry storm through the CDN chain](0001-stale-handle-retry-storm.md) — parked
- [0002 — Move the client onto PGliteWorker](0002-pglite-worker.md) — promoted → adr/0032
- [0003 — Cold-store shape prefetch overlap](0003-cold-store-shape-prefetch-overlap.md) — promoted → adr/0032
- [0004 — Registry-driven data-subject export (GDPR)](0004-registry-driven-data-subject-export.md) — candidate
- [0005 — Opt-in keyed incremental live queries for very large lists](0005-incremental-live-queries-for-large-lists.md) — parked
- [0006 — Revisit making strict (non-relaxed) durability the default again](0006-restore-strict-durability-default.md) — parked
- [0007 — OPFS storage model (two-tier VFS, Safari open-file ceiling)](0007-opfs-storage-model.md) — candidate
- [0008 — Lazy ephemeral schema at activation (split the all-mutations view first)](0008-lazy-ephemeral-schema-at-activation.md) — candidate
- [0009 — Circuits keys tables by bare name (schema-bound registries)](0009-circuits-schema-qualified-tables.md) — candidate
- [0010 — Mid-session shape reset (stream gone under a live read)](0010-mid-session-shape-reset.md) — done (2026-08-22)
- [0011 — A lost flip batch drains the convergence barrier](0011-lost-flip-batches-drain-the-barrier.md) — promoted → adr/0056
- [0012 — durable-streams needs a persistent volume before staging](0012-durable-streams-staging-persistence.md) — candidate
- [0013 — Engine-side claim leases (retry-safe shape release)](0013-engine-claim-leases.md) — candidate
- [0014 — A cross-stream commit fence (live cross-shape atomicity)](0014-cross-stream-commit-fence.md) — candidate
- [0015 — Entitlement gain is not surfaced mid-session (a re-mint only narrows)](0015-entitlement-gain-mid-session.md) — candidate
- [0016 — Runtime `params` are declared end to end and wired nowhere](0016-runtime-params-wired-nowhere.md) — candidate
- [0017 — `shapeKey` uniqueness is checked before schema qualification](0017-shapekey-uniqueness-after-qualification.md) — candidate
