---
title: The event lane
description: A second lane beside the sync rail for high-volume, append-only client facts — appendEvent, the Outbox, the ingestion endpoint, a queue, and your consumer callback.
sidebar:
  order: 11
---

Some client data is not sync state at all. Token encounters, aid interactions, review grades, "the user
opened this item" — thousands per session, append-only, never edited, never conflicting, and **nothing ever
reads them back down**. Putting them on a synced table is wrong in three compounding ways: every client
re-downloads its own log as shape rows, the conflict/overlay/versioning machinery taxes rows that can never
conflict, and you inherit a retention lifecycle (trim windows, forwarder ordering) that exists only because
of the transport choice.

Queue-shaped data gets a queue. The **event lane** is the toolkit's second lane, beside the sync rail:

```
appendEvent()  →  Outbox (local)  →  flush  →  POST /api/events  →  queue  →  your consumer callback
```

pgxsinkit owns everything between the append on the client and the callback on the server. It is **not** a
replacement for the write path — a change needing conflict resolution, an optimistic overlay, or an echo
back down stays on [the write path](/concepts/write-path/). Nor is it general pub/sub: one registered
consumer side per event stream, no fan-out subscriptions.

## Registering an event stream

An **event stream** is a named, registered category of events sharing one payload schema and one
consumer-side handling. It is registered on the sync registry you already have — the record key is the
stream name:

```ts
import { defineEventStream, defineSyncRegistry } from "@pgxsinkit/contracts";
import { z } from "zod";

export const registry = defineSyncRegistry({
  tables: { issue },
  streams: {
    issue_viewed: defineEventStream({
      payload: z.object({ issueId: z.uuid() }).strict(),
      identity: { viewerId: { claimPath: ["sub"] } },
    }),
  },
});
```

Three things to know before you write one:

- **Identity is stamped by the server, from verified claims.** `claimPath` is the same addressing managed
  fields use (`["sub"]`, `["app_metadata", "person_id"]`). The client's envelope carries no identity at all,
  so put a viewer or actor id in `identity`, never in the payload — a payload is client-supplied and can lie.
- **Names are validated when the module evaluates**: lowercase `[a-z][a-z0-9_]*`, at most 30 characters. The
  bound comes from the queue name the stream is provisioned under, and it fails at definition rather than at
  deployment.
- **An object payload must be strict, and that is enforced.** `.strict()` (or `z.strictObject()`) on the
  root — and on every object in a union — or `defineSyncRegistry` throws. A stripping `z.object({…})` would
  drop a misspelled or newly-added key silently somewhere between your call site and your consumer, with no
  verdict anywhere, which is exactly the failure the lane's validation exists to prevent. Any other root (a
  string, an array, a record, a transform pipeline) is accepted as written and follows ordinary parse
  semantics: what the schema accepts is what `appendEvent` validates, and the JSON-normalized form of what it
  produces is what your consumer receives.

### The schema validates at append; the authoritative parse is at ingest

`appendEvent` checks your payload against the registered schema and then stores **exactly what you passed**.
That client-side run is a **validation**: its output is discarded, so the Outbox reads back as the fact your
app staged. The **authoritative** parse happens server-side, at ingest, and the JSON-normalized form of _its_
output is what is enqueued and what your consumer receives. (Storing the client's parse output instead would
hand the server an already-transformed value to re-parse — a terminal rejection for a perfectly valid
append.)

The schema itself therefore **executes at both boundaries**, even though only one execution's output is ever
taken. Three consequences for a `.transform()`:

- **Transforms must be pure and deterministic.** Your callback runs once on the client and once on the
  server; only the server's result is kept, and nothing reconciles the two. An effectful transform (writing
  a log, incrementing a counter) or an environment-dependent one (reading `Date.now()`, a locale, a random
  value) is unsupported.
- **The output must be JSON.** A transform producing something the JSON value domain cannot carry — a
  `BigInt`, `undefined` — makes that one event a terminal `rejected` verdict at ingest. Its siblings in the
  same batch are unaffected.
- **Your consumer receives the JSON-normalized output, not the object the transform returned.** Ingest
  enqueues the JSON round-trip of the parse result, so a `.transform(v => new Date(v))` delivers that date's
  **ISO string**, and a nested `undefined` property is **dropped** (an `undefined` array member becomes
  `null`). Normalizing at the route is deliberate: every backend — the in-memory fake your unit tests use and
  the real `jsonb`-backed queue in production — then observes exactly the same value. If you want a rich type
  at the consumer, encode it in the payload and rebuild it there.

Registering a stream touches no synced table, no local schema and no apply function, so it never rebuilds a
client's read cache.

### Payload schemas may only evolve backward-compatibly

