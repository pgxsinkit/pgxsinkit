---
name: operating
description: >-
  Load when deploying or operating a pgxsinkit app, when a sync/write "feels slow" in a browser
  but the server is fast, or when wiring backups/export/restore. Covers the runtime/deployment
  properties (not toolkit bugs) deciding whether an app feels fast: convergence cadence (writes
  flush on enqueue; the interval is a fallback), serverless edge cold starts, the read path's cache
  split (no-store control plane, cacheable edge on its own origin, token out of the cache key), the
  browser HTTP/2 connection budget, the edge worker timeout vs the durable-streams long-poll hold,
  globalThis.__pgxsinkitDebug + the BootReport, worker mode (defineSyncWorker/attachSyncClient —
  capability-driven engine placement, relocation outcomes, the forwarded rail), the store lifecycle
  surface (storePath naming, durability, backend permanence, destruction, the three exports,
  restoreFrom), and Event-lane observability: onOutboxStatus, onEventLaneReport verdicts including
  deferred-on-skew, and the Outbox across destroy/restore/backup.
metadata:
  type: task
  library: "@pgxsinkit/client"
  library_version: "0.2.8"
  source: https://pgxsinkit.github.io/start/operating-in-production/
---

# Operating a pgxsinkit app in production

The read/write/converge primitives are fast. When a live app feels slow it is almost always one of the
properties below — none are toolkit bugs; they are how serverless edges, browser HTTP and CDN-shaped caching
behave. If writes or sync feel slow in a real browser but server benchmarks are fast, start here.

## Convergence cadence: event-driven, interval is a fallback

