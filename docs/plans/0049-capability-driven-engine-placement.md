# Plan — ADR-0049: capability-driven engine placement, opfs-repacked on every platform

Implements [ADR-0049](../adr/0049-capability-driven-engine-placement.md). Grilled and decided
2026-07-21; revised four times the same day across pre-implementation reviews. Decision numbers
refer to the ADR. The **accepted-risk register** below is normative: items on it are settled and
not relitigated.

## Bounded-context vocabulary

Canonical terms in `CONTEXT.md` § "Language — engine placement": **communication centre**,
**engine home**, **placement probe**, **election coordinator**, **leader lock**, **leader
keepalive**, **elected engine worker**, **engine identity**, **handoff window**, **store meta
record**, **commitment marker**, **adoption gate**, **adoption-bootstrap gate**, **drain
predicate**, **destructive lifecycle**. Plan and code comments use these terms exactly.

## Goals and explicit non-goals

Goals: opfs-repacked primary on all three platforms behind one attach surface; no acknowledged
write ever stranded (including offline-first-boot and restored stores — provenance gates, D7); no
silent deletion of local-only data (declaration-gated adoption, default off); honest relocation
outcomes (no blanket "retryable", D10). The public surface this delivers: the registry storage
declaration (`storage.backend`/`storage.durability`), the factory-shaped attach input
(`worker: () => SharedWorker`) and the `createEngineWorker` override, the adoption declaration
(default off) + manual trigger, `destroy()` on the attached facade, `EngineRelocatedError` with
outcome semantics, and the opt-in execution-limit configuration (disabled by default).

Non-goals (rejected or deferred, per the ADR): Firefox nested-worker placement; SAB-bridged VFS;
extension-host topologies; local idb→opfs store migration; durability default changes; per-tab
heartbeat protocols; timing-based dead-worker inference; mutation-dedup/replay frameworks;
cross-backend preservation during destroy; generalized meta transactions; any
BroadcastChannel-based coordination. No change of any kind to `@pgxsinkit/pglite-opfs-repacked`
(VFS signoff stands).

## Accepted-risk register (normative — do not relitigate)

1. **Double loss** — meta record independently wiped AND OPFS simultaneously unobservable over a
   committed store: outside the browser termination model. A later sentinel/record conflict
   surfaces as a hard error; no recovery machinery is designed for it.
2. **SW-direct silent infinite hang** (WebKit): unrecoverable by construction — a SharedWorker
   cannot be terminated from a page and a hung in-scope engine blocks the router's own event loop.
   Reported errors and browser/OS process management cover the rest.
3. **Module-worker assumption for auto-derived engine entries.** The elected engine worker is
   auto-derived as `new Worker(reportedUrl, { type: "module" })` — the only shape the published ESM
   entry supports. Entries that cannot be reconstructed from their URL as a module worker
   (classic-script workers, `blob:`/`data:` URLs, CSP constraints) require the `createEngineWorker`
   override; with no override and no derivable URL, attach fails with a typed error (never a silent
   no-engine attach). This assumption is settled.
4. **Leader keepalive false-positive** (SW alive but starved): benign by construction —
   reconstructing a same-URL+name SharedWorker connects to the live existing instance; the
   "recovery" is a reconnect, not a duplicate.
5. **Same-origin interference** (Web Locks `steal`, devtools OPFS/IDB tampering, malformed
   external layouts): trusted-origin model; fail-closed where observable, out of scope otherwise.
6. **BFCache `pagehide` not firing** (crashed/killed tab): covered structurally by lock release on
   agent death; no lease system.
7. **Meta-store fault coverage** is the total phase machine + representative tests + fail-closed
   unreadable authority — no Cartesian per-field fault matrix.

## Required invariants

1. **Single engine per store.** Leader lock elects at the client layer; the VFS ownership lock
   rejects a second opener. A double-grant anomaly surfaces as a deterministic boot failure.
