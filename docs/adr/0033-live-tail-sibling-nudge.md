# Live-tail sibling nudge: refresh quiet-shape watermarks instead of waiting out their long-polls

Status: accepted (2026-07-04). Amends ADR-0031 decision 4.

Contract confirmed (2026-07-04 design review): **strict cross-shape atomicity is pgxsinkit's
consistency contract, and CDN-fronted Electric — live long-polls coalesced at the CDN, catch-ups
CDN-cached — is a first-class production deployment, not a special case.** Under that paradigm a
quiet shape's watermark never advances promptly on its own (its parked poll returns only on its own
data or hold expiry), so *any* group-minimum commit gate requires an active freshness mechanism;
the nudge is therefore first-class protocol behavior, not a workaround. This holds for customer-run
CDNs (e.g. Cloudflare in front of self-hosted Electric) exactly as for Electric Cloud.

ADR-0031 fixed the group-commit stall at the **catch-up** boundary and kept full min-watermark gating
on the live tail, on the stated premise that "live responses are fresh, and Electric completes every
held long-poll on each global-LSN advance, so no shape's frontier lags for a cacheable reason." Field
measurement on Electric Cloud (backlog 0001, 2026-07-04) falsified that premise for the hosted
deployment: a quiet shape's parked live long-poll is **not** completed when the global LSN advances —
it returns only at the end of its ~41s hold cycle (CDN-mediated; ~20s against self-hosted Electric).

The consequence is the same stall class ADR-0031 fixed at boot, recurring in the steady state. A
cross-client write lands on a busy shape's stream within ~1–2s (delivery is healthy — measured 1.2–2.7s
direct and through the deployed proxy). But the group commits only at the MIN effective frontier across
its shapes, and the quiet siblings' frontiers advance only when their parked polls return. The measured
failing rail: the change batch was received and buffered at +2s, and committed **41.7s later** — the
exact moment the three quiet siblings' long-polls returned their next `up-to-date`. The rail compounded
the confusion: the `sync applied change batch to local store` line logged after `enqueueCommit()`
returned, whether or not the commit loop had actually committed the batch — "applied" while the rows
sat buffered.

## Decision

1. **Nudge lagging siblings when a live batch is gated.** When a change batch completes an LSN above
   the group's committed frontier and the commit loop cannot reach it (the batch stays buffered), a
   per-group watchdog calls `forceDisconnectAndRefresh()` on every sibling shape that (a) has reported
   `up-to-date` at least once — i.e. is parked in its live tail — and (b) whose effective frontier is
   below the gated LSN. The Electric client aborts the parked poll and issues an immediate **non-live
   catch-up** (`canLongPoll: false`), which returns the shape's current `global_last_seen_lsn` in
   ~sub-second. The frontier advance rides the normal `up-to-date` ingest path, so the **commit is
   still driven by the ordinary commit loop at the group min frontier — the watchdog never commits and
   atomicity is untouched.** The nudge only shortens how long a gated batch waits for its siblings'
   watermarks: from the remainder of a ~41s hold to roughly one shape-request round trip.

2. **A one-shot cache-buster defends each nudged catch-up.** The forced catch-up is a cacheable
   non-live request; a CDN HIT would echo the same stale watermark that made the sibling lag, defeating
   the nudge. The watchdog arms a per-shape token just before the refresh, and a thin `fetchClient`
   wrapper (`withNudgeBuster`) consumes it on that shape's next non-live request, appending
   `cache-buster=<token>`. One token, one request: steady-state catch-up traffic stays cacheable, so
   ADR-0031's rejection of blanket catch-up busting (CDN cold-fanout sharing) still stands.

