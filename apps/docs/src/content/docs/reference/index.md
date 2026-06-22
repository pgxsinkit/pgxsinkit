---
title: API reference
description: Generated type-level reference for the published @pgxsinkit/* packages.
sidebar:
  label: Overview
---

The pages under this section are generated with `starlight-typedoc` directly from each package's
source, so the API reference always matches the code. They cover the four packages you install and
use directly:

- **[@pgxsinkit/contracts](/api/contracts/readme/)** — shared Zod schemas, sync registry types, and
  transport DTOs.
- **[@pgxsinkit/client](/api/client/readme/)** — local overlay + journal, batch flush, and read wiring.
- **[@pgxsinkit/server](/api/server/readme/)** — `createSyncServer`, the apply-function builder, and
  the Electric shape proxy.
- **[@pgxsinkit/react](/api/react/readme/)** — React bindings over the client.

The vendored `@pgxsinkit/pglite-sync` is an internal transitive dependency of the client and is not
documented here — see [Packages](/packages/) for where it fits.

New to the library? Start with [Core concepts](/concepts/) for the model, then [Packages](/packages/)
for what to install.
