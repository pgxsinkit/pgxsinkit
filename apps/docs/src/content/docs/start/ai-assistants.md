---
title: Use these docs with your AI assistant
description: Point your coding assistant at pgxsinkit's llms.txt and the Agent Skills shipped in the @pgxsinkit/* packages so it loads the right model fast.
---

pgxsinkit is easy to misunderstand from the source alone — the read and write paths are asymmetric,
the write path is deliberately a single in-database function, and local PGlite schema is not a full
mirror of Postgres. These docs publish machine-readable summaries so an assistant can load the
correct model without re-deriving it from the whole repository.

## The llms.txt files

| File                                                            | What it is                                        |
| --------------------------------------------------------------- | ------------------------------------------------- |
| [`/llms.txt`](https://pgxsinkit.github.io/llms.txt)             | Index of the docs with short descriptions.        |
| [`/llms-full.txt`](https://pgxsinkit.github.io/llms-full.txt)   | The entire documentation as one file.             |
| [`/llms-small.txt`](https://pgxsinkit.github.io/llms-small.txt) | A compressed variant for tighter context windows. |

## How to use them

- **Working in a consuming codebase:** fetch `https://pgxsinkit.github.io/llms-full.txt` into your
  assistant's context before asking it to wire sync, or link it from your own agent guide.
- **Contributing to pgxsinkit itself:** the canonical vocabulary lives in the repository's
  `CONTEXT.md`, and the agent guide is `AGENTS.md` — read those first.

## Agent Skills shipped in the packages

The `@pgxsinkit/*` packages also ship **[TanStack Intent](https://tanstack.com/intent) Agent Skills** —
task-scoped `SKILL.md` guidance bundled **inside the npm package**, so it is pinned to the exact version
you installed. They complement `llms.txt` rather than replace it: `llms.txt` is the broad model you pull
by URL; a skill is a focused checklist your assistant loads at the moment it reaches for that task, and it
travels with the dependency.

| Skill                    | Package                           | Load it before…                                                                                                                                                                                                                                                     |
| ------------------------ | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`core`**               | `@pgxsinkit/client`               | wiring sync at all — the two asymmetric paths, the single in-database write path, the mandatory fail-closed subquery flag, and why local PGlite is not full DDL parity.                                                                                             |
| **`registry-authoring`** | `@pgxsinkit/contracts`            | defining a registry — the writable-table rules (a server-version field **and** a conflict policy), server-managed fields, `enum::text` in shape filters, and deriving the read filter and RLS from one predicate.                                                   |
| **`operating`**          | `@pgxsinkit/client`               | shipping to production — runtime latency, capability-driven worker placement (Safari SW-direct; Chromium/Firefox elected), OPFS-vs-idb durability, relocation outcomes, adoption/destruction, diagnostics, and the forwarded debug rail.                            |
| **`deploying`**          | `@pgxsinkit/server`               | deploying the server + shape proxy on Bun / Deno / Supabase Edge / Workers — bundling for Deno, the function-name path rewrite, and resolving claims from the platform JWT.                                                                                         |
| **`react`**              | `@pgxsinkit/react`                | building React components — `createSyncClientHooks`, the live read hooks, the snake_case→field-key remap, and that writes go through `client.tables.<t>`, not the hooks.                                                                                            |
| **`operating`**          | `@pgxsinkit/pglite-opfs-repacked` | constructing the constant-handle OPFS backend in a capability-proven worker scope — dedicated workers on Chromium/Firefox, SharedWorkers on real Safari — plus factory-owned durability, extent identity, complete-directory recreation, and stable error remedies. |

Discover and load them with the [TanStack Intent](https://tanstack.com/intent) CLI, from a project that
has `@pgxsinkit/*` installed:

```bash
bunx @tanstack/intent@latest list                          # every skill the installed packages ship
bunx @tanstack/intent@latest load @pgxsinkit/client#core   # print one skill
bunx @tanstack/intent@latest install                       # add "load a matching skill first" guidance to AGENTS.md / CLAUDE.md
```

(Use the `@latest` form: `@electric-sql/client` also installs an `intent` binary, so a bare `intent` in
`node_modules/.bin` can resolve to the wrong CLI.)

## The six things assistants get wrong

1. **It is a toolkit, not a demo or a data layer.** The `@pgxsinkit/*` packages are the product.
2. **The two paths are separate and asymmetric.** Writes do not travel back through Electric.
3. **There is one write path.** No selectable backend; one in-database apply function.
4. **The Electric subquery flag is mandatory** and fails closed without it.
5. **Local PGlite schema is not full DDL parity** with Postgres.
6. **Browser storage is capability-selected, not browser-named.** Capability worker mode prefers
   OPFS-repacked: real Safari runs SW-direct, Chromium/Firefox elect a dedicated worker, and idb is the
   fallback. Read `BootReport.storageBackend`/`engineHome`; do not infer from WebKitGTK or user-agent text.

Each is covered in [Core concepts](/concepts/).

## Operational gotchas that aren't visible in the code

These do not show up when reading the toolkit source — they are properties of the runtime around it,
and each silently makes a live app feel slow or flaky. An assistant wiring a real deployment should load
[Operating in production](/start/operating-in-production/) and apply them up front:

- **Writes flush on enqueue, not on the interval.** The convergence interval is a _fallback_; keep it
  long (idle CPU), do not shorten it to chase write latency.
- **A same-origin Electric shape proxy must force `cache-control: no-store`**, or a rotated shape handle
  serves stale and loops on 409s.
- **A browser opens one long-poll connection per shape.** With several shapes the HTTP/1.1 ~6-per-origin
  cap starves writes — serve the gateway over **HTTP/2**.
- **Serverless edges cold-start.** The first write after idle lags; warm the worker and set its
  wall-clock timeout above Electric's ~25s long-poll.
- **Debug latency with `globalThis.__pgxsinkitDebug`**, and measure at the network boundary — polling
  PGlite in a loop inflates the number it reports.
- **In a browser, attach through a SharedWorker** (`defineSyncWorker` + `attachSyncClient`) to take
  PGlite off the main thread. Capability placement is automatic — there is no placement option; pass the
  SharedWorker as a factory (`worker: () => SharedWorker`) and the elected engine is auto-derived from
  the SharedWorker's own script URL (supply `createEngineWorker` only for non-module/underivable
  entries). Storage is declared on the registry (`storage.backend`/`storage.durability`, defaulting to
  opfs/relaxed); force idb with `storage.backend: "idbfs"`. Safari runs in that SharedWorker;
  Chromium/Firefox elect a dedicated engine behind it. Always pass `extendedLifetime: true`, and branch
  on `EngineRelocatedError.outcome` rather than blindly retrying a mutation. See
  [Worker mode](/concepts/worker-mode/).
