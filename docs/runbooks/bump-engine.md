# Runbook: bump the Circuits engine / durable-streams images

## When to use

When the pgxsinkit fork of `electric-circuits` or of `durable-streams-rust` lands a change the repo
needs. Both are pinned, and both compose stacks must agree.

## Where the pins are

Four lines, two per image:

| Image                                                    | Harness                                       | Board                                        |
| -------------------------------------------------------- | --------------------------------------------- | -------------------------------------------- |
| `ghcr.io/pgxsinkit/electric-circuits/engine:sha-<short>` | `infra/compose/docker-compose.yml` → `engine` | `infra/compose/board-compose.yml` → `engine` |
| `ghcr.io/pgxsinkit/durable-streams-rust:sha-<short>`     | `infra/compose/docker-compose.yml` → `ds`     | `infra/compose/board-compose.yml` → `ds`     |

There is no pin file and no bump script — edit the four lines by hand. (Each pin is the `default` half of a
`${PGXSINKIT_CIRCUITS_ENGINE_IMAGE:-…}` / `${PGXSINKIT_DS_IMAGE:-…}` substitution; keep it that way.)

## Where the images come from

The engine: the `electric-circuits` fork's `docker.yml` builds `docker/Dockerfile.engine` on **every
push to its `main`** and publishes two tags: `main` and `sha-<short>`.

durable-streams: `pgxsinkit/durable-streams-rust`'s `docker.yml` publishes `main` + `sha-<short>` on
every push to its `main`, and `develop` + `sha-<short>` on a manual
`gh workflow run docker.yml --ref develop` — which is how images are produced while that repo's work
lands on `develop` rather than `main`.

**Pin by `sha-<short>`, never `main` or `develop`.** Branch tags move whenever the fork moves, which
would silently change the image under a lane or the board — a class of failure that reads as a flaky
test rather than a version change.

## Overriding without a bump

Both stacks read `PGXSINKIT_CIRCUITS_ENGINE_IMAGE` and `PGXSINKIT_DS_IMAGE`, so a local build needs no
edit here:

```bash
podman build -f docker/Dockerfile.engine -t localhost/electric-circuits-engine:dev .   # in the engine fork
export PGXSINKIT_CIRCUITS_ENGINE_IMAGE=localhost/electric-circuits-engine:dev
podman build -t localhost/durable-streams-rust:dev .                                    # in the ds fork
export PGXSINKIT_DS_IMAGE=localhost/durable-streams-rust:dev
```

Shell env wins over an `--env-file` value, so `export` works for the board stack too. The commented
defaults live in `.env.example` (harness) and `infra/compose/board.env` (board), both under the
Circuits section. Use the
override to iterate; land a `sha-` pin to make it the repo's version.

## After the bump

Run the container lanes — they are the only wire-compatibility proof:

```bash
bun run test:integration
```

A failure in the read-path lanes (`asymmetric-read`, `membership-fanout`, `registry-sync-roundtrip`) after
an engine or durable-streams bump is a genuine incompatibility. Stop and report it; do not quietly pin back down.

Commit the four pin lines together, and say in the message which fork commit the `sha-` tag names.
