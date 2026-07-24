---
title: Worker mode
description: Attach through a SharedWorker while runtime capability decides whether the engine runs there or in one elected dedicated worker.
sidebar:
  order: 8
---

By default `createSyncClient` runs the whole local-first engine **in the tab that called it** — PGlite,
the Local schema, the mutation journal, the Electric shape streams, and the convergence loop all execute
on that tab's thread. **Worker mode** leaves the tab a thin view and uses a native `SharedWorker` as the
communication centre. A real OPFS open at boot decides the engine's home:
Safari runs it inside that SharedWorker; Chromium and Firefox elect one tab-spawned dedicated worker.
React, live-query results, query building (Drizzle still compiles on the tab), auth ownership, and the
app-facing API stay on the main thread in both arrangements.

This is the recommended topology for **browser apps**. `createSyncClient` remains the in-process mode for
bun tests, Node harnesses, and the fallback below — same engine, same unit-suite coverage, just on the
calling thread.

## The two-file pattern

Worker mode is a facade **pair** with the same client shape as `createSyncClient`:

- **The worker entry** (a file bundled for both worker kinds) calls `defineSyncWorker({ registry,
electricUrl, batchWriteUrl, … })` at module top level. It hosts the engine directly or acts as its router. The
  registry is **code** and must be _imported_ by the worker file — never cloned or serialized into it.
- **The tab** calls `attachSyncClient({ worker, registry })`, which returns the same surface as
  `createSyncClient` (the write API, Drizzle reads, live rows, `localReadReady`/`writeReady`/`ready`/`status`/
  `stop`), transparently proxied to the shared engine, plus `notifyAuthChanged` and `setOnline`.

`attachSyncClient` resolves at **local-read readiness** — the worker's engine has an open store with a
compatible schema, so cached rows are queryable immediately (offline included). Writes are safe the moment
attach resolves: every write method transparently awaits `writeReady` (the write runtime + boot recovery) in
the engine, so a write issued the instant attach resolves simply completes once that stage crosses — you
never gate writes yourself. `ready` and per-group `groupReady` keep their catch-up meaning (below).

```ts
// sync.worker.ts — bundled as a worker; imports the registry as code
import { defineSyncWorker } from "@pgxsinkit/client";
import { registry } from "./registry";

defineSyncWorker({
  registry,
  electricUrl: "/api/shape",
  batchWriteUrl: "/api/mutations",
  // No placement or durability options here: where the engine runs is a runtime capability
  // decision, and storage backend + durability are declared on the registry (registry.storage).
});
```

```ts
// tab code
import { attachSyncClient } from "@pgxsinkit/client";
import { registry } from "./registry";

const storePath = "my-app-store";
// `worker` is a FACTORY, not an instance: a SharedWorker cannot be reconstructed from itself, and
// the factory is what makes SharedWorker-death recovery a guarantee.
const worker = () =>
  new SharedWorker(new URL("./sync.worker.ts", import.meta.url), {
    type: "module",
    name: `pgxsinkit:${storePath}`,
    extendedLifetime: true,
  } as WorkerOptions & { name: string; extendedLifetime: boolean });

const client = await attachSyncClient({
  worker,
  storePath,
  registry,
  // No createEngineWorker here: the elected engine worker is auto-derived from the SharedWorker's
  // own script URL. Supply createEngineWorker only for non-module / underivable entries (below).
  getToken: async () =>
    currentSession && { accessToken: currentSession.access_token, expiresAt: currentSession.expires_at },
});
```

The same worker entry serves a native `SharedWorker` (many ports, `onconnect`) and the elected dedicated
`Worker` (one implicit port). Keep the SharedWorker name stable and store-specific so tabs converge on
the same communication centre. On a handle-denied browser the elected engine worker needs **no** consumer
wiring: the SharedWorker reports its own script URL and the winning tab constructs the engine as
`new Worker(reportedUrl, { type: "module" })`. `createEngineWorker` is an **override** for entries that
cannot be reconstructed from their URL as a module worker (classic-script workers, `blob:`/`data:` URLs,
CSP constraints); with no override and no derivable URL, attach fails with a typed error — never a
silent no-engine attach.

