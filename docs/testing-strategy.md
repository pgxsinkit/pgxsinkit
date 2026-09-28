# Testing Strategy

## Unit tests

Unit tests must stay fast and deterministic. They cover:

- contract parsing and normalization
- read-path URL and shape configuration
- write payload mapping
- local mutation journaling semantics, including atomic client-side batch enqueue and per-entity sequencing
- explicit edge cases such as blank titles or invalid UUIDs

### 0.2.0 contract boundaries

The first published contract is intentionally narrow, and focused tests pin its public boundaries:

- Writes use `batchWriteUrl`; the routed endpoints are `/api/mutations` and `/api/mutations/unit` only. An
  absolute deployment URL may prefix that canonical suffix (for example a Supabase Function URL), but aliases
  such as `/mutations` are rejected. Coverage: `tests/unit/pessimistic-flush.test.ts`,
  `tests/integration/client-contract.integration.test.ts`, `tests/integration/server-contract.integration.test.ts`,
  and `tests/integration/board-smoke.integration.test.ts`.
- Registry row filters are authored through the typed-column callback exposed by `defineSyncTable` and
  `defineReadProjection`; the resolved `customPredicate` output — a predicate AST, never SQL text — is
  what the control plane compiles into a shape, and a `rowFilter` that restricts nothing is refused.
  Coverage: `tests/unit/contracts.test.ts`, `tests/unit/registry-projection.test.ts`, and
  `tests/unit/row-filter-predicate.test.ts`.
- Local preparation hooks are named by timing: `prepareLocalDbBeforeSchema` and
  `prepareLocalDbAfterSchema`. Coverage: `tests/unit/client-sync-reset.test.ts` and
  `tests/unit/worker-bridge.test.ts`.
- Journal rows always carry a non-null `registry_version`, and an exact local-schema fingerprint mismatch is a
  hard failure rather than in-place schema replay. Coverage: `tests/unit/local-store.test.ts` and
  `tests/unit/schema-fingerprint-fast-path.test.ts`.
- The apply function exposes only the current mutation signature, and the vendored Supabase router verifies
  asymmetric JWKS-backed JWTs only. Coverage: `tests/unit/plpgsql-apply.test.ts` and the board integration lane.
- A managed field declared `applyOn: ["create"]` is stamped by the server at birth and is **inert on
  update**: the generated apply function offers no UPDATE SET candidate for it, and the write route treats
  it exactly as it treats an update-managed field — flagged as a managed-field violation (400), stripped by
  the payload sanitizer, and omitted from the update validation schema. Coverage:
  `tests/unit/plpgsql-apply.test.ts` (candidate lists + a PGlite apply that leaves the stored value
  untouched) and `tests/unit/update-managed-field-guard.test.ts` (the three request-path guards).

## Release metadata: Agent Skill version pins (2026-09-28)

Skill pins (`metadata.library_version` in `packages/*/skills/**/SKILL.md`) are tag-derived like
`package.json`'s `version` (ADR-0001). Before this change, pins were hand-bumped before each tag
(`skills:pins:write`) and `skills:pins:check` failed any pin behind `git describe --tags`. The
`0.4.0` tag was pushed without the bump: the release job failed and every later commit failed the
pre-commit check. Now:

- **Repo side.** `skills:pins:check` (`scripts/validate-skills.ts --pins-only`, the first `validate` /
  `validate:full` stage) requires every pin to be exactly the `"0.0.0"` placeholder. The pin check
  no longer reads the git tag, so the `skills` cache stage no longer folds the tag into its
  fingerprint. The intent CLI's structural `skills:validate` is unchanged.
- **Publish side.** `scripts/publish-github-packages.ts` stamps the version it publishes into every
  `SKILL.md` of each package it stages, beside the `package.json` version rewrite. It stages all
  packages first and asserts that every staged pin equals its package's publish version before any
  `bun publish`, naming each offending file. `tests/unit/publish-github-packages.test.ts` covers
  stamping (nested skills, pin line only, `DRY_RUN` in memory only) and the assertion (the unstamped
  placeholder, a stale pin, the other channel's version, a missing pin) for both the release (tag)
  and dev channels. That file moved from `scripts/`, where the unit lane never ran it.

## Worker bridge protocol

The `attachSyncClient` / `defineSyncWorker` bridge (ADR-0032) evolved during the July 2026 implementation; the notes below record the resulting contract so coverage stays anchored to current behavior.

Under **ADR-0049** the SharedWorker is always the attach point but is no longer always the engine home: where the engine runs is a runtime capability decision, never a consumer knob. Under the default `storage.backend: "opfs"` an **unconditional** real `createSyncAccessHandle` probe (never method-presence) runs at boot and selects **SW-direct** (`shared-worker`: the engine boots in the SharedWorker itself, WebKit today) or **elected** (`elected-worker`: the SharedWorker is router-only and the engine boots in a tab-spawned dedicated worker holding the handles, Chromium/Firefox). The one opt-out is the registry declaration `storage.backend: "idbfs"`, which forces the in-SharedWorker IDB engine and skips the probe. Both capability paths must stay tested; the unit lanes below exercise them off-browser, and the engine CORE (`SyncWorkerHost.connect`, live queries, journal, convergence) runs unchanged in either home.

- The attach (worker-attached) client now **proxies one-shot Drizzle reads and `ensureSynced`**. `query` / `queryRow` / `queryRaw` / `queryRawRow` compile a read to SQL on the tab (its `drizzle` runs over a bridge executor) and route it to the worker; `ensureSynced([keys])` starts the named lazy groups on the shared engine.
- Two RPC ops were added to the bridge protocol (`packages/client/src/worker/protocol.ts`):
  - `ensureSynced` — carries `[keys]`; additive/idempotent lazy activation over the shared engine.
  - `guardedQuery` — the guarded one-shot Drizzle read. Its positional wire contract is the named `GuardedQueryWireArgs` tuple: `[sql, params, { rowMode }, use?]`, encoded once tab-side and decoded against the same type worker-side.
- Under **ADR-0059** the attach client also answers `isSynced` — the synchronous activation-STARTED peek — from a **worker-pushed started-state snapshot**, so two more additive protocol members exist:
  - the `BridgeEvent` variant `{ kind: "synced"; tables: Record<string, boolean> }` — the worker's own `client.isSynced(key)` for every key of the booted registry, broadcast to every attached port whenever the answer changes (deduped against the last one sent). Deliberately NOT on `SyncRuntimeStatus`: that is a public contract type the in-process client needs no such field on, so the snapshot stays bridge-only.
  - the `attach-ack` field `synced` — the same snapshot at ack time. `attachSyncClient` resolves AT the ack and the worker's first `status` event is posted after it, so only an ack field makes the first synchronous `isSynced` after attach faithful (and folds the current state for a late attach).
  - Ordering is part of the contract: for the RPC path the snapshot is published after the dispatch settles (resolved **or** rejected) and BEFORE the `rpc-result`; the `subscribe` handler publishes after its lazy-group guard and before `live-initial`. Events and results share one port and `MessagePort` delivery is FIFO, so `await client.ensureSynced(["x"]); client.isSynced("x") === true` holds on the tab with no tick in between.
- **Only `rowMode` crosses in the query options.** Drizzle's pglite `parsers` map is functions (non-serializable), so it is stripped tab-side; the worker re-applies an identity-parser mirror (`DRIZZLE_PGLITE_IDENTITY_PARSERS` — drizzle's fixed `parsers` constant mirrored verbatim: temporal OIDs plus `numeric[]`) so the identity-parsed OIDs round-trip as raw strings exactly as the in-process drizzle session sees them.
- Deliberate behaviour notes:
  - A bare awaited `client.drizzle` read is **GUARDED on attach** — stricter than the in-process escape hatch, which lets a bare `client.drizzle` read run ungated.
  - `client.drizzle.transaction()` **throws** on a worker-attached client — a read transaction needs a local store the tab does not have. See ADR-0044, "The attach client proxies one-shot reads; isSynced stays a refusal".
  - `client.isSynced(...)` no longer throws (ADR-0059 amends ADR-0044 decision 5): it reads the worker-pushed snapshot, so it answers exactly what the worker's own client would — including the promoted-group case (started from boot while its subscribe retries), the sync-pending window and ADR-0021's sync-disabled clause. Before any snapshot arrives, and for an unknown key, it reads `false`; a detached client keeps its last snapshot rather than throwing (it is a peek, not an operation).

