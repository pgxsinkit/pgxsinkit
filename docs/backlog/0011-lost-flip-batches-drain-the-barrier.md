# A lost flip batch drains the convergence barrier as if it had landed

Status: parked (upstream engine defect; not reachable by anything we do today)

Found 2026-08-21 while re-baselining the native read path onto upstream `electric-circuits` main.
[ADR-0056](../adr/0056-catchup-alignment-on-stream-offsets.md) decision 3 gates a client's first
commit on `pendingFlips == 0`, which is meant to mean "every computed membership effect has reached a
stream". It means that only when every batch either lands or stays counted.

## The defect

`spawn_flip_propagator` logs a propagation failure and decrements the barrier anyway
(`apps/engine/src/engine/mod.rs`, in the `if let Err(e) = propagate_flips(...)` arm — the
`pending.fetch_sub` runs on both paths):

```rust
if let Err(e) = crate::subquery::propagate_flips(...).await {
    tracing::error!("subquery flip propagation failed: {e:#}");
}
pending.fetch_sub(1, Ordering::SeqCst);
```

So a transient Postgres or query-back error **drops the work and reopens the barrier**. The stream
append path retries until it lands; the query-back that produces those envelopes does not. A client
then sees `sync: true, pendingFlips: 0` — every term satisfied, permanently — while the membership
move-out that batch carried never reaches any stream. On the shared tier that is a row the subject
has lost entitlement to, still present in their local store.

## Why it is parked rather than fixed

It needs a Postgres/query-back failure to manifest at all, and nothing in our lane provokes one. More
to the point, **no client-side guard is possible**: the engine reports no counter that distinguishes
"drained because it landed" from "drained because it was abandoned", so pgxsinkit cannot detect the
condition however carefully it reads the barrier. The fix has to be upstream, and it is one of:

- retry/requeue failed propagation rather than dropping it; or
- keep the barrier poisoned and report the fact — an abandoned-batch counter beside `pendingFlips`,
  and a health status an operator can alert on.

A client-side term was written against a fork that had the second of those and was then reverted;
that code is gone, and this entry exists so it is not re-derived from scratch.

## Reopen trigger

Either upstream grows a signal for it (then pgxsinkit adds the term to decision 3's predicate and
refuses terminally on it, since lost work is not something a client can wait out), or our own lane
observes a `subquery flip propagation failed` line in engine logs — which would make it reachable
rather than theoretical.