With an `autoSync` trigger, the client drives `flush → reconcile` **event-driven**: it calls `requestPass()`
the moment a mutation is enqueued, so a local write flushes immediately and does **not** wait for the
interval (`createBrowserConvergenceTrigger({ intervalMs })`, default 1.5s; in worker mode
`defineSyncWorker`'s `convergenceIntervalMs`, default 15s), which is only a fallback for
retries/recovery/cross-tab.

Therefore **keep the interval long.** A short interval is the dominant idle cost: every PGlite query is
~50ms of WASM work on one thread, and an unconditional reconcile each tick re-runs every live query. The
demo uses `intervalMs: 15_000`, cutting idle CPU from ~70% of a core to ~2% with **no change to convergence
latency** (latency is bounded by the read-path echo). Do **not** shorten it to "make writes faster".

## Serve the gateway over HTTP/2 (the connection budget)

`@durable-streams/client` holds **one live long-poll connection open per subscribed stream** (a subject in K
scopes of a shared shape holds K streams), and browsers cap **HTTP/1.1 at ~6 connections per origin** — so over
plain HTTP six streams' long-polls consume every slot and the same-origin **write** request is **Stalled in the
browser's connection queue** for a whole long-poll cycle before it is even dispatched. This presents as
multi-second writes invisible to `curl`/Node (no per-host cap); only a real browser shows it (DevTools → Network
→ a stuck `write` with a long **Stalled** time). Fix: serve the gateway over **HTTP/2** (or HTTP/3), which
multiplexes every request over one connection. Any production ingress already does; it only bites a local stack
on plain `http://` (browsers only negotiate HTTP/2 over TLS).

## Serverless edge cold starts

On a serverless edge a worker is suspended when idle and evicted after longer idle, so the **first write after a
quiet period** pays a cold start while steady-state writes are instant (measured: ~20ms warm, ~0.45s after ~15s
idle, ~5.8s on a cold module cache). That is the deployment target, not pgxsinkit — a long-lived Bun/Deno
process or a managed warm pool has none. Mitigate: keep the worker warm with a periodic cheap request (an empty
`{"mutations":[]}` POST, rejected at validation before any DB work), and set the worker wall-clock timeout
**above** the durable-streams long-poll hold so a live subscription is not recycled mid-cycle (the board gives
its read functions `EDGE_WORKER_TIMEOUT_MS: "600000"`, not the stock 60s).

Region-pin **only the DB-bound write function**, never the two read functions. Pinning it to the database's
region (Supabase `x-region`) keeps its chatty function→DB protocol on a ~1ms loop; the read halves are not
DB-bound at all — the control plane's upstream is the Circuits engine, the edge's is durable-streams — and the
edge wants to sit near the CALLER, so catch-up bytes take the short hop. `createSyncClient` splits this:
`requestHeaders` is the shared base (reads AND writes — e.g. a gateway `apikey`), `writeRequestHeaders` is
merged over it on the write path only. Put the region header in `writeRequestHeaders`, never in the shared
`requestHeaders`.

## Pre-warming PGlite's boot assets

A cold `PGlite.create` spends ~2.5s fetching + compiling the Postgres WASM (plus the initdb WASM and the
filesystem bundle) before it can open a store — otherwise paid **after** sign-in, on the path to first paint.
`createSyncClient` takes a `pgliteBootAssets` option: a promise of the already-fetched/compiled assets
(`{ pgliteWasmModule?, initdbWasmModule?, fsBundle? }`), awaited and passed straight into `PGlite.create` so
it skips its own lazy load. Start the fetch+compile on an **earlier screen** and hand the pending promise in
— the WASM cost then hides behind user think-time. It is best-effort: a rejected warm is caught to
`undefined` and PGlite loads its own assets. The `boot pglite assets warm` rail stamp times it. (Board demo:
`apps/board/src/board/pglite-warm.ts` shows the Vite `?url` pattern PGlite's `exports` field otherwise blocks.)

**In worker mode the engine loads PGlite's OWN assets — deliberately; do not pre-supply them.** The tab's
warm still serves the engine by priming the same-origin HTTP cache the worker fetches from. Handing the
engine a pre-compiled `WebAssembly.Module` benched NET-NEGATIVE: it forces compile-to-completion before
instantiate (forfeiting PGlite's streaming-load pipelining), and the engine realm's only overlap window is
the placement/handshake gap, so the compile just competes for CPU at spawn.

Pre-warming only hides the WASM fetch+compile; `PGlite.create` still spends ~1.9s on `initdb` + store open,
which can't start until the store id is known (usually the signed-in user). To hide that too, create the
store EAGERLY under a generated id on the first screen and BIND it at auth. `createClientPGlite(storePath,
{ bootAssets })` runs the exact same create the client does internally and returns a schemaless instance;
hand the still-pending promise to `createSyncClient`'s `precreatedPglite`. Unlike `pgliteInstance` (caller
owns schema), `precreatedPglite` lets the client still run schema exec, prepare hooks, journal recovery and
store-version reconcile — so the eager create buys only `initdb`, and the role/registry-derived schema stays
post-auth. A rejected `precreatedPglite` falls back to the `storePath` create path, so it is a pure
accelerator, never a boot dependency. Bind eager stores to users with a small localStorage registry
(userId→storeId plus one unbound "spare"): create a spare on the login screen, claim it at sign-in, GC any
store that is neither mapped nor the spare. On a signed-in RELOAD there is no login screen to create ahead of,
so START the mapped-store open at app bootstrap (before React render), memoised per userId so the provider's
later open adopts it. (Board demo: `store-registry.ts`, `store-prewarm.ts`.)

## Worker mode: capability-placed off-thread engine (browser apps)

In a browser, prefer worker mode so PGlite, shape streams, journal machinery, and convergence leave the main
thread. The SharedWorker is always the communication centre. There is no placement option: where the engine
runs is a runtime capability decision. Under the default `storage.backend: "opfs"`, an unconditional real
synchronous-handle open at boot chooses the engine home — real macOS/iOS Safari runs the OPFS-repacked engine
directly in the SharedWorker, Chromium/Firefox elect one tab-spawned dedicated engine worker through Web
Locks, and Playwright WebKitGTK denies the handle in both worker kinds, exercising the capability fallback to
idb (declared durability kept, `storageBackend: "idbfs"` + `storageFallbackReason` on the BootReport). The
one opt-out is `storage.backend: "idbfs"` on the registry: no probe, no election, the engine boots in the
SharedWorker on idb. `createSyncClient` remains the bun/Node mode and the main-thread idb fallback where
SharedWorker is missing.

**A home with NO grant refuses a store already committed to OPFS.** A boot whose home holds no sync-access
grant (a tab realm, the in-process fallback) over a store whose meta record says `opfs-committed` fails
CLOSED with `CommittedStoreUnreachableError`, because `idb://<storePath>` would be an EMPTY sibling (app
looks wiped, offline writes fork into a store no worker-mode boot opens). No override flag; the message names
both exits — boot from a granted home, or destroy first with `destroyStoreArtifacts(storePath)`, the
path-addressed destroy (a failed boot leaves you no client to call `destroy()` on) that deletes both backends
plus the sentinel and the meta record and needs no grant, quiescing any live worker for the path first
(`quiesceStoreWorker`). The error is `instanceof`-branchable on the tab side too (it crosses the bridge as
its class) and carries the refused `storePath`; a no-grant `provision` declines that store for the same
reason rather than pre-minting the sibling.

**Two-file pattern.** One worker entry, bundled for both SharedWorker and dedicated Worker, calls
`defineSyncWorker({ registry, controlPlaneUrl, streamBaseUrl, batchWriteUrl, … })` at module top level (read
URLs both-or-neither, as on `createSyncClient`) — no placement or durability option (both are
runtime/registry concerns); the registry is CODE, _imported_ by the worker file, never cloned/serialized
in. Give each store a stable SharedWorker name and always pass
`extendedLifetime: true` (Chromium 148+ grace period; ignore-safe elsewhere). The tab calls
`attachSyncClient({ worker, registry, getToken })`. Prefer the **factory** form (`worker: () => SharedWorker`)
over a bare instance or a raw `port` — a SharedWorker cannot be reconstructed from itself, so **in elected
placement** (Chromium/Firefox) the factory is what arms SharedWorker(router)-death recovery via the election
coordinator's keepalive. A `port`/instance input stays fully functional (provision, attach, and the
`storePath`-keyed handoff all work) but **forfeits that reconstruction** — the coordinator detects the death
and can only stop. In SW-direct placement (Safari/idbfs) the engine lives in the SharedWorker and there is no
keepalive; neither form auto-recovers a dead SharedWorker (opt into `bridgeSilenceMs` + a factory for a
bridge-silence reconnect there). The elected engine worker needs no consumer wiring: the SharedWorker reports
its own script URL and the winning tab constructs `new Worker(reportedUrl, { type: "module" })`. Supply
`createEngineWorker` ONLY for entries that cannot be reconstructed from their URL as a module worker
(classic-script workers, `blob:`/`data:` URLs, CSP); with no override and no derivable URL, attach fails with
a typed error — never a silent no-engine attach.

The attached facade returns the same client shape as `createSyncClient` (write API, one-shot Drizzle reads,
live rows, `ready`/`status`/`stop`) plus `notifyAuthChanged` and `setOnline`, proxied to the shared engine.
One-shot reads (`query`/`queryRow`/`queryRaw`/`queryRawRow`) compile on the tab and cross the bridge as ONE
guarded round trip — the worker runs the read gate + lazy-group guard, then Drizzle's own mapping runs back
on the tab, so results match the in-process client exactly. A bare awaited `client.drizzle` builder is ALSO
guarded here, and `client.drizzle.transaction()` throws (no tab-local store). `ensureSynced` is proxied
(additive, idempotent); `isSynced` throws — it is a SYNCHRONOUS activation-started peek the tab's cached
catch-up readiness cannot answer (use `groupReady` for catch-up, `ensureSynced` to activate). Local `pglite`
and `dropReadCache` are NOT proxied (no tab-local store; a cache rebuild is engine-wide). `destroy()` IS
proxied through a tab-side supervisor: it refuses peers with `StoreDestroyRefusedError`, refuses owed journal
rows unless `{ force: true }`, retires/closes the engine, then runs a resumable deletion. The lazy lifecycle
methods ARE proxied, but the engine is SHARED: `desync(tableKey)` from one tab reverts the consistency group
for EVERY attached tab (the footgun). For an ephemeral delivery window use `discardEphemeral(tableKey)`
instead — the scoped, multi-tab-safe finalize (drops the ephemeral rows, reverts to dormant, refuses a group
with any persistent member), safe under a shared engine because an ephemeral window is per-delivery-session
and single-consumer. The exception is the INSPECTION surface `rawQuery(sql, params)` / `rawExec(sql)` (debug
pages, REPLs, ad-hoc counts): identical on both clients (executed in the worker on the attach client), it
runs raw against the local store — bypassing the journal/overlay, any write staying local and never
converging — so it is not an app-data read path. `replAdapter(client)` shapes it into the `{ query, exec }`
duck `@electric-sql/pglite-repl` needs. A worker file can bake multiple role variants and pick per attach via
`resolveRegistry(role)` + the tab's `role`, and can pass the schema prepare hooks
`prepareLocalDbBeforeSchema` / `prepareLocalDbAfterSchema` (app migrations, indexes, views) — worker-entry,
not attach, options, because a hook is a function and cannot cross the bridge.

**Identity switches do not wait for worker retirement.** Scope each worker identity by `storePath` with a
distinct, stable SharedWorker name; multiple stores may remain alive concurrently. Detach/stop the old client
and immediately attach the new identity's worker/store — never wait for the old SharedWorker, elected engine,
provision expiry, or `extendedLifetime` grace. In worker mode `stop()` detaches only this tab; in-process it
disposes live queries before closing that client's engine and store.

**Auth stays tab-owned (ADR-0013).** The tab pushes `{accessToken, expiresAt}` at attach and on
`notifyAuthChanged`; the worker uses the cached token and pull-requests one only when a request finds it near
expiry (any tab answers via `getToken`, first wins). The worker NEVER refreshes — exactly one refresher, so
GoTrue refresh-token reuse detection can't be tripped by a second client.

**Boot: spare-as-worker.** The spare store (see above) becomes a pre-spawned schemaless worker at the login
screen (create + initdb off every thread that matters); the userId→storeId registry stays tab-side in
localStorage so binding resolves before attach (SharedWorker naming needs it). Call `provisionSyncWorker` with
the same `worker` input as attach (the factory form, so elected-mode recovery is armed for provisioning too); an
elected pre-open shares the tab's one election coordinator and derives the engine from the SharedWorker's own
script URL. `provisionExpiryMs` (default 60000) is ONE deadline: it retires the abandoned elected claim AND
settles the returned promise with the typed `ProvisionExpiredError` in both modes, so a provision behind a dead
SharedWorker connection fails loudly rather than hanging. It bounds YOUR promise; the worker-side create attempt
follows the placement. SW-direct: the attempt is left running — a later attach adopts it if it completed and
waits on it if it is stuck, and a retried provision re-acks the same attempt rather than opening a second.
Elected: the deadline also releases the provision claim, and a LAST-claim release retires and terminates the
engine with that attempt inside it, so the next attach elects a fresh one (an attach that adopted the
coordinator earlier keeps its claim, and that engine). Fire-and-forget callers should `.catch()` it like any
un-awaited promise. Claim = bind id, attach, push config + token. On a PROVABLY-fresh claimed store pass
`attachSyncClient({ freshStore: true })` (never for a mapped/returning store): it asserts freshness, so streams
start from the beginning and the subscription-state read is skipped — a wrong `true` on a warm store
re-snapshots instead of resuming. It buys no catch-up/schema OVERLAP (that needed a commit gate the native read
path has no equivalent of, so boot is strictly sequential); what the spare removes is the store create itself.
Board boot-rail stamps: `boot spare store ensured`, `boot mapped store prewarm`, `boot store claimed`.

**`ready` unchanged; per-group readiness exposed.** `client.ready` still gates on every eager group; for
progressive paint use `await client.groupReady(tableKey)` or read `status.groups`.

**Debug rail is forwarded and origin-tagged.** A SharedWorker's console is invisible to the page (only
`chrome://inspect`), so the worker forwards every rail line to each tab, stamped with the WORKER's monotonic
clock and re-printed as `[pgxsinkit·w <ms>ms] …`, gated by that tab's own `globalThis.__pgxsinkitDebug`. The
front half of boot runs on the FIRST attach before any tab is listening, so the worker buffers those
pre-attach lines in a bounded ring (last 500) and replays them `[replay]`-marked to the first attaching tab.
The worker's NETWORK traffic is invisible the same way: the subscribe calls and the streams' long-polls never
appear in the page's Network panel — "the app is syncing but the Network tab shows nothing" is worker mode
working as designed. Inspect the worker itself (`chrome://inspect/#workers`) for the real requests and errors
(CORS rejections surface only there, a missing `Access-Control-Expose-Headers` on the edge included). Full
model: <https://pgxsinkit.github.io/concepts/worker-mode/>.

