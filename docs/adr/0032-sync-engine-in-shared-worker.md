# The whole sync engine moves into a SharedWorker

Status: accepted (2026-07-03) — amended by [ADR-0049](0049-capability-driven-engine-placement.md)
(2026-07-21): the SharedWorker is permanently the attach point and router, but the engine's home is
now capability-probed — in the SharedWorker where its scope grants OPFS sync-access handles (WebKit),
in a Web-Locks-elected tab worker where it does not (Chromium/Firefox). The rejection of leader
election below is narrowed accordingly: election exists on handle-denied platforms only, with
structural (Web Locks) liveness, never heartbeats.

Cold-boot measurement of the board demo established that PGlite executes **on the main thread** —
there is no worker anywhere in the stack. The costs measured: initdb + IDBFS open ≈ 1.9–2.8s of
main-thread WASM per store creation, ~50ms of WASM per query, a first reconcile of ~1.5s versus
~160ms steady-state, all sharing the thread with React. The 2026-07-03 boot lane mitigated the
*create* (spare-store binding hides initdb behind login think-time) but left three structural
facts: every query and commit still janks the UI thread; the spare mint must be carefully fenced
away from a live board (same thread); and the initial catch-up cannot overlap the local boot
phases, because the sync engine is a **create-time PGlite extension** (`PGlite.create(..., {
extensions: { electric } })`) — nothing engine-side can exist before the store does (the blocker
recorded in backlog 0003). Two backlog items — 0002 (PGliteWorker) and 0003 (cold-store prefetch
overlap) — turned out to be the same architecture question. This ADR decides it.

## Decision

1. **The whole engine runs in a worker — not just the database.** PGlite, the local schema, the
   mutation journal machinery, the Electric shape streams, the inbox/commit pipeline, and the
   convergence loop all execute in a worker context. The main thread keeps React, live-query
   results, query building (Drizzle compiles on the tab), auth ownership, and the app-facing API.
   The shared prerequisite — decoupling the engine from the create-time extension into a plain
   module over `PGliteInterface` — lands first and alone, with the unchanged unit suite as its
   equivalence proof.

2. **One shared engine per (user, origin), carried by a native `SharedWorker`.** The worker is
   named by the store id, so the browser deduplicates instances natively: N tabs attach to one
   engine, one store, one Electric connection set, one convergence loop — which also fixes the
   previously unhardened two-tabs-one-store hazard structurally. No leader-election protocol: the
   SharedWorker outlives any individual tab, so there is no "leader died mid-commit" handoff.
   Browsers without `SharedWorker` fall back to the plain **in-process** main-thread client —
   never to a bespoke election layer.

3. **The tab layer stays the single auth owner (ADR-0013 unchanged).** Tabs push
   `{accessToken, expiresAt}` to the worker on every auth state change; the worker uses the cached
   token for shape requests and write flushes, and sends a token-request message only when a
   request finds the token near expiry (any attached tab answers, first response wins). The worker
   never runs its own refresh loop — exactly one refresher exists, so GoTrue refresh-token reuse
   detection can never be tripped by a second client.

4. **API surface: a facade pair, same client shape.** The consumer writes a worker entry calling
   `defineSyncWorker({ registry, electricUrl, batchWriteUrl, … })` — the registry is code and must be
   *imported* by the worker, never cloned into it — and the tab calls `attachSyncClient({ worker,
   registry })`, which returns the same client shape as `createSyncClient` (tables write API,
   Drizzle reads, live rows, status), transparently proxied. `createSyncClient` remains the
   in-process mode for bun tests, Node harnesses, and the fallback of decision 2.

5. **The boot optimizations translate, and the prefetch becomes internal.** The userId→storeId
   registry stays tab-side in localStorage — binding resolves *before* attach, which the
   SharedWorker naming needs anyway. The spare store becomes a **pre-spawned schemaless worker**
   at login-screen mount (create + initdb run inside it, off every thread that matters); claim =
   bind the id, attach, push config + token. The worker then runs the backlog-0003 overlap as a
   purely internal ordering: shape streams start (memory-buffered inbox) the moment config + token
   arrive, in parallel with schema/journal recovery/store-version reconcile — no cross-context
   coordination, and the same seam works in in-process mode.

