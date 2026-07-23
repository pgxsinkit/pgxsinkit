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
