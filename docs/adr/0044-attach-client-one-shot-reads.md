# The attach client proxies one-shot reads; isSynced stays a refusal

Status: accepted (2026-07-16).

ADR-0032 decision 4 promised the attach facade "the same client shape as `createSyncClient` …
transparently proxied", but S2 shipped without the one-shot Drizzle read family: attach clients
threw on `query`/`queryRow`/`queryRaw`/`queryRawRow`/`ensureSynced`/`isSynced`. The gap had real
cost — it pushed read-path consumers onto the BYO-instance seam (the consumer class ADR-0043 was
proposed for, and is withdrawn with) and left the mandated surface unfinished. The July 2026 implementation
closes it. One member deliberately
stays a refusal, and that divergence needs its own record because two accepted ADR texts read
otherwise: ADR-0032 decision 4's "transparently proxied", and ADR-0021's "`isSynced` returns `true`
when sync is disabled".

## Decision

1. **One-shot reads proxy over one guarded round trip.** Query building happens on the tab —
   `drizzle`/`views` are the same handles `createSyncClient` exposes — and awaiting a builder sends
   the compiled SQL over the bridge as the new `guardedQuery` RPC (wire contract:
   `[sql, params, { rowMode }, use?]`). The worker dispatches it to the in-process client's
   `guardedRawQuery` seam, so the ADR-0041 read gate and the ADR-0021 lazy-group guard share one
   core with the in-process `query`/`queryRaw` path and the two entry points can never drift on
   guard semantics. The worker returns the full PGlite `Results`; Drizzle's own result mapping
   (relational/nested included) runs back on the tab, so a one-shot read returns exactly what its
   in-process twin would. `queryRaw`/`queryRawRow` carry their raw-fragment `use` in a per-read
   scoped executor — never a shared stash, which races because Drizzle executes the builder in a
   microtask after `queryRaw` returns.

2. **Only `rowMode` crosses; the parser map is a version-pinned mirror.** Drizzle's `parsers` map
   is functions — non-serializable — so the attach side strips query options down to `rowMode` and
   the worker re-applies a verbatim mirror of `drizzle-orm/pglite`'s fixed identity-parser constant
   (the temporal scalar OIDs, their array OIDs, and `numeric[]` 1231), so values arrive exactly as
   in-process.

3. **Bare `client.drizzle` reads are guarded on attach — a deliberate asymmetry.** In-process, a
   bare awaited builder is ADR-0021's documented unguarded escape hatch (there is no interception
   point). On attach every read must cross the bridge anyway, so it routes through the guarded
   seam. Attach mode is strictly more protected, never less; the asymmetry is one-directional
   safety, not drift.

4. **`ensureSynced` proxies as a plain RPC.** Activation is engine-wide but additive and
   idempotent — starting a group another tab already activated is a no-op and nothing reverts, so
   unlike `desync` there is no cross-tab blast radius to guard.

5. **`isSynced` stays a refusal — the recorded divergence.** It is a *synchronous*
   activation-STARTED peek (in-process: `isTableStarted`). A synchronous member cannot be an RPC,
   and the tab's cached bridge state is per-group CATCH-UP readiness — strictly weaker: an
   activated-but-still-catching-up lazy group reads as not-ready, the very case `isSynced` exists
   to distinguish. ADR-0021's sync-disabled clause is equally unanswerable — the tab cannot see the
   worker's sync mode. A guessed boolean would lie silently in exactly the window the API exists
   for; the throw names `groupReady` (catch-up) and `ensureSynced` (activation) as the answerable
   alternatives. `drizzle.transaction()` throws for a structural reason of its own: a read
   transaction needs a local store the tab does not have. This decision amends ADR-0032 decision 4
   (its text stays immutable): "same client shape" holds for the shape; these two members carry
   attach-mode semantics, disclosed in the worker-mode doc.

## Alternatives considered

- **An async `isSynced` on the attach client only** (`Promise<boolean>` via RPC). Forks the member
  type across modes, so every shared call site must branch on mode — and the synchronous peek's
  whole value is use in render paths that cannot await.
- **Answer `isSynced` from the tab's `groupReady` cache.** Wrong in the
  activated-but-still-catching-up window, which is the distinguishing case; a plausible wrong
  boolean is strictly worse than a throw.
- **Broadcast activation-started over the bridge now.** The right long-term shape — a worker-pushed
  started-state cache would make the tab's answer faithful and synchronous — but it adds a bridge
  event and cache for an API with no current attach-mode consumer. Deferred; see the reopen
  trigger.
- **Leave one-shot reads unproxied** (status quo). Kept pushing read-path consumers to the BYO
  seam (ADR-0043's class), fragmenting the sanctioned worker topology for apps that fit it
  otherwise.

## Consequences

- ADR-0043 is withdrawn in the same cycle: its first reopen trigger ("the attach surface grows
  one-shot reads") fired, and it emptied the known consumer class — the bespoke worker topology
  that ADR's motivating consumer ran was itself a workaround for the missing read path, and that
  consumer is migrating to the sanctioned worker mode. The acknowledgment was never implemented;
  ADR-0043's Decision text stays as the shape to build if a genuinely independent adopted-proxy
  consumer ever surfaces.
- The protocol drift is recorded in `docs/testing-strategy.md` (AGENTS.md rule), and the
  `guardedQuery` wire tuple is a named type shared by encoder and decoder.
- Coverage: the injected-port unit suite (`tests/unit/worker-one-shot-reads.test.ts`) exercises the
  read family, guard activation, `use` scoping, and the two throwing members; the real-SharedWorker
  e2e lane exercises a one-shot read end-to-end in a browser worker.
- Reopen trigger: if a worker-pushed activation-started broadcast lands, `isSynced`'s refusal
  converts to a faithful synchronous answer from the tab cache.
