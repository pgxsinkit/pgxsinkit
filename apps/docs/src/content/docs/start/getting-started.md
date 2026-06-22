---
title: Getting started
description: Install the @pgxsinkit/* packages and stand up the read and write paths.
---

import { Steps, Aside } from "@astrojs/starlight/components";

This page gets you from zero to a working read + write path. For what each package does, see
[Packages](/packages/); for the model behind it, see [Core concepts](/concepts/).

## Prerequisites

- **PostgreSQL 18+** (Supabase-compatible; the write path uses Supabase-style auth claims for RLS).
- **ElectricSQL ≥ 1.6**, run with the subquery feature flag — this is **mandatory**:

  ```bash
  ELECTRIC_FEATURE_FLAGS=allow_subqueries,tagged_subqueries
  ```

  Without it, sync fails closed (no rows stream). See
  [The Electric subquery requirement](/concepts/electric-subqueries/).

- **Bun** for the write API runtime, and **Drizzle** (`drizzle-orm@1.0.0-rc.2`+) for schema.

<Aside type="caution" title="Enum columns in shape filters">
  A PostgreSQL `enum` referenced in a shape `where` must be cast to `text` —
  `"role"::text = 'manager'`, not `"role" = 'manager'`. The column stays an enum everywhere else.
</Aside>

## Install

```bash
bun add @pgxsinkit/client @pgxsinkit/server @pgxsinkit/contracts
# React bindings (optional)
bun add @pgxsinkit/react
```

Packages are published to public npm. Peer dependencies include `drizzle-orm`, `@electric-sql/pglite`,
`hono` (server), and `zod`.

## Stand up the write path

<Steps>

1. **Define your sync registry** — the tables, their sync mode, and governance (managed fields like
   owner/timestamps). This is the single source of truth both paths read from.

2. **Provision the apply function.** The write path applies batches through one in-database PL/pgSQL
   function, `pgxsinkit_apply_mutations`, installed by a migration. Generate it from your registry:

   ```bash
   bun run sync:function:generate
   ```

3. **Create the server** with `createSyncServer({ registry, db, resolveAuthClaims })` and serve its
   `fetch`. All writes go through `POST /api/mutations`; there is no per-table CRUD and no backend to
   choose.

</Steps>

## Stand up the read path

The client writes locally into an overlay + a durable journal, flushes the journal to the write API,
and subscribes to Electric shapes that land in local PGlite. Reads are served from PGlite; the write
API's `/v1/electric-proxy` forwards shape requests to Electric and enforces ownership.

See [The read path](/concepts/read-path/) and [The write path](/concepts/write-path/) for the full
flow, and [Packages](/packages/) for the client entry points.

## Try the demo

The repository's `apps/web` drives all of the above end-to-end against a local compose stack:

```bash
mise install && bun install
cp .env.example .env
bun run infra:up      # PostgreSQL + Electric (with the required flag) via Podman compose
bun run dev:api
bun run dev:web
```

See [Demo & harness](/demo-and-harness/) for what the demo and the verification suites are for.
