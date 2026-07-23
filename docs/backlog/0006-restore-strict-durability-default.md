# 0006 — Revisit making strict (non-relaxed) durability the default again

Status: parked (recorded 2026-07-18, superseded by ADR-0047 for now)
Opened: 2026-07-18 · Area: client store create (`createClientPGlite` / `createSyncClient` / `defineSyncWorker`)
Reopen trigger: PGlite's idb flush cost drops materially — e.g. a batched/incremental/partitioned flush
lands upstream so a per-query flush no longer sets the write-path latency floor — OR an OPFS storage
backend (backlog-0007) lands whose sync-access-handle writes make synchronous durability affordable.
Not before.

## Context

ADR-0047 made relaxed PGlite durability the toolkit default because the idb backend's **synchronous
per-query flush to IndexedDB** dominates optimistic-write latency (a measured ~50ms+ floor per
statement), which is the wrong default for a local-first sync toolkit. The trade is a narrow,
bounded loss window: on a crash, only the single most recent optimistic write can be lost, and only
if it has neither reached the write API (~hundreds of ms after enqueue) nor been idb-flushed —
synced tables are server-recoverable by construction, so only consumer local-only tables carry real
risk.

That trade is correct **today**, given the current PGlite flush cost. It is not obviously permanent.
If the flush stops being the latency floor, strict durability would cost little and would remove the
loss window entirely, making it the better default again.

## Why it is parked, not planned

The opt-out already exists (`relaxedDurability: false` on all three surfaces), so a durability-sensitive
consumer is unblocked now. Flipping the _default_ back is a behaviour change for every consumer and
should only happen once the cost that motivated ADR-0047 has actually moved — measured, not assumed.

## Shape of the work, if reopened

- Re-measure the idb per-query flush floor on the then-current PGlite (and OPFS backend if it exists).
- If the floor is gone, flip the single default point (`createClientPGlite`'s `?? true` → `?? false`),
  keep the option, and update ADR-0047's status + the skills/docs that state the default.
- If only _some_ backends are cheap (e.g. OPFS fast, idb still slow), consider a backend-derived
  default rather than a flat one — resolved at the same single point.
