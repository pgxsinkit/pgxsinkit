---
title: Project
description: Versions pgxsinkit is built and tested against, and how it is released.
sidebar:
  label: Overview
---

## Support matrix

pgxsinkit is pinned to specific versions of the systems it sits between. These are the versions it is
built and tested against.

| System      | Version               | Notes                                                                          |
| ----------- | --------------------- | ------------------------------------------------------------------------------ |
| PostgreSQL  | 18+                   | Supabase-compatible; auth claims used for RLS context.                         |
| ElectricSQL | ≥ 1.6 (CI pins 1.7.2) | **Must** run with `ELECTRIC_FEATURE_FLAGS=allow_subqueries,tagged_subqueries`. |
| PGlite      | 0.5.3                 | local client database (peer dependency).                                       |
| Drizzle ORM | 1.0.0-rc.2+           | authoritative server schema + migrations.                                      |
| Bun         | current               | write API runtime.                                                             |
| Zod         | v4+                   | transport validation.                                                          |

## Releasing

pgxsinkit follows the unified release standard (see [Design decisions](/decisions/) → ADR-0001):
versions are derived from the most recent semver tag, publishable `package.json` files carry a
`0.0.0` placeholder, and publishing is gated on validation. A push to `main` publishes a `@dev` build
to GitHub Packages; a semver tag publishes a release to npm + GitHub Packages.

Full mechanics are in
[`RELEASING.md`](https://github.com/pgxsinkit/pgxsinkit/blob/main/RELEASING.md).

## License & source

pgxsinkit is open source. Source, issues, and ADRs live at
[github.com/pgxsinkit/pgxsinkit](https://github.com/pgxsinkit/pgxsinkit).
