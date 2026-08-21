---
title: Project
description: Versions pgxsinkit is built and tested against, and how it is released.
sidebar:
  label: Overview
---

## Support matrix

pgxsinkit sits between several systems and is pinned to specific versions of each. The table below is
what it is **built and tested against** — not a claim that nothing else can work.

| System          | Version                                                        | Notes                                                                                                                                            |
| --------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| PostgreSQL      | 17+                                                            | Supabase-compatible; CI tests against Supabase Postgres 17.x. Requires `wal_level = logical`. Auth claims drive the RLS context.                 |
| Circuits engine | `ghcr.io/pgxsinkit/electric-circuits/engine:sha-0d336cf`       | ElectricSQL's Circuits engine, from the pgxsinkit fork. Pinned by **sha tag**, never `main`.                                                     |
| durable-streams | `docker.io/electricax/durable-streams-server-rust:0.1.5`       | ElectricSQL's official Rust durable-streams server, published image, pinned by version tag.                                                      |
| PGlite          | 0.5.5, aliased to the `@pgxsinkit/pglite` fork (`0.5.5-pgx.2`) | local client database (peer dependency). The fork carries a transaction-end sync fix `pglite-opfs-repacked`'s durability contract depends on.    |
| Read transport  | `@durable-streams/client` 0.2.6                                | the client's read-path transport (a dependency of `@pgxsinkit/client`, not a peer).                                                              |
| Drizzle ORM     | 1.0.0-rc.4+                                                    | authoritative server schema + migrations.                                                                                                        |
| Server runtime  | Bun / Deno / Supabase Edge                                     | the server is a web-standard `fetch` handler — the board demo runs it on the **Supabase Edge (Deno)** runtime, the minimal reference on **Bun**. |
| Zod             | v4+                                                            | transport validation.                                                                                                                            |

### What "tested against" means

CI exercises pgxsinkit against a **self-hosted Supabase Postgres + durable-streams + Circuits engine**
stack (Podman compose, at the versions pinned above), across both server runtimes: the minimal
reference server on **Bun** and the board demo's edge functions on the **Supabase Edge (Deno)** runtime.
The stream edge is TypeScript in `@pgxsinkit/server`, so it runs in-process in those lanes rather than
as a container.

Because every endpoint is env-driven, the same code is expected to run unchanged against managed
Postgres — Supabase Cloud among them — but that is **not validated in CI**. Treat it as supported by
design, not certified. There is no managed offering of the Circuits engine or of durable-streams to
point at: both are services you run yourself, and these docs do not currently cover deploying them to a
cloud environment.

## Releasing

pgxsinkit follows the unified release standard (see [Design decisions](/decisions/) → ADR-0001):
versions are derived from the most recent semver tag, publishable `package.json` files carry a
`0.0.0` placeholder, and publishing is gated on validation. A push to `main` publishes a `@dev` build
to GitHub Packages; a semver tag publishes a release to npm + GitHub Packages.

Full mechanics are in
[`RELEASING.md`](https://github.com/pgxsinkit/pgxsinkit/blob/main/RELEASING.md).

## License & source

pgxsinkit is open source under the
[**MIT License**](https://github.com/pgxsinkit/pgxsinkit/blob/main/LICENSE). Source, issues, and ADRs
live at [github.com/pgxsinkit/pgxsinkit](https://github.com/pgxsinkit/pgxsinkit).
