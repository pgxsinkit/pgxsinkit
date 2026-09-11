# 0018 — The subscribe route answers 503 and drops the engine's reason

Status: candidate (recorded 2026-09-11)
Opened: 2026-09-11 · Area: `packages/server/src/circuits/subscribe.ts` (`createSubscribeHandler`,
the `catch` around `subscribeToShapes`), `packages/server/src/circuits/engine-client.ts`
(`CircuitsEngineError`)
Reopen trigger: the next time an operator has to explain a wall of `/sync/v1/subscribe → 503` from
request logs alone — or the first time a host asks for a server-side logging seam.

## The fact

- When the engine refuses a shape registration, `createCircuitsEngineClient` throws a
  `CircuitsEngineError` that carries the engine's **status and response body** (for example
  `400 {"error":"unknown table 'public.competency_association'"}`).
- The subscribe route catches it and answers `503 {"error":"sync engine unavailable"}` — the right
  status for the client (a 503 is retried; a denial would truncate the client's scope and drop rows,
  see the comment at the `catch`), but the status and body are discarded on the way. Nothing is
  logged, and the server exposes no logging/`onError` seam a host could plug into.
- So a permanent misconfiguration reads exactly like a transient outage. On the emergent dev cluster
  (2026-09-11) the engine's replicated-table list had drifted from the sync registry; one untracked
  table (`competency_association`, behind `langListMembershipZh`) made every language subscribe
  batch 503 once a second for over an hour. The host's request log showed only
  `POST /sync/v1/subscribe -> 503`; the client showed "0 of 8 ready"; the engine logged nothing
  (see electric-circuits backlog 0001). Finding the cause meant deriving the registry's table list
  by hand and diffing it against the engine's `/tables`.

## The fix

- Log the dropped reason at the `catch`: status, body and the shape keys of the batch, through a
  host-provided logger (an `onError`/`logger` option on `createSyncServer`, defaulting to
  `console.error`), so a 503 is never silent server-side. The wire response stays as it is — the
  client must keep retrying, not learn the engine's internals.
- Consider distinguishing "engine unreachable" (network failure) from "engine refused" (4xx) in the
  log line, since the second never heals by itself.

## Reopen trigger

Any repeat of a silent 503 storm, or a host asking where to see why subscribes fail. Until then this
is a candidate: the client-facing behaviour is correct, only the operator's view is missing.
