---
title: The write path
description: Stage locally, flush a batch, apply in a single in-database function. One path, no backends.
sidebar:
  order: 3
---

There is exactly **one** write path, and it is deliberately not configurable. Earlier versions of
pgxsinkit experimented with several write strategies; the experiments converged on one clear winner —
**push the apply logic into the database and consume mutations in bulk** — and the alternatives were
deleted. There is no selectable backend, no strategy enum, and no per-table CRUD. (See
[ADR-0002](/decisions/) for the full rationale.)

## The flow

1. **Stage locally.** A client write is recorded into a local **overlay** table (the optimistic
   value the UI reads) and a durable **mutation journal** in PGlite. The app never mutates a synced
   table directly.
2. **Flush a batch.** The client sends one or more journaled mutations to the server's write route as
   a batch: `POST /api/mutations`.
3. **Validate.** The server validates every mutation against the registry's Zod schema, rejecting
   client-supplied server-managed or projected-away fields.
4. **Apply in one call.** Inside a transaction, the API calls the single in-database function
   `pgxsinkit_apply_mutations(...)`, which applies the whole batch. Constraints are deferred for the
   batch (`SET CONSTRAINTS ALL DEFERRED`) so intra-batch foreign keys resolve.
5. **Acknowledge.** The API returns an ack per mutation, including the server `updated_at_us`.
6. **Clear the overlay on echo.** The optimistic overlay row is cleared only once the read path
   streams the row back with a server `updated_at_us` at least as new as the acked value — so the UI
   never flickers back to a stale value.

## Why everything is in the database

Putting the apply logic in PL/pgSQL was the toolkit's central finding: it minimises round-trips,
keeps the batch atomic, and lets row-level security and managed-field logic run where the data lives.
The function is the **mutation applier**; provisioning it is a migration step
(`bun run sync:function:generate`).

The applier **verifies itself on every call** (ADR-0030). The migration stamps it with a fingerprint of
its own DDL (a `COMMENT ON FUNCTION`); on each apply the server passes the fingerprint it expects for its
registry + codegen, and the function compares that against its own stamped comment **before it touches
any table** — raising `PXS01` and applying nothing if they disagree (a stale, or hand-installed
unfingerprinted, function is refused). Because the check rides the existing call it costs no extra round
trip, needs no startup query, and has no read-then-call race. Provisioning-order and per-worker startup
cost are tuned with the `deployment` profile on `createSyncServer` (`startupVerification`,
`operationsLog`); its defaults preserve long-lived-host behavior, and the serverless posture
(`startupVerification: "deploy-time"`, `operationsLog: "enabled" | "disabled"`) sends zero queries before
the mutation transaction itself. Deploy-time drift is still caught in CI with `pgxsinkit-generate --check`.

## Row-level security

When any synced table has RLS policies (or governance managed fields that need the actor), the write
API resolves JWT claims via `resolveAuthClaims` and passes them into the apply function, which sets
the Supabase-style auth context (`role`, `request.jwt.claims`) for the duration of the batch and
restores the caller's prior context afterwards. Missing claims for an RLS-enabled table fail the
batch with 401.

## Managed fields

Governance "managed fields" (e.g. `ownerId` via `authClaim` at claimPath `["sub"]`,
`createdAtUs`/`updatedAtUs` via `nowMicroseconds`) are written **by the database**, not the client. The
server strips any client-supplied values for these fields before applying. (`authClaim` is the single
claim-stamping strategy: a value read from the verified JWT claims at a JSON path — `["sub"]` is the
auth subject, `["app_metadata","person_id"]` an app-minted identity; the old `auth.uid()` owner is just
`["sub"]`.)

This shapes what you pass to a `create`. `SyncTableCreateInput` **omits** every managed-on-create
field, so you supply only the non-managed columns — for a chat message that is just
`{ id, channelId, body }`; `authorId`, `createdAt`, `updatedAt` are stamped server-side. Including a
managed field in the payload is an error (the API rejects it), and the create-validation schema does
**not** require them — a `NOT NULL` managed column (an owner/author with no SQL default) is still a
valid create with the field absent.

