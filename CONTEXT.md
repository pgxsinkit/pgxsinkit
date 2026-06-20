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

**Read model**:
The generated view that unions the overlay over the synced table, so the app
reads a single consistent surface (optimistic where staged, synced otherwise).

**Parity boundary**:
The deliberate line dividing what the local schema enforces from what only the
server does. **Never local** (server authority): RLS/policies, triggers,
functions, materialized views, and managed-field values. **Not yet local** (gaps
to narrow, best-effort against the synced subset): static defaults, CHECK,
generated columns, FOREIGN KEY, and UNIQUE. The server is always the integrity
and security authority; the client only ever holds a filtered subset of rows.
