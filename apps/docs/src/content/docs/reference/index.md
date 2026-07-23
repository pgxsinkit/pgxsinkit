---
title: API reference
description: Generated type-level reference for the published @pgxsinkit/* packages.
sidebar:
  label: Overview
---

The pages under this section are generated with `starlight-typedoc` directly from each package's
source, so the API reference always matches the code. They cover the five packages you install and
use directly:

- **[@pgxsinkit/contracts](/api/contracts/readme/)** — shared Zod schemas, sync registry types, and
  transport DTOs.
- **[@pgxsinkit/pglite-opfs-repacked](/api/pglite-opfs-repacked/readme/)** — constant-handle OPFS
  adapter, PGlite factory, validated options, and stable storage errors.
- **[@pgxsinkit/client](/api/client/readme/)** — local overlay + journal, batch flush, and read wiring.
- **[@pgxsinkit/server](/api/server/readme/)** — `createSyncServer`, the apply-function builder, and
  the Electric shape proxy.
- **[@pgxsinkit/react](/api/react/readme/)** — React bindings over the client.

The Electric read-path ingest engine lives inside `@pgxsinkit/client` (`src/sync/`, ADR-0009) rather
than a separate package, so it is not documented as its own entry — see [Packages](/packages/) for
where it fits.

New to the library? Start with [Core concepts](/concepts/) for the model, then [Packages](/packages/)
for what to install.
