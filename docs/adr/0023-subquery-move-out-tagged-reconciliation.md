# Subquery move-out: applying Electric's tagged-subquery eviction in the local store

Status: accepted (2026-06-28) — Slices 1 & 2 implemented and tested (Electric 1.7.4)

## Context

pgxsinkit's membership-style read filters are Electric **subquery `where`** shapes — e.g. the board
demo's issue filter `team_id IN (SELECT team_id FROM team_member WHERE user_id = $sub)`. Adding a
membership fans the now-visible rows **in**; removing a membership is supposed to fan them **out** of the
removed member's local store. The fan-out (move-in) works. The fan-out **out** (move-out) does not: after
an admin removes a member from a team, that member keeps the team's board + tickets in their local PGlite.
This is a correctness **and security** gap — revoked read access persists offline.

### The bug is ours, not Electric's

A minimal, self-contained reproduction against **plain Postgres + Electric 1.7.4** (no pgxsinkit, no
Supabase) hitting the HTTP shape API directly proves Electric signals both directions on a live shape
([`tmp/agents/electric-subquery-moveout/`](../../tmp/agents/electric-subquery-moveout/), `./run.sh`):

- **Add membership** → an `event: "move-in"` message **and** an `insert` carrying the row's `tags`.
- **Remove membership** → an `event: "move-out"` message carrying `patterns`.

Captured wire messages (Electric 1.7.4, `ELECTRIC_FEATURE_FLAGS=allow_subqueries,tagged_subqueries`):

```jsonc
// the insert that brought item1 in — note `tags` and `is_move_in`
{ "key": "\"public\".\"items\"/\"item1\"",
  "value": { "id": "item1", "room_id": "growth", "body": "secret ticket" },
  "headers": { "operation": "insert", "is_move_in": true,
               "active_conditions": [true],
               "tags": ["3252d9cab8268bc76ce21e7015cf7d35"] } }

// the move-out, when the membership row was deleted — `patterns.value` == the row's tag
{ "headers": { "event": "move-out", "txids": [751],
               "patterns": [ { "pos": 0, "value": "3252d9cab8268bc76ce21e7015cf7d35" } ] } }
```

The reason the local store never evicts the row: the sync engine
([`packages/client/src/sync/index.ts:480-506`](../../packages/client/src/sync/index.ts)) handles only
`isChangeMessage` (buffer) and `isControlMessage` (`up-to-date` / `must-refetch`). An **`EventMessage`**
(`headers.event === "move-out" | "move-in"`) is **neither**, so it falls through both guards and is
silently dropped. `MultiShapeStream` *does* deliver the event to our callback (it spreads every message
and adds `.shape`), and `@electric-sql/client@1.5.22` *types* `EventMessage`/`MoveTag`/`MovePattern` — but
its runtime ships **no** move-out logic and its high-level `Shape` materialiser (which we don't use; we
materialise into PGlite with overlay/journal semantics) is the only place it would have lived. So the
consumer owns the reconciliation, and ours doesn't implement it.

A failing integration regression already exists:
`tests/integration/membership-fanout.integration.test.ts` → *"revokes a member's rows from their LIVE
shape when their membership is deleted (move-out)"*. It fails today for the right reason (the event is
dropped) and is the acceptance test for this ADR.

### The tagged-subquery protocol (the contract we must implement)

From the wire evidence and `@electric-sql/client`'s type doc-comments:

- A change message for a subquery shape carries **`tags: MoveTag[]`** — the set of *reasons* the row is in
  the shape (each tag ≈ one membership/grant). `removed_tags: MoveTag[]` on an update lists tags the row
  *lost*. `active_conditions: boolean[]` mirrors which subquery conditions matched.
- A **`MoveTag`** is a string of per-condition columns. **The column separator on the wire (Electric 1.7.4)
  is `/`, not the `|` the upstream type doc mentions** (confirmed by the captured messages — a row in a
  two-condition shape carries e.g. `"<grant>/1//"` *and* `"//<grant>/<grant>"`). Width is fixed per shape;
  `\/` is a literal `/`.
- A **`move-out` `EventMessage`** carries **`patterns: { pos, value }[]`**. The revoked grant can sit at more
  than one column (one per condition that references it), so the event enumerates those positions and a tag
  is withdrawn if it carries the value at **any** of them. A row is evicted only when **every** tag keeping
  it in the shape is withdrawn (a row held by an independent second grant survives).
- A **`move-in` `EventMessage`** precedes the `insert`(s) that bring the newly-matched rows; the rows
  arrive as ordinary inserts carrying their `tags`, so move-in is *already* handled by the insert path —
  except that we must now **persist the tags**.
- Move/​event messages carry **no `lsn`/`last`** header (only `txids`). They sit between change messages
  and the shape's `up-to-date` (whose `global_last_seen_lsn` is the commit boundary).

## Decision

