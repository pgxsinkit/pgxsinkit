# 0013 — Engine-side claim leases (make shape release retry-safe and bound the leak)

Status: candidate (recorded 2026-08-22)
Opened: 2026-08-22 · Area: the pgxsinkit `electric-circuits` fork (`apps/engine/src/engine/lifecycle.rs`),
`packages/server/src/circuits/subscribe.ts` (`refreshStreamToken`, `releaseStreamGrants`)
Reopen trigger: active shape count or engine RSS growing without bound in a long-running deployment,
or any second consumer of the release route.

## The engine facts this rests on

- A `POST /shapes` whose definition matches an existing shape does **not** create a second shape. It
  **joins** the existing one: `share.refcount += 1` (`engine/lifecycle.rs`). One subscribe is one
  join, and two subscribers of one shared-tier scope are two joins onto one stream.
- `DELETE /shapes/{id}` is `share.refcount = share.refcount.saturating_sub(1)`, and it carries **no
  claim identity** — nothing in the request says _whose_ claim is being dropped. The engine's own
  comment on that line says a retried DELETE "would decrement twice, which is the double-delete that
  steals another subscriber's refcount".
- `refcount > 0` blocks **both** dormancy and eviction (`engine/lifecycle.rs`, `retention.rs`). That
  is not incidental: on the native path reads terminate on durable-streams and never touch the
  engine, so the refcount is the _only_ thing telling the engine that a reader it cannot see still
  exists.
- `Joined` is durable in the engine catalog; `Left` is queued. So a join survives an engine restart
  and an unreleased claim survives with it.

## What pgxsinkit does now

`SubscriptionSession.close()` fires **one** `POST /sync/v1/release` carrying the token the subscribe
answered with, and the route releases **one claim per grant** (deliberately not deduplicated by
`shapeId`: two grants on one deduplicated shape were two joins, so they need two releases). The token
is the proof of what was acquired — verified with `allowExpired`, because a session closes routinely
past its TTL and expiry bounds how long a grant keeps _working_, not what it proves was issued.

It is **at most once, and never retried**, because the two failure modes are wildly asymmetric:

- A **lost** release leaves one claim too many. That is the status quo this route improved on, and it
  is now bounded to sessions that crashed or were unloaded before the request left. Nothing reclaims
  it: `refcount > 0` blocks dormancy, so the shape stays active and tailer-maintained until the engine
  is restarted.
- A **double** release drops a refcount this session no longer owns — i.e. it steals another
  subscriber's claim, and can park a shape dormant underneath a live reader that is still following
  its stream. The reader sees delivery simply stop.

So the client swallows every error, sends the request without the teardown abort signal and with
`keepalive` (a page unload must not cancel it), and latches so a second `close()` is a no-op. Best
effort by construction, not by omission.

## The robust form

Make the claim a **first-class, identified, expiring thing** in the engine:

1. A join returns a **claim id** alongside the shape handle. The refcount becomes a set of live claims
   rather than an integer.
2. Each claim carries a **lease**. The control plane **renews** it — the natural place is
   `refreshStreamToken`, which already runs per subject per TTL window and already re-authorizes every
   grant, so renewal costs no extra round trip and is refused for exactly the grants that were
   revoked.
3. **Release is by claim id**, and therefore **idempotent**: releasing a claim that is already gone is
   a no-op rather than a theft. That single property is what makes the client free to retry.
4. An **unrenewed claim expires**. A crashed or unloaded client's claims are reclaimed by the engine
   within one lease period instead of never, which bounds the leak by the lease rather than by the
   process lifetime.

Nothing here needs the read path to change: the engine is still asked once per subscribe and is still
out of the read path entirely.

## Why it is a candidate rather than a plan

The current form already turns "every shape ever created stays active forever" into "claims of clean
closes are returned promptly, claims of crashes leak until restart" — which is the difference between
unbounded growth and a bound an operator can reason about. Leases are worth the engine-side surface
only once that residual leak is observed to matter, or once something other than
`SubscriptionSession.close()` needs to release (a second consumer cannot be given a route whose
contract is "call this exactly once and never retry" and be expected to honour it).
