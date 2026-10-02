---
title: Project
description: Versions pgxsinkit is built and tested against, and how it is released.
sidebar:
  label: Overview
---

## Support matrix

pgxsinkit sits between several systems and is pinned to specific versions of each. The table below is
what it is **built and tested against** — not a claim that nothing else can work.

| System          | Version                                                  | Notes                                                                                                                                                                                |
| --------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| PostgreSQL      | 17+                                                      | Supabase-compatible; CI tests against Supabase Postgres 17.x. Requires `wal_level = logical`. Auth claims drive the RLS context.                                                     |
| Circuits engine | `ghcr.io/pgxsinkit/circuits/engine:sha-4c48e83`          | The engine, built in [pgxsinkit/circuits](https://github.com/pgxsinkit/circuits). Pinned by **sha tag** or version, never `dev` or `latest`.                                         |
| durable-streams | `ghcr.io/pgxsinkit/circuits/durable-streams:sha-4c48e83` | The log server, built in the same repository from the same commit. Pinned with the **same tag** as the engine.                                                                       |
| pgwasm          | the `@pgxsinkit/pgwasm*` packages of the same release    | local client database: the toolkit's own Postgres runtime (it began as a fork of PGlite), with the C build of PostgreSQL 18; a dependency of `@pgxsinkit/client`, versioned with it. |
| Read transport  | Durable Streams protocol, long-poll mode                 | `@pgxsinkit/client`'s own reader, written against the [protocol specification][ds-protocol] at a fixed commit; no third-party transport package.                                     |
| Drizzle ORM     | 1.0.0-rc.4+                                              | authoritative server schema + migrations.                                                                                                                                            |
| Server runtime  | Bun / Deno / Supabase Edge                               | the server is a web-standard `fetch` handler — the board demo runs it on the **Supabase Edge (Deno)** runtime, the minimal reference on **Bun**.                                     |
| Zod             | v4+                                                      | transport validation.                                                                                                                                                                |

[ds-protocol]: https://github.com/pgxsinkit/durable-streams/blob/a172acc389351cb3db6deb5cd60e3dec11e7ff39/PROTOCOL.md

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