1. **Add a third branch to the engine's message loop for `EventMessage`.** Alongside `isChangeMessage` /
   `isControlMessage`, detect `"event" in message.headers`. `move-out` buffers its `patterns` against the
   shape (a new `inbox` channel, mirroring `ingestChange`); `move-in` is a no-op for eviction (its rows
   arrive as tagged inserts). No event is ever silently dropped — an unknown `event` value logs and is
   surfaced, never ignored (the ADR-0006 "never silently lose" rule).

2. **Persist each synced row's tag-set in a side table, not a column on every synced table.** **Built as a
   single metadata table** `pgxsinkit.shape_row_tags(shape_table, pk_json, tag, PRIMARY KEY (shape_table,
   pk_json, tag))`, created once in `migrateSubscriptionMetadataTables`. *(The plan said one
   `<syncedTable>_tags` table per subquery shape; one shared table is simpler and avoids per-table DDL — and
   it must be created for **all** synced tables, not "only subquery shapes", because the **client** config
   does not carry the `customWhere` (the server proxy owns filtering), so the client cannot know which
   shapes are subquery shapes. A non-subquery shape simply never writes a row — its changes carry no
   `tags`.)*
   - *Why a side table over a `__tags text[]` column:* set semantics (add/remove/​count-remaining) are
     natural as rows; it keeps the move-out GC a clean delete of rows left with no tag; and it avoids
     touching every synced table's DDL, the COPY/JSON/INSERT bulk appliers, the reconcile trigger, and the
     overlay read-model view (which would all have to learn to carry/​hide the column). The cost is one
     extra write per *tagged* change and a tag lookup on move-out.

3. **Apply move-out at the shape's `up-to-date` boundary, inside the existing commit transaction.** Because
   the event has no LSN, it cannot key the LSN-ordered inbox. Instead, buffered move-out patterns for a
   shape are drained and applied in the **same `commitUpToLsn` transaction** that advances the frontier to
   the `up-to-date` that follows them — after the fold's DELETE/INSERT/UPDATE for that shape. This keeps
   eviction atomic with the surrounding changes and the subscription-state advance, so a retried/rolled-back
   commit never half-evicts. The move-out step: withdraw the matched tag from `_tags`, then delete synced
   rows with no remaining tag — both inside the txn, both firing the existing reconcile trigger so the
   overlay/read-model stays consistent.

