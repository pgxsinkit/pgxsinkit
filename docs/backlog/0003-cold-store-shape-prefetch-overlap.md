# 0003 — Cold-store shape prefetch overlap

Status: promoted → adr/0032
Superseded: the reopen trigger fired 2026-07-03 (catch-up measured as the dominant serial term for far users); ADR-0032 decision 5 absorbs the overlap as worker-internal boot ordering. The seam design below remains the reference.
Opened: 2026-07-03 · Area: client-sync
Reopen trigger: post-spare-store boot measurements on real consumers still show the initial
catch-up as the dominant _serial_ term for target users (it no longer is for the board demo), or a
consumer appears that cannot use the spare-store pattern and needs the overlap instead.

## Problem / evidence

On a cold boot, the initial shape catch-up cannot start until the local PGlite store exists,
because the sync engine is a **PGlite extension**: `PGlite.create(dataDir, { extensions: {
electric: … } })` runs the extension setup as part of create, and `syncShapesToTables` — with the
`new MultiShapeStream(...)` that triggers the first network fetch — is a method on that namespace.
The two cold-boot rocks (store create ≈ 1.9s post-WASM-warm; catch-up ≈ 1.0–2.9s depending on
caller geography) were therefore strictly serial.

The spare-store pattern (landed 2026-07-03) removed the create from the post-login critical path
for the board, which is why this overlap is parked rather than built: what remains serial after it
is auth (~0.15–0.9s) + local phases (~0.6s) + catch-up, and the overlap could only hide the local
phases under the catch-up (~0.6s upside).

## The designed seam (verified feasible, escape-hatched as deep restructuring)

Recorded from the implementation attempt so a reopen does not re-derive it:

- (a) a new pg-independent `packages/client/src/sync/prefetch.ts` that buckets the eager groups and
  constructs `MultiShapeStream` + `ShapeInbox` + a buffering subscriber, starting the network
  before `PGlite.create` resolves;
- (b) extract the ingest loop (the pure-memory part of the subscribe callback) into a shared
  function — it currently intertwines ingest with the DB-bound `enqueueCommit()`;
- (c) an **adoption** branch in `syncShapesToTables` that reuses the prefetched
  stream/inbox/`truncateNeeded` and rewires the commit trigger via a mutable hook — adoption, not
  re-subscribe, because the Electric client's `#publish` delivers only to current subscribers with
  **no replay buffer**, so swapping subscribers loses the already-fetched catch-up;
- (d) thread the prefetch handle through `startConfiguredSync`/`startGroupSync`;
- (e) gate on a provably-cold store only: no `pgliteInstance`, `idb://` scheme, and
  `indexedDB.databases()` shows no `/pglite/<path>` entry — anything else takes the exact
  sequential path.

Enabling invariants verified at the time: `reconcileLocalStoreVersion` on a cold store returns
`null` after stamping (no subscription reset), and `isNewSubscription = subState === null` already
matches the cold-prefetch assumption. A `must-refetch` arriving during the warm-up window must
resolve to resetShape + queued truncate applied once the applier attaches.

Risk note: this restructures the most invariant-critical file in the client (ADR-0009/0014/0023/
0024/0031 all live in that path); the failure class is silent cold-boot divergence. That risk/
reward is why it lost to the spare-store pattern.