Coverage: the one-shot read path and the bridge protocol are a **unit-lane** concern (ADR-0032 decision 8 — the bridge layer is built around injected MessagePort pairs and unit-tested in Bun): `tests/unit/worker-one-shot-reads.test.ts` drives a real in-process engine behind `defineSyncWorker` from `attachSyncClient` over injected `MessageChannel` port pairs, covering `queryRow` (first row / null), `queryRawRow` with a `use`-carrying fragment, and the `client.drizzle.transaction()` refusal. The same file owns the ADR-0059 `isSynced` cases, each asserting the attached answer AND parity with the worker's own client for every registry key (that client is the harness's oracle): the no-throw baseline, explicit activation with the no-tick ordering assertion, guard activation through a one-shot read and through a live subscription, `desync` then re-activation, the sync-disabled ack snapshot read before any other await, a late attach, a catch-up landing with no RPC in flight, and the discriminating case — a group the worker reports STARTED but not caught up reads `true` on the tab, which a catch-up-cache implementation cannot do. `tests/unit/worker-bridge.test.ts` pins the ack's `synced` field in its raw-envelope handshake assertions. The Playwright lane (`tests/e2e/board-worker.e2e.test.ts`) owns the real-SharedWorker **lifecycle and boot** posture, not the one-shot read path.

The board browser lane also switches between two identities inside one page realm and asserts that their
localStorage bindings resolve to distinct stores. This pins the general lifecycle contract: a new store may
attach immediately after the previous client detaches, without waiting for that store's worker lifetime or
provision expiry.

## Storage and durability

Under **ADR-0049 (capability-driven engine placement)** the store backend is a runtime capability decision, not a fixed idb topology. The store-minting funnel (`store-path.ts`, the ONE URL assembler) derives the dataDir URL from the executing scope: the placement probe granted sync-access handles → `opfs://` (opfs-repacked, the primary browser store on every platform); handles denied → `idb://` (browser/worker fallback); Bun/Node → `file://`; the sanctioned test lane → `memory://`. **ADR-0050 (storage declaration transport)** carries the store's storage declaration — `backend` (`opfs`/`idbfs`) and `durability` (`relaxed`/`strict`) — as a pre-placement **declaration message** on every worker port, not on the worker name. A registry-static declaration (`storage`, ADR-0047) is authoritative; a registry-silent consumer (the board demo) declares per store at runtime; the two resolve per-field on explicit values only (unset = no opinion), the declaration binds at first contact for the store's lifetime, and an explicit conflict is a typed `StorageDeclarationRefusedError`. A declared `backend: "idbfs"` skips the OPFS probe (SW-direct idbfs, not a fallback); anything else probes, and a capability fallback from opfs to idb keeps the declared durability.

