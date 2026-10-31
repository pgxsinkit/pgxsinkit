# Recent PGlite issues and PRs relevant to pgwasm

Reviewed: 2026-10-31. Initial source review; implementation follow-up recorded below.
Scope: recent September–October 2026 activity, compared with the current pgwasm `port-19` sources.
Candidate applicability is an inference from source; upstream measurements are not pgwasm results.
Local baseline: `80d012c` (the committed UTF-8 length fix), with the earlier performance changes
in `4c52f74`. The required commit hook passed 866 tests; the review itself ran no tests.

## Recommended shortlist

Start with custom-VFS timestamp handling, the no-override parser-map fast path and lazy default
asset URLs. They have small source perimeters and specific remaining gaps. Raw asset exports are
an optional companion to the URL work. Initdb copying is a larger, fresh-store memory/performance
candidate. Close ordering and live retries need contract/trigger qualification before being treated
as defects. Anton subsequently authorized only the three recommended small changes above.

## Authorized implementation follow-up

The custom-VFS bridge now accepts `atime` and `mtime`, including zero, retains legacy `timestamp`
fallback and preserves a missing side by reading the current metadata only when needed. Coverage
exercises the mounted callback and archived timestamps passing through the pinned WASM filesystem.

Result conversion reuses its normalized instance parser map when no per-query parser override is
supplied. Explicit overrides retain the copied merge. Tests cover no enumeration on the fast path,
both result modes, parser precedence, OID arguments, NULL and unknown types. The main Drizzle path
continues to supply overrides; no additional performance measurements or Drizzle gains are claimed.

Default C-build asset URLs are resolved and memoized on first access, and the pinned asset set forwards
them lazily rather than spreading getters at import. Literal relative URL expressions and public URL
identity are preserved. Coverage includes IIFE import/build creation, supplied-asset boot without
accessing defaults, and existing default-load/warm-up fallback paths.

Raw asset exports, initdb copying, close semantics, live retries and alternate filesystems remain
outside this implementation. Both `bun run validate` and `bun run validate:full` passed, each with
873 tests and zero failures in its final cached/selected run. All six typecheck projects, lint,
formatting and artifact checks passed. The earlier affected selection also exercised the new VFS
and parser cases; those passing results were reused by the content cache. Initial failures were in
test typing and the IIFE fixture's Bun-target bundle (`import.meta.require`); the final fixture uses
browser-target IIFE output and supplies the browser text-encoding globals. No test-cache bypass or
new performance benchmark was used. No complete browser deployment qualification is claimed.

## Runtime and live-query candidates

