---
title: Design decisions
description: Architecture Decision Records for pgxsinkit.
sidebar:
  label: Overview
---

pgxsinkit records significant, hard-to-reverse choices as ADRs. The canonical copies live in
`docs/adr/` in the repository; the summaries below link to them.

## ADR-0001 — Unified TypeScript release, versioning & tooling standard

The shared release/versioning/tooling standard across the author's TypeScript repos: rebase-only
integration, tag-derived versions (`0.0.0` placeholders), check-default scripts, and a gated publish
flow. [Read it](https://github.com/pgxsinkit/pgxsinkit/blob/main/docs/adr/0001-unified-ts-release-versioning-tooling-standard.md).

## ADR-0002 — Single in-database write path

Why there is exactly one write path and no selectable backend: the experiments converged on
in-database bulk apply, the alternatives were deleted, and the strategy/backend/artifact vocabulary
was retired. Explains the `pgxsinkit_apply_mutations` function and what git history holds.
[Read it](https://github.com/pgxsinkit/pgxsinkit/blob/main/docs/adr/0002-single-in-database-write-path.md).
