# Catch-up alignment on stream offsets and the engine convergence barrier

Status: accepted (2026-08-20)

## Context

ADR-0031 gave the `ShapeInbox` a one-time, monotonic **commit floor** so a busy shape's delivered
changes commit at catch-up completion rather than waiting on a quiet sibling's first live poll. It
rests on three things Electric's wire format supplied:

- a **per-change global position** (`headers.lsn`) driving the dedup frontier;
- a **per-shape reported watermark** on `up-to-date` (`global_last_seen_lsn`);
- the fact that those watermarks are **globally comparable**, so the group's floor can be the `max`
  over them.

ADR-0055 moves the read path to Circuits' native API and durable-streams. That path supplies none of
the three.

**No usable per-change global position.** `headers.lsn` is documented absent on backfill rows, and
is *structurally* absent on feed-retraction deletes: `delete_envelopes()` (`engine/output.rs`) takes
a `txid` and has no `lsn` parameter to pass. Those retractions are precisely the membership move-out
deletes ADR-0023 depends on, so the gap lands on the security-relevant message rather than an
incidental one. `headers.txid` is present more widely, but xid assignment order is not commit order,
so it is not a valid commit ordering.

**No control message at all.** A native shape stream carries only change envelopes. `up-to-date` is
the transport-level HTTP header `stream-up-to-date` — a boolean with no position — so
`global_last_seen_lsn` has no native counterpart and nowhere in-band to ride.

**Offsets are per-stream.** `stream-next-offset` indexes *that stream's* space. `max` across shapes
is undefined on them, and that operation is the whole of ADR-0031's alignment step.

Two further facts bound the design. Writes are atomic **within** a stream and never across streams —
`Ds::append` posts a batch as one JSON array which the server flattens one level — so cross-shape
tearing is real, not theoretical. And the engine already publishes its own convergence predicate at
`GET /replication/lsn`, whose comment states it outright: *"Convergence barrier = sync caught up +
per-table offsets at tail + pendingFlips == 0."*

`pendingFlips` counts deferred subquery flip batches not yet propagated — membership move-out and
move-in. It is the load-bearing term: a barrier expressed as an LSN alone would report convergence
while a computed revocation was still undelivered, which is silent staleness on the revocation path
— the failure signature that hid a real revocation-loss defect during the Circuits evaluation.

## Decision

1. **The dedup frontier becomes the durable-streams offset, per stream.**
   Dedup asks only "have I already applied this, from this stream?", which needs per-stream
   monotonicity and nothing more. `stream-next-offset` is per-stream monotonic and is *already* the
   resume token persisted in sync metadata, so the frontier and the resume position become one value
   instead of two that can disagree. This is strictly better than the LSN frontier it replaces, and
   it makes the absence of `headers.lsn` on backfill and retraction rows irrelevant to dedup.

2. **Commit alignment uses the engine's convergence barrier, fetched out of band, once per
   alignment.** When every shape in the group has reported `stream-up-to-date` at least once, the
   client reads the barrier and — if it is satisfied — commits everything it is currently holding.

   The argument is a happens-before, not a position comparison: each stream reported drained, and
   the barrier read *after* those reports asserts the engine has nothing further to propagate. What
   the client holds at that moment is therefore complete with respect to the barrier. Nothing
   arriving afterwards is affected, because alignment is one-time.

