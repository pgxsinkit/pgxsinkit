# Queue-shaped event ingestion as a first-class lane

Status: accepted (2026-08-01)

## Context

Consumers produce high-volume, append-only client events — thousands per session of token
encounters, aid interactions, review grades. These are queue-shaped, not sync-state-shaped, and
carrying them on sync tables is wrong in three compounding ways: nothing ever reads them back down
(other devices need derived state, never the raw log — yet a sync table makes every client
re-download its own events as shape rows); they never update and never conflict (LWW, conflict
policy, overlay views, and per-row apply are pure cost); and sync-table residence creates a
retention lifecycle (trim windows, forwarder/consumer ordering) that exists only because of the
transport choice.

The toolkit therefore gains a second lane beside the sync rail: a local-only Outbox flushed in
batches to an ingestion endpoint, delivered through a queue to an app-provided consumer callback.
pgxsinkit owns everything between `appendEvent()` on the client and the callback invocation on the
server. The maintainer ratified the requirements and the delivery-semantics contract
(2026-08-01); this ADR records the design decisions inside that contract, as amended by review.

## Decision

1. **Registration lives on the registry.** `SyncRegistryDefinition` gains a `streams` key (entries
   via `defineEventStream`): the Event-stream name, a strict zod payload schema, and the declarative
   claims→identity stamping rule — the entry names the identity FIELDS and the claim path each is
   stamped from (claimPath-style, like managed fields); identity is SERVER-stamped from verified
   claims, never client-trusted. `defineEventStream` validates the Event-stream name at module
   eval: lowercase `[a-z0-9_]`, at most 30 characters — the pgmq queue-name limit is 47 and the
   `pgxsinkit_events_` prefix consumes 17, and a bad name must fail at definition, never at
   deployment DDL. The registry's discipline holds: declarative data only, no functions — the
   gating hook (consent/entitlement refusal before enqueue) is a function on
   `CreateSyncServerOptions`, keyed by Event-stream name. `createSyncServer` auto-mounts the
   ingestion route when streams are present. Streams follow the `rowClasses` precedent exactly: a
   sibling in the lock/diff (new Event stream → `compatible`, removed → `breaking`, payload-schema
   change → `risky`) and OUT of the canonical fingerprint — streams touch no synced table, no
   local schema, and no apply function, so registering one must not wipe any store's read cache.
   **Schema evolution is compatibility-bound**: a stream's payload schema may evolve only
   backward-compatibly (it must keep accepting every previously-valid payload — events written
   offline under the old schema are still in flight); an incompatible change requires a NEW
   Event-stream name. In-band payload versioning stays the consumers' practice; this rule is what
   makes it safe rather than customary.

2. **One shared Outbox, library-owned, public shape.** The client Outbox is a single local-only
   table with a `stream` column — never in the sync registry, never replicated; the library owns
   its DDL beside the elected engine, and its shape is stream-independent (adding an Event stream
   changes nothing locally). Its shape is public contract, because apps may compose pending rows
   with down-synced aggregates into best-guess views. Every row carries a durable, monotonically
   increasing local `seq` (the append ordinal): UUIDs do not order, `occurredAtUs` collides at
   exactly the volumes motivating this feature, and SQL row order is undefined — `seq` is the ONE
   ordering key for Outbox selection and batch assembly. It is local machinery, never transmitted.
   `appendEvent(stream, payload)` validates against the registered zod schema AT APPEND and throws
   — a malformed payload is a call-site bug, and the invariant "everything in the Outbox is
   well-formed" is what the flush loop and best-guess views lean on; the append also enforces the
   contracts-level payload size cap (decision 3) at the call site. The library stamps `eventId`
   (uuid) and `occurredAtUs`; the append resolves on durable local enqueue under the store's
   declared durability. Two observation surfaces, on both client forms: the drain signal
   `onOutboxStatus(cb)` — `{ empty }`, fired on empty ↔ non-empty transitions with current state
   delivered on subscribe (no count: a count that updates only on transitions is stale by
   construction, and a count that updates per append is a worse live query — richer detail is a
   query against the Outbox table); and the verdict/report surface `onEventLaneReport(cb)` — per
   flush outcome, carrying terminal verdicts (`eventId`, Event stream, status, reason) and
   backoff-state transitions, as an ephemeral subscription with a warn-level default log (the
   `onDeadLetter` idiom), because once a terminal row is deleted the Outbox cannot answer "what
   happened to it".

