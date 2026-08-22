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

`pgxsinkit` is an offline-first **sync toolkit** for a `PostgreSQL -> Circuits engine -> durable-streams -> PGlite` read path and a `client -> write API -> PostgreSQL` write path. The `@pgxsinkit/*` packages are the product; the demo app (`apps/board`), the minimal reference server (`apps/write-api`), and the integration + performance harness exist to prove and harden them.

Canonical timestamps are stored as bigint microseconds since the unix epoch and cross API/sync boundaries as decimal strings.

📖 **[Documentation](https://pgxsinkit.github.io)** — start with [What is pgxsinkit?](https://pgxsinkit.github.io/start/overview/), then [Getting started](https://pgxsinkit.github.io/start/getting-started/) and [Core concepts](https://pgxsinkit.github.io/concepts/). Before you ship, read [Operating in production](https://pgxsinkit.github.io/start/operating-in-production/) — the runtime gotchas (convergence cadence, edge cold starts, the browser HTTP/2 connection budget) that decide whether a live app feels fast.

## Requirements

The read path runs on ElectricSQL's **Circuits engine** (pgxsinkit pins a published image of its own
fork, `ghcr.io/pgxsinkit/electric-circuits/engine`) writing into a **durable-streams** log that the
client reads through a token-gated stream edge. Three things it requires:

- **PostgreSQL 17+ with `wal_level = logical`.** The engine ingests logical replication and creates its
  own replication slot. Supabase Postgres ships this already.
- **An explicit table list for the engine** (`ELECTRIC_CIRCUITS_PG_TABLES`), never `*`. `*` introspects
  every `public` table that has a primary key and replicates all of them — including tables you never
  meant to publish. The names are **bare** and unqualified: the engine introspects `public` by bare name,
  and the shape compiler matches it.
- **A gateway that speaks HTTP/2 to browsers.** Each subscription is one held long-poll, so a subject
  with several scopes exhausts the browser's ~6-connections-per-origin ceiling on HTTP/1.1 and writes
  starve behind held reads. HTTP/2+ multiplexes them onto one connection.

## Install

```bash
bun add @pgxsinkit/client @pgxsinkit/server @pgxsinkit/contracts
# React bindings (optional): bun add @pgxsinkit/react
# Constant-handle OPFS storage (optional): bun add @pgxsinkit/pglite-opfs-repacked
```

The packages are published to public npm; install them with whichever package manager you use
(`pnpm add`, `npm install`, `yarn add` — pgxsinkit mandates none). Then follow
[**Getting started**](https://pgxsinkit.github.io/start/getting-started/) to wire the read and write
paths and provision the in-database apply function.

## Quick start — run the board demo

The substantial example (`apps/board`, a Linear-style board + chat) drives the full read and write
paths end-to-end against a partial Supabase + Circuits stack (durable-streams + the engine):

1. `mise install`
2. `bun install`
3. `cp .env.example .env`
4. `mkcert -install` — one-time: trust the local CA so the browser accepts the gateway's HTTP/2 cert
5. `bun run infra:up` — brings up the board stack (partial Supabase + the native read path), builds the edge functions, and applies the board's migration history
6. `bun run seed:board` — GoTrue identities + fixtures
7. `bun run dev:board`

The board stack is self-contained on its own ports (gateway `54331`, db `54322`, durable-streams
`54341`, Circuits engine `54342`, HTTP/2 gateway `54343`), so it coexists with the harness. Studio is at `http://localhost:54333`. For
the minimal reference server (`apps/write-api`) instead, use `bun run infra:harness:up` (PostgreSQL +
durable-streams + the Circuits engine) → `bun run dev:api`.

## The write path

There is exactly one write path: client writes are staged locally, flushed through the write API,
and applied to PostgreSQL in a single in-database PL/pgSQL function (`pgxsinkit_apply_mutations`).
There is no selectable backend — the in-database bulk apply is the only strategy. See
[The write path](https://pgxsinkit.github.io/concepts/write-path/) and
[ADR-0002](./docs/adr/0002-single-in-database-write-path.md).

## Development & contributing

Contributor setup, the canonical vocabulary, and the agent guide live in [`AGENTS.md`](./AGENTS.md)
and [`CONTEXT.md`](./CONTEXT.md). The repository is a Bun workspace:

- `apps/board` — the substantial demo (Linear-style board + chat) on a partial Supabase + Circuits stack.
- `apps/write-api` — the minimal `@pgxsinkit/server` reference (Bun, no web framework).
- `packages/contracts` · `client` · `server` · `react` — the published sync toolkit.
- `packages/pglite-opfs-repacked` — the published OPFS storage engine for PGlite.
- `packages/schema`, `packages/board-schema` — example/demo registries (your app defines its own).
- `infra/`, `tests/`, `supabase/functions` — compose stacks, suites, and the demo's edge functions.

Scripts are check-default (a bare verb never mutates):

```bash
bun run validate         # fast pre-commit gate: format, lint, typecheck, fast unit subset
bun run validate:full    # pre-push + CI gate: adds the PGlite-backed unit suite
bun run test:integration # container-backed suites on isolated, ephemeral compose stacks
```

**Fresh clone:** `@electric-sql/pglite` is temporarily overridden to the `@pgxsinkit/pglite` fork (see
[docs/runbooks/pglite-fork-override.md](./docs/runbooks/pglite-fork-override.md)). The fork is mirrored
on public npm, so a plain `bun install` resolves it — no registry auth or extra setup needed.

Deeper references, all under `docs/`: [architecture](./docs/architecture.md) ·
[testing strategy](./docs/testing-strategy.md) · [migrations](./docs/migrations.md) ·
[function artifacts](./docs/function-artifacts.md) · [performance](./tests/performance/README.md).

## Releasing

`@pgxsinkit/*` publishes from a semver **tag**: CI derives the version from the tag and publishes all
packages at that one version — there is no version bump. See [`RELEASING.md`](./RELEASING.md) and
[ADR-0001](./docs/adr/0001-unified-ts-release-versioning-tooling-standard.md).

## License

[MIT](./LICENSE) © pgxsinkit contributors.