3. **The predicate is the whole barrier, never a bare LSN.** Alignment requires `sync` caught up
   **and** per-table offsets at tail **and** `pendingFlips == 0` **and** `flipFailures == 0`.
   Dropping the third term reintroduces exactly the undelivered-revocation window described above.
   The `pendingFlips` term is read **engine-global** — conservative by construction: another table's
   pending flips can *delay* a group's alignment, never falsely satisfy it. Per-shape granularity
   would be an upstream engine change and is deferred until measured boot latency shows the delay
   matters. If the barrier is unsatisfied the client does not align; it retries with backoff and
   stays on the pre-alignment gate, which is correct if slower.

   *(Amended 2026-08-22.)* `sync` is dropped from this client's barrier: the engine's field is the
   `__el_sync` sentinel watermark — an i64 its conformance harness uses as a global quiescence fence,
   0 on every pgxsinkit database — and reading it as a convergence term would hold the gate closed
   forever. Per-table offsets at tail are what each stream's own up-to-date report asserts. The terms
   this client reads are `pendingFlips` (wait) and `flipFailures` (refuse).

   The first three terms describe work that is still *coming*, which is why waiting is the right
   response to each. Work that has been **lost** is a different condition, and the fourth term is the
   barrier expressing it — a term the engine did not report when this ADR was written, which
   [backlog 0011](../backlog/0011-lost-flip-batches-drain-the-barrier.md) records.

   *(Amended 2026-08-21, `flipFailures`.)* `flipFailures` is the one term the client must not wait
   on. The engine abandons a flip batch only after exhausting its propagation retries, and an
   abandoned batch **keeps its `pendingFlips` count held** — deliberately, so the waiting terms can
   never read converged over work that was lost. Waiting on that held count is therefore waiting
   forever, and from the client's side it is indistinguishable from waiting on a slow engine. The
   engine states the difference instead: it counts the abandoned batch in `flipFailures` and latches
   itself degraded, answering `503` on `/v1/health` and on every membership-bearing route while a
   reaper deletes the subquery shape streams. A group reading a non-zero `flipFailures` therefore
   **refuses terminally** rather than holding, and reports the refusal. Recovery is an operator
   restart, after which clients re-subscribe and re-snapshot — a deliberate act, not something a
   client can wait out.

4. **The barrier is read through the control plane, not the engine.** Clients never address the
   engine's control-plane HTTP directly — it is unauthenticated and not exposed. The control plane
   surfaces the barrier on its own authenticated endpoint and MAY cache it briefly.

   *(Amended 2026-08-21.)* This decision originally justified the cache with "a stale barrier can
   only *delay* alignment, never falsely satisfy it, because staleness moves it backwards". That
   holds for `pendingFlips`, and **inverts** for `flipFailures`: a cached pre-degradation zero
   licenses precisely the alignment the term exists to refuse. So a degraded reading is never cached
   and never served from cache, and the cache window is restated for what it actually is — the bound
   on how long a client may align against a freshly-degraded engine. That is why the default is zero.

5. **The steady-state commit gate is "every shape currently reports up-to-date". ADR-0031's commit
   floor is deleted, not ported.**

   *(Amended 2026-08-20. This decision originally read "the slowest-shape min-watermark gate governs
   the steady state", carrying ADR-0031's language onto a quantity where `min` is undefined — the
   same operation this ADR's own alternatives call ill-defined. Implementation forced the question;
   what follows is the resolution.)*

   The gate is a predicate over reports, not a comparison of positions: commit when **every** shape's
   most recent response asserted `stream-up-to-date`. That is decision 2's happens-before argument
   applied per commit rather than once — every stream has drained everything the server held, so no
   cross-shape transaction can be half-applied. It needs no comparable positions, which is what makes
   it expressible at all here.

   **Limitation** *(Amended 2026-08-22)*: that happens-before is real at **alignment** and weaker in
   the live steady state, and the ADR should say so rather than carrying the stronger claim. Once a
   group has caught up, every stream has an outstanding long poll and every one of them last
   *completed* asserting up-to-date — a `204` timeout carries the header — so the predicate is
   effectively always true and each delivery commits on arrival. Two streams carrying halves of one
   server transaction are answered by two separate long polls, so the client can commit one half
   before the other arrives. Cross-shape atomicity therefore holds at boot and catch-up (the barrier
   plus every-shape-drained argument above) and whenever both halves land before the gate evaluates;
   it is **not** guaranteed live, and the exposure is the two responses' inter-arrival gap — normally
   milliseconds. No client-side closure is airtight: waiting for each sibling's next report costs up
   to a long-poll timeout per single-table change, and re-polling the siblings narrows the window but
   cannot close it, because the engine's per-stream appends carry no cross-stream fence. The fence
   belongs in the emission path — this ADR's first alternative, recorded as
   [backlog 0014](../backlog/0014-cross-stream-commit-fence.md).

   The floor then has no job left. It existed for one reason: Electric's catch-up responses are
   CDN-cacheable and the `up-to-date` control message rides **inside the cached body**, so a quiet
   shape could assert a watermark captured before a busy sibling's writes, holding delivered changes
   until that shape's first live poll. Durable-streams carries up-to-date as a **response header on a
   live request**, and a long-poll timeout returns `204` with it set — so a quiet shape re-asserts
   freshness every poll cycle, and the stale-watermark failure mode cannot occur. A floor here would
   compensate for nothing.

   ADR-0031's remaining invariants survive because they were never about LSNs:
   - Ingestion is never narrowed by the gate. A batch below a shape's applied offset is dropped as
     already-applied; nothing else drops anything.
   - Alignment is one-time and monotonic per registration/reset generation.
   - A `must-refetch` reset re-arms alignment. It rewinds that shape to the start of its stream,
     which is coherent because the offset frontier and the resume token are the same value.

