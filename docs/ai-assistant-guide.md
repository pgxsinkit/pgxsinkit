# AI Assistant Guide

## Purpose

This repo is designed to be continued by AI assistants over time. The priority is maintaining confidence in the sync boundary, not just shipping UI features.

## Safe areas for rapid iteration

- new unit tests
- new integration fixtures
- additional API endpoints following the existing contract pattern
- sync adapter instrumentation and diagnostics
- targeted fixes inside `packages/pglite-sync` when backed by regression tests

## Areas that require extra care

- changing the table schema
- changing the vendored `packages/pglite-sync` behavior without tests
- introducing new PostgreSQL extensions
- changing container images or port assumptions

## Integration workflow policy

- Run integration suites through `bun run test:integration:contract`, `bun run test:integration:implementation`, or `bun run test:integration`.
- These scripts provision isolated compose projects and tear them down automatically.
- Do not rely on shared long-running local infra for integration test execution.

## Required context before major changes

Read these files first:

- `README.md`
- `docs/architecture.md`
- `docs/testing-strategy.md`
- `copilot-instructions.md`

## Tooling expectations

- Install toolchain-managed Bun `1.3.x` and Node `24.x` with `mise install`.
- Install dependencies with `bun install`.
- Prefer `bun run ...` over introducing another JavaScript package manager.

## Recommended next milestones

- persist PGlite subscription metadata between browser sessions
- add network interruption and resume tests
- add write conflict and idempotency cases
- add migration smoke tests across PostgreSQL versions
