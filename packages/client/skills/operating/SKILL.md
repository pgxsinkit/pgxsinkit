---
name: operating
description: >-
  Load when deploying or operating a live pgxsinkit app, when diagnosing a sync/write that "feels slow"
  in a browser even though the server is fast, or when wiring backups/export/restore. Covers the runtime
  and deployment properties (not toolkit bugs) that decide whether a live app feels fast: convergence
  cadence (writes flush on enqueue; the interval is only a fallback), serverless edge cold starts and
  warming, cache-control:no-store on a same-origin Electric shape proxy, the browser HTTP/2 connection
  budget, the edge worker timeout vs Electric's long-poll, globalThis.__pgxsinkitDebug + the BootReport,
  worker mode (defineSyncWorker/attachSyncClient — capability-driven Safari SharedWorker vs elected
  Chromium/Firefox engine placement, factories, relocation outcomes, diagnostics, and the forwarded rail),
  and the store lifecycle surface: storePath naming, backend-specific durability, adoption, supervised
  destruction, exportStore/exportDiagnostics/exportData (+ drain guard), and restoreFrom.
metadata:
  type: task
  library: "@pgxsinkit/client"
  library_version: "0.2.0"
  source: https://pgxsinkit.github.io/start/operating-in-production/
---

# Operating a pgxsinkit app in production

The read/write/converge primitives are fast. When a live app feels slow it is almost always one of the
properties below — none are toolkit bugs; they are how serverless edges, browser HTTP, and CDN-shaped
caching behave. If writes or sync feel slow in a real browser but server benchmarks are fast, start here.

## Convergence cadence: event-driven, interval is a fallback

When you pass an `autoSync` trigger to `createSyncClient`, the client drives `flush → reconcile`. The
pass is **event-driven**: the client calls `requestPass()` the moment a mutation is enqueued, so a local
write flushes to the server immediately — it does **not** wait for the interval. The interval
(`createBrowserConvergenceTrigger({ intervalMs })`, default 1.5s; in worker mode `defineSyncWorker`'s
`convergenceIntervalMs`, default 15s) is only a fallback for retries/recovery/cross-tab.

Therefore **keep the interval long.** A short interval is the dominant idle cost: every PGlite query is
~50ms of WASM work on one thread, and an unconditional reconcile each tick re-runs every live query. The
demo uses `intervalMs: 15_000`, cutting idle CPU from ~70% of a core to ~2% with **no change to
convergence latency** (latency is bounded by the Electric echo, not the interval). Do **not** shorten
the interval to "make writes faster" — it does nothing and burns CPU.

## Serve the gateway over HTTP/2 (the connection budget)

Electric's client holds **one live long-poll connection open per synced shape**. A client subscribing to
six shapes keeps six connections busy, and browsers cap **HTTP/1.1 at ~6 connections per origin** — so
over plain HTTP those long-polls consume every slot and the **write** request (same origin) is
**Stalled in the browser's connection queue** for a whole long-poll cycle before it is even dispatched.
This presents as multi-second writes that are invisible to `curl`/Node (which have no per-host cap) —
only a real browser shows it (DevTools → Network → a stuck `write` with a long **Stalled** time).

Fix: serve the gateway over **HTTP/2** (or HTTP/3), which multiplexes every request over one connection.
Any production ingress already does (Cloud Supabase, Electric Cloud, istio/Envoy, a TLS reverse proxy);
it only bites a local stack on plain `http://` (browsers only negotiate HTTP/2 over TLS).

## Serverless edge cold starts

On a serverless edge a worker is suspended when idle and evicted after longer idle, so the **first write
after a quiet period** pays a cold start while steady-state writes are instant (measured: ~20ms warm,
~0.45s after ~15s idle, ~5.8s on a cold module cache). This is a property of the deployment target, not
pgxsinkit — a long-lived Bun/Deno process or a managed warm pool has none. Mitigate: keep the worker warm
with a periodic cheap request (an empty `{"mutations":[]}` POST, rejected at validation before any DB
work), and set the worker wall-clock timeout **above** Electric's ~25s long-poll so a live subscription
is not recycled mid-cycle.