2. **One lock request per tab; claims own the lifecycle.** Provision and attach share the tab's
   coordinator; attach adopts an existing grant/engine; last-claim release retires the engine
   (notice → teardown → lock settle); BFCache entry releases authority (D2).
3. **No stranded writes.** An uncommitted candidate is NEVER exposed to writes (commitment
   precedes exposure, D7); commitment forbids fallback once published; the adoption transition is
   pre-expose.
4. **No silent local-only data loss.** Automatic adoption ONLY under the explicit declaration
   (default off); restored stores are authoritative and never await a server (D7).
5. **Outcome-honest relocation.** A dispatched mutation with a lost response fails
   `outcome: "unknown"` and is never auto-retried; only never-dispatched work is `not-dispatched`
   (D5, D10). Old-pipe pendings are settled with this classification on pipe replacement, never
   replayed.
6. **Tab identity is structural.** One proxy pipe per tab end-to-end; no cross-tab stream exists;
   the SharedWorker is not in the data path and never inspects payloads (D4).
7. **Engine identity is the pair.** `(SharedWorker instance id, generation counter)`; staleness
   checks compare the pair (D4).
8. **Probe per boot.** The placement probe result is never cached across SW lifetimes.
9. **Queueing is bounded.** The attach-side handoff queue has a cap + deadline; overflow fails
   with `outcome: "not-dispatched"` (still safe to retry).
10. **One identity encoding over a defined domain.** Injective percent-encoding; lone-surrogate
    rejection; per-component encoded-length cap; `.` and `..` rejected at the boundary (D11).
11. **Namespaces are disjoint.** `pgxsinkit/stores/`, `pgxsinkit/commitments/`,
    `pgxsinkit/probe/` — two valid identities can never contend for one OPFS entry (D6).
12. **The meta record is a total phase machine and first-use authority.** One phase
    (`idb-authoritative | opfs-candidate | adopting | opfs-committed | deleting`), `deleting`
    highest precedence, written at the first grant-scoped capability boot and completed before
    exposure. Registry-forced idbfs boots and capability-fallback boots remain deliberately
    record-free and classify through the recordless-idb arm; a denied boot writes `idb-authoritative`
    only when handing authority out of an existing `deleting` phase. A failed meta read is an ERROR
    (bounded retry → fail closed), never "no record" (D6).
13. **Destruction is resumable and supervised.** A boot that finds `deleting` completes the
    deletion first; `destroy()` resolves from a supervisor that survives engine shutdown (D8).
14. **Recordless idb stores are recognized.** No record + existing idb store (non-creating existence
    check) → `idb-authoritative`, never virgin — an existing idb store's data is never overwritten by
    a fresh opfs mint; it is opened in place, and adoption (when declared) migrates it forward to opfs.
    This arm is the entry point of the forward idbfs→opfs transition (D6).

### Recovery calibration

- **Potentially journal-bearing authority:** `idb-authoritative`, `opfs-committed`, and a
  sentinel-present OPFS store with no record. Never bin these silently; require an explicit/forced
  destructive decision or prove no mutations are owed.
- **Reconstructible cache state:** unactivated candidates, an adoption candidate whose IDB
  predecessor remains authoritative, and sentinel-less residue after authorized destruction.
  Delete-and-resynchronize is sufficient; do not add precise restoration machinery.
- **Explicitly destructible:** `deleting`. Disposal is already authorized. Recovery must prevent
  that authority reaching forward onto a replacement store, but need not preserve the old cache.

## Architecture

**Router (SharedWorker, always).** Owns: the attach registry, the current engine identity +
control channel, and relocation-notice fan-out. Per attached tab it mints a proxy `MessageChannel`
and transfers one end to the engine (`connect-port`); thereafter that tab's traffic flows
tab↔engine DIRECTLY on the pipe. The router relays relocation notices (`leader-granted`,
`engine-retiring`, engine-loss verdicts) to every tab, forwards tab-reported overdue dispatches
into control-channel probes (execution limit, when enabled), answers tab keepalive pings, never
spawns workers, never decides leadership, and never sees RPC payloads.

