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
   tier is not deprecated. The tier is discriminated by which field a shape declares — `scope` for
   shared, `rowFilter` for private — and declaring both is refused at definition time, so a shape's
   tier is evident from its authoring and cannot be ambiguous.

3. **A shared shape's predicate is generated from its scope columns, so disjointness is structural
   rather than validated.**
   The author declares which columns are scope keys and, optionally, a static conjunct that is
   identical for every subscriber. The predicate is generated as an `AND` of equalities over the
   scope columns, with `NULL` a legal scope value (`group_id = NULL` compiles to `IS NULL`):

   ```ts
   shape: {
     scope: (c) => [c.offeringId, c.groupId],
     where: (c) => p.eq(c.published, true),      // optional; static, subscriber-independent
     entitledBy: /* decision 7 */,
   }
   // → offering_id = $1 AND group_id = $2 AND published = true
   ```

   `p` is pgxsinkit's own predicate builder, not Drizzle's operators, and the difference is forced by
   decision 1 rather than chosen: Drizzle's `eq` returns an `SQL` fragment, which compiles to *text*,
   and the native API takes an AST. Re-deriving the AST from that text would put in the control plane
   the very SQL lexer this ADR declines to depend on. `p` takes the same real column objects and
   emits the AST directly, so authoring stays at tier ① — no SQL string exists at any point — and the
   call sites read as they did (`p.eq(c.published, true)`). It is namespaced rather than exported as
   bare `eq`/`and`/`or` precisely because a registry file legitimately uses both these and Drizzle's,
   for RLS policies, and two same-named operators returning different things is a trap.

   The private tier needs the same treatment for the same reason: `rowFilter.customPredicate` is
   `customWhere`'s native sibling, claims in and a `Predicate` out. Neither tier emits SQL text on
   the native path.

   There is deliberately no syntax for anything else. Disjointness is then a property of the
   construction, not a rule some checker enforces: a row carries exactly one value per scope column,
   so it belongs to exactly one shape of a family, and an overlapping pair cannot be expressed at
   all. That is worth more than the expressiveness it costs — a validator that admits one
   overlapping predicate reintroduces ambiguous deletes silently, which is the failure class that
   concealed a real revocation-loss defect during the evaluation.

   Two things fall out of it. Offering-wide rows become their own scope `(O, null)` instead of
   appearing in every group's shape: the tempting `group_id IS NULL OR group_id = $G` form is not
   merely disallowed but *wrong*, since it places one row in every group shape at once. And a
   posture difference stops being a predicate difference — a moderator entitled to every group of an
   offering reads the same shapes a member reads, only more of them, so the disjunction that made
   such filters unshareable dissolves rather than needing decomposition.

   A predicate that cannot be expressed this way uses the private tier.

   Disjointness is what keeps the client simple. A row satisfies at most one of a subject's shared
   shapes, so deletes are unambiguous, unsubscribing from a scope is
   `DELETE … WHERE scope_col = $k` derived from the scope key itself with no bookkeeping column, and
   the generated local schema is untouched. Falling back to the private tier is a supported outcome,
   not a failure, and it is why that tier is permanent.