- **Backend derivation.** `tests/unit/store-path.test.ts` covers the `opfs://` / `idb://` / `file://` / `memory://` derivation, the scheme precedence (memory override → opfs grant → idb → file), the `storeIdentityComponent` domain guards (lone surrogates, the encoded-length cap, `.`/`..` rejection), and the disjoint `pgxsinkit/stores|commitments|probe` namespaces (incl. `foo` vs `foo.committed`). `tests/unit/store-boot.test.ts` covers the `resolveStoreBoot` wiring that assembles the boot observations and executes the classifier's verdict, returning the resolved `dataDir` + `storageBackend`.
- **Diagnostics (ADR-0049 decision 12).** The `BootReport` carries additive `storageBackend` (`opfs-repacked` | `idbfs` | `filesystem` | `memory`), `engineHome` (`in-process` | `shared-worker` | `elected-worker`), and `storageFallbackReason` (set only when an opfs-capable boot opened idb — the recordless idb downgrade, or the virgin-uncreatable session fallback). `reportVersion` stays `1` — additive fields keep it. Coverage: `tests/unit/boot-report.test.ts` drives a real in-process boot (asserting `engineHome: "in-process"`, `storageBackend: "memory"` on the test lane) plus a builder-level suite for the additive omit-when-unstamped contract and the `shared-worker`/`elected-worker` + `opfs-repacked`/`idbfs` stamps.
- **Durability axis (ADR-0047 + ADR-0050).** A store's durability is fixed for its lifetime: bound at the store's first contact and immutable thereafter, so no open site can disagree with another about a live store's durability. The registry may declare it statically (`storage.durability`); a runtime consumer declares it per store via the ADR-0050 declaration message. It defaults to `"relaxed"` (the query returns before the datadir flush, scheduled asynchronously) with `"strict"` declarable (PGlite's synchronous end-of-query flush — ~100–200 ms/write on idb, cheap enough on opfs-repacked to actually opt into), and `createSyncClient` resolves the effective value at exactly one point, passing the result into every store mint. `tests/unit/client-boot-optimizations.test.ts` asserts the registry declaration resolves to PGlite's `relaxedDurability` boolean across `createClientPGlite`, `createSyncClient`, and the `defineSyncWorker` provision factory; `tests/unit/storage-declaration-resolution.test.ts` covers the ADR-0050 per-field resolution (explicit-only conflict, registry-static authority, refusal typing). Because a declaration is immutable per store, a runtime durability/backend change **mints a fresh store under a fresh path and reloads** (the board demo's obsolete-then-reload pattern; the superseded path is destroyed in the background at the next boot, never via a worker retirement handshake). End to end, `tests/e2e/board-worker.e2e.test.ts` asserts the real posture on headless Chromium: the SharedWorker engine boots, a second tab attaches the same engine, a human-paced durability change after spare provisioning mints a fresh store and round-trips a strict write after reload, an immediate Strict + OPFS Apply joins the in-flight spare before reloading cleanly, and an idbfs + strict preference then a local-data wipe converges to a fully-clean profile across boot-time obsolete-store destruction — the wipe scenario asserting convergence via **quiesce-then-destroy** (ADR-0050): each obsolete idbfs path has its `extendedLifetime` SharedWorker torn down (`quiesceStoreWorker` releasing the held IndexedDB connection) before `destroyStoreArtifacts`, which is what lets idbfs converge on the first retry where a bare destroy would sit `blocked` forever (opfs releases on idle and needs no teardown).
- **Crash and reopen (opfs-repacked).** `tests/unit/pgwasm-opfs-crash-reopen.test.ts` kills the store at chosen store-call indices (never timers) on a fault-injecting OPFS directory (`packages/pglite-opfs-repacked/test/support/crash-opfs.ts`), with PGlite through the package's own factory, in both durability modes, and reopens four images of what the crash left — everything the platform accepted (a terminated worker), only what was flushed, and the two arena/metadata mixes. It asserts the promise as a floor (strict: every commit that returned; relaxed: every commit the last strict boundary covered) and records what each image actually showed; `tests/e2e/pgwasm-opfs/` confirms the worker-termination case on OPFS on disk. Observed behaviour, recorded with the full matrix in [the package's testing strategy](../packages/pglite-opfs-repacked/docs/testing-strategy.md#crash-and-reopen-through-the-factory): a terminated worker keeps every commit that returned in both modes; with nothing unflushed surviving, relaxed keeps every commit written before the last arena flush of any kind (strict sync, repack, the 4 MiB amortization flush, or a zero barrier) — PGlite's WAL is preallocated and written in place, so the arena alone decides and unflushed metadata lost no commit. PGlite always runs `fsync=off` and never forwards a guest fsync, so `fsync=off` changes nothing on this engine. **Fixed (2026-09-25), store half:** a transient platform write failure whose error had no numeric `code` (a plain `Error`, a `DOMException` like `UnknownError`) inside a commit's WAL write was swallowed by PGlite's main loop and the commit acknowledged — in strict mode too — without reaching the store, and the engine then hung on its next statement (after a coded failure too). The store now poisons on an arena write that made no progress and on a failed metadata-log append, and throws `StoreFailedError` with `code` 29 (`EIO`) on that call and every later one, so Postgres gets an I/O error, PANICs in `XLogWrite`, and the commit fails; nothing reaches the platform after the failed write and a reopen lacks the commit — asserted for uncoded and coded errors alike. A query that reaches a poisoned store now fails with Postgres's own I/O error (SQLSTATE 58030). **Fixed (2026-09-25), PGlite half, in the `@pgxsinkit/pglite` 0.5.8-pgx.2 pin:** the main loop fails the instance on any exception that is not its longjmp unwind, so the statement after such a failure throws it at once instead of spinning synchronously, and `close()` releases every handle without running the aborted engine's shutdown, then rejects with the failure — asserted by a `test` in the same file (a `test.todo` on 0.5.8-pgx.1, where the spin could not be timed out). `tryFSOperation` now maps an uncoded error to `EIO`, so the store's retryable platform failures (zero barriers, arena growth, reads), which surface the platform's own error by design, reach Postgres as I/O errors instead of being swallowed by the main loop.
- **Storage bench lanes (not CI).** The perf lab ships an in-browser storage benchmark suite (`apps/perf-lab`, `src/bench/`) — a matrix of timed SQL batteries across `idb` and the constant-four-handle `opfs-repacked` backend (the `opfs-ahp` column, upstream PGlite's OPFS filesystem, retired with the switch to pgwasm, ADR-0062 d4/d6; its recorded results stay in the docs as history), at 8 KiB or 64 KiB and relaxed or strict. Run it manually per engine (headless via `bun run bench:storage`, or the live page on a real device, especially iPhone/Safari for the WebKit numbers desktop cannot gather). Beyond the raw SQL columns it runs the phase-0 `sharedWorkerProof` (does the full repacked engine boot, persist, and reopen inside SharedWorker scope?) — this is the **capability-drift monitor**: it is what proved SW-direct hosting on WebKit and would catch a platform withdrawing or granting the capability. A manual evidence lane, NOT part of `validate`/CI.

## Engine placement (ADR-0049)

Two engine-placement paths exist and both must stay tested (ADR-0049 consequence). The bulk of the control plane, the phase machines, and the lifecycle state machines are proved **off-browser** as pure/effect-injected modules, driven over `MessageChannel` and injected timers — Bun has no real SharedWorker, `navigator.locks`, OPFS, or WASM, so every IO surface is faked and no real engine is constructed in these lanes.

- **Control plane (MessageChannel-driven, injected timers).** `tests/unit/engine-control.test.ts` — the identity-tagged protocol types (staleness, retirement, overdue-dispatch reports, the opt-in execution limit with default-off + mismatch rejection) and the `EngineRelocatedError` `code`+`outcome` round-trip. `tests/unit/engine-router.test.ts` — the SharedWorker-side router (communication centre): attach registry, per-tab proxy-pipe minting/transfer, relocation-notice fan-out, probe forwarding, identity staleness, pipe isolation, engine liveness (control-port `close` retirement with teardown suppression; the ADR-0049 D5 default-config posture that silence is never a verdict — no window armed, no probe, no retirement; and, under the opt-in execution limit, the `connect-port-ack` window handing an unacked delivery to the probe loop, where each of `probeMissThreshold` pings gets a full interval to be answered). `tests/unit/attach-placement.test.ts` — the attach client's handoff window: bounded queue open/flush/overflow, pending-op classification incl. old-pipe settlement, worker-factory seam, bridge-silence deadline (asserting the reconstructed port's FIRST message is the ADR-0050 storage declaration, before the re-run attach). `tests/unit/attach-placement-composed.test.ts` + `tests/unit/destroy-supervision.test.ts` pin the composed elected flow (provision → placement → election → pipe handover, restore routing) and the supervised destroy (peer refusal first, teardown acknowledged before deletion, `destroyStoreArtifacts`' idempotent path-addressed destruction). `tests/unit/quiesce-store-worker.test.ts` pins the ADR-0050 by-path teardown matrix: SW-direct home sends `engine-teardown` and resolves `toreDown: true` on the reserved ack, an elected home is a no-op (`toreDown: false`, no teardown sent), a timeout rejects (not proof of teardown), and a conflicting storage declaration refuses typed. `tests/unit/sw-declaration-bootstrap.test.ts` pins the ADR-0050 declaration seam: a registry-silent bootstrap defers placement to the first declaration message, first-arrival binding, per-field explicit-conflict refusals, the engine-bound-before-declaration violation, and — for the reconnect/reconstruction path — that a **declared** port's engine-bound/control traffic arriving before placement resolves is queued and redelivered after routing ("declaration first, then anything"), never refused. `tests/unit/election-coordinator.test.ts` — the tab-side claim lifecycle (provision expiry, last-claim retirement ordering, keepalive reconstruction, BFCache release/reclaim) over mocked locks; its claim-expiry lane owns the elected TERMINATION half — an expired provision claim that was the last claim runs the full retirement (`engine-retiring` → `engine-teardown` → ack/timeout → terminate → lock settle). `tests/unit/provision-expiry.test.ts` — the provision's bounded settlement window and the CALLER-ONLY reach of that guarantee: the typed `ProvisionExpiredError` at the deadline in both modes (elected with no pipe and with a piped-but-dead engine; SW-direct with an ack that never comes), an ack before the deadline resolving and clearing the settlement timer, a late ack staying inert, and the PLACEMENT SPLIT the contract turns on — elected, the same deadline releases the provision claim, so the coordinator retires and terminates the engine (asserted here over a granting-locks fake through the retirement traffic and the spawned handle's `terminate`, with the sequencing detail owned by the election-coordinator lane); SW-direct, the worker-side create attempt is left running, pinned COMPOSED against the real `defineSyncWorker` over a `MessageChannel` with a create that never settles (the provision expires typed, a later attach waits behind that same attempt, and a retried provision re-acks it with exactly one open ever started). `tests/unit/engine-entry-control.test.ts` — the elected-engine-worker control plane on the dedicated-worker entry (dynamic `connect-port`, probe replies, retirement/teardown), driven through an injected fake scope. `tests/unit/sw-placement-bootstrap.test.ts` — the SharedWorker placement bootstrap gating each `onconnect` port on the resolved home (SW-direct host connect vs router-only attach). `tests/unit/placement-probe.test.ts` — the probe module over an injected FS surface.
- **Phase-machine / meta / lifecycle pure suites (crash-table composition proofs).** `tests/unit/store-meta.test.ts` — the total phase machine + boot classification 1–6, precedence (`deleting` highest), failed-read fail-closed, the recordless non-creating idb existence check and its terminus (an existing idb store classifies `boot-idb-authoritative` whatever the boot's OPFS observations are — a store's backend is fixed at first mint). `tests/unit/store-lifecycle.test.ts` — the fresh/restore commitment barrier, the fresh-candidate record-before-directory order, and the destruction machine, each over its crash table, plus the two-machine composition that threads every observed post-crash state back through `classifyStoreBoot`. `tests/unit/store-boot.test.ts` — the same verdicts EXECUTED with faked OPFS/IDB effects, including the no-grant arm's typed `CommittedStoreUnreachableError` refusal and the committed arms opening the committed store on the record's authority alone: an idb database sitting at the same path is inert and a boot leaves it strictly untouched (a boot is not a residue manager — cross-backend cleanup belongs to the destructive lifecycle, pinned by the destroy lanes below), the denied-home authority handoff (`resolveDeniedBootAuthority`): a `deleting` phase completes its inherited destruction while an `opfs-candidate` — sentinel-bearing (the barrier-gap crash) or plain — is RETIRED, sentinel and store directory both, with `idb-authoritative` published BEFORE the replacement idb store is exposed and no idb database at the path ever deleted, and an unobservable commitment namespace keeping the recorded phase and failing closed; and the GRANTED candidate's reclassification (`delete-candidate-and-rebuild` over an existing idb store re-classifies onto that store, never shadowing it with a fresh opfs mint). `tests/unit/fresh-commitment.test.ts` — the fresh/restore commitment boot wiring (`resolveFreshBoot` record-before-directory, `runFreshCommitmentBarrier` strict data-before-authority, the no-grant committed refusal, the no-grant `deleting` handoff and `opfs-candidate` retirement both running ahead of the idb resolution, the virgin-uncreatable session idbfs fallback). `tests/unit/worker-provision-offline.test.ts` — the provision lane's pre-mint meta gate, including the load-bearing decline over an EXISTING idb store (a pristine commitment namespace is not proof of a virgin store, so a granted provision must never pre-mint an empty opfs sibling the barrier would then commit over the user's data) and the candidate refusals in BOTH lanes (granted: only the adopting attach may rebuild a torn candidate; denied: that attach must retire the candidate and publish idb authority first, so the provision declines with the "phase is owned elsewhere" rail line). `tests/unit/destroy-supervision.test.ts` — the supervised destructive lifecycle (peer refusal, resumable boundaries). Both crash tables (fresh/restore, destruction) are exercised row-by-row by composing the pure classifiers/machines with faked observations, rather than a Cartesian per-field fault matrix (accepted-risk register item 7).
- **Sharded runner (cross-file WASM isolation).** `scripts/run-unit-tests.ts` splits the unit files into independent `bun test` shards run in a worker pool: the heavy real-engine/PGlite files (e.g. `boot-report.test.ts`) get their own isolated single-file shard so a `mock.module` (process-global) and a live WASM heap in one file never bleed into another, and the process stays flat regardless of file count. Run the placement suites through it — `bun scripts/run-unit-tests.ts tests/unit/boot-report.test.ts tests/unit/engine-router.test.ts …` — not a bare `bun test` over the set.

## Playwright multi-tab lanes (landed)

`tests/e2e/placement/` is the real-worker, real-`navigator.locks`, real-OPFS family. The serverless
suite runs with `bun run test:browser:placement` across Chromium, Firefox, and WebKit. It covers
placement decisions, election/succession, handoff queueing and relocation classification,
keepalive reconstruction, execution-limit termination, provision-then-attach, supervised
destroy/recreate, fresh commitment, and recordless-idb recognition.

Two of those lanes pin **backend permanence** — a store's backend is fixed at its first mint, and
destroy-then-remint is the only route to another one. `recordless-idb.browser.test.ts` seeds a bare
IndexedDB store and attaches through the granted elected engine: the `BootReport` reads `idbfs`, the
meta record settles `idb-authoritative`, and the OPFS commitment namespace stays empty — no
candidate directory, no sentinel, nothing migrated. `destroy.browser.test.ts` pins the mirror in
both directions: destroying an `idb-authoritative` store deletes its database, leaves the OPFS
namespace as empty as it found it, and lets the next boot mint `opfs-repacked`; destroying a
COMMITTED opfs store leaves no store directory, no sentinel, no meta record and no idb sibling.

An OPFS store's deletion is ordered on its **ownership lock** (`store-ownership-lock.ts`, 2026-09-28): the
opfs open path holds an exclusive per-store Web Lock (`pgxsinkit:store-owner:<identity>`) from before it opens
the sync-access handles until after close, and `deleteStoreDirectory` takes the same lock first, so a delete
waits for a previous owner whose worker is still dying (a reload or closed tab) instead of failing under its
handles (Chromium `NoModificationAllowedError`), and fails with `StoreOwnershipWaitError` after a bounded wait
under a live owner. `tests/unit/store-ownership-lock.test.ts` proves it with fake locks and a refusing OPFS;
`quiesce.browser.test.ts` destroys by path while the owner provably holds the lock and asserts the destroy
parks on it, then deletes once the owner leaves.

Where OPFS cannot be opened at all (`getDirectory()` rejects, as in Playwright's WebKit contexts), destroy
records "OPFS deletion pending" in IndexedDB instead of failing, and the next boot that can reach OPFS deletes
the sentinel and store directory before it classifies or opens anything (ADR-0036 amendment, 2026-09-28).
`tests/unit/store-boot.test.ts` ("pending OPFS deletion") pins the no-OPFS destroy leaving the marker, the
settling boot (granted and denied-but-reachable), the unreachable boot keeping the marker, and the unchanged
OPFS-capable destroy; WebKit's `destroy.browser.test.ts` and `quiesce.browser.test.ts` destroys prove it in a
real no-OPFS context.

The server-backed lanes run the real write API plus the native read stack — durable-streams and the
Circuits engine, stood up by `startNativeSyncStack` (`packages/test-utils/src/native-read-path.ts`),
with the edge mounted in process. `bun run test:integration:placement`
selects Chromium and is appended to `test:integration`, matching CI's installed browser.
`bun run test:browser:placement:server` runs the same server family without a project filter and is
the separate all-browser gate. It adds offline-first journal survival, delayed-write relocation
outcomes, and the server-lane permanence proof: a recordless IndexedDB store carrying the server
registry's real local schema, booted by the sync-enabled granted worker, stays `idb-authoritative`
across the boot AND across a reload — its database untouched, the OPFS commitment namespace empty.

Playwright automation prevents a genuine BFCache entry on the configured engines, so the
persisted-pagehide release/reclaim sequence remains deterministic unit coverage plus a real-device
check. WebKitGTK also lacks the worker-scope OPFS grants needed for several SW-direct assertions;
those lanes annotate/skip the platform limitation rather than claim synthetic coverage.

The manual Chromium provision comparison is
`bunx playwright test --config tests/e2e/placement/playwright.bench.config.ts`; it is intentionally
outside every aggregate and reports foreground attach-to-first-query timing for plain versus
provision-ahead-of-attach samples.

## pgwasm (ADR-0062 steps 1 and 2)

`@pgxsinkit/pgwasm` (the engine-neutral runtime), `@pgxsinkit/pgwasm-c` (the C build: the artefacts of
the pinned pgxsinkit/pgwasm-postgres release and their host code, and the prepopulated data directory),
`@pgxsinkit/pgwasm-pg-dump` (pg_dump over the wire protocol) and `@pgxsinkit/pgwasm-repl` (the REPL
component) replace the PGlite fork. Until step 3 nothing uses them yet; their lanes prove them on
their own. Where the code came from, file by file, is in
[docs/history/pgwasm-origin.md](history/pgwasm-origin.md).

- **Unit lane** (`bun run test:unit`): `tests/unit/pgwasm-*.test.ts` and `tests/unit/pgwasm-c-*.test.ts`.
  Most databases start from pgwasm-c's prepopulated data directory (`tests/unit/support/pgwasm.ts`,
  through `@pgxsinkit/pgwasm-c/prepopulated`), an unmarked C-build directory, so every seeded boot also
  exercises the rule that an unmarked directory is the C build's; `fresh: true` runs initdb.
  `pgwasm-c-prepopulated` proves the entry itself: the pinned bytes, no marker in it, the marker added
  on restore, and the lock file it carries from the live database it was taken from rewritten on
  start. The shared code's paths are proven against shapes no build in the repo has, by wrapping the
  C build (`tests/unit/support/pgwasm-build-decorators.ts`): an asynchronous exchange delivered in
  single-message chunks, notifications that arrive between exchanges through `onUnsolicited`, another
  build identity, a build without `/dev/blob`, and hooks on the storage persist and release
  (`pgwasm-seam`, `pgwasm-build-marker`, `pgwasm-persist-failure`). Boots that must fail before
  anything is written run on a spy build that records calls (`pgwasm-create`, `pgwasm-build-marker`). `pgwasm-extension-types` is also a type-level test, checked by
  `bun run typecheck`: an inline extension's `setup(pg)` is typed, and namespaces are inferred.
  `pgwasm-artefacts` checks every build package's artefacts against their pins (pgwasm-c's seven,
  pgwasm-pg-dump's two, all assets of one pgwasm-postgres release), the fetching of a release's assets
  (checked against the pin, cached, written through a `.part`, a corrupt cache entry replaced) and that
  only modules emitted at their own depth reference them
  (`src/artefacts.ts`, pgwasm-c's `src/prepopulated.ts` and `src/contrib/*.ts`); `pgwasm-c-initdb`
  pins the command lines initdb actually runs through the owned tokenizer; `pgwasm-legacy-datadir` opens a `file://` directory made by
  the fork's PGlite and restores a fork Store backup, both checked-in fork-made fixtures
  (`tests/unit/fixtures/pgwasm-legacy/`, captured from `@electric-sql/pglite` 0.5.8-pgx.2 before the
  fork left the graph in step 3). The reverse half, restoring a pgwasm backup into the fork, is
  retired with the switch (maintainer decision D4, 2026-09-27): it proved the rollback path, and the
  rollback path ends once the fork is no longer a dependency; `pgwasm-public-surface` pins every entry point's runtime exports.
  `pgwasm-protocol` also proves `/protocol`'s exclusive session: a query, a transaction and a backup
  wait for it, and it waits for a running transaction's COMMIT.
- **pg_dump** (`pgwasm-pg-dump`, `pgwasm-pg-dump-session`, `pgwasm-pg-dump-framing`): the fork's
  pg_dump cases, a round trip of many column types (sequences and a view included) through `exec()`, a
  row holding lines that look like psql's `\restrict`, a thousand tables (pg_dump's catalogue queries
  then exceed libpq's 8 KiB send blocks), and the custom format; the session held exclusively (both
  ways) and given back as it was (pg_dump's transaction ended, odd `search_path` values, the other
  settings pg_dump changes, its prepared statements gone while the database's own and a live changes
  feed survive); the refusals (a build without a synchronous wire, through the async-exchange
  decorator; a session inside a transaction block); the typed failure; and a wire that fails under
  pg_dump (through a `wireHookBuild` decorator), which fails the dump with the database's failure and
  no unhandled rejection. The framing of libpq's sends and the output file's handling are unit-tested
  on their own.
- **REPL** (`pgwasm-repl`): the component's non-DOM logic on a real database (SQL of several
  statements, errors as responses, psql's describe commands and the tables they produce, the
  autocompletion schema). `tests/pgwasm-repl-types.ts` is a type-level test, checked by
  `bun run typecheck`: a `Pgwasm` and `replAdapter(client)` are both a `ReplDatabase` without a cast.
  The package is typechecked in its own program (it needs the DOM library).
- **OPFS browser lane** (`bun run test:browser:pgwasm-opfs`, `tests/e2e/pgwasm-opfs/`): its six opfs-repacked
  specs run in Chromium and WebKit, the store in a dedicated worker in both (WebKit grants it sync access
  handles there). WebKit gives OPFS only to a persistent context, so every WebKit spec gets its own profile,
  and the lane serves on 4192 because WebKit refuses the bad port 4190 it used before.
- **IndexedDB browser lane** (`bun run test:browser:pgwasm-idb`, `tests/e2e/pgwasm-idb/`): Bun has
  neither IndexedDB nor Web Locks, so `idb://` storage is proven in Chromium and WebKit, on demand and
  outside the commit path, like the opfs-repacked lane. It runs the fork's web base flow (create,
  parameters, a gzipped dump loaded into memory, close, reopen after a reload, delete) and its IDBFS
  correctness cases through the build's `onPostgresModule` hook: one open per store (also across two
  tabs), the store released after a boot that fails before or after Postgres started, a relaxed
  statement running beside an in-flight snapshot, a strict statement held until the clock moves past
  its sync, a background persist failure reported once and recovered by the final persist, a throwing
  extension close hook that still lets shutdown, the final persist and the release happen, a failed
  final persist reported ahead of a failed close hook, and a clean shutdown that leaves nothing for
  crash recovery (with a dropped-persist control that does recover). The fork's `PGliteWorker`
  live-query cases are not ported: the worker is not part of pgwasm. In memory, it also runs pg_dump
  on a database created from the prepopulated data directory and restores the script into another,
  and mounts two REPLs, runs `select 1 as one` with Enter, and finds the REPL's stylesheet in the head
  once.