**Attach client (owns the handoff window).** On a relocation notice: queue NEW calls locally
(bounded, invariant 9), classify and settle pendings per invariant 5, re-attach, obtain the fresh
pipe, flush the queue, re-establish live queries (ADR-0041 staged readiness). Seams: the SharedWorker FACTORY
(`worker: () => SharedWorker`) that makes SharedWorker-death recovery a guarantee; the elected
engine worker auto-derived from the SharedWorker's self-reported script URL
(`new Worker(reportedUrl, { type: "module" })`), with `createEngineWorker` as an override for
non-module/underivable entries; the bridge-silence deadline (non-leader reconnection); identity
handling in acks; `destroy()` routed to the supervisor; `EngineRelocatedError` reconstruction
(`code` + `outcome`).

**Placement probe (SharedWorker startup).** Real `createSyncAccessHandle` open on scratch under
`pgxsinkit/probe/`, removed after. The probe is **unconditional** — it runs at every SharedWorker
boot under the default `storage.backend: "opfs"`. Granted → engine in-scope, election disabled this
SW lifetime. Denied → router-only mode; attach acks carry `electionRequired: true`. The one opt-out
is the storage contract: `storage.backend: "idbfs"` on the registry skips the probe entirely and
binds the in-SW engine host on idb (ADR-0032), answering the placement query
`electionRequired: false`. There is no consumer-facing placement mode — where the engine runs is the
toolkit's runtime decision, and the registry only ever declares the STORAGE backend.

**Election coordinator (tab side, one per tab per store).** Single owner of leader participation,
claim-counted (invariant 2): provision claim (expiry-bounded), one claim per attachment, failed
spawn releases its claim unless retried. Grant duties: `leader-granted` → spawn → `engine-announce`.
Holding duties: re-announce to every new SW instance; the leader keepalive (the one standing
timer) — missed-ack threshold → reconstruct the SW via the factory, re-attach, re-announce.
Engine-loss handling: worker `error`/spawn failure → immediate; execution-limit verdict →
`engine-retiring` notice, then deliberate `terminate()` (idempotent), await VFS ownership release,
respawn. Last-claim release and BFCache (`pagehide.persisted` → release authority + retire;
`pageshow` → re-queue + re-attach): retirement notice first, then `engine-teardown` → ack/timeout →
settle the lock callback.

**Engine (core unchanged, entry extended).** The dedicated-worker entry gains the control-plane
listener: dynamic `connect-port` acceptance into `SyncWorkerHost.connect`, probe replies,
retirement/teardown handling — all identity-tagged.

## Protocol changes (bridge + control plane)

- **Attach ack**: `engineHome`, `electionRequired`, SW instance id + engine identity.
- **Control plane (identity-tagged)**: `leader-granted`, `engine-announce`, `engine-ready`,
  `connect-port`, liveness `ping`/`ack`, overdue-dispatch reports, `engine-retiring`,
  `engine-teardown`. Stale identities discarded.
- **Execution limit (opt-in)**: ONE engine-construction value, disabled by default (no finite
  worst-case query duration exists, and the limit CONVERTS slow to terminated by policy, so
  enabling it must be a deliberate consumer choice); differing values across tabs are rejected at
  attach. Breach
  flow: tab reports overdue dispatch → router probes the engine control channel → missed-ping
  threshold → verdict to the leader → retirement + termination. Elected placement only (ADR D5);
  on SW-direct the option is rejected as unsupported.
- **Error contract**: clone-safe `{ code: "engine-relocated", outcome: "not-dispatched" | "unknown" }`;
  attach side reconstructs the exported `EngineRelocatedError`. Consumer-visible branch tested for
  queued expiry (`not-dispatched`), dispatched read (safe repeat), and dispatched mutation
  (`unknown`, never auto-retried) — after real relocation AND after SW replacement.
