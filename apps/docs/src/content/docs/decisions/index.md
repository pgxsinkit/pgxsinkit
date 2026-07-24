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
- [ADR-0025 — Per-client mode projection: one authoritative registry, readonly projections per client](https://github.com/pgxsinkit/pgxsinkit/blob/main/docs/adr/0025-per-client-mode-projection.md)
- [ADR-0026 — One claim-stamping managed-field strategy: `authClaim`](https://github.com/pgxsinkit/pgxsinkit/blob/main/docs/adr/0026-authclaim-managed-field-strategy.md)
- [ADR-0027 — Read projections: a derived second client shape over an owned table](https://github.com/pgxsinkit/pgxsinkit/blob/main/docs/adr/0027-read-projections.md)
- [ADR-0028 — Own the sync engine outright (upstream compatibility is an anti-goal)](https://github.com/pgxsinkit/pgxsinkit/blob/main/docs/adr/0028-own-the-sync-engine-outright.md)
- [ADR-0029 — The registry item is the ingest engine's spec](https://github.com/pgxsinkit/pgxsinkit/blob/main/docs/adr/0029-registry-item-driven-ingest-engine.md)
- [ADR-0030 — Self-verifying apply function and the serverless deployment profile](https://github.com/pgxsinkit/pgxsinkit/blob/main/docs/adr/0030-self-verifying-apply-function-deployment-profile.md)
- [ADR-0031 — Catch-up commit-floor alignment for CDN-cached shape watermarks](https://github.com/pgxsinkit/pgxsinkit/blob/main/docs/adr/0031-catchup-watermark-alignment.md)
- [ADR-0032 — The whole sync engine moves into a SharedWorker](https://github.com/pgxsinkit/pgxsinkit/blob/main/docs/adr/0032-sync-engine-in-shared-worker.md)
- [ADR-0033 — Live-tail sibling nudge: refresh quiet-shape watermarks instead of waiting out their long-polls](https://github.com/pgxsinkit/pgxsinkit/blob/main/docs/adr/0033-live-tail-sibling-nudge.md)
- [ADR-0034 — Boot observability: a structured, versioned BootReport for every client boot](https://github.com/pgxsinkit/pgxsinkit/blob/main/docs/adr/0034-boot-observability-bootreport.md)
- [ADR-0035 — Local store export: store backup, diagnostic dump, and data export](https://github.com/pgxsinkit/pgxsinkit/blob/main/docs/adr/0035-local-store-export.md)
- [ADR-0036 — Store path contract: derived storage backend, no client-visible memory stores](https://github.com/pgxsinkit/pgxsinkit/blob/main/docs/adr/0036-store-path-contract.md)
- [ADR-0037 — Vite library build for the React package](https://github.com/pgxsinkit/pgxsinkit/blob/main/docs/adr/0037-vite-library-build-for-react-package.md)
- [ADR-0038 — Manifest-derived externals for the public package bundles](https://github.com/pgxsinkit/pgxsinkit/blob/main/docs/adr/0038-manifest-derived-externals-for-public-bundles.md)
- [ADR-0039 — Ordinary writes activate their lazy group; claims-dependent groups warn on anonymous activation](https://github.com/pgxsinkit/pgxsinkit/blob/main/docs/adr/0039-write-activation-and-anonymous-activation-diagnostic.md)
- [ADR-0040 — A worker-owned live-query manager: awaited teardown, deduplication, and bounded keep-alive](https://github.com/pgxsinkit/pgxsinkit/blob/main/docs/adr/0040-shared-live-query-manager.md)
- [ADR-0041 — Staged boot readiness: local-read before write and network](https://github.com/pgxsinkit/pgxsinkit/blob/main/docs/adr/0041-staged-boot-readiness.md)
- [ADR-0042 — Session-scoped sync metadata for ephemeral groups](https://github.com/pgxsinkit/pgxsinkit/blob/main/docs/adr/0042-session-scoped-sync-metadata-for-ephemeral-groups.md)
- [ADR-0043 — Adopted stores whose persistence cannot be introspected need a named acknowledgment](https://github.com/pgxsinkit/pgxsinkit/blob/main/docs/adr/0043-adopted-store-persistence-acknowledgment.md)
- [ADR-0044 — The attach client proxies one-shot reads; isSynced stays a refusal](https://github.com/pgxsinkit/pgxsinkit/blob/main/docs/adr/0044-attach-client-one-shot-reads.md)
- [ADR-0045 — Per-table `applyMode` for locally-derived rows](https://github.com/pgxsinkit/pgxsinkit/blob/main/docs/adr/0045-per-table-apply-mode-for-locally-derived-rows.md)
- [ADR-0046 — Restore boots online when the recovered journal is clean](https://github.com/pgxsinkit/pgxsinkit/blob/main/docs/adr/0046-restore-boots-online-when-journal-clean.md)
- [ADR-0047 — Relaxed durability is the default for the local store, declared on the registry](https://github.com/pgxsinkit/pgxsinkit/blob/main/docs/adr/0047-relaxed-durability-default.md)
- [ADR-0048 — `opfs-repacked` — a packed, recreate-only OPFS VFS for PGlite](https://github.com/pgxsinkit/pgxsinkit/blob/main/docs/adr/0048-opfs-repacked-vfs.md)
- [ADR-0049 — Capability-driven engine placement: opfs-repacked on every platform](https://github.com/pgxsinkit/pgxsinkit/blob/main/docs/adr/0049-capability-driven-engine-placement.md)
- [ADR-0050 — Storage declaration transport and path-addressed store teardown](https://github.com/pgxsinkit/pgxsinkit/blob/main/docs/adr/0050-storage-declaration-transport.md)

<!-- adr:list:end -->