**Placement and relocation diagnostics.** Pull `client.bootReport()` and inspect `storageBackend`
(`opfs-repacked`/`idbfs`/`filesystem`/`memory`), `engineHome` (`shared-worker`/`elected-worker`/
`in-process`) and `storageFallbackReason`; never user-agent-sniff the backend. During elected-engine handoff
`EngineRelocatedError("not-dispatched")` is safe to retry, while `"unknown"` means a dispatched mutation may
already be journaled — inspect/reconcile, never retry blindly. The opt-in `executionLimit` is disabled by
default (no finite worst-case query duration exists, and the limit converts slow to terminated by policy);
it is elected-only and must match between the worker entry and every tab
(`ExecutionLimitMismatchError`), and SW-direct Safari rejects it as unsupported.

## Live-query manager: dedup + keep-alive (ADR-0040)

Every reactive read (`useLiveDrizzleRows`/`useLiveQueryRaw`/`subscribeLiveRows`) is a **local SQL live
query**: PGlite materialises it once, then re-runs + diffs it on every write to its tables. That registration
is a real cost (~a few hundred ms for a heavy aggregate) and is **automatically deduplicated** — identical
queries (keyed on executed SQL + bound params, NOT `use`) share ONE registration and ONE re-run + diff per
write, fanned to every subscriber, so N components (or N tabs on the shared worker) cost one materialisation.