3. **The flush endpoint is the mutation endpoint's sibling, minus what events don't need.**
   `POST /api/events`, strict zod `{ events: EventEnvelope[] }`,
   `EventEnvelope = { stream, eventId, occurredAtUs, payload }` — no seq (a batch's internal order
   is its array order; the local ordinal stays local), no base version (nothing to conflict with).
   Same auth-header and refresh-once idiom as the mutation client. Verdicts are layered:
   - **Malformed framing is batch-level.** A request that fails the strict envelope parse (or
     exceeds the request-shape limits below) gets a batch 400/413 — a malformed item without a
     parseable `eventId` cannot receive a per-event verdict. This layer is unreachable through the
     library (appends are validated, envelopes are library-built); it exists for library bugs and
     non-library callers, and matches the mutation path.
   - **Well-formed envelopes get per-event verdicts:**
     `{ acks: [{ eventId, status: acked | refused | rejected | deferred, reason? }] }`.
     `acked` (enqueued), `refused` (gating), and `rejected` (schema-invalid payload for a KNOWN
     stream, or an oversized payload) are TERMINAL: the client deletes all three from the Outbox,
     surfacing the latter two via `onEventLaneReport`. Given append-time validation and the
     compatibility rule in decision 1, `rejected` in practice means a non-library caller or a
     broken consumer deployment — a bug, not a rollout. `deferred` is NOT terminal: an Event
     stream the server does not (yet) know is ordinary deployment skew — a client rolled out ahead
     of its server — and deleting those events would be data loss on a normal path. Deferred rows
     stay in the Outbox, retry with backoff, surface in the report, and drain when the rollout
     completes.
   - **Request-shape limits are toolkit constants in `@pgxsinkit/contracts`** (max events per
     batch, max serialized payload bytes per event, max request body): the client flush loop
     clamps its batching to them, and the server enforces them independently of any client tuning
     — batch-count/body violations → 413 (reachable only under skew or foreign callers), a single
     oversized payload → per-event `rejected` (also enforced at `appendEvent`, so the library
     client fails at the call site).

4. **Backpressure is honest: the Outbox is the buffer.** When the queue is unavailable the endpoint
   returns 503 + `Retry-After` and enqueues NOTHING — a batch is enqueued atomically or the request
   fails retryably; the server never buffers on the queue's behalf (that would be a second, worse
   outbox). The client flush loop has exactly two retry classes: retryable (network, 5xx,
   408/425/429 — jittered exponential backoff with a ceiling, honoring `Retry-After`, pausing
   offline) and auth (refresh once, then retryable). There is NO attempt cap and NO client-side
   quarantine: terminal verdicts are exclusively per-event and server-issued, so the client never
   unilaterally discards an event — that is what at-least-once means on this edge. The mutation
   path's quarantine exists for user-authored writes needing human inspection; the Outbox instead
   keeps absorbing appends (it is designed to hold offline weeks) while a failing batch backs off
   at the ceiling, observably.

5. **Queue: narrow interface, pgmq built-in, one queue per Event stream, message = sub-batch.** The
   queue interface (enqueue batch / consume with visibility timeout / ack / dead-letter +
   enumerate/requeue) lives in `@pgxsinkit/server`; pgmq is the shipped backend (Postgres-native,
   no new infrastructure in the supabase-ecosystem stacks consumers run). One queue per Event
   stream (`pgxsinkit_events_<stream>`): a poison event or slow consumer in one Event stream must
   not head-of-line-block another, and each stream's consumer gets independent concurrency,
   backoff, and dead-letter attribution. The endpoint splits a mixed flush batch by Event stream,
   preserving array order, and enqueues each single-stream sub-batch as ONE message — one
   visibility timeout, one ack, one consumer transaction per sub-batch. **The queued message is
   the stamped, server-produced envelope**: per event
   `{ eventId, occurredAtUs, identity, payload }`, where `identity` is the record of claim-derived
   fields the stream's registration declares — stamped at ingest from verified claims, carried
   through the queue, and delivered to the callback as-is; this envelope is the security-sensitive
   interface, so its shape is contracts-defined, not implementation-defined. Queue provisioning is
   deploy-time: `pgxsinkit-generate` emits the event-lane DDL (extension + per-stream queues
   derived from the registry), never runtime create-if-missing — the endpoint may enqueue long
   before any runner first starts.

