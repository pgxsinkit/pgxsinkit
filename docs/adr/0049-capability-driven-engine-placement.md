# Capability-driven engine placement: opfs-repacked on every platform

Status: accepted (2026-07-21; revised four times same day across pre-implementation reviews —
commitment namespaces + lifecycle, liveness policy, adoption authority, election ownership,
relocation semantics, and provenance gates reworked; the plan carries the accepted-risk register
that closes the review cycle)

ADR-0048 delivered `opfs-repacked` — a constant-four-handle OPFS VFS that runs on every engine,
including WebKit's ~252-handle cap — but left hosting as "a consumer decision outside this package",
and ADR-0032 put the whole sync engine inside a native `SharedWorker`, where Chromium and Firefox
deny `createSyncAccessHandle`. Together those decisions confine every browser store to `idbfs`. This
ADR closes that gap: **`opfs-repacked` is the toolkit's default browser store on all three
platforms**, and the engine's placement is a runtime capability decision instead of a fixed
topology.

Drivers, in order:

1. **Reliability.** Even relaxed, `opfs-repacked` is structurally safer than `idbfs`: incremental
   extent writes under a poison contract, versus detached whole-FS snapshots whose failures are
   latched and replayed later. The failure modes are smaller, earlier, and attributable.
2. **One storage story.** One VFS across platforms means one performance profile, one durability
   model, one debugging surface. `idbfs` is fallback-only everywhere instead of being the primary
   on two of three platforms.
3. **Affordable strict durability.** Per-commit flush on idb costs ~100–160 ms/op; on
   `opfs-repacked` it is cheap enough to actually opt into where it matters.

The evidence gate is met: the real-device bench (`/bench/`, 2026-07-21, macOS + iOS Safari) returned
`sharedWorkerProof: granted-and-persisted` — the full repacked engine booted, persisted, and
reopened inside SharedWorker scope — and the `opfs-repacked-sw` column timed within noise of the
dedicated-worker column, so SharedWorker-direct hosting costs nothing where it is granted.

Nothing here reopens `@pgxsinkit/pglite-opfs-repacked` itself: the VFS format, recovery, and
durability contract stand as signed off under ADR-0048. Everything below is the toolkit lifecycle
layer above `RepackedVfs.open()`.

## Decision

1. **The SharedWorker is always the attach point; the engine's home is probed, not assumed — and
   the probe is unconditional.** At boot the SharedWorker probes its OWN scope by actually opening
   a sync-access handle (the bench phase-0 mechanism — never method presence). Granted (WebKit
   today): the engine boots in the SharedWorker itself and the election machinery never engages.
   Denied (Chromium, Firefox): the engine boots in an elected tab-spawned dedicated worker holding
   the handles. The engine CORE (`defineSyncWorker`'s sync client, live queries, journal,
   convergence) runs unchanged in either home; the worker entry gains a control plane (decision 4),
   and the attach surface gains toolkit-owned worker construction, a liveness protocol, and
   relocation semantics (decision 5). If an engine later exposes handles in SharedWorker scope, its
   placement collapses to the simpler form automatically.

   **The registry declares storage; placement is detected, never declared.**
   `SyncRegistryDefinition` gains
   `storage?: { backend?: "opfs" | "idbfs"; durability?: "relaxed" | "strict" }` (contracts-owned;
   durability semantics in decision 9 and ADR-0047). `backend` defaults to `"opfs"`: the capability
   machinery above is the store's normal boot on every platform. `backend: "idbfs"` is the one way
   to opt out — no probe runs, no election exists, the engine boots in the SharedWorker on the
   idbfs backend. The declaration is part of the storage contract, so it lives with the data
   contract, not the worker entry or the attach site. There is no consumer-facing placement mode:
   where the engine runs is the toolkit's runtime decision.

   The declaration scopes the BROWSER store only. Environment resolution is orthogonal and
   unchanged (decision 14): a Node mint from the same registry — including server-side generation
   of a client store artifact — stays `file://`, and the export clone stays memory. Restore
   artifacts compose with any backend: a `restoreFrom` seed is a `loadDataDir` payload applied at
   store creation, above the VFS, so a server-generated artifact restores into an opfs-repacked
   candidate through the restored-store provenance gate (decision 7) exactly as it restores into
   idbfs.

   **Capability absence falls back; wiring failure errors.** Under `backend: "opfs"`, the toolkit
   falls back automatically to the in-SharedWorker idbfs engine — with the declared durability
   unchanged — exactly when the platform cannot provide OPFS sync access in ANY home: the OPFS API
   is absent or throwing in both the SharedWorker scope and a dedicated worker, or every home's
   probe is denied (storage permission, quota). The fallback is observable, never silent-invisible:
   BootReport carries `storageBackend: "idbfs"` plus the fallback reason (decision 12), and the
   existing-store rules of decisions 6–8 apply unchanged (a fallback boot is record-free; an
   existing idb store's data is never overwritten by a later opfs mint; adoption is the only path
   that replaces it). A failure of WIRING is never a fallback: election required but the engine
   worker cannot be constructed (spawn failure; an underivable entry URL with no
   `createEngineWorker` override) is a hard typed error — the capability was present and the
   configuration was wrong, and silently downgrading storage would hide the defect.

