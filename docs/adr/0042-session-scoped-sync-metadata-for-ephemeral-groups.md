# Session-scoped sync metadata for ephemeral groups

Status: accepted (2026-07-14) — maintainer rulings recorded below

> The maintainer has ruled on three points that shaped this design: **(1) no boot-time sweep** — the fix
> is storage placement, not a per-boot cleanup obligation; **(2) same relation names, different schema** —
> the session variants are `pg_temp.subscriptions_metadata` and `pg_temp.shape_row_tags`, distinguished
> from the durable ones by schema alone, not by a renamed `_session` suffix; **(3) `shape_row_tags` is in
> scope** — the tagged-subquery reason sets have the same hazard as the cursor and are scoped together.

## Context

ADR-0021 §3 makes an `ephemeral`-retention group's whole local cluster `TEMP`: the synced/overlay/journal
tables, the sequence, both views, and the reconcile function all live in `pg_temp` and die with the engine,
so read- and write-ephemerality fall out together with no durable trace. One thing did **not** follow the
cluster into `pg_temp`: the group's Electric **subscription cursor** — the `{handle, offset}` per shape and
`last_lsn`, stored in `<metadataSchema>.subscriptions_metadata` (ADR-0028 decision 4). That row is durable
like any group's.

The mismatch is a correctness bug on an engine restart over a warm store. On every boot the engine
re-creates the ephemeral cluster's TEMP relations **empty** (a TEMP relation dies with the old engine). But
the durable cursor survives, so re-activating the group resumes Electric from the old `{handle, offset}`
over the recreated-empty TEMP table — Electric believes that table is already caught up and re-sends
nothing. The rows never re-arrive.

This surfaced on the board demo: a non-admin opens a `lazy + ephemeral` chat channel, sees the messages,
closes the window (the SharedWorker engine dies), and returns (cold worker, warm store) to "No messages in
this channel yet." A real-Electric two-boot integration repro failed `Expected 1 / Received 0` at the
boot-B row assertion with `groupReady` resolving — the activation was *not* dropped; it caught up with zero
rows because the resumed cursor believed the empty TEMP table was already synced. The bug predated this
decision: it arose from the interaction between the June 2026 rebuilt-gated reset and ephemeral-lifecycle
behaviour; the warm persisted-store lane surfaced it rather than introducing it.

ADR-0023's tagged-subquery reason sets (`shape_row_tags`, keyed by `shape_table`) carry the identical
hazard one bug report later: an ephemeral table's tags describe rows in the TEMP cluster. A surviving
durable tag-set after an engine restart would corrupt move-out/move-in reconciliation on the fresh
re-stream (stale tags for rows that no longer exist, then re-created). Tags must die with the rows they
describe, exactly as the cursor must.

## Decision

**Ephemeral retention scopes every piece of per-group sync bookkeeping to the engine session, enforced by
storage placement — not by boot-time cleanup.** An ephemeral group's cursor and tags are stored in `pg_temp`
relations that die with the engine, so their lifetime is *mechanically* tied to the lifetime of the rows
they index. This completes the existing idiom (the whole cluster is already `pg_temp`); the sync metadata
was the one leak into durable space.

Concretely:

1. **Two session metadata relations mirror the durable pair**, built from the **same** column builders
   (ADR-0029 D3 single-source) but schema-qualified into `pg_temp`: `pg_temp.subscriptions_metadata` and
   `pg_temp.shape_row_tags`. **Same relation names as the durable ones** (maintainer ruling 2), distinguished
   by schema alone. Postgres accepts `pg_temp.<name>` qualification in DML (verified on real PGlite), so the
   Drizzle DML paths select the session table object and otherwise differ from the durable DML only in that
object. Memoized singletons —
   `pg_temp` is per-engine by construction, so no schema parameter.

2. **Provisioning** renders these from the same session pgTables via the schema generator's new
   `renderCreateTableSql({ temp: true })` option, which emits the **unqualified** `CREATE TEMP TABLE IF NOT
   EXISTS <name>` form (+ each index `ON <name>`). TEMP DDL takes the bare name — the `TEMP` keyword places
   the relation in the session schema; a `CREATE TEMP TABLE pg_temp.x` target is not portable. An index name
   lives per schema, so the durable `shape_row_tags_shape_tag_idx` (in the metadata schema) and the session
   one (in `pg_temp`) coexist without collision (verified on real PGlite). The session DDL runs in the **same**
   `migrateSubscriptionMetadataTables` step as the durable DDL, once per engine.