- **Provision**: unchanged wire shape; routed through the election coordinator. It performs a
  bounded meta read before minting on every placement and declines while phase is `deleting`;
  attach then runs the ordinary resumable boot path. A rejected precreate also re-enters that full
  path rather than jumping directly to its mint.
- **Diagnostics**: additive `storageBackend`, engine home, fallback reason. `storeKind` untouched.

## Store-path, namespaces, meta record, and fallback engine

- `store-path.ts`: `opfs://<storePath>` scheme; browser resolution: handles available in the
  executing scope → `opfs://`, else `idb://`. `storeIdentityComponent` domain guards
  (invariant 10, incl. `.`/`..`). Namespace builders for `pgxsinkit/stores|commitments|probe`.
  `file://` raw paths; `idb://` PGlite naming — unchanged.
- **Store meta record**: dedicated small IndexedDB database; one record per store:
  `{ phase, updatedAt }` with phase-specific fields; written at CREATION (before exposure) for
  every backend; destruction deletes the record. Failed reads: bounded retry → fail closed
  (invariant 12).
- **Boot classification** (pure decision module, unit-tested):
  1. `deleting` → resume the destructive lifecycle (highest precedence).
  2. `adopting` → adoption crash recovery (its table below).
  3. `opfs-committed` → open with bounded retries; any final failure HARD (including unreachable
     root).
  4. `opfs-candidate` → delete + rebuild fresh (an unexposed candidate has no authority).
  5. `idb-authoritative` → idb boot; adoption gate re-evaluated when declared.
  6. No record, OPFS observable: sentinel present → committed (repair record → 3); candidate
     directory without sentinel → delete + rebuild; nothing present → **recordless-idb check** (7).
  7. **Recordless-idb check** (also when OPFS is NOT observable): non-creating idb existence check
     (`indexedDB.open` aborted on `upgradeneeded`; never `databases()`) — existing idb store →
     write record `idb-authoritative`; nothing → virgin: create per placement (record first; when
     OPFS is unobservable the new store is idb — double loss is accepted risk).

## Provenance gates and the commitment barrier (D7)

| Provenance                     | Gate proving the data source                                                                                                             | Server required?                                    |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Fresh store                    | successful local initialization/recovery                                                                                                 | No — nothing is deleted; offline-first boot commits |
| Restored store (`restoreFrom`) | successful backup load + restore recovery                                                                                                | No — the backup is authoritative and boots offline  |
| idb adoption                   | authorized online reconstruction: initial catch-up of the eager Consistency groups complete (anonymous access qualifies where permitted) | Yes — the predecessor is deleted                    |

Shared barrier for all three: gate → explicit `strictSync()` returns with VFS health good →
sentinel → `opfs-committed` phase → expose / delete predecessor. Barrier failure publishes
nothing. An uncommitted candidate is never exposed to writes (invariant 3).

Fresh/restore crash rows:

| State at boot                                   | Verdict                                                                                                                                                                                                                                               |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No record, no directory, no sentinel            | virgin / recordless-idb check (classification 7)                                                                                                                                                                                                      |
| `opfs-candidate` (any directory/sentinel state) | teardown (incl. any stale sentinel) + rebuild — a PRESENT record's phase is the total authority; the barrier-gap crash (sentinel published, phase not yet flipped) rebuilds: nothing was exposed, nothing strands; a restore re-invokes `restoreFrom` |
| Sentinel present, NO record (record loss)       | committed — repair record (sentinel authority applies only when the record is absent)                                                                                                                                                                 |
| `opfs-committed` + sentinel + directory         | normal committed boot                                                                                                                                                                                                                                 |
| `deleting` at any point                         | resume deletion                                                                                                                                                                                                                                       |

The `delete-candidate-and-rebuild` wiring (step 10) therefore ALWAYS deletes the commitment
sentinel alongside the candidate directory — a stale sentinel from a barrier-gap crash must never
survive into the rebuilt candidate's lifetime. (Adoption's barrier-gap crash differs by design:
its `adopting` phase routes to adoption recovery, where a present sentinel proves the
reconstructed store passed the barrier and completion is cheaper than re-bootstrapping — see the
adoption crash rows.)