Region-pin **only the DB-bound write function**, not read proxies. Pinning the write function's execution
to the database's region (Supabase `x-region`) keeps its chatty function→DB protocol on a ~1ms loop; a
read proxy's upstream is Electric Cloud's global CDN, so pinning reads away from a distant caller instead
**adds** intercontinental hops per catch-up (~1.2s vs ~300ms). `createSyncClient` splits this cleanly:
`requestHeaders` is the shared base (sent on reads AND writes — e.g. a gateway `apikey`), and
`writeRequestHeaders` is merged over it on the write path only. Put the region header in
`writeRequestHeaders`; never in the shared `requestHeaders`, which reads also send.

## Pre-warming PGlite's boot assets

A cold `PGlite.create` spends ~2.5s fetching + compiling the Postgres WASM (plus the initdb WASM and the
filesystem bundle) before it can open a store — otherwise paid **after** sign-in, on the path to first
paint. `createSyncClient` takes a `pgliteBootAssets` option: a promise of the already-fetched/compiled
assets (`{ pgliteWasmModule?, initdbWasmModule?, fsBundle? }`), awaited and passed straight into
`PGlite.create` so it skips its own lazy load. Start the fetch+compile on an **earlier screen** (a login /
identity picker) and hand the pending promise in — the WASM cost then hides behind user think-time. It is
best-effort: a rejected warm is caught to `undefined` and PGlite loads its own assets, so the warm never
fails the boot. The `boot pglite assets warm` rail stamp times it. (Board demo: `apps/board/src/board/
pglite-warm.ts` shows the Vite `?url` asset-URL pattern PGlite's `exports` field otherwise blocks.)

Pre-warming only hides the WASM fetch+compile; `PGlite.create` still spends ~1.9s on `initdb` + store open,
and that can't start until the store id is known (usually the signed-in user). To hide it too, create the
store EAGERLY under a generated id on the first screen and BIND it at auth. `createClientPGlite(storePath,
{ bootAssets })` runs the exact same create the client does internally (electric + live extensions, warm
consumption, the `boot pglite.create` stamp) and returns a schemaless instance; hand the still-pending
promise to `createSyncClient`'s `precreatedPglite` option. Unlike `pgliteInstance` (caller owns schema),
`precreatedPglite` lets the client still run schema exec, prepare hooks, journal recovery and store-version
reconcile — so the eager create buys only `initdb`, and the role/registry-derived schema stays post-auth. A
rejected `precreatedPglite` is caught and falls back to the `storePath` create path (which also consumes
`pgliteBootAssets`), so it is a pure accelerator, never a boot dependency. Bind eager stores to users with a
small localStorage registry (userId→storeId plus one unbound "spare"): create a spare on the login screen,
claim it at sign-in, and GC any store that is neither mapped nor the spare. On a signed-in RELOAD there is
no login screen to create ahead of, so START the mapped-store open at app bootstrap (before React render),
memoised per userId so the provider's later open adopts it rather than opening a second instance. (Board
demo: `apps/board/src/board/store-registry.ts`, `store-prewarm.ts`.)

## Worker mode: capability-placed off-thread engine (browser apps)

In a browser, prefer worker mode so PGlite, shape streams, journal machinery, and convergence leave the
main thread. The SharedWorker is always the communication centre. There is no placement option: where the
engine runs is a runtime capability decision. Under the default `storage.backend: "opfs"`, an
unconditional real synchronous-handle open at boot chooses the engine home: real macOS/iOS Safari
runs the OPFS-repacked engine directly in the SharedWorker; Chromium/Firefox elect one tab-spawned
dedicated engine worker through Web Locks. Playwright WebKitGTK denies the handle in both worker kinds and
exercises the capability fallback to idb (declared durability kept, `storageBackend: "idbfs"` +
`storageFallbackReason` on the BootReport). The one opt-out is `storage.backend: "idbfs"` on the registry:
no probe, no election, the engine boots in the SharedWorker on idb. `createSyncClient` remains the bun/Node
mode and the main-thread idb fallback where SharedWorker is missing.

