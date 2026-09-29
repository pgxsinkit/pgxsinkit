---
title: API reference
description: Generated type-level reference for the published @pgxsinkit/* packages.
sidebar:
  label: Overview
---

The pages under this section are generated with `starlight-typedoc` directly from each package's
source, so the API reference always matches the code. They cover the eight packages you install and
use directly:

- **[@pgxsinkit/contracts](/api/contracts/readme/)** — shared Zod schemas, sync registry types, and
  transport DTOs.
- **[@pgxsinkit/client](/api/client/readme/)** — local overlay + journal, batch flush, and read wiring.
- **[@pgxsinkit/server](/api/server/readme/)** — `createSyncServer`, the apply-function builder, and
  the read path's control plane + stream edge.
- **[@pgxsinkit/react](/api/react/readme/)** — React bindings over the client.
- **[@pgxsinkit/pgwasm](/api/pgwasm/readme/)** — the Postgres runtime: `createPgwasm`, `/live`,
  `/drizzle`, `/protocol`, the OPFS-repacked store (`/opfs`), and the `/fs` and `/build` contracts.
- **[@pgxsinkit/pgwasm-c](/api/pgwasm-c/readme/)** — the C Postgres build, `/prepopulated`, and
  `/contrib/amcheck`.
- **[@pgxsinkit/pgwasm-pg-dump](/api/pgwasm-pg-dump/readme/)** — `pgDump` and its errors.
- **[@pgxsinkit/pgwasm-repl](/api/pgwasm-repl/readme/)** — the `<Repl>` component.

The read-path reader, its transport included, lives inside `@pgxsinkit/client` (`src/circuits/`,
ADR-0055), rather than in a separate package, so it is not documented as its own entry — see
[Packages](/packages/) for where it fits.

New to the library? Start with [Core concepts](/concepts/) for the model, then [Packages](/packages/)
for what to install.
