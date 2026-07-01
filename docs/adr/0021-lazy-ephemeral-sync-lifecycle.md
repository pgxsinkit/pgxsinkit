# Sync lifecycle: subscription-timing and retention as orthogonal axes

Status: accepted (2026-06-28)

The original framing was a second "non-electric" / "direct" data flow — reads from a live API, writes
synchronously — motivated by data that should not sit durably on the client (proctored exams;
sensitive/PII data under erasure and data-minimisation pressure) and by per-user **cold** data that
basically never changes but, multiplied across many thousands of users, bloats storage.

Grilling dissolved the premise. The distinction that matters is not **transport** (Electric vs a direct
API) but **sync lifecycle** — and that lifecycle is **two orthogonal axes, not one**. Every shape today is
*eager* (subscribed at boot) and *persistent* (durable PGlite backend). The motivating cases vary those two
switches independently while remaining **real Electric shapes** — live while held, governed by the same
RLS-mirrored row filter, queryable and joinable in the same PGlite with the same Drizzle API. "Direct" was
never a different system; it is a point in a 2×2 of sync lifecycle.

Two supporting facts make this cheap and shape it:

- The local PGlite schema is **already a runtime-derived projection** distinct from the server (no
  migration), built **per-table**: each writable table gets its own read-cache table, overlay, **journal**,
  sequence, read-model + sync-state views, and reconcile trigger/function. The only cross-table singleton is
  a tiny key/value meta table (the registry fingerprint, ADR-0006); **no mutation data is pooled**. So an
  ephemeral table's *entire* footprint — reads **and** writes — is a self-contained cluster that can be
  emitted as `TEMP`.
- Storage is a **deployment/runtime knob**, not an architecture (client: persisted vs in-memory/temp;
  server: the Electric shape-log volume). So the right default is "ship everything eager-persistent,
  measure, tune where a real problem appears" — not a second architecture against an unmeasured worry.
  Electric also GCs idle shapes server-side.

This subsumes the proposed RLS direct-read endpoint: with reads always served by Electric, the RLS-bounded
direct-read path whose runway [ADR-0020](0020-index-friendly-rls-any-array.md) cleared is no longer a *core*
read path — it degrades to an optional escape hatch for a genuine streamed read-once.

## Decision

1. **Lifecycle is two orthogonal axes**, declared per table (per consistency group — see §4), both
   orthogonal to read/write mode and to authorization (the RLS policy / Electric row filter is unchanged):
   - **Subscription timing — `eager` (default) | `lazy`.** `eager` joins the boot subscription set; `lazy`
     is excluded from boot and subscribed on first query-reference.
   - **Retention — `persistent` (default) | `ephemeral`.** `persistent` uses the durable PGlite backend with
     a resumable subscription-state; `ephemeral` emits the table's whole local cluster as `TEMP` (§3) — no
     durable trace.

   The **four corners are all valid and cheap**, because the two presets below already require building both
   ends of every underlying switch:

   | | persistent | ephemeral |
   |---|---|---|
   | **eager** | warm, durable, offline — *today's default* | small data to keep warm immediately but with no durable trace; re-hydrates each boot |
   | **lazy** | **deferred-activation** durable table (§2) — pay nothing at boot until first use, then a normal synced table | cold per-user / exam data — pay nothing until used, leave nothing behind |

2. **`lazy` is a one-time ignition, not an ongoing mode.** A `lazy` table is **dormant** until first
   referenced; first reference **activates** it. For `lazy + persistent`, activation is *permanent*: the
   table joins the normal eager-persistent set — recorded by a **persisted activation flag** in the local
   meta table, so subsequent boots subscribe it eagerly and it resumes like any durable table — with no
   per-session re-evaluation, no "half-lazy", no serve-stale-then-update. An optional TTL / explicit
   **desync** reverts it to dormant with a clean truncate. For `lazy + ephemeral`, activation is
   session-scoped by construction (the temp cluster dies with the session), and idle-eviction
   (subscriber-refcount + TTL → `unsubscribe` + drop the temp cluster) reclaims it within a session.