Default lifetime is route-scoped: a live query is torn down the instant its last consumer unmounts, so a
navigate-away-and-back RE-materialises it. Opt a genuinely hot query into a grace period with a per-hook hint
`useLiveDrizzleRows(build, deps, { keepAliveMs: 30_000 })` (same field on the raw hook and
`subscribeLiveRows`), or a worker/client-wide policy `defineSyncWorker({ …, liveQueries: {
defaultKeepAliveMs, maxRetainedQueries, maxRetainedRows } })` (defaults `0` / `16` / `50_000`; the same block
exists on `createSyncClient`). The effective keep-alive is `max(default, subscribers' hints)`; the count/row
budgets outrank any hint and LRU-evict zero-subscriber entries; active entries are never evicted.

**Keep the default 0 unless you have a specific hot query.** A retained zero-subscriber query is NOT paused
(PGlite live queries can't be), so it still pays a full re-run + diff on every write to its tables while
held: retention wins only for a frequently-re-mounted, write-COLD query. For a fixed hot set the endorsed
"permanent" pattern is a **mounted subscriber** (a root-provider hook that never unmounts) — one live
registration for the app's life, every route dedups onto it; there is deliberately no retain-forever knob.

`client.liveQueryDiagnostics()` returns a per-entry snapshot — fingerprint DIGEST (never SQL/params/rows),
subscriber + row counts, timings, retention state — safe to log. The manager also emits
`live-query register|dedup-hit|retained|evicted|teardown-complete` rail lines (digests only).

## Store naming, backups, and restore (ADR-0035/0036)

**Stores are named by a plain `storePath`, never a storage URL.** The backend is derived, not named — a
capability-proven browser engine home uses OPFS-repacked; fixed worker mode, a denied engine home and the
main-thread fallback use IndexedDB; bun/Node uses the filesystem. Anything containing `://` throws
`InvalidStorePathError` — drop the scheme, don't re-add it. Memory-backed stores are deliberately unreachable
from the production API (durability semantics assume a persisted store): tests spread
`memoryStoreForTests("name")` from `@pgxsinkit/client/testing`, and a caller-owned
`pgliteInstance`/`precreatedPglite` that is provably non-persistent (`dataDir` undefined, or `memory://`) is
refused with `NonPersistentStoreError` unless `testStoreAcknowledgment()` is spread alongside. For browser
store GC, get the IndexedDB name from `storeIndexedDbDatabaseName(storePath)`, never assemble `/pglite/…`.

**Relaxed durability is the default**, declared once on the registry
(`SyncRegistryDefinition.storage.durability`) — never on a minting surface, worker entry or attach site,
because durability follows the data and one declaration binds every open of every store minted from that
registry. Its physical behavior is backend-specific: on idb, relaxed returns before the whole-datadir
snapshot flush and schedules it asynchronously while strict pays that synchronous snapshot (~100–200ms per
optimistic mutation); on OPFS-repacked the host still awaits every sync, with relaxed asserting VFS health
and running any due deferred repack without an ordinary physical flush while strict flushes arena data
before metadata (initialization, repack activation and open-state close use strict ordering either way).
The resolved value is stamped on the `boot pglite.create` rail line.

**The idb loss window.** On idb the store is an in-memory FS with debounced whole-snapshot writes, so
`relaxed`'s window is every write since the last COMPLETED snapshot. The risk lands only on a crash before
BOTH the journal rows reach the write API (~hundreds of ms after enqueue) AND the scheduled snapshot lands —
and synced tables are server-recoverable by construction, so only consumer **local-only** tables carry real
risk. `durability: "strict"` is the escape hatch if you keep unrecoverable local-only data; on idb it costs
~100–200ms/write. On OPFS-repacked, browser/worker termination recovers the longest valid stable
metadata-log prefix and an unflushed suffix may be absent; a returned strict boundary is stable under that
browser-failure model — do not generalize it to power loss, media failure, or external store edits.

**Three exports, named by purpose, all returning `{ file, report }`** (report = phase timings + a
`MutationDiagnostics` snapshot). They work identically on both client forms (the artefact crosses the bridge
as a transferred buffer):

- `exportStore()` — the **store backup**: a live, checkpointed `dumpDataDir` tarball of the WHOLE store,
  journal and overlay included. Never blocks, works offline with unflushed writes; restorable ONLY into
  PGlite via restore below. This is the backup/migration format.
- `exportDiagnostics()` — everything as SQL (synced + overlay + journal + views/functions + the `pgxsinkit`
  schema) for support evidence. Never blocks; not for restoring.
- `exportData({ drainJournal? })` — the **portable** SQL (synced tables + their enum types, nothing of
  pgxsinkit's machinery; loads into vanilla Postgres). The ONE blocking variant: it requires a fully drained
  journal (an `acked` write whose echo has not landed is NOT yet in the synced tables), so it flushes and
  awaits convergence up to `drainJournal.timeoutMs` (default 15s), failing fast with `DataExportDrainError`
  (which carries diagnostics) on `failed`/`quarantined`/`conflicted` rows. `drainJournal: false` exports
  as-is and flags it.

The pg_dump variants run against a **throwaway clone** booted from the backup — the live engine is never
suspended and tabs never pause. Exports, `destroy()`, `discardEphemeral()` and `dropReadCache()` serialise
through one lifecycle slot: a concurrent call rejects immediately with `LifecycleBusyError` (no queueing —
retry after the holder settles). Ephemeral (`pg_temp`) content is never in any artefact.

**Restore** = `createSyncClient({ restoreFrom: backupFile, … })` (or `attachSyncClient` — the tarball rides
the boot attach), ONLY into a store path that does not exist in EITHER idb or OPFS
(`RestoreTargetExistsError` otherwise; the overwrite path is a deliberate `destroy()` first). Recovered
journal rows are quarantined because the write path has no mutation dedupe; a dirty-journal restore stays
offline for inspection, a clean-journal one may honor the normal online options immediately. Inspect
`diagnostics()`, resolve quarantined rows via `discardQuarantined`, then reboot the persisted store normally
(<https://pgxsinkit.github.io/concepts/export-and-restore/>).

**Backend permanence.** A store's backend is FIXED at its first mint, for the store's whole life. An
existing idb store is opened IN PLACE by a newly capable OPFS home — nothing copied, nothing deleted
(`storageBackend: "idbfs"` + a `storageFallbackReason` on the report); a no-grant home refuses a committed
OPFS store instead (above). The ONE route to another backend is a deliberate destroy — `client.destroy()`,
or `destroyStoreArtifacts(storePath)` for a store nobody holds — then a fresh boot that re-syncs and mints
on the then-best backend. Budget a full cold bootstrap, and expect local-only state (anything written via
`rawExec`, un-flushed journal rows dropped by `force`) to be gone: the replacement is a NEW store, not a
converted one. There is no migration API and no in-place conversion. For a storage-PREFERENCE change, mint
under a FRESH path and destroy the obsolete one in the background — never delete-and-recreate a live path.

**Resetting and deleting stores (ADR-0050).** Four non-interchangeable levers, picked by what you keep and
whether the store is running:

- `client.dropReadCache()` — keep the store, drop synced rows, resync in place (overlay + journal survive).
- `client.destroy()` — delete a RUNNING store from an attached client: peer-count checked
  (`StoreDestroyRefusedError`), owed-journal checked (refused unless `force`), teardown-acked before deletion.
- `destroyStoreArtifacts(storePath)` — delete a NOT-running store by path: OPFS directory + commitment
  sentinel + meta record + idb database, backend-agnostic, bounded ownership-lag retry. Documented
  precondition, no liveness probe: on a still-held path it throws the ownership error — loud and safely
  re-runnable (a `deleting`-marked store is refused for boot). Keep failed paths on a retry list for the next
  boot. An idb-only sweep is NOT a substitute — it leaks the OPFS arena.
- `quiesceStoreWorker(worker, opts?)` — the by-path TEARDOWN companion that MAKES a store not-running before
  `destroyStoreArtifacts`. Give it a worker factory of the shape `attachSyncClient` takes
  (`() => new SharedWorker(url, { name: storePath })`) that constructs the worker with **byte-identical
  options to the LIVE store worker**, `extendedLifetime: true` included: a named SharedWorker dedups onto one
  instance, and Chromium (148+) FAILS a second `new SharedWorker(name, …)` whose options disagree (an `error`
  event, no `onconnect`), so the teardown port exchanges zero messages and only times out. Omitting
  `extendedLifetime` does not shorten the teardown worker's life (`closeHost` + `scope.close()` end it) — it
  only breaks the dedup and defeats the primitive. It reaches the worker by name, posts the declaration,
  queries placement, and for an SW-direct home sends `engine-teardown` and AWAITS the reserved ack (engine
  stopped, backend connection released → `{ toreDown: true }`); an elected home is a no-op
  (`{ toreDown: false }` — the elected engine dies with its tab). Compose best-effort:
  `await quiesceStoreWorker(f).catch(() => {}); await destroyStoreArtifacts(path)`. A timeout REJECTS (not
  proof of teardown, default 6s) and must not abort the destroy; omit `storage` so a worker on an older
  declaration is never refused; idempotent + safe on an already-dead store.

**Storage-preference changes.** A store's storage declaration is IMMUTABLE — bound at first contact,
conflicts refused typed (`StorageDeclarationRefusedError`). Never re-home or delete-and-recreate a live path
(an `extendedLifetime` predecessor may still hold it). The pattern: atomically drop bindings + record the old
exact paths on an obsolete list FIRST, then write the new preference and reload; fresh stores mint under
fresh paths, and each boot walks the obsolete list in the background (never awaited on sign-in), per path
QUIESCING the worker BEFORE `destroyStoreArtifacts`. The quiesce is what makes idbfs converge: an
`extendedLifetime` idbfs predecessor holds its IndexedDB connection across the reload, so a bare destroy
would block forever (opfs releases on idle; idbfs does not) — tearing the host down releases it so the first
retry wins. Dynamic declarations travel as the wire `storage` option on
`attachSyncClient`/`provisionSyncWorker`; a registry-attached static declaration stays authoritative.
Consumer docs: <https://pgxsinkit.github.io/concepts/local-store-lifecycle/>.

## Event lane: observing the Outbox (ADR-0053)

If your registry declares `streams`, `client.appendEvent(stream, payload)` stages a fire-and-forget fact in
the **Outbox** — a durable, local-only table, never synced, overlaid or conflict-resolved. It resolves on
**durable local enqueue, not on delivery**, so it never blocks on the network and an append made offline
survives a reload. Two observation surfaces, identical on both client forms:

- **`onOutboxStatus(cb)` — the drain signal.** `{ empty }`, fired on the empty ↔ non-empty **transitions**,
  current state delivered on subscribe (`await client.outboxStatus()` is the one-shot pull twin). It is the
  invalidation hook for a best-guess view composing pending events with down-synced aggregates: when the
  Outbox drains, the aggregate is authoritative again. It carries **no count** deliberately (one updated only
  on transitions is stale by construction) — query `getOutboxTable(registry)` when you need one.
- **`onEventLaneReport(cb)` — the verdicts.** Per flush pass: terminal non-`acked` verdicts, `deferred` ones,
  and batch-level backoff transitions. `acked` is never reported (a high-volume lane would drown you), and it
  is **EPHEMERAL** — with **nothing subscribed the library warn-logs each report**. Subscribe for the app's
  lifetime: once a row is deleted the Outbox cannot answer for it.

**Read the verdicts correctly — one of the four is not a failure.** `acked` is enqueued server-side. `refused`
(your `eventGate` said no) and `rejected` are **terminal**: the row is deleted, and `refused` is expected, not
an error. `rejected` has THREE causes on a KNOWN stream — a payload the schema refuses (or a parse output JSON
cannot carry), an oversized payload, and an **identity claim the stream declares that the verified claims
cannot resolve** (absent/null/object/array/empty — fail-closed, no partial stamp). The first two mean a
non-library caller or a broken deployment (the library validates at append) — a **bug**; the third means the
ISSUER stopped minting that claim, or moved its path. `deferred` is **NOT terminal**: the server does not
(yet) know that stream — rollout skew — so the rows stay, retry with backoff, and drain once the deploy lands.
A burst after a release is deploy order; one that never clears means the registry LACKS it.

**There is no attempt cap and no client-side quarantine, by design.** Retry has two classes: retryable
(network, 5xx, 408/425/429 — jittered backoff with a ceiling, honouring `Retry-After`, paused offline) and
auth (refresh once, then retryable). A row leaves the Outbox **only** on a server-issued per-event verdict,
so a stuck lane is a growing Outbox with backoff transitions on the report, never silent loss. A persistent
**503 / batch backoff** is the OTHER diagnosis — the server KNOWS the stream but could not enqueue the whole
batch: check the `--events` migration is applied (no queue, no enqueue), then DB reachability. Cadence/batch
caps are client config (`events`, validated at construction — a bad `batchSize` throws instead of wedging a
stream), clamped by the contracts limits; `flushEvents()` is the manual hatch without `autoSync`.

**The Outbox on every lifecycle surface** (durable owned state): `destroy()` **refuses** while it is
non-empty, exactly as on owed mutations — the refusal names which of the two blocked it, and `{ force: true }`
is the escape hatch. `dropReadCache()` never touches it (not read cache). `exportStore()` and
`exportDiagnostics()` include it; `exportData()` (synced tables only) excludes it. And **restore does NOT
quarantine restored Outbox rows** — the deliberate asymmetry with the mutation journal: they resume flushing
normally, because event delivery is idempotent end-to-end (`eventId` dedupe), which mutation replay is not.

## The read path's cache split: uncacheable control plane, cacheable edge

The two read halves have opposite caching postures. The **control plane** (`/sync/v1/subscribe`, `/refresh`,
`/barrier`) answers per-subject questions and mints stream tokens, so force `cache-control: no-store` on it. The
**edge** (`createStreamGate` at `/v1/stream`) is the only surface a CDN may share, and durable-streams already
labels its responses for one — a catch-up read returns `cache-control: public, max-age=60,
stale-while-revalidate=300` and an `etag`, exactly where the bytes are. Sharing is a **shared-tier** property
only: a `rowFilter` fuses the subject into the predicate, so those bytes are shareable with nobody.

**Put the edge on its own origin, and keep the stream token out of the cache key.** The cache key is the URL, so
a same-origin mount makes the cacheable and uncacheable surfaces share one key and forecloses ever fronting the
shared tier; the token rides in `Authorization` (never a query parameter) for the same reason, and the cache
must not vary on that header. Revocation latency then follows the deployment: behind a hit-serving CDN it is
bounded by the token TTL (5 minutes by default), behind a cache sitting _behind_ the edge's verifier it is
entitlement-propagation latency.

**Every `createStreamGate` mount must set `Access-Control-Expose-Headers` from the exported
`STREAM_READ_EXPOSED_HEADERS`.** CORS lets script read only a short safelist, and every header durable-streams
answers with is outside it, so a cross-origin browser gets a response whose stream headers are simply not there:
`@durable-streams/client` steers its read loop off them, never learns an offset, and re-requests from the
start in a hot loop, with no error raised on either side. It presents as "sync does nothing, and the console
is clean". Mount details: the `deploying` skill.

## Debugging latency: `globalThis.__pgxsinkitDebug`

`@pgxsinkit/client` ships opt-in, off-by-default, timestamped instrumentation that traces a write through
every phase. Enable it from the console or before boot:

```js
globalThis.__pgxsinkitDebug = true; // reproduce, then filter the console to "pgxsinkit" + enable Verbose
```

Read the **gaps** between phases: `mutation staged {mutationId, table}` (correlate by id with the later
sent/acked lines); `convergence pass requested (event-driven, …)` → `convergence flush` / `convergence
reconcile`; `flushBatch sending to board-write`; `board-write auth token resolved {ms}` (a stalling token
fetch); `board-write responded {status, ms}` (a cold worker or a connection stall); `board-write acks`; and
`live-query register|dedup-hit|retained|evicted|teardown-complete` (digests only). **The read path emits no rail
lines** — its cost is routing latency rather than phases, so read it off the `BootReport`'s per-group rows
(below) and off `status` / `status.lastError` (`degraded`/stream = subscribe failing or the stream silent;
`auth-needed` = the control plane refused this credential), and inspect the real requests in the worker's own
DevTools. Server-side, `createSyncServer({ logTimings: true })` emits matching `[pgxsinkit-timing]` lines (the
`deploying` skill); client-observed minus server `totalMs` isolates routing + network. Boot too: `boot
pglite.create` → `boot client ready` (store open, schema apply, journal recovery, store-version reconcile, sync
start) attributes a slow first paint to a phase; `boot pglite assets warm` times the optional pre-warm.

**Structured boot numbers — the `BootReport`.** The rail is for a human reading a console; for
machine-keepable numbers (dashboards, CI budget gates) every boot ALSO builds a versioned `BootReport`,
independently of the rail so it exists whether or not the flag is on (ADR-0034). Read it by push
(`onBootReport?: (report) => void`, fires once at boot completion) or pull (`await client.bootReport()` → the
most recent completed boot, `null` before the first sync; in worker mode it round-trips to the worker's
stored report, so a late tab reads a boot that predates it). It carries `totalMs`, decomposed `phases`, and a
per-group `groups[]`. Two reading caveats: groups catch up CONCURRENTLY on one WASM thread, so a group's
`fetchMs` is an UPPER BOUND on network wait and concurrent `applyMs` can overlap — never sum them into a
`totalMs` partition; and a non-null `provision` block is a spare's off-thread `initdb` made visible (then
`phases.pgliteCreateMs` is `null`).

**How a group decides to commit (ADR-0056), and the one state that is terminal.** There is **no commit floor**
and no cross-shape position comparison — offsets are per-stream and comparable only within one — so a group
commits when **every** one of its shapes' most recent responses asserted up-to-date. That is safe because
durable-streams answers each long-poll timeout with `204` plus the up-to-date header, so a quiet shape
re-asserts freshness every cycle instead of holding a busy sibling behind a stale watermark. The **first**
commit of each alignment generation (boot, and after any must-refetch) also reads the engine's convergence
barrier through the control plane's `/sync/v1/barrier`, aligning only with `pendingFlips` at zero — no computed
membership revocation still undelivered. A barrier the client cannot READ is a delay: the group stays on the
pre-alignment gate and retries. `flipFailures > 0` is **terminal**: the engine abandoned membership-flip
batches, those effects are lost, and the client refuses to align and goes `degraded` rather than waiting —
restart the engine and re-subscribe. Full prose: <https://pgxsinkit.github.io/start/operating-in-production/>.

**Measure at the network boundary, not by polling PGlite.** Each PGlite query is ~50ms on one thread, so
a tight `setInterval` reading PGlite to "watch" a value inflates the very latency it reports. Trust the
instrumentation's network timings and a server-side `curl` over a poll loop.

**Inspecting a stuck or failed write.** To see _why_ a write is not converging — journal status,
attempt/retry counts, last error, a table's pending/conflict/quarantine state — read the generated journal
and sync-state relations with the typed factories `getJournalTable(registry, tableKey)` /
`getSyncStateView(registry, tableKey)` (typed Drizzle, no hand-written SQL against `<t>_mutations`). One-shot
diagnostic reads only — don't poll them in a loop.

**Rolling back a terminal write.** Both terminal dispositions keep the optimistic overlay and have a
symmetric discard: a stale-write `conflicted` row (via `onConflict`) rolls back with
`client.discardConflict(table, entityKey)`, a structurally-rejected `quarantined` row (via `onQuarantine` —
a validation failure or a permanent policy denial such as an RLS `42501`) with
`client.discardQuarantined(table, entityKey)`. Each clears the entity's terminal journal rows + kept overlay,
so the read model falls back to the synced value and the entity accepts new mutations again (a lingering
terminal row otherwise blocks a re-create and chains a later update onto a dead head). Because quarantine has
a real rollback, route a permanent policy denial to `quarantined` — never mis-route it to `conflicted`.

## Common mistakes

- Shortening the convergence interval to chase write latency (no effect; wastes CPU).
- Serving many-stream sync over plain HTTP/1.1 and blaming the server for stalled writes.
- Mounting the stream edge on the control plane's origin (one cache key for both read surfaces), or
  omitting `Access-Control-Expose-Headers` on it — that one hot-loops the client, silently on both sides.
- Treating an edge cold start as a toolkit/sync-rail problem.
- Measuring latency by polling PGlite in a loop instead of at the network boundary.
- Treating `deferred` as a failure and "cleaning up" the Outbox — it is rollout skew, and those rows drain
  themselves once the server deploy lands.
- Subscribing to `onEventLaneReport` per-screen (verdicts are ephemeral), or expecting `acked` on it.
- Assuming `appendEvent` resolving means delivered — it means durably staged locally; delivery is the flush.

Full prose: <https://pgxsinkit.github.io/start/operating-in-production/>.
