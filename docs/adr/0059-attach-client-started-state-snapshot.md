# The attach client answers isSynced from a worker-pushed started-state snapshot

Status: accepted (2026-09-11) — amends [ADR-0044](0044-attach-client-one-shot-reads.md) decision 5

## Context

ADR-0044 decision 5 recorded `isSynced` as the one member of the attach surface that stays a refusal.
The reasoning was never that the answer is unknowable — it was that it is not knowable **on the tab**:

- `isSynced` is a **synchronous** activation-STARTED peek (in-process: `isTableStarted`). A synchronous
  member cannot be an RPC, so the tab has to answer from a cache.
- The only cache the bridge fed the tab was per-group **catch-up** readiness (`status.groups` and the
  `groupReady` edge), which is the strictly weaker question. A guessed boolean built from it "would lie
  silently in exactly the window the API exists for".
- ADR-0021's sync-disabled clause (`isSynced` is `true` for every key when sync is disabled) was equally
  unanswerable: the tab cannot see the worker's sync mode.

The same ADR named the fix and deferred it: "Broadcast activation-started over the bridge now. The right
long-term shape — a worker-pushed started-state cache would make the tab's answer faithful and synchronous
— but it adds a bridge event and cache for an API with no current attach-mode consumer." Its reopen
trigger: "if a worker-pushed activation-started broadcast lands, `isSynced`'s refusal converts to a
faithful synchronous answer from the tab cache." Worker-mode consumers of `isSynced` now exist — a guard
deciding whether local rows may be trusted, and a per-shape readiness counter seeded right after
`ensureSynced`, both on paths that cannot await — so the trigger has fired.

### What the in-process answer actually is

| State | `isSynced` |
| --- | --- |
| sync disabled (`syncEnabled: false`) | `true` for every key |
| sync pending (enabled, not yet wired — ADR-0041) | `false` |
| dormant `lazy` group | `false` |
| ordinary group, activated, still catching up | `false` |
| ordinary group, caught up | `true` |
| **promoted** `lazy + persistent` group whose boot kicked its start off, subscribe not landed | **`true`** |
| after `desync` / `discardEphemeral` (`stopGroup`) | `false` |

The promoted row is why a catch-up cache cannot stand in. Boot releases on a group's FIRST subscribe
attempt, success or failure, so offline the sync runtime is wired and a promoted group reads `true` while
its subscribe retries in the background. That is deliberate — promotion exists so an offline reopen can
read durable rows immediately — and it is precisely the state a catch-up-readiness cache reads as `false`.

The docblock on `SyncClient.isSynced` said "started and hydrated", which was never true for that row.

## Decision

**The worker computes a started-state snapshot by asking its own client, pushes it to every attached tab,
and the tab answers `isSynced` synchronously out of it.** Consumers need no change, and the member keeps
one type in both modes.

1. **The worker asks its own client, and nothing re-derives the semantics.** The snapshot is
   `client.isSynced(key)` for every key of the booted registry (the role variant `resolveRegistry` picked,
   when there is one), run on the in-process client the worker owns. Whatever that client answers, the tab
   answers — faithful **by construction**, so the promoted-group row, the sync-pending window and ADR-0021's
   sync-disabled clause all come along for free, and the tab never consults `status.groups`. It is keyed by
   **table**, not by group, so the tab needs no table→group mapping to read it.

2. **A bridge event plus an ack field.** `BridgeEvent` gains `{ kind: "synced"; tables: Record<string, boolean> }`,
   broadcast to every attached port. It is deliberately NOT added to `SyncRuntimeStatus`: that is a public
   contract type and the in-process client has no use for the field, so the snapshot stays bridge-only. The
   current snapshot also rides the **`attach-ack`** (`AttachAckPayload.synced`), because `attachSyncClient`
   resolves AT the ack while the worker's first `status` event is posted after it — so
   `const c = await attachSyncClient(…); c.isSynced(k)` runs before any broadcast is delivered, and only an
   ack field makes that first synchronous read faithful. A late-attaching tab folds the ack exactly as it
   folds the boot milestones (ADR-0041 stage 2).

3. **Broadcast where the answer can move, deduped.** The worker recomputes and sends only when the snapshot
   differs from the last one sent (the registry is small; recomputing is cheap, a redundant event is not).
   The points are: the status transition (`emitStatus` — it accompanies every group-readiness edge and the
   sync-pending→wired crossing), the `bootSettled` milestone (the background tail's completion, where a
   promoted group becomes started and buffered activations are replayed), every RPC dispatch, and the
   `subscribe` handler's guard. The last two are the ones that matter for ordering.