A stream's payload schema may change **only** in ways that keep accepting every previously-valid payload.
Events written offline under the old schema are still sitting in someone's Outbox, possibly for weeks. An
incompatible change requires a **new stream name**. In-band payload versioning stays your practice; this
rule is what makes it safe rather than customary.

The registry lock hashes each stream so a change shows up as a reviewable `risky` diff — but it hashes the
payload as a **JSON Schema**, and JSON Schema cannot express a zod refinement or transform. Two incompatible
`.refine()` thresholds therefore hash identically and the review gate never fires. That is what
`revision` is for: bump it (any positive integer) whenever you change acceptance logic the hash cannot see.

```ts
issue_viewed: defineEventStream({
  payload: z.object({ issueId: z.uuid() }).strict().refine(hasAccess),
  identity: { viewerId: { claimPath: ["sub"] } },
  revision: 2, // ← bumped with the refinement, so the lock diff surfaces it
});
```

It is the same obligation `rowFilter.revision` carries for a `customWhere` closure, for the same reason: a
hash can only see what it can serialize.

## The Outbox

`client.appendEvent(stream, payload)` validates the payload against the registered schema, stamps an
`eventId` and `occurredAtUs`, and writes one row to the **Outbox** — a single durable, local-only table
shared by every stream. It is never synced, never overlaid, never conflict-resolved.

```ts
await client.appendEvent("issue_viewed", { issueId });
```

The promise resolves on **durable local enqueue, not on delivery**. Appending never waits for the network,
and an append made offline survives a reload and drains when connectivity returns. Four failures are
possible, and all four are call-site bugs that throw synchronously rather than runtime conditions: no
streams registered, an unknown stream name, a payload the schema refuses, and an oversized payload.

The Outbox's shape is public contract, not an internal detail — get the typed table with
`getOutboxTable(registry)` — because apps legitimately compose pending events with down-synced aggregates
into best-guess views.

### Watching it drain

```ts
const stop = client.onOutboxStatus(({ empty }) => setPending(!empty));
```

`onOutboxStatus` fires on the empty ↔ non-empty **transitions**, delivering the current state on subscribe
(`await client.outboxStatus()` is the one-shot pull). It is the invalidation hook for those best-guess
views: when the Outbox drains, the down-synced aggregate is authoritative again. It carries no count on
purpose — a count that updates only on transitions is stale by construction, and a count that updates per
append is a worse live query than the one you can write yourself against the Outbox table.

## Flushing, and what the server says back

The flush loop assembles batches in append order across every stream and `POST`s them to `/api/events` —
the mutation endpoint's sibling, with the same auth-header and refresh-once behaviour. With an `autoSync`
trigger installed it drives itself (an append nudges a pass, an interval catches retries, and boot or
reconnect drains what was written offline); `client.flushEvents()` is the manual primitive for a host that
drives everything itself.

Every well-formed event comes back with its own verdict:

| Verdict    | Terminal? | What it means                                                            |
| ---------- | --------- | ------------------------------------------------------------------------ |
| `acked`    | yes       | Enqueued. The Outbox row is deleted.                                     |
| `refused`  | yes       | Your server-side gate declined it (consent, entitlement). Row deleted.   |
| `rejected` | yes       | Schema-invalid or oversized payload for a **known** stream. Row deleted. |
| `deferred` | **no**    | The server does not (yet) know this stream. The row stays and retries.   |

`deferred` is the one to understand. A client deployed ahead of its server is ordinary rollout skew, not a
bug — deleting those events would be data loss on a completely normal path. So they stay in the Outbox,
retry with backoff, and drain the moment the server deploy lands. A burst of `deferred` right after a client
release is the deploy order; a burst that never clears means the server's registry is missing that stream.

`rejected`, on the other hand, should be rare enough to treat as a defect: the library validates at append,
so a rejected event means a non-library caller or a broken deployment.

```ts
client.onEventLaneReport((report) => {
  for (const verdict of report.terminal) log.warn("event dropped", verdict);
});
```

`onEventLaneReport` carries each pass's terminal verdicts, its `deferred` ones, and the lane's batch-level
backoff transitions. `acked` is deliberately never reported — a high-volume lane would drown you in its own
success. The subscription is **ephemeral**: nothing is retained, because a durable verdict table would be
retention-bearing state for a debugging need, and with nothing subscribed the library logs each report at
warn level rather than dropping it. Subscribe for the app's lifetime, not per screen.

### Backpressure is honest: the Outbox is the buffer

When the queue is unavailable the endpoint returns `503` with `Retry-After` and enqueues **nothing** — a
batch is taken atomically or not at all, and the server never buffers on the queue's behalf. The client has
exactly two retry classes: retryable (network, 5xx, 408/425/429 — jittered exponential backoff with a
ceiling, honouring `Retry-After`, paused while offline) and auth (refresh once, then retryable).

