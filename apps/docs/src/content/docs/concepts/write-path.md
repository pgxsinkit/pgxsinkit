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
2. **Flush a batch.** The client sends one or more journaled mutations to the write API as a batch:
   `POST /api/mutations` (the `/mutations` alias is also accepted).
3. **Validate.** The write API validates every mutation against the registry's Zod schema, rejecting
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

## Row-level security

When any synced table has RLS policies (or governance managed fields that need the actor), the write
API resolves JWT claims via `resolveAuthClaims` and passes them into the apply function, which sets
the Supabase-style auth context (`role`, `request.jwt.claims`) for the duration of the batch and
restores the caller's prior context afterwards. Missing claims for an RLS-enabled table fail the
batch with 401.

## Managed fields

Governance "managed fields" (e.g. `ownerId` via `authUid`, `createdAtUs`/`updatedAtUs` via
`nowMicroseconds`) are written **by the database**, not the client. The write API strips any
client-supplied values for these fields before applying.

This shapes what you pass to a `create`. `SyncTableCreateInput` **omits** every managed-on-create
field, so you supply only the non-managed columns — for a chat message that is just
`{ id, channelId, body }`; `authorId`, `createdAt`, `updatedAt` are stamped server-side. Including a
managed field in the payload is an error (the API rejects it), and the create-validation schema does
**not** require them — a `NOT NULL` managed column (an owner/author with no SQL default) is still a
valid create with the field absent.

The optimistic overlay does not wait for the server, though. When you call `.create(...)`, the
runtime fills the overlay row's managed fields locally so the UI renders a complete, attributed row
this frame: `nowMicroseconds` fields take the client clock, and an `authUid` field takes the current
session's subject (decoded from the auth token — the same `sub` the server stamps via `auth.uid()`).
Because both sides resolve to the same identity, the value never flips when the server's row echoes
back. The flushed payload still omits these fields (it is built from your original input, not the
overlay), so the server remains authoritative.

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

- Don't look for a `WRITE_API_BACKEND` setting or a `backend` option — they don't exist.
- Don't add per-table REST routes — `POST /api/mutations` is the only write ingress.
- Don't write to synced tables from app code — stage through the mutation runtime.