## Adoption sequence (exclusive, quiescent — D7)

Eligibility: the explicit declaration, DEFAULT OFF; otherwise only the manual adoption API.

1. Boot the idb engine pre-expose; evaluate the drain predicate
   (`pending + sending + failed + quarantined + conflicted == 0`).
2. Not drained → expose on idb; deferred. Drained → strict-sync + close the never-exposed engine.
3. Phase → `adopting`.
4. Build the opfs candidate via server bootstrap; pass the adoption gate (eager Consistency
   groups caught up, authorized).
5. Barrier (strictSync → sentinel → `opfs-committed`), delete the idb store, done.

Adoption crash rows:

| Phase            | OPFS state                           | Verdict                                                           |
| ---------------- | ------------------------------------ | ----------------------------------------------------------------- |
| `adopting`       | absent or candidate dir, no sentinel | tear down candidate, re-run from step 1 (idb still authoritative) |
| `adopting`       | sentinel present                     | committed — set `opfs-committed`, delete idb, done                |
| `opfs-committed` | idb store lingers                    | complete the idb deletion                                         |

## Destructive lifecycle (D8)

Supervised by the coordinator/SharedWorker context that survives engine shutdown; the initiating
call resolves from the supervisor. Refuses owed mutations unless `force`; refuses while other tabs
hold claims (close peers first). Steps: stop admissions → quiesce/close engine → phase `deleting`
→ delete sentinel → delete store directory (or idb database) → delete the meta record. Resumable
at every boundary. On SW-direct placement, host close produces an identity-matched success/error
acknowledgement and then closes that SharedWorker scope; a later constructor/attach recreates the
host in a new SharedWorker lifetime. An acknowledgement timeout does not prove handle release, so
the bounded deletion may fail and deliberately leave `deleting` for the next boot:

| Crash after step     | Next boot reads                   | Action                          |
| -------------------- | --------------------------------- | ------------------------------- |
| phase `deleting` set | `deleting` + sentinel + directory | resume deletes                  |
| sentinel deleted     | `deleting` + directory            | resume deletes                  |
| directory deleted    | `deleting` only                   | delete record                   |
| record deleted       | clean                             | done — fresh creation permitted |

Corruption recovery = the lifecycle owner explicitly authorizes this machine after a fail-closed
error; never automatic.

## Fault matrix (normative)

