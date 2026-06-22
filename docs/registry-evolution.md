# Evolving the sync registry safely

How to change a sync registry without losing offline data. Rationale and the full
decision are in [adr/0006](adr/0006-local-schema-evolution.md).

## The local database is three things, not one

| State             | Durability                | On a shape change                    |
| ----------------- | ------------------------- | ------------------------------------ |
| Synced read cache | Reconstructible           | Drop + re-sync (cost: a re-download) |
| Overlay rows      | Pending intent            | Must not be dropped while un-flushed |
| Mutation journal  | The local source of truth | Must survive                         |

Drop + resync is right for the **read cache** and wrong for the **journal/overlay**.
The default upgrade path is therefore _drain-then-drop_: flush + confirm acks, then
rebuild the read cache only.

## What the client does on boot

The local store is keyed by the registry fingerprint (recorded in a `pgxsinkit_local_meta`
row), not a hand-bumped `idb://…-vN` suffix. On boot `createSyncClient` compares the stored
fingerprint to the current one:

- **Unchanged** → nothing to do.
- **Changed, nothing owed locally** → the read cache is dropped and rebuilt at the new shape,
  the Electric subscriptions are reset so shapes re-stream, and the new fingerprint is
  stamped. Surfaced via `onSchemaChange` with `status: "rebuilt"`.
- **Changed, writes still owed** (un-flushed/quarantined) → the rebuild is **deferred**
  (`status: "deferred"`) rather than dropping owed writes. Those writes flush and reconcile
  during normal use; the rebuild completes on a later boot once the journal is clear. This is
  the drain-then-drop, spread across sessions — never a silent loss.

`client.dropReadCache()` performs the read-cache rebuild on demand (preserving the journal
and overlay); `client.destroy()` wipes the whole store (refusing while writes are owed unless
`destroy({ force: true })`), distinct from `client.stop()` which only closes the handle.

## What the runtime does at send time

The runtime never silently drops an owed write. Every mutation is stamped at enqueue
with the registry fingerprint it was authored under (`registry_version`), and a flush
failure resolves into one of two durable states:

- **`failed` (transient, retryable):** a network/transport error, any `5xx`, or a
  transient `4xx` (auth `401`/`403`, timeout `408`, too-early `425`, rate-limit `429`).
  The mutation keeps its place and retries under a jittered, bounded backoff.
- **`quarantined` (permanent, terminal):** a structural `4xx` (`400`/`404`/`409`/`422`/…)
  the server will never accept as-is, **or** a mutation that has exhausted the hard
  attempt cap (`maxMutationAttempts`, default 10). It is **surfaced** — via the
  `onQuarantine` callback and `diagnostics().mutation.quarantinedCount` — and **never
  retried**. A later mutation for the same entity is held behind it (author-order
  integrity) until the quarantine is resolved.

This is the one loss case the runtime _can_ catch at send time. The silent case it
**cannot** catch — a same-named column whose meaning quietly changed — is caught instead
at authoring time by the registry-diff gate below.

## Use expand/contract (parallel change)

**Never drop, rename, or repurpose a column or table in the same release that ships
the new client.** Instead:

1. **Expand.** Add the new column/table (nullable or with a default; a new table is
   always safe). Ship it. Old clients ignore it; their pending mutations still target
   structures that exist.
2. **Backfill / dual-write** until every client and row is on the new shape.
3. **Contract.** Only once the slowest offline client has drained may you remove the
   old column/table — in a _later_ release.

Because the server keeps the old structures alive through a window that outlives the
slowest offline client's drain, an incompatible drain essentially never happens. The
residue — a genuine breaking change that cannot be expand/contract'd — becomes a rare,
deliberate decision, exactly where you choose "accept bounded, surfaced loss".

## Gate breaking changes at authoring time

pgxsinkit ships the mechanism; you own enforcement via a committed lock.

1. Generate the baseline and commit it:

   ```ts
   import { buildRegistryLock } from "@pgxsinkit/contracts";
   // write JSON.stringify(buildRegistryLock(myRegistry)) to registry.lock and commit it
   ```

2. In CI (or a pre-commit script), compare the working registry to the committed lock
   and let the exit code be your policy:

   ```ts
   import { runRegistryCheck, summarizeRegistryDiff } from "@pgxsinkit/contracts";

   const { ok, diff } = runRegistryCheck({ registry: myRegistry, lock });
   if (diff.changes.length > 0) console.log(summarizeRegistryDiff(diff));
   process.exit(ok ? 0 : 1); // ok is false on a `breaking` diff
   ```

A breaking change then shows up two ways: as a **failing check** and as a **reviewable
`registry.lock` diff**. Regenerating the lock is the explicit acknowledgement — "I see
this is breaking and I am shipping it". pgxsinkit never reaches into your pipeline; it
makes _not_ deciding loud.

Classifications: added table or nullable/defaulted column → `compatible`; mode/shape
change → `risky`; removed/renamed/type-changed column, `NOT NULL` without default,
primary-key change, removed table → `breaking`. The type-change case is the one a
client runtime cannot catch on its own — a same-named column whose meaning changed.