3. **`ephemeral` = the whole per-table cluster emitted as `TEMP`.** Because the local store is per-table
   (read-cache table, overlay, journal, sequence, read-model + sync-state views, reconcile trigger/function),
   making *all* of them `TEMP` makes **both read- and write-ephemerality fall out automatically** — there is
   no separate "ephemeral journal" mechanism. Mechanical consequences, all forced-consistent rather than
   optional:
   - the read-model / sync-state **views must be `TEMP`** (Postgres forbids a permanent relation depending on
     a temporary one);
   - the reconcile **function** lives in `pg_temp` (session-temp) alongside the temp table it references;
   - temp objects resolve via `pg_temp` / search_path (unqualified), so the generator emits an ephemeral,
     unqualified variant of the cluster DDL;
   - the Electric row-applier (and the must-refetch truncate) must target the **unqualified** name so it
     resolves via `search_path` to `pg_temp` — the engine signals this by passing **no schema**, and the
     applier must NOT default a missing schema to `"public"` (that would write to a non-existent
     `public.<table>` and the synced rows would silently never land). Confirmed end-to-end by the
     `lazy-activation` integration test (a `lazy + ephemeral` group's on-demand activation streams its rows
     into the temp cluster); it is not merely a build-time check.

4. **Grouping constraints (the consistency group is the grain).** Subscription timing is a property of a
   **consistency group**: a `lazy` table must be a singleton group, or its whole group is lazy together,
   because a multi-table group commits atomically at a shared LSN frontier and cannot be partly lazy.
   Retention likewise applies to the whole cluster a group spans.

5. **Readiness is surfaced, not hidden.** A `lazy` table's live-query result envelope exposes its
   hydrating/ready state — the same loading state every shape sits in at boot, triggered per-table on first
   use — plus `fetchedAt`/`refetch` affordances the eager form does not carry, so identical-looking query
   code cannot silently treat a cold/un-hydrated table as warm. The lifecycle axes are registry-declared and
   typed, so a join that will cold-block on first use is visible at authoring time.

## "True ephemeral" — the threat model

`ephemeral` targets a deliberately-bounded guarantee: **no durable, origin-addressable copy in OPFS /
IndexedDB once the site is closed.** It does *not* attempt "never touches disk at the OS level" — OS swap,
memory compression, and tab-discard snapshots can transiently page even an in-memory instance's wasm heap,
outside any in-browser control, so that guarantee is unachievable and is not the boundary. The determined
local adversary (a full-power browser extension, devtools, an unlocked browser) can read wasm memory
regardless of storage choice; that is why proctored exams run **stripped-down proctor browsers** — an
*environmental* control outside pgxsinkit's scope. Under this bar a `TEMP` cluster (session-scoped, dropped
on close) is "true ephemeral". A separate in-memory PGlite *instance* is the strongest form (no transient
VFS contact at all) but costs cross-instance joins, so it is reserved for the rare case that needs it; the
`TEMP`-cluster form is the default because it keeps cross-joins.

## Composition rule: ephemeral has no durable write queue

A temp journal dies with the session, so an `ephemeral` table has **no durable offline write queue** — a
mutation enqueued but not flushed before the tab closes is lost. This is *consistent* with ephemerality (and
is exactly right for an exam: no durable trace of answers), but it means "this write must not be lost" must
be paired with prompt or **pessimistic** flush (the authoritative path of
[ADR-0022](0022-pessimistic-write-units.md)), so the write reaches the server before close rather than
trusting a queue that will not survive. This is a composition note, not a gap.

## Why this is contained

The per-group subscribe/teardown primitive **already exists and is reentrant**: `startGroupSync(pg, {
groupKey, specs, … })` starts one consistency group on its own `MultiShapeStream` and returns
`{ unsubscribe, isUpToDate }`; a singleton table is already its own group. The all-or-nothing boot is purely
`startConfiguredSync`'s eager orchestration — a pgxsinkit choice, **not** an Electric or engine limitation.
The per-table cluster DDL and a `TEMP` variant of it are a small extension of `generateLocalSchemaSql`; the
truncate/teardown reuses `buildDropReadCacheSql` / `buildWipeLocalStoreSql`. So this is an **orchestration +
DDL-variant policy layer over existing primitives**, with no sync-engine work.

## Considered options

- **A second direct-read API endpoint (reads bypass PGlite), under RLS.** Rejected as a *core* read path: it
  forks the query API, the auth surface, and the result model into two systems; and once `= ANY(ARRAY)` RLS
  (ADR-0020) makes RLS-alone reads fast, the only thing it adds over a shape is "no local copy" — which
  `ephemeral` retention provides without leaving the Electric model. Retained only as an escape hatch for a
  true streamed read-once.
