---
title: Packages
description: What each @pgxsinkit/* package is and when you need it.
sidebar:
  label: Overview
---

pgxsinkit ships as a set of focused packages. Most apps install `client`, `server`, and `contracts`,
plus `react` for React bindings. The OPFS-repacked package is an optional low-level PGlite storage
backend for browser workers.

## Published packages (the product)

| Package                               | Install when you…                                                                                  | Runtime             |
| ------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------- |
| **`@pgxsinkit/contracts`**            | always — shared Zod schemas, the sync registry types, and the transport DTOs both paths use.       | shared              |
| **`@pgxsinkit/server`**               | you run the server — `createSyncServer`, the apply-function builder, and the Electric shape proxy. | any `fetch` runtime |
| **`@pgxsinkit/client`**               | you build the client — local overlay + mutation journal, batch flush, and read wiring over PGlite. | browser / PGlite    |
| **`@pgxsinkit/react`**                | you want React hooks/bindings over the client.                                                     | React               |
| **`@pgxsinkit/pglite-opfs-repacked`** | you need a constant-handle OPFS filesystem for a PGlite database in a capability-proven worker.    | browser worker      |

## Internal packages (not published)

| Package                 | What it is                                                                                                   |
| ----------------------- | ------------------------------------------------------------------------------------------------------------ |
| `@pgxsinkit/schema`     | the harness/reference sync registry — a membership fixture. Example code; your app defines its own registry. |
| `@pgxsinkit/test-utils` | shared helpers for the integration and unit suites.                                                          |

## How they fit the two paths

- **Write path:** your app uses `@pgxsinkit/client` to stage + flush; `@pgxsinkit/server` validates
  against `@pgxsinkit/contracts` and applies via the in-database function. See
  [The write path](/concepts/write-path/).
- **Read path:** `@pgxsinkit/client` (over its internal Electric ingest engine, `src/sync/`)
  subscribes to shapes served through the server's proxy. See [The read path](/concepts/read-path/).

API-level details will live in the [API reference](/reference/) (generated from the package sources).
For the storage package's construction, durability, and recreation contract, see
[OPFS-repacked PGlite storage](/packages/pglite-opfs-repacked/).
