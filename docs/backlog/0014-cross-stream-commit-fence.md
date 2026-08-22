# 0014 — A cross-stream commit fence (live cross-shape atomicity, not just aligned)

Status: candidate (recorded 2026-08-22)
Opened: 2026-08-22 · Area: the pgxsinkit `electric-circuits` fork (`apps/engine/src/engine/output.rs`,
the incremental-maintenance emission path), `packages/client/src/circuits/stream-inbox.ts`
(`isGroupUpToDate`), `packages/client/src/circuits/sync-engine.ts` (the commit gate)
Reopen trigger: a consumer observes a live half-applied cross-table transaction in practice, or
upstream/fork work on LSN stamping lands.

## The fact

A consistency group's commit gate is "every shape's most recent response asserted up-to-date"
(ADR-0056 decision 5). In **steady state** that predicate is effectively always true, so a delivery
commits at once — including a delivery that carries only one half of a server transaction that
touched two of the group's tables.

The mechanism is the long poll. Once a group has caught up, every one of its K streams has an
outstanding long-poll request in flight, and every one of them **last completed** with
`stream-up-to-date` set — a `204` timeout carries that header, so a quiet shape re-asserts freshness
each cycle. The client's per-shape "currently up-to-date" flags are therefore all latched true, and
they stay true while the requests are parked: nothing on the wire retracts an up-to-date report, and
nothing could, because a stream that has new bytes for the client answers with them rather than
announcing in advance that it is about to.

So a server transaction writing to tables A and B produces two independent appends, answered by two
independent long-polls. A's response returns, the gate reads "every shape up-to-date" — B's flag is
still the latched `true` from B's previous cycle — and A's half commits. B's half commits on its own
response. The exposure is the **inter-arrival gap** between the two responses, which in a healthy
deployment is milliseconds.

## What is and is not guaranteed

- **Guaranteed at boot and catch-up.** Alignment is the real happens-before: every shape has reported
  drained at least once, the engine's convergence barrier is read _after_ those reports, and
  everything held commits in one transaction. A boot never presents a torn cross-shape state.
- **Guaranteed whenever both halves land before the gate evaluates.** Anything buffered when a commit
  runs goes in that commit; a group that is mid-catch-up (any shape reporting not-up-to-date) holds
  everything until all of them drain.
- **Not guaranteed live.** Between two steady-state deliveries a reader can observe A's half applied
  and B's not. The registry's `consistencyGroup` therefore buys a single applied transaction per
  commit and an atomic aligned frontier — not a serialization point that server transactions are
  guaranteed to cross whole.

## Why this is not fixed client-side

Two client-only closures exist, and neither is airtight:

1. **Wait for each sibling's next report before committing.** Turns the latched flag into a fresh one
   by requiring a round trip from every stream. The cost is up to one **long-poll timeout per commit**
   — a single-table change would sit undelivered for the full poll window whenever its siblings happen
   to be quiet, which is most of the time. That trades a millisecond window for a multi-second one on
   the common path.
2. **Nudge the siblings** — cancel and re-issue their long polls on every delivery, then commit when
   they answer. Narrows the window to a re-poll round trip and costs K requests per delivery, but it
   **cannot close it**: the engine's per-stream appends carry no cross-stream fence, so a sibling
   answering "nothing for you" is not evidence that its half of the transaction was never coming. It
   is only evidence that it had not been appended yet.

The gap is in the substrate, not in the client's arithmetic. Papering it with either option would buy
a worse steady state and still not be able to state the guarantee.

## The engine-side shape

The airtight form is the one ADR-0056's alternatives already name as _"the in-band answer, and the
eventual right one to take upstream"_: stamp the commit position throughout the emission path and add
a heartbeat envelope carrying the replication head. With those, a client can hold a delivery until
every stream in the group has reported past the transaction's position, which is a real fence rather
than an inference from silence. A per-transaction fence — the engine naming, on each stream, the set
of streams a transaction also touched — would do the same job with less bookkeeping on the client.

ADR-0056 rejected it _for now_ for reasons that still stand: it is engine-core work in the
incremental-maintenance emission path, where a mistake corrupts ordering silently rather than failing
loudly, and the correct position for a **deferred** flip emission — propagated out of commit order by
design — is a genuine open question. Both are answerable in the fork, and the fork is where the work
would land.

## Why it is a candidate rather than a plan

The window is bounded by two responses' inter-arrival, it is closed entirely at boot and catch-up, and
the applications built on this so far render from a single group's tables in one frame per commit
rather than diffing across commits. Nobody has observed a torn read. Taking engine-core emission work
before that changes would be paying the highest-risk price in the stack for a hazard measured in
milliseconds — so it is documented as a limitation (ADR-0056 decision 5, and the public
operating-in-production prose) rather than hidden behind a claim the design does not support.