There is **no attempt cap and no client-side quarantine**. A row leaves the Outbox only on a server-issued
verdict — that is what at-least-once means on this edge. The Outbox is designed to hold offline weeks, so a
failing lane presents as a growing Outbox backing off observably, never as silently discarded events.

## Consuming: the delivery contract

The endpoint splits a mixed batch by stream (preserving order), stamps each event's identity from the
verified claims, and enqueues each single-stream sub-batch as one queue message. Your callback receives
those stamped envelopes:

```ts
const consumer = defineEventConsumer({
  registry,
  queue: createPgmqEventQueue({ db }),
  callback: async ({ stream, events }) => {
    await db.transaction(async (tx) => {
      await tx.insert(viewArchive).values(events.map(toRow)).onConflictDoNothing({ target: viewArchive.eventId });
    });
  },
});
consumer.start();
```

Three properties are the whole contract:

1. **At-least-once.** Your callback **must** be idempotent. The blessed pattern is deduping on `eventId`
   against your own durable store, which composes at-least-once delivery into effectively-exactly-once
   handling. Returning acks the sub-batch; throwing retries it.
2. **Order is batch-internal only.** Events arrive in append order _within_ one delivered sub-batch. Across
   sub-batches there is no promise: a retried sub-batch is redelivered after its successors, and concurrency
   processes sub-batches in parallel. Promising inter-batch order would force concurrency of one and
   block-the-stream-on-retry — the head-of-line blocking at-least-once queues exist to avoid. If you need
   temporal order, re-sort from your own archive on `occurredAtUs`.
3. **Identity is what the server stamped**, carried through the queue untouched. This is the point where a
   client-supplied event becomes an attributed fact, which is why its shape is contract-defined.

The runner is a **long-lived process** you host — deliberately separate from the server's serverless posture,
so do not deploy it as a per-request function. Pacing, visibility renewal and retry are internal to it: while
it is working through a read it renews the lease on every message of that read (the one in flight and the
ones queued behind it), so `visibilityTimeoutSeconds` is not a budget for the whole batch. It is the
**redelivery delay of a sub-batch whose callback threw** — a throw stops the renewals immediately and the
lapse is the retry pacing — and the bound on how long a crashed runner's messages stay stuck. Size it above
one callback's worst case, not the batch's. One runner can host many streams (each an independent loop), so
small deployments run one process and large ones split streams across processes. After a configurable number of attempts a sub-batch dead-letters into the
backend's own archive, with a hook plus an unconditional warning so it is never silent. Requeueing from the
archive is always a deliberate act.

Where you have no process to host — a managed backend whose only compute is per-request functions — the same
handle answers a **bounded drain** instead: `drainOnce({ budgetMs })` makes one pass across every stream
until they all read empty or the budget is spent, and reports `{ delivered, deadLettered, empty }`. Nothing
about the contract above changes; it is the same internals called differently, which is possible precisely
because pacing was never contract. Host it as a **scheduled invocation** (that schedule is the delivery
guarantee) and, optionally, nudge it from ingest with `createSyncServer({ onEventsEnqueued })` so an
interactive append drains at once rather than at the next tick — a fire-and-forget hook whose loss costs
latency only. Overlapping invocations are safe: the visibility timeout arbitrates concurrent drainers the
same way it arbitrates concurrent runners. The long-lived runner stays the primary mode wherever one can run.

Operationally there are two prerequisites, both covered in
[Deploying the server](/start/deploying-the-server/): the queues are **deploy-time DDL** (the endpoint may
enqueue long before any runner first starts), and the ingestion route mounts itself once your registry
declares streams.

## Limits

Toolkit-level constants, enforced by the server independently of any client tuning, and clamped by the
client's own batching:

- **1000 events** per flush batch,
- **64 KiB** serialized payload per event — events are facts, not documents; a payload near this is a
  modelling smell,
- **4 MiB** per request body.

A batch-count or body violation is a `413`; a single oversized payload is a per-event `rejected` (and
`appendEvent` refuses it at the call site, so a library caller fails long before that).

## The Outbox in the store lifecycle

The Outbox is durable, library-owned state, so every lifecycle surface takes a position on it:

- **`destroy()` refuses** while the Outbox is non-empty, exactly as it refuses on owed mutations. The
  refusal names which of the two blocked it; `{ force: true }` remains the escape hatch.
- **`dropReadCache()` never touches it** — it is not read cache.
- **Backups and diagnostic dumps include it**; the portable data export (synced tables only) excludes it.
- **A restore does NOT quarantine restored Outbox rows** — the deliberate asymmetry with the mutation
  journal, which does. Restored events resume flushing normally, because event delivery is idempotent
  end-to-end by design, and mutation replay is not.

The full rationale, and the alternatives that were rejected, are in ADR-0053 (see
[Design decisions](/decisions/)).
