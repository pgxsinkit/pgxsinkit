---
title: Mutation status
description: Render a global sync indicator with one subscription — client.mutations and the React hooks.
sidebar:
  order: 10
---

Every local write lands in a per-table **mutation journal** on its way to the server (see
[the write path](/concepts/write-path/)). To show a global "syncing…" indicator, a pending-changes
badge, or a diagnostics screen, you rarely want to reach into each table's journal by hand. pgxsinkit
gives you **one registry-wide surface** over every writable journal: `client.mutations`.

## One subscription, not one per table

A naive sync indicator opens one live query per writable table. On a registry with a dozen writable
tables that is a dozen registrations competing for the same database thread at startup — the exact
fan-out this API removes. Instead, mount **one** summary subscription:

```ts
const handle = await client.mutations.subscribeSummary((summary) => {
  // Fires on every change. `summary` carries per-status counts plus derived totals.
  setUnsettled(summary.unsettledCount);
});
setUnsettled(handle.initial.unsettledCount); // the current value, delivered on the handle
// later:
handle.unsubscribe();
```

The summary is cheap enough to mount **permanently** for the life of the app. Detail lists are the
route- or feature-scoped counterpart — mount them where a diagnostics panel is open.

## The summary shape

`summary()` (one-shot) and `subscribeSummary()` (live) both fold to a `MutationSummary`:

| Field              | Meaning                                                                                                                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pendingCount`     | staged locally, not yet sent                                                                                                                                                                           |
| `sendingCount`     | in flight to the server                                                                                                                                                                                |
| `ackedCount`       | acknowledged; awaiting the synced echo to reconcile away                                                                                                                                               |
| `failedCount`      | transient failure; will be retried                                                                                                                                                                     |
| `conflictedCount`  | a stale write the server declined — your optimistic edit is kept, resolve it as a new write                                                                                                            |
| `rejectedCount`    | a business rejection; the optimistic edit was auto-discarded                                                                                                                                           |
| `quarantinedCount` | parked from automatic processing because replay is unsafe (a restored journal) or the server permanently rejected it — your optimistic edit is KEPT; inspect and `discardQuarantined` (then re-author) |
| `unsettledCount`   | `pending + sending + failed + conflicted + quarantined` — every write still needing work or user action                                                                                                |
| `settledCount`     | `acked + rejected` — the truly-done complement                                                                                                                                                         |

`unsettledCount` is the number to drive a "you have unsynced changes" indicator, and it **includes
`quarantined` and `conflicted`**. Both are terminal in the journal's automatic state machine, but from
your (and your user's) standpoint they are NOT done: the optimistic edit is kept, later writes for that
entity stay blocked, `destroy()` refuses them without `force`, and the user must explicitly resolve them
(`discardConflict` / `discardQuarantined`, then re-author). This matters especially after a **restore**,
where pgxsinkit deliberately quarantines recovered writes for the user to resolve — a global indicator
must surface them, not hide them. The field is `settledCount` (not "terminalCount") precisely because
"terminal" is the state-machine word and quarantine is terminal there while unsettled here.

## Detail lists

For a table of individual writes — a diagnostics drawer, a per-entity status — use `list()` (one-shot)
or `subscribe()` (live). Both return normalized rows carrying the table key and the parsed entity key,
filtered and ordered newest-first:

```ts
const handle = await client.mutations.subscribe(
  { table: "todos", statuses: ["pending", "failed"], limit: 50 },
  (rows) => setRows(rows),
);
setRows(handle.initial);
```

Filters are all optional: `table`, `entityKey`, `statuses`, and `limit`. Rows are ordered by when they
were enqueued (newest first).

## React hooks

`createSyncClientHooks` returns two hooks for these surfaces. There is no `hydrating` flag — the journal
is local and never network-hydrated, so results are available as soon as the store is open.

```tsx
const { useMutationSummary, useMutationList } = createSyncClientHooks<typeof myRegistry>();

function SyncIndicator() {
  const { summary } = useMutationSummary();
  if (summary.unsettledCount === 0) return null;
  return <Badge>{summary.unsettledCount} unsynced</Badge>;
}

function PendingWrites() {
  const { rows, loading } = useMutationList({ statuses: ["pending", "failed"] });
  if (loading) return <Spinner />;
  return (
    <ul>
      {rows.map((r) => (
        <li key={r.mutationId}>
          {r.tableName} · {r.status}
        </li>
      ))}
    </ul>
  );
}
```

`useMutationSummary` is the one to reach for by default: mount it once, high in the tree, for a global
indicator. `useMutationList` is for the scoped, detailed view.

## Worker mode

Both surfaces behave identically on the worker-attached client — the queries run in the selected engine
home and stream back over the same bridge the read hooks use. You never touch the generated journal relation
names in either mode.
