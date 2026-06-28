# Internalize the read-path sync (break with pglite-sync)

Status: accepted (2026-06-22); implemented

[ADR-0007](0007-absorb-sync-engine.md) absorbed the thin `sync-engine` wrapper into
the client but **kept** `@pgxsinkit/pglite-sync` as a "vendored Electric adapter
against upstream churn" (its decision 2). That boundary has stopped paying for
itself: upstream is effectively unmaintained, there is no value in staying
wire-compatible with it, and the package's design carries real reliability and
performance debt that we cannot fix while pretending it is someone else's code.

Three findings from reading the vendored source (`packages/pglite-sync`,
~1,075 lines) and its single consumer (`client/src/shape-sync.ts`):

1. **The headline feature is unused.** `shape-sync.ts` calls `syncShapeToTable`
   once per table (`Promise.all` over specs), so each table is an independent
   single-shape stream with its own LSN frontier. `MultiShapeStream`'s cross-shape
   transactional engine — the whole reason it exists — never runs. Related tables
   (`discussion`+`post`, group+membership) can land in **separate** transactions, so
   a reactive local reader can briefly see a post whose parent row has not arrived.

2. **The commit loop is fire-and-forget.** `index.ts` runs
   `void commitUpToLsn(lowestCommittedLsn)` followed by a single `setTimeout(0)`
   yield. Because `MultiShapeStream._publish` *awaits* the subscribe callback, the
   detachment is deliberate (don't stall the network reader behind the DB), but it
   costs: overlapping `pg.transaction()` calls on a single-connection PGlite while
   they mutate a shared `changes` buffer; an **unhandled rejection** on commit
   failure (it reaches neither `onError` nor the runtime, yet `isUpToDate` can still
   flip — the read cache can silently diverge); and an unbounded buffer. `onError`
   is never even wired by `shape-sync.ts`, and the `degraded` runtime phase is
   never set. There is effectively no sync-error surfacing today.

3. **The apply path re-implements identifier quoting** (`'"'+s+'"'`) instead of the
   [ADR-0004](0004-one-registry-interpreter.md) shared resolver — the exact
   multi-implementation drift ADR-0004 eliminated everywhere else — and its three
   strategies (`COPY`, `json_to_recordset`, batched `INSERT`) are reachable only
   through dead options; we always run `INSERT`, querying `information_schema` at
   runtime for the json path we never take.

None of this is incompetence — it is an upstream codebase optimised for a different
consumer. But we are the only consumer, we know our registry's column types ahead of
time, and we only ever target the latest PGlite. Owning it lets us be more correct,
faster, and more nimble.

## Decision

1. **Delete `@pgxsinkit/pglite-sync`; fold its engine, applier, and
   subscription-state into `@pgxsinkit/client` as internal modules.** Drop it from
   the publish set (5 → 4 public packages), the build/release list, the tsconfig
   path map, and the `apps/web` Vite alias — exactly as ADR-0007 did for
   `sync-engine`. This **supersedes ADR-0007 decision 2**: the vendoring boundary is
   dissolved, not maintained. We keep depending on `@electric-sql/client` and
   `@electric-sql/experimental` — **we still sync with Electric**; we own the ingest
   glue, not the replication protocol.

2. **Adopt cross-shape consistency via registry-declared consistency groups.** A
   `consistencyGroup` on a synced table binds it with its peers onto one
   `MultiShapeStream` that commits atomically at a shared LSN frontier, so the local
   read cache never shows one table in a group advanced past another for the same
   server transaction. The default is a **per-table singleton group** (today's
   independent-frontier behaviour), so grouping is opt-in and the latency cost — a
   group advances only as fast as its slowest shape — is contained to the tables
   that asked for atomicity. Subscription resume and the [ADR-0006](0006-local-schema-evolution.md)
   `dropReadCache`/rebuild become **group-granular** (a group is one stream = one
   subscription-state row whose `shape_metadata` already maps per-shape).

3. **Choose the apply strategy statically from registry column types.** Per table,
   computed once: every column in the conservative COPY-safe scalar whitelist →
   `COPY`; else every column in (COPY-safe ∪ array/json/jsonb) → `json_to_recordset`
   (viable now that the latest PGlite fixed bigint and bigint-array round-tripping);
   else → batched `INSERT` (the always-correct floor for anything not positively
   whitelisted). No `information_schema` round-trip and no runtime probing — we own
   the types. The one discipline: never add a type to the COPY-safe set unless
   PGlite's `COPY` truly handles it. The `mapColumns` capability is kept but driven
   from the registry projection (the existing `clientProjection`), not an ad-hoc
   per-call function, so it cannot drift.

4. **Replace the detached commit with a serialized, single-flight commit queue.**
   The subscribe callback stays fast — buffer + advance frontier (synchronous),
   enqueue, return — so the network reader is never stalled (the original goal is
   preserved). A commit chain guarantees **one transaction at a time** (no overlap,
   no shared-buffer race), **coalesces** (one transaction absorbs all LSNs buffered
   while it waited — better batching than one-commit-per-message), enforces a
   **bounded buffer** high-water mark, and tracks a **running** committed frontier
   (the current `lastCommittedLsn` is a boot-time `const` that is never advanced).

5. **Surface sync failures; never diverge silently.** A failed commit retries with
   jittered backoff (reusing the write side's `computeRetryDelayMs`); on exhaustion
   the runtime enters the `degraded` phase and fires an `onSyncError` callback,
   holding the buffer and frontier — `isUpToDate` never flips on an unapplied
   commit. Electric's own `must-refetch` control stays an independent path
   (truncate + re-stream); we do not conflate our commit errors with shape
   invalidation. This builds the error path that does not exist today.

6. **Keep the sync-origin discriminator, renamed to a pgxsinkit-owned namespace.**
   The `SET LOCAL electric.syncing = true` GUC inside the sync transaction is a real
   seam — it lets a consumer trigger tell sync-origin writes apart from user-origin
   writes (audit, outbound-capture, derived-table maintenance), even though our
   reconcile trigger deliberately fires on both. Rename the metadata schema (and
   therefore the GUC) from `electric` to a pgxsinkit-owned name, since this is our
   local bookkeeping, not Electric's. Cosmetic but correct now that we own it.

## Consequences

- One fewer published package; the read-path engine is fully ours to evolve with no
  upstream-compatibility constraint.
- Cross-table consistency becomes available exactly where it matters (forum,
  rostering) without imposing the slowest-shape tax globally.
- Sync failures finally surface (`degraded` + `onSyncError`); the read cache can no
  longer silently diverge from the server.
- The apply performance ladder is ours to tune against the PGlite we actually ship.
- Cost: a meaningful rewrite of the ingest loop and a new consumer-facing registry
  knob (`consistencyGroup`), which the [ADR-0006](0006-local-schema-evolution.md)
  registry-diff/lock surface must account for.
- Supersedes ADR-0007 decision 2; ADR-0007's other decisions (absorb the wrapper,
  re-establish a seam only when real) stand.

References: [ADR-0004](0004-one-registry-interpreter.md) (shared identifier
resolver, fingerprint); [ADR-0005](0005-mutation-convergence.md) (`computeRetryDelayMs`,
`degraded` phase, convergence symmetry); [ADR-0006](0006-local-schema-evolution.md)
(group-granular `dropReadCache`, registry-diff/lock); [ADR-0007](0007-absorb-sync-engine.md)
(superseded decision 2); `CONTEXT.md` (Read path, Sync applier, Consistency group);
[docs/plans/0009-internalize-read-path-sync.md](../plans/0009-internalize-read-path-sync.md).