6. **Diagnostics keep the ADR-0031 shape.** The alignment transition emits one debug-rail line
   carrying the barrier that satisfied it — including `pendingFlips` — so an alignment that fired on
   a half-converged engine is one grep away rather than an inference from stale data.

7. **The native `must-refetch` trigger is the handle, discovered rather than received.** The client
   persists the stream it was reading alongside the offset. At every subscribe it compares the
   persisted handle with the one the control plane has just granted for that shape; when they differ
   the stored offset addresses a *different stream*, where ds offsets carry no meaning at all
   (PROTOCOL.md §10.2). Such a shape rewinds to the start of its stream, clears its rows in the same
   transaction the new snapshot lands in, and re-arms alignment — decision 5's surviving ADR-0031
   invariant, now with a trigger.

   Every native reset funnels through that single check. A shape the engine evicted, a stream
   deleted (`404`) or soft-deleted (`410`) under a live read, a stream that closed (`Stream-Closed`)
   — each ends with the client re-subscribing, and re-subscribing is what produces a new path. There
   is no separate control message and no reset opcode on the wire.

   This is where the substrate change pays off rather than costs. Electric needed an out-of-band
   `must-refetch` because its handles were opaque server state a client could not reason about, so
   the server had to *tell* it. Here the client already holds both handles and can simply compare
   them, which makes the trigger a local, total, synchronous check instead of a message that can be
   missed, duplicated, or arrive against the wrong generation.

   Two conditions are deliberately **not** resets. A `403` that survives a re-mint is a revocation:
   the scope is truncated and unsubscribed (ADR-0055 decision 6), not re-snapshotted. A `503` from a
   degraded engine is decision 3's terminal refusal.

   *(Amended 2026-08-22.)* The re-subscribe is automatic: a stream that ends under a live read
   restarts its group with backoff and the comparison runs on the fresh subscribe; a `403` that
   survives a re-mint takes the same path, and the scope it revoked is cleared at that subscribe
   (ADR-0055 d6).

## Consequences

- **The frontier and the resume token unify.** One persisted value per shape instead of an LSN
  frontier plus an offset, removing a class of disagreement between them.
- **`headers.lsn` stops being load-bearing.** Its absence on backfill and retraction rows, which
  would otherwise have forced engine-core changes to the dataflow emission path, becomes a
  non-issue. Nothing in this design reads it.

  That turned out to be worth more than the engine work it avoided. The compat path's B6/B10 defect
  (`docs/research/0001`) is exactly this hazard realised: a real watermark plus unstamped flip
  emissions makes an LSN-flooring consumer discard every membership move-in and move-out as
  already-seen. A frontier built on `headers.lsn` would have been vulnerable by construction; this
  one cannot be, because there is no code path that reads the field.
