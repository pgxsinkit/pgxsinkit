# pgxsinkit

An offline-first **sync toolkit** for the topology `PostgreSQL → ElectricSQL →
PGlite` (read path) and `client → write API → PostgreSQL` (write path). The
`@pgxsinkit/*` packages are the product; a demo app and an integration + perf
harness exist to prove and harden them.

The terms below are the canonical language for this repo. Add to them as more of
the model gets resolved; do not let stale or implementation-flavoured wording
creep in.

## Language — what the repo is

**Toolkit**:
The `@pgxsinkit/*` packages, taken together — the published, reusable library
that downstream products install to get offline-first sync. This is the product.
_Avoid_: "demo repository", "the harness" (those name parts of the repo, not the
thing you ship), "framework".

**Demo app**:
The reference application (`apps/board`, a Linear-style board + chat) that drives
the toolkit end-to-end against a self-hosted Supabase + Electric stack for a human
to see. It is an exerciser, not the product. (`apps/write-api` is the minimal
server-only reference.)
_Avoid_: calling it "pgxsinkit" — it is one consumer of pgxsinkit.

**Harness**:
The integration and performance suites (`tests/integration`, `apps/perf-lab`)
that prove the toolkit against real PostgreSQL/Electric/PGlite. It hardens the
product; it is not the product.
_Avoid_: "the demo" (the harness is not the demo app).

## Language — the write path

**Write path**:
The one way client writes reach Postgres: an app stages intent locally, the
client flushes it through the write API, and a single in-database function
applies it. There is exactly one write path — no selectable backends.
_Avoid_: "backend", "strategy", "artifact mode", `bulk-plpgsql-artifact` (all
retired — they implied a choice that never existed).

**Mutation applier**:
The single PL/pgSQL function (`pgxsinkit_apply_mutations`) that consumes a
flushed batch of staged mutations and applies it to Postgres in one in-database
call. Putting the apply logic in the database is the toolkit's central finding,
not an implementation detail.
_Avoid_: "the artifact", "the strategy function", "the bulk backend".

**Per-entity flush serialization**:
The guarantee that a single flush batch holds **at most one unresolved mutation per Entity
identity**: the Mutation journal sends a mutation only when no earlier same-entity mutation is
still owed, so an entity's writes reach the server in the order the client enqueued them and a
batch never carries same-entity duplicates. This invariant is what lets the Mutation applier
apply a batch set-based (grouped by table and kind) without a same-row join collision.
_Avoid_: assuming a batch may contain several operations for one entity — by construction it
cannot, and code that relies on the set-based apply depends on this holding.

## Language — the read path

**Read path**:
The one way server state reaches the client: the client subscribes to ElectricSQL
shape streams, buffers each shape's changes ordered by LSN, and applies them to the
local read cache in LSN order inside transactions. There is exactly one read path —
Electric shapes in, local synced tables out. The toolkit owns the ingest glue; Electric
owns the replication protocol.
_Avoid_: "pglite-sync", "the vendored sync", "the Electric adapter" — the ingest is
internal to the client, no longer a separate or vendored package.

**Shape inbox**:
The pure, in-memory staging buffer between a shape's Electric subscription and the Sync
applier. It receives the shape's raw change/control messages, holds them ordered by LSN, and
— before the applier writes anything — folds each primary key's operations across the drained
batch down to **one net operation** (insert / update / delete, the ADR-0014 fold), so no two
source rows ever target the same key. It performs no database I/O, which is exactly what makes
the fold property-testable against an ordered per-row apply oracle. One inbox per shape; a
Consistency group advances and commits its shapes' inboxes together at the shared LSN frontier.
The pure read-path seam an optional durable ingest log would attach to (ADR-0016, deferred).
_Avoid_: "the buffer" / "the queue" alone (they hide that it folds, and that it is pure), and
conflating it with the Sync applier — the inbox decides the net operation per key, the applier
performs the resulting bulk DML.

**Sync applier**:
The client component that writes buffered shape changes into the local synced tables.
It picks one apply strategy per table from the registry's column types — bulk `COPY`
for all-scalar tables, `json_to_recordset` for tables with array/json/jsonb columns,
and plain batched `INSERT` as the always-correct floor. The read-path counterpart to
the Mutation applier.
_Avoid_: "the importer", "the COPY path" (it is one of three), "row transform".