| Fault                                                                    | Expected behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Leader tab dies mid-commit, STRICT, before strict-sync boundary returned | Longest-valid-prefix recovery                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Leader tab dies mid-commit, STRICT, after boundary returned              | Mutation durable; successor boots from journal; pendings classified per invariant 5                                                                                                                                                                                                                                                                                                                                                                                        |
| Leader tab dies mid-commit, RELAXED                                      | ADR-0048 crash model: longest valid stable prefix                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Dispatched mutation, response lost (any relocation)                      | `EngineRelocatedError` `outcome: "unknown"` — inspect/reconcile, never auto-retried                                                                                                                                                                                                                                                                                                                                                                                        |
| Dispatched read, response lost                                           | Safe repeat after relocation                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Queued call at relocation                                                | Held and flushed after re-attach; on cap/deadline overflow fails `not-dispatched`                                                                                                                                                                                                                                                                                                                                                                                          |
| SW dies after a call was forwarded; engine alive                         | Pipes are direct — in-flight traffic survives; on pipe replacement (re-announce) old-pipe pendings settle per invariant 5                                                                                                                                                                                                                                                                                                                                                  |
| Engine worker dies with uncaught error                                   | Coordinator: immediate teardown, respawn-or-requeue                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Engine hangs silently, execution limit ENABLED, elected placement        | Overdue report → probes → threshold → `engine-retiring` → deliberate terminate (idempotent) → ownership release → respawn                                                                                                                                                                                                                                                                                                                                                  |
| Engine hangs silently, limit disabled or SW-direct placement             | No automatic recovery (default contract / accepted risk 2); reported errors still covered                                                                                                                                                                                                                                                                                                                                                                                  |
| Long query under the limit (or limit disabled)                           | Runs to completion; probes are never a verdict below threshold                                                                                                                                                                                                                                                                                                                                                                                                             |
| SharedWorker dies; leader + engine alive                                 | Leader keepalive threshold → HOLDER reconstructs via factory, re-attaches, re-announces. Without factory: leader-op-or-reload (risk 3)                                                                                                                                                                                                                                                                                                                                     |
| Non-leader reconnects first after SW death                               | Re-attaches, waits; recovery arrives via the leader                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Provision then attach, same tab                                          | Coordinator: attach adopts the provision grant; never self-queued                                                                                                                                                                                                                                                                                                                                                                                                          |
| Abandoned warmed provision                                               | Claim expiry → retirement + lock release                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Leader `stop()` with other tabs attached                                 | Claim released; last-claim rule; retirement notice precedes teardown                                                                                                                                                                                                                                                                                                                                                                                                       |
| Failed spawn/provision                                                   | Claim released (unless retried); next tab elects                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Leader enters BFCache (`persisted: true`)                                | Release authority + retire engine; `pageshow` → re-queue + re-attach; a frozen page never pins the lock. MANUAL VERIFICATION (2026-07-22): BFCache is unreachable under Playwright on all three engines — the automation/CDP attachment disables it (verified: `pageshow.persisted` never true, even force-enabled) — so the release/reclaim hooks are unit-proven (`election-coordinator.test.ts`) and the real-browser round-trip is a device-bench check, not a CI lane |
| Leader detach/navigation (non-persisted)                                 | Lock released on agent teardown; queued non-leaders cancel via `AbortSignal`                                                                                                                                                                                                                                                                                                                                                                                               |
| Two tabs issue identical correlation ids                                 | Structurally impossible (per-tab pipes); asserted anyway                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Live subscriptions / token / status across relocation                    | Re-established via re-attach flow; token pushed; status resumes under new identity                                                                                                                                                                                                                                                                                                                                                                                         |
| VFS ownership-lock release lag during succession                         | Successor open retries on contention until clear; bounded, then boot failure                                                                                                                                                                                                                                                                                                                                                                                               |
| Double grant (lock anomaly)                                              | Second engine's VFS ownership acquisition fails → deterministic boot failure                                                                                                                                                                                                                                                                                                                                                                                               |
| Mutation at the adoption clean-check boundary                            | Impossible (pre-expose); asserted by test                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Offline first boot, fresh store                                          | Commits on local init (no server gate); writes journal safely — never a deletable candidate holding writes                                                                                                                                                                                                                                                                                                                                                                 |
| `restoreFrom` offline                                                    | Commits on restore recovery; never awaits server; never scheduled for deletion                                                                                                                                                                                                                                                                                                                                                                                             |
| Adoption gate unmet (offline / unauthorized / syncEnabled: false)        | Nothing publishes; idb stays authoritative                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Adoption without the declaration                                         | Automatic adoption refuses; manual API only                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Recordless idb store, no meta record                                     | Non-creating existence check → `idb-authoritative`; never virgin-matched                                                                                                                                                                                                                                                                                                                                                                                                   |
| Crash at each fresh/restore, adoption, destruction boundary              | Per the three crash tables — every row exercised                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `destroy()` with peers attached                                          | Refused with a typed error (close peers first)                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `destroy()` mid-flight crash                                             | `deleting` resumes next boot                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Provision while phase is `deleting` (granted or denied placement)        | Decline the pre-mint; first attach runs the ordinary phase machine before any replacement can hold journal writes                                                                                                                                                                                                                                                                                                                                                          |
| Handle-denied boot finds `deleting`                                      | Delete old IDB honestly → remove OPFS sentinel through async OPFS → write `idb-authoritative` → expose replacement IDB. Sentinel-less directory residue is disposable and removed before candidate reuse; if sentinel removal is unconfirmable, remain `deleting` and fail closed                                                                                                                                                                                          |
| IDB deletion reports `onblocked`                                         | Keep waiting; only `onsuccess` is completion. Bounded timeout rejects and leaves `deleting` for the next boot                                                                                                                                                                                                                                                                                                                                                              |
| Meta read fails                                                          | Bounded retry → fail closed; never treated as "no record"                                                                                                                                                                                                                                                                                                                                                                                                                  |
| storePath `"."` / `".."` / lone surrogate / over-cap                     | `InvalidStorePathError` at the boundary                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `foo` vs `foo.committed`                                                 | Disjoint namespaces — no contention (asserted)                                                                                                                                                                                                                                                                                                                                                                                                                             |
| opfs uncreatable, virgin                                                 | idbfs fallback after bounded retries: candidate torn down, record written `idb-authoritative` (first-use authority — identical to the no-handle virgin path), verbatim reason in diagnostics. Re-entry to opfs is the DESIGNED non-destructive path: a declared consumer re-adopts on a later drained boot — not a per-boot re-probe (implementation decision 2026-07-21, superseding the earlier "non-sticky retry next boot" wording)                                    |
| opfs failure, committed store                                            | Hard boot failure                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Commitment namespace uninspectable, record committed                     | HARD failure                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Commitment namespace uninspectable, no record                            | Recordless-idb check → idb-authoritative or new recorded idb store (risk 1 residual)                                                                                                                                                                                                                                                                                                                                                                                       |

