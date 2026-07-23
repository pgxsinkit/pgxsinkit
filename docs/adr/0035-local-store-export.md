# Local store export: store backup, diagnostic dump, and data export

Status: accepted (2026-07-10)

The client has never been able to get its data *out*. In worker mode (ADR-0032) that is not an
inconvenience but a wall: `client.pglite` is deliberately a throwing proxy, so no application code can
reach the store at all. Three real consumers need an exit door: **device backup/migration** (carry the
whole local store to a new device, losslessly, unflushed writes included), **support diagnostics**
(a human-readable dump of everything — overlays, journal, sync metadata — exactly as the misbehaving
store holds it), and **data portability** (the synced data as plain SQL, loadable into a vanilla
Postgres, free of pgxsinkit machinery). A fourth consumer that looks adjacent — the GDPR
"give me all my personal data" request — is explicitly **not** served by any client-side export
(the local store is simultaneously too small: per-device, row-filtered, projection-transformed; and
too large: it holds other users' rows the requester may see but not receive) and is parked as the
server-side, registry-annotated capability in `docs/backlog/0004-registry-driven-data-subject-export.md`.

PGlite offers two mechanisms with very different temperaments. `dumpDataDir` produces a tarball of
the datadir, is callable on a live instance, and restores only into PGlite (`loadDataDir`). `pgDump`
(`@electric-sql/pglite-tools`) runs a WASM `pg_dump` **on the instance's single connection** and
executes `DEALLOCATE ALL` behind itself — which breaks every prepared statement, including the `live`
extension's machinery the engine and every subscribed tab depend on. Its documented caveats end
there, but its *undocumented* post-dump instance health is exactly the kind of foundation this
toolkit refuses to build on.

## Decision

1. **Three purpose-named exports, not one options-bag.** On `SyncClient` and `AttachedSyncClient`
   (three new bridge RPC ops; the dump crosses as a transferred `ArrayBuffer`, rebuilt as a `File`
   tab-side):

   | Term | Method | Mechanism | Artefact |
   | --- | --- | --- | --- |
   | Store backup | `exportStore(opts?)` | `dumpDataDir`, live | whole-store tarball, PGlite-restorable, full fidelity |
   | Diagnostic dump | `exportDiagnostics(opts?)` | `pgDump` | SQL of everything: synced + overlay + journal + views/triggers/functions + `pgxsinkit` schema |
   | Data export | `exportData(opts?)` | `pgDump -t` per synced table | synced tables + their enum types, schema + data, nothing else |

   Every export resolves to `{ file, report }` — an `ExportReport` carrying phase timings
   (suspend/dump/resume), the `MutationDiagnostics` snapshot, and the applied scope, extending the
   ADR-0034 observability rule to exports. Because `pg_dump -t` will not emit the enum types the
   tables depend on (and the `--exclude-*` inverse cannot exclude the reconcile functions), the data
   export is `generated enum DDL header + pg_dump -t` concatenated — the client already owns enum
   DDL generation, so the artefact stays self-contained without flag gymnastics.

2. **`exportStore` dumps live; `pgDump` variants run on a suspend → bare handle → resume seam.**
   A store backup is a `CHECKPOINT` followed by `dumpDataDir` through the engine's normal execution
   serialisation — no lifecycle event, no tab disruption. The two `pgDump` exports instead: (a)
   suspend the engine via the existing `stop()` ordering (convergence driver → shape streams →
   `pglite.close()`); (b) open a **bare** PGlite on the same dataDir — no engine, no `live`
   extension, nothing pg_dump can corrupt; (c) dump; (d) close the bare handle and resume via the
   normal boot path — shape streams recover from `pgxsinkit.subscriptions_metadata`, and the worker
   host replays its `liveSubs` registrations against the new instance so tabs never re-subscribe.
   Post-dump instance health becomes a non-question: the instance pg_dump touched is discarded by
   construction. During the blackout (roughly one boot cycle) bridge RPCs queue against a deadline
   rather than error, a new `suspended` status phase (with reason) is broadcast so every tab can
   render the pause, and the offline toggle survives the resume (host state, not rebuilt).

3. **Guards are per-consumer, and "flushed" means drained, not merely not-owed.** Store backups and
   diagnostic dumps never block: the journal travels *inside* the artefact, which is respectively
   the point (lossless backup) and the evidence (diagnostics). The data export is the one variant
   that silently loses unflushed writes — including `acked` writes whose synced echo has not landed
   (they exist only in the overlay, and the existing `destroy()` "owed" predicate does not count
   them). So `exportData` requires a **drained journal**: if rows are present it actively flushes
   and awaits the convergence barrier, bounded by `drainJournal: { timeoutMs }` (default on).
   Non-drainable states — `failed`, `quarantined`, `conflicted` — fail fast with the diagnostics
   snapshot rather than waiting out a timeout that cannot succeed. `drainJournal: false` is the
   explicit escape hatch exporting synced state as-is. An offline device with a clean journal
   exports strictly and instantly; an offline device with a dirty journal cannot produce a strict
   data export (its lossless option is the store backup).

4. **One lifecycle slot.** Exports, `destroy()`, and `discardEphemeral()` serialise through a single
   host-side slot; a second export while one runs rejects with a typed `busy` error (a fresh
   artefact is better served by retrying than by queueing back-to-back blackouts). Any tab may
   trigger an export; exports await engine-ready rather than rejecting during boot.

5. **Ephemeral clusters are never exported — by construction, not by filter.** Ephemeral retention
   is implemented as `pg_temp` TEMP objects (ADR-0021): pg_dump ignores temp objects, and the bare
   reopen sheds the previous session's temp state before either `pgDump` variant runs. A store
   backup may carry orphaned temp-relation bytes in the tarball (harmless after `loadDataDir` —
   session-scoped — but measured by an implementation probe for bloat).

6. **Restore is "boot on a restored datadir", always offline, journal quarantined.** A
   `restoreFrom: File | Blob` boot option on `createSyncClient` (in worker mode, carried on the one
   first-attach handshake that reaches the ENGINE HOME — the attach awaits the ADR-0049 placement
   reply and rides the SW port when the in-scope host is the engine, or the first per-tab pipe
   handshake when the engine is elected; the router-only SharedWorker is payload-blind, so a restore
   posted there would be dropped and its transferred buffer destroyed) passes the tarball to
   PGlite's `loadDataDir` — **only into a dataDir that does
   not yet exist**; overlaying an existing store is refused (that path is a deliberate manual
   `destroy()` first). Sync correctness then rides machinery that already exists: fingerprint check,
   persisted subscriptions, expired-handle refetch, watermark alignment (ADR-0031). Two restore-only
   rules: the engine boots **offline regardless of the toggle state captured in the backup**, and
   all non-terminal journal rows recovered from a backup (`pending`/`sending`/`failed`) are moved to
   `quarantined` — nothing recovered from a backup ever auto-flushes. This is not caution but
   verified necessity: the write path keeps `mutationId` in `operations_log` yet never consults it —
   there is no dedupe ledger. A replayed mutation is naturally rejected on `reject-if-stale` tables
   (its base Server version is stale), but on `last-write-wins` tables it would silently re-apply
   old values over newer writes, and a replayed create collides on its primary key. The app inspects
   `diagnostics()`, releases or discards the quarantined rows, then goes online.

7. **`@electric-sql/pglite-tools` is a lazy regular dependency.** A normal dependency of
   `@pgxsinkit/client`, loaded via dynamic `import()` inside the export ops so the ~700 kB
   `pg_dump.wasm` (plus ~100 kB JS) is fetched only on first `exportDiagnostics`/`exportData` — in
   the worker, in worker mode. `exportStore` needs no dependency at all. pglite-tools pins its
   PGlite peer **exactly** (0.4.4 → `@electric-sql/pglite@0.5.4`, precisely our pin), so every
   future PGlite bump moves pglite-tools in lockstep, enforced by an integration test rather than
   trust.

## Alternatives considered

- **Quiesce-in-place around pgDump** (pause streams and convergence, dump on the engine's own
  instance, resume). Faster — no reboot — but requires inventing pause/resume machinery that does
  not exist (`engine.close()` is the only stop today) *and* trusting the undocumented post-`DEALLOCATE
  ALL` health of the shared connection. The suspend/bare/resume seam reuses two battle-tested paths
  (`stop()`, boot) and removes the trust question entirely; the blackout cost is one boot cycle on a
  warm store.
- **One `export(opts)` method.** The three consumers differ in mechanism, guard, and artefact
  contract; a discriminated options bag would reunite what Q1 established are different operations
  and blur which guard applies where.
- **`--exclude-table`/`-N` flag composition for the data export.** Cannot exclude the reconcile
  functions (pg_dump has no function excludes), and dumping the read-model views' *rows* is not a
  pg_dump capability at all. The `-t` allowlist plus a generated enum header is exact.
- **Optional peer dependency for pglite-tools.** Punishes the common case with install ceremony to
  save non-exporting apps lockfile bytes they would not notice; the lazy import already keeps the
  WASM off their wire.
- **Queueing concurrent exports.** Back-to-back suspend cycles double the blackout to hand the
  second caller an artefact it could get fresher by retrying; typed `busy` is honest.
- **Auto-flushing (or auto-requeueing) restored journal rows.** Verified unsafe without a server-side
  dedupe ledger (silent LWW reverts, create PK collisions); building dedupe into the write path is a
  larger contract change than this lane justifies while quarantine + explicit release covers the
  need.

## Consequences

- A genuinely new **engine lifecycle seam** (suspend → run against a bare handle → resume) lands in
  both `createSyncClient` and the worker host, plus three RPC ops and a `suspended` status phase —
  the bridge gains its first lifecycle vocabulary. The spare `provisioned` slot is untouched by the
  seam (it holds the only handle on *its* store and must never be closed by an export on another).
- Failure paths are part of the contract: a throwing pgDump still resumes (resume runs in the
  finally path); a failed bare reopen or failed resume surfaces as a boot-class error; a worker
  killed mid-suspend recovers on next attach via the normal boot path, because suspension closes the
  store cleanly before anything else happens.
- The test matrix is the spec: {in-process, SharedWorker multi-tab, dedicated worker} ×
  {exportStore, exportDiagnostics, exportData, restore} × journal states (empty / pending / sending /
  acked-unechoed / failed / quarantined / conflicted) × {online, offline}, plus the concurrency
  lanes (export-vs-export, export-during-boot, export vs pessimistic-unit foreground flush, export
  vs `dropReadCache`/`destroy`/`discardEphemeral`, provisioned-slot present) and restore lanes
  (fresh dataDir, existing-dataDir refusal, offline boot, quarantine, catch-up on go-online,
  corrupt/foreign tarball). Implementation probes, not design blockers: temp-file bytes in a live
  tarball; live-dump → `loadDataDir` integrity under sync activity; synced-table vs read-model-view
  naming overlap when building `-t` patterns; bare-instance pgDump sanity.
- The GDPR/data-subject export stays out of the client permanently; its future home is the server,
  keyed by data subject, enumerated by the registry (backlog 0004).

## Addendum (2026-07-10): decision 2's mechanism superseded — the throwaway clone

Implementation-time probing (same day, before slice 2 was built) killed the suspend → bare-reopen →
resume seam and replaced it with something strictly better. The pgDump variants now run as:

1. take a **live store backup** (decision 2's `CHECKPOINT` + `dumpDataDir` — the slice-1 machinery,
   no engine suspension);
2. boot a **throwaway** bare PGlite from that tarball via `loadDataDir` — memory-backed, engine-less,
   no `live` extension, nothing pg_dump can corrupt;
3. run `pgDump` (with the `-t` allowlist for a data export) against the throwaway;
4. discard the throwaway.

Why the seam lost, on evidence:

- **Bare-reopen assumed a persistent dataDir.** A memory-backed store dies with its instance —
  "reopen the same dataDir bare" reopens an *empty* database. Memory-backed stores are not a product
  configuration (ADR-0036 now forbids them unintentionally), but the entire unit-test lane runs on
  them, so the seam's own tests could never have exercised it honestly.
- **In-process mode has a dangling-reference problem the seam cannot solve.** `client.pglite` is
  public API and in-process consumers hold it (plus repl adapters, Drizzle executors, live-query
  handles). Suspend/resume replaces the instance under every reference the app already holds; fixing
  that means a permanent indirection proxy — machinery the throwaway clone simply never needs,
  because the live instance is never closed.
- **The clone deletes the seam's whole failure surface**: no re-runnable boot refactor, no bridge
  lifecycle vocabulary, no RPC queueing against a deadline, no `suspended` status phase, no
  `liveSubs` replay, no worker-killed-mid-suspend recovery lane. Tabs never notice an export beyond
  the lifecycle slot reporting busy.

The consistency guarantee is unchanged (the artefact reflects the checkpointed dump moment — exactly
what the bare reopen would have seen). The accepted trade-off: a transient memory cost, tarball plus
throwaway instance co-resident with the live engine for the export's duration.

What survives untouched: decision 1 (the three exports and their artefact contracts), decision 3
(the drain guard), decision 4 (the lifecycle slot — still the single serialisation point, minus the
now-deleted "blackout" framing), decisions 5–7, and the restore design. The consequences section's
suspend-specific lanes (RPC queueing, `suspended` phase, mid-suspend crash recovery) are void; the
matrix keeps every journal/concurrency/restore lane and swaps the suspend lanes for one
clone-fidelity lane (backup → throwaway → pg_dump equals the live store's synced content).

Mechanism note: the throwaway must be booted from a **scheme-selected** memory store, never PGlite's
explicit `fs: new MemoryFS()` option — on PGlite 0.5.4 `dumpDataDir` from an explicit-`fs` instance
silently omits relation files created after initdb (probed: `/base/5/<oid>` missing even after
`CHECKPOINT`, restore raises `relation does not exist`; upstream report drafted in `tmp/agents/`).
The clone direction (loadDataDir *into* a memory store) is unaffected either way.