The worker entry can also carry the app-level schema prepare hooks — `prepareLocalDbBeforeSchema` and
`prepareLocalDbAfterSchema` — with the **same semantics as `createSyncClient`** (they run in the worker against the
engine's local store, before/after the registry schema exec); they are worker-entry options rather than
attach options because a hook is a function and functions cannot cross the bridge.

If the worker's engine **local-read core** fails (the store cannot open, or its schema is incompatible),
`attachSyncClient` **rejects** with that boot error rather than hanging silently — and a later attach retries
the boot. A failure **after** local-read readiness (the background write/sync tail) does _not_ reject the
already-resolved attach; instead it rejects `writeReady`/`bootSettled`, so a gated write fails loudly rather
than the client hanging.

:::note[Behavioural change — attach resolves at local-read readiness (ADR-0041)]
`attachSyncClient` (and the in-process `createSyncClient`) now resolve at **`localReadReady`**, not after full
boot. Cached rows in the persisted store are queryable — **offline included** — the instant attach resolves,
before sync starts or the network is touched. Previously attach resolved only after the whole boot (write
runtime, boot recovery, and sync **start**) had run, so a returning consumer that only wanted to paint cached
rows still waited on the write runtime and the sync engine.

**What this means for your code:** first paint should gate on **attach** (or `await client.localReadReady`),
not `await client.ready`. Per-view loading is driven by `hydrating`/`groupReady` (the live-rows hooks);
`ready` is for whole-sync UX (a "fully caught up" badge). Writes need **no** gate — every write method awaits
`writeReady` internally, so a write issued the instant attach resolves completes once the write runtime is
up. If you were relying on "attach resolved ⇒ the next write flushes immediately", that first write may now
await write-runtime init (a small window; see [ADR-0041](/decisions/0041-staged-boot-readiness/)). This repo's
releases are tag-derived, so this callout and the ADR are the record of the change.
:::

## Capability placement and storage

Where the engine runs is a **runtime capability decision**, never a consumer knob. The SharedWorker
probes once per worker lifetime — unconditionally, under the default `storage.backend: "opfs"` — by
actually creating a scratch sync access handle. The only storage knob is the **registry** declaration
(`SyncRegistryDefinition.storage`): `backend: "opfs"` (the default) runs the probe on every platform;
`backend: "idbfs"` forces the in-SharedWorker IndexedDB engine and skips the probe entirely — the one
way to opt out, and it lives with the DATA contract because forcing idbfs is a storage decision, not a
placement or wiring one. The probe outcomes:

| Probe result                                                           | Engine home      | Storage          |
| ---------------------------------------------------------------------- | ---------------- | ---------------- |
| Granted in SharedWorker (real macOS/iOS Safari)                        | `shared-worker`  | `opfs-repacked`  |
| Denied in SharedWorker, granted in dedicated Worker (Chromium/Firefox) | `elected-worker` | `opfs-repacked`  |
| Dedicated Worker also denied (Playwright WebKitGTK)                    | `elected-worker` | `idbfs` fallback |
| No SharedWorker                                                        | `in-process`     | `idbfs`          |

The Safari statement is backed by a real-device full boot, persist, and reopen on 2026-07-21. Do not
substitute Playwright WebKitGTK for Safari: the test build has a different capability result.

Read the outcome from `await client.bootReport()`, not from user-agent detection:

```ts
const report = await client.bootReport();
report?.storageBackend; // "opfs-repacked" | "idbfs" | "filesystem" | "memory"
report?.engineHome; // "shared-worker" | "elected-worker" | "in-process"
report?.storageFallbackReason; // present only when an OPFS-capable boot actually opened idb
```

The worker is named by its store id, so N tabs attach through one communication centre and ultimately
share **one store, one Electric connection set, and one convergence loop**. On Safari the SharedWorker
owns that engine directly. On Chromium and Firefox, Web Locks elect one tab's dedicated engine worker;
per-tab pipes connect tabs directly to it, and the OPFS VFS's exclusive handles remain the hard
single-owner guard.

The worker owns that convergence loop: a write flushes **event-driven** the moment it is enqueued (the
RPC requests a pass), and tabs forward their `online`/`visibilitychange` events as wake signals, so the
worker's own interval — `defineSyncWorker`'s `convergenceIntervalMs`, default **15s** — is purely the
retry/recovery fallback sweep. Keep it long; see
[Convergence cadence](/start/operating-in-production/#convergence-cadence-event-driven-with-the-interval-as-a-fallback).

Browsers without `SharedWorker` fall back to the plain **in-process** main-thread client — a main
thread can never hold sync-access handles — never to a bespoke election layer. Because
`attachSyncClient` and `createSyncClient` share a client shape, the fallback is a construction choice,
not an app-code fork.

### Multiple stores and identity switching

Scope each worker identity by `storePath`, rather than sharing one worker across a browser profile or application. Give every store its own
stable SharedWorker name (normally derived from that path). Distinct stores may be alive concurrently, so an
application switching identities should detach/stop the old client and immediately attach the new identity's
worker/store. It must not wait for the old SharedWorker, elected engine, provision claim, or
`extendedLifetime` grace period to expire. `stop()` is the client lifecycle boundary: worker mode detaches that
tab while peers and the store-specific engine may remain alive; in-process mode closes that client's engine and
store after disposing its live queries.

The board demo exercises this contract by retaining a `userId → storeId` map and switching identities inside
one page realm. A returning identity reattaches its mapped store; a first-time identity claims a separately
provisioned spare. Neither path reuses the previous identity's store.

### `extendedLifetime` is a grace period, not placement

Pass `extendedLifetime: true` on every SharedWorker construction. Chromium 148+ may retain it briefly
after the last client leaves, which can let a pending relaxed IndexedDB snapshot land and can warm-start a
quickly reopened tab. Firefox and Safari ignore the unknown option safely. It does not retain Chromium's
elected engine worker and is not part of the OPFS durability guarantee.

### The storage declaration on the wire (ADR-0050)

The worker **name carries the store path and nothing else** — never configuration. The store's
storage declaration (`SyncStorageDeclaration`: `backend`, `durability`) normally lives statically on
the registry (`attachSyncRegistryStorage`), and that remains authoritative. For a consumer whose declaration is
**dynamic** (a runtime storage toggle, like the board demo's), the declaration travels on the wire
instead: pass `storage` to `attachSyncClient`/`provisionSyncWorker`, and the library posts a
**declaration message** on every worker port _before_ its placement query. A registry-silent worker
defers its placement decision until the first declaration arrives — `backend: "idbfs"` must skip the
OPFS probe, so the declaration has to precede the decision — and the first arrival binds for the
worker's lifetime. The same declaration rides the provision/attach payloads so the engine binds the
mint's durability wherever it runs.

The rules are strict, per field, on **explicit values only**: an unset field is "no opinion" and never
conflicts; an explicit field disagreeing with the registry's declaration or the already-bound one — or
any provision/attach arriving on a port that has not declared — is a typed
`StorageDeclarationRefusedError`, never a silent fallback. A store's declaration is **immutable**: to
change a preference, mint a fresh store under a fresh path, point users at it, and destroy the old
path's artifacts in the background with
[`destroyStoreArtifacts`](/concepts/local-store-lifecycle/) — never delete-and-recreate the same path
while an `extendedLifetime` predecessor may still hold it. Each obsolete (or wiped) path is first
**quiesced** — `quiesceStoreWorker` tears the store's SharedWorker host down by path so an
`extendedLifetime` idbfs predecessor releases the IndexedDB connection it holds across the reload
(else `deleteDatabase` blocks forever); OPFS releases on idle and needs no teardown (ADR-0050).

## Relocation and the execution limit

Elected placement can move the engine when its leader leaves, enters BFCache, reports a worker error, or
is deliberately terminated. New calls wait in a bounded handoff queue. Work whose response is lost is
reported honestly through `EngineRelocatedError`:

- `outcome === "not-dispatched"` means the operation never left the tab and is safe to retry;
- a dispatched read is safe to repeat after reattach;
- `outcome === "unknown"` means a dispatched mutation may already have updated the journal. Inspect and
  reconcile; never retry it blindly.

The optional `executionLimit: { maxDispatchMs }` converts an unresponsive elected worker into a deliberate
termination and respawn. It is disabled by default, applies only to elected placement, and every tab plus
the worker entry must carry the same value. A mismatch raises `ExecutionLimitMismatchError`; enabling it
on SW-direct Safari is rejected because a page cannot terminate that in-scope SharedWorker engine.

### Selecting a role per attach

A single worker file can bake **more than one registry variant** (e.g. the board's admin and member
registries — same TS shape, different write capability) and pick per attach. Pass `resolveRegistry: (role)
=> …` to `defineSyncWorker` and `role` to `attachSyncClient`; the attach's `config.role` selects the
registry the engine boots with (falling back to the default `registry` when the role is absent or
unknown). The spare-store flow needs this: the spare is provisioned before the user — and therefore the
role — is known, and the role is settled only at claim/attach.

## The tab stays the single auth owner

Auth ownership does **not** move into the worker (ADR-0013 unchanged). The tab pushes
`{accessToken, expiresAt}` to the worker at attach and again on every app auth-state change (call
`client.notifyAuthChanged()`); the worker uses the cached token for shape requests and write flushes, and
sends a **pull request** only when a request finds the token near expiry — any attached tab answers via
its `getToken`, first response wins. The worker **never runs its own refresh loop**, so exactly one
refresher exists and GoTrue refresh-token reuse detection can never be tripped by a second client.

## What crosses the bridge — and what does not

`attachSyncClient` proxies the full mandated attach surface (ADR-0032 decision 4): the write API
(RPC-backed), per-group readiness, the live-rows seam, `ready`/`status`/`stop` — and the one-shot Drizzle
reads (`query`/`queryRow`/`queryRaw`/`queryRawRow`). Query building happens on the tab (`drizzle` and
`views` are the same handles `createSyncClient` exposes); awaiting a builder sends the compiled SQL over
the bridge as **one guarded round trip** — the worker runs the read gate (ADR-0041) and the lazy-group
guard (ADR-0021), executes, and returns the raw rows — and Drizzle's own result mapping (relational/nested
included) runs back on the tab, so a one-shot read returns exactly what its in-process twin would.
`ensureSynced` is proxied too (activation is engine-wide but additive and idempotent — nothing like
`desync`'s blast radius below). Two deliberate mode differences: a bare awaited
`client.drizzle.select()…` — the in-process **unguarded escape hatch** (ADR-0021) — is _also_ guarded
here, since every bridge read routes through the guarded seam (attach is strictly more protected, never
less); and `client.drizzle.transaction()` throws — a read transaction needs a local store the tab does not
have.

What remains unproxied is structural, not a slice gap: `pglite` (the tab holds no local store),
`dropReadCache` (an engine-wide cache rebuild), and `isSynced` (a **synchronous** activation-started peek — it cannot be an RPC, and the tab's
cached per-group state is catch-up readiness, which reads an activated-but-still-catching-up lazy group as
not-ready, the very case `isSynced` distinguishes; use `groupReady` for catch-up and `ensureSynced` to
activate).

`destroy()` **is** proxied under a supervisor that survives engine shutdown. It refuses with
`StoreDestroyRefusedError` while another tab is attached and refuses while journal mutations are owed
unless you pass `{ force: true }`. On success it closes the engine, records a resumable `deleting` phase,
deletes the commitment and both possible backend stores, and removes the phase record. A crash resumes the
same lifecycle on the next boot; a successful SW-direct destroy ends that SharedWorker lifetime so a later
attach cannot inherit a closed host.

An existing IndexedDB store is never silently overwritten by a newly capable OPFS home. Automatic
idb→OPFS adoption is off unless the worker entry declares `adoption: "server-reconstructible"`; that
declaration authorizes deletion of local-only predecessor state only after the journal is drained, online
reconstruction completes, and a strict commitment barrier returns. `adoptStore()` runs the same transition
manually as a creation-path operation: call it instead of opening a client, and handle `StoreInUseError` if
the store is already open. A restored backup is authoritative and is never treated as an adoption
candidate.

The lazy-relation lifecycle methods **are** proxied — but read the multi-tab semantics before you call
`desync`. The engine is **shared**, so a `desync(tableKey)` issued from one tab tears the consistency group
down for **every** attached tab: that is inherent to `desync`'s group-wide revert, and under a shared
engine "the group" is engine-wide. When the group is an **ephemeral** delivery window, reach for
`client.discardEphemeral(tableKey)` instead — the scoped, **multi-tab-safe** finalize. It drops that
ephemeral relation's local rows and reverts it to dormant, refuses a group with any persistent member
(naming the offender), and is safe under a shared engine because an ephemeral window is
per-delivery-session and inherently single-consumer: nothing durable, and no other tab, depends on it. The
local drop is lifecycle-only — post-finalize non-redelivery is the server gate's guarantee (e.g. a consumed
server-owned cursor), not this method's.

Boot observability crosses too (ADR-0034). `attachSyncClient` takes the `onBootReport` option — fired once
with the worker engine's finalized `BootReport`, but **only if this tab is attached when the boot
finalizes** (the one-shot broadcast). Every attached client also exposes `client.bootReport()`, which
**pulls** the engine's most recent completed report over the bridge. Pull is the primitive because a tab
that attaches **after** the boot never receives the push: it reads the boot it never witnessed via
`bootReport()`, which returns the engine's stored report regardless of when the tab attached.

The one exception is the **inspection read surface** — `client.rawQuery(sql, params)` and
`client.rawExec(sql)` — which _is_ proxied: the statement is executed in the worker (where PGlite lives)
and the `Results` cross back. It is identical to the in-process client, and it is for **inspection only**
(debug pages, REPLs, ad-hoc counts): statements run raw against the local store, bypassing the mutation
journal and optimistic overlay, and any write stays local and never converges — for app data reads use the
live-rows hooks. `client.pglite` itself stays unavailable. `replAdapter(client)` shapes this surface into
the `{ query, exec }` duck `@electric-sql/pglite-repl`'s `<Repl>` expects, so a SQL REPL works unchanged in
worker mode (each statement routed through the bridge).

Everything the engine emits crosses on **one broadcast event channel**: status, per-group readiness,
conflict, quarantine, reject, schema-change, and the debug rail — re-exposed by `attachSyncClient` as the
same `onStatusChange`/`onConflict`/… callbacks the in-process client takes. The bridge serializes through
a `BridgeCodec` seam; the shipped default is the v1 `identityCodec`, and a columnar/transferable codec is
a documented future swap (a non-goal today).

### Live queries cross as diffs, not resends

Live-query results cross the bridge **diff-shaped** — `{order, added, changed, removed}` — computed in the
worker with PGlite's `live.incrementalQuery` for single-PK queries (a keyless query falls back to
remove-all + add-all, never a silent full resend). The tab-side materializer **preserves row identity**:
an unchanged row keeps the same object reference (`===`), so a memoized React row skips re-rendering even
though the update crossed a thread boundary.

## Boot stages: `localReadReady` → `writeReady` → `ready`

The client exposes the boot as monotonic, idempotent stage promises, each of which a late attach resolves off
its `attach-ack` fold (the engine crosses each stage once; every tab observes the same sequence):

- **`localReadReady`** — the store is open and its schema is compatible; **cached reads are safe, with zero
  network**. `attachSyncClient` resolves here. Offline boots resolve this stage and stop.
- **`writeReady`** — the write runtime + boot recovery have completed; enqueue is safe. Write methods await it
  internally, so you never gate writes yourself.
- **`ready`** — **every eager group is caught up** (a fully-consistent whole-sync paint). Unchanged: `auth-needed`
  and `degraded` do **not** resolve it, and a tab attaching **after** the engine first became ready gets an
  immediately-resolved `ready`.

In worker mode `writeReady`/`bootSettled` cross in the engine's background tail after the ack, announced to
attached tabs as one-shot **milestone** messages (and folded into a late attach's ack); a tail failure crosses
as a **milestone-error** so the matching stage rejects rather than hanging. Worker mode additionally exposes
**per-group readiness** so an app can drive progressive paint: `await client.groupReady(tableKey)` for one
group, or read `status.groups` for the whole set. See
[Initial catch-up and the alignment trade](/start/operating-in-production/) for how a group reaches its floor.

## The spare store is a pre-spawned worker

The boot optimizations from [Operating in production](/start/operating-in-production/) translate directly,
and the prefetch overlap becomes **internal** to the worker:

- The userId→storeId registry stays **tab-side** in `localStorage` — binding resolves _before_ attach,
  which the SharedWorker naming needs anyway.
- The **spare store** becomes a pre-spawned **schemaless worker** at login-screen mount: create + initdb
  run inside it, off every thread that matters. Claiming it = bind the id, attach, push config + token.
- On the claim, the tab sets the `freshStore` hint (`attachSyncClient({ freshStore: true })`) **only** when
  it knows the store is a claimed schemaless spare — never for a mapped or returning store. The worker then
  overlaps the **shape catch-up** with its local boot phases: shape streams start (memory-buffered inbox)
  the moment config + token arrive, in parallel with schema apply / journal recovery / store-version
  reconcile, and the buffered commits are gated on `dbReady` and drained in one train to the
  [ADR-0031](/start/operating-in-production/) catch-up floor. Boot for a far-from-database user is then
  bounded by `max(create+schema, catch-up)` instead of their sum. The same seam works in in-process mode.

The boot rail stamps this sequence: `boot spare store ensured`, `boot mapped store prewarm`,
`boot store claimed`, `boot shape prefetch start`, and `boot commits opened`.

### Pre-opening a warm store, not just a fresh spare

`provisionSyncWorker({ worker, storePath })` is the pre-open primitive
behind that spare — it runs PGlite
`create`/initdb inside the worker and holds the raw store idle for the first `attachSyncClient` to adopt —
but it is **not only for fresh spares**. Adoption is keyed purely on the **storePath**, not on whether the
store has ever been written: a **returning** user whose IndexedDB is already populated adopts a pre-opened
store exactly as a first-time user does. So call `provisionSyncWorker` the moment the store identity is
known — at login-screen mount for a returning user, say — to overlap the WASM/PGlite open with auth and UI
startup on that **warm persisted store**. (You still omit the `freshStore` hint for a returning store: that
hint governs the shape-catch-up overlap above, not the pre-open, and is only ever true for a claimed
schemaless spare.)

Adoption is **exact-match**: the boot claims the pre-opened engine only when the `attachSyncClient`
`storePath` equals the provisioned one. A mismatch is not an error — the attach falls back to a fresh
create and the pre-open is simply discarded, so a wrong guess is wasted work, never a crossed or corrupted
store. That safety is also the technique's limit. Pre-opening **overlaps** the open; it does not remove it,
and it cannot start before you know which store to open. Do not manufacture an identity early by parsing
another library's private storage — an auth provider's `localStorage` layout, for instance — to pre-open
sooner. Resolve the store id from your own userId→storeId registry (the same tab-side binding the attach
uses) and provision only once it is genuinely known.

Pass the same `worker` factory as attach. On Chromium/Firefox, provisioning participates in the same
election coordinator; the elected engine is auto-derived from the SharedWorker's own script URL just as
in attach (supply `createEngineWorker` only for non-module/underivable entries). On Safari the engine
runs in the SharedWorker directly and the `worker` factory remains the communication-centre recovery seam.

The overlap is measurable: an adopted store reports its pre-open in the `BootReport` `provision` block —
`provision.initdbMs` is the create cost that ran off-thread before this boot, and
`provision.provisionedMsBeforeBoot` is how long the store sat ready before the attach claimed it. See
[The structured BootReport](/start/operating-in-production/#the-structured-bootreport-measure-before-you-optimize).

## Debugging a worker: the forwarded rail

A `SharedWorker`'s own `console` is invisible to the page — you can only see it under `chrome://inspect`.
So the worker **forwards** its debug rail to every attached tab over the event channel, stamped with the
**worker's** monotonic clock and origin-tagged: each tab re-prints the lines as `[pgxsinkit·w <ms>ms] …`,
gated by that tab's own `globalThis.__pgxsinkitDebug`. Without the forwarding the entire operability story
goes dark; with it, the full write/read/boot rail from
[Operating in production](/start/operating-in-production/) reads the same in worker mode, just origin-tagged.

The front half of boot (provision, schema exec) runs on the **first** attach, before any debug-enabled tab
is listening — so those opening rail lines used to vanish. `defineSyncWorker` now buffers pre-attach lines
in a bounded ring (last 500, worker-clock stamped) and replays them, `[replay]`-marked, to the first
attaching tab (ADR-0034). The back half already streams live over the bridge, so together the whole boot —
its front half included — reaches the first attached tab.

The same invisibility applies to **network traffic**: the worker owns every shape request and token
refresh, and browsers do not show a `SharedWorker`'s requests in the page's Network panel. If the rail
shows `shape request start` lines but the tab's Network panel shows nothing, that is worker mode working
as designed — not "no network calls". Open the worker's **own** DevTools (`chrome://inspect/#workers` →
the store-named worker → inspect): its Network and Console panels carry the real requests, status codes,
and any unforwarded errors (a CORS rejection, for example, is only visible there).
