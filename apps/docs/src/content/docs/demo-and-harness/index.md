---
title: Demo & harness
description: The demo app and verification suites exist to prove and harden the toolkit — they are not the product.
sidebar:
  label: Overview
---

The repository contains a demo app and a verification harness. Neither is the product — the
[`@pgxsinkit/*` packages](/packages/) are. These exist to make the toolkit demonstrable and to keep
it honest against real infrastructure.

## The demo app (`apps/web`)

A React + Vite application that drives the full read and write paths against a local PostgreSQL +
ElectricSQL stack. Its job is twofold:

- **Example code for consumers** — a working reference for how to wire the client, stage and flush
  writes, and read from PGlite.
- **A smoke-testing ground for maintainers** — somewhere to see end-to-end behaviour by hand.

It uses a generic example domain (authors, todos, projects). It is one _consumer_ of pgxsinkit — not
pgxsinkit itself, and not any downstream product's data layer.

```bash
mise install && bun install
cp .env.example .env
bun run infra:up    # PostgreSQL + Electric (with allow_subqueries,tagged_subqueries)
bun run dev:api
bun run dev:web
```

## The verification harness

The harness is where the toolkit earns trust. It runs against **real** services in isolated,
torn-down Podman compose stacks — not mocks.

- **Integration suites** (`tests/integration`) — prove the topology end-to-end: write validation,
  the in-database apply, membership fan-out, RLS auth context, and eventual convergence in local
  PGlite.

  ```bash
  bun run test:integration:contract
  bun run test:integration:implementation
  bun run test:integration
  ```

- **Performance lab** (`apps/perf-lab`, `tests/performance`) — measures the write/sync cycle under
  load; kept separate from `bun run validate`.

  ```bash
  bun run perf:lab
  bun run test:performance
  ```

Each lane provisions its own PostgreSQL + ElectricSQL, applies the current schema, runs, and tears
everything down. See the repository's `docs/testing-strategy.md` for the full model.
