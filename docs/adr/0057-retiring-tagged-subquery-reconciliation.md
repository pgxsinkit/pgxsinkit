# Retiring tagged-subquery reconciliation

Status: accepted (2026-08-20) — supersedes [ADR-0023](0023-subquery-move-out-tagged-reconciliation.md)
and [ADR-0024](0024-subquery-move-in-snapshot-rows.md)

## Context

ADR-0023 and ADR-0024 exist because of one Electric behaviour, named in both their titles: when a
row left or entered a shape because a **subquery membership** changed elsewhere, the row itself did
not change, and Electric emitted nothing. The client had to *infer* the eviction. ADR-0023
reconstructed it from tag patterns; ADR-0024 handled the inverse, materialising rows that had
silently become visible.

That machinery is substantial — `packages/client/src/sync/tags.ts` (390 lines), tag tables in the
generated local schema, and a tag sync shape per subquery-filtered table — and it is inference, not
observation. Inference is why its failure mode is silent: a revocation that is not reconstructed
leaves a row the client should no longer hold, with no error anywhere.

ADR-0055 changes both halves of the premise.

**The shared tier has no subqueries at all.** A shared shape's predicate is generated as equality
over declared scope columns of the row itself (`offering_id = $1`). A row leaves that shape only when
its own scope column changes, which is an ordinary update, which produces an ordinary delete. The
entire eviction class tags were built for cannot arise there — structurally, not by good fortune.

**The private tier keeps subqueries, but Circuits states the eviction rather than implying it.**
`delete_envelopes()` in `engine/output.rs` exists precisely for this: *"the feed relation's
retraction IS the delete decision (structural spurious-delete gating)."* Where Electric emitted
silence, Circuits emits a delete.

Under ADR-0055 there is also a genuinely new eviction path that tags never covered: losing
*entitlement* to a shared shape, which is a subscription-level event (403 → truncate that scope and
unsubscribe), not a row-level one.

## Decision

1. **Tag reconciliation is retired.** `tags.ts`, the tag tables in the generated local schema, and
   the per-table tag sync shapes are removed. Nothing infers an eviction any more; evictions are
   read off the stream.

2. **The shared tier could never have needed it**, so this is not a capability trade there. No
   shared-tier shape emits tag tables, and the schema generator does not branch to decide — the
   construction has no subquery to reconcile.

3. **The private tier's evictions come from explicit deletes**, verified across the offline gap
   rather than assumed (see below). A key-only `delete` envelope carries no row body, so the eviction
   itself discloses nothing — an improvement on tag reconstruction, which had to reason about rows it
   still held.

4. **Shape-level revocation is the new sibling path, and is not a substitute.** Losing entitlement
   evicts a whole scope; a predicate move-out evicts a row. Both exist, they are triggered
   differently, and both must be tested. Retiring tags does not reduce the eviction surface to one
   path.

## Proving it

A native stack — Postgres 16 with logical replication, `durable-streams-server-rust` 0.1.5 from the
published image, and the engine — with subquery shapes created through the native `POST /shapes`
predicate AST (no SQL text anywhere) and read directly from durable-streams by offset.

Every identifier is generated per iteration. This is not hygiene: ADR-0023's own regression history
shows that reusing ids leaves a key's earlier inserts and deletes in the shape log, so a resume folds
a key set that already contains the key — accumulated history makes a *dropped* revocation still look
correct. Fixed ids would have made this experiment incapable of failing.

| Scenario | Supersedes | Result |
|---|---|---|
| Row visible, membership revoked while offline, client resumes from its persisted offset | ADR-0023 | explicit `delete` delivered — **3/3** |
| Row not visible, membership granted while offline, client resumes | ADR-0024 | row materialised on resume — **3/3** |

Three iterations, several shapes coexisting on one engine. The observed envelopes also confirm the
wire facts ADR-0056 depends on: a backfill row carries `{"operation":"upsert"}` with neither `lsn`
nor `txid`, and a feed-retraction delete carries `txid` but no `lsn`.

Harness: `tmp/agents/circuits/tags-native-v2.sh` — boots the stack from scratch and is re-runnable.

**Not covered, and recorded as such:** engine restart across the gap (the delete is already durable
in the stream before the client returns, so the resume should not care, but that is an argument
rather than a measurement); live online move-out/move-in on the native path (exercised earlier only
against the compatibility adapter); and the shared tier, whose case is structural and was not
measured.

## Consequences

- **390 lines plus generated tag DDL and one sync shape per subquery-filtered table are removed.**
  Under ADR-0055's K:1 subscription model those shapes would have multiplied per scope, so this
  compounds rather than being a one-off saving.
- **An inference becomes an observation.** The failure mode changes from "the reconstruction was
  wrong and a row silently stayed" to "the delete did not arrive", which the ADR-0056 barrier can
  detect (`pendingFlips > 0` means an eviction is computed but undelivered) instead of hiding.
- **The eviction paths must be tested separately.** Row-level move-out and scope-level revocation
  have different triggers and different blast radii; a shared test would prove neither.
- **This is a one-way door with Electric.** The tag machinery was Electric's shape of the problem;
  removing it forecloses running against Electric even if the read path were otherwise restored.
  ADR-0055 already made that choice.

## Alternatives considered

- **Keep tags as a belt-and-braces second path.** Rejected: two mechanisms for one eviction, one of
  which is inference over data the other states outright. The inferring path would be exercised
  rarely, and rarely-exercised safety code is how the W9-class defect survived — it is a liability,
  not redundancy.
- **Retire tags for the shared tier only, keep them for the private tier.** Rejected once the
  private tier was measured. It was the right hypothesis before the evidence and would have kept the
  full machinery, since the private tier is where subqueries live.
- **Defer removal until after implementation.** Rejected: whether a shared-tier table emits tag
  tables is a branch in the schema generator, so it had to be settled before that code was written.
  Deferring would have meant building the K:1 apply path to route tag streams it never needed, and
  measuring a system carrying weight already known to be dead.
