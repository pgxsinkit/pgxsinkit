# Restore boots online when the recovered journal is clean

Status: accepted (2026-07-17). Refines ADR-0035 decision 6.

ADR-0035 decision 6 forces EVERY restore boot offline (`syncEnabled = restoreBoot ? false : …`), with a
sound rationale: the app must review the journal recovered from a backup before anything flushes, because
the write path has no `mutationId` dedupe ledger — a replayed write silently reverts newer values on a
last-write-wins table and a replayed create collides on its primary key. The decision text promised "a
subsequent NORMAL boot brings sync online." In worker mode (`defineSyncWorker`, ADR-0032) nothing ever
performs that subsequent boot: a SharedWorker that restored a backup stays offline — and silently stale —
for its entire lifetime. The production trigger is a **server-generated bootstrap artifact**: a backup
built server-side with a **guaranteed-empty journal**, restored to seed a fresh client. It has nothing to
review, yet it restores to a client that reports `ready` and never syncs.

The protective rule was designed for a backup carrying UNFLUSHED writes. When the recovered journal is
empty, there is nothing to protect against, and the always-offline blanket is pure downside.

## Decision

1. **A restore boot comes ONLINE iff journal recovery found NOTHING to quarantine.** Journal
   recovery/quarantine already runs during boot BEFORE any shape stream starts (staged boot, ADR-0041),
   and a restore never takes the overlap-prefetch path (it is never a fresh spare store), so the
   sync-enable decision is safely DEFERRED until after recovery. After the restore quarantine pass parks
   every recovered non-terminal write (`pending`/`sending`/`failed`) as `quarantined`, a zero quarantined
   count means the backup's journal was clean — and sync starts exactly as a normal boot would (streams,
   flush, convergence), honouring `syncEnabled`/`autoSync`. A non-zero count keeps the boot OFFLINE
   (today's behaviour): the app inspects `diagnostics()`, releases/discards the quarantined rows, then a
   subsequent normal boot brings sync online.

2. **An explicit `syncEnabled: false` is always honoured.** The clean-journal online path resolves to
   `options.syncEnabled ?? true`, so a caller that deliberately booted a restore offline stays offline.
   The offline branch's existing debug-rail warning is extended to name WHY it stayed offline (the
   quarantined-mutation count; a subsequent normal boot brings sync online).

3. **The resulting mode is the actual mode.** `status.phase` and the boot report reflect the real
   outcome — a clean restore that came online runs the sequential sync-start path and reports its groups
   like any online boot; a dirty restore finalizes at `ready` with no streams, as before.

4. **`defineSyncWorker` needs no change** — it delegates to `createSyncClient`, so the worker host inherits
   the refined behaviour, which is precisely where the always-offline blanket did its silent damage.

## Alternatives considered

- **Keep always-offline and make the worker auto-reboot.** Preserve ADR-0035's blanket and have
  `defineSyncWorker` perform the promised "subsequent normal boot" itself after a restore. This pays a
  full second boot cycle on EVERY restore — including the common fresh-login-from-a-server-artifact case,
  which is guaranteed clean — to serve the rare dirty-journal case that the engine can already detect for
  free. Rejected: a double boot on every restore to avoid a one-line clean-journal check.

- **An explicit `restoreOnline` boot option.** Let the caller opt a restore into online mode. But the
  caller would have to KNOW the artifact's journal is clean, and the engine already knows (it runs the
  quarantine pass and can count what it moved). Pushing that knowledge to the caller invites a wrong
  answer — an online flag on a dirty backup re-opens the exact unsafe-replay hole ADR-0035 closed.
  Rejected: the engine is the authority on whether the journal is clean, so the engine decides.

## Consequences

- The protective invariant keeps protecting exactly the case it was designed for — a recovered journal
  with unflushed writes still boots offline and quarantined — and the empty-journal case (server-built
  artifacts, the production trigger) syncs immediately, in worker mode and in-process alike.
- The signal is threaded minimally: the boot reads the post-quarantine `quarantinedCount` (already
  computed by the runtime) at the existing restore recovery point; no boot restructuring, no new option,
  no change to `defineSyncWorker`.
- ADR-0035 decision 6's text stays immutable (its "always offline" clause is now read through this
  refinement); the `restoreFrom` option doc and the worker-mode doc are updated to describe the split.
- Coverage: `tests/unit/client-restore.test.ts` splits the offline assertions — a dirty-journal restore
  stays offline (dead URLs prove no fetch) and quarantined, while a clean-journal restore boots online (a
  shape stream fetches against the dead URLs — the inverse signal) unless `syncEnabled: false` was passed;
  `tests/integration/restore-resume.integration.test.ts` reproduces the production failure end-to-end
  against real Electric+Postgres (export from client A, a post-export server UPDATE, restore into client B,
  assert B converges to the new value).