**Registry item (as engine spec)**:
The registry entry is the ingest engine's **sole** per-table specification: every table-scoped
fact — local table identity, client projection, primary keys, apply strategy, column types, and
lifecycle — derives from it (via `getSyncedLocalTable`, `deriveSyncColumnTypes`, and the
build-time strategy classification), never from options passed alongside it. Passing a
table-scoped fragment (a table name, a `columnTypes` array, a `primaryKey`) next to the registry
is a smell: two sources that can disagree, when the entry already states the answer (ADR-0029).
_Avoid_: "generic caller" and "passthrough table" — both name the retired slice-F designs (an
engine driven by bare name strings, and anonymous `pgTable`s re-derived from them beside the real
objects `getSyncedLocalTable` already returns); do not reintroduce a string-or-entry hybrid API.

**Type knowledge**:
What the apply path knows about a synced table's column types — the casts for `json_to_recordset`,
the COPY UDTs, the bulk-recordset casts. It derives from the registry model (`deriveSyncColumnTypes`,
the same Drizzle definitions the local-schema generator reads), never supplied by callers and never
introspected from the catalog: the local store has one DDL author rendering from that model, and the
fingerprint forces a rebuild on model change, so the catalog is causally downstream of the model —
introspecting it observes our own output with extra steps (ADR-0029).
_Avoid_: "the `information_schema` read", "resolve the casts from the catalog" (a redundant probe
of our own rendered output), and treating caller-supplied column types as a valid input.

