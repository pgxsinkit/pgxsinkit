# A Circuits-native sync core, with a shared read tier

Status: accepted (2026-08-20)

## Context

pgxsinkit's read path is built on the Electric sync service. Two things force a change, and the
second matters more than the first.

**The substrate is being retired.** ElectricSQL's Elixir sync service is shelved following the
Databricks acquisition; their stated forward path is `electric-circuits` (Rust, DBSP dataflow) over
`durable-streams`. Circuits is alpha, but it is where maintenance is going.

**Our read architecture cannot use an HTTP cache — structurally, not incidentally.** The governing
invariant is that **a stream is shareable and cacheable if and only if its bytes are
user-independent**: the cache key is the URL, so bytes are shared exactly as far as URLs are.
pgxsinkit makes bytes user-dependent in three independent places, and any one of them alone defeats
caching:

1. **The predicate.** `rowFilter(claims)` bakes the subject into the `where`. This is *necessary*
   for data whose row set genuinely differs per user, and *accidental* for scope-shared data — where
   the subject appears only as an authorization gate and every member of the scope sees identical
   rows.
2. **Egress rewriting.** `rowTransform` and `omitColumns` run per request, in the proxy.
3. **Auth placement.** Every read traverses the proxy for a per-request check, so every request
   reaches origin even when the bytes would have been cacheable.

The contract can express only the private tier. A shape whose rows are identical for 10 000 users
still gets 10 000 URLs, 10 000 shapes, and 10 000 origin reads.

Adopting Circuits improves the *constant* substantially. Measured on a release build, N=200 cold,
distinct filter parameter per subscriber (`docs/research/0001`):

| N=200, cold | Electric 1.7.11 | Circuits |
|---|---|---|
| RSS per shape | 386 KiB | **81 KiB** |
| shape creation | 39 ms/shape | **4.5 ms/shape** |
| propagation p95 | 0.16 s | 0.16 s |

So 10 000 users extrapolates to ~0.8 GiB of shape state rather than ~3.8 GiB. Real, but it does not
change the asymptote: shape count still tracks user count, and no read is ever cacheable.

What caching would buy is not hypothetical. A catch-up read (`offset=-1`) against
`durable-streams-server` 0.1.5 returns:

```
cache-control: public, max-age=60, stale-while-revalidate=300
etag: "3785364913788960:0:16"
stream-next-offset: 0000000000000000_0000000000000016
```

`public`, with stale-while-revalidate, on exactly the read where the bytes are — boot and catch-up.
A per-user URL can never hit it.

Two further facts shape what follows. Circuits' native API **already** collapses identical shape
definitions onto one stream by ref-count — it simply never gets the chance, because pgxsinkit never
generates identical predicates. And every defect found during the evaluation lives in Circuits'
**Electric compatibility adapter** (`apps/engine/src/electric.rs`), which the native path never
executes.

## Decision

1. **Target Circuits' native API; retire the Electric-compatible read path.**
   Shape lifecycle goes through `POST /shapes` with the protocol's predicate AST; reads are served
   from durable-streams. The engine's `/v1/shape` adapter — and `where_sql.rs`, its SQL-text lexer,
   whose sole caller it is — is not on our path. This is not a workaround for the four defects found
   there; it is a path that never reaches them. (They were fixed and contributed upstream anyway,
   for compat consumers.)

   There is no Electric fallback, and this is a one-way door: `/v1/shape` is served by the *engine*,
   while our reads terminate on *durable-streams*. The two topologies are mutually exclusive.

2. **Two read tiers, both first-class. A shape declares which it is.**
   - **Private tier** — today's fused contract, unchanged. `rowFilter(claims)` yields a per-subject
     predicate; one shape per subject; uncacheable by nature. Correct for data whose row set
     genuinely differs per user, which is most data.
   - **Shared tier** — the predicate is a function of **scope parameters only**, never of claims. A
     separate **entitlement rule** maps claims to the scope values a subject may read. One shape per
     scope value, shared by every entitled subject, which lands directly on Circuits' existing
     ref-counted sharing.

   The library ships both permanently. Neither is a migration target for the other, and the private
   tier is not deprecated.