4. **Sharing moves multiplicity from the server to the client. That is the trade, stated plainly.**
   A subject in K scopes holds K subscriptions feeding one local table; the multiplicity does not
   vanish, it relocates. Local DDL, the `_synced`/`_overlay`/read-model triple, and per-query cost
   are unchanged.

   **The apply path already admits K:1 — measured, not assumed.** Shapes are keyed by shape name with
   a `tableKey` pointer, and every per-shape structure in the engine is keyed by shape already
   (`shapeInsertMethod`, `useInsert`, `truncateNeeded`, `messagesToCommit`, `moveInsToCommit`). No
   routing layer is missing. The apparent barrier — `"Already syncing shape for table"` in
   `packages/client/src/sync/index.ts` — is not a general one-shape-per-table rule: it guards exactly
   one thing, the default must-refetch `TRUNCATE ${target.table}`, which would wipe a co-tenant's
   rows. Its own filter already exempts a shape that brings `onMustRefetch`, and a test pins three
   shapes into one table under that exemption.

   The shared tier satisfies it **by construction**: the scope key derives the scoped clear
   (`DELETE … WHERE scope_col = $k`) with no bookkeeping column and no refcounting. So the client
   cost of this decision is a clear function, not a routing layer.

   Two provisos. The tag store was the remaining table-keyed structure — `clearShapeTags` keys by
   the synced table, so a must-refetch on one shape would have dropped a co-tenant's tags —
   which makes [ADR-0057](0057-retiring-tagged-subquery-reconciliation.md)'s retirement a
   *precondition* for K:1, not merely an adjacent simplification. And the boot gate across K shapes
   already exists: `isUpToDate` gates `onInitialSync` group-wide, which is ADR-0031's existing group
   alignment over a larger group, exactly as anticipated.

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

   *(Amended 2026-08-22.)* The rewriting origin is the stream gate's transform stage
   (`packages/server/src/circuits/edge.ts`): for a shape declaring `serverProjection.rowTransform` the
   edge parses the JSON long-poll body, runs the transform per row with the token's subject, strips
   `serverOnlyColumns`, and answers `private, no-store`; SSE is refused for such shapes.
   `RedactionSpec` — the declarative, pre-computed form — is not implemented; the escape hatch is the
   only transform path.

6. **The shared tier is authorized by capability, not by a per-request origin call.**
   - The control plane mints a shape handle carrying a **signed stream token** naming the scope
     values it grants. Default lifetime **5 minutes**, overridable per shape; re-minting is batched,
     so a subject with K scopes refreshes in one request per window. Validity is evaluated at
     request start.
   - *(Amended 2026-08-22.)* A re-mint re-authorizes both tiers: the shared tier against the live
     entitlement set, the private tier by recompiling the shape with the subject's current claims and
     comparing the fingerprint carried in the grant — a predicate that now denies, or now compiles
     differently, is revoked, and the client re-subscribes for the shape its claims compile to.
   - *(Amended 2026-08-22.)* **Closing a session releases the engine claims its subscribe acquired.**
     Each grant is one `POST /shapes` join and the engine's refcount blocks dormancy and eviction, so
     the session hands them back on close (`/sync/v1/release`, at most once, never retried — the
     engine's DELETE carries no claim identity, so a double release would take another subscriber's).
   - **The token must be excluded from the cache key.** Including it gives every subscriber a unique
     key and destroys the sharing this tier exists for. This is not an optimisation detail; it is a
     correctness condition for the tier.
   - Revocation latency is deployment-shaped and must be documented as such: behind a hit-serving
     third-party CDN it is bounded by the token TTL; behind a cache sitting *behind* our verifier it
     is entitlement-propagation latency.
   - Losing entitlement means losing the *subscription*, not losing rows. The client receives 403 on
     its next poll and must **truncate that scope and unsubscribe**. This is a different eviction
     path from predicate-driven move-out (ADR-0023), and the client implements both.
     *(Amended 2026-08-22: the clear happens at subscribe — persisted scopes the control plane no
     longer grants are cleared before the group reports ready; live revocation re-subscribes, see
     ADR-0056 d7.)*
   - **The client names a shape; the control plane expands it to the subject's scopes.** *(Amended
     2026-08-21. Subscribe originally took `(shapeKey, scope)` per subscription, leaving the client
     to supply scope values it had no sanctioned way to learn.)* A subscription request carries a
     shape key and nothing else, and a shared-tier shape fans out to one grant — one stream, one
     entry in the token — per scope the subject holds. The expansion belongs on this side because
     this side holds the entitlement set: a client naming its own scopes can only restate that set
     redundantly or contradict it, and every contradiction is a denial it then has to reconcile at
     boot. It also removes the last thing a client could have got wrong about what it may read.

     Two consequences worth stating. **K requests can return more than K streams**, so a client
     keying its subscriptions by shape key alone loses all but one of a fan-out. And **a subject
     holding no scope of a shape is refused, not granted an empty set** — returning zero grants
     silently would leave the client waiting on streams that were never created.

     `EntitlementSet` therefore enumerates as well as decides (`scopesFor` beside `permits`), and
     the two are required to agree. Where they disagree, subscribe refuses the scope: the edge
     checks `permits` on every read, so a scope only enumeration believes in would mint a capability
     for a stream that then 403s forever.