## Test plan

- **Unit (bun, no real workers).** Coordinator claims lifecycle (provision expiry, last-claim
  retirement ordering, BFCache release/reclaim); router + attach client over `MessageChannel`
  through `SyncWorkerHost.connect` (grant/succession, identity staleness, pipe isolation,
  attach-side queue open/flush/overflow, outcome classification incl. old-pipe settlement,
  execution-limit verdict flow + option mismatch rejection, keepalive reconstruction,
  re-announce); store-path (`opfs://`, `storeIdentityComponent` domain incl. `.`/`..`, namespace
  disjointness incl. `foo` vs `foo.committed`); meta phase machine (classification 1–7, precedence,
  failed-read fail-closed, recordless-idb existence check); fresh/restore, adoption, and destruction
  state machines over their crash tables; `EngineRelocatedError` code+outcome round-trip.
- **Integration (Playwright, multi-tab).** Chromium + Firefox: leader kill → succession + queue
  flush + journal survival (strict pre/post-boundary + relaxed split); dispatched-mutation and
  dispatched-read classification after relocation; SW kill → keepalive recovery (with factory) and
  leader-op recovery (without) + old-pipe settlement; silent engine kill with limit enabled →
  termination + respawn; provision-then-attach; destroy() through the attached facade (peer
  refusal + success); offline-first-boot fresh commit; recordless-idb store recognition. NOT a CI lane
  (2026-07-22): BFCache navigation of the leader — unreachable under Playwright automation on all
  three engines (see the fault-matrix row); hooks unit-proven, real-browser round-trip on the
  device bench. Playwright's WebKitGTK lane takes the elected fallback because its SharedWorker
  denies sync-handle access; real-Safari SW-direct placement remains device-bench evidence. The
  SW-direct execution-limit rejection is unit-proven (the WebKit browser lane does not configure a
  limit). `test:integration:placement` runs the server-backed family on Chromium and is
  part of `test:integration`; `test:browser:placement:server` remains the separate all-project gate.
- **Bench (evidence, real devices).** `/bench/` columns + phase-0 proof as drift monitors;
  `provision-cold-boot.bench.ts` compares plain attach with provision-ahead-of-attach on Chromium
  and remains manual (outside every aggregate). First local headless-Chromium run (2026-07-22,
  five paired samples): plain attach→first-query median 3848.6 ms, provisioned 173.0 ms,
  foreground delta −3675.7 ms; provision work itself ran 3.5–5.3 s ahead of attach.