**Two-file pattern.** One worker entry, bundled for both SharedWorker and dedicated Worker, calls
`defineSyncWorker({ registry, electricUrl, batchWriteUrl, … })` at module top level — no placement or
durability option (both are runtime/registry concerns); the registry is CODE, _imported_ by the worker
file, never cloned/serialized in. Give each store a stable SharedWorker name and always pass
`extendedLifetime: true` (Chromium 148+ grace period; ignore-safe elsewhere). The tab calls
`attachSyncClient({ worker, registry, getToken })`, where `worker` is a **factory**
(`worker: () => SharedWorker`), not an instance — a SharedWorker cannot be reconstructed from itself, and
the factory is what makes SharedWorker-death recovery a guarantee. The elected engine worker needs no
consumer wiring: the SharedWorker reports its own script URL and the winning tab constructs the engine as
`new Worker(reportedUrl, { type: "module" })`. Supply `createEngineWorker` ONLY as an override for entries
that cannot be reconstructed from their URL as a module worker (classic-script workers, `blob:`/`data:`
URLs, CSP); with no override and no derivable URL, attach fails with a typed error — never a silent
no-engine attach. The attached facade returns the same
client shape as `createSyncClient` (write API, one-shot Drizzle reads, live rows,
`ready`/`status`/`stop`) plus `notifyAuthChanged` and `setOnline`, proxied to the shared engine. One-shot
reads (`query`/`queryRow`/`queryRaw`/`queryRawRow`) compile on the tab and cross the bridge as ONE guarded
round trip — the worker runs the read gate + lazy-group guard, then Drizzle's own mapping runs back on the
tab, so results match the in-process client exactly. A bare awaited `client.drizzle` builder is ALSO
guarded here (the in-process unguarded escape hatch has no attach equivalent), and
`client.drizzle.transaction()` throws (no tab-local store). `ensureSynced` is proxied (additive,
idempotent); `isSynced` throws — it is a SYNCHRONOUS activation-started peek the tab's cached catch-up
readiness cannot answer (use `groupReady` for catch-up, `ensureSynced` to activate). Local
`pglite` and `dropReadCache` are NOT proxied — there is no tab-local store and a cache rebuild is
engine-wide. `destroy()` IS proxied through a tab-side supervisor: it refuses peers with
`StoreDestroyRefusedError`, refuses owed journal rows unless `{ force: true }`, retires/closes the engine,
then runs a resumable deletion. The lazy lifecycle methods ARE proxied, but the engine is SHARED:
`desync(tableKey)` from one tab reverts the consistency group for EVERY attached tab (desync's group-wide
revert is engine-wide here — the footgun). For an ephemeral delivery window use `discardEphemeral(tableKey)`
instead — the scoped, multi-tab-safe finalize (drops the ephemeral rows, reverts to dormant, refuses a
group with any persistent member); safe under a shared engine because an ephemeral window is
per-delivery-session and single-consumer. The exception is the INSPECTION surface `rawQuery(sql, params)` /
`rawExec(sql)` (debug pages, REPLs, ad-hoc counts): identical on both clients (executed in the worker on the
attach client), it runs raw against the local store — bypasses the journal/overlay, any write stays local
and never converges — so it is not an app-data read path. `replAdapter(client)` shapes it into the
`{ query, exec }` duck `@electric-sql/pglite-repl` needs (`client.pglite` stays unavailable). A worker file can bake multiple role variants and pick per attach via
`resolveRegistry(role)` + the tab's `role` (the board's admin/member registries; the spare needs it). The
worker entry can also pass the app-level schema prepare hooks `prepareLocalDbBeforeSchema` / `prepareLocalDbAfterSchema`
(app migrations, indexes, views) — same semantics as in-process, run in the worker around the registry schema
exec; they are worker-entry (not attach) options because a hook is a function and cannot cross the bridge.

**Identity switches do not wait for worker retirement.** Scope each worker identity by `storePath`; use a distinct,
stable SharedWorker name for each store. Multiple stores may remain alive concurrently. Detach/stop the old
client and immediately attach the new identity's worker/store — never wait for the old SharedWorker, elected
engine, provision expiry, or `extendedLifetime` grace period. In worker mode `stop()` detaches only this tab;
in-process mode it disposes live queries before closing that client's engine and store. The board's
`userId → storeId` registry and real-browser identity-switch lane demonstrate this guarantee.

**Auth stays tab-owned (ADR-0013).** The tab pushes `{accessToken, expiresAt}` at attach and on
`notifyAuthChanged`; the worker uses the cached token and sends a pull-request only when a request finds it
near expiry (any tab answers via `getToken`, first wins). The worker NEVER refreshes — exactly one refresher,
so GoTrue refresh-token reuse detection can't be tripped by a second client.

