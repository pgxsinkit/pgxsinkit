# Storage declaration transport and path-addressed store teardown

Status: accepted (2026-07-24)

The board demo added a storage-preference switch (backend `opfs`/`idbfs`, durability
`relaxed`/`strict`) and threaded both preferences through the SharedWorker **name**
(`<storePath>?durability=…&backend=…`). That made configuration part of the worker's dedup
identity: changing a preference replaced the worker under a new name, while the old
extended-lifetime worker still held the store's database handle. Making that safe spawned a
retire-before-apply barrier in the board, a placement-spanning retirement protocol in the toolkit
(`retireSyncWorker`/`retireSyncWorkerHost`), a synchronous Apply gate, and Safari timeout
archaeology — and it still failed. The name was the wrong seam; everything downstream of it was
symptom.

The correct seam already existed in the model: ADR-0049 made the **Storage declaration**
(`SyncStorageDeclaration`, ADR-0047/0049) a registry-owned property of the data contract — "one
declaration binds every open of every store minted from the registry". What was missing was a
transport for a consumer whose declaration is **dynamic** (the board's localStorage toggle) where
the registry must stay silent. This ADR adds that transport and deletes the name protocol and the
retirement machinery it necessitated.

Replacing the name transport with a fresh-path-per-preference model (decision 5) then exposes a
second problem, which the second half of this ADR resolves. A preference change mints a new store
under a new path and records the superseded exact paths as **obsolete**, retrying
`destroyStoreArtifacts` per path in the background at each boot until it succeeds. That pattern
**assumes the obsolete worker dies between boots** — the list is the resume state, and a later boot,
once the predecessor is gone, completes the destruction. For OPFS the assumption holds: the
OPFS-repacked VFS releases its sync-access handles when the engine goes idle, so a path is deletable
soon after its last document leaves. For **idbfs it does not**. The board's SharedWorkers are
`extendedLifetime: true` (ADR-0049) — a store's worker deliberately OUTLIVES the document that
spawned it — and PGlite's idbfs backend holds its IndexedDB connection open for the engine's whole
life. So after a reload (a preference change, or the "Delete local data" wipe) an idbfs store's
worker is STILL ALIVE and STILL holding the connection: `indexedDB.deleteDatabase` sits `blocked`,
`destroyStoreArtifacts` fails, and it fails **boot after boot within the same session** until the
browser eventually reaps the worker. The board e2e made this concrete — an OPFS wipe converges to a
clean profile in under a second, while the idbfs+strict wipe never converged on the obsolete-list
retry alone. The obsolete list is the right resume state; what was missing is any mechanism to make
an idbfs store **not-running on demand**, so the very first retry can win — a path-addressed
teardown, distinct from destroy.

## Decision

### Transport

1. **The worker name carries the store path. Nothing else, ever.** The name is the browser's dedup
   identity (N tabs → one engine per store, ADR-0032); configuration in the name turns every
   preference change into a worker replacement under a live predecessor. No query strings, no
   worker-side name parsing.

2. **The declaration message.** The library's tab-side (`attachSyncClient`, `provisionSyncWorker`)
   posts one small message — `{ [DECLARATION_KEY]: SyncStorageDeclaration }` — on **every** worker
   port, **before** the placement query. Always, even when the app declared nothing (an empty `{}`
   meaning "no opinion"). It must precede placement because `backend: "idbfs"` selects
   SharedWorker-direct and skips the OPFS probe (ADR-0049 D1) — by placement-decision time it is
   too late to learn the backend. A registry-silent SharedWorker bootstrap therefore **defers its
   placement decision until the first declaration message arrives**; the first arrival **binds**
   the declaration for the worker/store lifetime. The declaration also rides the provision/attach
   payloads, so the **engine** binds it (the mint's durability) wherever it runs — the elected
   dedicated engine's scope never saw the SharedWorker's message.

3. **Mandatory; violations refused.** An engine-bound message (provision/attach) arriving on a port
   before that port's declaration is a protocol violation → typed refusal
   (`{ [DECLARATION_REFUSED_KEY]: { message, name } }`, rebuilt tab-side as
   `StorageDeclarationRefusedError`). No timeout, no silent default: a missing declaration can only
   mean a version-skewed or foreign client, and guessing a placement it cannot renegotiate later is
   exactly the silent-old-value failure this ADR removes. Placement/destroy queries are meta
   traffic — answerable once placement resolves, exempt from the violation check. Because the tab
   now always knows placement before its handshake, the attach flow awaits the placement reply
   (which is also where a refusal arrives) — this costs no real latency, since the old
   fire-and-forget handshake queued behind the same placement decision anyway.

4. **Registry-static is authoritative.** An `attachSyncRegistryStorage` declaration binds and
   decides placement at scope startup — no wait. A wire declaration is honoured only where the
   registry is silent. Comparison is **per-field on explicit values only**: an unset field is "no
   opinion" and can never conflict (so `{}` from a static-declaring consumer's tab never refuses);
   an explicit field disagreeing with the resolved declaration — registry-vs-wire, or a later
   arrival vs the bound resolution — refuses typed. Never a silent old value. (Naive "normalize
   `{}` to explicit defaults" was rejected: it would refuse every static-declaring consumer whose
   tabs send `{}`.) The resolution lives in `@pgxsinkit/contracts`
   (`resolveStorageDeclaration`/`assertStorageDeclarationCompatible`) and is the single rule for
   the bootstrap seam, the engine payload seam, and `createSyncClient`'s durability resolution.

5. **Declarations are immutable per store; a preference change mints a fresh store under a fresh
   path.** Never delete-and-recreate the same path — an extended-lifetime predecessor may still
   hold it. The switching consumer (the board) drops its bindings, records the old exact paths as
   obsolete, writes the new preference, and reloads; fresh random store ids boot under the new
   declaration, and obsolete paths are destroyed best-effort in the background
   (`destroyStoreArtifacts`, the public wrapper over the ADR-0049 D8 destruction machinery —
   backend-agnostic: OPFS directory + commitment sentinel + meta record + idb database), each
   preceded by the path-addressed teardown of decisions 7–8.

6. **The retirement surface is deleted.** With no worker replacement under a live predecessor,
   retire-before-apply has no reason to exist: `retireSyncWorker`, `retireSyncWorkerHost`, their
   diagnostics rail, the board's `retireBoardWorkers` barrier, and the worker-name query-string
   protocol are removed. Internal teardown/destruction primitives (host close, supervised destroy,
   `runStoreDestruction`) stay — they serve `client.destroy()` and artifact destruction, not
   preference changes.

### Teardown

7. **Add `quiesceStoreWorker(worker, opts?)` — a path-addressed teardown, separate from destroy.**
   It takes a `worker` factory/instance of the exact shape `attachSyncClient` takes — the caller
   constructs `new SharedWorker(url, { name: storePath })`, so the library stays DOM-free.
   Connecting by that name reaches the LIVE (extendedLifetime) worker if one survives, else spawns a
   throwaway. The sequence reuses the transport's wire order: post the storage **declaration** first,
   then query **placement**, then act on the reported engine home.

8. **SW-direct home → active teardown, awaited.** For a `shared-worker` home (idbfs, and real-Safari
   opfs) it sends `engine-teardown` and awaits the reserved ack the host posts ONLY after it has
   stopped the engine and released the backend connection (then closed its own scope), resolving
   `{ engineHome, toreDown: true }`. That released connection is exactly what unblocks a subsequent
   `deleteDatabase` — the idbfs fix. The ADR-0049 SW-direct host already answers `engine-teardown`
   this way for `client.destroy()`; decision 7 reaches that same seam **by path**, for a store no
   client is attached to.

9. **Elected home → no-op, resolved immediately.** For an `elected-worker` home it sends no teardown
   and resolves `{ engineHome, toreDown: false }`. There is nothing to close from this router-only
   SharedWorker connection: the elected dedicated engine is owned by its tab and the browser
   terminates it on document teardown, releasing its store — so a path-addressed destroy of an
   elected store never faces a held connection in the first place. (Elected placement is also an
   OPFS home, which releases on idle regardless.)

10. **`destroyStoreArtifacts` is UNCHANGED — quiesce is a caller-composed step, not folded in.** Its
    contract stands: destroy a store's artifacts BY PATH, on a store nobody is attached to, with the
    not-running precondition **documented, not probed** (a liveness probe could not be race-free, and
    the ownership error already fails hard), safely re-runnable. Quiescence is a SEPARATE primitive
    the caller composes BEFORE it: `await quiesceStoreWorker(f).catch(() => {}); await
    destroyStoreArtifacts(path)`. Keeping them separate preserves the destroy path's honesty (it
    never guesses liveness) and keeps quiesce optional for callers with no worker to tear down (the
    in-process fallback constructs none).

11. **A timeout REJECTS — it is not proof of teardown.** The handshake is bounded (`timeoutMs`,
    default 6000); on timeout the returned promise rejects and the caller keeps the path on its retry
    list. The `.catch(() => {})` in the compose pattern is deliberate: a quiesce failure must NOT
    abort the destroy, whose own ownership-lag retry then reports honestly and leaves the path
    re-runnable — a still-held path simply stays obsolete for the next boot, exactly as before, now
    with a real chance the retry already won.

12. **No storage opinion by default; never refused.** `storage` is an optional declaration; omitting
    it (or `{}`) states NO opinion, so it is always compatible with whatever a live worker already
    bound (decision 4's per-field resolution) and can never raise `StorageDeclarationRefusedError`.
    The board omits it — the teardown must not fail because the surviving worker was bound to an older
    preference. Passing a concrete declaration is available but risks a refusal on disagreement.

13. **Idempotent and safe on an already-dead store.** Connecting to a name with no live worker spawns
    a fresh one that boots no engine; its teardown closes an empty host and resolves. So the primitive
    is safe to call unconditionally on every obsolete path each boot, whether or not a predecessor
    survives.

14. **Consequence: the board's wipe and obsolete-cleanup quiesce-then-destroy.** Both destructive
    surfaces — `local-data.ts`'s boot-time wipe and `store-registry-default.ts`'s
    `destroyObsoleteStores` adapter — route through a `quiesceThenDestroyStore` helper (worker-mode-
    gated, best-effort `.catch`, no storage opinion). The idbfs wipe converges immediately instead of
    waiting out the extendedLifetime grace period; OPFS is unaffected (its teardown closes an
    already-releasable host).

15. **The teardown worker's construction options MUST MATCH the live worker's — the sharp caller edge.**
    Decision 7 says the caller constructs the `SharedWorker` "by that name"; the name is necessary but
    NOT sufficient. A named `SharedWorker` is deduped by the browser onto one instance, and **Chromium
    (148+, where `extendedLifetime` is honoured) rejects a second `new SharedWorker(name, …)` whose
    options DISAGREE with the live instance's** — it fires an `error` event on the returned worker and
    never runs `onconnect`, so the teardown port silently exchanges ZERO messages and `quiesceStoreWorker`
    times out. The live board worker is `{ type: "module", name, extendedLifetime: true }`; the teardown
    worker MUST use the identical dictionary. Omitting `extendedLifetime` on the teardown worker (on the
    plausible-sounding theory that a throwaway teardown should not itself outlive) does NOT shorten its
    life — `closeHost` + `scope.close()` end it regardless — it only breaks the dedup match and defeats
    the whole primitive. This is invisible in a same-page test where both workers are constructed
    identically; it only bit the board, whose live worker and teardown worker are two separate call sites.
    The library cannot enforce this (it takes a factory and stays DOM-free), so it is a **documented
    caller contract**: construct the teardown worker with byte-identical options to the live one.

16. **Quiescing releases the connection, but the obsolete-list cleanup that consumes it must not
    starve (board registry, not the primitive).** With decision 15 fixed, the idbfs teardown succeeded
    yet the wipe still flaked ~30%: `destroyObsoleteStores` removes a destroyed path from the obsolete
    list under the registry lock, but `ensureSpare` on the post-wipe login screen was awaiting
    `computeOrphanIdbNames`'s **blocking** `deleteDatabase` (an orphan whose live extendedLifetime
    worker held the connection) WHILE holding that same lock — starving the removal, so the phantom
    entry lingered and convergence never completed. Fix (in `store-registry.ts`): compute the orphan
    set under the lock, but run the blocking `deleteDatabase` sweep AFTER releasing it. General rule
    this encodes: **never hold `REGISTRY_LOCK` across blocking IndexedDB I/O** — the lock guards state
    read/write only.

## Alternatives considered

- **Keep the name transport, harden retirement.** Rejected — this was the shipped attempt. The
  barrier must span placements, browsers, and extended lifetimes, and any missed path leaves a
  predecessor holding the store handle. The fault is structural: configuration must not be dedup
  identity.
- **Reuse the placement query as the carrier.** Rejected: the placement query is a *question*
  answered from decided state; the declaration is an *input* that decides it. Folding them couples
  the reply's semantics to binding semantics and leaves provision (which also needs the
  declaration pre-mint) without a carrier.
