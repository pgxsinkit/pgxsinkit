# Pessimistic write-units: server-authoritative writes via flush-routing

Status: accepted (2026-06-28)

The companion driver to [ADR-0021](0021-lazy-ephemeral-sync-lifecycle.md). Some writes must be
**server-authoritative**: the client cannot optimistically grant itself the outcome, because the invariant
is a server-side rule the client cannot evaluate — a capacity/quota limit ("seats ≤ N", "max posts per
group per day"), a uniqueness or licensing gate. For these, the authoritative answer (accepted, or
rejected-because-full) must come from the server **before** the UI shows success.

pgxsinkit's default write path is optimistic: a mutation enters the local journal with an optimistic
overlay, the UI updates immediately, and the convergence loop flushes the journal as one **all-or-nothing
batch** to `pgxsinkit_apply_mutations`; the canonical row returns via the sync echo and clears the overlay.

Grounding "pessimism is just a policy" against the code splits it into two very different halves:

- **The gating half is already free.** The journal state machine
  (`pending → sending → acked | failed | quarantined | conflicted`, per-entity `latestMutationStatus`,
  overlay kinds, `acked` cleared by reconciliation against the **synced echo**) already expresses "do not
  render as done until the server confirms".
- **The rejection half is not free.** The apply batch is **one transaction with no per-statement
  savepoint**; a constraint/trigger rejection — the realistic way capacity is enforced — raises a hard SQL
  exception that **aborts the whole batch**, taking unrelated mutations down with it (they land in
  `failed`/`quarantined`, never a clean per-mutation rejection). [ADR-0015](0015-stale-write-conflict-policy.md)'s
  `reject-if-stale` *does* produce a clean per-mutation soft rejection — but only for **staleness**, which
  it detects by a *pre-check* (a Server-version compare that excludes stale rows from the DML); it does not
  catch a constraint failure. So pessimism is **the next conflict policy in the ADR-0015 lineage**, not a
  free toggle on the existing path.

## Decision

1. **Write-mode (`optimistic` default | `pessimistic`) is a property of an atomic *write-unit*, not a
   table.** A write-unit is a set of co-committed mutations; a unit is **uniformly one mode**. Per-table
   mode is rejected — it over-constrains satellites: a `post_user` written alongside a quota-gated `post`
   would become *globally* pessimistic, wrongly constraining every other flow that writes it.

2. **A write-unit's membership comes from one of two declaration sites:**
   - **Static (default): the consistency group.** A pessimistic consistency group *is* a standing atomic
     write-unit. Because the consistency group is the transaction boundary (one transaction → one LSN →
     one read frame), a static pessimistic group earns write-atomicity **and** read-atomicity from a single
     declaration. The strong, principled default for stable clusters that always move together.
   - **Dynamic (override): an imperative `transaction({ mode })` block.** At authoring time it tags an
     ad-hoc set of mutations with a shared unit id and mode, regardless of their tables' static groups —
     for "this table is optimistic in general but must commit pessimistically *here*". It is the choice
     that **cannot be wrong under uncertainty** (you need not know whether a satellite is ever written
     alone): scope pessimism to the *operation*, and *promote* a confirmed-stable cluster to a static group
     later. Its only cost: an ad-hoc unit spanning *different* static groups keeps write-atomicity but
     loses cross-table **read**-atomicity (the rows arrive via separate shapes — briefly tearable), because
     read-atomicity is a property of the shared shape stream.

3. **A pessimistic unit flush-routes to an authoritative endpoint** (mechanism below) that applies it in
   its **own isolated, serialised transaction** and returns a **per-mutation** result: accepted (the
   canonical row, which also returns via the normal sync echo) or rejected-with-typed-reason. The optimistic
   batch path is untouched and cannot be aborted by a pessimistic rejection.

4. **A new overlay disposition: auto-discard-on-reject.** Distinct from `conflicted` (overlay KEPT, resolve
   as a new write) and `quarantined` (structural, surfaced as diagnostics): a business rejection
   auto-rolls-back the optimistic overlay **for the whole unit** and surfaces the typed reason ("full").

5. **The inherent serialisation is unavoidable and is the consumer's to place.** Capacity is a cross-row
   aggregate; correctness under concurrency requires locking the contended counter (e.g. `SELECT … FOR
   UPDATE` on the parent, or an equivalent atomic conditional). **No apply mechanism removes this** — the
   choice only affects *where the lock lives and how long it is held*.

## Apply mechanism — considered options