4. **Ordering guarantee: the snapshot precedes the result that caused it.** For the RPC path the publish
   happens after the dispatch settles — resolved **or rejected**, since a failing op may have moved the
   state before it failed — and before the `rpc-result` is posted. It is placed after **every** op rather
   than a curated list: `ensureSynced`/`desync`/`discardEphemeral` move the started state explicitly, while a
   `guardedQuery` or an ordinary write moves it implicitly through the lazy-group guard, and a list would rot.
   The `subscribe` handler publishes after its guard runs and before `live-initial`. Events and results share
   one port per tab and `MessagePort` delivery is FIFO, so on the tab
   `await client.ensureSynced(["x"]); client.isSynced("x") === true` holds with no tick in between.

5. **Before any snapshot, the answer is `false`.** An unknown key reads `false` too. That matches the
   in-process sync-pending answer — the honest one for a client whose engine has not spoken yet.

6. **A detached client keeps its last snapshot rather than throwing.** The attach client's detach convention
   (ADR-0040 P2) settles *operations*: those promising data reject, doneness signals resolve. `isSynced` is
   neither — it is a synchronous peek, like `status`, which stays readable after detach with `isRunning`
   false. It is also read from render paths that cannot handle a throw, and detach commonly runs at page
   teardown, so throwing there would reintroduce exactly the crash class this ADR removes. The in-process
   client behaves the same way: `stop()` does not clear the started state `isTableStarted` reads.

7. **The public docblock is corrected** to the semantics in the table above — STARTED, meaning a durable
   subscription exists so reads of the relation are meaningful — pointing at `groupReady` for catch-up
   completion, instead of the inaccurate "started and hydrated".

## Alternatives considered

**Answer from the tab's catch-up cache (`readyGroups`).** Free — the data is already there — and wrong for
promoted groups: offline it reads `false` where the in-process client reads `true`, which is the exact case
promotion exists to serve. A guard built on it would refuse durable rows the same code reads happily
in-process.

**Redefine `isSynced` as "caught up" in both modes.** Smaller, and it would make the catch-up cache correct
by definition — but it regresses the in-process answer for the same promoted-offline case, so the fix would
be paid for by the mode that works today.

**An async `isSynced` on the attach client only** (`Promise<boolean>` via RPC). Forks the member type across
modes, so every shared call site branches on mode — and the peek's whole value is use in render paths that
cannot await. Already rejected by ADR-0044 for the same reason.

**Carry the snapshot on `SyncRuntimeStatus` instead of its own event.** It would reuse an existing message,
but `SyncRuntimeStatus` is a published contract type shared with the in-process client, which has no use for
a field it can compute directly. The snapshot is a bridge concern, and keeping it on the bridge keeps the
public type honest.

## Consequences

**The protocol grew one event and one ack field**, both additive: `{ kind: "synced" }` and
`AttachAckPayload.synced`. A tab built against an older worker sees no `synced` traffic and reads `false`
everywhere rather than misbehaving; the drift is recorded in `docs/testing-strategy.md`.

**ADR-0044 decision 5 is amended, not rewritten** — its text stays immutable. Its reopen trigger fired, and
this is what it converts to. The `isSynced` throw and its justification comment are gone from the attach
client; the worker-mode concept page and the `operating` skill no longer list `isSynced` among the
unproxied members.

**Coverage** lives in `tests/unit/worker-one-shot-reads.test.ts`, which drives a real in-process engine
behind `defineSyncWorker` over an injected `MessageChannel` and uses the worker's own client as a parity
oracle: every case asserts the attached answer AND equality with that client for every registry key. The
cases are the no-throw baseline, explicit activation with the no-tick ordering assertion, guard activation
through a one-shot read and through a live subscription, `desync` and re-activation, the sync-disabled ack
snapshot read before any other await, a late attach, a catch-up landing with no RPC in flight, and the
discriminating one: a group the worker reports STARTED but not caught up reads `true` on the tab while its
catch-up is still pending — the case a catch-up-cache implementation fails.

**`discardEphemeral` is covered by construction, not by its own case.** It travels the same RPC dispatch
and the same engine `stopGroup` as `desync`; giving it a case would mean adding an ephemeral member to the
shared test registry, changing every other case's local schema for no extra discrimination.

**A latent `status.groups` issue surfaced while writing this and is recorded, not fixed**
(`docs/backlog/0019`): nothing clears a group's ready flag when `stopGroup` runs, so catch-up readiness is
stale after a `desync`. The snapshot here does not inherit it — it is recomputed from `isSynced`, which does
reset on stop.