7. **The edge holds entitlements in memory, kept live as a Circuits shape, and fails closed.**
   The entitlement relation syncs into the edge through the same engine that serves everything else.
   Checks are an in-memory lookup with no database on the read path, and freshness is engine
   propagation rather than a cache TTL.

   Because the edge is TypeScript (decision 8), an entitlement rule is **an ordinary typed function**
   over those synced relations — authored in Drizzle terms beside the registry it belongs to:

   ```ts
   entitledBy: {
     relations: [offeringMembership, groupMembership],
     scopesFor: (claims, r) => {
       const person = readPersonId(claims);
       if (person === null) return [];                       // deny: no scopes
       return r.offeringMembership.byPerson(person).flatMap((m) => [
         { offeringId: m.offeringId, groupId: null },         // offering-wide
         ...(isTeaching(m.membershipRole)
           ? r.groups.byOffering(m.offeringId).map((g) => ({ offeringId: m.offeringId, groupId: g.id }))
           : r.groupMembership.byPerson(person).map((g) => ({ offeringId: m.offeringId, groupId: g.groupId }))),
       ]);
     },
   }
   ```

   Returning `[]` denies, so the anonymous and unentitled cases are the same code path as any other.
   No expression mini-language, no derived entitlement tables, and no triggers maintaining a
   denormalised copy that could drift from its source. Circuits shapes can only source from base
   tables carrying a primary key (`pg.rs`: base tables with `indisprimary`), so the relations synced
   are the membership tables themselves, which already satisfy that. While that subscription is catching up, degraded, or stale,
   the edge **denies**: an unavailable entitlement set is never a permit.

8. **The edge is a thin stateless process in front of a stock durable-streams server. We fork
   neither.**
   - TLS, HTTP/2 and HTTP/3 terminate at the gateway (istio, for our deployments). They are not the
     edge's concern and no protocol work belongs in it.
   - The edge verifies the token, checks the scope against the entitlement set, and proxies bytes.
     With redaction pre-computed and predicates resolved at shape creation, there is no per-read
     filtering and no per-read rewriting (except transform shapes — decision 5): it is a gate, not a
     pipeline.
   - **It is TypeScript, in the existing `packages/server` process, alongside the control plane.**
     Because there is no per-byte work, CPU is irrelevant here — the only axis on which a native
     implementation wins is memory per held long-poll connection, and that crossover sits far above
     the target scale (order 4 GB fleet-wide at ten thousand concurrent subscribers, against roughly
     0.8 GB; it only dominates near a hundred thousand). Against that, co-locating with the control
     plane — which MUST be TypeScript, since it interprets the Drizzle registry and builds the
     predicate AST — collapses two services into one, turns ADR-0056's barrier read into a local
     call, makes the registry directly available for shapeKey resolution, and keeps token minting
     and verification in one process sharing key material.

     The costs are named rather than hidden: the read path's availability depends on a Node/Bun
     process, and GC pauses sit in the path of held long-polls. Neither binds at this scale. The
     edge is roughly 500–1500 lines of gate logic, so moving it to a native implementation later is
     a contained rewrite, not an architecture change — which is what makes choosing the simpler
     option now cheap to reverse.
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
| A5 | Egress `rowTransform` | Decision 5: arbitrary transforms mark the shape private-tier (enforced at definition) and are rewritten at the stream edge per read, `no-store` |
| A6 | Mandatory-posture invariant | **Preserved and extended** — the disjointness check joins it |
| A7 | `serverOnlyColumns` | Native: emitted onto the stream so the transform can read them, stripped at the edge after it runs |
| A8 | `omitColumns` | Native `ShapeDef.columns`. The A5→A8 ordering hazard is **answered in one place** — the edge transforms, then strips |
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
- **No new service and no new language.** The edge is ~500–1500 lines added to the existing
  TypeScript server beside the control plane, rather than a second process to build, deploy and
  observe. What we accept in exchange is a Node/Bun process on the read path — GC pauses in the path
  of held long-polls, and connection memory roughly 5× a native implementation's, which only becomes
  the binding constraint an order of magnitude above the target scale.