- **(a) Pre-check guard inside the batch applier** (mirror `reject-if-stale`): the policy declares the
  capacity rule; the applier runs a guard SELECT, collects over-limit creates, excludes them from the
  INSERT. Least new code. Rejected as the general mechanism — it **duplicates the invariant** (the guard
  re-expresses a rule the DB constraint already states; two sources of truth that can drift), holds the
  parent lock for the *whole batch's* duration, and cannot naturally reject a *paired* satellite insert
  (pairing-awareness is awkward in per-table-group SQL).
- **(b) Per-statement savepoint + catch** inside the batch applier: wrap each DML in a savepoint and turn a
  caught constraint/trigger exception into a conflict. Most general (any DB-enforced invariant), but
  rejected — it **breaks whole-batch atomicity** (partial application → a rejected parent can orphan a
  committed child), adds subtransaction overhead scaling with batch size, and still needs unit-awareness to
  roll back a pair together.
- **(c) Flush-routing to an authoritative endpoint** (**chosen**): the pessimistic unit leaves the batch
  entirely and is applied in its own transaction with a per-mutation answer. Fewest new failure modes —
  batch atomicity untouched, the DB constraint stays the single authority, cost localised to the writes
  that opted in, and **unit-oriented by construction**, so the multi-table `post` + `post_user` case is
  natural (hand the unit to the endpoint; it applies the unit). Cost: the most new surface (a second write
  path + flush-routing + the authoritative handler), and a pessimistic write is a dedicated round-trip
  rather than batch-amortised — though that round-trip is intrinsic to pessimism, and same-policy writes can
  be grouped to recover amortisation.
  - Sub-choice: **(c1) generic transaction-group** — the endpoint applies the unit with the same
    registry-driven applier logic, inside its own capacity-checked transaction (default); **(c2) bespoke
    operation RPC** — a hand-written handler for a gnarly operation (escape hatch).

## Symmetry with the read side

This is the write-side twin of ADR-0021, and both hang off the **consistency group as the transaction
boundary**:

- Read: one query API, two **hydration lifecycles** (`eager-persistent` / `lazy-ephemeral`).
- Write: one mutation API, two **flush modes** (optimistic-batch / pessimistic-authoritative).

## Consequences

- The **gating** half ships for free on the existing state machine; the **rejection** half is a bounded new
  conflict policy in the ADR-0015 mould (a new policy value, the authoritative apply path, the auto-discard
  disposition, a typed-rejection ack).
- The quota-gated **multi-table** operation is handled: `post` + `post_user` commit atomically; on reject
  both overlays auto-discard; the satellite is pessimistic *by membership in the unit*, not globally.
- New client surface: the `transaction({ mode })` block. Everything else reuses the flush-routing path — a
  mutation carries an optional unit tag, the flusher routes by `unitTag ?? staticGroup`, and the
  authoritative endpoint and disposition are unit-agnostic — so supporting **both** declaration sites is
  near-free once the static pessimistic path exists.
- **Composition with ephemeral reads (ADR-0021).** An `ephemeral` table has no durable local write queue (its
  journal is part of a `TEMP` cluster that dies with the session), so a write that must not be lost on
  tab-close should use this pessimistic / prompt-flush path — it reaches the server before close rather than
  trusting a queue that will not survive. This is the read/write composition point between the two lanes
  (e.g. exam answers).
- This is **more** work than the read side (which is pure orchestration); sequence the read lane first. The
  write lane needs the apply-mechanism decision (taken here: **c**) and the write-unit/grouping primitive
  before build.

## Implementation status

**Implemented — decisions 1–4 are built end to end: the write-unit model + validation, the durable tag
substrate, the authoritative endpoint, the client flush-routing + public `transaction({ mode })` block, and
the auto-discard-on-reject disposition.**

Built:

- **Write-mode as a contract property** (`writeMode: optimistic | pessimistic`, default optimistic) on the
  registry entry, validated: a declared value must be a valid `WriteMode`, `pessimistic` is rejected on a
  `readonly` table (no write path to govern), and — because a pessimistic consistency group *is* the static
  atomic write-unit (decision 2) — a consistency group must be **uniformly one write-mode** (checked
  alongside the ADR-0021 subscription/retention uniformity). `packages/contracts` (`config.ts`,
  `registry.ts`). Deliberately **excluded from the registry fingerprint** (like `subscription`): static
  write-mode is runtime flush-routing over identical local DDL, so flipping it needs no cache rebuild.
