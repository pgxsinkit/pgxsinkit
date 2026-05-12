# Copilot Instructions

# Project Constraints & Rules

## Build System

- **Compiler**: Never use `tsc`, `npx tsc`, or `bunx tsc`.
- **Tooling**: Always use `tsgo` for all TypeScript operations. Always use `podman` for container management. Always use `mise` for tool version management. Always use `oxlint` and `oxfmt` for linting and formatting. NEVER use `docker`, `npm` or `tsc` for anything.
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

Build and maintain a battle-hardened demo and verification harness for `PostgreSQL -> ElectricSQL -> PGlite` sync.

## Working rules

- Use `tmp/linearlite` and `tmp/pglite` only as reference inputs.
- Do not treat `tmp/` as project code. It is reference material only.
- Prefer the vendored `packages/pglite-sync` codebase sourced from upstream `@electric-sql/pglite-sync`, and evolve it before considering a clean-room rewrite.
- Keep production-facing logic in the workspace packages, not in ad hoc scripts.
- Record any protocol or behavior drift in `docs/testing-strategy.md`.
- Prefer small, composable helpers over framework-heavy abstractions.
- Add or update tests whenever changing sync configuration, write validation, database schema, or integration setup.
- Use `mise` for pinned tool installation and Bun workspaces for package management.
- Preserve Bun for the write API runtime.
- Preserve Drizzle ORM and `drizzle-kit@1.0.0-rc.*` or later for schema management.
- Keep Drizzle schema authoritative for server-side PostgreSQL structure.
- Preserve Zod v4 validation on all user-controlled payloads.
- Run ALL type checks through `tsgo` from `@typescript/native-preview`, never attempt to use tsc.
- Use `oxlint` and `oxfmt` instead of ESLint and Prettier.
- Pure JavaScript is forbidden for project code and ad-hoc scripts; use TypeScript with repository typecheck coverage, or use bash when TypeScript coverage cannot be made robust.

## Definition of done

- `bun run validate` - this runs all linters, formatters, and type checks. You MUST ensure this passes before passing back.

Integration suites must run through the package scripts that launch isolated compose projects (`test:integration:contract`, `test:integration:implementation`, or `test:integration`). Do not rely on shared long-running infra for integration verification.

## AI implementation priorities

1. Fix root causes, not just happy-path examples.
2. Add explicit error messages at boundary layers.
3. Prefer deterministic tests and polling helpers over sleeps.
4. Document assumptions if ElectricSQL or PGlite behavior is version-sensitive.