- **Two eviction paths exist on the client** — predicate move-out and shape-level revocation — and
  both must be tested. A revocation path that silently fails is a disclosure, not a stale row.
- **Redaction changes shape from code to schema.** Changing a `RedactionSpec` becomes a migration
  with a backfill, rather than a deploy. This is a real cost, accepted because it removes redaction
  from every read.
- **Schema-bound registries cannot cut over until the engine gains qualified table names.** This is
  a **blocker**, not a limitation to note. Circuits keys a table by its bare name end to end: it
  introspects `information_schema` with `table_schema = 'public'`, and its replication decoder
  *parses* the relation namespace off the wire and then discards it (`replication.rs:233`), so two
  same-named tables in different schemas collide silently rather than erroring. But
  `SyncRegistryDefinition.schema` is the **Postgres source** schema — `attachSyncRegistrySchema`
  validates it against the Drizzle table's own schema and qualifies the shape target from it — so a
  non-`public` registry is a shipped pgxsinkit feature, and Electric supports it today. Cutting over
  without the engine change is therefore a **regression**, not a deferral.

  Until then the control plane refuses such a shape and names the reason, rather than sending a name
  that would fail deep inside shape creation. The engine change is scoped in
  [backlog/0009](../backlog/0009-circuits-schema-qualified-tables.md) — roughly a day, mostly
  mechanical, since the namespace is already on the wire. Nothing in this ADR's design depends on the
  answer; the predicate AST references columns of one already-resolved table either way.

  No rationale for the restriction exists anywhere upstream — no ADR, note, or commit message — and
  the maintainers have not replied. The code reads as an alpha shortcut rather than a decision (a
  namespace decoded and thrown away; a compat adapter that silently *strips* a foreign schema instead
  of rejecting it), which suggests a fix would be welcome upstream. That is inference from the source,
  not something we have been told, and it should not be relied on when planning the fork's
  maintenance burden.
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
  plugin is an ordinary `caddyhttp.MiddlewareHandler` and composes cleanly. Rejected because it puts
  the gate in a third language and a separate process, away from the registry and the token-minting
  key material it has to agree with, while istio already terminates TLS/h2 so Caddy's protocol
  features earn nothing here.
- **A native (Rust) edge as its own service.** Rejected for v1: the edge does no per-byte work at
  all — no filtering, no rewriting, no parsing of stream content — so CPU is irrelevant and the only
  axis on which it wins is connection memory, well above the target scale. It also forgoes
  co-location with the control plane, which must be TypeScript regardless. Recorded as the answer if
  held-connection memory ever becomes binding; the gate is small enough that the move is a contained
  rewrite rather than an architecture change.
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
3. ~~**Whether ADR-0023's tag reconstruction can be retired.**~~ **Resolved** by
   [ADR-0057](0057-retiring-tagged-subquery-reconciliation.md): retired entirely. The shared tier has
   no subqueries to reconcile, and the private tier's evictions arrive as explicit deletes, verified
   across the offline gap on a native stack.
4. **The shape of the entitlement relation** the edge subscribes to: one canonical `(subject, scope)`
   projection, or per-shape-family relations. Decision 6's amendment sharpens rather than settles
   this: the set must now **enumerate** a subject's scopes, not only answer yes/no about one, and a
   canonical `(subject, shapeKey, scope)` projection supports that directly while a per-family rule
   computed on demand has to be invertible to. The invalidation question underneath it is untouched
   — a rule reading a relation *transitively* has no subject to key a memo by.
5. **Migration sequencing** for existing consumers. Clients resync from scratch at cutover, which
   removes most of the difficulty, but the order of server, edge, and client rollout is unspecified.