4. **Matching is per-tag-component, eviction is per-empty-tag-set.** A tag is withdrawn if it carries the
   revoked value at **any** of the event's pattern positions — its `pos`-th component (split on unescaped
   `/`, the wire separator — see the protocol note) equals `value`. Then any row left with no tag in
   `shape_row_tags` is deleted from the synced table. The composite / multi-grant / any-position path is
   implemented (the board's two-condition shape exercises it), not deferred (see Alternatives).

5. **Maintain the tag-set on every change.** Insert/update: `tags` is the authoritative current reason-set,
   so replace the row's entry; `removed_tags` (without `tags`) deletes just those. Delete: drop the row's
   tags. Done as a tag-sync pass over the raw drained batch in `commitUpToLsn`, before the data apply and
   the move-out eviction (so an add-then-remove within one commit resolves correctly).

6. **`must-refetch` / desync rebuild tags from scratch.** The `truncate` on `must-refetch` (and the ADR-0006
   read-cache rebuild) also clears the shape's tags, so a fresh snapshot repopulates them; `desync`
   (ADR-0021) clears them too. A *resumed* subscription keeps its tags (consistent with its kept synced
   rows) and replays the move-out on catch-up (Slice 2).

7. **Scope: subquery shapes only; everything else is untouched.** A non-subquery shape emits no tags and
   no move-out events, so it gets no `_tags` table and no new code path — zero behaviour change for the
   bulk of the registry.

## Alternatives considered

- **`__tags text[]` column on the synced table** — rejected as the default (decision 2): it spreads the
  protocol across DDL + every bulk applier + the reconcile trigger + the overlay view, for a feature that
  only subquery shapes use. Kept in reserve only if the side-table join proves a measured hot path.
- **Naive "any move-out → delete matching rows", ignore multi-grant** — rejected. It passes the board
  (single-grant per row) but is wrong in general: a row visible via two memberships would vanish when only
  one is removed. The side-table set model makes the correct version no harder, so we do it right.
- **Apply move-out immediately on receipt (outside the commit)** — rejected: breaks atomicity with the
  surrounding changes and the frontier/subscription-state advance; a crash mid-eviction could leave the
  store inconsistent or re-evict on resume.
- **Treat move-out as a `must-refetch`** (drop + re-snapshot the whole shape) — rejected as the steady-state
  mechanism: correct but a sledgehammer (re-streams the entire shape on every membership change). Kept as
  the **fallback** if a malformed/unknown event is seen.

## Delivery — two slices, both required (neither is optional)

Revocation must hold whether or not the client was watching when it happened. The work splits into two
slices **both of which land under this ADR with their own passing integration test** — the offline case is
*not* parked and *not* a maybe. Slice 2 may follow Slice 1, but it is a committed deliverable, not a
"follow-up".

### Slice 1 — live move-out (client watching at the moment of revocation)

The design above (decisions 1–7). Steps:

1. **Debug spike (confirm the lib-surfaced shape):** temporarily log the exact `EventMessage` object our
   loop receives via `MultiShapeStream` running the failing integration test against Electric 1.7.4 — confirm
   `headers.event`, `patterns`, absence of `lsn`, and `.shape`. Revert the logging. *(De-risks decision 3.)*
2. **Metadata store:** emit the single `shape_row_tags` table in `migrateSubscriptionMetadataTables`
   (`subscription-state.ts`); teach the `must-refetch` truncate **and** `desync` (`buildDesyncTableSql`) to
   clear it.
3. **Inbox:** add a per-shape move-out-pattern buffer + drain (`shape-inbox.ts`).
4. **Engine loop:** the `EventMessage` branch (`sync/index.ts`); tag-sync + buffered move-out eviction in
   `commitUpToLsn`; the commit loop fires on a pending move-out.
5. **Tag module (`sync/tags.ts`):** the matcher + pk serializer + tag-sync / eviction / clear helpers,
   evicting via the existing bulk-delete path.

**Acceptance:** the existing `membership-fanout.integration.test.ts` → *"revokes a member's rows from their
LIVE shape …"* goes green, plus unit tests for composite-tag matching and the multi-grant
survive-on-partial-removal case.

### Slice 2 — offline / resumed revocation (categorically required, with its own test)

**The case:** a member is removed while their client is shut down, the shape is dormant, or the network is
down. On reconnect the local store **must converge to "no access"** — a revoked member must never resume
into a stale board + tickets. This is the security-critical half and is **mandatory**; Slice 1 alone does
not establish it.

Three sub-cases, each to be **proven by test**, and any gap closed in this slice:

- **Resume-from-offset replay (handle still valid):** the shape resumes from its persisted offset and
  Electric replays the durable log from that point — which *includes* the move-out event — so Slice 1's
  handling evicts on catch-up. *Test:* sync → receive the item (tags persisted) → `unsubscribe` (simulate
  offline) keeping the local store → delete the membership server-side → re-subscribe on the **same** store
  → assert the rows are evicted after catch-up.
- **Handle expiry / log compaction:** Electric answers the resume with `409`/`must-refetch`; the engine
  truncates and re-snapshots, and the fresh snapshot reflects current membership (member absent → rows
  absent). *Test/assert:* the `must-refetch` path also clears `_tags` and the synced rows (decision 6),
  so a compacted-handle resume converges, not retains.
- **Dormant lazy shape (ADR-0021):** a relation that was never re-activated cannot silently retain revoked
  rows. *Define + test* the reconcile point (on re-activation, and/or at boot for persistent groups) so a
  lazy/ephemeral group that missed the live move-out is brought current before it is read.

**Acceptance:** a new integration test *"revokes a member's rows across an offline gap (resume)"* (the
resume sub-case), plus assertions for the must-refetch and lazy-dormant sub-cases. If any sub-case proves
Electric does **not** converge a resumed client on its own, Slice 2 adds the boot/activation reconcile that
makes it converge — this slice is not done until an offline revocation is provably evicted.

**Outcome (built + tested against Electric 1.7.4):**

- **Resume replays the move-out — proven, no new code needed.** The integration test
  *"revokes a member's rows across an OFFLINE gap … evicted on resume"* (`membership-fanout`) syncs,
  `unsubscribe`s (offline), deletes the membership server-side, then re-subscribes on the **same** store:
  the resume from the persisted offset replays the `move-out`, and Slice 1's handling evicts it. So the
  needed "reconcile point" *is* the existing resume/activation path — no boot reconcile was required.
- **Lazy-dormant is the same mechanism.** A lazy *persistent* relation re-activates by resuming from its
  persisted offset (identical to the test above → replays the move-out). A lazy *ephemeral* relation, and a
  `desync`, drop the subscription and re-stream a **fresh snapshot** that already reflects current
  membership. So a dormant group cannot retain revoked rows — by resume-replay or by fresh snapshot.
- **`must-refetch` and `desync` clear the tag store.** The engine clears a shape's tags on the
  `must-refetch`/rebuild truncate (decision 6); `buildDesyncTableSql` clears them too (guarded by
  `to_regclass`, so a standalone schema build is unaffected) — so a re-snapshot rebuilds tags with no
  orphans. Unit-tested (`clearShapeTags`, the guarded desync SQL) alongside the composite-tag matcher and
  the multi-grant survival case.

## Consequences

- Membership revocation correctly evicts board + tickets — **live (Slice 1) and across an offline gap
  (Slice 2)** — closing the security gap with no Electric change and no fallback that violates the
  "subqueries are a hard requirement" stance.
- A new, small, subquery-only local-store table and write path. Bounded, isolated, off the path for every
  non-subquery shape.
- The direct-Electric repro ([`tmp/agents/electric-subquery-moveout/`](../../tmp/agents/electric-subquery-moveout/))
  is kept as a documented artifact and the basis of an upstream-quality protocol reference.