- **Registry-only declarations (no wire transport).** Rejected: the board's toggle is a genuine
  dynamic-consumer case, and baking preferences into generated registry code at reload time is a
  build step masquerading as configuration. The wire transport is subordinate (registry-static
  wins), so static consumers lose nothing.
- **Timeout-then-default instead of refusing undeclared engine-bound traffic.** Rejected: a client
  that meant `idbfs` silently getting `opfs` is the exact bug class this ADR exists to kill;
  pathological states refuse loudly.
- **Fold the teardown into `destroyStoreArtifacts` (probe liveness, tear down if alive).** Rejected:
  it re-opens the contract the destroy path was designed to keep. A by-path destroy cannot probe
  liveness race-free, and making it construct and speak to a worker couples the dead-store deletion
  machine to the DOM worker surface it was deliberately kept free of. Composition keeps each
  primitive honest.
- **Revive a retirement/coordination protocol for teardown.** Rejected: that is exactly the
  machinery decision 6 deleted, and its faults (placement-spanning barriers, missed paths leaving a
  live holder) were structural. Quiesce reuses the SINGLE existing `engine-teardown` seam addressed
  by path; it adds no standing protocol.
- **Just wait out the extendedLifetime grace period on the obsolete list.** Rejected: it is what the
  bare obsolete-list retry already did, and the e2e showed idbfs never converged within a session —
  the grace period is unbounded from the app's view, and a demo visitor who clicked "Delete local
  data" watches a dirty profile. On-demand teardown makes the first retry able to win.
- **Terminate the SharedWorker from the tab.** Rejected: there is no API for it — a document cannot
  terminate a SharedWorker (that is the whole reason the wipe runs on the boot path, not the live
  page). Teardown must be cooperative: ask the host to close itself and prove it did via the ack.
