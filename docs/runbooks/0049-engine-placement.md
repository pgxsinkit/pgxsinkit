# Runbook: engine placement, storage backend, and the 0049 consumer surface

Consumer-facing companion to [ADR-0049](../adr/0049-capability-driven-engine-placement.md)
(capability-driven engine placement). ADR-0049 makes `opfs-repacked` the primary browser store on
every platform and turns the engine's home into a runtime capability decision. `opfs-repacked` is
the default browser store; where the engine runs is the toolkit's runtime decision, never a consumer
knob. This runbook is the map of the storage declaration, the diagnostics, and the recovery seams,
and why each exists.

## When to use

- You want the safer `opfs-repacked` storage (incremental extent writes under a poison contract)
  instead of `idbfs` (detached whole-FS snapshots), and want to know how placement is decided.
- You are wiring a `SharedWorker`-hosted engine and need SharedWorker-death recovery, so you must
  pass the `SharedWorker` as a factory (`worker: () => SharedWorker`).
- You need to force `idbfs` for a store, or opt into `strict` durability — both are registry
  `storage` declarations.
- You want to read the `storageBackend` / `engineHome` boot diagnostics.
- You need `destroy()`, the opt-in execution limit, or automatic idb→opfs adoption — each has a
  gate you must understand before enabling.

## How placement is decided

There is no consumer-facing placement mode. The `SharedWorker` is **always** the attach point, and at
startup it runs an **unconditional placement probe** — a real `createSyncAccessHandle` open on
scratch, never method-presence — to decide its **engine home** once per SharedWorker lifetime. The
only storage knob is the registry declaration:

```ts
// contracts: SyncRegistryDefinition.storage
storage: {
  backend: "opfs",     // default — the capability machinery below is the normal boot everywhere
  durability: "relaxed", // default — see ADR-0047; "strict" is the one opt-in
}
```

`backend: "opfs"` (the default) runs the probe on every platform. `backend: "idbfs"` is the one way
to opt out: no probe runs, no election exists, and the engine boots in the SharedWorker on the idbfs
backend. The declaration lives with the DATA contract because forcing idbfs is a storage decision,
not a placement or wiring one.

Under the default `backend: "opfs"` the probe decides the home:

- **`shared-worker` (SW-direct):** handles granted in SharedWorker scope (WebKit today). The engine
  boots in the SharedWorker itself; the election machinery never engages.
- **`elected-worker`:** handles denied in SharedWorker scope (Chromium, Firefox). The SharedWorker
  is router-only; the engine boots in a tab-spawned **dedicated worker** that holds the handles. One
  tab is elected leader via Web Locks and spawns that worker.
- **`in-process`:** no SharedWorker at all — the main-thread `idbfs` client (a main thread can never
  hold sync-access handles). Node stays `file://`.

You do not choose the home; the probe does. If a platform later exposes handles in SharedWorker
scope, its placement collapses to the simpler SW-direct form automatically.

