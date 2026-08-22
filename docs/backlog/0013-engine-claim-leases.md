# 0013 — Engine-side claim leases (make shape release retry-safe and bound the leak)

Status: done (2026-08-22)
Opened: 2026-08-22 · Area: the pgxsinkit `electric-circuits` fork (`apps/engine/src/engine/lifecycle.rs`),
`packages/server/src/circuits/subscribe.ts` (`refreshStreamToken`, `releaseStreamGrants`)
Reopen trigger: active shape count or engine RSS growing without bound in a long-running deployment,
or any second consumer of the release route.

## What landed

The "robust form" below, in full — the engine grew it, and pgxsinkit consumes it.

**Engine** (fork ADR-0008, _Subscriptions are identified, idempotent, and leased_): a subscription is a
first-class identity. `POST /shapes` takes a caller-chosen `subscription` id and echoes it back with
`leaseSeconds`; repeating the create with that id **renews** the claim and returns the same handle
(an id held by a different shape is `409`); `DELETE /shapes/{id}?subscription=…` releases **that**
claim and repeating it is a no-op `200`; a claim not renewed within `ELECTRIC_CIRCUITS_SHAPE_IDLE_SECS`
is released by the retention sweeper, so a crashed client's claims lapse instead of pinning a shape.

**pgxsinkit** (this repo):

- **A claim per grant.** `subscribeToShapes` mints a uuid per grant, sends it as `subscription`, and
  the `StreamGrant` carries it (`claim`) — per grant, never per shape, because two grants that
  deduplicate onto one `shapeId` are two joins.
- **Renew on the re-mint.** `refreshStreamToken` renews every re-authorized grant by repeating its
  compiled create with the same `claim` (both tiers share one compile). The cadence is therefore the
  CLIENT's refresh, not a server timer — a tab that stops polling stops renewing, and its claims
  lapse. That is the intended liveness semantics, not a gap: on the native path the engine cannot see
  reads, so a subscriber that has stopped asking is a subscriber that has left. A renewal that comes back a
  **different handle** revokes the grant (`shape stream changed; re-subscribe`) and releases the claim
  it just took; a **409** revokes it without a release; any other engine error is a 503, never a
  revocation. A revoked grant is not renewed, so its lease lapses.
- **Release by claim.** `releaseStreamGrants` sends `DELETE /shapes/{id}?subscription=<claim>` per
  grant — idempotent and retry-safe, so the route's old "call this exactly once and never retry"
  contract is gone. The client keeps its fire-and-forget `close()` (a page unload cannot retry
  anyway), and a lost release is reclaimed by the lease.
- **Lease/TTL guard.** Claims are renewed only on the token re-mint, so a lease window under
  `2 × ttlSeconds` would lapse a live session on one missed refresh. That pairing throws
  `CircuitsLeaseConfigError` and the subscribe/refresh routes answer
  `503 {"error":"sync engine lease window shorter than the token TTL"}` — a deployment fault, never a
  denial. `leaseSeconds: 0` (dormancy off) is accepted.
- The create response is **validated**, not cast: an engine that answers without `subscription` or
  `leaseSeconds` is the wrong engine and says so, exactly as the convergence barrier does.

## The engine facts this rested on (before fork ADR-0008)

None of the following is the engine's contract any more — it is the anonymous refcount that made this
item necessary. The current contract is in "What landed" above.

- A `POST /shapes` whose definition matched an existing shape did **not** create a second shape. It
  **joined** the existing one: `share.refcount += 1` (`engine/lifecycle.rs`). One subscribe was one
  join, and two subscribers of one shared-tier scope were two joins onto one stream.
- `DELETE /shapes/{id}` was `share.refcount = share.refcount.saturating_sub(1)`, and it carried **no
  claim identity** — nothing in the request said _whose_ claim was being dropped. The engine's own
  comment on that line said a retried DELETE "would decrement twice, which is the double-delete that
  steals another subscriber's refcount".
- `refcount > 0` blocked **both** dormancy and eviction (`engine/lifecycle.rs`, `retention.rs`). That
  was not incidental: on the native path reads terminate on durable-streams and never touch the
  engine, so the refcount was the _only_ thing telling the engine that a reader it could not see still
  existed.
- `Joined` was durable in the engine catalog; `Left` was queued. So a join survived an engine restart
  and an unreleased claim survived with it.

## What pgxsinkit did before this landed

`SubscriptionSession.close()` fired **one** `POST /sync/v1/release` carrying the token the subscribe
answered with, and the route released **one claim per grant** (deliberately not deduplicated by
`shapeId`: two grants on one deduplicated shape were two joins, so they needed two releases). The
token was the proof of what was acquired — verified with `allowExpired`, because a session closes
routinely past its TTL and expiry bounds how long a grant keeps _working_, not what it proves was
issued. (That half survives unchanged; what follows is what did not.)

It was **at most once, and never retried**, because the two failure modes were wildly asymmetric:

- A **lost** release left one claim too many, bounded to sessions that crashed or were unloaded before
  the request left. Nothing reclaimed it: `refcount > 0` blocked dormancy, so the shape stayed active
  and tailer-maintained until the engine was restarted.
- A **double** release dropped a refcount the session no longer owned — i.e. it stole another
  subscriber's claim, and could park a shape dormant underneath a live reader still following its
  stream. The reader saw delivery simply stop.

So the client swallowed every error, sent the request without the teardown abort signal and with
`keepalive` (a page unload must not cancel it), and latched so a second `close()` was a no-op. Best
effort by construction, not by omission. The client still does all of that; only the REASONS changed
— a repeat is now harmless, and the latch is about not making a pointless request.

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

## Why it was deferred, and what ended the deferral

The form before this already turned "every shape ever created stays active forever" into "claims of
clean closes are returned promptly, claims of crashes leak until restart" — which is the difference
between unbounded growth and a bound an operator can reason about. Leases were worth the engine-side
surface only once that residual leak was observed to matter, or once something other than
`SubscriptionSession.close()` needs to release (a second consumer cannot be given a route whose
contract is "call this exactly once and never retry" and be expected to honour it). The engine's own
work on durable, de-duplicated catalog events made identified subscriptions the natural shape for it,
so the leases came with them.