**Boot: spare-as-worker + internal prefetch overlap.** The spare store (see above) becomes a pre-spawned
schemaless worker at the login screen (create + initdb off every thread that matters); the userId→storeId
registry stays tab-side in localStorage so binding resolves before attach (SharedWorker naming needs it).
Call `provisionSyncWorker` with the same `worker` factory as attach; an elected
Chromium/Firefox pre-open shares the tab's one election coordinator and auto-derives the engine from the
SharedWorker's own script URL (override with `createEngineWorker` only for non-module/underivable entries).
Claim = bind id, attach, push config + token. On a PROVABLY-fresh claimed store, pass
`attachSyncClient({ freshStore: true })` (never for a mapped/returning store) and the worker overlaps the
shape catch-up with schema/journal/store-version recovery — far-user boot bounded by `max(create+schema,
catch-up)`, not their sum. New boot-rail stamps: `boot spare store ensured`, `boot mapped store prewarm`,
`boot store claimed`, `boot shape prefetch start`, `boot commits opened`.

**`ready` unchanged; per-group readiness exposed.** `client.ready` still gates on every eager group; for
progressive paint use `await client.groupReady(tableKey)` or read `status.groups` — no contract change.

**Debug rail is forwarded and origin-tagged.** A SharedWorker's own console is invisible to the page (only
`chrome://inspect`), so the worker forwards every rail line to each tab, stamped with the WORKER's monotonic
clock and re-printed as `[pgxsinkit·w <ms>ms] …`, gated by that tab's own `globalThis.__pgxsinkitDebug`. Set
the flag on the TAB as usual; the write/read/boot phases below read the same, just origin-tagged. The front
half of boot runs on the FIRST attach before any tab is listening, so the worker buffers those pre-attach
rail lines in a bounded ring (last 500) and replays them `[replay]`-marked to the first attaching tab (so
the boot's opening phases reach it too, ADR-0034). The worker's NETWORK traffic is invisible the same way:
shape requests never appear in the page's Network panel — "rail shows `shape request start`, Network tab
shows nothing" is worker mode working as designed, not an absence of requests. Inspect the worker itself
(`chrome://inspect/#workers` → inspect) for the real requests, status codes, and errors (e.g. CORS
rejections surface only there). Full model:
<https://pgxsinkit.github.io/concepts/worker-mode/>.

**Placement and relocation diagnostics.** Pull `client.bootReport()` and inspect `storageBackend`
(`opfs-repacked`/`idbfs`/`filesystem`/`memory`), `engineHome`
(`shared-worker`/`elected-worker`/`in-process`), and `storageFallbackReason`; never user-agent-sniff the
backend. During elected-engine handoff, `EngineRelocatedError("not-dispatched")` is safe to retry, while
`"unknown"` means a dispatched mutation may already be journaled — inspect/reconcile, never retry blindly.
The opt-in `executionLimit` is disabled by default — no finite worst-case query duration exists and the
limit converts slow to terminated by policy, so enabling it must be a deliberate choice. It is
elected-only, and must match between the worker entry and every tab (`ExecutionLimitMismatchError`
otherwise); SW-direct Safari rejects it as unsupported.

## Live-query manager: dedup + keep-alive (ADR-0040)

Every reactive read (`useLiveDrizzleRows`/`useLiveQueryRaw`/`subscribeLiveRows`) is a **local SQL live
query**: PGlite materialises it once, then re-runs + diffs it on every write to its tables. That registration
is a real cost — ~a few hundred ms to materialise a heavy aggregate — and is **automatically deduplicated**:
identical queries (keyed on executed SQL + bound params, NOT `use`) share ONE registration and ONE re-run +
diff per write, fanned to every subscriber. So N components — or N tabs on the shared worker — on the same
query cost one materialisation, not N. You do nothing to get this.

Default lifetime is route-scoped: a live query is torn down the instant its last consumer unmounts, so a
navigate-away-and-back RE-materialises it. Opt a genuinely hot query into a grace period with a per-hook hint
`useLiveDrizzleRows(build, deps, { keepAliveMs: 30_000 })` (or the raw-hook / `subscribeLiveRows` field), or
set a worker/client-wide policy `defineSyncWorker({ …, liveQueries: { defaultKeepAliveMs, maxRetainedQueries,
maxRetainedRows } })` (defaults `0` / `16` / `50_000`; same block on `createSyncClient`). The effective
keep-alive is `max(default, subscribers' hints)`; the count/row budgets are authoritative over any hint and
LRU-evict zero-subscriber entries past them; active (still-subscribed) entries are never evicted.

**Keep the default 0 unless you have a specific hot query.** A retained zero-subscriber query is NOT paused —
PGlite live queries can't be — so it still pays a full re-run + diff on every write to its tables for as long
as it's held. Retention wins only for a frequently-re-mounted, write-COLD query; for a write-hot one it costs
more idle than the one re-materialisation it saves. For a fixed hot set, the endorsed "permanent" pattern is a
**mounted subscriber** (a root-provider hook that never unmounts) — one live registration for the app's life,
every route dedups onto it — not a retention setting; there is deliberately no retain-forever knob.

`client.liveQueryDiagnostics()` returns a per-entry snapshot — fingerprint DIGEST (never SQL/params/rows),
subscriber + row counts, setup/refresh timings, retention state — safe to log. The manager also emits
`live-query register|dedup-hit|retained|evicted|teardown-complete` lines on the debug rail (digests only).

## Store naming, backups, and restore (ADR-0035/0036)

**Stores are named by a plain `storePath`, never a storage URL.** The backend is derived, not named — a
capability-proven browser engine home uses OPFS-repacked; fixed worker mode, a denied engine home, and the
main-thread browser fallback use IndexedDB; bun/Node uses the filesystem. Anything containing `://` throws
`InvalidStorePathError` — do not "fix" that by re-adding a scheme, drop it. Memory-backed stores are
deliberately unreachable from the production API (durability semantics assume a persisted store): tests spread
`memoryStoreForTests("name")` from `@pgxsinkit/client/testing`, and a caller-owned
`pgliteInstance`/`precreatedPglite` that is provably non-persistent (`dataDir` undefined — a bare
`new PGlite()` — or `memory://`) is refused with `NonPersistentStoreError` unless `testStoreAcknowledgment()`
is spread alongside. For browser store GC, get the IndexedDB name from
`storeIndexedDbDatabaseName(storePath)` — never assemble `/pglite/…` yourself.

**Relaxed durability is the default.** It is declared once, on the registry
(`SyncRegistryDefinition.storage.durability`, `"relaxed" | "strict"`) — never on a minting surface,
worker entry, or attach site, because durability follows the data, and one declaration binds every open
of every store minted from that registry. Its physical behavior is
backend-specific. On idb, relaxed returns before the whole-datadir snapshot flush and schedules it
asynchronously; strict pays that synchronous snapshot (~100–200ms per optimistic mutation). On
OPFS-repacked the host still awaits every sync: relaxed asserts VFS health and runs any due deferred repack
without an ordinary physical flush, while strict flushes arena data before metadata. Initialization,
repack activation, and open-state close use strict ordering in either OPFS mode. The resolved value is
stamped on the `boot pglite.create` rail line.

**The idb loss window.** On the idb backend the store is an in-memory FS with debounced whole-snapshot writes to
IndexedDB, so `relaxed`'s window is every write since the last COMPLETED snapshot (a whole-FS debounce). The
risk lands only on a crash before BOTH the journal rows reach the write API (~hundreds of ms after enqueue)
AND the scheduled snapshot lands — and synced tables are server-recoverable by construction, so only consumer
**local-only** tables carry real risk. `storage: { durability: "strict" }` on the registry is the escape
hatch if you keep unrecoverable local-only data and cannot accept that window; on idb it costs
~100–200ms/write (allowed and documented, not forbidden).

On OPFS-repacked, browser/worker termination recovers the longest valid stable metadata-log prefix; an
unflushed suffix may be absent. A returned strict boundary is stable under that browser-failure model. Do
not generalize this to power loss, media failure, or external store edits.

**Three exports, named by purpose, all returning `{ file, report }`** (report = phase timings + a
`MutationDiagnostics` snapshot, BootReport-style). They work identically on the in-process client and the
attach client (the artefact crosses the bridge as a transferred buffer):

- `exportStore()` — the **store backup**: a live, checkpointed `dumpDataDir` tarball of the WHOLE store,
  journal and overlay included. Never blocks, works offline with unflushed writes; restorable ONLY into
  PGlite via restore below. This is the backup/migration format.
- `exportDiagnostics()` — everything as SQL (synced + overlay + journal + views/functions + the `pgxsinkit`
  schema) for support evidence. Never blocks; not for restoring.
- `exportData({ drainJournal? })` — the **portable** SQL (synced tables + their enum types, nothing of
  pgxsinkit's machinery; loads into vanilla Postgres). The ONE blocking variant: it requires a fully
  drained journal (an `acked` write whose echo has not landed is NOT yet in the synced tables), so it
  flushes and awaits convergence up to `drainJournal.timeoutMs` (default 15s), failing fast with
  `DataExportDrainError` (+ diagnostics) on `failed`/`quarantined`/`conflicted` rows. `drainJournal: false`
  exports synced state as-is and flags it in the report.

The pg_dump variants run against a **throwaway clone** booted from the backup — the live engine is never
suspended and tabs never pause. Exports, `destroy()`, `discardEphemeral()`, and `dropReadCache()` all
serialise through one lifecycle slot: a concurrent call rejects immediately with `LifecycleBusyError`
(no queueing — retry after the holder settles). Ephemeral (`pg_temp`) content is never in any artefact.

**Restore** = `createSyncClient({ restoreFrom: backupFile, … })` (or `attachSyncClient` — the tarball rides
the boot attach), ONLY into a store path that does not exist in EITHER idb or OPFS
(`RestoreTargetExistsError` otherwise; the overwrite path is a deliberate `destroy()` first). Recovered
journal rows are quarantined because the write path has no mutation dedupe. A dirty-journal restore stays
offline for inspection; a clean-journal restore may honor the normal online options immediately. Inspect
`diagnostics()`, resolve quarantined rows via `discardQuarantined` (+ re-author if wanted), then reboot the
persisted store normally. Consumer docs:
<https://pgxsinkit.github.io/concepts/export-and-restore/>.

**Adoption.** An existing idb store is authoritative and is never silently replaced by a newly capable
OPFS home. Automatic adoption is default-off and requires the worker-entry declaration
`adoption: "server-reconstructible"`; only a drained journal, authorized online reconstruction, and a
returned strict barrier permit the idb predecessor to be deleted. `adoptStore()` is the manual
creation-path equivalent and refuses a live store with `StoreInUseError`.

**Resetting and deleting stores (ADR-0050).** Three non-interchangeable levers — pick by what you keep
and whether the store is running:

- `client.dropReadCache()` — keep the store, drop synced rows, resync in place (overlay + journal survive).
- `client.destroy()` — delete a RUNNING store from an attached client: peer-count checked
  (`StoreDestroyRefusedError` while peers hold it), owed-journal checked (refused unless `force`),
  teardown-acknowledged before deletion.
- `destroyStoreArtifacts(storePath)` — delete a NOT-running store by path: OPFS directory + commitment
  sentinel + meta record + idb database, backend-agnostic, bounded ownership-lag retry. Documented
  precondition, no liveness probe: on a still-held path it throws the ownership error — loud and safely
  re-runnable (idempotent, phase-recorded; a `deleting`-marked store is refused for boot). Keep failed
  paths on a retry list for the next boot. An idb-only sweep is NOT a substitute — it leaks the OPFS arena.
- `quiesceStoreWorker(worker, opts?)` (ADR-0050) — the by-path TEARDOWN companion that MAKES a store
  not-running before `destroyStoreArtifacts`. Give it a worker factory of the same shape `attachSyncClient`
  takes (`() => new SharedWorker(url, { name: storePath })`) — but the factory MUST construct the worker with
  **byte-identical options to the LIVE store worker**, `extendedLifetime: true` included. A named SharedWorker
  dedups onto one instance, and Chromium (148+) FAILS a second `new SharedWorker(name, …)` whose options
  disagree with the live one (an `error` event, no `onconnect`) — the teardown port then exchanges zero
  messages and only times out. Omitting `extendedLifetime` on the teardown worker does not shorten its life
  (`closeHost` + `scope.close()` end it); it only breaks the dedup and defeats the primitive. It reaches the
  worker by name, posts the
  declaration, queries placement, and for an SW-direct home (idbfs, real-Safari opfs) sends `engine-teardown`
  and AWAITS the reserved ack (engine stopped, backend connection released → `{ toreDown: true }`); an elected
  home is a no-op (`{ toreDown: false }` — the elected engine dies with its tab). Compose best-effort:
  `await quiesceStoreWorker(f).catch(() => {}); await destroyStoreArtifacts(path)`. A timeout REJECTS (not
  proof of teardown, default 6s) and must not abort the destroy; omit `storage` (no opinion) so a worker on
  an older declaration is never refused; idempotent + safe on an already-dead store.

**Storage-preference changes.** A store's storage declaration (backend/durability) is IMMUTABLE — bound at
first contact, conflicts refused typed (`StorageDeclarationRefusedError`). Never re-home or
delete-and-recreate a live path (an `extendedLifetime` predecessor may still hold it). The pattern:
atomically drop bindings + record the old exact paths on an obsolete list FIRST, then write the new
preference and reload; fresh stores mint under fresh paths, and each boot walks the obsolete list in
the background (never awaited on sign-in), per path QUIESCING the worker (`quiesceStoreWorker`) BEFORE
`destroyStoreArtifacts`. The quiesce is what makes idbfs converge: an `extendedLifetime` idbfs
predecessor holds its IndexedDB connection across the reload, so a bare destroy would block forever
(opfs releases on idle; idbfs does not) — tearing the host down releases the connection so the first
retry wins. Dynamic declarations travel as the wire `storage` option on
`attachSyncClient`/`provisionSyncWorker`; a registry-attached static declaration stays authoritative. Consumer docs:
<https://pgxsinkit.github.io/concepts/local-store-lifecycle/>.

## Proxying Electric: force `cache-control: no-store`

Electric tags shape responses with a CDN-oriented `cache-control` (`max-age`, `stale-while-revalidate`).
Behind a **same-origin proxy with no CDN**, the browser cache serves them **stale** the moment a shape
handle rotates (re-seed, re-login, restart), and the client loops on "expired shape handle" **409s**
until it self-heals. Force `cache-control: no-store` on the proxied response:

```ts
const response = await proxyElectricShapeRequest(request, claims, { registry, electricUrl });
const headers = new Headers(response.headers);
headers.set("cache-control", "no-store");
return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
```

Resumption stays cheap because Electric's offset/handle bookkeeping (in the local store) makes it cheap,
not the HTTP cache.

Upstream direction, hosted Electric behind a CDN: live long-polls can be answered by a layer blind to
fresh commits (consecutive full-hold `up-to-date` responses at an unmoved offset → ~40–90s cross-client
propagation). The proxy appends a unique `cache-buster` to every `live=true` upstream request by default
(`bustLiveUpstreamCache`; catch-up stays unbusted for CDN cold-fanout sharing). TEMPORARY
upstream-defect mitigation — it defeats Electric's sanctioned live-poll coalescing (per-client origin
fan-out at scale); flip off once Electric Cloud wakes coalesced polls reliably. Distinct from the
ADR-0033 sibling nudge, which is permanent protocol behavior. Running your own CDN in front of
self-hosted Electric: key on the FULL query string (every param is load-bearing), respect origin
cache-control, keep SWR windows modest, let coalesced live polls complete immediately on origin
response, read-timeouts 60s+, then VERIFY with bust off — cross-client render ≲3s = healthy, ~a full
hold cycle = live path served blind (full checklist: operating-in-production docs page). Harmless
self-hosted;
set `false` to restore untouched forwarding.

## Debugging latency: `globalThis.__pgxsinkitDebug`

`@pgxsinkit/client` ships opt-in, off-by-default, timestamped instrumentation that traces a write through
every phase. Enable it from the console or before boot:

```js
globalThis.__pgxsinkitDebug = true; // reproduce, then filter the console to "pgxsinkit" + enable Verbose
```

Read the **gaps** between phases: `mutation staged {mutationId, table}` (the write's origin — correlate
by id with the later sent/acked lines); `convergence pass requested` → `flush` / `reconcile`
(durations); `board-write auth token resolved {ms}` (a stalling per-request token fetch shows here);
`board-write responded {status, ms}` (a cold worker, or a browser connection stall, shows here);
`sync received change batch` → `sync applied {ms}` (truthful: fires only when the batch committed — a
batch gated behind a quiet sibling's watermark logs `sync change batch held by group frontier` +
`live-tail sibling nudge {shape}` instead, ADR-0033); `live query updated → re-render`. The read path has
its own pair: `shape request start {shape, offset, live}` → `shape request done {shape, status, ms,
upToDate?}` for EVERY Electric HTTP cycle (catch-up and long-poll), plus `must-refetch received {shape}`
when the server rotates a shape (the truncate + re-snapshot recovery trigger — the thing to look for
when a table unexpectedly re-syncs). Server-side, `createSyncServer({ logTimings: true })` emits the
matching per-request `[pgxsinkit-timing]` lines (see the `deploying` skill, `@pgxsinkit/server`);
client-observed minus server `totalMs` isolates routing + network. Boot is stamped too — the `boot
pglite.create` → `boot client ready` phases (local store open, schema apply, journal recovery,
store-version reconcile, sync start) let you attribute a slow first paint to a specific boot phase, and
`boot pglite assets warm` times the optional boot-asset pre-warm (see below).

**Structured boot numbers — the `BootReport`.** The rail lines are for a human reading a console; for
machine-keepable numbers (dashboards, CI budget gates) every boot ALSO builds a versioned `BootReport`,
independently of the rail so it exists whether or not the flag is on (ADR-0034). Read it by push
(`onBootReport?: (report) => void` client option, fires once at boot completion) or pull
(`await client.bootReport()` → the most recent completed boot, `null` before the first sync; in worker mode
it round-trips to the worker's stored report, so a late tab reads a boot that predates it). It carries
`totalMs`, decomposed `phases`, and a per-group `groups[]`. Two reading caveats: groups catch up
CONCURRENTLY on one WASM thread, so a group's `fetchMs` is an UPPER BOUND on network wait (it absorbs other
groups' applies + main-thread work between deliveries), and concurrent `applyMs` can overlap — never sum
them into a `totalMs` partition; and a non-null `provision` block is a spare's off-thread `initdb` made
visible (then `phases.pgliteCreateMs` is `null`).

A `catch-up watermark aligned {floor}` line marks the one moment the group finished its initial catch-up
and aligned its commit floors (ADR-0031). Electric's catch-up responses are CDN-cacheable and carry the
`up-to-date` watermark inside the cached body, so a quiet shape's stale cached watermark would otherwise
hold a busy shape's fresh changes until the quiet shape's first live long-poll (~41s on Electric Cloud —
the "stale board that rearranges itself" symptom). The client aligns once to the freshest asserted head
instead; the trade is a sub-second torn view of a multi-table transaction at load, self-healing in one
round trip, rather than a consistent-but-seconds-stale one. The same hold recurs on the **live tail**
(a quiet sibling's parked long-poll returns only at hold expiry), where the engine **nudges** the
laggards instead of waiting — `sync change batch held by group frontier` → `live-tail sibling nudge
{shape, target, round}` → commit on the refreshed watermarks; `live-tail nudge exhausted` means a
sibling never advanced and the engine degraded to waiting out its poll (ADR-0033). Full prose:
<https://pgxsinkit.github.io/start/operating-in-production/>.

**Measure at the network boundary, not by polling PGlite.** Each PGlite query is ~50ms on one thread, so
a tight `setInterval` reading PGlite to "watch" a value inflates the very latency it reports. Trust the
instrumentation's network timings and a server-side `curl` over a poll loop.

**Inspecting a stuck or failed write.** To see _why_ a write is not converging — its journal status,
attempt/retry counts, last error, or a table's pending/conflict/quarantine state — read the generated
journal and sync-state relations with the typed factories `getJournalTable(registry, tableKey)` /
`getSyncStateView(registry, tableKey)` from `@pgxsinkit/client` (typed Drizzle, no hand-written SQL against
`<t>_mutations`). One-shot diagnostic reads only — don't poll them in a loop.

**Rolling back a terminal write.** Both terminal dispositions keep the optimistic overlay and now have a
symmetric discard. A stale-write `conflicted` row (fired via `onConflict`) rolls back with
`client.discardConflict(table, entityKey)`; a structurally-rejected `quarantined` row (fired via
`onQuarantine` — a validation failure or a permanent policy denial such as an RLS `42501`) rolls back
with `client.discardQuarantined(table, entityKey)`. Each clears the entity's terminal journal rows +
kept overlay, so the read model falls back to the synced value and the entity accepts new mutations
again (a lingering terminal row otherwise blocks a re-create and chains a later update onto a dead head).
Because quarantine has a real rollback now, route a permanent policy denial to `quarantined` — don't
mis-route it to `conflicted` to borrow a discard.

## Common mistakes

- Shortening the convergence interval to chase write latency (no effect; wastes CPU).
- Serving many-shape sync over plain HTTP/1.1 and blaming the server for stalled writes.
- Omitting `cache-control: no-store` on a same-origin shape proxy → intermittent 409 loops.
- Treating an edge cold start as a toolkit/sync-rail problem.
- Measuring latency by polling PGlite in a loop instead of at the network boundary.

Full prose: <https://pgxsinkit.github.io/start/operating-in-production/>.