- **Direct fetch into a PGlite temp table (a snapshot).** Rejected: a snapshot forces the query API to
  answer "is this stale?" (a hard, ongoing freshness burden) and to hand-roll reconciliation. A
  `lazy`/`ephemeral` *shape* is live while held, so the burden shrinks to a transient "is this hydrated yet?".
- **A single `lifecycle` enum (`eager-persistent | lazy-ephemeral`).** Rejected (this ADR's own first draft):
  it conflates two independent switches and hides the two genuinely-useful off-diagonal corners
  (`eager-ephemeral`, `lazy-persistent`), which cost nothing extra once both presets are built.
- **A separate in-memory PGlite instance as the *only* ephemeral mechanism.** Rejected as the default: it
  breaks cross-instance joins. Kept as the strongest-isolation option for the rare case that needs zero
  transient VFS contact; the `TEMP`-cluster form is the default because it preserves joins.
- **Per-table storage backend within one persisted PGlite.** N/A under the `TEMP`-cluster mechanism —
  ephemerality is achieved by temp objects in the shared instance, not by a per-table backend (which PGlite
  does not offer).
- **Everything eager-persistent (do nothing).** Rejected as the *only* mode: it forces a durable per-user
  copy of cold data and cannot serve the no-durable-client-copy requirements (exam integrity,
  data-minimisation/erasure). It remains the correct **default**; the other corners are opt-in.

## Consequences

- **One system.** Reads are always Electric; "direct/non-electric" retires as an architecture and reappears
  only as lifecycle axes. RLS-everywhere (ADR-0019/0020) is unchanged and remains the single read-auth
  authority for every corner.
- **Storage tuning is deferred and reversible.** Ship eager-persistent, measure, then move cold shapes to
  `ephemeral` and/or point server-side Electric shape-log storage at cheap/ephemeral volumes — a deployment
  change, not app code.
- **Write-ephemerality is automatic** (the per-table `TEMP` cluster), at the cost of no durable offline write
  queue for ephemeral tables (the composition rule above).
- **The new honesty burden is small.** The result envelope distinguishes hydrating/cold from ready; a
  cross-lifecycle join cold-blocks on first use (correct, but visible).
- **The lift is contained** — orchestration + a `TEMP` DDL variant over `startGroupSync` /
  `generateLocalSchemaSql`, not an engine change. This is the cheaper of the two lanes; sequence it before
  the write lane (ADR-0022).

## Known limitations / TO FIX

The read-path safety net keeps a query from silently reading an un-hydrated `lazy` relation, and it is
**one mechanism**: scan the query's *compiled* SQL for the lazy relations it reads, activate them, and
hydrate before the query runs. A lazy relation therefore auto-activates on **any** reference — FROM,
JOIN, subquery, WHERE — with no Proxy, no builder-AST walk, and no `use` declaration required.

Because the scan is complete for pure Drizzle, the read API splits accordingly. The pure guarded reads —
`client.query((c) => …)` / `queryRow`, and `useLiveDrizzleRows` — take the builder callback directly and
expose **no `use`**: it would be dead weight, since the scan already finds every relation. `use` survives
only on the raw-fragment surface — `client.queryRaw({ use, build })` / `queryRawRow`, and `useLiveQueryRaw` —
where a builder may embed a raw ``sql`…` `` fragment naming a relation as a bare identifier the scan cannot
see. An oxlint rule (`pgxsinkit/guarded-query-purity`) flags the two provenance facts the type system
cannot: a raw fragment smuggled into the pure path, and a redundant `use` on a pure raw-path builder. It
ships with `@pgxsinkit/client` via the `./oxlint` subpath export, so downstream repos enable it with
`"jsPlugins": ["@pgxsinkit/client/oxlint"]` — the rule versions with the installed client.

Why one SQL scan suffices and is safe:

- **Detection = activation.** The compiled SQL is ground truth — a relation the query reads must appear
  there by name. Earlier drafts split a "precise" detector (a client-accessor Proxy + a Drizzle
  builder-config walk) from a "conservative" SQL *tripwire* that threw on the gap between them. The scan
  subsumes both (everything they could catch is in the compiled SQL — and the Proxy was *worse*: it
  recorded accessed-but-unused relations), so they were removed, taking the Drizzle-internal-builder-shape
  dependency with them.
- **No value false positives.** Drizzle compiles to *parameterised* SQL — values are bound (`$1`, `$2`),
  never inlined — so a literal like `where label = 'archive'` cannot masquerade as the table `archive`.
- **Schema-correct + alias-proof by construction.** The index is built from the *same* Drizzle objects
  that emit the SQL (`getTableConfig`/`getViewConfig`), and matches the exact **quoted** token they emit:
  `"name"`, or `"schema"."name"` when schema-qualified. Quotes make the token self-delimiting (`"a"` can't
  match inside `"ab"`); a schema-qualified token (`"appserver"."events"`) is **collision-proof** against
  any bare alias/CTE/table-alias, since Drizzle always emits aliases bare.

Residual edges:

1. **Schema-less relation vs. a same-named column alias.** For a relation with *no* schema (a bare
   readonly table, or a `*_read_model` view), a column aliased `as "name"` shares the bare token. Handled
   by an `as`-lookbehind guard (Drizzle emits `… as "name"` for `.as()`), so the realistic case is closed.
   The narrow remainder — a *CTE* or *table-alias* named **identically** to a bare lazy relation — is not
   excluded, but is impossible for `*_read_model` views and, for a bare readonly table, costs at most one
   spurious **persistent** subscription (never a wrong result, since activating an unread relation cannot
   change a query). Give such a relation a schema to make it collision-proof. *TO FIX (optional):* lex the
   SQL to also exclude CTE/table-alias positions.
2. **Raw SQL is unsupported by the scan, on purpose.** `useLiveRows` (a raw string) is the **unguarded**
   escape hatch — it does not auto-activate. A raw query touching a lazy relation must
   `client.ensureSynced([...])` first; otherwise it reads empty/stale. For a Drizzle builder that embeds a
   raw ``sql`…` `` fragment, use the guarded raw surface — `client.queryRaw({ use, build })` / `useLiveQueryRaw`
   — and name the lazy relations in `use`. Pure-Drizzle reads (`client.query`) need no `use`.
3. **`client.drizzle` direct reads bypass the guard.** A bare `await client.drizzle.select()…` (not via
   `client.query`/`queryRow` or the hooks) has no interception point. *Workaround:* use the guarded
   equivalents, or `ensureSynced` first. The documented power-user escape hatch.
4. **The backstop throws only on activation failure.** After scanning + activating, a final check throws
   `LazyRelationNotActivatedError` if a referenced lazy relation is still not active — a failed initial
   sync, or a lazy relation with no consistency group — rather than letting the query read empty/stale.
   In the normal path everything scanned was just activated, so it never fires.
5. **"Never read a *never-hydrated* relation", not "always read the freshest".** A lazy relation that
   started and finished initial sync stays "active" even if its stream later flips `isUpToDate:false`
   during a resync. Staleness is the convergence layer's concern, not the guard's.
6. **Sync-disabled (local-only) mode skips the guard.** `isSynced` returns `true` when sync is disabled —
   `lazy` has no meaning without Electric.
7. **`ephemeral` (not built) will *not* auto-pull on the scan.** When the retention axis lands, an
   `ephemeral` relation referenced without an explicit `use` should refuse to auto-activate (its whole
   point is to not pull cold data on a probable reference) and instead require the deliberate `use` — the
   one place a throw, not an auto-activate, is the right default.

## To confirm at build time

- That a PGlite `TEMP` cluster leaves **no OPFS / IndexedDB trace after the tab closes** (expected: temp
  objects are session-scoped and dropped; transient in-session VFS use is irrelevant under the threat model).
- That the `./sync` engine (`syncShapesToTables`) accepts being invoked for *additional* groups mid-session
  and torn down individually, and that its row-applier targets the `pg_temp`-resolved name for an ephemeral
  cluster.
- How a lazy group's subscription-state and the **whole-registry pause/resume** interact: a global pause must
  not wake a lazy group; a lazy-start must not fight the pause.

## Implementation status

**Implemented — both axes are built end to end (read lane, promotion, ephemeral `TEMP` DDL, fingerprint,
explicit desync). The only deferred piece is *automatic* idle-eviction for `lazy + ephemeral`, a memory
optimisation whose correctness guarantee is already met without it (see below).**

Built:

- **The two lifecycle axes in the registry** (`subscription: eager|lazy`, `retention:
  persistent|ephemeral`), validated, with a per-consistency-group uniformity check (a group may not mix
  either axis). `packages/contracts` (`config.ts`, `registry.ts`).
- **Exclusion of `lazy` groups from the eager boot pass** + a single-flight `ensureGroupStarted` /
  `stopGroup` / `groupKeyForTable` / `isTableStarted` on the sync result. `packages/client/src/shape-sync.ts`.
- **Start-on-first-reference, made safe by one compiled-SQL scan** (`packages/client/src/lazy-guard.ts`):
  a query's parameterised SQL is scanned for the schema-aware quoted tokens of its lazy relations, which
  are then activated + hydrated before it runs. Surfaced through `client.ensureSynced` / `isSynced` /
  `prepareQuery`, the non-live facade — pure `client.query` / `queryRow` (callback-direct, no `use`) and
  raw `client.queryRaw` / `queryRawRow` (`{ use, build }`) — and the live `useLiveQueryRaw` / `useLiveQueryRawRow`
  + `useLiveDrizzleRows` hooks (`useLiveRows` raw SQL is the unguarded escape hatch).
  See **Known limitations** above for why the scan is sufficient and its residual edges.
- **`lazy + persistent` permanent promotion** via a persisted activation flag (`lazy_active:<group>`) in
  the local meta table: an on-demand start of a persistent lazy group records the flag
  (`writeLazyGroupActivation`); the next boot reads it (`readActivatedLazyGroups`) and treats the group as
  eager — a one-time ignition, never a per-session re-evaluation. `local-store.ts`, `shape-sync.ts`, `index.ts`.
- **`ephemeral` = the whole per-table cluster as `TEMP` / `pg_temp`**: the synced/overlay/journal tables +
  sequence are `TEMP`, both views `TEMP`, the reconcile function lives in `pg_temp`, and the row-applier
  targets the temp cluster — so read- and write-ephemerality fall out together with no durable trace.
  `packages/client/src/schema.ts`.
- **`retention` folded into the registry fingerprint** — a `TEMP`-vs-durable DDL change forces a cache
  rebuild + subscription reset; `subscription` is deliberately excluded (pure runtime orchestration over
  identical tables, no DDL change). `packages/contracts/src/fingerprint.ts`.
- **Explicit `desync(table)`** — the manual revert to dormant, operating on the whole consistency **group**
  (a group is one subscription / one frontier, so reverting one member reverts them all): stop the group's
  stream (`stopGroup`, so a live shape can't re-fill the cache mid-truncate), clear the persisted
  `lazy + persistent` activation flag (`clearLazyGroupActivation`, a no-op for ephemeral), **delete the
  group's persisted Electric subscription** (`deleteSubscription`, so re-activation re-streams from scratch
  rather than resuming the old cursor and never re-sending the truncated rows), and clean-truncate **every
  member's** read cache (`buildDesyncTableSql`, ephemeral-aware: bare/`pg_temp` for a temp cluster,
  schema-qualified for a durable one — the cluster is emptied, not dropped, so a later reference re-streams
  into it). Refuses an `eager` relation (always-on) or any group member that owes unsettled writes (the
  truncate would drop them). `index.ts`, `schema.ts`.