**Capability absence falls back; wiring failure errors.** Under `backend: "opfs"`, when the platform
cannot provide OPFS sync access in ANY home (the OPFS API absent or throwing in both the SharedWorker
and a dedicated worker, or every home's probe denied for permission/quota), the toolkit falls back
automatically to the in-SharedWorker `idbfs` engine — with the DECLARED durability unchanged. That
fallback is observable, never silent: the `BootReport` carries `storageBackend: "idbfs"` plus a
`storageFallbackReason`. A failure of WIRING is never a fallback: if election is required but the
engine worker cannot be constructed (a spawn failure, or an underivable entry URL with no
`createEngineWorker` override), attach fails with a hard typed error — the capability was present and
the configuration was wrong, and silently downgrading storage would hide the defect.

## Diagnostics: `storageBackend` and `engineHome`

The `BootReport` (ADR-0034) gains three additive fields (`reportVersion` stays `1`). Read them via
the `bootReport()` pull or the `onBootReport` push:

```ts
const client = await createSyncClient({/* … */});
const report = await client.bootReport();
report?.storageBackend; // "opfs-repacked" | "idbfs" | "filesystem" | "memory" | (omitted for a BYO instance)
report?.engineHome; // "in-process" | "shared-worker" | "elected-worker" | (omitted when underivable)
report?.storageFallbackReason; // present ONLY when an opfs-capable boot opened idb (see below)
```

- **`storageBackend`** is derived from the dataDir scheme at the single store-mint seam. It is
  _omitted_ for a bring-your-own PGlite instance whose backend the toolkit did not mint (it never
  guesses).
- **`engineHome`** is `"in-process"` for the main-thread/Bun client, `"shared-worker"` for SW-direct,
  and `"elected-worker"` for the dedicated elected engine. Both browser worker homes run their real
  capability probe; only a plain test/Node scope with no browser placement omits it.
- **`storageFallbackReason`** is the verbatim reason an opfs-_capable_ boot (the probe granted
  handles) nonetheless opened `idbfs`. It is set **only** when such a fallback actually happened —
  never on a plain idb boot, never on a granted boot that stayed on opfs. The set-sites are the
  two granted-then-idb transitions: a **declared adoption that deferred/failed** (idb stays
  authoritative) and the **recordless idb-store downgrade** (invariant 14 — an existing idb store is
  opened in place, never overwritten by a fresh opfs mint). A dashboard can alert on its presence.

## Worker construction: the SharedWorker factory and the engine override

Worker construction is **toolkit-owned**. The attach input carries the SharedWorker as a **factory**,
and the elected engine worker is constructed by the toolkit itself — you do not normally wire it.

- **`worker: () => SharedWorker`** — the attach input for a `SharedWorker`-hosted engine. It is a
  FACTORY, not an instance, because a `SharedWorker` object cannot be reconstructed from itself, and
  the factory is what makes SharedWorker-death recovery a **guarantee** rather than a best-effort:
  when the lock-holder's keepalive trips, it reconstructs the SharedWorker via this factory,
  re-attaches, and re-announces its still-live engine. A bare instance or port-shaped transport is
  accepted for tests and exotic hosts, where reconstruction is structurally impossible and
  diagnostics say so.
- **The elected engine worker needs no consumer wiring.** The worker entry is dual-scope (one file
  serves both homes), the SharedWorker reports its own script URL (`self.location.href`) in the
  placement reply, and the winning tab constructs the engine as
  `new Worker(reportedUrl, { type: "module" })`. Auto-derivation assumes a **module** worker — the
  only shape the published ESM entry supports.
- **`createEngineWorker` is an override only.** Supply it for entries that cannot be reconstructed
  from their URL as a module worker: classic-script workers, `blob:`/`data:` URLs, or CSP
  constraints. With no override AND no derivable URL, attach fails with a **typed error** — never a
  silent no-engine attach (see "Capability absence falls back; wiring failure errors" above).

Wire the SharedWorker factory wherever you construct the attach client, e.g.:

```ts
attachSyncClient({
  // … registry, urls …
  worker: () =>
    new SharedWorker(new URL("./router.worker.ts", import.meta.url), {
      type: "module",
      name: "pgxsinkit",
      extendedLifetime: true,
    } as WorkerOptions & { name: string; extendedLifetime: boolean }),
  // createEngineWorker is only needed for non-module / underivable engine entries:
  // createEngineWorker: () =>
  //   wrapEngineWorker(new Worker(engineBlobUrl)),
});
```

### `extendedLifetime: true` on every `SharedWorker` construction

Pass `extendedLifetime: true` in the `SharedWorker` constructor options (plan step 14). Chromium
keeps the SharedWorker alive for a grace period after its last client unloads, which lets a pending
relaxed idbfs detached flush LAND when the last tab closes right after a write — a direct narrowing
of the relaxed loss window wherever the engine lives in the SharedWorker (the registry-forced-idbfs
in-SW engine, the 0049 idb-fallback path, and WebKit SW-direct if WebKit ships the option). It also
gives a free warm-start for a tab opened within the grace window (same SharedWorker instance — the
good case for engine identity). It has **no effect on the 0049 Chromium opfs path** (the elected
engine dies with its tab regardless; the strict barrier and the ADR-0048 crash model protect that
path).

Support floor (verified against MDN browser-compat-data, 2026-07-21): **Chromium 148+**
(Chrome/Edge 148). Firefox and Safari do **not** implement it and safely **ignore** the unknown
dictionary member, so the option is unconditionally safe to always pass — do not feature-check it in
code.

## Execution limit (opt-in, disabled by default)

The execution limit is ONE engine-construction value that CONVERTS a silently-hung engine from slow
to _terminated-and-respawned_. It is **disabled by default** (`undefined`): no finite worst-case
query duration exists, and the limit converts slow to terminated by policy, so enabling it must be a
deliberate consumer choice:

```ts
executionLimit: {
  maxDispatchMs: 30_000,
} // undefined (or omitted) = DISABLED
```

- **What enabling converts:** when a dispatched op runs past the limit and the engine's control
  channel then goes unanswered past the missed-ping threshold, the leader's coordinator deliberately
  terminates the suspected worker (idempotent if already dead), waits for the VFS ownership release,
  and respawns. It is a _policy_ conversion, never claimed as death evidence — a long query under the
  limit runs to completion.
- **Elected placement only.** On SW-direct (`shared-worker`) a hung in-scope engine blocks the
  router's own event loop and a SharedWorker cannot be terminated from a page, so the option is
  **rejected as unsupported** there (accepted-risk register item 2).
- **Every tab must agree.** The value is an engine-construction property; a tab attaching with a
  different value (including disabled-vs-enabled) is rejected at attach with
  `ExecutionLimitMismatchError`. Carry the same value in `defineSyncWorker` and every
  `attachSyncClient` call. A worker configured with a limit must use capability/elected placement;
  observing it on SW-direct is a construction error and attach is rejected before engine boot.

## `destroy()` (peer refusal, force)

`destroy()` on the attached facade wipes the entire local store (synced cache + overlay + journal)
and closes the handle, under the resumable destructive lifecycle (a mid-flight crash resumes the
deletion on the next boot):

```ts
await client.destroy(); // refuses if mutations are still owed to the server
await client.destroy({ force: true }); // wipe even with owed mutations (drops un-flushed writes)
```

- **Owed-mutation refusal:** without `force`, `destroy()` refuses while mutations are still owed to
  the server, so it never silently drops un-flushed writes. Pass `{ force: true }` only when you
  intend to discard them.
- **Peer refusal:** with other tabs still attached, destruction is REFUSED with a typed error —
  close the peers first (the SharedWorker alone knows the attached-tab count and answers the
  peer-count query). This is the simpler contract by design.
- **Completion is honest:** the supervisor closes the elected engine, or asks an SW-direct host to
  close and waits for its acknowledgement, before deleting storage. An acknowledgement timeout
  does not prove the SharedWorker died; deletion is attempted under a bound and any failure leaves
  `deleting` for the next boot. IDB `onblocked` is likewise nonterminal—only `onsuccess` permits the
  meta record to be removed.
- **Recreate is deterministic:** a successful SW-direct teardown explicitly closes that
  SharedWorker scope after acknowledging. A later constructor/attach therefore boots a fresh host
  even when `extendedLifetime: true` would otherwise retain the old scope.
- **IDB destruction deletes the database:** an `idb-authoritative` destroy does not retain a wiped
  shell. The next granted boot is genuinely fresh and may select opfs-repacked.

## Automatic idb→opfs adoption (declaration-gated, DEFAULT OFF)

Adoption migrates an existing `idb-authoritative` store to a committed `opfs` successor and then
**deletes the idb predecessor**. Because that deletes local data, it never happens by default. It is
a **worker-entry** option (baked into your `defineSyncWorker` file as code — a tab cannot set it):

```ts
defineSyncWorker({
  // … registry, urls …
  adoption: "server-reconstructible", // DEFAULT: undefined (off). Hook absence is never authority.
});
```

- **What the declaration means:** `"server-reconstructible"` asserts that this store's local-only
  state is safe to reconstruct from the server — the ONLY authority that lets the toolkit delete the
  idb predecessor. Absence of any hook is _not_ consent (`rawExec` can write documented local-only
  state on any store).
- **What deleting local-only data means:** adoption runs only when the drain predicate is clean
  (`pending + sending + failed + quarantined + conflicted == 0`) and the opfs successor has passed
  the authorized online reconstruction gate (the eager Consistency groups caught up) plus the strict
  commitment barrier. If any of that is unmet, nothing publishes and idb stays authoritative — you
  see a `storageFallbackReason` on the report. The one-time cost is a re-bootstrap per user.
- **Manual path (`adoptStore`):** a creation-path API (like `restoreFrom`) — call it _instead of_
  `createSyncClient`, never against a store an open client already holds (it refuses with
  `StoreInUseError`). It runs the same drain-gated transition and reports `{ adopted: true }` or
  `{ adopted: false, reason }`. Use it to migrate on demand without wiring the automatic declaration.

## Verify

- Read `client.bootReport()` after boot: confirm `storageBackend`/`engineHome` match the platform
  you expect (`opfs-repacked` + `elected-worker` on Chromium/Firefox; `opfs-repacked` +
  `shared-worker` on WebKit; `idbfs` + `in-process` on a no-SharedWorker fallback).
- Run `bun run test:browser:placement` for the serverless Chromium/Firefox/WebKit placement suite.
  Run `bun run test:integration:placement` for the Chromium server-backed lanes, or
  `bun run test:browser:placement:server` for the separate all-browser server gate. The provision
  comparison is manual: `bunx playwright test --config tests/e2e/placement/playwright.bench.config.ts`.
- Local headless Chromium evidence (2026-07-22, five paired samples): plain cold attach→first
  query median **3848.6 ms**; provisioned attach→first query median **173.0 ms**; foreground delta
  **−3675.7 ms**. Provision itself took roughly 3.5–5.3 s ahead of attach. Treat these as workstation
  evidence, not a release budget; rerun on target devices before setting thresholds.
- The server-backed adoption lane proves a drained IDB predecessor reconstructs, commits, deletes
  the predecessor, and reopens without re-adoption. Destroy/recreate, relocation outcomes,
  recordless-idb recognition, and fresh commitment have dedicated browser lanes; deterministic lifecycle
  boundaries remain covered by the unit suites in `docs/testing-strategy.md`.

## Pre-mint deletion recovery

Provision is a pure accelerator. On both granted and denied placement it performs the bounded
store-meta read before creating anything; if the phase is `deleting`, provision acknowledges the
decline without minting and the first attach runs the ordinary resumable boot path. A failed eager
precreate falls back through that same complete path. This prevents a replacement store—and its
Mutation journal—from appearing beneath deletion authority that a later boot must honor.

If a registry-forced-idbfs or handle-denied boot sees an existing `deleting` record, it does not create a new store
under that live authority. It deletes the old IDB database, removes the commitment sentinel through
asynchronous OPFS, writes `idb-authoritative`, and only then creates the replacement IDB store. A
sentinel-less OPFS directory may remain as disposable cache residue; the next candidate build removes
it before reuse. If the sentinel cannot be inspected/removed, boot remains fail-closed at `deleting`
rather than risk exposing two authorities.