6. **Delivery contract: at-least-once, batch-internal order ONLY.** The consumer callback MUST be
   idempotent; the blessed (documented, not enforced) pattern is dedupe on `eventId` against the
   app's own durable store, giving effectively-exactly-once composition. Within one delivered
   batch, events arrive in append order. Across batches there is NO promise — a retried sub-batch
   is redelivered after its successors, and concurrency processes sub-batches in parallel.
   Happy-path FIFO is behavior, not contract: promising inter-batch order would force
   concurrency = 1 and block-the-stream-on-retry, the head-of-line blocking at-least-once queues
   exist to avoid. Consumers needing temporal order re-sort from their own archive on
   `occurredAtUs` — the replay-is-an-archive-scan pattern already assumes this.

7. **Consumer runner: the library defines, the app hosts.** `defineEventConsumer({ registry,
   streams, callback, …tuning })` in `@pgxsinkit/server` returns a `start()`/`stop()` handle the
   app runs in its own long-lived Bun process — the toolkit's first long-lived server artifact,
   deliberately separate from `createSyncServer`'s zero-startup-query serverless posture; no
   supervisor, no CLI entrypoint, no daemon. One runner hosts multiple Event streams (each an
   internal loop), so small deployments run one process and large ones split streams across
   processes. Pacing, visibility renewal, and retry/backoff are INTERNAL — out of consumer-app
   design space by ratified requirement. The pacing mechanism is **adaptive interval polling**:
   after a non-empty read the stream's loop reads again immediately (a backlog drains
   back-to-back), and consecutive empty reads grow the wait from a floor (~250 ms) toward an idle
   ceiling (~5–10 s; floor/ceiling are tuning defaults, not contract). LISTEN/NOTIFY is REJECTED
   as the wake mechanism (maintainer decision, 2026-08-01): Bun's native `SQL` — the sanctioned
   Postgres driver — has no LISTEN/NOTIFY support, and the consumers' supabase-ecosystem stacks
   sit behind transaction poolers, the environment where a held listening connection is exactly
   what is not available. Because pacing is internal, the mechanism may evolve later without any
   contract change. The callback receives
   the stamped envelopes of decision 5; return acks; throw retries with backoff; after N attempts
   the sub-batch dead-letters into pgmq's native per-queue archive (no library-owned DLQ table —
   the archive is already durable, per-stream, and SQL-queryable), and loudness comes from the
   runner: an `onDeadLetter` hook plus a warn-level log even when the app wires nothing. Requeue
   from the archive is a deliberate act via the interface, never automatic. Trade-off, accepted:
   dead-letter STORAGE is backend-defined; the interface, not the storage, is the contract, and v1
   ships one backend.

8. **The Outbox in the store lifecycle.** The Outbox is durable library-owned state, so every
   lifecycle surface takes a position. Store backup includes it (a backup is the whole store);
   Diagnostic dump includes it (evidence); Data export excludes it (synced tables only, by
   definition). Restore is the deliberate asymmetry with the Mutation journal, stated loudly:
   **restored Outbox rows are NOT quarantined** — they resume flushing normally, because event
   delivery is idempotent end-to-end (the `eventId` dedupe is the design), which mutation replay
   is not. `dropReadCache` never touches the Outbox (it is not read cache). Non-forced `destroy()`
   refuses while the Outbox is non-empty — exactly as it refuses on owed mutations, upholding
   "never discard without a server verdict" — with forced destruction remaining the explicit
   escape hatch.

