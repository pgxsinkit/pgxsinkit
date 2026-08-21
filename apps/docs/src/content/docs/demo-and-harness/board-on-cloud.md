---
title: Run the board on managed BaaS
description: The managed-BaaS run of the board demo is retired — what that path was, and what a native read path would need in its place.
sidebar:
  label: Board on the cloud
---

**This path is retired.** The board's managed-BaaS run targeted Supabase Cloud plus a managed
read-path service that is being shut down, and the read path it drove was the classic one this toolkit
no longer ships. The `board:cloud:*` scripts remain in the repository, but they were written for that
topology and are not a working deployment path for the current one.

**Run the board locally instead.** The local compose stack is the version-matched, CI-gated proof of
the whole topology, and it is the same `apps/board` code:

```bash
mise install && bun install
mkcert -install       # one-time: trust the local CA so the browser accepts the gateway's TLS cert
cp .env.example .env
bun run infra:up      # the board stack via Podman compose
bun run seed:board    # GoTrue identities + deterministic fixtures
bun run dev:board
```

See [Demo & harness](/demo-and-harness/). The hosted public instance is also retired — see
[The hosted board /demo](/demo-and-harness/hosted-demo/).

## How it fits together

Everything below still describes the board as it runs today; what has gone is the managed backend the
read half used to point at.

- **Auth is Supabase's asymmetric model** — ES256 sessions verified against the project JWKS, with the
  `sb_publishable_`/`sb_secret_` API keys (no HS256). The board functions are the single auth point;
  the gateway only translates the opaque keys into role JWTs. Board
  [ADR-0007](https://github.com/pgxsinkit/pgxsinkit/blob/main/apps/board/docs/adr/0007-supabase-asymmetric-auth-only.md).
- **The read path is two functions over two services.** `board-sync` is the **control plane**: it
  serves `/sync/v1/subscribe`, `/sync/v1/refresh` and `/sync/v1/barrier`, compiling each shape's row
  filter and minting stream tokens against the **Circuits engine**'s control API. `board-stream` is the
  **edge**, on its own origin: it verifies a stream token, checks the grant, and proxies **durable-streams**
  bytes. Neither the engine nor durable-streams is client-reachable — reaching them is what the two
  functions are for, and they share nothing but the stream-token signing key.
- **The engine and durable-streams are services you run.** There is no managed offering of either, and
  these docs do not currently cover deploying them to a cloud environment. That is the concrete reason
  a managed-BaaS board is not a documented path today: the front half (Postgres, auth, the functions)
  maps onto a managed platform straightforwardly, and the read half has nowhere to land. The
  `board:cloud:*` deploy script also predates the edge — its function list does not include
  `board-stream`.
- **The edge functions deploy as pre-built bundles** (`supabase/config.toml` entrypoints,
  `verify_jwt = false`), because the demo registry `@pgxsinkit/board-schema` is unpublished. Board
  [ADR-0008](https://github.com/pgxsinkit/pgxsinkit/blob/main/apps/board/docs/adr/0008-board-on-managed-baas.md).
- **The client sends its publishable key** via `@pgxsinkit/client`'s `requestHeaders` option, alongside
  the per-request `Authorization`.
- **The Event lane needs a fourth function on a serverless platform.** Locally the board runs the
  toolkit's long-lived consumer runner (`bun run dev:board:consumer`); a managed platform with no
  process to host one uses `board-events-drain` instead — an edge function running one bounded
  [`drainOnce()`](/start/deploying-the-server/) pass per invocation, with a **cron schedule as the
  delivery guarantee** and a `board-write` **nudge** for latency. Its callers are machines with no
  session, so the gate is a shared secret (`BOARD_EVENTS_DRAIN_SECRET`) compared in constant time.

## What's verified

The **local** stack is covered by the board smoke (`bun run test:integration:board`): the API-key flow,
ES256/JWKS verification, and the full read/write topology through the gateway, the three functions, the
engine and durable-streams. Nothing about a managed deployment is verified.