3. **The shared tier requires disjoint scopes, enforced at definition time.**
   A shared shape's predicate must be equality over declared scope columns that are present on the
   row; anything else is refused when the registry is defined — the posture `serverProjection`'s
   mandatory invariant already takes.

   Disjointness is what keeps the client simple. A row satisfies at most one of a subject's shared
   shapes, so deletes are unambiguous, unsubscribing from a scope is
   `DELETE … WHERE scope_col = $k` derived from the scope key itself with no bookkeeping column, and
   the generated local schema is untouched. A predicate that cannot be made disjoint — an
   irreducibly per-person disjunct, or overlapping scopes — uses the private tier. That is a
   supported outcome, not a failure, and it is why the private tier is permanent.

4. **Sharing moves multiplicity from the server to the client. That is the trade, stated plainly.**
   A subject in K scopes holds K subscriptions feeding one local table; the multiplicity does not
   vanish, it relocates. The apply path gains shape→table K:1 routing, per-scope deletion, and a
   boot gate across K shapes — the last being ADR-0031's existing *group* catch-up alignment with a
   larger group. Local DDL, the `_synced`/`_overlay`/read-model triple, and per-query cost are
   unchanged.

5. **Redaction is pre-computed in Postgres, and its specification is declarative.**
   `RedactionSpec` — a predicate over the row (and where required, claims), a null-out column set,
   JSON-pointer removals, and an explicit fail-closed policy — compiles to DDL: an `IMMUTABLE`
   function plus a generated column. Shapes project the already-redacted column and split by
   predicate on the control column, which `ShapeDef.columns` permits them to match on without
   emitting it.

   Redaction then costs one computation per write rather than one per read per subscriber,
   unredacted values never enter durable-streams storage at all, and neither Circuits nor the ds
   server needs to know redaction exists. Claims-conditional redaction stays expressible: a claims
   domain with small finite range is a small finite set of shapes over pre-computed projections.

   **Arbitrary `rowTransform` survives as an escape hatch.** A shape declaring one is *thereby* a
   private-tier shape and routes through a rewriting origin. The capability is not removed; its cost
   is made explicit and confined to the shape that incurs it.

6. **The shared tier is authorized by capability, not by a per-request origin call.**
   - The control plane mints a shape handle carrying a **signed stream token** naming the scope
     values it grants. Default lifetime **5 minutes**, overridable per shape; re-minting is batched,
     so a subject with K scopes refreshes in one request per window. Validity is evaluated at
     request start.
   - **The token must be excluded from the cache key.** Including it gives every subscriber a unique
     key and destroys the sharing this tier exists for. This is not an optimisation detail; it is a
     correctness condition for the tier.
   - Revocation latency is deployment-shaped and must be documented as such: behind a hit-serving
     third-party CDN it is bounded by the token TTL; behind a cache sitting *behind* our verifier it
     is entitlement-propagation latency.
   - Losing entitlement means losing the *subscription*, not losing rows. The client receives 403 on
     its next poll and must **truncate that scope and unsubscribe**. This is a different eviction
     path from predicate-driven move-out (ADR-0023), and the client implements both.

7. **The edge holds entitlements in memory, kept live as a Circuits shape, and fails closed.**
   The entitlement relation syncs into the edge through the same engine that serves everything else.
   Checks are an in-memory lookup with no database on the read path, and freshness is engine
   propagation rather than a cache TTL. While that subscription is catching up, degraded, or stale,
   the edge **denies**: an unavailable entitlement set is never a permit.