Deferred — a memory optimisation, not correctness:

- **Automatic idle-eviction for `lazy + ephemeral`** (subscriber-refcount + idle-TTL → `unsubscribe` + drop
  the temp cluster, recreating it on the next reference). The ephemerality *guarantee* is already met
  without it: an ephemeral cluster is `TEMP`, so it vanishes at session end regardless. Auto-eviction would
  only reclaim memory *within* a long-lived session for an ephemeral relation the user navigated away from.
  The primitives it would build on are done (`stopGroup`, `desync`, the ephemeral-aware truncate); the
  unbuilt part is the refcount+TTL driver plus on-re-reference cluster *recreate* and the hook-level
  retain/release plumbing to feed it — sized out of proportion to the win, so it waits for a measured need.
  Until then, `desync` is the explicit reclaim primitive a host can wire to navigation/idle by hand.

References: [ADR-0009](0009-internalize-read-path-sync.md) (read-path sync; consistency groups = decision 2 —
the per-group `MultiShapeStream` and the group grain this builds on);
[ADR-0019](0019-row-filters-as-drizzle-fragments.md) / [ADR-0020](0020-index-friendly-rls-any-array.md) (the
RLS row-filter / `= ANY(ARRAY)` that stays the single read-auth authority);
`packages/client/src/shape-sync.ts` (`startGroupSync`, `startConfiguredSync`);
`packages/client/src/schema.ts` (`generateLocalSchemaSql` — the per-table cluster; `buildDropReadCacheSql` /
`buildWipeLocalStoreSql`); [ADR-0022](0022-pessimistic-write-units.md) (the write-side twin; the pessimistic
flush an ephemeral table pairs with); `CONTEXT.md` (the Parity boundary).