**Self-verifying apply function**:
The generated `pgxsinkit_apply_mutations` takes the caller's expected fingerprint as an argument
and refuses to run (SQLSTATE `PXS01`) unless it matches its own comment anchor — so the drift
check is atomic with the call it guards (no verify-then-call window) and costs zero round trips,
holding under any worker model including one-worker-per-request serverless hosts. Enforcement is
always-on; deploy-time verification (`pgxsinkit-generate --check`) remains the pipeline half
(ADR-0030, superseding ADR-0018's startup enforcement point).
_Avoid_: "the startup drift check" / `applyFunctionDriftCheck` as current mechanism (retired —
enforcement no longer has an off switch or a startup query), and warn-and-continue for
unfingerprinted functions (now refused; regenerate instead).

**Deployment profile**:
The `createSyncServer` option group describing what the **host process** may assume was verified
at deploy time: `startupVerification` (`in-process` keeps the boot-time RLS-helper check;
`deploy-time` skips it — the migration pipeline owns it) and `operationsLog` (`probe` /
`enabled` / `disabled` — a declaration replacing the startup probe). The zero-startup-query
serverless posture is `deploy-time` + a declared ops-log, so a fresh worker's first statement is
the mutation transaction itself (ADR-0030).
_Avoid_: describing these as per-request behavior toggles (they only move verification between
boot and pipeline), and re-adding table-scoped facts to them (those belong to the Registry item).

**Cache wipe vs server echo**:
A must-refetch wipe is engine **cache maintenance** (TRUNCATE, then re-stream) and must never
trigger server-echo reactions — the row-level reconcile trigger exists to react to _server truth_
arriving, so firing it off the engine's own wipe conflates the two. Only streamed changes are
server truth; completeness rides the reconcile loop (`reconcileTable`'s `clearable_entities` pass),
not the per-row trigger (ADR-0029).
_Avoid_: "row-wise wipe" / deleting the cache row-by-row (the retired form — O(n) statements and a
trigger storm), and conflating the wipe with an echo.

**Consistency group**:
A set of synced tables that share one shape stream and commit atomically at a shared
LSN frontier, so the local read cache never shows one table advanced past another for
the same server transaction (no transient broken joins). Declared per table via
`consistencyGroup`; the default is a per-table singleton, so grouping is opt-in and a
group advances only as fast as its slowest shape. Subscription resume and read-cache
rebuild are group-granular.
_Avoid_: "sync group", "shard", "batch", and especially "group" alone (it collides
with an application-domain Group primitive and is a reserved word).

## Language — the local-first client

**Local schema**:
The PGlite schema the client generates from the sync registry: enum types, each
synced table (its projected columns, types, NOT NULL, and primary key), and — for
writable tables — the overlay, mutation journal, reconcile trigger, and read
model. It is a **read cache plus write-staging buffer**, not a mirror of Postgres.
_Avoid_: "the local mirror", "the local replica of the schema" (it is neither a
mirror nor full parity).

**Sync worker**:
The worker context that runs the whole local-first engine — PGlite, the Local schema,
the Mutation journal machinery, the Electric shape streams, and the convergence loop. Its home is
capability-selected (the Engine home, ADR-0049): the SharedWorker attach point itself where that
scope grants sync-access handles, else an elected engine worker behind the same SharedWorker —
one engine per (user, origin) either way; absent `SharedWorker`, the engine falls back to the
in-process (main-thread) execution mode (ADR-0032 decision 2). Declared by the consumer with
`defineSyncWorker` (the registry is imported as code, never serialized in). _Avoid_: "the database
worker" — the worker owns the engine, not just the store; "its default home is a SharedWorker" —
placement is probed, not defaulted (see § Language — engine placement).

**Attach client**:
The tab-side facade over a Sync worker, returned by `attachSyncClient`: the same client shape as
the in-process `createSyncClient` (write API, Drizzle reads, live rows, status), with engine
events and the debug rail arriving over one broadcast bridge. The tab layer remains the single
auth owner — it pushes tokens to the worker; the worker never refreshes.

**Guarded read**:
A one-shot app-data read that passes the client's two read protections before executing: the read
gate (the local-read core must have finished booting, ADR-0041) and the lazy-group guard (the
compiled SQL — plus any declared `use` list — is scanned for lazy relations, which are activated
and awaited so a lazy relation is never read empty, ADR-0021). `query`/`queryRow`/`queryRaw`/
`queryRawRow` are guarded reads on both client forms; on the Attach client the guard runs
worker-side inside the read's single RPC round trip (ADR-0032).
_Avoid_: "safe read" (vague), and calling `rawQuery` a guarded read — that is the Inspection
surface, deliberately unguarded.

**Inspection surface**:
The raw, guard-free SQL pair `rawQuery`/`rawExec` (and the REPL adapter over them): identical on
both client forms, executed directly against the local store, bypassing the read gate, the
lazy-group guard, and the journal/overlay semantics — a write through it stays local and never
converges. For debug pages, REPLs, and ad-hoc counts; never an app-data read or write path.
_Avoid_: "raw reads" as a synonym for one-shot reads — a Guarded read is the app path; the
inspection surface is for humans looking at the store.

**Overlay**:
The local table holding the optimistic value of a staged write until the synced
echo arrives. The read model reads the overlay over the synced row.

**Mutation journal**:
The durable local log of staged mutations awaiting flush/ack. A reconcile trigger
clears overlay and journal rows once the read path echoes the applied row.
_Avoid_: "the outbox" (acceptable informally, but journal is the canonical term).

**Entity identity**:
The one canonical way a single synced row is named across the write path and the Convergence
model: the table's **server** primary-key columns, by column name, with typed values. It is the
same in every representation — the wire mutation, the in-database Mutation applier, the local
journal/overlay keys, and the per-entity sync-state. The public mutation API accepts the identity
by the app's property names and maps it to this canonical form **once**, at the boundary.
_Avoid_: keying an identity by drizzle property name anywhere past the API boundary, or by the
client `localPrimaryKey` for a writable table — the write path targets the server table, so the
server primary key is the identity.

**Read model**:
The generated view that unions the overlay over the synced table, so the app
reads a single consistent surface (optimistic where staged, synced otherwise).

**Convergence model**:
The single owner of how local optimistic state converges to server state. It holds the
Convergence barrier (the resolution rule) and exposes each entity's derived convergence
state — whether it is showing optimistic, acknowledged-but-not-yet-observed, converged,
pending-delete, or conflicted state. Read sync and write sync remain the two edges that feed
it, but neither independently decides whether an entity is resolved: the model is the one
authority, so observation and resolution can never disagree. Its convergence state is a
**derived projection**, never a stored copy.
_Avoid_: "control plane" / "entity store" — it is a model of resolution, not a storage layer
(that is the Local schema) and not a scheduler (that is the convergence driver, ADR-0005).

**Server version**:
A per-row token the server advances on every write to a writable synced table,
**strictly increasing per row** so it never repeats or moves backwards. It answers
exactly one question: has the synced read cache caught up to a particular acked write?
Every writable synced table carries one (conventionally `updated_at_us`); a writable
synced table without one is rejected, because optimistic convergence is unsound without it.
_Avoid_: "timestamp" / "updated time" — it is a version, not a wall-clock reading;
treating it as a clock reintroduces the skew bug the strict-monotonicity exists to avoid.

**Convergence barrier**:
The rule that resolves optimistic local state against server state: an acked write's
Overlay row and Mutation journal entry are cleared only once the synced echo's Server
version reaches that write's acked Server version — never merely because a row with the
same key appeared in the synced cache. A delete is resolved instead by the synced row's
absence (a deleted row has no Server version). The barrier is what stops a stale echo from
clearing an optimistic write before the real write has synced back.
_Avoid_: "echo gate" / bare "reconciliation" — reconciliation is the broader overlay/journal
cleanup; the barrier is specifically the Server-version comparison that gates it.

**Base server version**:
The Server version a mutation was authored against. For the first staged write on an entity it is the
synced version the user saw; for a write chained on an unacked one it is the version its predecessor
resolves to (known at flush, by Per-entity flush serialization). A write is **stale** when, at apply,
the row's current Server version has advanced past its base — someone else wrote in between.
_Avoid_: "the version the user saw" alone — for a chained write the base is the predecessor's version,
not the synced one, so an entity's own successive edits never self-conflict.

**Conflict policy**:
The per-table, **required** choice of what happens to a stale write. v1 offers `last-write-wins` (apply
anyway — a named choice, never a silent default) and `reject-if-stale` (reject and surface, keeping the
optimistic Overlay marked so the user's edit is never silently lost). `field-merge` and
`custom-resolver` are reserved for later.
_Avoid_: a silent or implicit default — silent last-write-wins is exactly the data loss the policy
exists to turn into a conscious decision.

**Store path**:
The only way a consumer names a local store: a plain path/name, never a storage URL. The name
never encodes the storage backend — in a browser the backend is capability-selected (ADR-0049:
`opfs-repacked` where the engine home holds sync-access handles, `idbfs` as the fallback), on
Bun/Node it is the filesystem; a scheme-bearing string is rejected at the boundary. Memory-backed
stores are not a product configuration — pgxsinkit's durability semantics (persistent retention,
the optimistic Mutation journal) assume a persisted store — and exist only behind the explicit
testing acknowledgment. _Avoid_: "dataDir" (retired from the public contract; a PGlite-internal
notion now), any `scheme://` URL in configuration or documentation examples, and "IndexedDB in a
browser" as the derivation rule (idb is the fallback, not the primary).

**Storage declaration**:
The registry-owned storage contract for a browser store (ADR-0049/0047): `storage.backend`
(`opfs` default, or `idbfs` to force IndexedDB) and `storage.durability` (`relaxed` default, or
`strict`). It lives on the registry, not on any minting surface, worker entry, or attach site,
because both properties follow the data: one declaration binds every open of every store minted from
that registry. It scopes the BROWSER store only — Node mints stay filesystem, export clones stay
memory. _Avoid_: calling it a placement mode (where the engine runs is a runtime decision, never
declared); a per-open, per-tab, or minting-surface option.

**Durability**:
The registry-declared property (`storage.durability`, ADR-0047) of whether a local write may be
returned before its physical flush lands. `relaxed` (default) relaxes flush TIMING, not persistence:
the loss window is only the writes not yet covered by a completed flush, and synced tables are
recoverable from the server by construction. `strict` awaits the flush per commit. A capability
fallback from opfs to idbfs keeps the declared durability. _Avoid_: treating it as a per-open,
per-tab, or per-table toggle — it is one registry declaration binding every open of the store.

**Store backup**:
The full-fidelity export of the whole local store (`exportStore`): everything the store holds,
staged writes and sync metadata included, restorable only into PGlite. The lossless option, and the
only export an offline device with unflushed writes can take.
_Avoid_: "snapshot" (collides with Electric's snapshot rows, ADR-0024); "database dump" (that is a
Diagnostic dump or Data export — a backup is a store image, not SQL).

**Diagnostic dump**:
The everything-as-SQL export (`exportDiagnostics`): synced tables, overlays, the Mutation journal,
views, triggers, functions, and engine metadata, exactly as the store holds them — evidence for a
human reading a misbehaving store, never an artefact for restoring one.

**Data export**:
The portable export (`exportData`): the synced tables and the enum types they depend on, schema and
data, nothing of pgxsinkit's machinery — loadable into a vanilla Postgres. Requires a **drained**
Mutation journal (not merely "nothing owed" — an acked write whose echo has not landed is still only
in the Overlay), or an explicit opt-out.
_Avoid_: "registry export" / "registry tables" — the registry is the spec, not the tables; the
things exported are the synced tables.

**Restore**:
Booting a client on a Store backup (`restoreFrom`), into a store that does not yet exist. A restored
engine always boots offline, and journal rows recovered from the backup are quarantined, never
auto-flushed — the write path has no mutation dedupe, so replaying them is not idempotent. Catch-up
after go-online is the ordinary read path, not a special mode.
_Avoid_: "import" — restore recreates a local store; loading a Data export into some Postgres is
outside the client's vocabulary.

**Parity boundary**:
The deliberate line dividing what the local schema enforces from what only the
server does. **Never local** (server authority): RLS/policies, triggers,
functions, materialized views, and managed-field values. **Not yet local** (gaps
to narrow, best-effort against the synced subset): static defaults, CHECK,
generated columns, FOREIGN KEY, and UNIQUE. The server is always the integrity
and security authority; the client only ever holds a filtered subset of rows.

## Language — engine placement

**Communication centre**:
The SharedWorker in its permanent role: the single attach point every tab bridges
to, and the router that connects those bridge ports to wherever the engine lives.
This role never moves, whatever the engine's placement.
_Avoid_: "the engine worker" (the engine may not live there).

**Engine home**:
Where `defineSyncWorker` actually runs for a given boot: in the SharedWorker
itself (handle-granted scopes — WebKit today) or in an elected engine worker
(handle-denied scopes — Chromium/Firefox today).
_Avoid_: "topology" for this axis (the topology — tabs → SharedWorker → engine —
is fixed; only the engine's home varies).

**Placement probe**:
The boot-time act of actually opening a sync-access handle in the SharedWorker's
own scope to decide the engine home. Always a real open, never method-presence
sniffing.

**Election coordinator**:
The one-per-tab-per-store owner of leader participation, shared by pre-attach
provisioning and attach: the leader lock is requested at most once per tab, and
attach adopts an existing grant and engine. While holding the lock it carries the
announce duty (re-announce to every new SharedWorker instance) and the single
keepalive.
_Avoid_: letting provision and attach each talk to `navigator.locks` (a tab
queuing behind itself is the bug this term exists to forbid).

**Leader lock**:
The per-store Web Lock the election coordinator queues on. Its grant elects the
tab that spawns the engine worker; its browser-side release on tab death is the
tab-liveness and succession mechanism. Distinct from (and layered above) the VFS
store-ownership lock.
_Avoid_: "appointment" (no tab is chosen by the communication centre).

**Elected engine worker**:
The tab-spawned dedicated worker holding the sync-access handles and running the
engine on handle-denied platforms. Spawned on lock grant only — never as a
per-tab hot spare.

**Engine identity**:
The PAIR (SharedWorker instance id, generation counter) naming one announced
engine. The generation counter is its scoped second component — monotonic only
within one SharedWorker instance — so authority and staleness checks always
compare the pair. Control and routing messages carry it; stale-identity messages
are discarded, never applied.
_Avoid_: "generation" alone for the authoritative object (code must compare both
fields; the bare counter resets with the SharedWorker).

**Handoff window**:
The attach-side state between a relocation notice (`leader-granted`,
`engine-retiring`, or an engine-loss verdict) and re-attachment to the
replacement engine. The ATTACH CLIENT owns it — the communication centre never
sees RPC payloads (per-tab pipes are direct): new calls queue locally (bounded);
pending ops are settled by OUTCOME — never-dispatched → `not-dispatched` (safe
retry), dispatched read → safe repeat, dispatched mutation with a lost response
→ `unknown` (inspect/reconcile, never auto-retried; there is no mutation-dedup
key). Old-pipe pendings are settled the same way on pipe replacement, never
replayed.
_Avoid_: "the router buffers calls" (it cannot see them); a blanket "retryable"
on relocation errors (a dispatched mutation's outcome is unknown).

**Leader keepalive**:
The one standing timer in the design: the lock holder's low-frequency ping to
the communication centre. A missed-ack threshold makes the LOCK HOLDER ITSELF
reconstruct the SharedWorker (worker factory seam), re-attach, and re-announce —
SharedWorker-death recovery is causal, never a bystander's job.
_Avoid_: "heartbeats" in the plural (non-leader tabs run none).

**Store meta record**:
The per-store record in a small dedicated IndexedDB database (readable in every
engine home), written at store CREATION for every backend — the first-use
authority fallback decisions key on. Its state is ONE total phase —
`idb-authoritative | opfs-candidate | adopting | opfs-committed | deleting` —
with `deleting` taking precedence over everything; destruction completes by
DELETING the record. A failed meta read is an ERROR (bounded retry, then fail
closed), never "no record". One of the two halves of commitment publication;
documented as independently losable, which is why an uninspectable commitment
namespace with a committed record fails hard.
_Avoid_: independent boolean fields (`committed` + `deletionIntent`
cross-products left precedence ambiguous — the phase is total).

**Commitment marker**:
The dual publication that commits a store to opfs: a sentinel file in the
toolkit-owned commitments namespace (`pgxsinkit/commitments/<identity>`,
disjoint from `pgxsinkit/stores/<identity>/` — the store directory itself
contains exactly the four VFS-owned files, and suffix-sibling naming collides
across valid identities), published first, then the Store meta record's
committed flag. Sentinel-without-record is a real crash state and reads as
committed (repair the record) — but sentinel authority applies ONLY when the
record is absent: a PRESENT record's phase is the total authority, so a
sentinel beside an `opfs-candidate` record (the fresh/restore barrier-gap
crash) means teardown-and-rebuild, stale sentinel deleted with the candidate.
A store directory without a sentinel is an uncommitted CANDIDATE — deleted and
rebuilt fresh, never granted authority. Once committed, any opfs boot failure
is a hard failure.
_Avoid_: "the directory exists" as a commitment test; any entry inside the store
directory as a marker; `<identity>.committed` sibling naming (collides with the
store path `foo.committed`).

**Adoption-bootstrap gate**:
The authority milestone for publishing an ADOPTED store's commitment — the one
provenance whose predecessor is deleted, so it alone requires the server:
authorized online reconstruction, meaning the initial catch-up of the eager
Consistency groups a valid initial store requires ("authorized" includes
legitimately anonymous/public shapes). Staged-readiness milestones never qualify
(`localReadReady` is deliberately offline-local; `ready` resolves immediately
under `syncEnabled: false`). Gate unmet → nothing publishes; idb stays
authoritative. Fresh and restored stores have their own provenance gates
(local init/recovery; backup load + restore recovery) and commit WITHOUT server
contact — all three then share one strict barrier: `strictSync()` returns →
sentinel → committed phase → exposure.
_Avoid_: one universal online gate (it stranded offline-first-boot writes and
contradicted Restore's authoritative offline boot); "every required group"
(name the eager Consistency groups).

**Adoption gate**:
The eligibility + drain conditions an existing idb store must meet — evaluated
pre-expose, so no mutation can race them — before the toolkit builds its opfs
successor (via normal server bootstrap, through the Adoption-bootstrap gate).
Eligibility is an explicit consumer declaration that the store is
server-reconstructible / its local-only data disposable, DEFAULT OFF — hook
absence is never authority (`rawExec` writes documented local-only state on any
store); without the declaration only the manual adoption API runs. The idb
store is deleted only after commitment is published.

**Destructive lifecycle**:
The one toolkit-owned deletion machine for explicit `destroy()`, AUTHORIZED
corruption recovery (the lifecycle owner explicitly approves recreation after a
fail-closed error — never automatic), and every recreate-only format break:
refuse owed mutations unless forced → stop admissions → quiesce/close the
engine → phase `deleting` → delete sentinel → delete store directory (or the
idb database — two backend branches of one lifecycle) → delete the meta record.
Resumable at every boundary — a boot that finds `deleting` completes the
deletion before anything else. SUPERVISED above the engine: the attached
`destroy()` resolves from the coordinator/communication-centre context that
survives engine shutdown, and refuses while other tabs hold claims. Required
because commitment authority lives outside the store directory: deleting only
the directory would leave a committed marker and fail every fresh creation
closed.
_Avoid_: destroy as an ordinary RPC whose responder closes itself; auto-deleting
a corrupt activated store.

**Drain predicate**:
In the journal's canonical status terms: rows in `pending`, `sending`, `failed`,
`quarantined`, or `conflicted` number ZERO; `acked` and `rejected` rows are
permitted (both settled — rejection is terminal). Echo-landing is NOT required
(the opfs successor is rebuilt from the server, which already holds every acked
write) — deliberately weaker than Data export's "drained", which reads local
tables.