- **Boot acquires a control-plane dependency.** Alignment cannot complete while the barrier endpoint
  is unreachable. Failure is a delay, not a correctness break — the client stays on the
  pre-alignment gate — but staged boot (ADR-0041) must treat it as a degraded rather than failed
  state.
- **One extra round trip per alignment**, off the cacheable read path. It is once per
  registration/reset generation, not per poll.
- **The commit floor, the live-tail sibling nudge, and the snapshot-acceptance flag all disappear.**
  Each existed to compensate for something Electric-shaped — a stale cached watermark, a parked poll
  that would not refresh one, and LSN-0 snapshot rows racing an advanced frontier. None has a native
  counterpart, so all three are deletions rather than ports.
- **Cross-shape atomicity is an alignment guarantee, not a live one.** Boot and catch-up commit a
  group's shapes as one unit; live deliveries commit per response, with a tearing window bounded by
  the streams' response inter-arrival. Decision 5's limitation states the mechanism, and
  [backlog 0014](../backlog/0014-cross-stream-commit-fence.md) records the engine-side fence that
  would close it.
- **Alignment can now fail closed on a real condition.** `pendingFlips > 0` is a genuine
  not-yet-converged signal that Electric's wire format could not express at all, so this design can
  detect a case its predecessor silently mis-committed.
- **Alignment can also fail *terminally*, which is new.** `flipFailures > 0` has no Electric
  counterpart in either direction: the engine could not previously report lost membership effects,
  and the client had no state in which it stopped rather than retried. Runtimes must surface it —
  a group in this state never becomes up-to-date and never will without an engine restart.
- **`must-refetch` stops being a wire concern.** No reset opcode, no control message, no handling for
  one arriving against a superseded generation. The cost is that a reset is only ever *noticed* at
  subscribe: a shape whose stream is deleted mid-session learns its new handle from a re-subscribe
  rather than being told inline. That re-subscribe is automatic (decision 7's amendment) — the group
  restarts with backoff on the read failure — so the cost is a round trip and a backoff step, not a
  session that has to be rebuilt from outside.

## Alternatives considered

- **Stamp the LSN throughout the engine and add a heartbeat envelope carrying the replication head.**
  The in-band answer, and the eventual right one to take upstream: it restores Electric's semantics
  natively with no control-plane call. Rejected for now because it is engine-core work in the
  incremental-maintenance emission path, where a mistake corrupts ordering silently rather than
  failing loudly, and because the correct LSN for a *deferred* flip emission — propagated out of
  commit order by design — is a genuine open question we would be answering on upstream's behalf.
- **Group by `txid` and commit a transaction once every shape has passed it.** Rejected: backfill
  rows carry no `txid` either; "which shapes could carry transaction T" is not answerable from the
  stream; and xid wraparound would need handling. It also replaces a one-time alignment with
  permanent per-transaction bookkeeping.
- **Per-shape independent commit, abandoning cross-shape alignment.** Rejected: it discards the
  guarantee ADR-0031 decision 3 exists to protect. Writes are atomic within a stream but never
  across streams, so a reader could observe one half of a cross-shape transaction.
- **Aligning on `max` over per-stream offsets.** Rejected as ill-defined, not merely imprecise:
  offsets from different streams are incomparable values, so the comparison has no meaning even when
  it produces a number.
- **Reading the barrier from the engine directly.** Rejected: the engine's control plane is
  unauthenticated by design and is not client-reachable. Proxying it through the control plane costs
  nothing and keeps the trust boundary intact.

## Open questions

1. **How long may the control plane cache the barrier?** Still open, but the question changed shape
   under decision 4's amendment. It is no longer only "how stale may an alignment signal be" — a
   healthy cached reading also masks a subsequent degradation for the length of the window, so the
   bound is the smaller of measured alignment latency and the tolerable delay in noticing an engine
   that has lost membership effects. The default stays zero until both are measured.
2. ~~**Does `must-refetch` have a native equivalent?**~~ **Resolved** by decision 7: it is the
   handle comparison at subscribe, and every other candidate trigger (eviction, `404`, `410`,
   `Stream-Closed`) reaches the client through it.
