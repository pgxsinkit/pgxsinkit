# Secured sync ingress: fail closed, one verified-claims adapter

Status: accepted (2026-06-22)

The read path (the Electric shape proxy) and the write path (the mutation route)
are two ingress points that must both answer the same question: *who is this
caller, and what are they allowed to see or do?* Today they answer it twice, in
separate code, and the read path can answer "everything" by accident.

`createSyncServer` owns only the mutation route (`packages/server/src/index.ts:143`)
and accepts `resolveAuthClaims` (`:44`). It does **not** register the Electric
proxy. The proxy (`proxyElectricShapeRequest`) is exported as a loose function
(`:245`) that every consumer must wire by hand. The demo does exactly that: a
second Hono app, a hand-rolled `/v1/electric-proxy` route, and a **second** claim
resolution via `parseDemoAuthClaimsFromRequest`
(`apps/write-api/src/server.ts:39-65`, `:27`, `:52`). Nothing forces the read and
write claim resolution to agree.

Worse, the proxy fails **open**. `buildProxyTargetUrl` copies every incoming
param — `table`, `where`, `columns` — onto the Electric URL
(`packages/server/src/electric-proxy.ts:87-89`) and then, when the requested table
is absent from the registry, returns the URL **unchanged** (`:97-101`). The
pre-existing `electricUrl` params, including the secret Electric API token, are
preserved (proven by `tests/unit/electric-proxy.test.ts:38-61`), so an unregistered
`table=…&where=…` is forwarded to Electric with the proxy's credentials and no
owner filter. No unit test pins fail-closed behaviour.

Maintainer decisions (2026-06-22):

- **Q1 — No.** A table absent from the registry must not be reachable through this
  proxy. If a deployment wants passthrough, that is a *separate, independent* proxy.
- **Q2 — No.** The proxy is the **sole** credentialed path to Electric, so this is a
  critical fail-open, not a theoretical one.
- **Q3 — No.** Read and write claim resolution must never differ per deployment.

A related hazard sits adjacent: `RowFilterSpec.customWhere` returns raw SQL text
(`packages/contracts/src/config.ts:145`) interpolated straight into the Electric
`where` param (`electric-proxy.ts:109-121`). Escaping and fail-closed behaviour are
pushed onto downstream code, and request-derived `extraParams` are an injection
surface.

## Decision

1. **The secured ingress is single-purpose: it serves only registry-governed
   shapes.** A shape request for a table not present in the sync registry is
   rejected (HTTP 403), never forwarded. A request with no `table` is rejected
   (HTTP 400). A table that *is* in the registry but declares no `rowFilter` still
   streams — the deliberate "public table" case. **The gate is registry
   membership, not the presence of a filter.**

2. **Forwarding unknown tables is explicitly not an extension mechanism of this
   module.** A deployment that wants unfiltered passthrough stands up a separate,
   independent proxy; pgxsinkit's secured ingress never grows that mode (it would
   couple two operational concerns and reduce locality).

3. **One verified-claims adapter serves both paths.** `createSyncServer` owns the
   Electric proxy route alongside the mutation route and resolves claims once via
   the single `resolveAuthClaims`. The read and write paths cannot diverge because
   there is one resolver. `createSyncServer` gains an `electricUrl` (and proxy
   path) option; consumers stop hand-rolling a second Hono app and a second claim
   resolution.

4. **Fail-closed is a tested invariant.** The unit suite asserts that an
   unregistered table is rejected *without an upstream fetch*, and that a
   registered-but-unfiltered table still forwards. The interface is the test
   surface.

5. **`customWhere` raw SQL is repositioned as an escape hatch.** The injection
   surface is documented, and a safe-by-default owner/shared filter path is
   provided so `customWhere` is the rare, explicitly-opt-in case rather than the
   default way to filter. (Phased in the plan; not all of it lands in the first
   increment.)

## Consequences

- The read path can no longer leak a table its registry author never reasoned
  about. The blast radius of the proxy is exactly the declared registry.
- Consumers get a smaller, safer surface: pass `electricUrl` to `createSyncServer`
  instead of assembling Hono glue. The demo shrinks.
- One-resolver coupling is intentional (Q3); a deployment that genuinely needed
  different read/write identity would be a different design and is out of scope.
- `customWhere` stays powerful but the common ownership case never touches raw SQL.

## Implementation status

All five decisions are implemented. Decisions 1 and 4 (fail closed on
unregistered/absent tables) landed first, pinned by
`tests/unit/electric-proxy.test.ts`. Decision 3 — `createSyncServer` owns the shape
proxy via an `electricUrl` option and shares the single `resolveAuthClaims`, and the
demo drops its hand-rolled second Hono app — is pinned by
`tests/unit/server-shape-proxy.test.ts`. Decision 5 strengthens the `customWhere`
injection warning and pins the safe-by-default `ownership`/`shared` escaping in
`tests/unit/contracts.test.ts`. `proxyElectricShapeRequest` stays exported for
advanced/manual hosting (the integration harnesses use it directly).

**Post-review hardening (2026-06-22).** A review found the fail-closed gate did not fully
secure *authorization*. The proxy merged the client-supplied `where` into the ownership
predicate (`(<client>) AND (<owner>)`), so a crafted `where=1=1) OR (1=1` reduced — by
`AND`/`OR` precedence — to all-rows; and table allowlisting stripped the schema, so
`private.authors` was authorized by an `authors` entry. Both are fixed: the client `where`
is **never** forwarded (raw untrusted SQL cannot be safely merged into an auth predicate —
the registry row filter is the sole authority), and allowlisting now matches the **exact**
declared Electric target with no schema stripping. Pinned by the precedence-bypass and
schema-qualified-rejection cases in `tests/unit/electric-proxy.test.ts`.

**Post-review hardening (ISS-08, code landed 2026-06-24).** A later pass found the proxy still
forwarded every client query param except `where` (`buildProxyTargetUrl`), so a client could set
`columns`, `replica`, or arbitrary params on the upstream Electric request — ambient authority the
registry never granted. The proxy now **derives every shape-defining param from the registry**
(`table` and `where`, plus an explicit `columns` projection where one is declared) and forwards
**only** an allowlist of Electric protocol resume/control params (`offset`, `handle`, `live`,
`cursor`, and friends) from the client; a client-supplied `columns`/`replica`/unknown param is
dropped. The allowlist is enumerated locally in `electric-proxy.ts` (mirroring
`@electric-sql/client`'s `*_QUERY_PARAM` names — the package exposes no aggregate
"protocol params" export to import, and `@pgxsinkit/server` deliberately takes no client-package
dependency) so the proxy fails **closed** on any unknown or future param. Per-row column omission
stays enforced by the post-hoc JSON strip (and the explicit `rowFilter.columns` projection where
configured) rather than by deriving `columns` from the projection: a declared `rowTransform` may
need to read a column the client must not see, so the upstream fetch keeps the default column set
and the strip removes withheld columns from the response. The registry entry, keyed by its exact
Electric target, is itself the shape capability — no opaque shape-id layer is introduced (it would
add no authorization the exact-table allowlist does not already give). Pinned by the
forwarded-param-rejection and control-param-forwarding cases in `tests/unit/electric-proxy.test.ts`.
The implementation and its tests are part of the supported 0.2.0 baseline.

References: [ADR-0002](0002-single-in-database-write-path.md) (single write path);
`CONTEXT.md` (Parity boundary, Read model);
[docs/plans/0003-secured-sync-ingress.md](../plans/0003-secured-sync-ingress.md).