8. **The edge is a thin stateless process in front of a stock durable-streams server. We fork
   neither.**
   - TLS, HTTP/2 and HTTP/3 terminate at the gateway (istio, for our deployments). They are not the
     edge's concern and no protocol work belongs in it.
   - The edge verifies the token, checks the scope against the entitlement set, and proxies bytes.
     With redaction pre-computed and predicates resolved at shape creation, there is no per-read
     filtering and no per-read rewriting: it is a gate, not a pipeline.
   - durable-streams runs as its own workload from the **official published image**
     (`electricax/durable-streams-server-rust`), pinned **by digest** and mirrored rather than
     rebuilt. It is stateful — WAL, shard files, object-store tier; the edge is stateless and
     replica-scaled. Fusing them would make the stateless tier inherit the stateful tier's sharding
     constraints, trading horizontal scalability of authorization for the removal of one localhost
     hop.
   - Network access to durable-streams is restricted to the edge's service account. The ds protocol
     has **no read authorization in any implementation** — a protocol-level decision (PROTOCOL.md
     §12.1) — and shape stream paths are a monotonic counter (`shape/s1`, `shape/s2`, …), so they
     are enumerable rather than capability-bearing. §12.2 states the obligation directly: guessable
     URLs oblige the server to enforce access control.

9. **Which durable-streams implementation we run is deployment configuration, gated by conformance.**
   Two are official: the Caddy plugin (designated *production* in the durable-streams README) and the
   Rust server (ElectricSQL's own, in `electric-sql/electric`, and what Circuits' stack runs). We run the Rust server at the version our fork's
   suite exercises, and make `packages/server-conformance-tests` passing the acceptance gate.
   Switching is configuration, not rework — the edge speaks plain HTTP to whichever.

10. **The client consumes durable-streams directly.**
    `@durable-streams/client` supplies the raw transport — long-poll, offsets, backoff — and nothing
    above it. Everything above remains pgxsinkit's: ShapeInbox, the fold, apply modes, tag
    reconciliation, boot staging. This is ADR-0009's precedent applied to a new substrate: keep the
    transport, internalize the semantics. `@electric-circuits/client` is **not** adopted; it carries
    `@tanstack/db` and a store model that would displace the PGlite apply path.

    Two properties of that package were **verified before adopting it**, because both are
    correctness requirements rather than conveniences:

    - Its backoff retries **only** 429 and 503 (`HTTP_RETRY_STATUS_CODES`); every other 4xx is
      thrown immediately. So a 403 on an expired stream token surfaces to us and can trigger a
      re-mint, instead of being swallowed into a retry loop that would present first as a stall and
      then as data loss.
    - `HeadersRecord` accepts async thunks (`string | (() => MaybePromise<string>)`), resolved
      afresh on every request. That is exactly the read-path token refresh ADR-0013 requires —
      re-resolved per request, never frozen at boot.

    The package deliberately mirrors `@electric-sql/client`'s API (its own comment says so for
    dynamic params) and exports the same `BackoffDefaults` symbol pgxsinkit already imports, so this
    is closer to substitution than rewrite. Its write half (`idempotent-producer.ts`, ~849 lines) is
    unused — we write to Postgres — and tree-shakes away; `SequenceGapError` and `StaleEpochError`
    are producer-side and do not apply to us.

    What it does **not** provide is multi-stream coordination: there is no `MultiShapeStream`
    equivalent, so the K-shapes-into-one-table layer of decision 4 is ours to build either way.

## What happens to every existing capability

Nothing in the current contract is dropped. Where a capability moves, it moves to a place that
expresses it better.

**Server / proxy**

| | Capability | Disposition |
|---|---|---|
| A1 | Fail-closed ingress, verified claims | Splits: token verification at the edge; claims → predicate/scope at the control plane |
| A2 | Registry-derived filter, client `where` discarded | Control plane builds the predicate AST at shape creation. **Strengthened** — no `where` exists on the wire to discard |
| A3 | `shapeKey` resolution, 403 on undeclared | Control plane; unchanged in intent |
| A4 | Query-param allowlist | Largely dissolves — the client asks for a shapeKey and scope, not URL parameters |
| A5 | Egress `rowTransform` | Decision 5: declarative spec pre-computed in Postgres; arbitrary transforms mark the shape private-tier |
| A6 | Mandatory-posture invariant | **Preserved and extended** — the disjointness check joins it |
| A7 | `serverOnlyColumns` | Native: `ShapeDef.columns` matches on columns it does not emit |
| A8 | `omitColumns` | Native `ShapeDef.columns`. The A5→A8 ordering hazard **dissolves** |
| A9 | `electricTable` physical-target mapping | Preserved; maps to `ShapeDef.table` |
| A10 | Timing / observability | Edge and control plane |