The optimistic overlay does not wait for the server, though. When you call `.create(...)`, the
runtime fills the overlay row's managed fields locally so the UI renders a complete, attributed row
this frame: `nowMicroseconds` fields take the client clock, and an `authClaim` field takes the decoded
claim at its path (for `["sub"]`, the current session's subject — the same value the server stamps).
Because both sides resolve to the same identity, the value never flips when the server's row echoes
back. The flushed payload still omits these fields (it is built from your original input, not the
overlay), so the server remains authoritative.

## Terminal dispositions and rollback

Most writes ack and clear on echo. Two outcomes are **terminal** — the server will not accept the write
as-is — and each keeps the optimistic overlay so the edit is never silently lost, surfaces a callback,
and now has a **symmetric discard** that rolls the overlay back:

- **`conflicted`** (ADR-0015, the `reject-if-stale` policy) — a stale edit the server declined because
  the row moved on. Fires `onConflict`; the app shows a resolve/diff UI and either resolves it as a new
  write or rolls it back with **`discardConflict(table, entityKey)`**.
- **`quarantined`** (ADR-0006) — a structurally-rejected write (a 4xx the server will never accept:
  a validation failure, or a permanent policy denial such as an RLS `42501`). Fires `onQuarantine`; the
  app surfaces it and either re-authors + resubmits or rolls it back with
  **`discardQuarantined(table, entityKey)`**.

Both discards do the same thing for their status: delete the entity's terminal journal rows and clear
its kept overlay row, so the read model falls back to the synced (server) value and the entity **accepts
new mutations again** (a lingering terminal row otherwise blocks a re-create and chains a later update
onto a dead head). The overlay is cleared only when no _other_ journal row still owes the entity, so a
discard never strips an overlay a still-pending write depends on.

```ts
const client = await createSyncClient({
  registry,
  // …
  onQuarantine: async (details) => {
    // surface to the user, then either resubmit a corrected write…
    // …or roll the optimistic edit back:
    await client.discardQuarantined(details[0].tableName, details[0].entityKey);
  },
});
```

Because quarantine now has a real rollback, route a **permanent policy denial (e.g. RLS `42501`) to
`quarantined`** — there is no longer any reason to mis-route it to `conflicted` just to borrow a discard
affordance. Reserve `conflicted` for genuine stale-write conflicts under `reject-if-stale`.

## Blind pessimistic update

A **pessimistic write unit** (`client.transaction({ mode: "pessimistic" }, …)`, ADR-0022) flush-routes to
the authoritative endpoint and resolves only once the server has decided — the block returns each member's
`acked` / `conflicted` / `rejected` outcome. Its table handles carry `create` / `update` / `delete`, and one
more: **`updateBlind`**.

Ordinary `update` requires the entity to be present in the actor's **local read model** — it seeds the
optimistic overlay from the local row and captures the base server version to detect a stale write. But some
legitimate writers target a row their own read shape **excludes**. The classic case is anonymity-scoped
moderation: a moderator flags a report, but the report's row streams only to the reporter's projection — the
moderator holds an identity-free projection with no matching row. The write target simply never appears
locally, so there is no base row to update.

The old way to satisfy `update` here was to **seed a phantom base row** just to pass the presence check. That
row then lingered forever: no Electric echo ever arrives for a row you can't see, so the acked journal entry
and its overlay never clear (the acked-row cleanup is gated on a synced echo reaching the acked version), and
the phantom row stays in your read model.

`updateBlind(entityKey, patch)` is the fix. It:

- **plans a journal row only** — no optimistic overlay, so nothing enters the read model and nothing can
  linger there;
- **skips the local-presence check** (there is no base to capture; the server-side `/unit` expander is
  authoritative for the result);
- is **pessimistic-only** — it is meaningful solely inside a `transaction({ mode: "pessimistic" })` block (or
  over a statically-pessimistic table). An optimistic-routed blind write has nothing to show optimistically
  and no base to converge, so it **throws at enqueue**;
- **retires without an echo** — once the authoritative unit acks the row, reconcile drops the journal entry
  directly (no visible row ever converges for it), so it is crash-safe: any later convergence tick clears it.

```ts
await client.transaction({ mode: "pessimistic" }, (tx) => {
  // `reportId` is not in this moderator's read shape — no local row, no overlay.
  tx.tables.reports.updateBlind({ id: reportId }, { status: "hidden" });
});
```

A `conflicted` blind write stays dischargeable via `discardConflict`; a `rejected` one is surfaced via
`onReject` — both with no overlay to clean up.

### The write-only pattern

Because the local journal / overlay / synced tables are provisioned for **every** registered `readwrite`
entry — `subscription` only gates Electric streaming, not the local DDL — a `readwrite` entry declared
`subscription: "lazy"` and **never activated** still flushes, acks, and retires blind updates cleanly, with
its consistency group never opened. That combination is a **write-only table**: you author to it (through the
authoritative endpoint) without ever streaming a row of it into the client. Nothing reads locally, nothing
shows optimistically, and no acked row lingers.

### Lazy read/write groups need an echo

Ordinary optimistic `create`, `update`, and `delete` operations maintain an overlay, and an acknowledged
journal row retires only after the committed server version returns through Electric. That echo can only
arrive over an open shape — so the target's `subscription: "lazy"` consistency group has to be active by
the time the server commits.

You do not have to arrange that yourself. **An ordinary write activates its target's lazy group
automatically.** A write is a reference to its target, and referencing a lazy relation activates its whole
consistency group — exactly as a read does. The client fires this activation at enqueue (fire-and-forget,
so the write never blocks on the network); the group only has to be open by the time the echo returns, and
a start that briefly fails self-heals on the group's next activation. The manual "mount an activator live
query before first write" step is no longer needed.

`updateBlind` stays the deliberate exception: it plans a journal row with no overlay and no echo barrier,
retires on the authoritative ack, and does **not** activate its group — that is the whole point of the
[write-only pattern](#the-write-only-pattern) (a fully provisioned local table that never streams a row).

The auth angle still holds. A write-triggered activation uses the claims available at that moment, so a
group whose row filters deny anonymous callers should not be written before the session exists — otherwise
it activates against unauthenticated claims. Activating a claims-denied group with no token now logs a
console warning naming the group; see
[Gate authenticated lazy groups until auth is resolved](/concepts/registry-entry-options/#subscription)
for the gating pattern (still the right approach for authenticated reads, and for authenticated-only
writes).

## Pausing convergence (an offline toggle)

The convergence driver decides _when_ to run flush/reconcile by asking its `ConvergenceTrigger`'s
`shouldConverge()`. That is the seam for an app-built "offline" mode: wrap your trigger so
`shouldConverge()` returns `false` while the app is offline. Writes still stage into the local journal
(the optimistic overlay updates as usual) — they simply are not sent — so the journal fills visibly
while offline. Flip back online and fire one signal, and the queued writes flush and reconcile. No
teardown, no lost edits.

This pauses the **outbound** half. The **inbound** read path (the Electric shape subscriptions) has no
pause/resume today — `client.stop()` halts it but also closes the local store — so an app offline
toggle built this way still _receives_ remote changes. Suspending both directions without tearing down
the store is a planned capability.

## What this means for you

- Don't write to synced tables from app code — stage through the mutation runtime; all writes flush
  to the one write route (`POST /api/mutations`).