2. **Election is a Web Locks queue behind ONE per-tab election coordinator with an explicit claim
   lifecycle.** Each tab owns a single election coordinator per store, shared by pre-attach
   provisioning and attach: the leader lock is requested at most once per tab, and a later attach
   ADOPTS the coordinator's existing grant and engine rather than re-queuing. The coordinator is
   CLAIM-COUNTED: a provision holds one claim (with an expiry deadline — an abandoned warmed
   engine is torn down and its lock released), each attachment holds one claim (released by
   `stop()`/detach/failed spawn), and on last-claim release the coordinator retires the engine
   (decision 5's retirement notice, then `engine-teardown` → ack/timeout) before settling its lock
   callback. On **BFCache entry** (`pagehide` with `persisted: true`) the coordinator releases
   leader authority and retires the engine; on `pageshow` it re-queues and re-attaches. Tab death
   releases the lock structurally; the VFS store-ownership lock (ADR-0048) remains underneath as
   the hard single-owner guard. On handle-denied platforms, pre-attach provision triggers this
   same election and the winner's engine executes it. Provision remains a pure accelerator: before
   minting on **any** placement it performs the bounded store-meta read, and a live `deleting`
   record declines the pre-mint so the first attach runs the ordinary resumable phase machine.
   A rejected precreate likewise falls back through that complete phase machine, never directly
   to a replacement mint beneath unresolved authority.

3. **Spawn on grant only.** No per-tab hot-spare workers. A non-leader tab's worker would never
   serve a request (tabs talk through the toolkit's own channels, unlike upstream `PGliteWorker`
   where each tab's worker is its RPC endpoint), so a spare is purely a pinned module graph per
   tab. Failover cost is one cold engine boot.

4. **Tab identity is preserved by per-tab proxy pipes under an instance-scoped engine-identity
   protocol.** Bridge correlation ids are unique only within a tab, so tabs are NEVER multiplexed
   onto one stream. Per attached tab the SharedWorker mints a proxy `MessageChannel` and transfers
   one end to the engine over the control channel; from then on that tab's RPC/live-query traffic
   flows tab↔engine DIRECTLY on the pipe (the SharedWorker is not in the data path and never
   inspects payloads — which is also why buffering and outcome classification live attach-side,
   decision 5). The engine's dedicated-worker entry accepts dynamically transferred ports and
   feeds each to the same `SyncWorkerHost.connect` the SharedWorker `onconnect` path already uses
   N times. **Engine identity** is the PAIR `(SharedWorker instance id, generation counter)`;
   staleness checks always compare the pair. The control plane carries `leader-granted`,
   `engine-announce`, `engine-ready`, `connect-port`, liveness probes, `engine-retiring`, and
   `engine-teardown`; stale-identity messages are discarded.

5. **Relocation, handoff, and liveness — outcome-honest and placement-scoped.**
   - **The handoff window is an attach-side state.** On a relocation notice (`leader-granted`,
     `engine-retiring`, or an engine-loss verdict, relayed by the SharedWorker to every tab) the
     attach client queues NEW calls locally (bounded cap + deadline) and flushes them to the new
     engine after re-attach; live queries re-establish through the normal re-attach and
     staged-readiness flow (ADR-0041).
   - **Outcome-classified failure, never a blanket "retryable".** The attach client owns the
     pending-op map and classifies every op it must fail: a NEVER-DISPATCHED op fails
     `outcome: "not-dispatched"` (safe to retry — and queued ops are normally just held, not
     failed); a DISPATCHED READ is safe to repeat after relocation; a DISPATCHED MUTATION whose
     response was lost fails `outcome: "unknown"` — its journal update may already exist, there is
     no mutation-dedup key, so the caller is directed to inspect/reconcile, never auto-retry. The
     same classification applies when a pipe is replaced (a new SharedWorker instance hands out
     fresh pipes: outstanding old-pipe calls are settled with this classification and the old pipe
     closed — never replayed).
   - **Deliberate retirement opens the window first.** Last-claim teardown, BFCache exit, and
     execution-limit termination all send the identity-tagged `engine-retiring` notice BEFORE the
     engine goes away, so new calls queue instead of racing a dying engine.
   - **Engine death, reported paths**: the leader's worker `error` event, spawn failure, and tab
     death are immediate engine-loss verdicts.
   - **Engine death, silent paths — an ELECTED-PLACEMENT feature with an opt-in limit.** There is
     no false-positive-free timing detection (consumers may run arbitrarily expensive SQL, and the
     control channel shares the blocked worker event loop). The policy is an explicit
     **execution limit**: one engine-construction value (mismatch rejected), **disabled by
     default** — no finite worst-case query duration exists, and the limit CONVERTS slow to
     terminated by policy, so enabling it must be a deliberate consumer choice. When enabled and
     breached (a tab reports its overdue dispatch; the SharedWorker's control-channel probes then
     go unanswered past the threshold), the LEADER'S coordinator deliberately terminates the
     suspected worker — idempotent if already dead — waits for the VFS ownership release that
     agent termination guarantees, and respawns. The limit is never claimed as death evidence. On
     SharedWorker-direct placement this feature does not exist: a hung in-scope engine blocks the
     router's own event loop and a SharedWorker cannot be terminated from a page — reported errors
     and ordinary browser/process termination remain covered, and the silent-infinite-hang case is
     an accepted platform limitation (risk register), not a reason to abandon the simpler WebKit
     placement.
   - **SharedWorker death**: the LOCK HOLDER is the causal recovery agent. Its coordinator runs a
     low-frequency keepalive to the SharedWorker; a missed-ack threshold makes IT reconstruct the
     SharedWorker via the attach factory, re-attach, and re-announce its still-live engine
     (in-flight pipe traffic survives — the pipes are direct; settlement applies only where pipes
     are replaced). Non-leader tabs reconnect on their own bridge-silence deadlines. This narrows
     ADR-0032's "no heartbeats": exactly ONE tab carries a keepalive, elected platforms only.
   - **Worker construction is toolkit-owned; the attach input is a factory.** `attachSyncClient`
     takes the SharedWorker as a FACTORY (`worker: () => SharedWorker`) — a SharedWorker object
     cannot be reconstructed from itself, and the factory is what makes the recovery above a
     guarantee rather than an option. A bare instance or port-shaped transport is accepted for
     tests and exotic hosts, where reconstruction is structurally impossible and diagnostics say
     so. The ELECTED engine worker needs no consumer wiring: the worker entry is dual-scope (one
     file serves both homes), the SharedWorker reports its own script URL (`self.location.href`)
     in the placement reply, and the winning tab constructs the engine as
     `new Worker(reportedUrl, { type: "module" })`. `createEngineWorker` remains as an override
     for entries that cannot be reconstructed from their URL (classic-script workers,
     `blob:`/`data:` URLs, CSP constraints); with no override and no derivable URL, attach fails
     with a typed error (decision 1) — never a silent no-engine attach. Auto-derivation assumes a
     module worker — the only shape the published ESM entry supports; the override covers the rest
     (risk register).

6. **Commitment lives in disjoint toolkit-owned namespaces; the meta record is a total phase
   machine and the first-use authority.** The toolkit owns a container at the OPFS root with
   DISJOINT child namespaces (a suffix-sibling sentinel collides across valid identities):
   ```text
   pgxsinkit/stores/<identity>/        the four-file VFS store directory
   pgxsinkit/commitments/<identity>    the committed sentinel file
   pgxsinkit/probe/…                   placement-probe scratch
   ```
   The per-store **meta record** (small dedicated IndexedDB database — readable in every engine
   home) is written at the first grant-scoped capability boot and completes before that backend is
   exposed. Registry-forced idbfs boots and capability-fallback boots remain record-free and are
   classified through the recordless-idb arm; the exception is an existing `deleting` record, whose
   denied-boot recovery writes `idb-authoritative` because it transfers durable authority. Its
   state is ONE total phase —
   `idb-authoritative | opfs-candidate | adopting | opfs-committed | deleting` — with `deleting`
   taking precedence over everything (a committed store mid-destruction resumes deletion, never
   the committed verdict), and `adopting` over ordinary idb boot. Destruction completes by
   DELETING the record. A failed meta read is an ERROR (bounded retry, then fail closed), never
   "no record". Commitment publishes sentinel first, then the `opfs-committed` phase;
   sentinel-without-record reads as committed and repairs the record. Boot classification:
   - Phase present → it is authoritative (per its precedence above).
   - No record, OPFS observable → sentinel present → committed (repair); candidate directory
     without sentinel → delete + rebuild fresh; nothing present → **recordless-idb check**: a
     NON-CREATING idb existence check (an `indexedDB.open` aborted on `upgradeneeded` — never
     `databases()`, which is absent on some engines) finding an existing idb store establishes
     `idb-authoritative` — a recordless idb store is a first-class citizen, not an anomaly: it is
     what a registry-forced idbfs store or a capability-fallback store IS, and it is the ENTRY
     POINT of the forward idbfs→opfs transition (adoption drains the idb journal, then resyncs
     fully server-sourced into opfs). Its data is never overwritten by a fresh opfs mint — only a
     store-less profile is virgin and creates per placement, record first.
   - No record, OPFS NOT observable (throwing OR API absent — present absence is not historical
     proof) → the recordless-idb check still runs; an existing idb store is `idb-authoritative`;
     otherwise boot idb without inventing new meta authority. The double-loss residual (record wiped AND
     observability withdrawn over a committed store) is accepted risk; a later sentinel/record
     conflict surfaces as a hard error, never silently resolved.

7. **Commitment gates are provenance-specific; one strict barrier is universal.** Each store
   provenance has the authority gate that actually proves ITS data source, and an uncommitted
   candidate is NEVER exposed to writes (commitment precedes exposure — a candidate scheduled for
   deletion can never hold a user's mutation):
   - **Fresh store**: successful local initialization/recovery. No server contact required — no
     predecessor is deleted, so early commitment strands nothing, and an offline-first boot works.
   - **Restored store** (`restoreFrom`, ADR-0035): successful backup load + restore recovery. A
     backup is authoritative, may hold local-only data and quarantined mutations, and deliberately
     boots offline — it must never await server catch-up nor be scheduled for deletion.
   - **idb adoption**: successful AUTHORIZED online server reconstruction — the initial catch-up
     of the eager Consistency groups a valid initial store requires ("authorized" includes
     legitimately anonymous/public shapes; no auth token is demanded where the server permits
     anonymous access). Staged-readiness milestones never qualify (`localReadReady` is
     offline-local; `ready` resolves under `syncEnabled: false`). Only adoption needs this gate,
     because only adoption deletes a predecessor.
   Then ONE shared durability sequence: provenance gate → explicit `strictSync()` returns with VFS
   health good (data-before-authority, required even under relaxed runtime durability) → sentinel
   → `opfs-committed` phase → expose the store / delete the predecessor as applicable. If the
   barrier fails, nothing publishes.
   **Adoption eligibility and quiescence:** automatic adoption only under the explicit
   reconstructibility/disposability declaration, DEFAULT OFF (adoption deletes a predecessor, and
   hook absence is never authority — `rawExec` writes documented local-only state on any store);
   the transition is pre-expose with the drain predicate in canonical journal terms
   (`pending + sending + failed + quarantined + conflicted == 0`; `acked`/`rejected` permitted).

8. **One toolkit-owned destructive lifecycle, supervised above the engine.** ADR-0048's permanent
   recreate-only policy requires delete-and-recreate on any format break — and with commitment
   authority outside the store directory, deleting only the directory would fail every fresh
   creation closed. One resumable machine serves explicit `destroy()`, authorized corruption
   recovery, and format breaks: (1) refuse owed mutations unless `force`; (2) stop new admissions;
   (3) quiesce/close the engine (all four handles released); (4) record the `deleting` phase;
   (5) delete sentinel, then store directory (or the idb database — two backend branches of one
   lifecycle); (6) delete the meta record. Every boundary is resumable — a boot that finds
   `deleting` completes the deletion first. The attached facade gains `destroy()` (today
   `notSupported`), SUPERVISED by the coordinator/SharedWorker context that survives engine
   shutdown — never an ordinary RPC whose responder closes itself; the initiating call resolves
   from the surviving supervisor. With other tabs attached, destruction REFUSES (close the peers
   first — the simpler contract; revisit only if UX demands). "Corruption recovery" means the
   lifecycle owner explicitly authorizes recreation after a fail-closed error — a corrupt
   activated store is never auto-deleted.

   On SW-direct placement the tab supervisor asks the in-scope host to close, receives an
   identity-matched success/error acknowledgement, and the SharedWorker scope then closes itself.
   Recreation therefore starts a new SharedWorker lifetime; the implementation does not retain a
   closed host and rebuild it inside the old lifetime. An acknowledgement timeout is not proof that
   the scope or its handles are gone: the bounded deletion attempt may fail and leave `deleting` for
   the next boot.

   A denied boot that encounters `deleting` cannot inspect the synchronous OPFS store, but it can
   complete a narrow authority handoff: honestly delete the old IDB database, remove the commitment
   sentinel through asynchronous OPFS, write `idb-authoritative`, then create the replacement IDB
   store. Sentinel-less OPFS residue is disposable and removed before any later candidate reuse. If
   sentinel removal cannot be confirmed, the record remains `deleting` and boot fails closed. IDB
   deletion resolves only on `onsuccess`; `onblocked` is nonterminal and a bounded timeout leaves the
   resumable phase intact.

9. **Durability is registry-declared; relaxed is the default on every backend.** ADR-0047's
   default and loss-window analysis apply to opfs stores verbatim; `storage.durability: "strict"`
   on the registry is the one opt-in, and it binds every open of every store minted from that
   registry — durability is a property of the data contract, so no open-site option exists to
   contradict it, and an opfs→idbfs fallback (decision 1) keeps the declared durability. Crash
   expectations are stated against the strict-sync boundary: STRICT guarantees a mutation only
   once its strict synchronization has RETURNED; before that boundary, and always under relaxed,
   ADR-0048's crash model applies verbatim (longest valid stable prefix; the terminal
   not-yet-flushed mutation may be absent).

10. **Relocation is a stable public error contract with outcome semantics.** The bridge/pipe error
    shape carries a clone-safe discriminator
    (`{ code: "engine-relocated", outcome: "not-dispatched" | "unknown" }`), reconstructed
    attach-side as the exported `EngineRelocatedError`: `not-dispatched` is safe to retry;
    `unknown` (a dispatched mutation with a lost response) directs the caller to
    inspect/reconcile and is never auto-retried. Consumers branch on the type and outcome, never
    on prose.

11. **Store identity has one injective encoding over a defined domain.** A single
    `storeIdentityComponent(storePath)` (percent-encoding — injective, never lossy sanitising)
    produces the canonical single-component token used in every namespace of decision 6 and for
    the leader lock, meta record key, and SharedWorker name. Lone UTF-16 surrogates are rejected;
    the ENCODED length is capped per filesystem component; and the two reserved component names
    the encoding passes through unchanged — `.` and `..` — are rejected at the boundary
    (`InvalidStorePathError`). `file://` keeps the raw path; `idb://` keeps PGlite's existing
    database naming.

12. **Diagnostics: `storageBackend`.** BootReport and diagnostics carry
    `storageBackend: "opfs-repacked" | "idbfs" | "filesystem" | "memory"` plus the engine home and
    any fallback reason (`reportVersion` stays `1` under ADR-0034's versioning rule). The existing
    `storeKind` (`"fresh" | "warm" | "restored"`) keeps its meaning untouched.

13. **Placement of the code.** `packages/client` takes a hard dependency on
    `@pgxsinkit/pglite-opfs-repacked`; `store-path.ts` gains the `opfs://` scheme and remains the
    only place that assembles store URLs; the election coordinator, router, and control-plane
    machinery live in `packages/client/src/worker/`; the storage declaration lives in
    `packages/contracts` (`SyncRegistryDefinition.storage`) and is interpreted by
    `packages/client`.

14. **Unchanged surfaces.** The no-SharedWorker fallback stays the in-process main-thread `idbfs`
    client (a main thread can never hold sync-access handles). Node stays `file://`. Extension-host
    topologies are consumer decisions (transcrobes ADR-0002 is follow-up work there).

## Alternatives considered

- **Engine stays in the SharedWorker, SAB-bridged VFS.** Rejected: forces `crossOriginIsolated`
  onto every consumer app, adds a synchronous cross-worker I/O bridge, and leader death still
  stalls the engine mid-query.
- **Async-OPFS snapshot FS.** Rejected: inherits the O(store-size) sync cost and snapshot failure
  modes that are among the drivers for leaving idbfs.
- **A consumer-declared placement mode (a worker-entry `placement` option).** Rejected: placement
  is a runtime capability fact, not a preference — a declared mode either restates what the probe
  would find or forces a worse topology. The one legitimate demand ("never use OPFS") is a
  STORAGE contract, so it lives on the registry (`backend: "idbfs"`), and placement stays the
  toolkit's decision.
- **Consumer-supplied worker factories as the primary wiring (optional, with a documented
  degraded mode when absent).** Rejected: the worker entry is dual-scope and the SharedWorker
  knows its own URL, so the toolkit can construct the elected engine itself; an attach that
  cannot elect an engine on a denied platform is a misconfiguration, and the honest response is a
  typed error, never a silent no-engine attach or a quietly weaker recovery story.
- **Uniform elected-worker on every platform.** Rejected: ignores a granted capability to maximize
  leader churn on exactly the platform (iOS) where tab eviction is most aggressive.
- **Firefox-only nested worker.** Rejected: a third arrangement for a minuscule market share.
- **Per-tab hot spares (upstream `PGliteWorker` shape).** Rejected: a pinned module graph per tab
  for a fraction of one failover second.
- **Blind replay of in-flight RPCs on handoff / a blanket `retryable: true`.** Rejected across
  reviews 1 and 4: no mutation-dedup key exists, so a dispatched mutation's outcome is UNKNOWN —
  the error contract says so instead of inviting double-apply.
- **Directory existence as commitment** (review 1), **in-directory sentinel** (review 2 — the VFS
  owns exactly four in-directory files), **suffix-sibling sentinel** (review 3 — collides across
  valid identities): all rejected; disjoint toolkit-owned namespaces replace them.
- **One universal online commitment gate** (revision 3's shape). Rejected in review 4: it stranded
  offline-first-boot writes in a deletable candidate and was incompatible with `restoreFrom`'s
  authoritative offline boot — provenance-specific gates + one strict barrier replace it.
- **Boolean meta fields.** Rejected in review 4 for a total phase machine with `deleting`
  precedence — booleans left committed+deleting and idb+adopting ambiguous.
- **Fallback on any uninspectable commitment namespace with no meta record.** Refined across
  reviews 2–4 into: first-use record + recordless non-creating idb existence check + fail-closed
  meta errors; the double-loss residual is accepted risk, surfaced on conflict.
- **Timing-based silent-death detection / always-on execution limit.** Rejected: no finite
  worst-case query duration exists; the limit is opt-in, converts slow to terminated by policy,
  and exists only where termination is possible (elected placement).
- **Reconstructibility inferred from hook absence.** Rejected (review 3): only the explicit
  declaration authorizes automatic adoption.
- **Multiplexing all tabs onto one engine stream.** Rejected (review 1): per-tab pipes preserve
  identity structurally.
- **Per-tab heartbeat/lease liveness.** Rejected as a standing all-tabs protocol; adopted only as
  the single lock-holder keepalive (review 2).

## Consequences

- ADR-0032 is amended: the SharedWorker is always the attach point; the engine home is probed;
  leader election exists on handle-denied platforms only; "no heartbeats" narrows to "no per-tab
  heartbeats".
- ADR-0048's "hosting topology is a consumer decision outside this package" is superseded; its
  recreate-only policy now has the destructive lifecycle it requires. The VFS package itself is
  untouched — reviews 1–4 requested no change to its format, recovery, or durability contract.
- The public surface this ADR defines: the registry storage declaration
  (`storage.backend`/`storage.durability`), the factory-shaped attach input and the
  `createEngineWorker` override, the adoption declaration (default off) + manual adoption
  trigger, `destroy()` on the attached facade, `EngineRelocatedError` with outcome semantics, and
  the opt-in execution-limit configuration (disabled by default).
- Two engine-placement paths exist and both must stay tested; `docs/testing-strategy.md` must be
  refreshed before ADR-0049 is declared complete.
- The plan carries the normative **accepted-risk register** (double loss, SW-direct silent hang,
  module-worker assumption for auto-derived engine entries, keepalive false-positive benignity,
  same-origin interference, BFCache crash coverage, bounded meta fault testing): items on it are
  settled and are not relitigated in future reviews.
- A one-time re-bootstrap per user is the adoption cost; adoption additionally requires the
  explicit declaration and the authorized online reconstruction gate. Fresh and restored stores
  commit without any server requirement.
