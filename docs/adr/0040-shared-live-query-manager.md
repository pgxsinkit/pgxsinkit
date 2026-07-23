# A worker-owned live-query manager: awaited teardown, deduplication, and bounded keep-alive

Status: accepted (2026-07-13)

Every `subscribeLiveRows` call today creates its own PGlite live query. In the SharedWorker
(ADR-0032) that means N tabs mounting the same hook create N registrations, N worker-side diff
states, and N full-SQL reruns per relevant write — the engine, store, Electric streams, and
convergence loop are deduplicated, but live SQL subscriptions are not. Separately, GenreTV's
route-navigation profiling showed that *recreating* a live query on every route visit costs hundreds
of milliseconds inside PGlite `live.query` materialization even when the local data is already
present and the network is idle (≈384–401 ms for an empty aggregate; ≈470 ms cumulative for three
serially recreated canonical subscriptions — versus 4–31 ms when the queries were kept mounted).
GenreTV solved this at the app layer by lifting a small fixed hot set of queries into root
providers, which is sound for a bounded set but does not generalize: indefinite retention of
arbitrary parameterized queries is an unbounded cache, and it does nothing about the N-tabs
multiplication.

There is also a live correctness bug in the teardown path. PGlite `close()` racing an in-flight
fire-and-forget live `unsubscribe()` leaves the process permanently wedged (repro'd against
`@electric-sql/pglite` 0.5.4; upstream report drafted). The worker's `close()` does exactly that
shape today: it fires every `liveSubs` unsubscribe synchronously and immediately `stop()`s the
client. The in-process seam's `unsubscribe` is equally fire-and-forget.

Three independent lifetimes must not share one overloaded "retention" concept: **shape lifetime**
(registry `subscription`/`retention` — Electric consistency-group activation, untouched by this
ADR), **local SQL live-query lifetime** (the PGlite registration + diff state + materializer — this
ADR), and **domain projection lifetime** (app-built models over live rows — the consumer's,
unmanageable by the library).

## Decision

1. **Live-query teardown becomes owned and awaited.** Every live registration's `unsubscribe()`
   promise is retained. Ordinary unsubscribe/port-detach stay non-blocking for the caller, but the
   pending promises are tracked, and `close()`/`stop()` awaits all of them **before**
   `pglite.close()` / `client.stop()`. This is a standalone bug fix (the close-vs-unsubscribe hang)
   and ships first, independent of everything below. The macrotask-tick workaround in tests is
   removed once this lands.

2. **A worker-owned `LiveQueryManager` deduplicates identical live queries.** One PGlite
   registration per canonical query fingerprint per engine; any number of subscribers — keyed
   `(port, queryId)` — consume it. One PGlite listener computes one diff (`computeLiveDiff` over one
   shared `LiveDiffState`) and fans it out per subscriber. A new subscriber's initial snapshot is
   served from the entry's current rows (the diff state's insertion-ordered `previous` map — no
   second row copy is kept). Setup and teardown are single-flight: concurrent subscribes to one
   fingerprint share one setup promise; a resubscribe during teardown awaits the teardown and then
   creates a fresh entry; a failed setup removes the entry and rejects every waiter. Closing one
   tab can never tear down a query another tab still uses. **The bridge protocol is unchanged** —
   `subscribe`/`unsubscribe`/`live-initial`/`live-diff`/`live-hydrated` stay per-`queryId`; the
   dedup is entirely worker-internal.

