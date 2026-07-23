# Runbook: publishing and driving the storage benchmarks

Maintainer-facing companion to the consumer-facing [Storage benchmarks](../../apps/docs/src/content/docs/demo-and-harness/storage-benchmarks.md)
page. The published page tells a consumer how to run the live suite in their own browser; this runbook
holds the monorepo build/publish pipeline and the local headless commands, which are maintainer-only and
must NOT live in `apps/docs/` (AGENTS.md, "the published docs site is consumer-facing").

## How the bench page is published

The bench page is built into `apps/docs/dist/bench/` as a step in the **docs deploy**
(`.github/workflows/docs.yml`), so it ships as part of the same GitHub Pages artifact as the docs site —
the same co-publish pattern as the hosted `/demo`. Locally:

```bash
bun run docs:build      # build the docs site (regenerates apps/docs/dist)
bun run bench:publish    # build the bench page into apps/docs/dist/bench
```

## Driving the suite headless

The suite itself lives in `apps/perf-lab` (`src/bench/`, `bench.html`). To drive it headless across the
locally installed engines and print the numbers:

```bash
bun run bench:storage                        # all batteries, all backends, relaxed
bun run bench:storage --batteries=big-read   # one battery
bun run bench:storage --strict               # strict durability for the non-matrix batteries
```

These are a desktop baseline only. The numbers that decide the OPFS flavor choice come from a real
iPhone/Safari run of the live page — see the consumer page's "Run it" section for the in-browser flow.