9. **The Board demo drives the lane.** The Board gains a minimal Event stream
   (`board_issue_viewed`): registered in `boardSyncRegistry`, appended from the UI, consumed by a
   trivial runner into a small archive table. The exerciser role demands it — an event lane the
   demo doesn't drive would be the first toolkit surface with no exerciser — and the browser e2e
   lane (Outbox durability across reload, flush against a real endpoint) falls out of it. Unit
   lanes cover outbox/flush/dedupe semantics; the container lane (testcontainers/Podman) covers
   pgmq end-to-end (enqueue → consume → ack → dead-letter). Skills move with the feature:
   `registry-authoring` gains stream registration, `server/deploying` gains the runner process and
   pgmq prerequisites, `client/operating` gains Outbox observability.

## Non-goals

Not a general pub/sub (one registered consumer side per Event stream, no fan-out subscriptions).
Not a replacement for the mutation path (events are fire-and-forget facts; writes needing conflict
resolution, optimistic overlay, or echo stay on the write path). No ordering promises beyond
batch-internal. No sub-batch bisection on poison (a poison event dead-letters its sub-batch
intact; documented future refinement). No server-side buffering when the queue is down.

## Consequences

- Flush-policy tuning (batch caps, intervals, per-stream overrides) is client-level engine config
  (`defineSyncWorker` / `createSyncClient`), NOT registry: the registry is the contract, cadence is
  deployment tuning, and a batch-size tweak must not surface as a registry diff. Client batching
  is additionally clamped by the contracts-level request-shape limits.
- pgmq becomes a dependency of the event lane's server side — extension enablement and queue DDL
  join the migration story via `pgxsinkit-generate`.
- The verdict contract is skew-safe in both directions: a client ahead of its server parks
  unknown-stream events as `deferred` (no data loss on rollout), and a server ahead of its client
  keeps accepting old payloads by the backward-compatibility rule. Terminal deletion (`refused`,
  `rejected`) happens only on a server verdict, surfaced via `onEventLaneReport`.
- The vocabulary grows: **Outbox** (canonical for the event staging table — the Mutation journal's
  informal "outbox" alias is retired to a hard Avoid) and **Event stream** (bare "stream" only as
  an API field name). See CONTEXT.md.
- New surface to maintain: one registry key + helper, the Outbox DDL + flush loop + two
  observation surfaces, one endpoint, one queue interface + backend, one runner, one demo stream,
  lifecycle positions in backup/restore/destroy, three skill updates.

## Considered and rejected

- **Sync tables as the transport.** The motivating rejection: every client re-downloads its own
  events, conflict machinery taxes rows that never conflict, and retention lifecycles exist only
  because of the transport. Queue-shaped data gets a queue.
- **A parallel `defineEventStreams` beside the registry.** Rejected: a second contract artifact, a
  second lock mechanism to satisfy the diff gate, and a second import threaded through both
  `createSyncServer` and `defineSyncWorker` — for vocabulary purity the `streams` key preserves
  anyway.
- **Per-stream Outbox tables.** Rejected: batch assembly across streams becomes the UNION-ALL merge
  the mutation journal is forced into by per-table journals; nothing forces it here, and one table
  keeps the drain signal one count and the DDL stream-independent.
- **Batch-level 400 on an invalid event (the mutation path's shape).** Rejected for well-formed
  envelopes: a malformed event can never succeed on retry, so a batch fault would wedge the whole
  Outbox behind one row. The batch layer remains only for unparseable framing, where no per-event
  verdict is addressable.
- **Terminal rejection of unknown Event streams.** Rejected on review: a client deployed ahead of
  its server is ordinary rollout skew, not a bug, and deleting its events is data loss on a normal
  path — hence the non-terminal `deferred` verdict.
- **A wire-level schema version on `EventEnvelope`.** Rejected: the enforced
  backward-compatibility rule plus new-name-for-incompatible-change covers evolution without a
  second versioning axis; consumers keep their in-band payload versions.
- **Client-side attempt cap / quarantine.** Rejected: at-least-once on this edge means the client
  never discards without a server verdict; quarantine exists for user-authored writes a human must
  inspect, which events are not.
- **Inter-batch FIFO as contract.** Rejected: it forces concurrency = 1 and contractual
  head-of-line blocking; consumers re-sort from their archive instead.
- **A `pendingCount` on the drain signal (or per-change emission).** Rejected on review: a count
  updated only on empty↔non-empty transitions is stale by construction, and per-change emission is
  a worse live query — the signal is `{ empty }`, counts come from the Outbox table.
- **A durable client-side verdict table.** Rejected: retention-bearing state for a debugging need;
  the `onEventLaneReport` subscription plus default warn logging surfaces verdicts without new
  owned state.
- **A library-owned DLQ table.** Rejected: it would duplicate pgmq's archive and become the
  toolkit's second server-side owned state table for no interface gain.
- **Runtime queue create-if-missing.** Rejected: the endpoint may enqueue before any runner exists,
  and deploy-time DDL is the repo's established posture (ADR-0030's direction of travel).