- **The durable write-unit tag substrate** (decision 2, dynamic site — storage half): two nullable journal
  columns `write_unit` (the shared unit id grouping co-committed mutations) + `write_mode`, stamped by a new
  optional `WriteUnit` arg on the runtime's `batch(items, unit)`; the per-table create/update/delete helpers
  pass no unit (their mode comes from the static group at flush). NULL on both = the default path.
  `packages/client/src/schema.ts` (journal DDL), `packages/client/src/mutation.ts` (`insertMutationsBulk`,
  `enqueueBatch`, `batch`).

- **The authoritative write endpoint + protocol** (decision 3, mechanism **c1**): a new `rejected` ack
  transport status + `rejectionReason` + the `authoritativeWriteRequestSchema` (one write-unit per POST), and
  a sibling server route (`/api/mutations/unit`) that **reuses the registry-driven applier** but runs each
  unit in its **own isolated transaction** — so a constraint/trigger exception becomes a clean per-mutation
  `rejected` ack (the whole unit rolls back, never a whole-batch 500), a stale member rolls the atomic unit
  back as `conflicted` (overlays kept, ADR-0015), and a clean unit acks every member with its Server version.
  The `rejected` ack's `rejectionReason` is **sanitised** (`toPublicRejectionReason`) — an app-authored
  `RAISE` message passes through (the friendly capacity/quota channel) but a built-in constraint violation
  becomes a stable generic message, so the raw DB error (constraint names, the offending values/PII, schema,
  hints) never reaches the client; the full detail stays in the operations log.
  `packages/contracts/src/mutation.ts`, `packages/server/src/mutations/route.ts`, `index.ts`. Behaviour
  proven in the container integration lane (`write-api.integration.test.ts`: acked / rejected-on-constraint /
  conflicted-on-stale).

