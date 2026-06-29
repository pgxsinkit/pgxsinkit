---
title: Design decisions
description: Architecture Decision Records for pgxsinkit.
sidebar:
  label: Overview
---

pgxsinkit records significant, hard-to-reverse choices as Architecture Decision Records (ADRs). The
canonical copies live in
[`docs/adr/`](https://github.com/pgxsinkit/pgxsinkit/tree/main/docs/adr) in the repository; the list
below is generated from them (`bun run docs:adr`) and verified on every docs build, so it stays
complete as ADRs are added.

<!-- adr:list:start -->

- [ADR-0001 — Unified TypeScript release, versioning, and tooling standard (emergent / conform-ed / pgxsinkit)](https://github.com/pgxsinkit/pgxsinkit/blob/main/docs/adr/0001-unified-ts-release-versioning-tooling-standard.md)
- [ADR-0002 — Single in-database write path; retire the strategy/backend/artifact seam](https://github.com/pgxsinkit/pgxsinkit/blob/main/docs/adr/0002-single-in-database-write-path.md)
- [ADR-0003 — Secured sync ingress: fail closed, one verified-claims adapter](https://github.com/pgxsinkit/pgxsinkit/blob/main/docs/adr/0003-secured-sync-ingress.md)
- [ADR-0004 — One registry interpreter: shared resolvers and a registry fingerprint](https://github.com/pgxsinkit/pgxsinkit/blob/main/docs/adr/0004-one-registry-interpreter.md)
- [ADR-0005 — Mutation convergence: mechanism primitives plus an opt-in driver](https://github.com/pgxsinkit/pgxsinkit/blob/main/docs/adr/0005-mutation-convergence.md)
- [ADR-0006 — Local schema evolution and mutation compatibility](https://github.com/pgxsinkit/pgxsinkit/blob/main/docs/adr/0006-local-schema-evolution.md)
- [ADR-0007 — Absorb sync-engine into the client](https://github.com/pgxsinkit/pgxsinkit/blob/main/docs/adr/0007-absorb-sync-engine.md)
- [ADR-0008 — Documentation proves the product interface](https://github.com/pgxsinkit/pgxsinkit/blob/main/docs/adr/0008-docs-prove-interface.md)
- [ADR-0009 — Internalize the read-path sync (break with pglite-sync)](https://github.com/pgxsinkit/pgxsinkit/blob/main/docs/adr/0009-internalize-read-path-sync.md)
- [ADR-0010 — Convergence barrier: resolve optimistic state by Server version, not key-match](https://github.com/pgxsinkit/pgxsinkit/blob/main/docs/adr/0010-convergence-barrier.md)
- [ADR-0011 — The Convergence model: one owner of local convergence, derived not stored](https://github.com/pgxsinkit/pgxsinkit/blob/main/docs/adr/0011-convergence-model.md)
- [ADR-0012 — Canonical entity identity and a composite-PK-correct applier](https://github.com/pgxsinkit/pgxsinkit/blob/main/docs/adr/0012-canonical-entity-identity.md)
- [ADR-0013 — Read-path identity: refresh the token, never freeze it at boot](https://github.com/pgxsinkit/pgxsinkit/blob/main/docs/adr/0013-read-path-identity-refresh.md)
- [ADR-0014 — Bulk apply on both paths, without the set-based ordering hazard](https://github.com/pgxsinkit/pgxsinkit/blob/main/docs/adr/0014-bulk-apply-ordering-safety.md)
- [ADR-0015 — Stale-write conflict policy: detect by Server version, choose per table](https://github.com/pgxsinkit/pgxsinkit/blob/main/docs/adr/0015-stale-write-conflict-policy.md)
- [ADR-0016 — Deferred read-path optimisations and their triggers to revisit](https://github.com/pgxsinkit/pgxsinkit/blob/main/docs/adr/0016-deferred-read-path-optimisations.md)
- [ADR-0017 — Framework-neutral server: drop the Hono dependency](https://github.com/pgxsinkit/pgxsinkit/blob/main/docs/adr/0017-framework-neutral-server-drop-hono.md)
- [ADR-0018 — Apply-function drift detection via an embedded fingerprint](https://github.com/pgxsinkit/pgxsinkit/blob/main/docs/adr/0018-apply-function-drift-detection.md)
- [ADR-0019 — Row filters as type-safe Drizzle fragments → parameterized Electric `where`](https://github.com/pgxsinkit/pgxsinkit/blob/main/docs/adr/0019-row-filters-as-drizzle-fragments.md)
- [ADR-0020 — Index-friendly RLS: `= ANY(ARRAY(subquery))` for runtime-resolved id-sets](https://github.com/pgxsinkit/pgxsinkit/blob/main/docs/adr/0020-index-friendly-rls-any-array.md)
- [ADR-0021 — Sync lifecycle: subscription-timing and retention as orthogonal axes](https://github.com/pgxsinkit/pgxsinkit/blob/main/docs/adr/0021-lazy-ephemeral-sync-lifecycle.md)
- [ADR-0022 — Pessimistic write-units: server-authoritative writes via flush-routing](https://github.com/pgxsinkit/pgxsinkit/blob/main/docs/adr/0022-pessimistic-write-units.md)
- [ADR-0023 — Subquery move-out: applying Electric's tagged-subquery eviction in the local store](https://github.com/pgxsinkit/pgxsinkit/blob/main/docs/adr/0023-subquery-move-out-tagged-reconciliation.md)
- [ADR-0024 — Subquery move-in: applying Electric's live snapshot rows in the local store](https://github.com/pgxsinkit/pgxsinkit/blob/main/docs/adr/0024-subquery-move-in-snapshot-rows.md)

<!-- adr:list:end -->
