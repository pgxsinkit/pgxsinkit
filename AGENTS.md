<!-- intent-skills:start -->

## Skill Loading

Before editing files for a substantial task:

- Run `bunx @tanstack/intent@latest list` from the workspace root to see available local skills.
- If a listed skill matches the task, run `bunx @tanstack/intent@latest load <package>#<skill>` before changing files.
- Use the loaded `SKILL.md` guidance while making the change.
- Monorepos: when working across packages, run the skill check from the workspace root and prefer the local skill for the package being changed.
- Multiple matches: prefer the most specific local skill for the package or concern you are changing; load additional skills only when the task spans multiple packages or concerns.
<!-- intent-skills:end -->

# pgxsinkit Agent Instructions

## Release, versioning & tooling standard

This repo follows the **Cross-repo TypeScript release & versioning standard** (defined in the global
agent guide, `~/.claude/CLAUDE.md`; full rationale in
[docs/adr/0001](docs/adr/0001-unified-ts-release-versioning-tooling-standard.md)). The essentials:

- **Scripts are check-default.** `bun run format` / `bun run lint` **check** (non-mutating); use
  `format:write` / `lint:fix` to change files. `bun run validate` (format, typecheck, lint, then the
  **fast** unit subset `test:unit:fast`) is the **pre-commit** gate, auto-installed via the `prepare`
  script — it skips the PGlite/WASM-backed unit tests so commits stay quick. `bun run validate:full`
  (the **full** unit suite) is the **pre-push** gate and what CI runs; `bun run test` /
  `bun run test:unit` remain the canonical full unit run. `test` is unit-only; container lanes are
  `test:integration` (CI on release + on demand), never in the commit path.
- **Versions are tag-derived, never hand-edited.** Every publishable `package.json` carries
  `"version": "0.0.0"` as a placeholder — the most recent semver tag is the _only_ version input,
  and CI derives the real dev/release version at publish time. There is no version-bump script.
- **Publishing.** A push to `main` publishes a `@dev` build to GitHub Packages; a semver tag
  publishes release-parity at `@latest` (both gated on validation). The public npm mirror is a
  separate, human-gated step on your machine: `bun run release:npm <tag>`.

# Project Constraints & Rules

## Build System

- **Compiler**: Never use `tsc`, `npx tsc`, or `bunx tsc`. tsgo is the underlying engine but always invoke it via package scripts, not directly.
- **Tooling**: Always use `podman` for container management. Always use `mise` for tool version management. NEVER use `docker`, `npm` or `tsc` for anything.
- **Dependency Management**: Keep packages on their latest versions by default unless a compatibility or product requirement is written down explicitly.

## Directory Hygiene

- **Temporary Files**: All temporary files, one-shot scripts, and logs MUST be placed in `./tmp/`.
- **Root Directory**: NEVER create log files or temporary files at the project root. Do not create files in the repository root unless explicitly asked for configuration files (e.g., `package.json`).
- **System /tmp**: Never use the global `/tmp` directory. Use the project-local `./tmp/`.
- **/dev/null**: Never write to `/dev/null`. If you need to discard output, use a project-local file in `./tmp/` instead.
- **Hard-stop Enforcement**: Before creating any non-source artifact, verify the target path is under `./tmp/` (prefer `./tmp/agents/` for assistant artifacts). If not, do not create the file.
- **Immediate Remediation**: If a temporary file is accidentally created outside `./tmp/`, delete or move it into `./tmp/` before running any further commands.

## Prohibitions

- Never suggest installing the old version of `typescript`.
- DO NOT use `bunx` for TypeScript execution.
- NEVER create migration SQL files by hand. Always use the `drizzle-kit` commands to generate migration files, and then edit/add the SQL if necessary.
- NEVER launch a new set of tests without making sure that the previous test run is fully complete and all related containers and processes are stopped. Always check `podman ps` and `podman compose ls` to confirm no prior test containers are running before starting a new test run.

## Project intent

Build and maintain the `@pgxsinkit/*` **toolkit** — an offline-first sync library for the
`PostgreSQL -> ElectricSQL -> PGlite` read path and the `client -> write API -> PostgreSQL` write
path. The toolkit is the product; the demo app (`apps/web`) and the integration + performance
harness exist to prove and harden it. pgxsinkit is a standalone open-source library — never treat it
as any particular downstream application's data layer. See [CONTEXT.md](CONTEXT.md) for the canonical
vocabulary.

## Working rules

- Use `tmp/linearlite` and `tmp/pglite` only as reference inputs.
- Do not treat `tmp/` as project code. It is reference material only.
- The read-path ingest engine is internalized at `packages/client/src/sync/` (ADR-0009, originally vendored from upstream `@electric-sql/pglite-sync`). It is ours to evolve freely — there is no upstream-compatibility constraint. `tests/unit/pglite-sync-upstream.test.ts` + `tests/integration/pglite-sync-e2e.integration.test.ts` are the behavioural oracle; keep them green through refactors.
- Keep production-facing logic in the workspace packages, not in ad hoc scripts.
- Record any protocol or behavior drift in `docs/testing-strategy.md`.
- Prefer small, composable helpers over framework-heavy abstractions.
- Add or update tests whenever changing sync configuration, write validation, database schema, or integration setup.
- Use `mise` for pinned tool installation and Bun workspaces for package management.
- Preserve Bun for the write API runtime.
- Preserve Drizzle ORM and `drizzle-kit@1.0.0-rc.*` or later for schema management.
- Keep Drizzle schema authoritative for server-side PostgreSQL structure.
- Preserve Zod v4 validation on all user-controlled payloads.
- Type checking: use `bun run typecheck` — not `tsgo` or `tsc` directly.
- Lint and format: use `bun run lint` and `bun run format` (both **check** only) — not `oxlint` or `oxfmt` directly. To mutate, use `bun run lint:fix` / `bun run format:write`.
- Always prefer package scripts over direct tool invocation. Package scripts encode project-specific flags that direct invocation silently skips.
- Pure JavaScript is forbidden for project code and ad-hoc scripts; use TypeScript with repository typecheck coverage, or use bash when TypeScript coverage cannot be made robust.

## Definition of done

- `bun run validate` (the fast pre-commit gate: format, lint, typecheck, fast unit subset) must pass before any commit. Before handing back work — and before any push — run `bun run validate:full`, which adds the PGlite/WASM-backed unit tests; that is the gate CI enforces.

Integration suites must run through the package scripts that launch isolated compose projects (`test:integration:contract`, `test:integration:implementation`, or `test:integration`). Do not rely on shared long-running infra for integration verification.

## AI implementation priorities

1. Fix root causes, not just happy-path examples.
2. Add explicit error messages at boundary layers.
3. Prefer deterministic tests and polling helpers over sleeps.
4. Document assumptions if ElectricSQL or PGlite behavior is version-sensitive.