6. **`ready` keeps its meaning; per-group readiness is exposed.** `client.ready` still means every
   eager group is caught up (a fully-consistent first paint), with the prefetch overlap making the
   gate cheap. The attach client additionally exposes per-group readiness so an app can opt into
   progressive paint without a contract change.

7. **One broadcast event channel crosses the bridge.** Status, group readiness, conflict,
   quarantine, schema-change, and the debug rail all flow worker→tabs on a single typed stream,
   re-exposed by `attachSyncClient` as today's callback options. Debug-rail lines are stamped with
   the **worker's** monotonic clock and origin-tagged (`[pgxsinkit·w …ms]`); each tab prints them
   gated by its own `__pgxsinkitDebug` — a SharedWorker's own console is invisible
   (`chrome://inspect`), so without forwarding the entire operability story goes dark.

8. **Three test tiers.** The unit suite keeps running the decoupled engine in-process (unchanged
   coverage — the sync semantics do not know they moved). The bridge layer (codecs, token cache,
   event fanout, attach handshake) is built around injected MessagePort pairs and unit-tested in
   bun. A Playwright browser lane runs the real SharedWorker against the local stack — two tabs on
   one engine, spare-worker claim, tab-close survival, the boot rail end-to-end — in the same PR
   gate as the existing integration lanes.

9. **Five slices, in order**: S1 engine decoupling (equivalence checkpoint); S2 the worker pair +
   auth + event channel + per-group ready; S3 board adoption (spare-as-worker, registry binds
   pre-attach, browser lane); S4 the in-worker prefetch overlap with before/after rail numbers; S5
   docs/skills wiring and backlog status flips.

## Alternatives considered

- **DB-in-worker only (PGliteWorker), engine stays on main.** The engine survives unchanged and
  every WASM cost leaves the main thread — but shape fetch parsing, folding, and the convergence
  loop stay on the UI thread, every statement pays a structured-clone hop, and the create-time
  extension coupling still has to be broken to get there. Rejected: pays most of the migration
  cost for a fraction of the isolation; this was the recommended middle option and the owner chose
  the full move.
- **Engine per tab (dedicated workers).** Simplest lifecycle, but inherits the two-tabs-one-store
  hazard (now two workers), multiplies Electric connections and convergence loops per tab, and
  keeps the cross-tab locking burden in the store registry.
- **Leader election over dedicated workers.** Needed only where `SharedWorker` is missing; builds
  the hardest lifecycle (handoff of in-flight commits and held long-polls) that the native
  SharedWorker makes unnecessary. The in-process fallback covers those browsers instead.
- **Per-request token pull.** Today's `getAuthToken` semantics stretched over the bridge — adds a
  main-thread round trip to every long-poll cycle and write, re-coupling sync latency to a busy
  React thread.
- **No worker; prefetch overlap only (backlog 0003 alone).** Cheapest path to the far-user boot
  win, but initdb and query WASM keep janking the UI, and the spare mint stays a main-thread
  hazard to fence.

## Consequences

- The main thread's PGlite WASM cost goes to zero (queries, commits, initdb, reconciles); tabs
  become thin views over one engine.
- Boot for far-from-database users is bounded by `max(create+schema, catch-up)` instead of their
  sum — the backlog-0003 projection (~4.5s → measured against ~7s) — and the spare's initdb runs
  in a worker that no live board shares a thread with.
- The `@pgxsinkit/react` hooks and app call sites survive via the facade; the new public surface
  is `defineSyncWorker`/`attachSyncClient` plus per-group readiness and the event stream.
- Two token paths (push + expiry pull) and the event bridge are new protocol code with their own
  test tier; the browser lane becomes a required PR gate.
- Backlog 0002 and 0003 are superseded by this ADR (promoted); their evidence files remain the
  measurement record.