- **Packed install** (`bun run fixture:smoke`): the fixture installs the packed packages, boots pgwasm
  on the C build from the install (live, amcheck, Drizzle, `/protocol`, a Store backup restored, the
  `opfs-ahp://` refusal, a database from the prepopulated entry dumped with pg_dump, the REPL rendered
  on the server), typechecks against the published declarations, and builds a Vite production consumer
  of pgwasm-c, pgwasm-pg-dump, pgwasm-repl and the prepopulated entry whose emitted assets must contain
  every artefact loaded by URL (`pg_dump.wasm` and the prepopulated tarball included) byte-identical
  under a fingerprinted name.

### Behaviour drift from the fork

Against `@pgxsinkit/pglite` 0.5.8-pgx.2 (the fork at `b36bf12`):

- `dumpDataDir()` takes the query lock, so a dump never reads the data directory while a statement is
  running. The fork read it beside the running statement.
- A throw from the wire flush that ends a main-loop run (`_PostgresSendReadyForQueryIfNecessary`,
  `_pgl_pq_flush`) latches the instance as failed, like any other engine exception. The fork rethrew
  it without latching.
- `dumpDataDir()` always returns a `File`, named `<store>.tar` or `<store>.tar.gz`. The fork returned
  a `Blob` where `File` did not exist.
