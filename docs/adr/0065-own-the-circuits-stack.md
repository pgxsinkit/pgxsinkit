# Own the Circuits stack: one repository for the engine and the log server

Status: accepted (2026-09-29). Extends [ADR-0028](0028-own-the-sync-engine-outright.md)'s anti-goal
and [ADR-0062](0062-absorb-pglite-as-pgwasm.md)'s ownership from the client to the server side of the
read path. Amends [ADR-0055](0055-circuits-native-sync-core.md) decision 10: the read transport
becomes pgxsinkit's own code. Not yet implemented.

## Context

The read path's server side is two Rust programs, each maintained as a fork in its own repository.

| | `pgxsinkit/durable-streams-rust` | `pgxsinkit/electric-circuits` |
| --- | --- | --- |
| What it is | the log server | the Circuits engine |
| Rust source | 11.3k lines, one crate, binary only | 22.4k lines |
| Other code | one conformance run (bun, vitest 4) | 19.3k lines of TypeScript harness (pnpm, vitest 3) |
| Toolchain | Rust 1.96.0, held only to match the engine | Rust 1.96.0, held by a compiler crash on dbsp |
| Our commits on top of upstream | 17 | 47 |

The maintainer's assessment (2026-09-29) is that neither will get maintenance from its original
developers, and that pgxsinkit is likely the only user for the foreseeable future. The same holds for
the rest of the durable-streams family: the protocol repository went from 26 commits in January 2026
to 2 in September, with 69 pull requests and 62 issues open.

Three costs follow from the split:

- **The pair is not tested together where it is built.** The engine's test wrapper and its log server
  image both install `durable-streams` 0.1.5 from crates.io, which is upstream's build. Our log server
  carries 17 commits on top, read paging among them. The two only meet in pgxsinkit's integration lane.
- **Every consumer pins two shas that move independently.** pgxsinkit does so in two compose files,
  emergent in one.
- **Every dependency update is done twice.** 209 of the 227 crates in the log server's lockfile are
  already in the engine's.

Rust 1.99 fixes the compiler crash that holds the toolchain at 1.96.0. dbsp is pinned at 0.318 and the
latest is 0.357, so a large update is about to become possible.

## Decision

1. **One repository, two programs, two images.** The engine and the log server are built, tested and
   released from one Cargo workspace with one lockfile and one toolchain pin. They remain separate
   processes: the log server keeps serving clients while the engine restarts, and the engine is the
   memory-heavy half.

2. **The repository is new, and holds only what pgxsinkit needs.** It is `pgxsinkit/circuits`. It
   carries the engine repository's history, with the log server's commits replayed under
   `apps/durable-streams`, so history stays linear and the licence attribution stays intact. It is not
   a GitHub fork. The old repositories, their branches, issues and packages are left as they are until
   it is clear they are abandoned.

3. **Electric's name goes; "Circuits" and "durable-streams" stay.** "Circuits" is this glossary's word
   for the engine. Durable Streams is the open protocol the log server implements, so the server keeps
   its protocol's name and shows its ownership in the image path.

   | Thing | Before | After |
   | --- | --- | --- |
   | Engine crate and binary | `electric-circuits-engine` | `circuits-engine` |
   | Engine image | `ghcr.io/pgxsinkit/electric-circuits/engine` | `ghcr.io/pgxsinkit/circuits/engine` |
   | Log server crate and binary | `durable-streams`, `durable-streams-server` | unchanged |
   | Log server image | `ghcr.io/pgxsinkit/durable-streams-rust` | `ghcr.io/pgxsinkit/circuits/durable-streams` |
   | Engine environment variables | `ELECTRIC_CIRCUITS_*` | `CIRCUITS_*` |
   | TypeScript package scope (private) | `@electric-circuits/*` | `@circuits/*` |
   | Container build files | `docker/`, `Dockerfile.*` | `container/`, `Containerfile.*` |

4. **What the repository contains.**

   | In | Why |
   | --- | --- |
   | `apps/engine` | the engine |
   | `apps/durable-streams` | the log server, with its tests, conformance run and design notes |
   | `packages/conformance`, `oracle`, `protocol`, `client`, `ds-rust` | the engine's test harness |
   | the engine's container build, and a log server image built from the workspace | the two images |
   | `docs/`, `CONTEXT.md`, `AGENTS.md` | the decisions, architecture notes and glossary |

   Left out: `packages/bench`, `packages/loadgen`, `apps/pipeline-viz`, `apps/api`, `examples`,
   `tutorials`, the log server's `npm/` and `bench-latency`, and the container builds that serve them.

5. **The Electric compatibility adapter is removed.** `GET /v1/shape` imitates Electric's wire
   protocol; nothing of ours calls it, and the reason the engine fork kept it (its ADR-0001, "for
   upstream only") is gone. Tests that reach engine behaviour through the adapter are ported to the
   native path, not deleted.

6. **The read transport is pgxsinkit's own.** pgxsinkit uses one function of
   `@durable-streams/client`, `stream()`, out of 6,363 lines. It is replaced by a long-poll reader in
   `packages/client/src/circuits/`, and the package stops being a runtime dependency. This is
   independent of the rest and can land before or after it.

7. **The conformance suite and the protocol specification stay external.**
   `@durable-streams/server-conformance-tests` is taken from npm at an exact version, and links to the
   specification point at a fixed commit in `pgxsinkit/durable-streams`. They come into the repository
   only if the log server must do something the specification does not allow, or if the package is
   removed from npm.

8. **Order of work.**
   1. The move and the rename, released together. The toolchain stays on 1.96.0 and no dependency
      changes, so both test suites passing proves the move changed nothing. The harness and the image
      build switch to the log server built in the workspace. pnpm is replaced by bun. Consumers change
      their pins and environment variable names once.
   2. Rust 1.99 and the Rust dependency updates, once, in the one lockfile.
   3. The compatibility adapter's removal.
   4. The rest of the cross-repo tooling standard ([ADR-0001](0001-unified-ts-release-versioning-tooling-standard.md)):
      oxlint, oxfmt, podman, the validate hook.

## Considered options

- **One process**, with the log embedded in the engine. Rejected: it removes a localhost HTTP hop
  nobody has measured a need to remove, and joins two failure domains.
- **Inside the pgxsinkit monorepo.** Rejected: a dbsp build takes minutes and would sit in every
  commit and push gate, and images release by sha where packages release by tag. ADR-0064 made the
  same call for the C build.
- **Renaming the engine fork in place.** Rejected by the maintainer in favour of a new repository
  that starts with only what is needed.
- **Absorbing the whole durable-streams client.** Rejected: it would mean maintaining about 6,000
  lines nothing of ours calls. pgwasm was different, since pgxsinkit used nearly all of PGlite's core.
- **Updating dependencies before the move.** Rejected: it would be done twice, and would leave the
  engine tested against 0.1.5 through the riskiest change of the lot.

## Consequences

- Every consumer changes its two image pins and its engine environment variable names once:
  pgxsinkit's two compose files, emergent's compose file, and the Kubernetes deployment.
- dbsp writes state to disk. A jump from 0.318 to 0.357 may change that format and need an engine
  reset on deployed systems. This is unverified and is checked in step 2.
- The engine fork's `compat-branch` holds 26 unmerged commits from 2026-08-21, engine fixes among
  them. Whether `develop` already covers them is checked when the work starts.
- The engine fork's ADR-0001 and the log server's `PROVENANCE.md` ("own the build, not to take over
  development") are superseded in the new repository by its own record of this decision.
