---
name: react
description: >-
  Load when wiring @pgxsinkit/react into a React app — createSyncClientHooks and the reactive read hooks
  (useLiveRows, useLiveRow, useLiveDrizzleRows, useLiveDrizzleRow) plus SyncClientProvider /
  useSyncClient. Teaches that live reads are event-driven off PGlite's live.query (they fire on commit,
  not on a poll), that useLiveDrizzleRows remaps snake_case columns back to the builder's field keys
  while raw useLiveRows returns underlying column names, the { rows, loading, error } contract (the
  Drizzle hooks add a hydrating flag that stays true until every referenced consistency group — eager or
  lazy — has caught up and delivered its rows, so empty is distinguishable from still-synchronizing), that
  authenticated lazy groups must be gated until claims exist (ordinary writes self-activate their group,
  so gate the write on auth rather than mounting an activator), and that writes go through
  client.tables.<t> (not the hooks) and flush on enqueue. Load before building React components that read
  or write synced data.
metadata:
  type: framework
  framework: react
  library: "@pgxsinkit/react"
  library_version: "0.2.0"
  source: https://pgxsinkit.github.io/
requires:
  - react
---

# Using @pgxsinkit/react

Create one set of registry-typed hooks at module scope and provide the client at the root:

```ts
export const { SyncClientProvider, useSyncClient, useLiveRows, useLiveDrizzleRows } =
  createSyncClientHooks<typeof registry>();
```

Wrap your tree in `<SyncClientProvider client={client}>`; components then read the local store
reactively and write through the client.

## Reads are reactive and event-driven (not polled)

The live hooks register a PGlite `live.query`. When the sync engine applies a change to PGlite, the live
query re-runs and the hook re-renders — **on commit, not on an interval**. Do not add a `setInterval` to
"refresh" a live query; it is already reactive, and polling PGlite is actively harmful (every query is
~50ms of WASM work on one thread — see the `operating` skill).

Every read hook returns `{ rows, loading, error }` (singular variants return `{ row, ... }`). Pass
`ready: false` to defer a query until a dependency is available.

### `hydrating` — distinguish "still synchronizing" from "genuinely empty"

The Drizzle hooks (`useLiveDrizzleRows`/`useLiveDrizzleRow`/`useLiveQueryRaw`/`useLiveQueryRawRow`) add a
`hydrating` boolean. It is `true` from mount until **every** consistency group the query reads — eager
**or** lazy — has completed its initial catch-up and the caught-up rows have been delivered to the
subscription. Cached/local rows paint immediately while `hydrating` is `true` (the subscription registers
without waiting on the network), and the signal is rows-before-catch-up: it never flips to `false` before
the freshly caught-up rows have landed, so it can never flash a false "empty".

This is uniform across eager and lazy relations — an eager relation still catching up on a cold boot is
covered too, not just lazy relations. Steady-state subscriptions (every referenced group already caught up
at mount) are unaffected: `hydrating` clears at the first snapshot with no extra work. Render an empty
state only when `!loading && !hydrating` — zero rows before that means "not loaded yet", not "empty":

```tsx
const { rows, loading, hydrating } = useLiveDrizzleRows((c) => c.drizzle.select().from(c.views.todos), []);
if (loading || hydrating) return <Spinner />;
if (rows.length === 0) return <EmptyState />;
```

## Gate authenticated lazy groups until the session exists

A live query that references one `subscription: "lazy"` relation activates its **whole consistency
group**. The first shape request uses the claims available at that moment. If the group's row filters
return `DENY_ALL` without a user claim, mounting the query while auth is unresolved starts an anonymous,
empty subscription; a later auth notification then has to rotate/refetch the shape.

Use the hook's `ready` option to make first activation coincide with the authenticated session:

```tsx
const workflowView = registry.workflow.view!;

useLiveDrizzleRows((client) => client.drizzle.select({ id: workflowView.id }).from(workflowView), [], {
  ready: session != null,
});
```

You no longer need a separate activator component for writes. An ordinary optimistic create/update/delete
self-activates its target's lazy group at enqueue, so the Postgres commit echoes back through Electric and
retires the acknowledged journal row on its own. But that write-triggered activation still uses the claims
available at the time, so gate the **write** on auth the same way — do not write to an authenticated-only
group before the session exists. (`updateBlind` is different: it has no overlay, does not activate its
group, and deliberately retires on the authoritative ack without an echo.) Activating a claims-denied group
with no token — by read or by write — now logs a `console.warn` naming the group.

If anonymous access is valid, gate on **auth resolution** rather than `session != null`, then call
`client.notifyAuthChanged()` whenever the known session changes. The rule is not "always require a user";
it is "do not activate a claims-dependent lazy group with unresolved claims."

## Prefer `useLiveDrizzleRows` for typed, correctly-keyed rows

PGlite returns rows keyed by the underlying **snake_case** column names. `useLiveDrizzleRows` takes a
Drizzle select builder and **remaps** those back to the builder's (camelCase) field keys, so the rows
match the inferred type with no casts:

```ts
const { rows } = useLiveDrizzleRows((c) => c.drizzle.select().from(c.views.todos), []);
```

Raw `useLiveRows(sql, { params })` does **no** remap — its rows carry the raw DB column names. Use it for
ad-hoc SQL where you control the column names; prefer `useLiveDrizzleRows` for typed reads. The Drizzle
builder is rebuilt when the `deps` array changes (same contract as `useEffect`). When you pass `params`,
the positional `$N` placeholders in the raw SQL must be strictly sequential `$1..$n`, each used exactly
once — PGlite bug #1055 inlines live-query params textually rather than positionally, so any other shape
mis-binds; the client now rejects it with a clear error naming the bug. A Drizzle builder always compiles
to that safe shape, so this only affects hand-written raw SQL.

## Writes go through `client.tables`, not the hooks

The read hooks are read-only. Mutate via `client.tables.<table>.create/update/delete` (or
`useSyncClient()` inside a component). Each call stages an optimistic local write (the live query
re-renders this frame) and **flushes on enqueue** — the optimistic overlay clears when the server value
streams back through Electric. See the `core` skill for the write model and `operating` for convergence
cadence and the `globalThis.__pgxsinkitDebug` latency instrumentation.

## Common mistakes

- Expecting `useLiveRows` to return camelCase keys — it returns raw DB column names; use
  `useLiveDrizzleRows` for remapped, typed rows.
- Polling PGlite (`setInterval` re-reads) to "watch" data — the hooks are already reactive, and polling
  saturates the single WASM thread.
- Mutating local tables directly instead of through `client.tables.<t>` (the one write path).
- Reading before the client is ready instead of gating with `ready: false`.
- Reading OR writing an authenticated lazy group before auth resolves — it activates against anonymous
  claims (now flagged by a console warning) and the shape stays empty until a later rotation/refetch. Gate
  on the session, not on a manual activator (writes self-activate their group).

Reference: <https://pgxsinkit.github.io/>.