- **The client flush-routing + public `transaction({ mode })` block** (decisions 2–4, client half):
  - *Tagging.* A statically-`pessimistic` table's writes earn a per-enqueue unit at enqueue
    (`enqueueBatch`), so every pessimistic row carries `write_mode = 'pessimistic'` + a unit id — dynamic
    (the block) and static (the group) tag uniformly. The optimistic background batch **excludes**
    pessimistic rows (`readPendingBatchRows`), so a tagged write is never optimistically sent.
  - *Authoring.* `client.transaction({ mode }, run)` collects the callback's mutations into one unit and
    enqueues them atomically (`batch(items, unit)`); a `pessimistic` block then inline-flushes the unit and
    awaits the per-mutation result (foreground — the server's answer before the UI shows success), an
    `optimistic` block enqueues + background-flushes. A **plain** write to a statically-`pessimistic` table
    (`client.tables.x.create(...)`, outside a block) is foreground-routed the same way — the per-table
    `create`/`update`/`delete` flush the unit `enqueueBatch` tagged for it, so a static-pessimistic write is
    never left tagged-but-unflushed.
  - *Routing + disposition.* `runtime.flushUnit(unitId)` POSTs the unit to the authoritative endpoint and
    applies each ack: `acked` converges via the synced echo; `conflicted` keeps the overlay (ADR-0015);
    `rejected` is terminal and **auto-discards** the unit's optimistic overlay (`discardOverlayForSettledEntity`)
    and surfaces the typed reason via the new `onReject` callback. Transport failure keeps the overlay for a
    retry (no background retry — pessimism is foreground). `packages/client/src/mutation.ts`,
    `packages/client/src/index.ts`. Proven over real PGlite + a stubbed endpoint (`pessimistic-flush.test.ts`:
    acked / rejected-with-discard+onReject / conflicted-kept / background-batch-skips-pessimistic) and the
    `rejected` state machine in `mutation-state.test.ts`.

Deferred (small, non-blocking): multi-unit amortisation (one POST carrying several independent units, each in
its own server txn — today one unit per POST); and background retry of a pessimistic unit whose inline flush
hit a transport error (today it stays `failed`/overlay-kept for an explicit re-flush, matching the
foreground-pessimism model).

Grounded in `packages/server/src/mutations/plpgsql-apply.ts` (the batch is one transaction;
`reject-if-stale` via pre-check + `RETURNS TABLE`), `packages/client/src/mutation-state.ts` (the state
machine), and `packages/client/src/mutation.ts` (`onConflict` / `discardConflict` — the disposition template).

References: [ADR-0009](0009-internalize-read-path-sync.md) (consistency groups = the transaction boundary,
reused as the static write-unit); [ADR-0015](0015-stale-write-conflict-policy.md) (stale-write conflict
policy — the lineage and the per-mutation `RETURNS TABLE` rejection channel this extends);
[ADR-0021](0021-lazy-ephemeral-sync-lifecycle.md) (the read-side twin); `CONTEXT.md` (the Parity boundary —
the server is the write authority).

## Addendum (2026-07-06): blind pessimistic update — a `/unit` update needing no local base row

The unit model above assumes an `update`/`delete` member is **present in the actor's local read model**:
the enqueue planner captures the row's base server version (ADR-0015) and seeds the optimistic overlay
from it, and throws `"<key> not found in local read model"` when the entity is absent. That assumption
broke for a legitimate class of writers whose own read shape streams **zero** matching rows — an
anonymity-scoped moderation flow is the canonical case: the write target's read stays reporter-scoped while
the moderator holds only an identity-free projection, so the row the moderator writes never appears locally.
The only way to satisfy `update` was to **seed a phantom base row** just to pass the presence check — and
because no Electric echo ever arrives for an invisible row, the acked journal row *and* its overlay lingered
forever (the acked-clear is echo-barrier-gated on a synced row reaching the acked version).

**Decision.** Add `updateBlind(entityKey, patch)` to the pessimistic transaction table handle
(`SyncTransactionTableHandle`) — an update-by-key with no local base row:

- **Journal-only.** It plans a journal row with `mutationKind = "update"`, payload `{ kind: "update", patch }`,
  and `baseServerVersion: null` (the `/unit` expander is authoritative — there is no base to capture). It
  plans **no overlay**, so nothing enters the read model and nothing can linger there. The local-presence
  check is skipped; the "already queued for deletion" guard (journal-derived) is kept.
- **A persistent `pessimistic-blind` marker.** The journal row's `write_mode` is `"pessimistic-blind"` (not
  the unit's `"pessimistic"`), stamped per row. The optimistic background flusher's skip predicate widened
  from `<> 'pessimistic'` to `NOT LIKE 'pessimistic%'` so a blind row is excluded too (it belongs to its
  unit's foreground flush only); `flushUnit` selects by unit id + status, so blind rows flow through it
  unchanged.
- **Echo-free retirement.** Reconcile gained one unconditional statement — `DELETE … WHERE status = 'acked'
  AND write_mode = 'pessimistic-blind'`, with **no** echo barrier: nothing local converges for these rows and
  no overlay exists, so once the authoritative unit acks them there is nothing left but to drop the journal
  row. The idle fast-path already probes on `'acked'`, so it fires without change — making cleanup crash-safe
  (any later tick clears), not dependent on the foreground call surviving to reconcile.
- **Pessimistic-only, by construction.** An optimistic-routed blind write has nothing to show optimistically
  and no base to converge, so `updateBlind` **throws at enqueue** unless the write routes pessimistically (an
  explicit `pessimistic` unit, or a statically-`pessimistic` table). `conflicted`/`rejected` blind rows keep
  today's terminal handling (kept-for-diagnostics + `onReject`; dischargeable via `discardConflict`) — with no
  overlay, the discard/owed-guard paths no-op harmlessly.

**The write-only pattern.** The local journal/overlay/synced tables are provisioned for **every** registered
`readwrite` entry — `subscription` gates Electric streaming, not the local DDL — so a `readwrite` entry
declared `subscription: "lazy"` and **never activated** flushes, acks, and retires blind updates cleanly with
its consistency group never opened: a genuine write-only table (authored through the authoritative endpoint,
never streamed).

**Explicitly deferred: blind CREATE.** No consumer needs it yet, and it does not fall out for free — the
presence check never applied to creates, but a create still plans an **overlay**, so a write-only create would
linger the same way the phantom-row workaround did. Out of scope until a real consumer appears (it would need
the overlay-free + echo-free retirement extended to the create path).

Grounded in `packages/client/src/mutation.ts` (enqueue planner, `insertMutationsBulk` per-row `write_mode`,
`readPendingBatchRows` skip predicate, `reconcileTable` blind retirement), `packages/client/src/index.ts` +
`packages/client/src/worker/{attach-sync-client,define-sync-worker}.ts` (the `updateBlind` handle and its
worker-bridge round-trip). Proven over real PGlite (`blind-update.test.ts`: absent-entity flush + no-overlay +
echo-free retirement + re-accept, optimistic-guard throw, plain-update presence-check regression,
background-flush isolation, rejected-blind + `onReject`, statically-pessimistic route) and the worker bridge
(`worker-bridge.test.ts`).