**Client read path**

| | Capability | Disposition |
|---|---|---|
| B1 | Transport, resume from `(handle, offset)` | `@durable-streams/client` offsets |
| B2 | LSN frontier, ADR-0031 catch-up alignment | **Requires rework** — see open questions. The largest single item |
| B3 | `foldChangeBatch` (ADR-0014) | Unchanged |
| B4 | `applyMode`, COPY tier (ADR-0045) | Unchanged |
| B5/B6 | Move-out / move-in (ADR-0023/0024) | **Simplified** — Circuits emits an explicit `delete` on catch-up (verified), so tag reconstruction may be reducible. Shape-level revocation is added alongside |
| B7/B8 | Lazy/ephemeral, session metadata (ADR-0021/0042) | Unchanged |
| B9/B10 | Staged boot, BootReport (ADR-0041/0034) | Extended across K shapes per table |
| B11 | Token refresh (ADR-0013) | Extended — stream-token re-mint joins JWT refresh |
| B12 | Stall detection / nudge | Unchanged |
| B13 | `must-refetch` → truncate + re-snapshot | Maps onto engine/ds 409 semantics |
| B14 | Registry-version rebuild (ADR-0006) | Unchanged |

**Registry** — `defineReadProjection` (C1, ADR-0027), `asReadonly` (C2, ADR-0025), `conflictPolicy`
(C3), `managedFields` (C4) and `clientProjection.localPrimaryKey` (C5) are all unchanged. C1 in
particular is *better* served: a read projection is a distinct shape, which the native API models
directly rather than through physical-target disambiguation.

**Write path — unchanged.** Postgres-mode writes stay SQL through the existing mutation API; the
engine tails logical replication; mutation echo was validated against Circuits during the
evaluation.

## Consequences

- **The fan-out ceiling is lifted for scope-shared data.** Shape count for the shared tier scales
  with structure (scopes) rather than population (subjects), and catch-up reads become CDN-cacheable
  for the first time.
- **Per-client connection count rises.** K subscriptions is K concurrent long-polls; durable-streams
  serves one stream per request, and the Rust server is HTTP/1.1-only with no TLS. A gateway
  speaking HTTP/2 to browsers is therefore **mandatory**, not optional — without it a subject with
  several scopes hits the browser's ~6-connection-per-origin ceiling and stalls.
- **We take on a small Rust service** (~500–1500 lines) plus its deployment, in exchange for not
  forking a 16k-line protocol implementation and not putting TypeScript on the hot read path.
- **Two eviction paths exist on the client** — predicate move-out and shape-level revocation — and
  both must be tested. A revocation path that silently fails is a disclosure, not a stale row.
- **Redaction changes shape from code to schema.** Changing a `RedactionSpec` becomes a migration
  with a backfill, rather than a deploy. This is a real cost, accepted because it removes redaction
  from every read.
- **We depend on alpha software in two places.** Circuits is 0.x; the Rust ds server is 0.1.5 with
  271 total downloads. Mitigations: we run our own fork of Circuits, we pin ds by digest, and
  conformance is an acceptance gate rather than an assumption.