3. **Bounded and single-flight.** At most `NUDGE_MAX_ROUNDS` (3) rounds per gated target, one watchdog
   per group (a concurrent gated batch just raises the shared target LSN), a shape is never re-nudged
   while its previous refresh is in flight, and a round that finds no nudgeable sibling exits quietly —
   the routine pre-alignment case, where still-catching-up siblings advance on their own. A dead
   sibling degrades to the old behavior (wait out its poll), never a refresh storm.

   **A hold must PERSIST (`NUDGE_HOLD_GRACE_MS`, 1s) before the first round fires.** A cross-shape
   transaction's sibling halves arrive milliseconds apart even on a healthy stack, so every grouped
   commit passes through a transient held instant; nudging on it immediately aborts the sibling poll
   that is about to deliver the other half — measured as an abort/refetch disruption loop that broke
   the grouped sync-e2e integration lane on local (no-CDN) Electric. With the grace, the nudge simply
   never fires on local stacks, and on Electric Cloud it adds ~1s to a path that saves ~40s.

4. **The rail tells the truth.** `sync applied change batch to local store` now fires only when the
   batch's completed LSNs are at or below the advanced committed frontier. A gated batch logs
   `sync change batch held by group frontier {heldLsn, frontier}` instead, followed by
   `live-tail sibling nudge {shape, target, round}` lines and — only when rounds exhaust with the
   frontier still short — `live-tail nudge exhausted; waiting on sibling live polls`.

## Alternatives considered

- **Wait out the sibling polls** (ADR-0031 decision 4, the status quo). Correct but delivers a measured
  ~40s cross-client latency on Electric Cloud for any write whose consistency group contains quiet
  shapes — unacceptable for a live sync product, and the direct trigger for this ADR.
- **Per-shape independent commits.** Removes the wait entirely but abandons cross-shape atomicity in
  the live tail; rejected in ADR-0031 and still rejected here — the nudge achieves the latency without
  giving up the invariant.
- **Proxy-side busting of live long-polls** (the backlog 0001 stopgap, `bustLiveUpstreamCache`). Solves
  a different half: it restores wake-on-commit for the **busy** shape's own delivery. It cannot help the
  quiet siblings — their polls are blind because nothing on their shape changed; only a fresh watermark
  fetch (this nudge) advances them. Both mechanisms stay in place for Electric Cloud.
- **A heartbeat table in every group** (a server-side ticker making every group "busy"). Dead on
  arrival: the heartbeat is its own shape, so its freshness asserts only its *own* stream's
  completeness — it can never prove a quiet sibling has delivered everything up to the head, which
  is exactly what the min-gate needs. Per-shape freshness genuinely requires per-shape assertions.
- **Per-group relaxed atomicity** (a `consistency: "independent"` group mode). Declined in the same
  review: ungrouped tables are already the default and already commit independently, so the mode
  would buy only "shared lifecycle without atomicity" at the cost of a permanently forked commit
  path and a doubled commit/resume/reset test matrix. A cheap per-group nudge opt-out remains
  available as a future ops knob if ever asked for.
- **An upstream Electric Cloud fix** (live polls completing on global-LSN advance, per the filed
  report `docs/backlog/0001-upstream-report-electric-cloud-live-poll-blindness.md`). Would shrink the
  window the nudge papers over, but the engine cannot depend on hosted-CDN behavior it does not
  control; the nudge is correct against any hold length, including self-hosted's ~20s.

## Consequences

- **Cross-client latency on Electric Cloud drops from ~41s worst-case to ~1–3s** for gated live
  batches (delivery + one nudged catch-up round trip + commit).
- **Bounded extra origin load.** Each gated batch costs at most one CDN-busted catch-up per lagging
  sibling per round (≤3 rounds, coalesced across concurrent batches by the shared target). Idle groups
  and single-shape groups never nudge.
- **Rail-line change is observable.** Anything grepping the old unconditional "applied" line now sees
  it only on real applies; the held/nudge lines are the new diagnostic surface for this class.
- The nudge lives in the engine's per-group scope (`packages/client/src/sync/index.ts`) with the pure
  pieces (`withNudgeBuster`, round constants) in `packages/client/src/sync/nudge.ts`; the inbox gained
  `effectiveLsnFor` / `hasReportedUpToDate` accessors, with `lowestCompleteLsn()` refactored onto
  `effectiveLsnFor` so the two definitions cannot drift.
- ADR-0031's catch-up alignment is unchanged and still load-bearing; only its decision 4 ("the live
  tail keeps full min-watermark gating" as a *waiting* posture) is amended — the gate itself remains,
  the waiting is replaced by an active watermark refresh.
