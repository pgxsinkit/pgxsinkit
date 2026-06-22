---
title: Packages
description: What each @pgxsinkit/* package is and when you need it.
sidebar:
  label: Overview
---

pgxsinkit ships as a set of focused packages. Most apps install `client`, `server`, and `contracts`,
plus `react` for React bindings.

## Published packages (the product)

| Package                      | Install when you…                                                                                        | Runtime          |
| ---------------------------- | -------------------------------------------------------------------------------------------------------- | ---------------- |
| **`@pgxsinkit/contracts`**   | always — shared Zod schemas, the sync registry types, and the transport DTOs both paths use.             | shared           |
| **`@pgxsinkit/server`**      | you run the write API — `createSyncServer`, the apply-function builder, and the Electric shape proxy.    | Bun + Hono       |
| **`@pgxsinkit/client`**      | you build the client — local overlay + mutation journal, batch flush, and read wiring over PGlite.       | browser / PGlite |
| **`@pgxsinkit/react`**       | you want React hooks/bindings over the client.                                                           | React            |
| **`@pgxsinkit/pglite-sync`** | almost never directly — the vendored, hardened fork of `@electric-sql/pglite-sync` that the client uses. | browser / PGlite |

## Internal packages (not published)

| Package                 | What it is                                                                                                            |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `@pgxsinkit/schema`     | the **demo's** sync registry and tables (authors, todos, projects). Example code — your app defines its own registry. |
| `@pgxsinkit/test-utils` | shared helpers for the integration and unit suites.                                                                   |

## How they fit the two paths

- **Write path:** your app uses `@pgxsinkit/client` to stage + flush; `@pgxsinkit/server` validates
  against `@pgxsinkit/contracts` and applies via the in-database function. See
  [The write path](/concepts/write-path/).
- **Read path:** `@pgxsinkit/client` (over the vendored `@pgxsinkit/pglite-sync`) subscribes to
  shapes served through the server's proxy. See [The read path](/concepts/read-path/).

API-level details will live in the [API reference](/reference/) (generated from the package sources).
