# Mid-session shape reset — a stream that dies under a live read is not yet re-subscribed

Status: candidate (boot-path reset is implemented; the mid-session half is not)

Found 2026-08-21 while resolving [ADR-0056](../adr/0056-catchup-alignment-on-stream-offsets.md)'s
open question 2. Decision 7 settles what the native `must-refetch` trigger _is_ — the handle
comparison at subscribe — and that check is implemented. What is not implemented is the path that
gets a mid-session failure back to a subscribe so the check can run.

## What is missing

Decision 7 names four conditions that all funnel into the handle comparison:

| Condition                       | When it is noticed | Implemented                     |
| ------------------------------- | ------------------ | ------------------------------- |
| Handle differs from persisted   | at subscribe       | yes — `syncCircuitsShapes` boot |
| Engine evicted the shape        | next subscribe     | yes, by the same check          |
| Stream deleted (`404`)          | mid-read           | **no** — the read just fails    |
| Stream soft-deleted (`410`)     | mid-read           | **no**                          |
| Stream closed (`Stream-Closed`) | mid-read           | **no** — delivery simply ends   |

The first two are the common cases and are covered: a client that restarts, or whose session
re-subscribes, converges correctly. A long-lived session whose stream disappears underneath it does
not — it stops receiving and has no path back.

## Why it was not done with decision 7

The trigger and the recovery are separable, and the trigger is the part that was load-bearing for
correctness: without it a resumed shape replays an offset from a foreign stream, which the ds
protocol leaves undefined (PROTOCOL.md §10.2). The recovery loop is a liveness feature on top of a
now-correct base, and it needs a decision that is not yet made — whether the sync engine re-opens a
session itself, or surfaces the condition and lets the runtime (ADR-0041 staged boot) do it.

## Shape of the work

1. Classify `404` / `410` / `Stream-Closed` in the read transport as **stream-gone** rather than a
   generic error, distinct from `401`/`403` (revocation) and `503` (degraded engine).
2. Route that to a re-subscribe for the affected shape, which grants a fresh handle.
3. Let the existing comparison do the rest — the new handle differs, so the shape resets through the
   path decision 7 already specifies and that is already tested.

Step 3 is free. Steps 1 and 2 are the item.

## Reopen trigger

A live session observed losing a stream without recovering — most likely from engine shape eviction
under a client that stays connected across an idle period longer than the retention lifecycle. The
integration lane will surface this as soon as it can hold a session open across an eviction.
