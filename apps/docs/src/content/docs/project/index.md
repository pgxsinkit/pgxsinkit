---
title: Project
description: Versions pgxsinkit is built and tested against, and how it is released.
sidebar:
  label: Overview
---

## Support matrix

pgxsinkit sits between several systems and is pinned to specific versions of each. The table below is
what it is **built and tested against** — not a claim that nothing else can work.

| System         | Version                    | Notes                                                                                                                                            |
| -------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| PostgreSQL     | 17+                        | Supabase-compatible; CI tests against Supabase Postgres 17.x. Auth claims drive the RLS context.                                                 |
| ElectricSQL    | ≥ 1.7 (CI pins 1.7.3)      | **Must** run with `ELECTRIC_FEATURE_FLAGS=allow_subqueries,tagged_subqueries`.                                                                   |
| PGlite         | 0.5.3                      | local client database (peer dependency).                                                                                                         |
| Drizzle ORM    | 1.0.0-rc.2+                | authoritative server schema + migrations.                                                                                                        |
| Server runtime | Bun / Deno / Supabase Edge | the server is a web-standard `fetch` handler — the board demo runs it on the **Supabase Edge (Deno)** runtime, the minimal reference on **Bun**. |
| Zod            | v4+                        | transport validation.                                                                                                                            |

### What "tested against" means

CI exercises pgxsinkit against a **self-hosted Supabase + ElectricSQL** stack (Podman compose, at the
versions pinned above), across both server runtimes: the minimal reference server on **Bun** and the
board demo's two edge functions on the **Supabase Edge (Deno)** runtime. Because every endpoint is
env-driven, the same code is expected to run unchanged against the **hosted** services — Supabase Cloud
and Electric Cloud — but those are **not yet validated in CI**. Treat them as supported by design, not
yet certified.

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
