---
title: Use these docs with your AI assistant
description: Point your coding assistant at pgxsinkit's llms.txt so it loads the right mental model fast.
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

## The five things assistants get wrong

1. **It is a toolkit, not a demo or a data layer.** The `@pgxsinkit/*` packages are the product.
2. **The two paths are separate and asymmetric.** Writes do not travel back through Electric.
3. **There is one write path.** No selectable backend; one in-database apply function.
4. **The Electric subquery flag is mandatory** and fails closed without it.
5. **Local PGlite schema is not full DDL parity** with Postgres.

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
