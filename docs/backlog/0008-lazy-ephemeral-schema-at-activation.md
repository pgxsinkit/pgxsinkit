# 0008 — Lazy ephemeral schema at activation (split the all-mutations view first)

Status: open
Opened: 2026-07-27 · Area: client boot (schema exec), ephemeral consistency groups (ADR-0021)

## The residue this targets

The ADR-0053-era engine-boot measurement campaign (emergent, 2026-07-26/27) decomposed the warm
boot's `schemaExec` phase after the fingerprint fast path already skips the durable replay. What
remains on every warm boot is the `pglite.exec` crossings, not JS work:

- the `pgxsinkit_local_meta` bootstrap exec,
- the stored-fingerprint read, and
- the **ephemeral schema exec** — every ephemeral TEMP cluster plus the `pgxsinkit_all_mutations`
  TEMP view, applied unconditionally because TEMP relations die with the old engine.

Measured on the board warm-boot bench: `schemaExecMs` ~130–200ms per boot with the durable replay
skipped — the ephemeral exec dominates. (The candidate "structural-first fingerprint" optimisation
was killed on evidence in the same campaign: generating the durable DDL text costs ~2ms; the
crossings are the cost. Bench artifacts: `tmp/warm-boot-bench/results-1785077571703.json` and
successors.)

## The proposed shape (3D → 3A from the campaign's proposal doc)

Two steps, strictly ordered because the TEMP view unions the ephemeral journals:

1. **3D — split `pgxsinkit_all_mutations`** into a durable view over the durable journals plus a
   TEMP overlay that unions in the ephemeral journals. The durable half then persists with the
   store (applied once, covered by the existing fingerprint), and only the small overlay remains
   an every-boot TEMP exec.
2. **3A — apply each ephemeral TEMP cluster at its group's FIRST ACTIVATION** instead of at boot,
   aligning with ADR-0021's lazy-activation model (a reference activates; nothing about an
   ephemeral group is needed before something references it). Boot then execs only the overlay
   view (or nothing, when no writable table exists), and an ephemeral group's cluster cost moves
   to the first read/write that touches it — off the warm-paint path entirely.

Design questions to settle before building (this item is parked at the design-pass stage):

- Activation ordering: a write enqueued against an ephemeral table before its cluster exists must
  create the cluster first (the ADR-0039 write-activation path already routes through activation —
  verify the ephemeral exec can ride it without reordering the enqueue pipeline).
- The overlay view must be recreated whenever an ephemeral cluster appears mid-session (its union
  branches change) — `CREATE OR REPLACE TEMP VIEW` per activation, or a static view over all
  declared ephemeral journals created up front while the tables themselves stay lazy.
- Failure surface: a first-activation exec failure lands inside a read/write path instead of boot;
  it needs the same loud, typed treatment boot-time schema failures get today.

## Trigger to pick it up

Warm-boot profiling shows `schemaExecMs` is a meaningful share of what remains between
`pglite.create done` and `localReadReady` (it is today: the two other big blocks — create-time
asset load and adoption — were addressed by the 2026-07 campaign), or an ephemeral-heavy registry
lands in a consumer and pushes the every-boot exec up.