- `auto` compression always means gzip (`CompressionStream` exists in Bun and every supported
  browser). The fork fell back to an uncompressed tarball where it found no compressor.
- `username` runs `SET ROLE` with a quoted identifier. The fork interpolated the name unquoted.
- Promises the fork left unawaited are awaited (oxlint's `no-floating-promises`). One changes what a
  caller sees: when a live query's prepared statement was gone, the fork re-ran it without awaiting and
  then delivered the failed attempt's (undefined) results; pgwasm awaits the re-run and delivers only
  its results.
- `serialize.parse` refuses a statement name longer than Postgres' 63 characters with a `RangeError`.
  The fork logged it and let Postgres truncate the name, so two long names could collide.
- A Store backup entry whose path leaves the data directory (`..`) is refused with
  `BackupFormatError`.
- A Store backup that is cut short (even exactly at a member boundary), lacks its two end-of-archive
  records, or has a malformed size (a PAX `size` included) is refused with `BackupFormatError`. The
  fork's tinytar reader restored the members before a cut. Every backup PGlite ever wrote came from
  tinytar's writer, which always writes the end records, so no existing backup is refused.
- A server extension whose bundle fails to download, or is not a readable tarball, fails the boot. The
  fork logged the failure and booted without the extension.
- `close()` rejects when Postgres' shutdown throws; it still runs the final persist and releases the
  storage first. The fork logged the error and resolved.
- A boot that fails after a custom `fs` (a `BaseFilesystem`) was handed over closes it:
  `cleanupFailedInit()` defaults to `closeFs()`. The fork left a filesystem without its own cleanup
  hook open.
- `dataDir` is refused with `UnsupportedDataDirError` when it is a bare path, has an unknown scheme,
  or is `idb://` without a name, and when it is given together with `fs`; `opfs-ahp://` is refused with
  `OpfsAhpRemovedError`. The fork opened a bare path or an unknown scheme as a NODEFS directory, a
  nameless `idb://` as an in-memory database, and let `fs` win over `dataDir`.
- `listen()` and `unlisten()` take the transaction lock before the listen lock, the order a
  transaction's `tx.listen()` already holds them in (a live query's init does this). In the fork, a
  top-level `listen()` racing a transaction's `tx.listen()` deadlocked both.
- The unsubscribe function `listen()` returns removes a quoted mixed-case channel's callback and
  UNLISTENs it. The fork lower-cased the already-normalised name, so it did neither.
- Restored files keep their modification times. The fork passed seconds to Emscripten's `utime`,
  which takes milliseconds, so restored files were dated January 1970.
- The fork's exclusive-execution persist lane is gone: no kept filesystem used it. A relaxed persist
  still runs beside later statements, and `close()` and a failed boot wait for an in-flight persist
  before releasing storage.
- New data directories carry the build marker `PGWASM_BUILD` (ADR-0063). Existing unmarked
  directories open on the C build and are not backfilled.

Against `@electric-sql/pglite-tools` (pg_dump), `@electric-sql/pglite-repl` and
`@electric-sql/pglite-prepopulatedfs` at the same commit:

