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
The reference application (`apps/web`) that drives the toolkit end-to-end for a
human to see. It is an exerciser, not the product.
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

**Parity boundary**:
The deliberate line dividing what the local schema enforces from what only the
server does. **Never local** (server authority): RLS/policies, triggers,
functions, materialized views, and managed-field values. **Not yet local** (gaps
to narrow, best-effort against the synced subset): static defaults, CHECK,
generated columns, FOREIGN KEY, and UNIQUE. The server is always the integrity
and security authority; the client only ever holds a filtered subset of rows.
