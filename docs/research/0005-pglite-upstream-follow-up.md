# PGlite upstream follow-up

Reviewed 2026-11-27 against toolkit `develop` at `74a3d8a` and PGlite main at
`3d71d1f51`. This continues `0003-recent-pglite-issues-and-prs.md`.
The review covers issues and PRs active since the October 31 review, including open proposals,
and November commits on main through November 26. The C source baseline is `b3ce91a`.
I compared the upstream patches with the shipped PG19 code and used a disposable in-memory
pgwasm database and standalone parser calls for the reproductions below. Browser persistence
and performance conclusions are based on source inspection. [Upstream main at review](https://github.com/electric-sql/pglite/commits/3d71d1f51)

## Recommended fixes, in order

1. **IndexedDB truncation.** Add the browser close/reopen regression and correct truncate timestamps.
   This affects the toolkit's browser fallback as well as explicit `idb://` users. See the storage
   evidence below. [Issue 1233](https://github.com/electric-sql/pglite/issues/1233)
2. **Reject a transaction that Postgres rolled back at COMMIT.** Reproduced locally. A callback
   inserted a row, caught a duplicate-key error (23505) and returned normally. The transaction
   promise resolved with the callback's success value. A subsequent SELECT counted zero rows.
   `packages/pgwasm/src/core/pgwasm.ts:651` awaits COMMIT and discards its command tag. Inspect
   that tag, preserve explicit rollback semantics, and cover recovery via savepoint and deferred
   constraint errors. This is independent of whether the storage layer flushed correctly.
   [Issue 1179](https://github.com/electric-sql/pglite/issues/1179) · [Merged PR 1180](https://github.com/electric-sql/pglite/pull/1180)
3. **Serialize domain parameters using the base type.** Reproduced locally through an ordinary
   bound INSERT into a domain over `bytea`. The four bytes `de ad be ef` came back from PostgreSQL
   as hex `3232322c3137332c3139302c323339`, the text `222,173,190,239`. The exact-OID lookup in
   `packages/pgwasm/src/core/pgwasm.ts:521` falls back to text. Check explicit serializer
   precedence, domains created after boot, and nested domains when adapting the fix. Existing
   rows keep their stored bytes. [Issue 1244](https://github.com/electric-sql/pglite/issues/1244) · [Open PR 1248](https://github.com/electric-sql/pglite/pull/1248)
4. **Escape identifiers and preserve literal percent signs in parameterized live SQL.** Two
   separate small fixes. The exported `identifier` helper in `packages/pgwasm/src/templating.ts:88`
   quotes the input without doubling embedded quotes. Valid names can break or select another
   identifier. Use ordinary names containing a quote as regression fixtures. Separately,
   `live/format-query.ts:43` passes existing percent signs to PostgreSQL format() when replacing
   parameters. Locally, formatting `select ($1::int % 2)` with 3 failed. LIKE patterns can be
   affected too. Keep positional parameter semantics for repeated and reordered arguments.
   [Merged PR 1199](https://github.com/electric-sql/pglite/pull/1199) · [Open PR 1195](https://github.com/electric-sql/pglite/pull/1195)
5. **Correct early years and infinite values in the default temporal codecs.** A local call to
   the timestamptz parser mapped year 0050 to 1950 and 0099 to 1999. Both infinity literals
   returned Invalid Date, while serializing numeric Infinity threw. These affect users of
   the default codecs in `packages/pgwasm/src/types.ts`. Drizzle supplies its own temporal
   parsers. Document the public representation of infinity when fixing the round trip.
   [Open PR 1074](https://github.com/electric-sql/pglite/pull/1074) · [Merged PR 1202](https://github.com/electric-sql/pglite/pull/1202)

## Performance candidates

**Implementation follow-up, November 27.** The six correctness fixes above now have local
regressions. The IndexedDB browser case reproduced 10,000 deleted rows returning after a clean
reopen on the old code. The stale relation occupied 368,640 bytes. The corrected case checks
that both measurements remain zero.

The result-parser candidate was prototyped and left out. A Bun conversion benchmark used the
PG19 instance's 326 parser keys, four result columns and the real Drizzle overrides. Across
seven alternating timed samples after warmup, median object conversion fell from 119 to 2 µs
for one row and from 254 to 168 µs for 1,000 rows with overrides. Direct calls without overrides
regressed 2.7% in object mode and 5.1% in array mode at 1,000 rows. These measure conversion
only. A future variant should isolate the Drizzle savings and recheck the direct path before
shipping.

- **Measure per-column parser resolution first.** The October fast path skips a map copy for calls
  without overrides. `core/parse.ts:28` still copies the instance map for calls with overrides,
  including ordinary Drizzle calls, and looks up a parser per cell. Compare short Drizzle queries
  and many-row reads before adopting a per-column lookup. Preserve NULLs, custom parser precedence,
  OID arguments and both row modes. [Open PR 1226](https://github.com/electric-sql/pglite/pull/1226)
- **Fragment assembly and archive restore** are secondary. We already decode text from a view,
  but `protocol/wire/parser.ts` can copy a fragmented input twice. Retain ownership guarantees
  if optimizing. Our restore already checks for existing directories, but
  `packages/pgwasm-c/src/host/data-dir.ts:36` rechecks the same parent for sibling files.
  Neither upstream speedup has been measured on pgwasm.
  [PR 1196](https://github.com/electric-sql/pglite/pull/1196) · [PR 1246](https://github.com/electric-sql/pglite/pull/1246)
- **Bulk live-query refreshes** are worth profiling if initial sync competes with interactive reads.
  Our table-change trigger also calls pg_notify and refreshes are coalesced per query. The reporter's
  improvement was on PGlite with its sync package. Any local suppression would need to refresh
  every affected query, including subscriptions created during catch-up.
  [Issue 1184](https://github.com/electric-sql/pglite/issues/1184)

## Recent upstream work already covered or outside our runtime

- Each top-level array parse already allocates fresh state in `types.ts`. A local parse after a
  throwing element parser succeeded. The mixed-case live-key fix and quoted-channel unsubscribe
  are also present. Live SQL generation still deserves a separate embedded-quote check if arbitrary
  SQL column names are supported. [PR 1245](https://github.com/electric-sql/pglite/pull/1245) · [PR 1218](https://github.com/electric-sql/pglite/pull/1218) · [PR 1093](https://github.com/electric-sql/pglite/pull/1093)
- Raw streaming callbacks are scoped to each exchange and cleared in finally. Our public interface
  has no describeQuery method or pglite-socket server. Socket port selection, COPY bridging and
  pooled socket batch interleaving concern that upstream adapter. Our host also exits the raw
  exchange loop on unexpected backend failure. [PR 1208](https://github.com/electric-sql/pglite/pull/1208) · [PR 1206](https://github.com/electric-sql/pglite/pull/1206) · [Issue 1046](https://github.com/electric-sql/pglite/issues/1046) · [PR 1081](https://github.com/electric-sql/pglite/pull/1081)
- The C PG19 ReadyForQuery error-recovery correction is in our main-loop patch 0005. Upstream's
  PG19 change removed earlier custom-memory overrides for initdb/pg_dump. Those older commits
  provide no current PG19 fix to import. [C recovery commit](https://github.com/electric-sql/postgres-pglite/commit/dcf94376d) · [PG19 PR 1225](https://github.com/electric-sql/pglite/pull/1225)

## Persistence and worker lifecycle

### High priority candidate — IndexedDB truncation persistence

Upstream issue 1233 reports deleted rows returning after DELETE, VACUUM and reopening an
`idb://` store. Merged PR 1234 marks the successfully truncated MEMFS node with current
`mtime` and `ctime`, making its changed contents eligible for IDBFS reconciliation.
[Issue 1233](https://github.com/electric-sql/pglite/issues/1233),
[PR 1234](https://github.com/electric-sql/pglite/pull/1234).

Our `packages/pgwasm-c/src/host/mounts/idb.ts:90` mounts the bundled IDBFS without that
correction. The pinned `packages/pgwasm-c/artefacts/postgres.js` contains the same mismatch.
`FS.doTruncate` passes `{size:len,timestamp:Date.now()}` to `FS.doSetAttr`, while MEMFS's
`setattr` accepts `mode`, `atime`, `mtime`, `ctime` and `size`, leaving `timestamp` unused.
IDBFS builds its reconciliation set from `stat.mtime`. A truncate can therefore change the
resident bytes without changing the timestamp that decides whether they reach IndexedDB.
The timestamp-floor wait in `IdbMount.#syncfs` addresses later writes sharing a clock
millisecond with a completed sync, and does not mark a truncate dirty.

This is a source-confirmed shared defect and a high priority fix candidate for `idb://`.
The precise upstream DELETE/VACUUM/reopen result still needs a local browser regression.
Adapt the successful-truncate timestamp update at the owned IDB mount boundary, preserving
the existing collision guard. OPFS repacked uses its own resize metadata and persistence
protocol, so this IDBFS mechanism does not establish a defect there.

### Queued sync completion — shared guard, upstream trigger blocked by our interface

Merged PR 1193 makes a caller await an already queued filesystem sync. Upstream exposes
`syncToFs()` publicly, allowing concurrent calls that resolve prematurely when a second
sync is scheduled behind a running one.
[Issue 1191](https://github.com/electric-sql/pglite/issues/1191),
[PR 1193](https://github.com/electric-sql/pglite/pull/1193).

Our `packages/pgwasm/src/core/pgwasm.ts:454` retains a similar `#persistScheduled` early
return. However, pgwasm exposes persistence through private statement handling rather than a
public concurrent `syncToFs()`. Normal queries hold the query mutex through strict persistence,
and `/protocol` sessions hold their exclusive session lock. Strict statement calls therefore
cannot enqueue the concurrent pattern shown by the upstream reproduction. Relaxed mode
deliberately returns before persistence and latches background failures. Treat this as a
guard to revisit if persistence is exposed or its locking changes. A current strict-durability
failure has not been established.

### Already handled — transaction terminal sync and worker init errors

PR 1205 adds a filesystem sync after COMMIT or ROLLBACK and forwards upstream worker protocol
options. Our `core/pgwasm.ts:644` clears `#inTransaction` before COMMIT, causing it to persist
as a terminal statement, and explicitly persists an earlier explicit rollback. Existing
`tests/unit/pgwasm-transaction-persist.test.ts` covers transaction persistence. Our worker
executes high-level operations through its own bridge, so the upstream per-message option
forwarding patch has a different transport target.
[PR 1205](https://github.com/electric-sql/pglite/pull/1205).

PR 1231 propagates a rejected worker initialization to waiting clients. Our worker already
sends a serialized failure in `attach-ack` from
`packages/client/src/worker/define-sync-worker.ts:1444`; core also rejects `waitReady` on
failed boot and suppresses a duplicate unhandled rejection. The upstream hanging-client
fix supplies no missing equivalent identified by this review.
[PR 1231](https://github.com/electric-sql/pglite/pull/1231).

### Lower priority investigation — process exit timer

Issue 1232 reports a roughly ten-second Node process exit delay after a write when the
application omits `close()`. The reporter says explicit close avoids it.
[Issue 1232](https://github.com/electric-sql/pglite/issues/1232).

Our pinned glue's `__setitimer_js` also schedules a plain `setTimeout` without `unref`.
This makes a Bun lifetime check reasonable, since Bun is a supported host. It does not
prove the reported delay occurs in pgwasm. An application retaining its open instance can
also need these timers to deliver Postgres work, so unref behavior needs an explicit runtime
lifetime decision. Our host already forces runtime exit during shutdown. This is a potential
CLI convenience issue, with no evidence here of data loss or browser impact.

### Optional startup optimization — avoid overlapping initdb backend instances

PR 1214 checks persistent storage for PG_VERSION before instantiating the long-lived backend,
reducing overlap between that backend and initdb's scratch backend. The author explicitly
reports slower initialization after removing the proxy-sharing route.
[PR 1214](https://github.com/electric-sql/pglite/pull/1214).

Our `packages/pgwasm/src/core/pgwasm.ts:211` boots a mounted backend before reading PG_VERSION.
`packages/pgwasm-c/src/build.ts:172` creates a second scratch backend for a fresh cluster,
and `host/initdb.ts:72` also retains a pristine heap copy. Preflight storage detection could
reduce fresh-store peak memory, but requires storage-specific reads and care with the existing
ownership/build-marker checks. It deserves measurement only when fresh-store memory matters.
The prepopulated build path already avoids running initdb. This optimization does not by
itself remove the pristine heap copy.

### Monitor — very large transaction empty reads

Issue 1200 reports empty reads following nearly one million statements in an outer transaction
on Bun/macOS. The reporter explicitly has no standalone reproduction and has not isolated the
symptom to PGlite. Reopening the files restores expected reads.
[Issue 1200](https://github.com/electric-sql/pglite/issues/1200).

The environment and workload make this worth following for pgwasm, but there is currently no
root cause or upstream patch to adapt. It supports bounded migration transactions and future
diagnostic work if a matching symptom appears. It does not establish engine corruption or
justify changing pgwasm's transaction implementation from this report alone.