- **LISTEN/NOTIFY (or `pgmq.read_with_poll` long-polling) as the runner's wake mechanism.**
  Rejected: LISTEN/NOTIFY is unimplementable on Bun's native `SQL` without a second Postgres
  driver dependency, and both mechanisms hold a connection per stream — through the transaction
  poolers the consumers' stacks run, that pins a server connection continuously, which adaptive
  polling's short statements deliberately avoid. Pacing is internal, so this can be revisited
  without contract change if the constraints move.

## Amendment (2026-08-02): serverless drain hosting

Decision 7 hosts the consumer in a long-lived process the app runs. Managed Supabase — the
supabase-ecosystem deployment the lane was designed for — has nowhere to put one: the board's cloud
deploy ships edge functions and nothing else, so its queues are stamped, enqueued, and never drained.
Ratified fix, and it is a HOSTING addition, not a contract change: decision 7 already puts pacing out
of consumer-app design space ("the mechanism may evolve later without any contract change"), and this
adds a second way to CALL the same runner, not a second way to deliver.

- **The runner gains a bounded-drain invocation mode.** The same `defineEventConsumer` handle answers
  `drainOnce({ budgetMs })`: one pass that reads → delivers → acks across every configured Event
  stream until they all read empty or the wall-clock budget is spent, returning
  `{ delivered, deadLettered, empty }`. It is the SAME internals throughout — read/deliver/ack, lease
  renewal, retry by lapsing lease, dead-lettering with the `onDeadLetter` hook and the unconditional
  warn — so the delivery contract of decision 6 is untouched: at-least-once, batch-internal order
  only, the pgmq archive as dead-letter storage. The budget is checked BETWEEN sub-batches and never
  inside a callback: an in-flight callback is awaited and acked exactly as the runner would (its lease
  stays renewed), so a pass may overrun its budget by one callback, and a sub-batch whose callback
  throws near the edge simply redelivers next pass. `empty: false` is the caller's signal that work
  remains. One handle drives ONE pacing mode: `drainOnce` beside a live `start()`, beside another
  pass, or after `stop()`, throws. Two PROCESSES draining concurrently is safe and supported — the
  visibility timeout arbitrates them exactly as it arbitrates two long-lived runners.
- **A scheduled invocation is the delivery guarantee; an ingest-side nudge is only latency.** The
  serverless deployment wires a platform cron (the board: Supabase Cron → `pg_net` → the function,
  every 10 s) as the sweep, and optionally the new `createSyncServer({ onEventsEnqueued })` hook —
  fired after a successful enqueue with the request's deduplicated Event-stream names, fire-and-forget
  — to poke the drain endpoint so an interactive append archives in milliseconds. The hook is
  deployment-agnostic by design (the library owns no transport): its throw is caught and warn-logged,
  and a lost nudge costs latency only, because the sweep still runs.
- **The long-lived runner remains the PRIMARY mode**, and the local/demo one. `drainOnce` exists for
  hosts that cannot hold a process; nothing about a Bun/Deno deployment should change.
- **The board grows a third edge function** (`board-events-drain`, `verify_jwt = false`, gated by a
  constant-time compare of a shared-secret header — its callers are machines with no GoTrue session),
  the cron schedule, and the nudge on `board-write`. The cron/`pg_net` SQL is deploy tooling with
  host-specific values (project URL, secret), so it lives in the cloud deploy script, never in a
  committed migration.

Rejected on the way: a second runner artifact for serverless (the delivery semantics would then have
two implementations to keep honest); making the nudge the delivery mechanism (an unreliable transport
cannot be a guarantee); LISTEN/NOTIFY, again and for the same reasons.