| Candidate                                                                                                                                                                                       | Local applicability                                                                                                                                                                                                          | Recommendation                                                                                                                                                         |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Avoid copying default parsers ([PR 1178](https://github.com/electric-sql/pglite/pull/1178), merged October 30; [issue 1145](https://github.com/electric-sql/pglite/issues/1145))                | `packages/pgwasm/src/core/parse.ts:27` still merges the entire parser map for every conversion. Upstream reuses defaults when there are no per-query overrides.                                                              | Small, high-confidence allocation improvement for direct ordinary queries. No measured gain claimed.                                                                   |
| Preserve or explicitly define pre-close work ([PR 1170](https://github.com/electric-sql/pglite/pull/1170), merged October 28; [issue 1168](https://github.com/electric-sql/pglite/issues/1168)) | `core/pgwasm.ts:817` sets closing before draining the transaction/query mutexes at lines 826–827; exchange guards reject closing at lines 290–293 and 326–327. An admitted operation's later exchanges can therefore reject. | Qualified reliability investigation. The upstream teardown crash is guarded locally; decide whether admitted work should drain or cancel before changing the contract. |
| Bounded live initialization retries and explicit exhaustion ([PR 1110](https://github.com/electric-sql/pglite/pull/1110), open)                                                                 | `live/index.ts:254,493` initializes once, while refresh has retries. The changes refresh loop at lines 498–524 can exhaust retries and then emit RESET with stale/empty changes instead of rejecting.                        | Conditional/low urgency. Upstream's multi-tab leader reset is absent from our session lifecycle; no corresponding pgwasm failure is established.                       |

The exact parser fast path does **not** improve the main Drizzle path, which always supplies
`drizzleParsers` (`packages/pgwasm/src/drizzle/session.ts:64–66`). Supporting overrides without copying
would require another lookup/overlay design and semantics review. The earlier
[PR 1159](https://github.com/electric-sql/pglite/pull/1159) was closed rather than merged; do not assume
its prototype-layering proposal is the same as merged PR 1178.

The close interface (`packages/pgwasm/src/interface.ts:180`) does not currently promise drain versus
cancellation. Existing close tests check normal close and refusal afterward, rather than queued
work or transaction completion. The useful adaptation is to qualify and choose that behavior,
not blindly add upstream's mutex acquisition: our close already acquires both mutexes.

## Storage, boot and packaging candidates

| Candidate                                                                                                                                               | Why it may help pgwasm                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Priority / effort / confidence                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Honor separate `atime`/`mtime` in the custom-VFS bridge ([PR 1162](https://github.com/electric-sql/pglite/pull/1162), merged October 26)                | `packages/pgwasm-c/src/host/vfs-mount.ts:9` defines only `timestamp`, and `setattr` at line 95 calls `utimes` only for that field. Current Emscripten calls can supply `atime`/`mtime`, so restore/file-time updates can miss the custom filesystem. `OpfsRepackedFS.utimes` already exists at `packages/pgwasm/src/opfs/opfs-repacked-fs.ts:118`.                                                                                                                          | First small correctness candidate. Small / high source confidence.                                                                            |
| Resolve default asset URLs only when needed ([PR 1175](https://github.com/electric-sql/pglite/pull/1175), merged October 30)                            | Our loader selects supplied modules/bundles lazily (`packages/pgwasm-c/src/build.ts:269`), but importing `artefacts.ts:16` eagerly executes three `new URL(..., import.meta.url)` calls. Supplying all assets therefore cannot avoid invalid `import.meta.url` in IIFE-style bundles. Preserve bundler-visible literal URL expressions while making default construction lazy.                                                                                              | Small portability improvement; relevant when targeting those bundles. Small–medium / high source confidence, target bundle behavior untested. |
| Avoid copying a new in-memory cluster back from initdb scratch storage ([PR 1165](https://github.com/electric-sql/pglite/pull/1165), merged October 30) | `CMountedDataDirectory.createCluster` creates a scratch Postgres instance and copies all its entries into the destination (`packages/pgwasm-c/src/build.ts:172–197`). Upstream proxies the destination MEMFS into the scratch instance so initdb writes there directly; persistent filesystems keep isolated scratch creation. We already avoid their tar encode/decode overhead, so our remaining benefit is less copying/transient storage, not the full upstream change. | Worth a focused boot/memory investigation. Medium / high source applicability, benefit unmeasured.                                            |
| Public raw-asset export paths ([PR 1161](https://github.com/electric-sql/pglite/pull/1161), open October 31)                                            | `packages/pgwasm-c/package.json` exports the build, amcheck and prepopulated entry, but not the raw WASM/data files. `cBuildArtefacts` is already public (`src/index.ts:1`), so runtime URL access exists; explicit asset subpaths would improve bundler imports/copy tooling only.                                                                                                                                                                                         | Optional packaging convenience. Small / high confidence.                                                                                      |

For the timestamp bridge, adapt the intent rather than copy upstream's truthiness checks: an epoch-zero
timestamp is valid. Preserve omitted attributes deliberately. The separate seconds/milliseconds
restore bug from the same PR is already avoided: `packages/pgwasm-c/src/host/data-dir.ts:51` multiplies
`mtimeSeconds` by 1,000 before calling `FS.utime`.

This is not merely an assumption about a newer SDK: the pinned
`packages/pgwasm-c/artefacts/postgres.js` implements `utime(path, atime, mtime, ...)` by forwarding
`{atime, mtime, dontFollow}` through `FS.doSetAttr`; that function forwards the attributes to the
node's `setattr` unchanged. Our bridge ignores both time attributes. Therefore restore's correctly
converted milliseconds reach this bridge but not `vfs.utimes`, leaving the custom VFS's creation/
write time instead of the archived file time. The finding concerns metadata fidelity; no database
corruption or OPFS durability failure is claimed.

The initdb proxy optimization does **not** remove the scratch Postgres instance or the pristine-heap
copy in `packages/pgwasm-c/src/host/initdb.ts:72`. The existing
[`prepopulated` export](../../packages/pgwasm-c/src/prepopulated.ts) already supplies the main workaround
recommended in [issue 1158](https://github.com/electric-sql/pglite/issues/1158): skip initdb on fresh
stores by using a prebuilt cluster. The issue's reported RSS numbers describe upstream Node runs and
must not be presented as measurements of our runtime.

## Broader storage issues, not small patches

- **Cross-process ownership for `file://` stores** ([issue 1106](https://github.com/electric-sql/pglite/issues/1106),
  updated October 17): `FileMount.acquire` (`packages/pgwasm-c/src/host/mounts/file.ts:20`) resolves and
  creates the directory but acquires no exclusive OS-process ownership. The report describes a second
  process running recovery on a live directory. Our browser OPFS ownership does not protect this
  separate Bun file-storage path. Important if shared directories can have concurrent processes;
  needs an ownership design, not a copied PID-file patch. Source gap confirmed; local corruption
  reproduction intentionally not attempted. This does not imply an ownership gap in our OPFS path.
- **Ordered host persistence for `file://` stores** ([issue 1107](https://github.com/electric-sql/pglite/issues/1107),
  open): our `FileMount.persist` is empty (`packages/pgwasm-c/src/host/mounts/file.ts:37`). Direct host
  writes and clean close are not by themselves an ordered power-loss durability barrier. Upstream
  supplies no completed fix here. This is a filesystem/contract investigation, not a quick PR port
  and not evidence of a demonstrated pgwasm corruption event.

## Changes not recommended for immediate adoption

- **MEMFS2OPFS** ([PR 1166](https://github.com/electric-sql/pglite/pull/1166), merged October 28): an
  experimental filesystem keeping the entire database in memory and flushing changes to OPFS. It
  trades memory for access speed and would replace a substantially different packed storage design.
  Our OPFS implementation already has its own four-handle persisted store
  (`packages/pgwasm/src/opfs/index.ts:42`). This does not meet a simple speed/memory non-regression
  objective without workload and durability analysis. [PR 1174](https://github.com/electric-sql/pglite/pull/1174)
  merely adds the upstream experiment to benchmarks.
  This is not a finding of no benefit: serving filesystem reads from MEMFS can avoid OPFS calls,
  dirty writes can be coalesced before persistence, and an asynchronous writable-stream fallback
  could broaden OPFS placement where synchronous handles are unavailable (capability handling still
  needs qualification). The costs are keeping all database files resident and loading them at boot.
  It is a credible alternative for small stores with frequent filesystem accesses, but no comparison
  against our packed VFS has been measured. The benchmark PR adds configurations, not published
  evidence of an advantage over pgwasm. A future comparison should include full-store memory, reopen
  time and equal durability alongside throughput; a bounded cache is another option to compare.
- **OPFS-AHP handle-map consolidation** ([PR 1135](https://github.com/electric-sql/pglite/pull/1135),
  merged October 13): applies to the upstream access-handle-pool implementation, which pgwasm does
  not use. There are no corresponding two per-file handle maps to consolidate in our packed VFS.
- **Embedded filesystem bundle** ([PR 1131](https://github.com/electric-sql/pglite/pull/1131), open):
  moves `.data` bytes into JavaScript glue via `--embed-file`. Potential bundler convenience, but a
  C-build packaging change with bundle-size/loading trade-offs. Prefer the smaller lazy-URL/raw-export
  improvements before changing the artifact model.
- **Node permission-model compatibility** ([PR 1164](https://github.com/electric-sql/pglite/pull/1164),
  merged October 26): the pinned `packages/pgwasm-c/artefacts/postgres.js` still contains
  `process.binding("constants")["fs"]`, the forbidden operation upstream replaces with filesystem
  constants. However pgwasm currently targets Bun/browser rather than Node runtime support. Relevant
  only if that support scope changes; a standalone glue rewrite would not establish full Node support.
- **Emscripten upgrade** ([PR 1167](https://github.com/electric-sql/pglite/pull/1167), merged October 27):
  upstream moves to 6.0.5; our PG19 builder already uses 6.0.13
  (`pgwasm-postgres/README.md:15–17`). Its pointer-signature cleanup (`iii` → `ipi`) could inform a
  separate ABI consistency audit, but is not evidence of a current wasm32 failure. Do not downgrade
  the builder to match upstream.

## Evidence and limits

The initial review inspected linked upstream bodies/diffs and cited local source paths without local
reproduction, profiling, corruption probes or compatibility testing. Effort estimates described the
likely adaptation perimeter. Subsequent implementation and validation are recorded in the authorized
follow-up above. Its IIFE case covers browser-target import/build creation with absent module URLs;
the supplied-asset WASM boot is a separate Bun unit case, not a complete browser deployment test.

## Already covered or structurally different

- Backup transaction/query locking from [PR 1143](https://github.com/electric-sql/pglite/pull/1143)
  is present in `core/pgwasm.ts:802–810`; awaiting readiness before close from
  [PR 1149](https://github.com/electric-sql/pglite/pull/1149) is present at line 816.
- Extended-query error synchronization from [PR 1144](https://github.com/electric-sql/pglite/pull/1144)
  is already owned by the C main-loop patch and qualified in `docs/testing-strategy.md`.
  Handled-error stack restoration from [issue 1115](https://github.com/electric-sql/pglite/issues/1115)
  and fail-fast handling of unexpected traps from [issue 1058](https://github.com/electric-sql/pglite/issues/1058)
  are present in `packages/pgwasm-c/src/host/postgres-instance.ts:74–95,411–458`.
  The separate churn/JIT hang in [issue 1068](https://github.com/electric-sql/pglite/issues/1068)
  has no confirmed root cause or patch to adapt; do not equate it with the handled-trap issue.
- Shared live-subscriber behavior from [PR 1141](https://github.com/electric-sql/pglite/pull/1141)/
  [1142](https://github.com/electric-sql/pglite/pull/1142) already removes only the requested callback
  and tears down when none remain (`live/index.ts:327–338,536–549,681–684`).
  Windowed total-count statement cleanup from [PR 1108](https://github.com/electric-sql/pglite/pull/1108)
  was included in the earlier agreed fixes.
- Initdb UTC from [PR 1156](https://github.com/electric-sql/pglite/pull/1156) and unsigned parameter
  counts/overflow checks from [PR 1123](https://github.com/electric-sql/pglite/pull/1123) already exist.
  [PR 1050](https://github.com/electric-sql/pglite/pull/1050) is covered by the committed result loops
  and safe property handling; metadata caching was deliberately omitted after mixed measurements.
- Worker notify-loop teardown ([PR 1113](https://github.com/electric-sql/pglite/pull/1113),
  [1147](https://github.com/electric-sql/pglite/pull/1147)), raw per-tab lock leaks
  ([PR 1146](https://github.com/electric-sql/pglite/pull/1146)), no-leader hangs
  ([PR 1109](https://github.com/electric-sql/pglite/pull/1109)), initialization-error propagation
  ([issue 1122](https://github.com/electric-sql/pglite/issues/1122)) and worker parser transport
  ([PR 1114](https://github.com/electric-sql/pglite/pull/1114)) concern a different worker architecture.
  Our attach teardown rejects pending operations and removes listeners (`attach-sync-client.ts:1974–2017`);
  election handles late lock grants (`election-coordinator.ts:232–254,275–286`);
  relocation classifies outcomes (`attach-sync-client.ts:1487–1510`); initialization failures are sent
  to clients (`define-sync-worker.ts:1444–1453`); Drizzle parsers are reinstated worker-side
  (`define-sync-worker.ts:858–871`). These are not missing upstream patches to copy.
- Refetch truncation/commit failures ([PR 1126](https://github.com/electric-sql/pglite/pull/1126),
  [issue 1125](https://github.com/electric-sql/pglite/issues/1125)) are already addressed by native
  transactional replacement and acknowledge-after-success (`circuits/sync-engine.ts:267–295,398–414`).

The worker/client references in the final two bullets are under `packages/client/src/worker/`
except `circuits/sync-engine.ts`, which is under `packages/client/src/`. This review describes the
current PG19 checkout; it does not certify another branch or establish new regressions by execution.