3. **Read/write routing** takes one `sessionScoped: boolean`. `getSubscriptionState` / `updateSubscriptionState`
   and the tag read/write/clear helpers (`applyShapeTagSync`, `addShapeRowTags`, `applyShapeMoveOut`,
   `clearShapeTags`) pick the durable-vs-session table object by that bit — pure table selection, queries stay
   Drizzle-built. `syncShapesToTables` gains `sessionScoped` (default `false`); `shape-sync.ts` passes
   `group.retention === "ephemeral"` at the one start site. **The engine never learns the retention model — it
   learns one storage-scope bit**, the same way it already learns bare-vs-qualified table naming per spec.

4. **Delete paths are scope-blind.** `deleteSubscriptionState` / the engine's `deleteSubscription` delete the
   key from **both** cursor tables, and the desync tag-clear SQL clears the shape from **both** tag tables
   (each guarded by `to_regclass`). Idempotent, so every existing caller — `desync`, `discardEphemeral`, the
   `"rebuilt"` all-keys reset — clears both with zero caller changes, and a `persistent → ephemeral` flip
   leaves no orphaned durable cursor row behind.

5. **Tag hygiene at ephemeral group start needs no special-casing.** On every engine boot the session tables
   are empty, so a returning ephemeral group behaves exactly like a brand-new subscription:
   `getSubscriptionState` returns `null` → a full shape fetch from scratch → tags and rows rebuilt in
   `pg_temp`. This is asserted in tests rather than coded.

### Why boot-time cleanup was rejected (maintainer ruling 1)

The rejected boot-sweep approach deleted ephemeral groups' durable cursors unconditionally on **every**
boot, on both boot paths. It works, but it is **procedural**: it imposes a per-boot-path obligation that a
future boot path must remember to honour, and it leaves the durable rows as the source of truth that a sweep
must chase. Storage placement makes the guarantee **structural** instead — there is no durable row to sweep,
nothing for a future boot path to forget, and the cursor's session-scope is the same mechanism as the data's.
The sweep is redundant under this design and is not shipped.

### Retention-flip analysis

`retention` participates in the canonical registry fingerprint (`fingerprint.ts`), so a `persistent →
ephemeral` flip forces the read-cache rebuild whose `"rebuilt"` path already resets every group's cursor
(full re-stream). During a *deferred* rebuild (owed mutations), the stale durable row is unreachable the
moment routing flips — reads for the now-ephemeral group go to the empty session table — and it dies at the
eventual rebuild. The scope-blind deletes are belt-and-braces on top of this.

### Baseline hygiene

Session-scoped routing is part of the supported 0.2.0 store format. There is no earlier supported
format to sweep or convert; ordinary `"rebuilt"` resets and explicit desync remain responsible only
for current store cleanup.

## Consequences

- The board repro is fixed: a returning session re-streams an ephemeral view from scratch.
- Persistent groups' cursor/tag storage is durable and unaffected (`sessionScoped` defaults `false`).
- No boot work is added — one extra `CREATE TEMP TABLE IF NOT EXISTS` pair inside the existing per-engine
  migrate step — so the warm-boot benchmark shows no measurable delta.
- The invariant is now enforceable by inspection: an ephemeral group's cursor and tags are in `pg_temp`, so
  they cannot outlive the rows they index.

## Implementation

- `packages/client/src/sync/metadata-tables.ts` — `getSessionMetadataTables()` / `pickMetadataTables()`
  (`pg_temp`-qualified, same column builders).
- `packages/client/src/schema.ts` — `renderCreateTableSql(table, { temp })` bare-name TEMP DDL.
- `packages/client/src/sync/subscription-state.ts` — session DDL in the migrate step; `sessionScoped`
  routing on read/update; scope-blind `deleteSubscriptionState`.
- `packages/client/src/sync/tags.ts` — `sessionScoped` routing on the tag helpers; scope-blind
  `buildClearShapeTagsSql`.
- `packages/client/src/sync/index.ts` + `packages/client/src/sync/types.ts` — thread `sessionScoped`.
- `packages/client/src/shape-sync.ts` — pass `group.retention === "ephemeral"` at the start site.

References: [ADR-0021](0021-lazy-ephemeral-sync-lifecycle.md) (lazy/ephemeral lifecycle; §3 makes the cluster
`TEMP` — this ADR completes it for the sync metadata);
[ADR-0023](0023-subquery-move-out-tagged-reconciliation.md) (the `shape_row_tags` reason-set store scoped
here); [ADR-0028](0028-own-the-sync-engine-outright.md) (the metadata-store relations);
[ADR-0029](0029-registry-item-driven-ingest-engine.md) (D3 single-source pgTables the session variants
reuse); [ADR-0041](0041-staged-boot-readiness.md) (the warm persisted store lane that surfaced the bug).
