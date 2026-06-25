<p align="center">
  <a href="https://pgxsinkit.github.io">
    <picture>
      <source srcset="./brand/banner/banner.avif" type="image/avif" />
      <source srcset="./brand/banner/banner.webp" type="image/webp" />
      <img src="./brand/banner/banner.png" alt="pgxsinkit" width="720" />
    </picture>
  </a>
</p>

# pgxsinkit

`pgxsinkit` is an offline-first **sync toolkit** for a `PostgreSQL -> ElectricSQL -> PGlite` read path and a `client -> write API -> PostgreSQL` write path. The `@pgxsinkit/*` packages are the product; the demo app (`apps/board`), the minimal reference server (`apps/write-api`), and the integration + performance harness exist to prove and harden them.

Canonical timestamps are stored as bigint microseconds since the unix epoch and cross API/sync boundaries as decimal strings.

📖 **[Documentation](https://pgxsinkit.github.io)** — start with [What is pgxsinkit?](https://pgxsinkit.github.io/start/overview/), then [Getting started](https://pgxsinkit.github.io/start/getting-started/) and [Core concepts](https://pgxsinkit.github.io/concepts/). Before you ship, read [Operating in production](https://pgxsinkit.github.io/start/operating-in-production/) — the runtime gotchas (convergence cadence, edge cold starts, the browser HTTP/2 connection budget) that decide whether a live app feels fast.

## Requirements

`pgxsinkit` row filters may use cross-table subquery `where` clauses — for example membership
fan-out, where a row in a container streams to every member of that container:

```sql
container_id IN (SELECT container_id FROM memberships WHERE member_id = <subject>)
```

The electric-proxy forwards this verbatim as the Electric shape `where`, so streaming it relies on
a **required** ElectricSQL capability:

- **ElectricSQL >= 1.7** running with `ELECTRIC_FEATURE_FLAGS=allow_subqueries,tagged_subqueries`.

This is a hard prerequisite, not an optional optimisation. Subquery `where` support is a flagged
preview feature (still flagged as of 1.7.3); without the flag Electric rejects any subquery `where`
with HTTP 400 (`{"where":["Subqueries are not supported"]}`). The sync then fails **closed** — no rows
stream — it never silently fans out unfiltered data.

A second point follows from the same grammar: **a PostgreSQL `enum` column referenced in a shape
`where` must be cast to `text`** — `"role"::text = 'manager'`, not `"role" = 'manager'`. The enum
column itself stays an enum everywhere else — RLS and the write path keep using it natively, so there
is no enum→text migration. See
[The Electric subquery requirement](https://pgxsinkit.github.io/concepts/electric-subqueries/) for the
full story.

## Install

```bash
bun add @pgxsinkit/client @pgxsinkit/server @pgxsinkit/contracts
# React bindings (optional): bun add @pgxsinkit/react
```

The packages are published to public npm; install them with whichever package manager you use
(`pnpm add`, `npm install`, `yarn add` — pgxsinkit mandates none). Then follow
[**Getting started**](https://pgxsinkit.github.io/start/getting-started/) to wire the read and write
paths and provision the in-database apply function.

## Quick start — run the board demo

The substantial example (`apps/board`, a Linear-style board + chat) drives the full read and write
paths end-to-end against a partial Supabase + Electric stack:

1. `mise install`
2. `bun install`
3. `cp .env.example .env`
4. `mkcert -install` — one-time: trust the local CA so the browser accepts the gateway's HTTP/2 cert
5. `bun run infra:up` — brings up the board stack (partial Supabase + Electric), builds the edge functions, and applies the board's migration history
6. `bun run seed:board` — GoTrue identities + fixtures
7. `bun run dev:board`

The board stack is self-contained on its own ports (gateway `54331`, db `54322`, electric `54330`,
HTTP/2 gateway `54343`), so it coexists with the harness. Studio is at `http://localhost:54333`. For
the minimal reference server (`apps/write-api`) instead, use `bun run infra:harness:up` (PostgreSQL +
Electric) → `bun run dev:api`.

## The write path

There is exactly one write path: client writes are staged locally, flushed through the write API,
and applied to PostgreSQL in a single in-database PL/pgSQL function (`pgxsinkit_apply_mutations`).
There is no selectable backend — the in-database bulk apply is the only strategy. See
[The write path](https://pgxsinkit.github.io/concepts/write-path/) and
[ADR-0002](./docs/adr/0002-single-in-database-write-path.md).

## Development & contributing

Contributor setup, the canonical vocabulary, and the agent guide live in [`AGENTS.md`](./AGENTS.md)
and [`CONTEXT.md`](./CONTEXT.md). The repository is a Bun workspace:

- `apps/board` — the substantial demo (Linear-style board + chat) on a partial Supabase + Electric stack.
- `apps/write-api` — the minimal `@pgxsinkit/server` reference (Bun, no web framework).
- `packages/contracts` · `client` · `server` · `react` — the published toolkit.
- `packages/schema`, `packages/board-schema` — example/demo registries (your app defines its own).
- `infra/`, `tests/`, `supabase/functions` — compose stacks, suites, and the demo's edge functions.

Scripts are check-default (a bare verb never mutates):

```bash
bun run validate         # fast pre-commit gate: format, lint, typecheck, fast unit subset
bun run validate:full    # pre-push + CI gate: adds the PGlite-backed unit suite
bun run test:integration # container-backed suites on isolated, ephemeral compose stacks
```

Deeper references, all under `docs/`: [architecture](./docs/architecture.md) ·
[testing strategy](./docs/testing-strategy.md) · [migrations](./docs/migrations.md) ·
[function artifacts](./docs/function-artifacts.md) · [performance](./tests/performance/README.md).

## Releasing

`@pgxsinkit/*` publishes from a semver **tag**: CI derives the version from the tag and publishes all
packages at that one version — there is no version bump. See [`RELEASING.md`](./RELEASING.md) and
[ADR-0001](./docs/adr/0001-unified-ts-release-versioning-tooling-standard.md).

## License

[MIT](./LICENSE) © pgxsinkit contributors.