3. **The fingerprint covers execution-relevant inputs only — `use` is excluded.** Fingerprint =
   the **post-wrap** materialized SQL (`wrapLiveQueryForMaterialization` output, which already
   embeds the field aliases) + a stable **typed** encoding of the bound params + the key mode
   (`pkColumns` and therefore `live.incrementalQuery` vs `live.query`). The param encoding is
   computed worker-side over the decoded (structured-cloned) values and is tagged by type — a
   `Date` must never collide with its ISO string, a `Uint8Array` never with its base64 text.
   Activation (`prepareQuery`) and hydration (`hydratingTablesFor` → `groupReady` → refresh →
   `live-hydrated`) remain **per-subscriber pre-steps**, exactly as today: they run before the
   subscriber joins the entry, never affect the registration or its rows, and activation is
   monotonic and engine-global — so differing `use` sets neither split sharing nor threaten
   correctness. A joining subscriber's post-catch-up refresh runs on the shared registration; its
   diff fans out to everyone (strictly cheaper than today's N refreshes), and rows-before-`hydrated`
   ordering is preserved per port because snapshot, diffs, and the hydrated signal travel that
   subscriber's port in sequence.

4. **Zero-subscriber entries may be kept alive, bounded, opt-in, default off.** When an entry's
   subscriber count reaches zero it is retained for a grace period and reused verbatim (fresh
   initial snapshot + fresh per-subscriber hydration) if a matching subscriber returns; otherwise
   it is torn down on expiry or budget pressure. Policy surface:

   ```ts
   defineSyncWorker({
     liveQueries: {
       defaultKeepAliveMs: 0, // default: exact current route-scoped behaviour
       maxRetainedQueries: 16,
       maxRetainedRows: 50_000,
     },
   });
   ```

   plus a per-subscription hint (`keepAliveMs` on `subscribeLiveRows` and the React hook options; an
   optional `SubscribePayload` field whose omission means zero). An entry's effective keep-alive is the
   **max** of the worker default and the hints observed during the current active **generation** (a
   generation opens when subscribers go 0→1 — fresh entry or retained rejoin — and its max is sticky
   until the last-out decision), so equivalent subscriber sets behave identically regardless of
   unmount order. The worker-wide count/row budgets are authoritative over any hint, enforced both
   at retention entry and when a retained entry's rows grow. Only zero-subscriber entries
   participate in (LRU) eviction; active entries are never evicted. All policy fields and hints are
   validated at the public boundary (finite, non-negative; budgets integral) — `Infinity` is
   rejected rather than becoming de-facto permanent retention. The knob is named `keepAliveMs` — never `retention`, which belongs to
   the shape lifetime. **There is no permanent-retention concept**: permanence is holding an active
   subscriber, which is exactly the app-level root-provider pattern (GenreTV's) and remains the
   endorsed mechanism for a fixed hot set. A retained zero-subscriber entry still pays a full SQL
   rerun + diff per dependent-table write (PGlite live queries cannot be paused, only torn down) —
   the standing argument for keeping the default at `0`.

5. **Diagnostics live inside the manager.** Per-entry: an opaque fingerprint digest, subscriber and
   distinct-scope counts (the worker passes one scope per port, so scope count reads as distinct
   tabs), dedup-hit count, row count, setup duration, refresh count / last / cumulative / max
   durations, created-at / last-used monotonic stamps, zero-subscriber duration, and pending
   teardown state. The snapshot covers live entries only — a completed teardown failure is a
   one-shot event, surfaced as a `teardown-failed` debug-rail line (which buffers and replays),
   never as a snapshot tombstone. Surfaced two ways: debug-rail events (register / dedup-hit /
   retained / evicted / teardown) and an explicit snapshot RPC (`liveQueryDiagnostics`) for tests
   and support tooling. Neither carries
   SQL text, bound values, or result rows — fingerprint digests and counts only. A perf-lab bench
   decomposes the observed ~400 ms setup (plain execution of the same SQL vs `live.query`
   registration) **before** any nonzero keep-alive default is ever reconsidered — if setup cost ≈
   one query execution, a write-hot retained query pays it per write anyway, and the right consumer
   fix is the query, not retention.

6. **The in-process client adopts the same manager.** Same module, same single-flight and awaited
   teardown, same keep-alive semantics — it cannot deduplicate across tabs, but it deduplicates
   identical hooks within one client and keeps one lifecycle contract across both client forms.

7. **Manager lifetime = engine lifetime; no suspend/replay machinery.** Exports never touch the
   live engine (ADR-0035 addendum: throwaway clone), the worker has no in-place engine restart, and
   restore only rides the first boot attach — so the manager is created with the engine and
   disposed (awaiting all teardowns) with it. Auth/store replacement builds a new engine and
   therefore a new manager; entries can never leak across engines.

## Alternatives considered

- **App-owned permanent providers only (status quo).** Solves repeat setup for a fixed hot set and
  keeps domain projections next to their rows, but leaves identical queries duplicated across tabs,
  makes every consumer invent retention conventions, and puts route structure in charge of data
  lifetime. Retained as the *pattern for permanence* (decision 4), rejected as the whole story.
- **Observability only.** Lowest risk, but removes neither the setup delay nor the tab
  multiplication, and a separate long-lived diagnostics endpoint would outlive its usefulness —
  folded into the manager instead (decision 5).
- **Retain result snapshots, not registrations.** Destroy the PGlite query on last unsubscribe but
  keep its rows to paint instantly while a fresh query builds. Rejected: the local database *is*
  the durable cache; a stale row cache weakens the current/live semantics the hydration seam
  guarantees (rows-before-ready), needs an explicit staleness contract, and still pays the
  hundreds-of-ms setup on the SharedWorker.
- **`use` in the fingerprint (sorted).** Considered as the conservative key; rejected because
  activation and hydration are per-subscriber pre-steps that never influence the registration —
  keying on `use` would only split sharing (see decision 3).
- **Incremental queries (`pkColumns`) as the fix.** Backlog 0005's analysis stands: two full
  temporary state tables, ordering/key constraints, extra teardown surface, narrow benefit. Query
  retention and incremental execution stay separate decisions; the hooks continue not passing
  `pkColumns`.

## Consequences

- The recorded PGlite close/unsubscribe hang is fixed at the library layer regardless of the
  upstream issue's fate; the test-suite macrotask workaround goes away.
- N tabs on identical hooks converge to one PGlite registration, one rerun + one diff per write,
  fanned out N ways — the largest current multi-tab cost disappears without any consumer change.
- `keepAliveMs: 0` is the default because a retained zero-subscriber entry is standing SQL that
  re-runs on every write and holds worker memory: keep-alive is a bounded, deliberate opt-in, never
  a surprise cost. Opting a hot query into a grace period is a one-line hook option instead of a
  provider restructuring.
- New public surface to document and keep stable: the `liveQueries` worker/client policy block, the
  `keepAliveMs` hint, and the diagnostics snapshot shape.
- The manager adds lifecycle states (setup / active / retained / tearing-down) that must hold under
  the existing hydration guarantee (rows-before-`hydrated` per subscriber) — covered by the unit,
  browser, and lifecycle test matrix in the implementation plan.
- GenreTV keeps its root providers (they are the endorsed permanence pattern and a real comparison
  workload); no downstream migration is required.
