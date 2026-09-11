# 0019 — Group catch-up readiness never clears when a group is reverted

Status: candidate (recorded 2026-09-11)
Opened: 2026-09-11 · Area: `packages/client/src/index.ts` (`onGroupReady`, the shared `desync` /
`discardEphemeral` revert path), `packages/client/src/circuits/group-sync.ts` (`stopGroup`),
`packages/client/src/worker/define-sync-worker.ts` (`seenReadyGroups`),
`packages/client/src/worker/attach-sync-client.ts` (`readyGroups`)
Reopen trigger: the first consumer that reverts a lazy group and then awaits `groupReady` (or reads
`status.groups`) for the re-activation — a hydration gate that flashes "ready" over an empty
re-catching-up relation is the symptom.

## The fact

A group's catch-up readiness is recorded in four places and cleared in none of them when the group
is stopped.

- `onGroupReady` sets `status.groups[groupKey] = true` and never writes `false`. The revert path
  (`desync` / `discardEphemeral` → `stopGroup`) stops the stream, clears the persisted lazy
  activation, resets the subscription and truncates the members — it does not touch `status.groups`.
- `stopGroup` itself does the right thing on the runtime: `group.ready = false`, a FRESH
  `readyPromise`, `promoted.delete(groupKey)`. So the in-process `client.groupReady(table)`, which
  awaits that promise, is correct — it goes pending again. Only the STATUS snapshot is stale.
- In the worker, `seenReadyGroups` is the dedup set for deriving `groupReady` broadcasts from the
  status snapshot, and it is never cleared either. After a revert the group is still in it, so when
  the re-activated group's catch-up lands, no new `groupReady` edge is broadcast.
- On the tab, `readyGroups` is likewise append-only, so `client.groupReady(table)` resolves
  immediately for the whole window in which the re-activated group is catching up — the exact window
  the method exists to cover. A tab attaching after the revert folds the same stale `true` out of
  `status.groups`.

So: in-process `groupReady` is right, `status.groups` is stale everywhere, and the worker-attached
`groupReady` inherits the staleness as a wrong answer rather than a stale field.

## The fix

- Clear the flag where the group is stopped: drop `status.groups[groupKey]` (or set it `false`) in
  the revert path, so the status snapshot means what it says.
- Clear the worker's `seenReadyGroups` entry for the group at the same moment, so the next catch-up
  re-broadcasts a `groupReady` edge.
- Give the tab a way to drop its `readyGroups` entry — the honest carrier is the status snapshot
  itself (a `groups` map whose absent/false entry is authoritative), not a new event.
- Its own tests: a revert-then-reactivate case in the in-process lazy-facade suite and in the worker
  bridge suite, asserting `groupReady` goes pending again in both modes.

## Not to be confused with

The started-state snapshot ADR-0059 added does NOT inherit this: it is recomputed from `isSynced` on
the worker's own client for every registry key, and `stopGroup` does reset what `isSynced` reads. A
reverted group reads `false` on the tab immediately (covered in `tests/unit/worker-one-shot-reads.test.ts`).
That is also why the fix above must not be attempted by reusing the snapshot — the two answer
different questions.

## Reopen trigger

A consumer awaiting `groupReady` across a revert, or any report of a hydration gate resolving
instantly over a relation that is still catching up. Until then this is a candidate: the destructive
half is correct, and only the readiness REPORTING is stale.
