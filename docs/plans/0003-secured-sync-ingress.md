# Plan — ADR-0003: Secured sync ingress

Implements [ADR-0003](../adr/0003-secured-sync-ingress.md). Goal: the read-path
proxy fails closed on tables absent from the registry, both ingress paths share one
claims adapter, and `customWhere` is repositioned as an opt-in escape hatch.

Depends on: nothing. Unblocks: confident read-path security for all consumers.

## Phase 1 — Fail closed (landed with the ADR)

The critical security fix; self-contained, no public-API change.

- `packages/server/src/electric-proxy.ts`
  - Decide the proxy target up front: parse `table` from the **incoming request**.
    - no `table` → reject `400` (a shape request must name a table).
    - `table` not in registry (`getRegistryEntry` miss) → reject `403`, **no
      upstream fetch**.
    - `table` in registry → proceed exactly as today (apply `rowFilter` if present;
      a registered-but-unfiltered table still forwards).
  - Rejections return a JSON body and never leak the `electricUrl` token.
- Tests — `tests/unit/electric-proxy.test.ts`
  - unregistered table → `403`, `fetch` **not** called.
  - missing `table` → `400`, `fetch` not called.
  - registered-but-unfiltered table → still forwards (no regression).
- Gate: `bun run validate`.

## Phase 2 — One ingress, one claims adapter (ADR decision 3)

- `packages/server/src/index.ts` — `createSyncServer` gains `electricUrl` and an
  optional `shapeProxyPath` (default e.g. `/api/shape`). When `electricUrl` is set,
  register a `GET` proxy route that resolves claims via the **single**
  `resolveAuthClaims` and calls `proxyElectricShapeRequest`.
- `apps/write-api/src/server.ts` — delete the hand-rolled second Hono app and the
  duplicate `parseDemoAuthClaimsFromRequest` call; pass `electricUrl` to
  `createSyncServer`.
- Keep `proxyElectricShapeRequest` exported for advanced/manual hosting, but the
  documented path is the server-owned route.
- Tests: a server-level test that the proxy route is served, shares the resolved
  claims, and fails closed (reuse Phase 1 assertions through the route).
- Integration: confirm `asymmetric-read` / `membership-fanout` lanes still pass via
  the server-owned route.

## Phase 3 — `customWhere` hardening (ADR decision 5)

- Document the raw-SQL injection surface on `RowFilterSpec.customWhere`
  (`packages/contracts/src/config.ts`).
- Ensure the built-in ownership/shared filters are the default safe path; treat
  `customWhere` as explicitly opt-in. Consider a guarded identifier/value builder
  for the common predicates so authors rarely hand-write SQL.
- Add a test proving request-derived `extraParams` cannot break out of the intended
  predicate via the safe path.

## Acceptance

- Phase 1: unregistered/absent tables provably rejected without fetch; validate
  green. **(done in this pass)**
- Phase 2: demo runs with a single claims adapter; no second Hono app; integration
  lanes green.
- Phase 3: ownership is the default; `customWhere` documented as the escape hatch
  with an injection-resistance test.