- **The Rust ds server is fully sourced and fixable upstream.** It is developed in ElectricSQL's
  main monorepo — `electric-sql/electric`, `packages/durable-streams-rust`, Apache-2.0 — rather than
  in the durable-streams protocol repo, which carries the protocol and its JS/Go servers. That split
  is why it is absent from the protocol repo's server table. The crate's `.cargo_vcs_info.json`
  names its exact publish commit (`3ef7614c`, 2026-07-08, "chore: publish new package versions"
  #4689), which is public, so a defect we hit is reportable and fixable on the same footing as the
  engine fixes. The published tarball omits a copy of the licence text despite its Apache-2.0
  declaration — a trivial packaging nit worth reporting, not a constraint on use.

## Alternatives considered

- **Stay on Electric, or keep the compat adapter as a fallback.** Rejected: the substrate is shelved,
  and the fallback is not architecturally available — `/v1/shape` is served by the engine while our
  reads terminate on durable-streams. Maintaining both means maintaining two read topologies.
- **Adopt Circuits but keep the fused `rowFilter` contract.** Rejected as the *whole* answer: it
  captures the 4.8× constant-factor win and none of the structural one, leaving every read
  uncacheable. Retained as the **private tier**, which is the right home for it.
- **Fork the Rust durable-streams server and put auth inside it.** Rejected: the crate is
  binary-only (no lib target), so this is a true source fork of ~16k lines including a hand-rolled
  HTTP/1.1 core; it would require retrofitting TLS and h2 into exactly that core; and it fuses a
  stateless authorization tier with a stateful storage tier, so authorization could then only scale
  by sharding storage.
- **A Caddy auth module in front of the stock `durable_streams` handler.** Genuinely viable — the
  plugin is an ordinary `caddyhttp.MiddlewareHandler` and composes cleanly. Rejected for language
  coherence with the rest of the edge, and because istio already terminates TLS/h2 in our
  deployments so Caddy's protocol features earn nothing here. Recorded as the fallback if the Rust
  edge proves a poor investment.
- **Per-request origin authorization for the shared tier.** Rejected: it is precisely what makes
  every read an origin read. Correct and available for the private tier, where nothing is cacheable
  anyway.
- **Entitlement carried as JWT claims.** Rejected: token size grows with membership (a learner in
  fifty scopes carries fifty entries on every poll) and revocation is bounded by token TTL with no
  better bound available.
- **Grants materialised by the control plane at subscribe time.** Rejected: grants are a derived
  copy of membership, so something must reconcile them on every membership change; a missed delete
  is a disclosure. Syncing the source relation removes the copy.
- **Embedding a JS engine in the edge to run existing `rowTransform` functions.** Rejected: it
  preserves arbitrary code at the cost of a JS runtime on the hot read path, and still yields no
  static analysis — so it buys process consolidation without buying shareability.
- **Decomposing non-disjoint predicates into several shapes** (union view over per-branch tables, or
  one table with per-shape presence refcounting). **Deferred, not rejected.** Union costs duplicate
  storage and a `DISTINCT ON` on every read in single-threaded WASM Postgres; refcounting is faster
  but its failure mode is silent row loss masked by local history — the W9 signature. The private
  tier covers these cases today; revisit only if a real workload demands it.
- **Adopting `@electric-circuits/client`.** Rejected: it depends on `@tanstack/db` and a store model
  that would displace the PGlite apply path, discarding ADR-0014/0023/0024/0031/0041/0045. We take
  the transport only.

## Open questions

These are deliberately not decided here.

1. **ADR-0031's watermark and commit-floor alignment against ds offsets and Circuits envelopes.**
   The existing design floors on Electric's `lsn` / `global_last_seen_lsn` headers; Circuits carries
   `txid` and commit LSN through a different envelope, and ds contributes its own offset ordering.
   This is the largest remaining piece of client work and needs its own ADR.
2. **Registry syntax** for declaring scope parameters, the claims-free predicate, and the entitlement
   rule — and where the disjointness checker runs.
3. **Whether ADR-0023's tag reconstruction can be retired** now that the engine emits explicit
   deletes on catch-up, or whether it must remain for cases the explicit delete does not cover.
4. **The shape of the entitlement relation** the edge subscribes to: one canonical `(subject, scope)`
   projection, or per-shape-family relations.
5. **Migration sequencing** for existing consumers. Clients resync from scratch at cutover, which
   removes most of the difficulty, but the order of server, edge, and client rollout is unspecified.