## Detailed implementation sequence (TDD-ordered)

1. `store-path.ts`: `opfs://` scheme, resolution rules, `storeIdentityComponent` domain guards
   (lone surrogates, length cap, `.`/`..`), namespace builders (unit tests first).
2. Store meta record module: phase machine, creation-time write, failed-read policy, non-creating
   idb existence check, boot classification 1–7 (pure, unit).
3. Fresh/restore, adoption, and destruction state machines as pure modules over their crash
   tables; provenance gates + the strictSync barrier sequence (unit).
4. Placement probe module (`pgxsinkit/probe/`; injectable FS surface).
5. Control-plane protocol types: identity tags, staleness, retirement, overdue-dispatch reports,
   execution-limit option (default off, mismatch rejection), `EngineRelocatedError`
   (code + outcome) (pure, unit).
6. Router: attach registry, pipe minting/transfer, relocation-notice fan-out, probe forwarding
   (unit over MessageChannel).
7. Attach client: handoff queue (cap/deadline), pending-op classification + old-pipe settlement,
   worker factory seam, bridge-silence deadline, identity handling, reconnect (unit).
8. Election coordinator: claims, lock lifecycle, spawn-on-grant, announce/re-announce, keepalive,
   engine-loss + deliberate-termination handling, BFCache hooks (unit with mocked locks;
   integration for real `navigator.locks`).
9. Engine entry control plane: dynamic `connect-port`, probe replies, retirement/teardown.
10. Wire `@pgxsinkit/pglite-opfs-repacked` into `createClientPGlite` for `opfs://`; boot
    classification + destructive lifecycle wiring; fresh/restore commitment barrier; `destroy()`
    supervision (attached facade).
11. Adoption: declaration option (default off), transition, manual adoption API.
12. Playwright multi-tab lanes; WebKit placement lane; provision cold-boot bench.
13. Diagnostics stamps + docs: consumer runbook, **`docs/testing-strategy.md` refresh** (required
    before ADR-0049 is declared complete), CONTEXT entries kept in lockstep.
14. **`extendedLifetime: true` on every SharedWorker construction site** (demo app, worker-factory
    docs, consumer runbook — decided 2026-07-21). Chromium keeps the SW alive for a grace period
    after its last client goes, letting a pending relaxed idbfs detached flush LAND when the last
    tab closes right after a write — a direct narrowing of the relaxed loss window wherever the
    engine lives in the SW (the registry-forced-idbfs in-SW engine, the 0049 idb-fallback path, and
    WebKit SW-direct if WebKit ships the option), plus a free warm-start for a tab opened within the
    grace window (same SW instance — the good case for engine identity). No effect on the 0049
    Chromium opfs path (the elected engine dies with its tab regardless — the strict barrier and
    ADR-0048 crash model protect that path). Unknown dictionary members are ignored by
    non-implementing engines, so the option is unconditionally safe; verify the shipped Chrome
    version floor when writing the docs line (no feature-check in code — ignore-safe).

## Definition of done

- All fault-matrix rows have a test or an explicit manual-verification note; all three crash
  tables fully exercised.
- Chromium, Firefox: opfs-repacked primary via elected worker; WebKit: via SW-direct — verified in
  integration lanes and real-device bench envelopes.
- Offline-first-boot fresh stores and restored stores commit without server contact; adoption
  never strands a write, never deletes undeclared local-only data, and never publishes without the
  authorized reconstruction gate + strict barrier.
- A dispatched-mutation relocation demonstrably surfaces `outcome: "unknown"` (never auto-retry);
  recordless idb stores demonstrably classify `idb-authoritative`.
- Destroy/recreate works end-to-end on a committed store; the SW-death lane recovers via the
  leader keepalive with a factory, and via leader-op without.
- ADR-0032/0048 amendment notes merged; decisions index regenerated; `docs/testing-strategy.md`
  updated; consumer runbook updated with `storageBackend` diagnostics and the adoption
  declaration.
