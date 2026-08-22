# Mid-session shape reset — a stream that dies under a live read is not yet re-subscribed

Status: done (2026-08-22) — implemented: a stream that ends under a live read (404/410/Stream-Closed, a
403 that survives re-mint, or a lost connection) restarts its group with backoff, and ADR-0056 d7's
handle comparison runs on the fresh subscribe (packages/client/src/circuits/group-sync.ts,
`scheduleRestart`)

Found 2026-08-21 while resolving [ADR-0056](../adr/0056-catchup-alignment-on-stream-offsets.md)'s
open question 2. Decision 7 settles what the native `must-refetch` trigger _is_ — the handle
comparison at subscribe — and that check was implemented. What was not was the path that gets a
mid-session failure back to a subscribe so the check can run. See **Resolution** below for what
landed.

## What was missing

Decision 7 names four conditions that all funnel into the handle comparison:

| Condition                       | When it is noticed | Implemented                     |
| ------------------------------- | ------------------ | ------------------------------- |
| Handle differs from persisted   | at subscribe       | yes — `syncCircuitsShapes` boot |
| Engine evicted the shape        | next subscribe     | yes, by the same check          |
| Stream deleted (`404`)          | mid-read           | yes — see Resolution            |
| Stream soft-deleted (`410`)     | mid-read           | yes — see Resolution            |
| Stream closed (`Stream-Closed`) | mid-read           | yes — see Resolution            |

The first two were the common cases and were already covered: a client that restarts, or whose
session re-subscribes, converges correctly. A long-lived session whose stream disappeared underneath
it did not — it stopped receiving and had no path back.

## Why it was not done with decision 7

The trigger and the recovery are separable, and the trigger is the part that was load-bearing for
correctness: without it a resumed shape replays an offset from a foreign stream, which the ds
protocol leaves undefined (PROTOCOL.md §10.2). The recovery loop is a liveness feature on top of a
now-correct base, and it needed a decision that was not yet made — whether the sync engine re-opens
a session itself, or surfaces the condition and lets the runtime (ADR-0041 staged boot) do it. The
answer turned out to be neither: the group orchestrator does it, because it is the layer that owns
the subscription (see Resolution).

## Shape of the work

1. Classify `404` / `410` / `Stream-Closed` in the read transport as **stream-gone** rather than a
   generic error, distinct from `401`/`403` (revocation) and `503` (degraded engine).
2. Route that to a re-subscribe for the affected shape, which grants a fresh handle.
3. Let the existing comparison do the rest — the new handle differs, so the shape resets through the
   path decision 7 already specifies and that is already tested.

Step 3 is free. Steps 1 and 2 are the item.

## Resolution

Implemented 2026-08-22, on the shape the "shape of the work" section describes but with the routing
one layer up.

- The read transport now hands its consumer the response's `closed` promise as an `onEnd` callback
  (`packages/client/src/circuits/stream-source.ts`) — `null` for a normal end, the error otherwise.
  That was the missing observation, and it is why the condition was invisible rather than merely
  unhandled: `stream()`'s own `onError` wraps only the OPENING request, so every later long-poll dies
  inside the response with nothing thrown at anyone. The group forwards it (`shape-group.ts`) and the
  engine passes it through (`sync-engine.ts`).
- `startCircuitsSync` answers it with `scheduleRestart` (`group-sync.ts`): report `onStreamError`,
  drop the session and streams, back off on the subscribe ladder, and re-open. A re-open that fails
  climbs the same ladder, so an edge that stays down is retried at the capped 10 s cadence instead of
  being abandoned. A restart is neither a boot nor a stop — it leaves `ready`, `startPromise`,
  promotion and the boot stamp untouched — and a generation counter lets a stop or a teardown
  abandon a restart parked on its backoff.
- Step 3 was free, as predicted: the fresh subscribe runs the ADR-0056 d7 handle comparison, so a
  stream the engine replaced re-snapshots and one it did not resumes from its persisted offset.

Two things were deliberately decided rather than inherited:

- **The whole group re-subscribes, not the one dead shape.** The subscribe answer is the single
  authority on what the subject may read, and the reconcile at subscribe (ADR-0055 d6) is what
  clears a scope that has since been revoked. Re-opening one stream would restore liveness while
  leaving both of those unasked — and a revoked scope's rows would stay readable.
- **A failed re-mint no longer rejects.** It runs inside the read's header thunk, so rejecting there
  killed the stream silently — the exact failure this item is about, reached by a second road. The
  held token stays in place (still valid for the refresh skew); when it truly lapses the edge 403s,
  the read ends, and this restart path re-subscribes, which is where a 401 surfaces as `onAuthError`
  and a 503 as a retried subscribe.

Covered by `tests/unit/circuits-group-restart.test.ts` and the second test in
`tests/unit/circuits-shared-revocation.test.ts`.

## Reopen trigger

A live session observed losing a stream without recovering — most likely from engine shape eviction
under a client that stays connected across an idle period longer than the retention lifecycle. The
integration lane will surface this as soon as it can hold a session open across an eviction.