- `pgDump` holds the database's session for the whole dump, and the reading and restoring of the
  session around it (`/protocol`'s `runExclusiveSession`: the transaction lock, then the query lock).
  A transaction in progress commits first, and one started during the dump waits. The fork ran pg_dump
  beside anything else on the one session, so its `BEGIN` could land inside another caller's
  transaction.
- `pgDump` refuses a session left inside a transaction block (`PgDumpSessionError`), and a build
  whose wire is not synchronous (`PgDumpUnsupportedBuildError`) before it loads anything.
- pg_dump never ends its REPEATABLE READ, READ ONLY transaction (a disconnect would). The fork left the
  application's session inside it, so every later write failed as read-only; `pgDump` rolls it back,
  after a failed dump too.
- pg_dump changes `search_path`, `row_security`, `restrict_nonsystem_relation_kind` (which forbids
  reading views), `extra_float_digits` and the timeouts on the session. The fork restored only
  `search_path`, interpolated into SQL (which failed for an empty value), and when it still differed
  logged a warning that printed a result object. `pgDump` restores every setting a session can set,
  and the role, with a parameterised `set_config`, and fails with `PgDumpSessionError` naming any it
  cannot.
- The fork ran `DEALLOCATE ALL` after each dump, which also dropped the database's own prepared
  statements; a live changes feed (and so an incremental live query) then failed on its next refresh.
  `pgDump` deallocates only the statements pg_dump prepared.
- libpq, on pg_dump's Unix-socket connection, sends whole 8 KiB blocks and keeps the rest, so a longer
  message (pg_dump's catalogue queries list every table's OID) reached the fork's write callback in
  pieces, each handed to the backend as a whole message: the backend read past its input and the
  database failed. `pgDump` frames frontend messages first.
- A failure of the database's wire during the dump fails the dump with that failure. The fork left the
  exchange's promise unawaited, so it surfaced as an unhandled rejection.
- A failed pg_dump throws `PgDumpError` with `exitCode` and `stderr` (the fork threw a plain `Error`),
  and its `stderr` no longer starts with a warning about the executable's path.
- Only pg_dump's own `\restrict <key>` / `\unrestrict <key>` lines are removed, found by the key. The
  fork removed every line starting `\restrict` or `\unrestrict`, including lines inside a row's text.
  The custom and tar formats and a compressed dump are returned byte for byte; the fork decoded every
  output as UTF-8 text.
- `Repl` requires `pg` (no `usePGlite` context), and its `pg` is any `ReplDatabase`. Its stylesheet is
  a React-hoisted `<style>` rather than an imported CSS file, and its classes and custom properties are
  prefixed `pgwasm-repl-` (the fork's were `PGliteRepl-`). The web component is not ported.
- `Repl` shows each table psql-describe produces, with its caption and footers. The fork showed the
  rows of the describe command's last internal query, so `\d <table>` showed an unrelated result.
- The prepopulated data directory is fetched by URL in Bun as in browsers; the fork read it with
  Node's `fs` there. Databases created from it are marked (ADR-0063).

## pgwasm step 3 drift (ADR-0062 decision 10, 2026-09-27)

The switch moved the client, React, the apps and every test from the PGlite fork onto pgwasm. What changed
in the test estate:

- **Lane renames.** The store's browser lane moved from `tests/e2e/opfs-repacked/` to
  `tests/e2e/pgwasm-opfs/` (`pgwasm-opfs.browser.test.ts`, now also run in WebKit), and its perf tests became
  `pgwasm-opfs-await.perf.test.ts` and `pgwasm-opfs-core.perf.test.ts`. The unit test
  `perf-lab-pglite.test.ts` is now `perf-lab-pgwasm.test.ts`.
- **The test-store seam contract, retyped.** `@pgxsinkit/client/testing` keeps its names
  (`memoryStoreForTests`, `testStoreAcknowledgment`); what it guards is now a `PgwasmClient`. A caller-owned
  `pgwasmInstance` / `precreatedPgwasm` is refused as non-persistent when it is a memory store or a
  filesystem that declares `persistent: false`; a custom filesystem that declares nothing is accepted, as
  before. Store factories (`defineSyncWorker`'s `createStore`, the declared store-engine module's
  fallback export) return a `PgwasmClient`. Supplied and adopted builds are checked against
  `storage.build`, and the typed build refusals are never retried by the OPFS open loop.
- **Fixtures.** The fork-made legacy data directory and Store backup are checked in under
  `tests/unit/fixtures/pgwasm-legacy/` (see the pgwasm section above), so no test needs the fork at run time.
- **Retired halves.** Restoring a pgwasm backup into the fork (maintainer decision D4); the perf lab's
  opfs-ahp comparator column (published results stay as history); the PGlite-fork override runbook and the
  store shim package's own suite, which now runs as pgwasm's `/opfs` tests.

## pgwasm-postgres 18.3.0 (ADR-0064 step 4c, 2026-09-27)

Both build packages now pin the assets of one pgxsinkit/pgwasm-postgres GitHub release, written by
`bun run pgwasm:pin <tag>` and fetched by the root postinstall; `pgwasm-pin` proves the committed pins are
exactly what the command renders for their release, that the manifest and SHA256SUMS must agree, and that a
release of another data format is refused. initdb and pg_dump are byte-identical to the previous pins; the
server, its filesystem bundle, its glue and amcheck are new. Drift the lanes record:

- **Encoding conversions work.** Every loadable module now resolves the server symbols it imports, so
  `convert_to('é', 'LATIN1')` returns `\xe9`, all default conversions run and `LOAD` of a conversion module
  succeeds (`pgwasm-c-engine-features`). On the previous artefacts the first conversion failed the instance
  (`PgwasmFailedError: … TypeError: resolved is not a function`): the conversion module's import of a server
  symbol was never exported.
- **version() names the build.** It reads `PostgreSQL 18.3 (pgwasm-postgres 18.3.0) on
wasm32-unknown-emscripten, …`, and `C_BUILD_IDENTITY.release` is the same name (asserted).
- **The prepopulated data directory** is made by the release's own initdb, deterministically, and is still
  unmarked. Its modes are 0750/0640 (the previous backup's were 0777/0666); a restore does not carry modes
  into the data directory, and restoring it into memory and `file://` storage, rewriting the catalogs and
  reopening are asserted (`pgwasm-c-prepopulated`).
- The data format is unchanged (1, the same compatibility tuple), so every existing store opens as before.

## pgwasm-postgres 18.6.0 (2026-09-28)

Both build packages pin release `18.6.0`: upstream `REL_18_6` plus pgwasm-postgres's patch series at `efcbf6e`, built in the same
builder image. Every asset is new (PostgreSQL 18.6's fixes, one of them for CVE-2026-6478). Drift the lanes
record:

- **version() and pg_dump name 18.6.** `version()` (`pgwasm-c-engine-features`) reads
  `PostgreSQL 18.6 (pgwasm-postgres 18.6.0) on wasm32-unknown-emscripten, …`, and a plain dump
  (`pgwasm-pg-dump`) says `Dumped by pg_dump version 18.6`.
- **Three more exports** (`_RestrictSearchPath`, `_WalRcvIdentifySystemLsn`, `_timingsafe_bcmp`; 1,124 in all).
  Nothing in pgxsinkit calls them.
- The data format is unchanged (1, the same compatibility tuple), so every existing store opens as before.

## Offline return (board ADR-0010)

The board demo's app shell is served offline by a hand-rolled, runtime-capture service worker
(`apps/board/public/sw.js`, plain un-bundled JavaScript copied verbatim to the build root). It is
registered only from built output (`import.meta.env.PROD`) against `import.meta.env.BASE_URL`, so the one
file scopes itself to `/` under `vite preview` and `/demo/` on GitHub Pages. Four behaviours are under
test:

- **Shell precache at install, first-session backfill once ready.** The install's one eager fetch is the
  scope document, because the first navigation of a first visit completes before the worker exists. The
  same blind spot covers the entry assets (the document's own script/style graph, requested during
  parse), so once the worker is ready the page posts it the same-origin URLs the session has already
  fetched and it backfills the ones runtime capture missed (`sw.js` `backfill`; still no manifest,
  nothing a drive-by visitor didn't already download). Everything later is captured as the app fetches
  it anyway. One online session must therefore be sufficient — the lane's cold-return scenario holds
  that line.
- **Two-branch fetch policy, same-origin GET only.** Navigations are network-first with a fallback to
  the cached exact URL and then to the cached scope document (the SPA fallback the worker lane needs,
  since that lane builds with path routing while the Pages build uses hash routing). Every other
  same-origin GET — hashed bundles, the PGlite wasm/data blobs, the worker scripts — is cache-first with
  background fill. Only full same-origin 200s are stored (`response.type === "basic"`), never partials,
  opaque responses or errors; range requests and cross-origin traffic (Supabase auth, the stream edge, the
  write API) are left to the network so an offline failure stays honest. There is no cache pruning:
  superseded content-hashed entries are accepted garbage, never wrong answers.
- **The connection-needed pattern** (`apps/board/src/connection-needed.ts`). Where data cannot exist
  offline the surface says so instead of showing an indefinite skeleton or a dead button. Chat composes
  the existing `settled` convention with `isBackendUnreachable(useBoardSyncStatus())` — the signal is the
  runtime phase `degraded` with reason `stream`, which a read path that cannot reach the server reaches
  two ways (a subscribe that keeps failing for a non-auth reason, via `onSubscribeError`; or the
  read-silence watchdog below), and which clears back to `syncing`/`ready` on the next delivered batch,
  so the state is derived at render time and never latched. `navigator.onLine` is not
  consulted, and the board's
  Offline toggle pauses only the outbound convergence driver, so flipping it must NOT produce the state.
  Sign-in renders outside the sync provider and therefore keys off the auth error's shape instead:
  supabase-js reports a rejected `fetch` as `AuthRetryableFetchError` with status `0`, which
  `signInAs` translates to a `SignInConnectionError`; a 5xx of the same class, and any `AuthApiError`
  (a rejected credential), stay verbatim. This makes the auth-error vocabulary an upgrade gate — a
  supabase-js bump that changes it must be re-pinned here.
- **The outage signal the pattern keys off — the subscribe classifier.** `@durable-streams/client`
  retries only `429`/`503` and throws every other 4xx, and the control plane is where a credential or a
  reachability problem actually lands, so the classification happens on subscribe: a `ControlPlaneError`
  whose status is `401`/`403` raises `auth-needed` through `onAuthError`; anything else raises
  `degraded`/`stream` through `onSubscribeError` while subscribe keeps retrying with backoff. The runtime
  side pins the transitions: never mask `auth-needed` or a commit-failure `degraded` with a stream one,
  refresh a stream-degraded status on each new fault so the reported cause is the current one, and clear
  on the next delivered batch (`onSyncActivity`). Coverage: `tests/unit/client-sync-reset.test.ts` (the
  status machine) and `tests/unit/circuits-subscribe.test.ts` + `tests/unit/circuits-group-sync.test.ts`
  (the classification and the retry).
- **The read-silence watchdog** (`readSilenceMs`, default 45s). A connection that dies by HANGING (a
  physically pulled cable mid-long-poll) settles no attempt and fails no subscribe, so it produces no
  signal at all — and a runtime that reached `ready` this session kept claiming "up to date" for the whole
  outage, broadcasting that claim to every attaching tab in worker mode. A healthy read path is never
  silent: durable-streams answers `204` with the up-to-date header on every long-poll timeout, so every
  cycle fires `onSyncActivity` even for a shape with nothing to send. Silence past the window while
  claiming `ready` therefore drops the phase to the same self-recovering stream-degraded state. Pinned in
  `tests/unit/client-sync-reset.test.ts`: activity inside every window holds `ready`; silence past it
  degrades with a lastError naming the silence; the next batch returns `ready`; and `stop()` clears the
  armed timer (no post-stop emission).

The proof lane is a chromium offline-return e2e in the existing worker harness (`test:integration:worker`,
which serves the BUILT app): sign in online, boot fully, write, close the page, flip the same browser
context offline (same profile = same store, session and caches), open a new page, and assert the
navigation is service-worker-served, the board reaches interactive, eager tables render local rows, the
role-split chat behaviour holds (Admin promoted history versus the Member's ephemeral chat taking the
connection-needed state), and an offline write journals then converges after going online. The suite's
cold-return scenario is the strictest form and the maintainer's manual repro verbatim: one online session
with no reload anywhere, a wait past the SharedWorker's `extendedLifetime` grace so the engine is dead,
then an offline reopen that must cold-boot the engine from the worker cache alone and still paint — the
fast-reopen scenarios can be answered by a surviving worker, so only this one proves the first-session
backfill and the dead-engine boot path. Its assertions are CONTENT-level — the landing redirect completing
offline (`/team/…/board`) and the kanban columns rendering — because sidebar-only assertions once passed
while the real board sat on an eternal spinner (the home route's redirect was gated on `settled`, which no
offline boot can ever reach; local rows must drive navigation).
`tests/e2e/board-offline-return.e2e.test.ts` is the owning suite; nothing else claims this coverage.

## Event lane (ADR-0053)

The lane is covered in three tiers, split by what each can actually prove.

**Unit** (`tests/unit/event-*.test.ts`, `tests/unit/board-event-lane.test.ts`) owns the semantics: append
validation and Outbox durability, batch assembly and per-event verdict settlement (including the
non-terminal `deferred`), the two retry classes with no attempt cap, the drain signal and report surfaces
across both client forms, the ingestion endpoint's layered verdicts, the queue interface, the consumer
runner's pacing/visibility/dead-letter behaviour on a fake queue, and — board-side — that the demo stream
survives the per-role registry projection and maps onto its archive row.

**Container** (testcontainers/Podman) owns pgmq end-to-end: enqueue → consume → ack → dead-letter against a
real extension, plus `set_vt` holding a delivered message invisible past its original lease.
`tests/integration/event-lane-pgmq.integration.test.ts` is the owning suite and it runs in
`test:integration:implementation` (and therefore in `test:integration`); nothing else claims this coverage.

**Browser** (`tests/e2e/board-event-lane.e2e.test.ts`, in the existing `test:integration:worker` harness)
owns the two claims only a real browser can make: an append made through the real UI, against the real
`board-write` deployment, with the engine in a SharedWorker, drains from the Outbox; and an append made
with the network cut stages, survives the tab being closed and reopened with connectivity still gone, and
drains on reconnect. The offline order is deliberate — the client never deletes an Outbox row without a
server verdict, so "staged across a reload, then empty after reconnect" is the round-trip proof that
"append online, observe empty" could not be (empty is also the resting state).

That lane deliberately does NOT assert the event reached the board's `board_issue_view_event` archive: the
consumer runner is a separate long-lived process (`bun run dev:board:consumer`) that the worker lane does
not host, and the Playwright specs have no database client. The consumer half is the unit and container
tiers' job.

## Integration tests

Integration tests are container-backed and require `infra/compose/docker-compose.yml`.

Each integration test command launches its own isolated Podman Compose project on ephemeral host ports, runs tests against those URLs, and tears containers down (including volumes) afterwards. This keeps integration runs independent from demo/example containers and from each other.

This is the canonical integration workflow for the repo.

Schema ownership for integration tests is strict:

- PostgreSQL tables used by the demo app and integration suites belong in `packages/schema` and must be migrated through Drizzle.
- Integration tests must not create server-side tables inline when the shape can be expressed through Drizzle schema modules and normal migrations.
- Cleanup should prefer Drizzle table deletes or other schema-owned helpers over handwritten setup SQL.

Since the repo-wide raw-SQL→Drizzle campaign, fixtures, seeds, and assertion reads are **Drizzle-authored**, not hand-written SQL:

- `tests/support/drizzle.ts` provides `drizzleOver(pg)` (a memoized tier-① Drizzle handle over any test PGlite instance) and `createTablesFromSchema(db, schema)` (creates fixture tables by generating empty→schema migration statements offline), so setup and assertion reads run through Drizzle builders.
- `tests/support/catalog-tables.ts` supplies read-only Drizzle stubs for the system catalogs the suites introspect (`information_schema.*`, `pg_catalog.*`), so schema/DDL assertions select through Drizzle instead of raw catalog SQL.
- The client's local-table factories (`getSyncedLocalTable` / `getOverlayTable` / `getJournalTable` / `getSyncStateView` / `getReadModelView` / `getLocalMetaTable` from `@pgxsinkit/client`) give typed Drizzle objects for the generated local relations, so overlay/journal/sync-state assertions no longer hand-write SQL against `<t>_overlay` / `<t>_mutations`.

The accepted raw remainder is the justified tier-③ set — SQL that genuinely cannot be a Drizzle object:

- `GRANT`/`REVOKE` to Supabase roles such as `authenticated` (Drizzle policies do not grant table privileges by themselves).
- PL/pgSQL function DDL and execution paths intentionally generated as SQL artifacts.
- Session/constraint commands (`SET`, `ALTER CONSTRAINT ... DEFERRABLE`) and `COPY` bulk-load paths.
- Planner-experiment text exercised as literal strings — the RLS read-load track's `shape-query` mode
  renders the row filter's Postgres spelling itself (`tests/performance/support/rls-read-load.ts`),
  because the contracts builders now emit a predicate AST that is deliberately never SQL, and the
  comparison it makes is against a query planner.

Run them by slice when possible:

- `bun run test:integration:contract` for public facade contract coverage
- `bun run test:integration:implementation` for lower-level implementation coverage
- `bun run test:integration:placement` for the Chromium server-backed placement family
- `bun run test:integration` for the full integration suite

Use `bun run infra:harness:up` only for manual local reference development (the `apps/write-api` minimal server). It applies the committed infra/drizzle migration history after infra becomes reachable. Integration scripts must not depend on or reuse that shared stack. (The substantial board demo uses its own stack via `bun run infra:up`.)

### Contract suites

These verify the public facade surfaces against non-demo registries and should stay focused on externally visible behavior.

- client facade readiness, persistence, local typed access, and write-path diagnostics
- server facade diagnostics, health, CRUD behavior, validation, and missing-record handling

### Implementation suites

These verify the lower-level integration behavior behind the facades.

The canonical scenarios are:

- initial sync from PostgreSQL through the Circuits engine and durable-streams into PGlite
- server-side writes becoming visible to a running PGlite subscriber
- write API validation failures and successful persistence
- local batch submission through the public client facade, including create-plus-update chains before flush
- deferred foreign-key behavior for out-of-order batch writes
- repeated polling without fixed sleeps

## Upgrade gates

When changing PostgreSQL, the Circuits engine, durable-streams, PGlite, or the internalized read path (the reader in `packages/client/src/circuits`, the applier in `packages/client/src/sync`), add at least one regression test for any newly observed drift.

Recorded apply-semantics drift (read-path engine):

- **Generated-identity PKs.** drizzle-orm's insert builder drops a `GENERATED ALWAYS AS IDENTITY` column from `.values()`, so the insert-family apply paths (CDC per-row, bulk-insert tier, move-in upsert) now emit `INSERT … OVERRIDING SYSTEM VALUE` when the applied columns include such a column, preserving the server's authoritative id. Regression: `tests/unit/bulk-apply.test.ts` ("generated-identity PK") asserts the applied ids MATCH the delivered server values, not a local sequence.
- **Enum columns.** The apply-ladder classifier now treats Drizzle `pgEnum` columns as COPY-safe / JSON-safe (via `SyncColumnType.isEnum`) instead of falling to the per-row `insert` floor; the `json_to_recordset` cast identifier-quotes and schema-qualifies the enum type name. Regressions: `tests/unit/apply-strategy.test.ts` (enum classification) and `tests/unit/bulk-apply.test.ts` ("enum columns") round-trip labels through the COPY and JSON tiers.

## Performance tests

Performance and abuse tests live outside the normal validation lane.

Use:

- `bun run test:performance`
- `bun run test:performance:client`
- `bun run test:performance:concurrent`
- `bun run test:performance:concurrent:matrix`
- `bun run test:performance:server`
- `bun run perf:lab`

These runs may take 10-30 minutes, seed large datasets, and write result artifacts under `tmp/perf-results/` or a custom `PGXSINKIT_PERF_RESULTS_DIR`.

The automated performance suites enforce coarse default p95 budgets for client mutation latency, client optimistic-read latency, and server write-batch latency. Override those defaults with:

- `PGXSINKIT_PERF_CLIENT_MUTATION_P95_MAX_MS`
- `PGXSINKIT_PERF_CLIENT_READ_P95_MAX_MS`
- `PGXSINKIT_PERF_SERVER_BATCH_P95_MAX_MS`
- `PGXSINKIT_PERF_CONCURRENT_ENQUEUE_P95_MAX_MS`
- `PGXSINKIT_PERF_CONCURRENT_FLUSH_P95_MAX_MS`
- `PGXSINKIT_PERF_CONCURRENT_CONVERGENCE_P95_MAX_MS`

They must not be added to `validate`, `test`, `test:unit`, or `test:integration` by default.

The main goals are:

- apply-function abuse testing
- large-schema and large-row-count scenarios
- optimistic local read performance with 100k+ local rows and large pending journals
- flush throughput under realistic journal sizes so query-shape and index changes can be measured independently from local enqueue costs
- end-to-end concurrent multi-client pressure with real auth identities, real sync, and real server contention

The performance lanes are intentionally distinct:

- `test:performance:client`: local-only optimistic staging and read costs inside one client
- `test:performance:concurrent`: end-to-end multi-client mutate, flush, sync-echo, and convergence behavior under contention
- `test:performance:server`: server-only concurrent `/api/mutations` pressure

The browser lab at `apps/perf-lab/` is the manual companion for those client-runtime scenarios. `bun run perf:lab` launches a dedicated fixed-name stack for the lab itself, tears any prior `pgxsinkit-perf-lab` processes and containers down first, and writes browser-lab logs under `tmp/perf-lab/`. It stands the native read path up itself (`scripts/perf-lab-server.ts`, `scripts/perf-lab-config.ts` — durable-streams, the engine, and an in-process control plane + edge on one origin). Its default live mode reprovisions the active synthetic registry on the dedicated write server, seeds PostgreSQL, waits for those rows to sync into browser PGlite down the read path, stages local mutations, flushes them upstream, and waits for the read-path echo plus reconcile pass to settle before calling the full cycle complete.

The concurrent client lane now uses scenario-driven mixed mutation traffic keyed by `PGXSINKIT_PERF_SCENARIO_KEY`, with create and delete probabilities configurable alongside the existing burst-shape knobs. The first pass covers `mixed-small-bursts`, `mixed-small-plus-large`, and `hot-partition-overlap`. Same-row conflicts, disconnect/reconnect, restart-resume, and deliberate server-failure scenarios still belong in the same lane but remain follow-up work.

Use `bun run test:performance:concurrent:matrix` to run the preset/scenario grid sequentially. Filter it with comma-separated `PGXSINKIT_PERF_MATRIX_PRESETS` and `PGXSINKIT_PERF_MATRIX_SCENARIOS` values when you want to run only part of the matrix.

The performance runner is now single-owner by design: it uses a fixed Podman Compose project name, refuses to start if another `run-performance-suite.ts` process is still alive, tears down stale suite containers before relaunch, and prunes leftover `tmp/pgxsinkit-perf-concurrent-*` work directories on startup and shutdown. If a prior run was interrupted, rerun the same command in the foreground and let the harness recover that stale state before starting new work.

The concurrent mixed-load harness now keeps the shared hot row pool limited to rows that were already synced for all same-user clients at scenario start. Freshly created ids remain client-local until later sync distributes them, which prevents sibling clients from enqueueing updates or deletes against rows they have not hydrated yet. Delete targets are also reserved out of the shared pool as soon as a batch is assembled so sibling clients do not plan follow-up mutations against rows that are about to disappear from their local read models.

## Provisioning parity

Integration coverage should reflect the provisioning workflow described in:

- `docs/migrations.md`
- `docs/function-artifacts.md`

In staging/prod, keep at least one contract suite path running against the preinstalled function migration, not startup-generated SQL.
